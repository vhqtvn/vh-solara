package server

// notify_transport.go — the replaceable push-notification transport layer
// (slice S1 of the controller-side companion-app notification program;
// solution brief tmp/agent-runs/android-push-20260928/brief.md, operator
// decision: FCM first, but transports must be replaceable/addable).
//
// Pieces:
//   - NotifyMessage + the Notifier interface: the transport-neutral send
//     contract. An implementation delivers one message to one device
//     registration token. v1 contract: NO internal retries — the caller
//     owns retry/backoff policy (S2's sender); Send classifies failures
//     into typed errors so that policy can act without parsing strings.
//   - FCMNotifier: the Firebase Cloud Messaging HTTP v1 implementation,
//     STDLIB-ONLY (crypto/rsa + encoding/json + net/http; the settled
//     no-third-party-deps decision). Loads a Google service-account JSON
//     (client_email, private_key, project_id), signs an RS256 JWT
//     assertion with the firebase.messaging scope, exchanges it at the
//     OAuth token endpoint, caches the access token until (near-)expiry,
//     and POSTs {"message":{...}} to
//     /v1/projects/{project}/messages:send. BOTH endpoints are injectable
//     fields (empty = the real Google defaults) so lane-1 tests drive a
//     httptest fake OAuth + fake FCM with zero network.
//   - nullNotifier: the no-credentials posture (Name "null"; Send returns
//     ErrNotifyDisabled). Used as the daemon default and by tests.
//
// Error taxonomy (the S2 sender's actionable signals):
//   - *NotifyInvalidTokenError: the provider PERMANENTLY rejects the
//     registration token (FCM 404 / UNREGISTERED). S2 retires the stored
//     token on this class.
//   - *NotifyRetryError: rate-limit / transient-provider signal (FCM 429
//     or any 5xx), carrying the parsed Retry-After when present.
//   - anything else: configuration/transport failure (OAuth exchange
//     refused, malformed request, network) — caller-visible as plain
//     errors; never silently swallowed.
//
// Startup posture (cmd/server.go): --notify-fcm-credentials unset ⇒
// nullNotifier (test-send answers 409 naming the flag); set-but-bad ⇒
// log.Fatalf naming the path and reason, the same discipline as
// --status-config. External calls happen ONLY inside Send — construction
// parses credentials and touches no network.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Message + interface
// ---------------------------------------------------------------------------

// NotifyMessage is the transport-neutral push payload: a visible
// notification (title/body — rendered by the OS while the companion app is
// backgrounded) plus a flat string:string data map delivered to the app's
// receiver (the FCM data payload; S2 will define the event vocabulary that
// rides here — kept generic on purpose).
type NotifyMessage struct {
	Title string
	Body  string
	Data  map[string]string
}

