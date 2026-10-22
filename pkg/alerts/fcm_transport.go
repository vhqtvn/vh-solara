package alerts

// fcm_transport.go — the FCM HTTP v1 transport core shared by the worker's
// notify sender (notify.go) and the controller's central dispatcher (notify
// controller-hub S4, pkg/server/notify_dispatch.go). Extracted from the
// worker Notifier in S4 as the "narrowly-shared seam": everything that is
// transport — the OAuth2 service-account flow (RS256 JWT → access token,
// cached, refreshed ~5 min before expiry), the send policy (401 → ONE
// forced token refresh + one retry; clean 5xx → ONE cheap retry; no queue,
// no backoff loop), UNREGISTERED evidence classification, and the
// attempt-lifecycle observability surface (window counters + the probe's
// last_attempt/last_error pair) — lives here. Everything that is POLICY —
// profile/attendance/cooldown gating, token registries, prune ownership —
// belongs to the caller and is deliberately absent.
//
// The worker's Notifier EMBEDS this type by value (notify.go); the
// controller constructs it directly via NewFCMTransportFromFile with the
// CONTROLLER's own credentials (FCM credentials exist only on the
// controller in v4 — never copied to workers, never logged).
//
// Secrets discipline (unchanged): the credentials file contents, the
// private key, the OAuth access token, and the device tokens are never
// logged and never appear in an error message — errors and log lines carry
// status codes, canonical error names, label-or-hash token references, and
// paths only.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// AndroidConfig is the message.android delivery posture for one send:
// priority HIGH|NORMAL, collapse-by-event key, and the TTL in WHOLE
// SECONDS. Callers derive the TTL from their own policy — the worker uses
// its configured notify.ttl_sec; the controller bounds the configured TTL
// by the event's remaining freshness (an old replay never gets a fresh
// full TTL).
type AndroidConfig struct {
	Priority    string
	CollapseKey string
	TTLSeconds  int
}

// SendFailure classifies one failed delivery for the log line, the window
// counters, and the probe's sanitized last_error. Reason is a short
// classified phrase; Status is the HTTP status when the failure came from a
// response (0 otherwise); Canonical is FCM's google error.status name when
// the body carried one (e.g. NOT_FOUND, UNREGISTERED); Err optionally
// carries the underlying transport error (which never contains token or
// key material — only URLs, timeouts, and status lines). Pruned marks the
// UNREGISTERED prune path (counted separately, still logged). SendFailure
// implements error so callers can hand it straight to telemetry surfaces.
type SendFailure struct {
	Reason    string
	Status    int
	Canonical string
	Err       error
	Pruned    bool
}

// Error implements error with the sanitized summary.
func (f *SendFailure) Error() string { return f.Summary() }

// Summary renders the sanitized operator-facing error string: "404
// NOT_FOUND" when a status and canonical name exist, "429 rate limited
// (quota)" when only a status does, or the bare reason (no status), e.g.
// "oauth exchange failed".
func (f *SendFailure) Summary() string {
	switch {
	case f.Status > 0 && f.Canonical != "":
		return strconv.Itoa(f.Status) + " " + f.Canonical
	case f.Status > 0:
		return strconv.Itoa(f.Status) + " " + f.Reason
	default:
		return f.Reason
	}
}

// FCMTransport is the shared FCM HTTP v1 transport core (see the file
// header). Zero value is not usable — construct via NewNotifier (the
// worker path) or NewFCMTransportFromFile (the controller path). Safe for
// concurrent use.
type FCMTransport struct {
	client *http.Client
	now    func() time.Time
	logger *slog.Logger // vhlog's shared logger by default; overridable in tests
	ttl    int          // the caller-policy default TTL (seconds); per-send TTLs ride AndroidConfig

	projectID string
	creds     serviceAccount
	signer    *rsa.PrivateKey

	// fcmBase is the FCM API root; the default is fcmDefaultBase, overridden
	// in tests via SetBaseURL.
	fcmBase string

	tokMu  sync.Mutex
	tokVal string
	tokExp time.Time

	// statMu guards the observability surface: window counters for the
	// periodic health line plus the operator-checkable last_attempt /
	// last_error pair. The pair is published TOGETHER, under one lock hold,
	// only when an attempt COMPLETES — an in-flight attempt stays invisible
	// to the probe. Failures still never block delivery.
	statMu      sync.Mutex
	attempted   int64     // delivery units started since the last health line
	succeeded   int64     // delivered OK since the last health line
	failed      int64     // failed (any class) since the last health line
	pruned      int64     // pruned as UNREGISTERED since the last health line
	lastAttempt time.Time // start time of the most recent COMPLETED attempt (zero before any completes)
	lastErr     string    // sanitized outcome of that same completed attempt ("" when it succeeded)
}

