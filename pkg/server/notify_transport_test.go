package server

// notify_transport_test.go — lane-1 co-located tests for the push
// transport layer (slice S1; see notify_transport.go). Everything runs
// against httptest fakes: the FCM client's injectable endpoints (tokenURL
// + baseURL, empty = real Google defaults) are pinned by driving a
// fake OAuth exchange + fake FCM send with ZERO network. Covers: JWT
// assertion correctness (RS256 signature verified against the generated
// public key; iss/scope/aud/exp-iat claims), token caching (a second send
// does NOT re-exchange while unexpired; a short expires_in DOES), the
// send message shape + Authorization header + project-derived path,
// error classification (UNREGISTERED → retiring unregistered class; bare
// 404 → plain, 429/5xx + Retry-After → retry), credential parsing
// (PKCS#8 + PKCS#1, missing fields, real-Google extra fields ignored),
// the nullNotifier posture, and the default endpoints when nothing is
// injected.

import (
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
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Test scaffolding: key generation + service-account JSON
// ---------------------------------------------------------------------------

// testNotifyKey generates one RSA key per test needing it (2048-bit — the
// realistic Google shape; generation is ~100ms and lane-1 tolerates it).
func testNotifyKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	return key
}

// testServiceAccount renders a service-account JSON like Google issues
// (PKCS#8 PEM + the sibling fields real files carry — proving the parser
// tolerates them).
func testServiceAccount(key *rsa.PrivateKey, email, project string, pkcs1 bool) []byte {
	var der []byte
	var header string
	if pkcs1 {
		der = x509.MarshalPKCS1PrivateKey(key)
		header = "RSA PRIVATE KEY"
	} else {
		d, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			panic(err)
		}
		der = d
		header = "PRIVATE KEY"
	}
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: header, Bytes: der}))
	b, _ := json.Marshal(map[string]any{
		"type":                        "service_account",
		"project_id":                  project,
		"private_key_id":              "test-key-id",
		"private_key":                 pemKey,
		"client_email":                email,
		"client_id":                   "109876543210987654321",
		"auth_uri":                    "https://accounts.google.com/o/oauth2/auth",
		"token_uri":                   "https://oauth2.googleapis.com/token",
		"auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
		"client_x509_cert_url":        "https://www.googleapis.com/robot/v1/metadata/x509/" + email,
	})
	return b
}

// fakeOAuth is a scripted OAuth token endpoint.
type fakeOAuth struct {
	mu         sync.Mutex
	hitCount   int
	assertions []string
	grantTypes []string
	respond    func(hit int) (status int, body string)
	srv        *httptest.Server
}

func newFakeOAuth(t *testing.T) *fakeOAuth {
	t.Helper()
	f := &fakeOAuth{
		respond: func(int) (int, string) {
			return http.StatusOK, `{"access_token":"fake-access-token","token_type":"Bearer","expires_in":3600}`
		},
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.hitCount++
		hit := f.hitCount
		f.assertions = append(f.assertions, r.PostForm.Get("assertion"))
		f.grantTypes = append(f.grantTypes, r.PostForm.Get("grant_type"))
		f.mu.Unlock()
		status, body := f.respond(hit)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOAuth) hits() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hitCount
}

func (f *fakeOAuth) lastAssertion() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.assertions) == 0 {
		return ""
	}
	return f.assertions[len(f.assertions)-1]
}

// fakeFCM is a scripted FCM v1 messages:send endpoint.
type fakeFCM struct {
	mu             sync.Mutex
	hitCountLocked int
	requests       []fakeFCMRequest
	respond        func(hit int) (status int, body string, header http.Header)
	srv            *httptest.Server
}

type fakeFCMRequest struct {
	Path   string
	Auth   string
	Body   string
	Method string
}

