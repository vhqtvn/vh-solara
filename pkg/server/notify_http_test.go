package server

// notify_http_test.go — lane-1 co-located tests for the /vh/notify/*
// HTTP family (slice S1; see notify_http.go). Drives the REAL handler
// chain (auth middleware + csrfGuard + userMux — buildRootHandler) with
// a passphrase session, exactly like the fleet-config tests. Covers:
//
//   - the CSRF ladder (403 mutation without the header / 401
//     unauthenticated / 405 wrong method / GET CSRF-exempt);
//   - the full token lifecycle (create → masked list → patch → delete),
//     pinning that the RAW TOKEN NEVER appears in any response body;
//   - strict decode refusals and the disabled-store 409 posture;
//   - THE CRUX: POST /vh/admin/notify/test through the real chain driving the
//     fake-OAuth + fake-FCM pair (both bare-token and by-id paths) — the
//     fake FCM must receive the correct message envelope; error
//     surfacing and registry telemetry included.

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

// newNotifyAuthDaemon builds a passphrase-auth daemon (no host pattern —
// the notify family is host-independent) and returns it with the root
// handler plus a logged-in session cookie.
func newNotifyAuthDaemon(t *testing.T) (*Daemon, http.Handler, *http.Cookie) {
	t.Helper()
	d := NewDaemon(":0", ":0", "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()
	return d, h, loginPassphrase(t, h, "secret")
}

// loadNotifyStore installs the registry holder on the daemon at a path
// inside a temp dir where the file does NOT exist yet (the first-boot
// empty-start posture). It also installs the drain JOIN: the async
// send-result drain persists into this temp dir from a background
// goroutine that outlives the test body, so the test must not end
// (t.TempDir's RemoveAll) while a persist may still be in flight —
// "unlinkat ...: directory not empty". The cleanup below runs BEFORE
// that RemoveAll (cleanups are LIFO, and TempDir's was registered by the
// t.TempDir call above).
func loadNotifyStore(t *testing.T, d *Daemon) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "notify-tokens.json")
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatalf("LoadNotifyStore: %v", err)
	}
	t.Cleanup(d.notifyStore.flushSendResults)
	return path
}