// Notifier is ONE push transport. Implementations are replaceable and
// additional transports can be added later (interface + registry pattern;
// the operator's settled decision) — nothing outside this file may import
// FCM-specific shapes.
type Notifier interface {
	// Send delivers msg to the single device registration token token.
	// v1 makes NO retry attempts: a non-nil error means "not accepted",
	// classified per the file comment so the caller can decide retry,
	// token retirement, or operator surfacing.
	Send(ctx context.Context, token string, msg NotifyMessage) error
	// Name is the stable transport identifier echoed by
	// POST /vh/notify/test ("fcm", "null", ...).
	Name() string
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

// ErrNotifyDisabled is returned by nullNotifier.Send — no credentials are
// configured, so no transport exists. Handlers translate it into the 409
// posture naming --notify-fcm-credentials (never a silent no-op).
var ErrNotifyDisabled = errors.New("notification transport not configured (no --notify-fcm-credentials on this controller)")

// NotifyInvalidTokenError reports a registration token the provider
// rejects PERMANENTLY (FCM HTTP 404 or an UNREGISTERED error detail). The
// device has uninstalled the app / rotated its token; retrying the same
// token cannot succeed. S2's sender uses this class to retire stored
// tokens.
type NotifyInvalidTokenError struct {
	Detail string
}

func (e *NotifyInvalidTokenError) Error() string {
	return "notification token invalid/unregistered: " + e.Detail
}

// NotifyRetryError reports a rate-limit / transient provider failure
// (FCM 429 or any 5xx). After carries the parsed Retry-After hint when the
// provider sent one (zero = no hint). The caller owns backoff — Send does
// not sleep or retry.
type NotifyRetryError struct {
	Status int
	After  time.Duration
	Detail string
}

func (e *NotifyRetryError) Error() string {
	if e.After > 0 {
		return fmt.Sprintf("notification send retryable (HTTP %d, retry-after %s): %s", e.Status, e.After, e.Detail)
	}
	return fmt.Sprintf("notification send retryable (HTTP %d): %s", e.Status, e.Detail)
}

// ---------------------------------------------------------------------------
// nullNotifier — the disabled posture
// ---------------------------------------------------------------------------

// nullNotifier is the Notifier installed when no credentials are
// configured: every Send fails with ErrNotifyDisabled and Name() is
// "null". Deliberately not a log sink — v1 has no send paths that could
// hit it beyond test-send, which 409s before calling Send anyway.
type nullNotifier struct{}

// NewNullNotifier returns the disabled-posture transport.
func NewNullNotifier() Notifier { return nullNotifier{} }

func (nullNotifier) Name() string { return "null" }

func (nullNotifier) Send(context.Context, string, NotifyMessage) error {
	return ErrNotifyDisabled
}

// notifyTransportDisabled reports whether n is the disabled posture (nil —
// a Daemon built as literals before SetNotifyTransport — or an explicit
// nullNotifier).
func notifyTransportDisabled(n Notifier) bool {
	if n == nil {
		return true
	}
	_, isNull := n.(nullNotifier)
	return isNull
}

// ---------------------------------------------------------------------------
// FCM (HTTP v1) — stdlib-only
// ---------------------------------------------------------------------------

const (
	// fcmDefaultTokenURL is the Google OAuth token exchange endpoint an
	// RS256 service-account assertion is redeemed at.
	fcmDefaultTokenURL = "https://oauth2.googleapis.com/token"
	// fcmDefaultBaseURL is the FCM HTTP v1 API base; the send endpoint is
	// baseURL + /v1/projects/{project}/messages:send.
	fcmDefaultBaseURL = "https://fcm.googleapis.com"
	// fcmScope is the OAuth scope a FCM v1 send requires.
	fcmScope = "https://www.googleapis.com/auth/firebase.messaging"
	// fcmAssertionTTL is the JWT assertion lifetime (Google accepts up to
	// 1 hour).
	fcmAssertionTTL = time.Hour
	// fcmTokenSkew refreshes the cached access token slightly BEFORE its
	// reported expiry so a send never races the token's last seconds.
	fcmTokenSkew = time.Minute
	// fcmSendTimeout bounds one OAuth exchange or one send (the brief's
	// proposed 10s send budget).
	fcmSendTimeout = 10 * time.Second
)

// serviceAccountKey is the SUBSET of the Google service-account JSON the
// FCM client needs. Decoding is deliberately NOT strict
// (no DisallowUnknownFields): real Google-issued files carry a dozen
// sibling fields (type, private_key_id, client_id, auth_uri,
// token_uri, ...) that would all be "unknown" — only the three fields we
// consume are validated, so a genuine Google file always loads.
type serviceAccountKey struct {
	ProjectID     string `json:"project_id"`
	ClientEmail   string `json:"client_email"`
	PrivateKeyPEM string `json:"private_key"`
}

// FCMNotifier sends via Firebase Cloud Messaging HTTP v1. Construct with
// NewFCMNotifier / NewFCMNotifierFromFile. The tokenURL and baseURL fields
// exist for lane-1 tests (httptest fakes); empty = the real Google
// defaults. Safe for concurrent use (the access-token cache is
// mutex-guarded; one exchange at a time under the lock — sends are few in
// v1, S2 may refine to single-flight if volume demands it).
type FCMNotifier struct {
	projectID   string
	clientEmail string
	key         *rsa.PrivateKey

	// tokenURL overrides the OAuth token exchange endpoint (tests only).
	tokenURL string
	// baseURL overrides the FCM API base URL (tests only); the send
	// endpoint is derived as baseURL + /v1/projects/{project}/messages:send.
	baseURL string

	httpClient *http.Client

	mu          sync.Mutex
	accessToken string
	tokenExpiry time.Time
}

// NewFCMNotifier parses a Google service-account JSON and returns a ready
// FCM transport. External calls happen only in Send — this parses and
// validates locally. Errors name the precise problem; the caller
// (cmd/server.go) fails startup on them.
func NewFCMNotifier(credentialsJSON []byte) (*FCMNotifier, error) {
	var sak serviceAccountKey
	if err := json.Unmarshal(credentialsJSON, &sak); err != nil {
		return nil, fmt.Errorf("parse service-account JSON: %v", err)
	}
	if sak.ProjectID == "" {
		return nil, errors.New("service-account JSON: project_id is empty")
	}
	if sak.ClientEmail == "" || !strings.Contains(sak.ClientEmail, "@") {
		return nil, errors.New("service-account JSON: client_email is missing or malformed")
	}
	key, err := parseRSAPrivateKey(sak.PrivateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("service-account JSON: private_key: %v", err)
	}
	return &FCMNotifier{
		projectID:   sak.ProjectID,
		clientEmail: sak.ClientEmail,
		key:         key,
		httpClient:  &http.Client{Timeout: fcmSendTimeout},
	}, nil
}

// NewFCMNotifierFromFile loads the service-account JSON at path (the
// --notify-fcm-credentials startup path). A missing/unreadable/invalid
// file returns an error naming the path and reason — set-but-bad is a
// startup failure, never a silent null transport.
func NewFCMNotifierFromFile(path string) (*FCMNotifier, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read FCM credentials %s: %v", path, err)
	}
	n, err := NewFCMNotifier(data)
	if err != nil {
		return nil, fmt.Errorf("FCM credentials %s: %v", path, err)
	}
	return n, nil
}