func newFakeFCM(t *testing.T) *fakeFCM {
	t.Helper()
	f := &fakeFCM{
		respond: func(int) (int, string, http.Header) {
			return http.StatusOK, `{"name":"projects/test-proj/messages/0:1"}`, nil
		},
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		f.mu.Lock()
		f.hitCountLocked++
		hit := f.hitCountLocked
		f.requests = append(f.requests, fakeFCMRequest{
			Path:   r.URL.Path,
			Auth:   r.Header.Get("Authorization"),
			Body:   string(buf),
			Method: r.Method,
		})
		f.mu.Unlock()
		status, body, hdr := f.respond(hit)
		if hdr != nil {
			for k, vs := range hdr {
				for _, v := range vs {
					w.Header().Add(k, v)
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// count returns the number of send requests the fake received.
func (f *fakeFCM) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hitCountLocked
}

func (f *fakeFCM) request(i int) fakeFCMRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[i]
}

// newTestFCMNotifier builds an FCMNotifier from a fresh key + service
// account, pointed at the given fakes.
func newTestFCMNotifier(t *testing.T, key *rsa.PrivateKey, oauth *fakeOAuth, fcm *fakeFCM) *FCMNotifier {
	t.Helper()
	n, err := NewFCMNotifier(testServiceAccount(key, "push@test-proj.iam.gserviceaccount.com", "test-proj", false))
	if err != nil {
		t.Fatalf("NewFCMNotifier: %v", err)
	}
	n.tokenURL = oauth.srv.URL
	n.baseURL = fcm.srv.URL
	return n
}

// ---------------------------------------------------------------------------
// Credential parsing
// ---------------------------------------------------------------------------

// TestFCMNotifier_CredentialParse pins the constructor contract: both PEM
// forms accepted, real-Google sibling fields tolerated (deliberately NOT
// DisallowUnknownFields), and missing/malformed fields rejected with
// precise errors.
func TestFCMNotifier_CredentialParse(t *testing.T) {
	key := testNotifyKey(t)
	valid := testServiceAccount(key, "a@b.iam.gserviceaccount.com", "proj-x", false)
	if _, err := NewFCMNotifier(valid); err != nil {
		t.Fatalf("valid PKCS#8 service account rejected: %v", err)
	}
	valid1 := testServiceAccount(key, "a@b.iam.gserviceaccount.com", "proj-x", true)
	if _, err := NewFCMNotifier(valid1); err != nil {
		t.Fatalf("valid PKCS#1 service account rejected: %v", err)
	}

	for _, tc := range []struct {
		name   string
		json   string
		marker string
	}{
		{"not json", `not json`, "parse service-account JSON"},
		{"missing project_id", `{"client_email":"a@b","private_key":"` + pemString(t, key) + `"}`, "project_id is empty"},
		{"missing client_email", `{"project_id":"p","private_key":"` + pemString(t, key) + `"}`, "client_email"},
		{"malformed client_email", `{"project_id":"p","client_email":"nope","private_key":"` + pemString(t, key) + `"}`, "client_email"},
		{"missing private_key", `{"project_id":"p","client_email":"a@b"}`, "private_key"},
		{"private_key not PEM", `{"project_id":"p","client_email":"a@b","private_key":"raw-bytes"}`, "no PEM block"},
		{"private_key garbage PEM", `{"project_id":"p","client_email":"a@b","private_key":"-----BEGIN PRIVATE KEY-----\nZ2FyYmFnZQ==\n-----END PRIVATE KEY-----\n"}`, "not a parseable RSA key"},
	} {
		_, err := NewFCMNotifier([]byte(tc.json))
		if err == nil {
			t.Errorf("%s: accepted invalid credentials", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.marker) {
			t.Errorf("%s: error %q does not contain marker %q", tc.name, err.Error(), tc.marker)
		}
	}
}

// pemString renders the PKCS#8 PEM (helper for inline JSON cases).
func pemString(t *testing.T, key *rsa.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return strings.ReplaceAll(string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "\n", "\\n")
}

// TestFCMNotifier_DefaultEndpoints pins the injectable-URL contract: with
// nothing injected, the client targets the REAL Google endpoints (and the
// send URL embeds the project id).
func TestFCMNotifier_DefaultEndpoints(t *testing.T) {
	key := testNotifyKey(t)
	n, err := NewFCMNotifier(testServiceAccount(key, "a@b.iam.gserviceaccount.com", "my proj", false))
	if err != nil {
		t.Fatalf("NewFCMNotifier: %v", err)
	}
	if got := n.tokenEndpoint(); got != fcmDefaultTokenURL {
		t.Errorf("default token endpoint: want %s, got %s", fcmDefaultTokenURL, got)
	}
	if got, want := n.sendEndpoint(), "https://fcm.googleapis.com/v1/projects/my%20proj/messages:send"; got != want {
		t.Errorf("default send endpoint: want %s, got %s", want, got)
	}
	// An injected base URL replaces the whole origin but keeps the
	// versioned path shape.
	n.baseURL = "http://example.invalid/"
	if got, want := n.sendEndpoint(), "http://example.invalid/v1/projects/my%20proj/messages:send"; got != want {
		t.Errorf("injected send endpoint: want %s, got %s", want, got)
	}
	if n.Name() != "fcm" {
		t.Errorf("Name: want fcm, got %s", n.Name())
	}
}

// ---------------------------------------------------------------------------
// JWT / OAuth exchange
// ---------------------------------------------------------------------------

// TestFCMNotifier_JWTAndExchange drives Send against the fake pair and
// verifies the FULL OAuth correctness story: the assertion is a valid
// RS256 JWT (signature verified with the public key), its claims carry
// iss=client_email, scope=firebase.messaging, aud=the EFFECTIVE token
// endpoint (the fake — proving aud follows the injection), exp>iat with a
// 1h delta; the grant_type is the JWT-bearer urn; and the send carries
// the exchanged bearer token.
func TestFCMNotifier_JWTAndExchange(t *testing.T) {
	key := testNotifyKey(t)
	oauth := newFakeOAuth(t)
	fcm := newFakeFCM(t)
	n := newTestFCMNotifier(t, key, oauth, fcm)

	msg := NotifyMessage{Title: "T", Body: "B", Data: map[string]string{"k": "v"}}
	if err := n.Send(context.Background(), "device-token-aaaaaaaaaaaa", msg); err != nil {
		t.Fatalf("Send: %v", err)
	}

	assertion := oauth.lastAssertion()
	if assertion == "" {
		t.Fatal("no assertion reached the fake OAuth endpoint")
	}
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		t.Fatalf("assertion is not a JWS (want 3 dot-separated parts, got %d)", len(parts))
	}
	enc := base64.RawURLEncoding
	headerJSON, err := enc.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("decode JWT header: %v", err)
	}
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	if err := json.Unmarshal(headerJSON, &header); err != nil {
		t.Fatalf("parse JWT header: %v", err)
	}
	if header.Alg != "RS256" || header.Typ != "JWT" {
		t.Errorf("JWT header = %+v, want alg RS256 typ JWT", header)
	}
	claimsJSON, err := enc.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode JWT claims: %v", err)
	}
	var claims struct {
		Iss   string `json:"iss"`
		Scope string `json:"scope"`
		Aud   string `json:"aud"`
		Exp   int64  `json:"exp"`
		Iat   int64  `json:"iat"`
	}
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		t.Fatalf("parse JWT claims: %v", err)
	}
	if claims.Iss != "push@test-proj.iam.gserviceaccount.com" {
		t.Errorf("claims.iss = %q, want the service-account client_email", claims.Iss)
	}
	if claims.Scope != "https://www.googleapis.com/auth/firebase.messaging" {
		t.Errorf("claims.scope = %q, want the firebase.messaging scope", claims.Scope)
	}
	if claims.Aud != oauth.srv.URL {
		t.Errorf("claims.aud = %q, want the EFFECTIVE token endpoint %q (aud must follow the injected URL)", claims.Aud, oauth.srv.URL)
	}
	if claims.Exp <= claims.Iat {
		t.Errorf("claims.exp (%d) must be after iat (%d)", claims.Exp, claims.Iat)
	}
	if d := time.Duration(claims.Exp-claims.Iat) * time.Second; d != time.Hour {
		t.Errorf("claims exp-iat = %s, want 1h", d)
	}
	sig, err := enc.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decode JWT signature: %v", err)
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, sum[:], sig); err != nil {
		t.Errorf("JWT RS256 signature does not verify against the service-account public key: %v", err)
	}
	if gt := oauth.grantTypes[0]; gt != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
		t.Errorf("grant_type = %q, want the jwt-bearer urn", gt)
	}

	// The send rode the exchanged access token.
	req := fcm.request(0)
	if req.Auth != "Bearer fake-access-token" {
		t.Errorf("send Authorization = %q, want the fake-exchanged bearer", req.Auth)
	}
}