// newFCMTransport assembles the core from already-loaded credentials.
func newFCMTransport(creds serviceAccount, key *rsa.PrivateKey, projectID string, ttlSec int) *FCMTransport {
	return &FCMTransport{
		client:    &http.Client{Timeout: 10 * time.Second},
		now:       time.Now,
		logger:    vhlog.Logger(),
		projectID: projectID,
		creds:     creds,
		signer:    key,
		ttl:       ttlSec,
		fcmBase:   fcmDefaultBase,
	}
}

// NewFCMTransportFromFile loads a Google service-account credentials file
// and returns the transport core for a NON-worker sender — the controller's
// central dispatcher (notify controller-hub S4), which constructs its OWN
// instance with the controller's credentials. projectID falls back to the
// credentials file's project when empty; ttlSec <= 0 becomes the 24h
// default. External calls happen only inside Deliver — this parses and
// validates locally, and errors name the path and failing step only.
func NewFCMTransportFromFile(credentialsPath, projectID string, ttlSec int) (*FCMTransport, error) {
	creds, key, err := loadServiceAccount(credentialsPath)
	if err != nil {
		return nil, err
	}
	if projectID == "" {
		projectID = creds.ProjectID
	}
	if projectID == "" {
		return nil, errors.New("notify: no project_id (config or credentials file)")
	}
	if ttlSec <= 0 {
		ttlSec = fcmDefaultTTL
	}
	return newFCMTransport(creds, key, projectID, ttlSec), nil
}

// SetBaseURL overrides the FCM API root (the lane-1 test seam: a
// httptest fake stands in for fcm.googleapis.com with zero network).
func (c *FCMTransport) SetBaseURL(base string) { c.fcmBase = base }

// --- OAuth2 service-account token (stdlib only) ---

