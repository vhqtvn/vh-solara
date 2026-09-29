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
//   - THE CRUX: POST /vh/notify/test through the real chain driving the
//     fake-OAuth + fake-FCM pair (both bare-token and by-id paths) — the
//     fake FCM must receive the correct message envelope; error
//     surfacing and registry telemetry included.

import (
	"context"
	"encoding/json"
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

// loadNotifyStore seeds a registry file + holder on the daemon.
func loadNotifyStore(t *testing.T, d *Daemon) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "notify-tokens.json")
	if err := d.LoadNotifyStore(path); err != nil {
		// First boot: the file may not exist yet — install an empty
		// registry by persisting the canonical empty form, then load.
		if err := persistNotifyStore(path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
			t.Fatalf("seed empty notify store: %v", err)
		}
		if err := d.LoadNotifyStore(path); err != nil {
			t.Fatalf("LoadNotifyStore: %v", err)
		}
	}
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
		LastUsedAt   *time.Time `json:"last_used_at"`
		LastError    string     `json:"last_error"`
		Scope        struct {
			Enabled    bool     `json:"enabled"`
			Conditions []string `json:"conditions"`
		} `json:"scope"`
	} `json:"tokens"`
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
	rec = doNotify(t, h, http.MethodDelete, "/vh/notify/tokens/0011223344556677", "", withCookie(session))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("DELETE without CSRF: want 403, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPatch, "/vh/notify/tokens/0011223344556677", `{}`, withCookie(session))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("PATCH without CSRF: want 403, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"token":"x"}`, withCookie(session))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("test POST without CSRF: want 403, got %d", rec.Code)
	}

	// 401: unauthenticated (API-class /vh/* — clean 401, not a redirect).
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/vh/notify/tokens", `{"token":"fcm-token-ladder-aaaaaa"}`},
		{http.MethodGet, "/vh/notify/tokens", ""},
		{http.MethodPost, "/vh/notify/test", `{"token":"fcm-token-ladder-aaaaaa"}`},
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
// the real chain: 201 create, idempotent 200 re-submit, masked list,
// strict PATCH, 404/204 delete — and the RAW TOKEN never appears in ANY
// response body along the way.
func TestNotifyHTTP_TokenLifecycle(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	raw := "fcm-lifecycle-token-0001"

	rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"`+raw+`","label":"Operator phone"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: want 201, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	var created notifyTokenWireView
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create body: %v", err)
	}
	if created.Token.ID == "" || !created.Created {
		t.Fatalf("create body = %+v", created)
	}
	if created.Token.Label != "Operator phone" {
		t.Errorf("create label = %q", created.Token.Label)
	}
	if !strings.Contains(rec.Body.String(), "token_preview") || strings.Contains(rec.Body.String(), raw) {
		t.Errorf("create response must carry a masked preview and NEVER the raw token: %s", rec.Body.String())
	}

	// Idempotent re-submit → 200, created=false, SAME id.
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"`+raw+`"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("re-submit: want 200, got %d", rec.Code)
	}
	var resub notifyTokenWireView
	_ = json.Unmarshal(rec.Body.Bytes(), &resub)
	if resub.Created || resub.Token.ID != created.Token.ID {
		t.Errorf("re-submit = created:%v id:%s (want created:false, same id)", resub.Created, resub.Token.ID)
	}

	// Masked list.
	rec = doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: want 200, got %d", rec.Code)
	}
	var list notifyListWireView
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Tokens) != 1 {
		t.Fatalf("list holds %d tokens, want 1 (body=%s)", len(list.Tokens), rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), raw) {
		t.Fatalf("MASKING LEAK: raw token appears in GET /vh/notify/tokens: %s", rec.Body.String())
	}
	if list.Tokens[0].TokenPreview == "" || list.Tokens[0].TokenPreview == raw {
		t.Errorf("token_preview = %q, want a masked preview", list.Tokens[0].TokenPreview)
	}
	if want := "fcm-li" + string('…') + "0001"; list.Tokens[0].TokenPreview != want {
		t.Errorf("token_preview = %q, want %q", list.Tokens[0].TokenPreview, want)
	}
	id := list.Tokens[0].ID

	// PATCH label + scope (wholesale).
	rec = doNotify(t, h, http.MethodPatch, "/vh/notify/tokens/"+id,
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
		rec := doNotify(t, h, http.MethodPatch, "/vh/notify/tokens/"+tc.id, tc.body, withCookie(session), withCSRF())
		if rec.Code != tc.code {
			t.Errorf("%s: want %d, got %d (body=%q)", tc.name, tc.code, rec.Code, rec.Body.String())
			continue
		}
		if !strings.Contains(rec.Body.String(), tc.marker) {
			t.Errorf("%s: body must contain %q, got %q", tc.name, tc.marker, rec.Body.String())
		}
	}

	// Create refusals: unknown field, bad token charset, too-short token,
	// oversize body, trailing document.
	for _, tc := range []struct {
		name, body, marker string
	}{
		{"unknown key", `{"token":"ok-token-aaaaaaaaaa","x":1}`, "unknown field"},
		{"token with space", `{"token":"abc defghijklmnop"}`, "printable ASCII"},
		{"token too short", `{"token":"short"}`, "outside the"},
		{"token missing", `{"label":"x"}`, "outside the"},
		{"label too long", `{"token":"ok-token-aaaaaaaaaa","label":"` + strings.Repeat("L", 65) + `"}`, "code points exceeds"},
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

	// DELETE: 204, then the entry is gone (list empty, id now 404).
	rec = doNotify(t, h, http.MethodDelete, "/vh/notify/tokens/"+id, "", withCookie(session), withCSRF())
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: want 204, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	rec = doNotify(t, h, http.MethodDelete, "/vh/notify/tokens/"+id, "", withCookie(session), withCSRF())
	if rec.Code != http.StatusNotFound {
		t.Fatalf("re-delete: want 404, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))
	var after notifyListWireView
	_ = json.Unmarshal(rec.Body.Bytes(), &after)
	if len(after.Tokens) != 0 {
		t.Errorf("registry must be empty after delete, has %d", len(after.Tokens))
	}

	// The persisted file never contained anything but the canonical form.
	// (Round-trip covered in notify_store_test.go.)
}

// TestNotifyHTTP_DisabledStorePosture pins the honest disabled posture:
// with no --notify-store path, EVERY family endpoint answers 409 naming
// the flag — including GET (an empty 200 list would read as "zero devices
// registered", which is a lie).
func TestNotifyHTTP_DisabledStorePosture(t *testing.T) {
	_, h, session := newNotifyAuthDaemon(t)
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/vh/notify/tokens", ""},
		{http.MethodPost, "/vh/notify/tokens", `{"token":"fcm-disabled-aaaaaaaaa"}`},
		{http.MethodDelete, "/vh/notify/tokens/0011223344556677", ""},
		{http.MethodPatch, "/vh/notify/tokens/0011223344556677", `{"label":"x"}`},
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
	if rec.Code != http.StatusCreated {
		t.Fatalf("enroll without transport: want 201 (registry is independent), got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"token":"fcm-credless-aaaaaaaa"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusConflict {
		t.Fatalf("test-send without transport: want 409, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "--notify-fcm-credentials") {
		t.Fatalf("409 body must name --notify-fcm-credentials: %q", rec.Body.String())
	}
	// Explicit null transport (the cmd/server.go unset-flag wiring) — same posture.
	d.SetNotifyTransport(NewNullNotifier())
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"token":"fcm-credless-aaaaaaaa"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "--notify-fcm-credentials") {
		t.Fatalf("explicit null transport: want 409 naming the flag, got %d %q", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// THE CRUX: test-send through the real chain → fake OAuth + fake FCM
// ---------------------------------------------------------------------------

// TestNotifyHTTP_TestSendThroughRealChain is the slice's behavioral
// crux: POST /vh/notify/test through the FULL handler chain (session
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
	rec := doNotify(t, h, http.MethodPost, "/vh/notify/test",
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

	// Register the token, then exercise the by-id path.
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"fcm-byid-00000000000001","label":"Phone"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusCreated {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
	var enrolled notifyTokenWireView
	_ = json.Unmarshal(rec.Body.Bytes(), &enrolled)
	id := enrolled.Token.ID

	advance(notifyTestSendInterval) // rate limit: the bare send just consumed the slot
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test",
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
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test",
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
		rec := doNotify(t, h, http.MethodPost, "/vh/notify/test", tc.body, withCookie(session), withCSRF())
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
// carve-out: a request on a per-worker SUBDOMAIN host must be served by
// the CONTROLLER (masked JSON), never proxied down to the worker (which
// has no /vh/notify/ route — its catch-all would serve the SPA shell).
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

	path := filepath.Join(t.TempDir(), "notify-tokens.json")
	if err := persistNotifyStore(path, &notifyStoreFile{Schema: 1, Tokens: []notifyStoreEntry{}}); err != nil {
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
	var list notifyListWireView
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || list.Schema != 1 {
		t.Fatalf("worker-subdomain response must be the controller's JSON: err=%v body=%s", err, rec.Body.String())
	}

	// The subpath shape ({id}) is covered by the PREFIX carve-out too.
	rec = doNotify(t, h, http.MethodDelete, "/vh/notify/tokens/0011223344556677", "", withHost("alpha.example.test"), withCookie(session), withCSRF())
	if rec.Code != http.StatusNotFound {
		t.Errorf("worker-subdomain DELETE unknown id: want controller 404, got %d", rec.Code)
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
	if rec.Code != http.StatusCreated {
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

	// Enroll one token so the by-id path is exercisable.
	rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"fcm-ratelimit-000001","label":"Phone"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusCreated {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
	var enrolled notifyTokenWireView
	_ = json.Unmarshal(rec.Body.Bytes(), &enrolled)
	id := enrolled.Token.ID

	// First send: allowed, reaches the stub transport.
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"token":"fcm-ratelimit-000001"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("first send: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if stub.sends != 1 {
		t.Fatalf("stub.sends = %d, want 1", stub.sends)
	}

	// Rapid second send (bare-token path): 429 + Retry-After naming the
	// full wait; the provider is untouched.
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"token":"fcm-ratelimit-000001"}`, withCookie(session), withCSRF())
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
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"token":"fcm-ratelimit-000002"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("different bare token inside the window: want 429, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"id":"`+id+`"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("by-id inside the window: want 429, got %d", rec.Code)
	}

	// Partial wait: 4s in, the remaining 6s is named; the 429s above did
	// NOT extend the window (they never record).
	advance(4 * time.Second)
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"token":"fcm-ratelimit-000001"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("4s into the window: want 429, got %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "6" {
		t.Errorf("Retry-After after 4s = %q, want 6", got)
	}

	// Validation refusals keep their precise codes WITHOUT consuming or
	// extending a slot (the gate sits after decode/resolve).
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty test body: want 400, got %d", rec.Code)
	}
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"id":"8899aabbccddeeff"}`, withCookie(session), withCSRF())
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
	rec = doNotify(t, h, http.MethodPost, "/vh/notify/test", `{"token":"fcm-ratelimit-000001"}`, withCookie(session), withCSRF())
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

// TestNotifyRead_TokensGetUnchanged pins the Slice-2 additivity fence:
// the shared read cursor lives in the HISTORY surface only — the tokens
// GET response carries no read_id/unread_count keys and its envelope
// shape is byte-stable across an ack.
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
	if _, ok := probe["schema"]; !ok {
		t.Errorf("tokens GET envelope lost its schema field: %s", after.Body.String())
	}
	if before.Body.String() != after.Body.String() {
		t.Errorf("tokens GET body changed across an ack:\nbefore: %s\nafter:  %s", before.Body.String(), after.Body.String())
	}
}