// parseRSAPrivateKey accepts both PEM forms Google issues (PKCS#8
// "PRIVATE KEY" and the older PKCS#1 "RSA PRIVATE KEY").
func parseRSAPrivateKey(pemData string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemData))
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rk, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("key is %T, want RSA", k)
		}
		return rk, nil
	}
	rk, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("not a parseable RSA key (tried PKCS#8 then PKCS#1): %v", err)
	}
	return rk, nil
}

// Name implements Notifier.
func (f *FCMNotifier) Name() string { return "fcm" }

// tokenEndpoint is the effective OAuth exchange URL (override or default).
func (f *FCMNotifier) tokenEndpoint() string {
	if f.tokenURL != "" {
		return f.tokenURL
	}
	return fcmDefaultTokenURL
}

// sendEndpoint derives the FCM v1 send URL from the effective base URL and
// the project id.
func (f *FCMNotifier) sendEndpoint() string {
	base := f.baseURL
	if base == "" {
		base = fcmDefaultBaseURL
	}
	return strings.TrimSuffix(base, "/") + "/v1/projects/" + url.PathEscape(f.projectID) + "/messages:send"
}

// signAssertion builds and signs the RS256 JWT bearer assertion (RFC 7523):
// iss = client_email, scope = firebase.messaging, aud = the effective
// token endpoint, exp-iat = 1h.
func (f *FCMNotifier) signAssertion(now time.Time) (string, error) {
	type jwtHeader struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	type jwtClaims struct {
		Iss   string `json:"iss"`
		Scope string `json:"scope"`
		Aud   string `json:"aud"`
		Exp   int64  `json:"exp"`
		Iat   int64  `json:"iat"`
	}
	hb, err := json.Marshal(jwtHeader{Alg: "RS256", Typ: "JWT"})
	if err != nil {
		return "", err
	}
	cb, err := json.Marshal(jwtClaims{
		Iss:   f.clientEmail,
		Scope: fcmScope,
		Aud:   f.tokenEndpoint(),
		Exp:   now.Add(fcmAssertionTTL).Unix(),
		Iat:   now.Unix(),
	})
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	signingInput := enc.EncodeToString(hb) + "." + enc.EncodeToString(cb)
	sum := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("sign assertion: %v", err)
	}
	return signingInput + "." + enc.EncodeToString(sig), nil
}

// oauthTokenResponse is the redeem-result shape of the token endpoint.
type oauthTokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
}