// assertion builds the signed RS256 JWT for the token exchange.
func (c *FCMTransport) assertion(iat time.Time) (string, error) {
	header := b64url([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(struct {
		Iss   string `json:"iss"`
		Scope string `json:"scope"`
		Aud   string `json:"aud"`
		Iat   int64  `json:"iat"`
		Exp   int64  `json:"exp"`
	}{
		Iss:   c.creds.ClientEmail,
		Scope: fcmScope,
		Aud:   c.creds.TokenURI,
		Iat:   iat.Unix(),
		Exp:   iat.Add(fcmJWTLifetime).Unix(),
	})
	if err != nil {
		return "", err
	}
	input := header + "." + b64url(claims)
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, c.signer, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return input + "." + b64url(sig), nil
}

// accessToken returns a cached access token, exchanging a fresh JWT when
// the cache is empty or within fcmTokenLeadTime of expiry. force discards
// the cache first (the 401 recovery path: refresh once, then treat as
// failure).
func (c *FCMTransport) accessToken(force bool) (string, error) {
	c.tokMu.Lock()
	defer c.tokMu.Unlock()
	now := c.now()
	if force {
		c.tokVal, c.tokExp = "", time.Time{}
	}
	if c.tokVal != "" && now.Add(fcmTokenLeadTime).Before(c.tokExp) {
		return c.tokVal, nil
	}
	assert, err := c.assertion(now)
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assert},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.creds.TokenURI,
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("notify: token exchange: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("notify: token exchange status %d", resp.StatusCode)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil {
		return "", fmt.Errorf("notify: token exchange response: %w", err)
	}
	if out.AccessToken == "" {
		return "", errors.New("notify: token exchange returned no access_token")
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 3600
	}
	c.tokVal = out.AccessToken
	c.tokExp = now.Add(time.Duration(out.ExpiresIn) * time.Second)
	return c.tokVal, nil
}

// --- the delivery unit ---

// Deliver executes one full delivery unit: the attempt-lifecycle
// bookkeeping (window counters + the probe's last_attempt/last_error pair
// published TOGETHER at completion), the FCM POST policy (401 → one forced
// token refresh + one retry; clean 5xx → one cheap retry; nothing else
// retries), UNREGISTERED evidence classification, the caller's PRUNE
// action, and the per-failure log line (token identified by label-or-hash —
// never the token value). It returns nil on success or the classified
// *SendFailure.
//
// prune, when non-nil, is invoked when — and only when — FCM answers 400
// or 404 with canonical UNREGISTERED evidence in the error body (either a
// details[].errorCode entry or a top-level error.status, exactly the
// worker sender's two accepted shapes). A generic 404 NOT_FOUND
// (sender-side misconfiguration) does NOT invoke prune: it is the plain
// send-failure class, and pruning on it would mass-erase a healthy
// registry. Pruning POLICY is the caller's: the worker prunes its token
// registry directly; the controller binds the prune to the registry
// GENERATION so a stale in-flight result cannot delete a since-re-registered
// token (v4 §9.5). A prune error classifies the attempt as failed
// ("token unregistered but prune failed") rather than pruned.
func (c *FCMTransport) Deliver(token, label string, data map[string]string, android *AndroidConfig, prune func() error) *SendFailure {
	started := c.now() // this attempt's start time, published with its own outcome below

	c.statMu.Lock()
	c.attempted++
	c.statMu.Unlock()

	msg := fcmMessage{Token: token, Data: data}
	if android != nil {
		ttl := android.TTLSeconds
		if ttl <= 0 {
			ttl = c.ttl
		}
		msg.Android = &fcmAndroidConfig{
			Priority:    android.Priority,
			CollapseKey: android.CollapseKey,
			TTL:         strconv.Itoa(ttl) + "s",
		}
	}
	f := c.send(token, msg, 0, false, prune)

	// Publish last_attempt and last_error TOGETHER, only at attempt
	// COMPLETION: the pair always describes ONE whole attempt — its start
	// time plus its own outcome (a success clears the error). Until then
	// the probe shows the untouched zero state, and overlapping attempts
	// can never pair one attempt's timestamp with another's outcome.
	c.statMu.Lock()
	c.lastAttempt = started
	switch {
	case f == nil:
		c.succeeded++
		c.lastErr = "" // the completed attempt succeeded — current channel health is OK
	case f.Pruned:
		c.pruned++
		c.lastErr = f.Summary()
	default:
		c.failed++
		c.lastErr = f.Summary()
	}
	c.statMu.Unlock()

	if f != nil {
		c.logFailure(tokenRefOf(label, token), f)
	}
	return f
}

// logFailure emits the one-line-per-failure record. channel=notify, the
// classified reason, the HTTP status where applicable, and the token as
// label-or-hash — never the value, credentials material, or response
// bodies.
func (c *FCMTransport) logFailure(ref string, f *SendFailure) {
	attrs := []any{"channel", "notify", "token", ref, "reason", f.Reason}
	if f.Status > 0 {
		attrs = append(attrs, "status", f.Status)
	}
	if f.Canonical != "" {
		attrs = append(attrs, "code", f.Canonical)
	}
	if f.Err != nil {
		attrs = append(attrs, "err", f.Err.Error())
	}
	if f.Pruned {
		c.logger.Warn("notify: token unregistered, pruned", attrs...)
		return
	}
	c.logger.Warn("notify: fcm send failed", attrs...)
}

// send posts the message, applying the retry/prune policy. attempt counts
// posts so far (0 = first); refreshed marks that the OAuth token was
// already force-refreshed for this message (a second 401 is a failure). It
// returns nil on success or a classified *SendFailure.
func (c *FCMTransport) send(token string, msg fcmMessage, attempt int, refreshed bool, prune func() error) *SendFailure {
	access, err := c.accessToken(refreshed)
	if err != nil {
		return &SendFailure{Reason: "oauth exchange failed", Err: err}
	}
	body, err := json.Marshal(struct {
		Message fcmMessage `json:"message"`
	}{msg})
	if err != nil {
		return &SendFailure{Reason: "marshal message failed", Err: err}
	}
	endpoint := c.fcmBase + "/v1/projects/" + url.PathEscape(c.projectID) + "/messages:send"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return &SendFailure{Reason: "request build failed", Err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("User-Agent", "vh-solara-notify/1")
	resp, err := c.client.Do(req)
	if err != nil {
		return &SendFailure{Reason: "transport error", Err: err}
	}
	defer resp.Body.Close()

	// 401 → the cached OAuth token went stale: force-refresh once and retry.
	if resp.StatusCode == http.StatusUnauthorized && !refreshed {
		return c.send(token, msg, attempt+1, true, prune)
	}
	// 5xx → one cheap retry, then give up.
	if resp.StatusCode >= 500 && attempt < 1 {
		return c.send(token, msg, attempt+1, refreshed, prune)
	}
	// Terminal non-2xx: read (bounded) body once for the canonical error
	// name and the UNREGISTERED inspection. Only parsed fields are used —
	// the raw body is never surfaced.
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	canonical := fcmErrorStatus(raw)

	// Token gone: 400 or 404 carrying error detail UNREGISTERED → prune.
	// A generic 404 NOT_FOUND (FCM's answer to sender-side misconfiguration,
	// e.g. a wrong/deleted project ID) carries no UNREGISTERED evidence and
	// must leave registrations intact — pruning on it would mass-erase every
	// valid token. Both statuses share the same body-inspection rule.
	if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusNotFound {
		if fcmIsUnregistered(raw) {
			if prune != nil {
				if perr := prune(); perr != nil {
					return &SendFailure{Reason: "token unregistered but prune failed", Status: resp.StatusCode, Canonical: "UNREGISTERED", Err: perr}
				}
			}
			return &SendFailure{Reason: "token unregistered (pruned)", Status: resp.StatusCode, Canonical: "UNREGISTERED", Pruned: true}
		}
		return &SendFailure{Reason: "fcm rejected message", Status: resp.StatusCode, Canonical: canonical}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return &SendFailure{Reason: "rate limited (quota)", Status: resp.StatusCode, Canonical: canonical}
	}
	if resp.StatusCode >= 300 {
		if resp.StatusCode == http.StatusUnauthorized {
			return &SendFailure{Reason: "unauthenticated after refresh", Status: resp.StatusCode, Canonical: canonical}
		}
		if resp.StatusCode >= 500 {
			return &SendFailure{Reason: "fcm 5xx retry exhausted", Status: resp.StatusCode, Canonical: canonical}
		}
		return &SendFailure{Reason: "fcm error", Status: resp.StatusCode, Canonical: canonical}
	}
	return nil
}

// --- observability surface ---

// notifyHealthInterval is the default period of the channel-health log line.
const notifyHealthInterval = 10 * time.Minute

// tokenRefOf renders a token for log lines: the LABEL when present, else
// the sha256 hash prefix the cooldown map keys on (sum[:16] bytes, hex).
// The token VALUE never enters a log line or error string.
func tokenRefOf(label, token string) string {
	if label != "" {
		return label
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:16])
}

// Health returns the operator-checkable channel state: the start time of
// the most recent COMPLETED FCM send attempt and that same attempt's
// sanitized outcome (empty when it succeeded). Both stay zero values until
// some attempt has completed — an in-flight attempt is invisible. Safe for
// concurrent use; never carries token material.
func (c *FCMTransport) Health() (time.Time, string) {
	c.statMu.Lock()
	defer c.statMu.Unlock()
	return c.lastAttempt, c.lastErr
}

// SetLogger swaps the failure/health log target. Production keeps the
// daemon's shared vhlog logger; tests use a discard or buffered handler so
// failure-path coverage never writes real Warn lines into the test run's
// stderr. Call before the first Deliver — the per-token delivery paths
// read the field without a lock.
func (c *FCMTransport) SetLogger(l *slog.Logger) {
	if l != nil {
		c.logger = l
	}
}

// StartHealthLoop launches the periodic channel-health line: the enabled
// state and token counts by policy (both supplied by the CALLER — the
// worker reads its config + token registry, the controller its central
// store) plus attempted/succeeded/failed/pruned counters since the previous
// line (window counters reset on each line). interval <= 0 means the
// daemon default (notifyHealthInterval). Returns immediately; the loop
// exits when ctx is cancelled.
func (c *FCMTransport) StartHealthLoop(ctx context.Context, interval time.Duration, enabled func() bool, policyCounts func() map[string]int) {
	if interval <= 0 {
		interval = notifyHealthInterval
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.logHealth(enabled, policyCounts)
			}
		}
	}()
}

// logHealth snapshots-and-resets the window counters and emits the health
// line. The counters are maintained under statMu by Deliver(); this reader
// takes the same lock, so no new races.
func (c *FCMTransport) logHealth(enabled func() bool, policyCounts func() map[string]int) {
	c.statMu.Lock()
	attempted, succeeded, failed, pruned := c.attempted, c.succeeded, c.failed, c.pruned
	c.attempted, c.succeeded, c.failed, c.pruned = 0, 0, 0, 0
	c.statMu.Unlock()
	enabledNow := false
	if enabled != nil {
		enabledNow = enabled()
	}
	var counts map[string]int
	if policyCounts != nil {
		counts = policyCounts()
	}
	c.logger.Info("notify: channel health",
		"channel", "notify",
		"enabled", enabledNow,
		"tokens_when_unattended", counts[PolicyWhenUnattended],
		"tokens_always", counts[PolicyAlways],
		"attempted", attempted,
		"succeeded", succeeded,
		"failed", failed,
		"pruned", pruned)
}