// TestFCMNotifier_TokenCaching pins the cache contract: while the token is
// unexpired, additional sends do NOT re-exchange (one OAuth hit for N
// sends); once the reported expiry (minus the early-refresh skew) passes,
// the next send re-exchanges.
func TestFCMNotifier_TokenCaching(t *testing.T) {
	key := testNotifyKey(t)
	oauth := newFakeOAuth(t)
	fcm := newFakeFCM(t)
	n := newTestFCMNotifier(t, key, oauth, fcm)

	msg := NotifyMessage{Title: "x", Body: "y"}
	for i := 0; i < 3; i++ {
		if err := n.Send(context.Background(), fmt.Sprintf("device-token-%d-aaaaaaaaa", i), msg); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	if got := oauth.hits(); got != 1 {
		t.Errorf("3 unexpired sends: want exactly 1 OAuth exchange, got %d", got)
	}

	// A short expires_in (1s) minus the 1m skew lands in the past, so the
	// very next send must re-exchange — proving the expiry math drives the
	// cache, not a "exchange once forever" bug.
	oauth.respond = func(int) (int, string) {
		return http.StatusOK, `{"access_token":"second-token","token_type":"Bearer","expires_in":1}`
	}
	n.mu.Lock()
	n.accessToken = ""
	n.tokenExpiry = time.Now().Add(-time.Second)
	n.mu.Unlock()
	if err := n.Send(context.Background(), "device-token-z-aaaaaaaaaa", msg); err != nil {
		t.Fatalf("send after forced expiry: %v", err)
	}
	if got := oauth.hits(); got != 2 {
		t.Errorf("after expiry: want a re-exchange (2 hits), got %d", got)
	}
}

// ---------------------------------------------------------------------------
// Message shape
// ---------------------------------------------------------------------------

// TestFCMNotifier_MessageShape pins the exact HTTP v1 envelope the fake
// FCM receives: POST, the project-derived path, and
// {"message":{"token":…,"notification":{title,body},"data":{…}}} —
// notification omitted for data-only messages, data omitted when empty.
func TestFCMNotifier_MessageShape(t *testing.T) {
	key := testNotifyKey(t)
	oauth := newFakeOAuth(t)
	fcm := newFakeFCM(t)
	n := newTestFCMNotifier(t, key, oauth, fcm)

	if err := n.Send(context.Background(), "the-device-token-000", NotifyMessage{
		Title: "Hello", Body: "World", Data: map[string]string{"a": "1", "b": "2"},
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	req := fcm.request(0)
	if req.Method != http.MethodPost {
		t.Errorf("method = %s, want POST", req.Method)
	}
	if want := "/v1/projects/test-proj/messages:send"; req.Path != want {
		t.Errorf("path = %q, want %q (project-derived)", req.Path, want)
	}
	var got struct {
		Message struct {
			Token        string `json:"token"`
			Notification *struct {
				Title string `json:"title"`
				Body  string `json:"body"`
			} `json:"notification"`
			Data map[string]string `json:"data"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(req.Body), &got); err != nil {
		t.Fatalf("decode send body %q: %v", req.Body, err)
	}
	if got.Message.Token != "the-device-token-000" {
		t.Errorf("message.token = %q (must be VERBATIM)", got.Message.Token)
	}
	if got.Message.Notification == nil || got.Message.Notification.Title != "Hello" || got.Message.Notification.Body != "World" {
		t.Errorf("message.notification = %+v, want title Hello body World", got.Message.Notification)
	}
	if len(got.Message.Data) != 2 || got.Message.Data["a"] != "1" || got.Message.Data["b"] != "2" {
		t.Errorf("message.data = %v, want the flat string map", got.Message.Data)
	}

	// Data-only message: notification must be omitted.
	if err := n.Send(context.Background(), "the-device-token-001", NotifyMessage{
		Data: map[string]string{"only": "data"},
	}); err != nil {
		t.Fatalf("Send data-only: %v", err)
	}
	body2 := fcm.request(1).Body
	if strings.Contains(body2, "notification") {
		t.Errorf("data-only send must omit notification, body=%s", body2)
	}
	// No-data message: data must be omitted.
	if err := n.Send(context.Background(), "the-device-token-002", NotifyMessage{Title: "t"}); err != nil {
		t.Fatalf("Send no-data: %v", err)
	}
	body3 := fcm.request(2).Body
	if strings.Contains(body3, "\"data\"") {
		t.Errorf("no-data send must omit data, body=%s", body3)
	}
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

// TestFCMNotifier_ErrorClassification pins the typed-error taxonomy the
// S2 sender will branch on.
func TestFCMNotifier_ErrorClassification(t *testing.T) {
	key := testNotifyKey(t)
	oauth := newFakeOAuth(t)
	fcm := newFakeFCM(t)
	n := newTestFCMNotifier(t, key, oauth, fcm)
	ctx := context.Background()

	// 404 + UNREGISTERED → the retiring unregistered class (canonical
	// FCM shape for a dead token).
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusNotFound, `{"error":{"code":404,"message":"The registration token is not registered","status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`, nil
	}
	err := n.Send(ctx, "dead-token-aaaaaaaaaaaa", NotifyMessage{})
	var unreg *NotifyUnregisteredError
	if !errorsAs(err, &unreg) {
		t.Errorf("404+UNREGISTERED: want *NotifyUnregisteredError, got %T: %v", err, err)
	}

	// UNREGISTERED detail (on a non-404 status) → unregistered too — the
	// reason string is conclusive whatever status a proxy left on it.
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusBadRequest, `{"error":{"code":400,"message":"The registration token is not registered","status":"INVALID_ARGUMENT","details":[{"errorCode":"UNREGISTERED"}]}}`, nil
	}
	err = n.Send(ctx, "dead-token-aaaaaaaaaaaa", NotifyMessage{})
	if !errorsAs(err, &unreg) {
		t.Errorf("UNREGISTERED: want *NotifyUnregisteredError, got %T: %v", err, err)
	}

	// BARE 404 (NOT_FOUND only, no UNREGISTERED) → a PLAIN send-failure
	// error, NOT the retiring class: a misconfigured project answers 404
	// for every send and must not mass-retire a healthy registry.
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusNotFound, `{"error":{"code":404,"message":"Requested entity was not found","status":"NOT_FOUND"}}`, nil
	}
	err = n.Send(ctx, "live-token-aaaaaaaaaaaaa", NotifyMessage{})
	if err == nil {
		t.Fatal("bare 404: want an error")
	}
	if errorsAs(err, &unreg) {
		t.Errorf("bare 404 must NOT classify as unregistered (retirement safety): %v", err)
	}
	var retry *NotifyRetryError
	if errorsAs(err, &retry) {
		t.Errorf("bare 404 must not classify as retry either: %v", err)
	}
	if !strings.Contains(err.Error(), "HTTP 404") {
		t.Errorf("bare 404 plain error should name the status: %v", err)
	}
	// 429 + Retry-After → retry error carrying the hint.
	hdr := http.Header{}
	hdr.Set("Retry-After", "37")
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusTooManyRequests, `{"error":{"code":429,"message":"Quota exceeded"}}`, hdr
	}
	err = n.Send(ctx, "live-token-aaaaaaaaaaaaa", NotifyMessage{})
	if !errorsAs(err, &retry) {
		t.Errorf("429: want *NotifyRetryError, got %T: %v", err, err)
	} else {
		if retry.Status != http.StatusTooManyRequests {
			t.Errorf("retry.Status = %d, want 429", retry.Status)
		}
		if retry.After != 37*time.Second {
			t.Errorf("retry.After = %s, want 37s (parsed Retry-After)", retry.After)
		}
	}

	// 5xx → retry signal, zero hint when no Retry-After.
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusServiceUnavailable, `internal`, nil
	}
	err = n.Send(ctx, "live-token-aaaaaaaaaaaaa", NotifyMessage{})
	if !errorsAs(err, &retry) {
		t.Errorf("503: want *NotifyRetryError, got %T: %v", err, err)
	} else if retry.Status != http.StatusServiceUnavailable || retry.After != 0 {
		t.Errorf("503 retry = status %d after %s, want 503/0", retry.Status, retry.After)
	}

	// 200 → nil.
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusOK, `{"name":"projects/p/messages/1"}`, nil
	}
	if err := n.Send(ctx, "live-token-aaaaaaaaaaaaa", NotifyMessage{}); err != nil {
		t.Errorf("200: want nil error, got %v", err)
	}

	// 403 (SENDER_ID_MISMATCH-shaped) → plain error, NOT unregistered/retry.
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusForbidden, `{"error":{"code":403,"message":"SenderId mismatch"}}`, nil
	}
	err = n.Send(ctx, "live-token-aaaaaaaaaaaaa", NotifyMessage{})
	if err == nil {
		t.Fatal("403: want an error")
	}
	if errorsAs(err, &unreg) || errorsAs(err, &retry) {
		t.Errorf("403: must be a plain error, got a typed one: %v", err)
	}

	// OAuth exchange failure → plain error mentioning the exchange.
	oauth.respond = func(int) (int, string) {
		return http.StatusBadRequest, `{"error":"invalid_grant"}`
	}
	n.mu.Lock()
	n.accessToken = ""
	n.tokenExpiry = time.Now().Add(-time.Second)
	n.mu.Unlock()
	err = n.Send(ctx, "live-token-aaaaaaaaaaaaa", NotifyMessage{})
	if err == nil || !strings.Contains(err.Error(), "oauth exchange") {
		t.Errorf("oauth failure: want plain oauth-exchange error, got %v", err)
	}

	// Empty token → plain error (caller misuse, not a provider signal).
	if err := n.Send(ctx, "", NotifyMessage{}); err == nil || errorsAs(err, &unreg) {
		t.Errorf("empty token: want plain error, got %v", err)
	}
}