// token returns a cached-or-fresh access token. The cache is honored until
// fcmTokenSkew before the reported expiry; an unexpired cached token means
// a second Send performs NO exchange (pinned by tests). The exchange is
// serialized under f.mu so concurrent sends cannot stampede the endpoint.
func (f *FCMNotifier) token(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.accessToken != "" && time.Now().Before(f.tokenExpiry) {
		return f.accessToken, nil
	}
	assertion, err := f.signAssertion(time.Now())
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.tokenEndpoint(), strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := f.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fcm: oauth exchange: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("fcm: oauth exchange: read response: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fcm: oauth exchange failed: HTTP %d: %s", resp.StatusCode, snippet(body))
	}
	var tr oauthTokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return "", fmt.Errorf("fcm: oauth exchange: decode response: %v", err)
	}
	if tr.AccessToken == "" || tr.ExpiresIn <= 0 {
		return "", fmt.Errorf("fcm: oauth exchange: response missing access_token/expires_in")
	}
	f.accessToken = tr.AccessToken
	f.tokenExpiry = time.Now().Add(time.Duration(tr.ExpiresIn)*time.Second - fcmTokenSkew)
	return f.accessToken, nil
}

// fcmSendRequest / fcmMessage / fcmNotification mirror the FCM HTTP v1
// send body. notification is omitted when the message carries no visible
// title/body (data-only push); data is omitted when empty.
type fcmSendRequest struct {
	Message fcmMessage `json:"message"`
}

type fcmMessage struct {
	Token        string            `json:"token"`
	Notification *fcmNotification  `json:"notification,omitempty"`
	Data         map[string]string `json:"data,omitempty"`
}

type fcmNotification struct {
	Title string `json:"title,omitempty"`
	Body  string `json:"body,omitempty"`
}

// Send implements Notifier. One OAuth token fetch (cached) + one POST; no
// retries. Error classes: *NotifyInvalidTokenError (404/UNREGISTERED —
// S2 retires the token), *NotifyRetryError (429/5xx + Retry-After hint),
// plain errors otherwise.
func (f *FCMNotifier) Send(ctx context.Context, token string, msg NotifyMessage) error {
	if token == "" {
		return errors.New("fcm: send: empty token")
	}
	accessToken, err := f.token(ctx)
	if err != nil {
		return err
	}
	m := fcmMessage{
		Token: token,
		Data:  msg.Data,
	}
	if msg.Title != "" || msg.Body != "" {
		m.Notification = &fcmNotification{Title: msg.Title, Body: msg.Body}
	}
	payload, err := json.Marshal(fcmSendRequest{Message: m})
	if err != nil {
		return fmt.Errorf("fcm: marshal send body: %v", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.sendEndpoint(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := f.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("fcm: send: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("fcm: send: read response: %v", err)
	}
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	detail := snippet([]byte(scrubNotifyToken(string(body), token)))
	// Invalid-token: FCM answers 404 NOT_FOUND for an unregistered token
	// and spells the reason UNREGISTERED in the error details. Either
	// signal alone is conclusive (a proxy may rewrite the status; the
	// reason string may ride a different code).
	if resp.StatusCode == http.StatusNotFound || strings.Contains(detail, "UNREGISTERED") {
		return &NotifyInvalidTokenError{Detail: detail}
	}
	// Retryable: rate-limit (429) and provider-side transients (5xx),
	// with the parsed Retry-After hint when present.
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		return &NotifyRetryError{
			Status: resp.StatusCode,
			After:  parseRetryAfter(resp.Header.Get("Retry-After")),
			Detail: detail,
		}
	}
	return fmt.Errorf("fcm: send failed: HTTP %d: %s", resp.StatusCode, detail)
}

// scrubNotifyToken redacts the submitted device registration token from
// provider error text: a provider (or intermediary proxy) that echoes the
// token back in its error body cannot leak it into classified, surfaced,
// or persisted error strings (b-F2/c-F4). Applied to the FULL body before
// snippet's truncation, so a token straddling the cut cannot survive as a
// fragment.
func scrubNotifyToken(detail, token string) string {
	if token == "" {
		return detail
	}
	return strings.ReplaceAll(detail, token, "«token»")
}

// snippet collapses an error body to a bounded one-line summary for error
// text (never echoed at full length; the send path additionally scrubs the
// submitted device token — see scrubNotifyToken).
func snippet(body []byte) string {
	s := strings.TrimSpace(string(body))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	const max = 300
	if len(s) > max {
		s = s[:max] + "…"
	}
	if s == "" {
		s = "(empty body)"
	}
	return s
}

// parseRetryAfter parses the HTTP Retry-After hint (delta-seconds or
// HTTP-date); zero when absent/unparseable/negative.
func parseRetryAfter(v string) time.Duration {
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs > 0 {
			return time.Duration(secs) * time.Second
		}
		return 0
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}