// doNotify issues a request against the real chain with the standard
// option decorators (withCookie / withCSRF / withHost live in the sibling
// test files).
func doNotify(t *testing.T, h http.Handler, method, path, body string, opts ...func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	var rd *strings.Reader
	if body == "" {
		rd = strings.NewReader("")
	} else {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rd)
	for _, o := range opts {
		o(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// notifyTokenWireView mirrors the response envelope (kept local so a wire
// drift breaks compilation, not silence).
type notifyTokenWireView struct {
	Schema  int  `json:"schema"`
	Created bool `json:"created"`
	Token   struct {
		ID           string     `json:"id"`
		Label        string     `json:"label"`
		TokenPreview string     `json:"token_preview"`
		PushPolicy   string     `json:"push_policy"`
		CreatedAt    time.Time  `json:"created_at"`
		LastUsedAt   *time.Time `json:"last_used_at"`
		LastError    string     `json:"last_error"`
		Scope        struct {
			Enabled    bool     `json:"enabled"`
			Conditions []string `json:"conditions"`
		} `json:"scope"`
	} `json:"token"`
}

type notifyListWireView struct {
	Schema int `json:"schema"`
	Tokens []struct {
		ID           string     `json:"id"`
		Label        string     `json:"label"`
		TokenPreview string     `json:"token_preview"`
		PushPolicy   string     `json:"push_policy"`
		LastUsedAt   *time.Time `json:"last_used_at"`
		LastError    string     `json:"last_error"`
		Scope        struct {
			Enabled    bool     `json:"enabled"`
			Conditions []string `json:"conditions"`
		} `json:"scope"`
	} `json:"tokens"`
}

// notifyProbeView mirrors the v4 public probe (GET /vh/notify/tokens).
type notifyProbeView struct {
	Enabled     bool           `json:"enabled"`
	Count       int            `json:"count"`
	Policies    map[string]int `json:"policies"`
	LastAttempt string         `json:"last_attempt"`
	LastError   string         `json:"last_error"`
}

type notifyTestWireView struct {
	Schema    int    `json:"schema"`
	Sent      bool   `json:"sent"`
	Transport string `json:"transport"`
	Error     string `json:"error"`
}

// fakeNotifyClock installs a controllable clock on the test-send rate
// limit seam (notifyTestSendNow) and returns an advance function.
// Restored via t.Cleanup. Lane-1 determinism: the rate-limit tests (and
// the crux test's rapid consecutive sends) advance time instead of
// sleeping 10s.
func fakeNotifyClock(t *testing.T) (advance func(time.Duration)) {
	t.Helper()
	now := time.Now()
	notifyTestSendNow = func() time.Time { return now }
	t.Cleanup(func() { notifyTestSendNow = time.Now })
	return func(d time.Duration) { now = now.Add(d) }
}

// stubNotifier is a minimal configured transport for the rate-limit
// tests: every Send succeeds, Name is stable. (The full FCM pair is
// exercised by the crux test; the limit itself needs no provider.)
type stubNotifier struct{ sends int }

func (n *stubNotifier) Name() string { return "stub" }
func (n *stubNotifier) Send(context.Context, string, NotifyMessage) error {
	n.sends++
	return nil
}

// ---------------------------------------------------------------------------
// CSRF ladder + method discipline
// ---------------------------------------------------------------------------

// TestNotifyHTTP_CSRFLadder pins the family's auth surface: mutations
// 403 without X-VH-CSRF (IN-handler — csrfGuard is /api/-scoped),
// unauthenticated requests get the clean API-class 401 under /vh/*, GET
// is CSRF-exempt, and wrong methods get the mux's 405.
func TestNotifyHTTP_CSRFLadder(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)

	// 403: authenticated POST without the header.
	rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens", `{"token":"fcm-token-ladder-aaaaaa"}`, withCookie(session))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("POST without CSRF: want 403, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), csrfHeader) {
		t.Fatalf("403 body must name the missing header: %q", rec.Body.String())
	}
	rec = doNotify(t, h, http.MethodDelete, "/vh/admin/notify/tokens/0011223344556677", "", withCookie(session))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("DELETE without CSRF: want 403, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPatch, "/vh/admin/notify/tokens/0011223344556677", `{}`, withCookie(session))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("PATCH without CSRF: want 403, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"token":"x"}`, withCookie(session))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("test POST without CSRF: want 403, got %d", rec.Code)
	}

	// 401: unauthenticated (API-class /vh/* — clean 401, not a redirect).
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/vh/notify/tokens", `{"token":"fcm-token-ladder-aaaaaa"}`},
		{http.MethodGet, "/vh/notify/tokens", ""},
		{http.MethodPost, "/vh/admin/notify/test", `{"token":"fcm-token-ladder-aaaaaa"}`},
	} {
		rec := doNotify(t, h, tc.method, tc.path, tc.body, withCSRF())
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("unauthenticated %s %s: want 401, got %d", tc.method, tc.path, rec.Code)
		}
	}

	// GET with a session but no CSRF header: exempt, 200.
	rec = doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET with session, no CSRF: want 200 (exempt), got %d", rec.Code)
	}

	// 405: PUT is not registered on the collection.
	rec = doNotify(t, h, http.MethodPut, "/vh/notify/tokens", `{}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT /vh/notify/tokens: want 405, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// Lifecycle: create → list → patch → delete (masked everywhere)
// ---------------------------------------------------------------------------

// TestNotifyHTTP_TokenLifecycle is the registry's behavioral pin through
// the real chain under the v4 contract: public registration answers
// {"ok":true} (never a token echo), the full-state POST rule refreshes
// label+policy (a re-POST without push_policy RESETS to when_unattended)
// without touching administrative scopes, the ADMIN masked list shows the
// policy, strict PATCH keeps working, 404/204 delete — and the RAW TOKEN
// never appears in ANY response body along the way.
func TestNotifyHTTP_TokenLifecycle(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	raw := "fcm-lifecycle-token-0001"

	// v4 public registration: 200 {"ok":true} — no masked echo.
	rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"`+raw+`","label":"Operator phone","push_policy":"always"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("create: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if got, want := strings.TrimSpace(rec.Body.String()), `{"ok":true}`; got != want {
		t.Fatalf("create body = %s, want %s", got, want)
	}

	// Full-state re-POST without push_policy: 200, and the ADMIN list
	// shows the policy RESET to when_unattended with the label refreshed.
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"`+raw+`","label":"Tablet"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("re-submit: want 200, got %d", rec.Code)
	}

	// The ADMIN masked list (the S4 home of the S1 list; S5 relocates the
	// rest of the admin family here and points NotifyDialog at it).
	rec = doNotify(t, h, http.MethodGet, "/vh/admin/notify/tokens", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("admin list: want 200, got %d", rec.Code)
	}
	var list notifyListWireView
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Tokens) != 1 {
		t.Fatalf("list holds %d tokens, want 1 (body=%s)", len(list.Tokens), rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), raw) {
		t.Fatalf("MASKING LEAK: raw token appears in GET /vh/admin/notify/tokens: %s", rec.Body.String())
	}
	if list.Tokens[0].TokenPreview == "" || list.Tokens[0].TokenPreview == raw {
		t.Errorf("token_preview = %q, want a masked preview", list.Tokens[0].TokenPreview)
	}
	if want := "fcm-li" + string('…') + "0001"; list.Tokens[0].TokenPreview != want {
		t.Errorf("token_preview = %q, want %q", list.Tokens[0].TokenPreview, want)
	}
	if list.Tokens[0].PushPolicy != "when_unattended" {
		t.Errorf("full-state re-POST without push_policy must RESET the policy, got %q", list.Tokens[0].PushPolicy)
	}
	if list.Tokens[0].Label != "Tablet" {
		t.Errorf("full-state re-POST must refresh the label, got %q", list.Tokens[0].Label)
	}
	id := list.Tokens[0].ID

	// PATCH label + scope (wholesale) — the administrative surface keeps
	// working against the migrated store.
	rec = doNotify(t, h, http.MethodPatch, "/vh/admin/notify/tokens/"+id,
		`{"label":"Tablet","scope":{"enabled":false,"conditions":["worker_down"]}}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("patch: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), raw) {
		t.Fatalf("MASKING LEAK: raw token in PATCH response: %s", rec.Body.String())
	}
	var patched notifyTokenWireView
	_ = json.Unmarshal(rec.Body.Bytes(), &patched)
	if patched.Token.Label != "Tablet" || patched.Token.Scope.Enabled ||
		len(patched.Token.Scope.Conditions) != 1 || patched.Token.Scope.Conditions[0] != "worker_down" {
		t.Errorf("patched = %+v", patched.Token)
	}

	// A later full-state POST setting always must NOT override the
	// administrative disable (v4 §3.2).
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"`+raw+`","push_policy":"always"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("re-POST over disabled: want 200, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodGet, "/vh/admin/notify/tokens", "", withCookie(session))
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if list.Tokens[0].Scope.Enabled || len(list.Tokens[0].Scope.Conditions) != 1 {
		t.Fatalf("a full-state POST must not override administrative disable/scopes: %+v", list.Tokens[0].Scope)
	}
	if list.Tokens[0].PushPolicy != "always" {
		t.Errorf("re-POST with push_policy=always must set the policy: %+v", list.Tokens[0])
	}

	// PATCH refusals: unknown field / empty patch / missing scope member /
	// unknown condition / unknown id / bad id.
	for _, tc := range []struct {
		name, body, marker string
		code               int
		id                 string
	}{
		{"unknown field", `{"nope":1}`, "unknown field", 400, id},
		{"empty patch", `{}`, "nothing to update", 400, id},
		{"missing scope member", `{"scope":{"enabled":true}}`, "scope.conditions is required", 400, id},
		{"unknown condition", `{"scope":{"enabled":true,"conditions":["nope"]}}`, "unknown condition", 400, id},
		{"unknown id", `{"label":"x"}`, "unknown token id", 404, "8899aabbccddeeff"},
		{"bad id shape", `{"label":"x"}`, "invalid token id", 400, "not-hex!"},
	} {
		rec := doNotify(t, h, http.MethodPatch, "/vh/admin/notify/tokens/"+tc.id, tc.body, withCookie(session), withCSRF())
		if rec.Code != tc.code {
			t.Errorf("%s: want %d, got %d (body=%q)", tc.name, tc.code, rec.Code, rec.Body.String())
			continue
		}
		if !strings.Contains(rec.Body.String(), tc.marker) {
			t.Errorf("%s: body must contain %q, got %q", tc.name, tc.marker, rec.Body.String())
		}
	}

	// Create refusals: unknown field, bad token charset, too-short token,
	// oversize body, trailing document, invalid push_policy (the v4 400).
	for _, tc := range []struct {
		name, body, marker string
	}{
		{"unknown key", `{"token":"ok-token-aaaaaaaaaa","x":1}`, "unknown field"},
		{"token with space", `{"token":"abc defghijklmnop"}`, "printable ASCII"},
		{"token too short", `{"token":"short"}`, "outside the"},
		{"token missing", `{"label":"x"}`, "token required"},
		{"invalid push_policy", `{"token":"ok-token-aaaaaaaaaa","push_policy":"sometimes"}`, "invalid push_policy"},
		{"trailing doc", `{"token":"ok-token-aaaaaaaaaa"} {}`, "exactly one JSON document"},
		{"oversize", `{"token":"` + strings.Repeat("A", 5000) + `"}`, "byte cap"},
	} {
		rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens", tc.body, withCookie(session), withCSRF())
		if rec.Code != http.StatusBadRequest {
			t.Errorf("create %s: want 400, got %d", tc.name, rec.Code)
			continue
		}
		if !strings.Contains(rec.Body.String(), tc.marker) {
			t.Errorf("create %s: body must contain %q, got %q", tc.name, tc.marker, rec.Body.String())
		}
	}

	// DELETE: 204, then the entry is gone (admin list empty, id now 404).
	rec = doNotify(t, h, http.MethodDelete, "/vh/admin/notify/tokens/"+id, "", withCookie(session), withCSRF())
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: want 204, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	rec = doNotify(t, h, http.MethodDelete, "/vh/admin/notify/tokens/"+id, "", withCookie(session), withCSRF())
	if rec.Code != http.StatusNotFound {
		t.Fatalf("re-delete: want 404, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodGet, "/vh/admin/notify/tokens", "", withCookie(session))
	var after notifyListWireView
	_ = json.Unmarshal(rec.Body.Bytes(), &after)
	if len(after.Tokens) != 0 {
		t.Errorf("registry must be empty after delete, has %d", len(after.Tokens))
	}

	// The persisted file never contained anything but the canonical form.
	// (Round-trip covered in notify_store_test.go.)
}

// TestNotifyHTTP_DisabledStorePosture pins the honest disabled posture
// under the v4 split: the PUBLIC routes answer the central-channel
// posture (POST 503 "notify unavailable" BEFORE body validation; the
// probe 200-always with the disabled shape — the app's connectivity
// check must keep working), while the ADMIN family keeps its honest 409
// naming the flag (an empty list would read as "zero devices
// registered", which is a lie).
func TestNotifyHTTP_DisabledStorePosture(t *testing.T) {
	_, h, session := newNotifyAuthDaemon(t)

	// Public POST: 503 notify-unavailable, BEFORE body validation (even a
	// malformed body answers 503 while the channel is down).
	rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens", `{"token":"fcm-disabled-aaaaaaaaa"`, withCookie(session), withCSRF())
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("public POST (disabled store): want 503, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "notify unavailable") {
		t.Errorf("public POST 503 body must say notify unavailable, got %q", rec.Body.String())
	}

	// Public probe: 200-always with the honest disabled shape.
	rec = doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("probe (disabled store): want 200-always, got %d", rec.Code)
	}
	var probe notifyProbeView
	if err := json.Unmarshal(rec.Body.Bytes(), &probe); err != nil {
		t.Fatalf("probe body: %v (%s)", err, rec.Body.String())
	}
	if probe.Enabled || probe.Count != 0 || probe.Policies["when_unattended"] != 0 || probe.Policies["always"] != 0 ||
		probe.LastAttempt != "" || probe.LastError != "" {
		t.Fatalf("disabled probe = %+v, want the honest disabled shape", probe)
	}

	// Admin family: honest 409s naming the flag.
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/vh/admin/notify/tokens", ""},
		{http.MethodDelete, "/vh/admin/notify/tokens/0011223344556677", ""},
		{http.MethodPatch, "/vh/admin/notify/tokens/0011223344556677", `{"label":"x"}`},
	} {
		rec := doNotify(t, h, tc.method, tc.path, tc.body, withCookie(session), withCSRF())
		if rec.Code != http.StatusConflict {
			t.Errorf("%s %s (disabled store): want 409, got %d", tc.method, tc.path, rec.Code)
			continue
		}
		if !strings.Contains(rec.Body.String(), "--notify-store") {
			t.Errorf("%s %s: 409 body must name --notify-store, got %q", tc.method, tc.path, rec.Body.String())
		}
	}
}

// TestNotifyHTTP_DisabledTransportPosture pins the test-send 409 when no
// credentials are configured (null transport), naming
// --notify-fcm-credentials — while the REGISTRY still works (tokens can
// be enrolled before credentials exist).
func TestNotifyHTTP_DisabledTransportPosture(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	// d.notifyTransport is nil (never set) — the literal-Daemon posture.

	rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens", `{"token":"fcm-credless-aaaaaaaa"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("enroll without transport: want 200 (registry is independent), got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"token":"fcm-credless-aaaaaaaa"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusConflict {
		t.Fatalf("test-send without transport: want 409, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "--notify-fcm-credentials") {
		t.Fatalf("409 body must name --notify-fcm-credentials: %q", rec.Body.String())
	}
	// Explicit null transport (the cmd/server.go unset-flag wiring) — same posture.
	d.SetNotifyTransport(NewNullNotifier())
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"token":"fcm-credless-aaaaaaaa"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "--notify-fcm-credentials") {
		t.Fatalf("explicit null transport: want 409 naming the flag, got %d %q", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// THE CRUX: test-send through the real chain → fake OAuth + fake FCM
// ---------------------------------------------------------------------------

// TestNotifyHTTP_TestSendThroughRealChain is the slice's behavioral
// crux: POST /vh/admin/notify/test through the FULL handler chain (session
// auth + csrfGuard + userMux → handler → FCMNotifier with injected
// endpoints) drives the fake OAuth exchange + fake FCM send, and the
// fake FCM receives the CORRECT message envelope for BOTH the bare-token
// and by-id paths. Also pins: token caching across the two sends (one
// OAuth exchange), typed-error surfacing in the response, registry
// telemetry on the by-id path, and body refusals.
func TestNotifyHTTP_TestSendThroughRealChain(t *testing.T) {
	key := testNotifyKey(t)
	oauth := newFakeOAuth(t)
	fcm := newFakeFCM(t)
	n := newTestFCMNotifier(t, key, oauth, fcm)

	d, h, session := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	d.SetNotifyTransport(n)
	// The test-send rate limit (10s per Daemon) would refuse the crux
	// test's rapid consecutive sends; drive the seam clock instead.
	advance := fakeNotifyClock(t)

	// Bare-token path: test BEFORE registering.
	rec := doNotify(t, h, http.MethodPost, "/vh/admin/notify/test",
		`{"token":"fcm-bare-00000000000001"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("bare-token test-send: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	var view notifyTestWireView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode test-send body: %v", err)
	}
	if !view.Sent || view.Transport != "fcm" || view.Error != "" {
		t.Fatalf("bare-token response = %+v, want sent/fcm/no-error", view)
	}

	// Register the token, then exercise the by-id path (the v4 public POST
	// answers {"ok":true}; the ID comes from the admin masked list).
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"fcm-byid-00000000000001","label":"Phone"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
	rec = doNotify(t, h, http.MethodGet, "/vh/admin/notify/tokens", "", withCookie(session))
	var enrolledList notifyListWireView
	if err := json.Unmarshal(rec.Body.Bytes(), &enrolledList); err != nil || len(enrolledList.Tokens) != 1 {
		t.Fatalf("admin list after enroll: err=%v body=%s", err, rec.Body.String())
	}
	id := enrolledList.Tokens[0].ID

	advance(notifyTestSendInterval) // rate limit: the bare send just consumed the slot
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test",
		`{"id":"`+id+`"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("by-id test-send: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &view)
	if !view.Sent || view.Transport != "fcm" {
		t.Fatalf("by-id response = %+v", view)
	}

	// THE ENVELOPES: both sends reached the fake FCM with the correct
	// message shape (fixed test message) and the exchanged bearer.
	if got := fcm.count(); got != 2 {
		t.Fatalf("fake FCM received %d sends, want 2", got)
	}
	for i, tok := range []string{"fcm-bare-00000000000001", "fcm-byid-00000000000001"} {
		req := fcm.request(i)
		if req.Auth != "Bearer fake-access-token" {
			t.Errorf("send %d Authorization = %q", i, req.Auth)
		}
		var env struct {
			Message struct {
				Token        string `json:"token"`
				Notification *struct {
					Title string `json:"title"`
					Body  string `json:"body"`
				} `json:"notification"`
				Data map[string]string `json:"data"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(req.Body), &env); err != nil {
			t.Fatalf("send %d body: %v (%s)", i, err, req.Body)
		}
		if env.Message.Token != tok {
			t.Errorf("send %d token = %q, want %q VERBATIM", i, env.Message.Token, tok)
		}
		if env.Message.Notification == nil || env.Message.Notification.Title != "vh-solara" {
			t.Errorf("send %d notification = %+v, want the fixed test title", i, env.Message.Notification)
		}
		if env.Message.Data["vh_kind"] != "test" {
			t.Errorf("send %d data = %v, want vh_kind=test", i, env.Message.Data)
		}
	}

	// Token caching: two sends → ONE OAuth exchange.
	if got := oauth.hits(); got != 1 {
		t.Errorf("two sends caused %d OAuth exchanges, want 1 (cached)", got)
	}

	// Registry telemetry on the by-id path (best-effort, ASYNC — the
	// response returns before the file write lands, so poll).
	if !waitForNotify(time.Second, func() bool {
		e, ok := d.notifyStore.byID(id)
		return ok && e.LastUsedAt != nil && e.LastError == ""
	}) {
		e, _ := d.notifyStore.byID(id)
		t.Errorf("by-id send must (asynchronously) record last_used_at and clear last_error: %+v", e)
	}

	// Error surfacing: FCM answers a BARE 404 (no UNREGISTERED) →
	// sent:false + the plain send-failure text naming the status.
	// (advance: the by-id send consumed the rate-limit slot; the FAILED
	// send must also reach the provider — a refusal here would 429.)
	fcm.respond = func(int) (int, string, http.Header) {
		return http.StatusNotFound, `{"error":{"code":404,"message":"Requested entity was not found","status":"NOT_FOUND"}}`, nil
	}
	advance(notifyTestSendInterval)
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test",
		`{"id":"`+id+`"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("failed test-send must still be 200 (sent:false), got %d", rec.Code)
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &view)
	if view.Sent || !strings.Contains(view.Error, "HTTP 404") {
		t.Fatalf("failed test-send response = %+v, want sent:false + plain HTTP-404 error text", view)
	}
	if !waitForNotify(time.Second, func() bool {
		e, ok := d.notifyStore.byID(id)
		return ok && strings.Contains(e.LastError, "HTTP 404")
	}) {
		e, _ := d.notifyStore.byID(id)
		t.Errorf("registry last_error must (asynchronously) carry the failure: %q", e.LastError)
	}

	// Body refusals: both/neither, unknown id, bad bare token, unknown field.
	for _, tc := range []struct {
		name, body, marker string
		code               int
	}{
		{"both", `{"token":"x","id":"y"}`, "exactly one of token or id", 400},
		{"neither", `{}`, "exactly one of token or id", 400},
		{"unknown field", `{"token":"x","z":1}`, "unknown field", 400},
		{"bad bare token", `{"token":"short"}`, "outside the", 400},
		{"unknown id", `{"id":"8899aabbccddeeff"}`, "unknown token id", 404},
	} {
		rec := doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", tc.body, withCookie(session), withCSRF())
		if rec.Code != tc.code {
			t.Errorf("test-send %s: want %d, got %d (body=%q)", tc.name, tc.code, rec.Code, rec.Body.String())
			continue
		}
		if !strings.Contains(rec.Body.String(), tc.marker) {
			t.Errorf("test-send %s: body must contain %q, got %q", tc.name, tc.marker, rec.Body.String())
		}
	}
}

// ---------------------------------------------------------------------------
// hostInterceptor precedence
// ---------------------------------------------------------------------------

// TestNotifyHTTP_HostInterceptorPrecedence pins the /vh/notify/ prefix
// carve-out AND the /vh/admin/notify/ family-prefix carve-out
// (tier1_b/F1): a request on a per-worker SUBDOMAIN host must be served
// by the CONTROLLER (masked JSON), never proxied down to the worker
// (which has no /vh/notify/ route — its catch-all would serve the SPA
// shell) and never 502'd for an offline/unknown worker BEFORE userMux
// runs. The admin half is the dialog's actual fetch: NotifyDialog GETs
// /vh/admin/notify/tokens from worker-subdomain hosts, so the masked
// list must come from the controller there too.
// Mirrors TestHostInterceptorFleetConfigRoutePrecedence.
func TestNotifyHTTP_HostInterceptorPrecedence(t *testing.T) {
	// Host pattern armed (matches any single-label subdomain of
	// example.test) so the interceptor is in the chain.
	d := NewDaemon(":0", ":0", "$ID.example.test")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	// Seed ONE registered device so the admin masked list has visible
	// content to assert against (preview, label — never the raw token).
	raw := "fcm-hostint-0000000001"
	path := filepath.Join(t.TempDir(), "notify-tokens.json")
	if err := persistNotifyStore(path, &notifyStoreFile{Schema: 2, Tokens: []notifyStoreEntry{{
		ID:         "0011223344556677",
		Token:      raw,
		Label:      "Operator phone",
		PushPolicy: "always",
		CreatedAt:  time.Now().UTC().Truncate(time.Second),
		Scope:      notifyScope{Enabled: true, Conditions: []string{}},
	}}}); err != nil {
		t.Fatal(err)
	}
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatal(err)
	}

	// A worker subdomain host (no such worker registered — without the
	// carve-out the interceptor would 502 with "Worker alpha not found").
	rec := doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withHost("alpha.example.test"), withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("worker-subdomain GET /vh/notify/tokens: want controller 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	var probe notifyProbeView
	if err := json.Unmarshal(rec.Body.Bytes(), &probe); err != nil || probe.Enabled {
		t.Fatalf("worker-subdomain response must be the controller's v4 probe (transport unconfigured ⇒ enabled:false): err=%v body=%s", err, rec.Body.String())
	}
	if probe.Count != 1 || probe.Policies["always"] != 1 {
		t.Fatalf("worker-subdomain probe must reflect the seeded device (count/policies), got %+v", probe)
	}

	// The subpath shape ({id}) is covered by the PREFIX carve-out too.
	// (8899… is NOT the seeded id — this stays the unknown-id 404 pin,
	// not a real delete of the seeded device below.)
	rec = doNotify(t, h, http.MethodDelete, "/vh/admin/notify/tokens/8899aabbccddeeff", "", withHost("alpha.example.test"), withCookie(session), withCSRF())
	if rec.Code != http.StatusNotFound {
		t.Errorf("worker-subdomain DELETE unknown id: want controller 404, got %d", rec.Code)
	}

	// THE BLOCKER PIN (tier1_b/F1): the ADMIN masked list is
	// controller-served on a worker-subdomain host. Unknown subdomain
	// ("alpha" is not registered): without the /vh/admin/notify/ prefix
	// carve-out the interceptor 502s ("Worker alpha not found or
	// offline") BEFORE userMux — the exact NotifyDialog failure this
	// pins.
	rec = doNotify(t, h, http.MethodGet, "/vh/admin/notify/tokens", "", withHost("alpha.example.test"), withCookie(session))
	if rec.Code == http.StatusBadGateway {
		t.Fatalf("hostInterceptor proxied GET /vh/admin/notify/tokens (502) — admin-notify carve-out missing or broken")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("worker-subdomain GET /vh/admin/notify/tokens: want controller 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	assertMaskedControllerList(t, rec, raw)

	// The OFFLINE-worker case (no 502): a REGISTERED worker whose tunnel
	// is down — the interceptor's "not found or offline" fast-fail branch
	// would 502 without the carve-out. NotifyDialog must still get the
	// masked list.
	d.Registry.AddWorker(&Worker{ID: "beta", Name: "beta-worker", Status: "offline", Version: "v1"})
	rec = doNotify(t, h, http.MethodGet, "/vh/admin/notify/tokens", "", withHost("beta.example.test"), withCookie(session))
	if rec.Code == http.StatusBadGateway {
		t.Fatalf("hostInterceptor 502'd GET /vh/admin/notify/tokens for an OFFLINE worker — admin-notify carve-out missing or broken")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("offline-worker-subdomain GET /vh/admin/notify/tokens: want controller 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	assertMaskedControllerList(t, rec, raw)
}

// assertMaskedControllerList checks that rec carries the CONTROLLER's
// masked admin list for the seeded device — the JSON envelope with the
// masked preview + label, and NEVER the raw token (a proxied worker
// would answer its SPA shell; a 502 never reaches here).
func assertMaskedControllerList(t *testing.T, rec *httptest.ResponseRecorder, raw string) {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("admin list Content-Type: want application/json (controller handler), got %q", ct)
	}
	var list notifyListWireView
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("admin list must decode as the controller's masked JSON: %v (body=%s)", err, rec.Body.String())
	}
	if list.Schema != 1 || len(list.Tokens) != 1 {
		t.Fatalf("admin list = schema %d with %d tokens, want the controller's 1-token envelope (body=%s)", list.Schema, len(list.Tokens), rec.Body.String())
	}
	got := list.Tokens[0]
	if got.Label != "Operator phone" || got.PushPolicy != "always" {
		t.Fatalf("admin list entry = %q/%q, want the seeded device (label/policy)", got.Label, got.PushPolicy)
	}
	if want := "fcm-ho" + string('…') + "0001"; got.TokenPreview != want {
		t.Fatalf("token_preview = %q, want the masked %q", got.TokenPreview, want)
	}
	if strings.Contains(rec.Body.String(), raw) {
		t.Fatalf("MASKING LEAK: raw token appears in the worker-subdomain admin list: %s", rec.Body.String())
	}
}

// TestNotifyHTTP_RegistryFilePersistsThroughChain proves the handler
// chain's mutations land in the FILE (not just memory): after a create,
// the on-disk registry contains the raw token and reloads strictly.
func TestNotifyHTTP_RegistryFilePersistsThroughChain(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	path := loadNotifyStore(t, d)
	rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"fcm-persist-0000000001","label":" disk "}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "fcm-persist-0000000001") {
		t.Errorf("persisted registry must contain the raw token (it is the send authority):\n%s", data)
	}
	f, err := loadNotifyStoreFile(path)
	if err != nil {
		t.Fatalf("strict reload of the handler-written file: %v", err)
	}
	if len(f.Tokens) != 1 || f.Tokens[0].Label != " disk " {
		t.Errorf("reloaded file = %+v", f.Tokens)
	}
}

// TestNotifyHTTP_EmptyStartGetPosture pins the GET posture after a
// missing-file empty start through the REAL chain: the registry is
// configured (not the 503/409 disabled postures), the public probe
// serves the honest enabled:false + zero-count shape, the file itself is
// still absent (lazy create), and the first create through the chain
// materializes it.
func TestNotifyHTTP_EmptyStartGetPosture(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	path := loadNotifyStore(t, d)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("empty start must not create the store file (lazy first write), stat err=%v", err)
	}

	rec := doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET after empty start: want 200 (configured, empty), got %d (body=%q)", rec.Code, rec.Body.String())
	}
	var probe notifyProbeView
	if err := json.Unmarshal(rec.Body.Bytes(), &probe); err != nil {
		t.Fatalf("probe after empty start: %v (%s)", err, rec.Body.String())
	}
	if probe.Enabled || probe.Count != 0 || probe.Policies["when_unattended"] != 0 || probe.Policies["always"] != 0 {
		t.Fatalf("empty-start probe = %+v, want disabled + zero counts", probe)
	}

	// First mutation through the real chain creates the file.
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"fcm-token-empty-start-1","label":"Phone"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("first create after empty start: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("first mutation through the chain must create the store file: %v", err)
	}
	f, err := loadNotifyStoreFile(path)
	if err != nil || len(f.Tokens) != 1 {
		t.Fatalf("reload after chain create: err=%v tokens=%+v", err, f.Tokens)
	}
}

// TestNotifyHTTP_TestSendRateLimit pins the S3 test-send rate limit:
// per-Daemon, 10s minimum between ATTEMPTS (a failed send consumes a
// slot; a refused one does not extend the window), 429 + Retry-After +
// a body naming the wait, and the gate sits AFTER decode/resolve (bad
// bodies and unknown ids keep their precise 400/404 without consuming
// or extending a slot).
func TestNotifyHTTP_TestSendRateLimit(t *testing.T) {
	stub := &stubNotifier{}
	d, h, session := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	d.SetNotifyTransport(stub)
	advance := fakeNotifyClock(t)

	// Enroll one token so the by-id path is exercisable (the v4 public
	// POST answers {"ok":true}; the ID comes from the admin masked list).
	rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"fcm-ratelimit-000001","label":"Phone"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
	rec = doNotify(t, h, http.MethodGet, "/vh/admin/notify/tokens", "", withCookie(session))
	var enrolledList notifyListWireView
	if err := json.Unmarshal(rec.Body.Bytes(), &enrolledList); err != nil || len(enrolledList.Tokens) != 1 {
		t.Fatalf("admin list after enroll: err=%v body=%s", err, rec.Body.String())
	}
	id := enrolledList.Tokens[0].ID

	// First send: allowed, reaches the stub transport.
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"token":"fcm-ratelimit-000001"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("first send: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if stub.sends != 1 {
		t.Fatalf("stub.sends = %d, want 1", stub.sends)
	}

	// Rapid second send (bare-token path): 429 + Retry-After naming the
	// full wait; the provider is untouched.
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"token":"fcm-ratelimit-000001"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rapid second send: want 429, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got != "10" {
		t.Errorf("Retry-After = %q, want %q", got, "10")
	}
	if !strings.Contains(rec.Body.String(), "wait 10s") {
		t.Errorf("429 body must name the wait: %q", rec.Body.String())
	}
	if stub.sends != 1 {
		t.Fatalf("refused send must not reach the provider: stub.sends = %d", stub.sends)
	}

	// The limit is per-Daemon, not per-token or per-path: a DIFFERENT
	// token, and the by-id path, are equally refused inside the window.
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"token":"fcm-ratelimit-000002"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("different bare token inside the window: want 429, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"id":"`+id+`"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("by-id inside the window: want 429, got %d", rec.Code)
	}

	// Partial wait: 4s in, the remaining 6s is named; the 429s above did
	// NOT extend the window (they never record).
	advance(4 * time.Second)
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"token":"fcm-ratelimit-000001"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("4s into the window: want 429, got %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "6" {
		t.Errorf("Retry-After after 4s = %q, want 6", got)
	}

	// Validation refusals keep their precise codes WITHOUT consuming or
	// extending a slot (the gate sits after decode/resolve).
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty test body: want 400, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"id":"8899aabbccddeeff"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown id: want 404, got %d", rec.Code)
	}

	// Past the interval (exactly 10s after the RECORDED attempt — the
	// interleaved 429/400/404 did not shift it): the send passes. Bare-
	// token on purpose: a by-id send here would queue ASYNC registry
	// telemetry whose drain persists into t.TempDir() after the test
	// returns (racing RemoveAll); the by-id rate-limit behavior is
	// already pinned by the in-window 429 above.
	advance(6 * time.Second)
	rec = doNotify(t, h, http.MethodPost, "/vh/admin/notify/test", `{"token":"fcm-ratelimit-000001"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("send after full interval: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if stub.sends != 2 {
		t.Errorf("stub.sends = %d, want 2 (refusals never reached the provider)", stub.sends)
	}
	var view notifyTestWireView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !view.Sent || view.Transport != "stub" {
		t.Errorf("response = %+v, want sent/stub", view)
	}
}

// TestNotifyHTTP_RegisterPersistFailureV4Envelope pins t1a-F2: a store
// persistence failure on the PUBLIC registration route answers the v4
// error envelope — 500, Content-Type application/json, decoded
// {"ok":false,"error":…} (the notify-fcm.md §3.1 response table) — never
// a plain-text http.Error. The persist failure is forced through the
// notifyCreateExcl seam; the registry itself stays untouched
// (persist-before-swap).
func TestNotifyHTTP_RegisterPersistFailureV4Envelope(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	orig := notifyCreateExcl
	notifyCreateExcl = func(name string) (*os.File, error) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrPermission}
	}
	t.Cleanup(func() { notifyCreateExcl = orig })

	rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"fcm-persist-fail-0001","label":"x"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("persistence failure: want 500, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json (the v4 envelope)", ct)
	}
	var body struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("the 500 body must decode as the v4 JSON envelope: %v (%s)", err, rec.Body.String())
	}
	if body.OK || body.Error == "" || !strings.Contains(body.Error, "notification registry") {
		t.Fatalf("v4 500 envelope = %+v, want ok:false + a non-empty registry error", body)
	}
	// Persist-before-swap: the failed submit left running state untouched.
	if snap := d.notifyStore.snapshot(); len(snap.entries) != 0 {
		t.Fatalf("failed persist must leave running state untouched, got %d entries", len(snap.entries))
	}
}

// TestNotifyHTTP_RegisterRefusalEnvelopeUniformity pins the t1c-F2
// rider: the invalid-token 400 (validNotifyToken failure) and every
// decode-failure 400 on the PUBLIC registration route answer the v4 JSON
// envelope (Content-Type application/json, {"ok":false,"error":…}) like
// the mirrored worker route — no plain-text http.Error remains on the
// handler's 4xx paths, and the status codes are unchanged (400).
func TestNotifyHTTP_RegisterRefusalEnvelopeUniformity(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d) // the store must be configured or the 503 gate wins over decode
	for _, tc := range []struct{ name, body, marker string }{
		{"invalid token charset", `{"token":"abc defghijklmnop"}`, "printable ASCII"},
		{"token too short", `{"token":"short"}`, "outside the"},
		{"decode: unknown field", `{"token":"ok-token-aaaaaaaaaa","x":1}`, "unknown field"},
		{"decode: trailing document", `{"token":"ok-token-aaaaaaaaaa"} {}`, "exactly one JSON document"},
		{"decode: empty document", ``, "empty document"},
		{"decode: oversize body", `{"token":"` + strings.Repeat("A", 5000) + `"}`, "byte cap"},
	} {
		rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens", tc.body, withCookie(session), withCSRF())
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400 (status unchanged), got %d (body=%q)", tc.name, rec.Code, rec.Body.String())
			continue
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("%s: Content-Type = %q, want application/json (the v4 envelope)", tc.name, ct)
			continue
		}
		var body struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("%s: body must decode as the v4 JSON envelope: %v (%s)", tc.name, err, rec.Body.String())
			continue
		}
		if body.OK || !strings.Contains(body.Error, tc.marker) {
			t.Errorf("%s: v4 envelope = %+v, want ok:false + error containing %q", tc.name, body, tc.marker)
		}
	}
}

// TestNotifyRead_TokensGetUnchanged pins the Slice-2 additivity fence
// under the S4 probe: the shared read cursor lives in the HISTORY surface
// only — the public probe response carries no read_id/unread_count keys
// and its shape is byte-stable across an ack.
func TestNotifyRead_TokensGetUnchanged(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	d.notifyHistory.append(histEntry(fleetCondWorkerDown, notifyActionAppeared, 1))

	before := doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))
	if before.Code != http.StatusOK {
		t.Fatalf("tokens GET: %d", before.Code)
	}

	// Ack through the real read route, then re-GET tokens.
	ack := doRead(t, h, `{"id":1}`, withCookie(session), withCSRF())
	if ack.Code != http.StatusOK {
		t.Fatalf("read ack: %d (%s)", ack.Code, ack.Body.String())
	}
	after := doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))

	var probe map[string]json.RawMessage
	if err := json.Unmarshal(after.Body.Bytes(), &probe); err != nil {
		t.Fatalf("tokens body: %v", err)
	}
	for _, key := range []string{"read_id", "unread_count"} {
		if _, ok := probe[key]; ok {
			t.Errorf("tokens GET must not carry %q (history-surface only): %s", key, after.Body.String())
		}
	}
	for _, key := range []string{"enabled", "count", "policies", "last_attempt", "last_error"} {
		if _, ok := probe[key]; !ok {
			t.Errorf("probe lost required field %q: %s", key, after.Body.String())
		}
	}
	if before.Body.String() != after.Body.String() {
		t.Errorf("tokens GET body changed across an ack:\nbefore: %s\nafter:  %s", before.Body.String(), after.Body.String())
	}
}