// errorsAs is a thin alias so the classification table reads uniformly.
func errorsAs(err error, target any) bool {
	return errors.As(err, target)
}

// TestFCMNotifier_ErrorDetailTokenScrub pins the b-F2/c-F4 hardening: a
// provider (or intermediary proxy) that echoes the submitted device token
// verbatim in its error body cannot leak it into classified/surfaced/
// persisted error text — every occurrence is redacted to «token» before
// classification, and the classification itself is unaffected.
func TestFCMNotifier_ErrorDetailTokenScrub(t *testing.T) {
	key := testNotifyKey(t)
	oauth := newFakeOAuth(t)
	fcm := newFakeFCM(t)
	n := newTestFCMNotifier(t, key, oauth, fcm)
	ctx := context.Background()
	tok := "echoed-fcm-device-token-314159265358979"

	// UNREGISTERED on a 400 whose message echoes the token verbatim →
	// still classified unregistered, but the surfaced text is token-free.
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusBadRequest, `{"error":{"code":400,"message":"The registration token ` + tok + ` is not registered","status":"INVALID_ARGUMENT","details":[{"errorCode":"UNREGISTERED"}]}}`, nil
	}
	err := n.Send(ctx, tok, NotifyMessage{})
	var unreg *NotifyUnregisteredError
	if !errorsAs(err, &unreg) {
		t.Fatalf("UNREGISTERED+echo: want *NotifyUnregisteredError, got %T: %v", err, err)
	}
	if got := err.Error(); strings.Contains(got, tok) {
		t.Errorf("unregistered error leaks the device token: %q", got)
	}
	if got := err.Error(); !strings.Contains(got, "«token»") {
		t.Errorf("unregistered error should carry the redaction marker: %q", got)
	}

	// Plain 403 whose body echoes the token → plain error, token-free.
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusForbidden, `{"error":{"code":403,"message":"SenderId mismatch for token ` + tok + `"}}`, nil
	}
	err = n.Send(ctx, tok, NotifyMessage{})
	if err == nil {
		t.Fatal("403: want an error")
	}
	if got := err.Error(); strings.Contains(got, tok) {
		t.Errorf("plain error leaks the device token: %q", got)
	}

	// Retry class detail is scrubbed too.
	hdr := http.Header{}
	hdr.Set("Retry-After", "5")
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusTooManyRequests, `{"error":{"code":429,"message":"Quota exceeded for ` + tok + `"}}`, hdr
	}
	err = n.Send(ctx, tok, NotifyMessage{})
	var retry *NotifyRetryError
	if !errorsAs(err, &retry) {
		t.Fatalf("429: want *NotifyRetryError, got %T: %v", err, err)
	} else if strings.Contains(retry.Detail, tok) || !strings.Contains(retry.Detail, "«token»") {
		t.Errorf("retry detail not scrubbed: %q", retry.Detail)
	}
}

// ---------------------------------------------------------------------------
// nullNotifier
// ---------------------------------------------------------------------------

// TestNullNotifier pins the disabled posture: name "null", Send returns
// ErrNotifyDisabled (errors.Is-able), and notifyTransportDisabled
// recognizes nil, nullNotifier, and passes a real transport.
func TestNullNotifier(t *testing.T) {
	n := NewNullNotifier()
	if n.Name() != "null" {
		t.Errorf("Name = %q, want null", n.Name())
	}
	if err := n.Send(context.Background(), "tok", NotifyMessage{}); err == nil || err.Error() != ErrNotifyDisabled.Error() {
		t.Errorf("Send = %v, want ErrNotifyDisabled", err)
	}
	if !notifyTransportDisabled(nil) {
		t.Error("nil transport must classify as disabled")
	}
	if !notifyTransportDisabled(nullNotifier{}) {
		t.Error("nullNotifier must classify as disabled")
	}
	key := testNotifyKey(t)
	real, err := NewFCMNotifier(testServiceAccount(key, "a@b", "p", false))
	if err != nil {
		t.Fatal(err)
	}
	if notifyTransportDisabled(real) {
		t.Error("an FCMNotifier must NOT classify as disabled")
	}
}
