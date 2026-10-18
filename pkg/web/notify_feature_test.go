package web

// notify_feature_test.go — lane-1 tests for the /vh/notify/* routes
// (pkg/web/notify_feature.go). The crux test drives notices through the REAL
// engine (alerts.Engine.EmitDaemonNotice with a suppressing profile) and reads
// them back over HTTP — no handler faking.

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// newNotifyTestServer boots the real worker stack (fake OpenCode stub →
// aggregator → pkg/web Server) with a REAL alerts engine wired exactly the way
// InitAlerts wires it: history ring attached, token registry under stateDir,
// notifyFeature registered. `authOn` installs passphrase auth (the security-
// chain tests); otherwise the server is open (ModeNone posture).
func newNotifyTestServer(t *testing.T, authOn bool) (*httptest.Server, *alerts.Engine) {
	t.Helper()
	stateDir := t.TempDir()
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatalf("alerts.NewStore: %v", err)
	}
	pres := alerts.NewPresence()
	engine := alerts.NewEngine(cfg, pres, alerts.NewDispatcher(cfg, pres))
	engine.SetHistory(alerts.NewHistory(stateDir))

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir)})
	if authOn {
		a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
		if err != nil {
			t.Fatalf("auth.New: %v", err)
		}
		srv.SetAuth(a)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	return web, engine
}

func notifyGet(t *testing.T, url string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func notifyPost(t *testing.T, url, body string, csrf bool) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if csrf {
		req.Header.Set("X-VH-CSRF", "1")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// TestNotifyRouteAuthChain pins the security posture: /vh/notify/* rides the
// shared /vh/* chain (auth → csrfGuard), so an unauthenticated request is
// 401-challenged, and an authenticated POST without X-VH-CSRF is 403.
func TestNotifyRouteAuthChain(t *testing.T) {
	web, _ := newNotifyTestServer(t, true)

	// Unauthenticated GETs → 401 (API-path challenge).
	for _, path := range []string{"/vh/notify/tokens", "/vh/notify/history"} {
		if code, _ := notifyGet(t, web.URL+path); code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated GET %s: want 401, got %d", path, code)
		}
	}

	// Login (passphrase form) to get a session cookie. The no-redirect client
	// preserves the 303 (DefaultClient would follow it to a 200 page).
	loginClient := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	loginResp, err := loginClient.PostForm(web.URL+"/auth/login", map[string][]string{"passphrase": {"secret"}})
	if err != nil {
		t.Fatal(err)
	}
	loginResp.Body.Close()
	if loginResp.StatusCode != http.StatusSeeOther {
		t.Fatalf("login: want 303, got %d", loginResp.StatusCode)
	}
	var session *http.Cookie
	for _, c := range loginResp.Cookies() {
		if c.Name == "vh_session" {
			session = c
		}
	}
	if session == nil {
		t.Fatal("login: no vh_session cookie")
	}

	// Authenticated POST WITHOUT X-VH-CSRF → 403 (csrfGuard).
	req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/notify/tokens", strings.NewReader(`{"token":"t"}`))
	req.AddCookie(session)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("authenticated POST without CSRF: want 403, got %d", resp.StatusCode)
	}
}

// TestNotifyTokensProbeUnconfigured pins the probe contract for an
// unconfigured channel: 200 (never an error) with {"enabled":false,"count":0}
// — and never any token material.
func TestNotifyTokensProbeUnconfigured(t *testing.T) {
	web, _ := newNotifyTestServer(t, false)
	code, body := notifyGet(t, web.URL+"/vh/notify/tokens")
	if code != http.StatusOK {
		t.Fatalf("GET /vh/notify/tokens: want 200, got %d (body=%s)", code, body)
	}
	var probe struct {
		Enabled     bool           `json:"enabled"`
		Count       int            `json:"count"`
		Policies    map[string]int `json:"policies"`
		LastAttempt string         `json:"last_attempt"`
		LastError   string         `json:"last_error"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		t.Fatalf("probe body: %v (%s)", err, body)
	}
	if probe.Enabled || probe.Count != 0 {
		t.Fatalf("unconfigured probe = %+v, want enabled:false count:0", probe)
	}
	// v3: the shape is stable in the unconfigured state — both policy keys
	// present (zeroed) and empty observability fields.
	if probe.Policies == nil || probe.Policies["when_unattended"] != 0 || probe.Policies["always"] != 0 {
		t.Fatalf("unconfigured policies = %+v, want {when_unattended:0, always:0}", probe.Policies)
	}
	if probe.LastAttempt != "" || probe.LastError != "" {
		t.Fatalf("unconfigured observability = (%q, %q), want empty/empty", probe.LastAttempt, probe.LastError)
	}
}

// TestNotifyTokensPost503WhenUnconfigured pins the upsert contract while the
// channel has no sender (Slice 1): POST answers 503 {"ok":false,"error":...}
// regardless of the body — the channel check precedes validation (the
// /vh/alerts/push/subscribe pattern).
func TestNotifyTokensPost503WhenUnconfigured(t *testing.T) {
	web, _ := newNotifyTestServer(t, false)
	code, body := notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"a-valid-token","label":"phone"}`, true)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("POST /vh/notify/tokens: want 503, got %d (body=%s)", code, body)
	}
	var e struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &e); err != nil || e.OK || e.Error != "notify unavailable" {
		t.Fatalf("503 body = %s, want {\"ok\":false,\"error\":\"notify unavailable\"}", body)
	}
	// Even an empty token answers 503 here (channel check first).
	if code, _ := notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":""}`, true); code != http.StatusServiceUnavailable {
		t.Fatalf("POST with empty token while unconfigured: want 503, got %d", code)
	}
	// Non-POST/GET methods: 405 from the handler's method guard (DELETE needs
	// the CSRF header to get past csrfGuard, which lists it unsafe).
	req, _ := http.NewRequest(http.MethodDelete, web.URL+"/vh/notify/tokens", nil)
	req.Header.Set("X-VH-CSRF", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE /vh/notify/tokens: want 405, got %d", resp.StatusCode)
	}
}

// TestMergeConfigPreservesNotifySection pins the Slice-1 trap: mergeConfig
// folds a settings-UI save (wireConfig carries only channels/profiles/active/
// detect) onto the stored config WITHOUT stripping the notify section — a UI
// save must never silence a configured notify channel.
func TestMergeConfigPreservesNotifySection(t *testing.T) {
	prev := alerts.Config{
		Active: "At desk",
		Notify: &alerts.NotifyConfig{CredentialsFile: "/secrets/fcm.json", ProjectID: "proj-1", TtlSec: 3600},
	}
	in := wireConfig{Active: "Away"}
	merged := mergeConfig(prev, in)
	if merged.Notify == nil {
		t.Fatal("mergeConfig stripped the notify section on a UI save")
	}
	if merged.Notify.CredentialsFile != "/secrets/fcm.json" || merged.Notify.ProjectID != "proj-1" || merged.Notify.TtlSec != 3600 {
		t.Fatalf("notify section drift: %+v", merged.Notify)
	}
	// And a config without notify stays without (nil, not a zero struct).
	if got := mergeConfig(alerts.Config{}, wireConfig{}).Notify; got != nil {
		t.Fatalf("absent notify section must stay nil, got %+v", got)
	}
}

// TestNotifyHistoryRouteEndToEnd is the LOAD-BEARING crux for Slice 1:
// notices emitted by the real engine are recorded in history and returned by
// GET /vh/notify/history with correct since/limit semantics — including
// notices the routing would suppress. The active profile here is "Silent"
// (PolicyNever), so dispatcher.Dispatch drops every outbound delivery for
// these notices, yet all three daemon notices are retained, ascending, with
// the daemon shape the contract fixes (type "stalled", title "OpenCode",
// empty sessionID/root).
func TestNotifyHistoryRouteEndToEnd(t *testing.T) {
	web, engine := newNotifyTestServer(t, false)

	// Suppress all outbound delivery, then emit three notices through the
	// REAL engine path (EmitDaemonNotice — the same method the oc death
	// watcher uses in production).
	cfg := engine.Config()
	if err := cfg.SetActive("Silent"); err != nil {
		t.Fatal(err)
	}
	engine.EmitDaemonNotice("serve died #1")
	engine.EmitDaemonNotice("serve died #2")
	engine.EmitDaemonNotice("serve died #3")

	// Full window: ascending ids 1..3, lastId 3.
	code, body := notifyGet(t, web.URL+"/vh/notify/history")
	if code != http.StatusOK {
		t.Fatalf("GET /vh/notify/history: want 200, got %d (body=%s)", code, body)
	}
	var resp struct {
		Events []struct {
			ID        int64  `json:"id"`
			Type      string `json:"type"`
			SessionID string `json:"sessionID"`
			Root      string `json:"root"`
			Project   string `json:"project"`
			Title     string `json:"title"`
			Detail    string `json:"detail"`
			Ts        int64  `json:"ts"`
		} `json:"events"`
		LastID int64 `json:"lastId"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("history body: %v (%s)", err, body)
	}
	if len(resp.Events) != 3 || resp.LastID != 3 {
		t.Fatalf("want 3 events lastId 3, got %d events lastId %d (%s)", len(resp.Events), resp.LastID, body)
	}
	for i, ev := range resp.Events {
		if ev.ID != int64(i+1) {
			t.Fatalf("events not ascending: got ids in order %v", resp.Events)
		}
		if ev.Type != "stalled" || ev.Title != "OpenCode" || ev.SessionID != "" || ev.Root != "" {
			t.Fatalf("daemon event %d shape drift: %+v", i, ev)
		}
		if ev.Detail != "serve died #1" && ev.Detail != "serve died #2" && ev.Detail != "serve died #3" {
			t.Fatalf("daemon event %d detail drift: %+v", i, ev)
		}
		if ev.Ts == 0 {
			t.Fatalf("daemon event %d missing ts: %+v", i, ev)
		}
	}

	// since=1 → only ids 2,3, ascending.
	_, body = notifyGet(t, web.URL+"/vh/notify/history?since=1")
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Events) != 2 || resp.Events[0].ID != 2 || resp.Events[1].ID != 3 || resp.LastID != 3 {
		t.Fatalf("since=1: want ids [2 3] lastId 3, got %+v", resp.Events)
	}

	// since=1&limit=1 → oldest match first (id 2) — the paging contract.
	_, body = notifyGet(t, web.URL+"/vh/notify/history?since=1&limit=1")
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Events) != 1 || resp.Events[0].ID != 2 {
		t.Fatalf("since=1&limit=1: want [2], got %+v", resp.Events)
	}

	// limit only → newest window, ascending.
	_, body = notifyGet(t, web.URL+"/vh/notify/history?limit=2")
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Events) != 2 || resp.Events[0].ID != 2 || resp.Events[1].ID != 3 {
		t.Fatalf("limit=2: want ids [2 3], got %+v", resp.Events)
	}

	// since at the head → empty events, lastId honest.
	_, body = notifyGet(t, web.URL+"/vh/notify/history?since=3")
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Events) != 0 || resp.LastID != 3 {
		t.Fatalf("since=3: want empty + lastId 3, got %d events lastId %d", len(resp.Events), resp.LastID)
	}
	if !strings.Contains(string(body), `"events":[]`) {
		t.Fatalf("empty history must serialize events as [], got %s", body)
	}

	// Bad params → 400.
	if code, _ := notifyGet(t, web.URL+"/vh/notify/history?since=abc"); code != http.StatusBadRequest {
		t.Fatalf("since=abc: want 400, got %d", code)
	}
	if code, _ := notifyGet(t, web.URL+"/vh/notify/history?limit=-2"); code != http.StatusBadRequest {
		t.Fatalf("limit=-2: want 400, got %d", code)
	}
	if code, _ := notifyGet(t, web.URL+"/vh/notify/history?limit=0"); code != http.StatusOK {
		t.Fatalf("limit=0 (default): want 200, got %d", code)
	}
}

// newConfiguredNotifyTestServer boots the same stack as
// newNotifyTestServer but with the FCM notify channel CONFIGURED and its
// sender attached: a mock OAuth2 token endpoint (via the credentials file's
// token_uri), a real service-account credentials file, the notify config
// section, and engine.SetNotifier — the InitAlerts wiring. Returns the
// server, the engine, and the shared token registry (for pre-filling).
func newConfiguredNotifyTestServer(t *testing.T) (*httptest.Server, *alerts.Engine, *alerts.TokenRegistry) {
	t.Helper()
	stateDir := t.TempDir()

	// Mock OAuth2 token endpoint; no FCM send happens in these route tests,
	// so the default FCM base is never hit.
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"test-token","expires_in":3600,"token_type":"Bearer"}`))
	}))
	t.Cleanup(tokenSrv.Close)

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa keygen: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal pkcs8: %v", err)
	}
	creds := map[string]string{
		"type":         "service_account",
		"project_id":   "proj-web",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "bot@proj-web.iam.gserviceaccount.com",
		"token_uri":    tokenSrv.URL,
	}
	cj, _ := json.Marshal(creds)
	credsPath := filepath.Join(stateDir, "fcm-creds.json")
	if err := os.WriteFile(credsPath, cj, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatalf("alerts.NewStore: %v", err)
	}
	c := cfg.Get()
	c.Notify = &alerts.NotifyConfig{CredentialsFile: credsPath, ProjectID: "proj-web"}
	if err := cfg.Replace(c); err != nil {
		t.Fatalf("cfg.Replace: %v", err)
	}

	pres := alerts.NewPresence()
	engine := alerts.NewEngine(cfg, pres, alerts.NewDispatcher(cfg, pres))
	engine.SetHistory(alerts.NewHistory(stateDir))
	tokens := alerts.NewTokenRegistry(stateDir)
	// Premise: the CONFIG half is ready (sender attaches next; NotifyReady
	// needs both halves).
	if !cfg.Get().NotifyConfigured() {
		t.Fatal("test premise: notify config section must be present")
	}
	notifier, err := alerts.NewNotifier(cfg, pres, tokens)
	if err != nil {
		t.Fatalf("alerts.NewNotifier: %v", err)
	}
	engine.SetNotifier(notifier)
	if !engine.NotifyReady() {
		t.Fatal("test premise: NotifyReady must be true with sender attached")
	}

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: tokens})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	return web, engine, tokens
}

// TestNotifyTokensConfiguredChannel pins the CONFIGURED-channel contract
// (Slice 2): the probe answers enabled:true, a token POST round-trips 200,
// and the probe reflects the new count — and an empty token is a 400 (the
// sentinel mapping), not a 503.
func TestNotifyTokensConfiguredChannel(t *testing.T) {
	web, _, _ := newConfiguredNotifyTestServer(t)

	code, body := notifyGet(t, web.URL+"/vh/notify/tokens")
	if code != http.StatusOK {
		t.Fatalf("probe: want 200, got %d (body=%s)", code, body)
	}
	var probe notifyProbe
	if err := json.Unmarshal(body, &probe); err != nil {
		t.Fatalf("probe body: %v (%s)", err, body)
	}
	if !probe.Enabled || probe.Count != 0 {
		t.Fatalf("configured probe = %+v, want enabled:true count:0", probe)
	}

	code, body = notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"a-valid-fcm-token","label":"phone"}`, true)
	if code != http.StatusOK {
		t.Fatalf("token POST: want 200, got %d (body=%s)", code, body)
	}
	if !strings.Contains(string(body), `"ok":true`) {
		t.Fatalf("token POST body = %s, want ok:true", body)
	}

	code, body = notifyGet(t, web.URL+"/vh/notify/tokens")
	if err := json.Unmarshal(body, &probe); err != nil {
		t.Fatalf("probe body: %v (%s)", err, body)
	}
	if !probe.Enabled || probe.Count != 1 {
		t.Fatalf("post-upsert probe = %+v, want enabled:true count:1", probe)
	}

	// Empty token now maps to 400 (the channel is live, so validation runs).
	if code, body = notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":""}`, true); code != http.StatusBadRequest {
		t.Fatalf("empty token: want 400, got %d (body=%s)", code, body)
	}
}

// TestNotifyTokensUpsertErrorMapping pins the 400-vs-500 mapping (review
// DEFERs C-F1/A-F1): sentinel registry errors (missing token, cap) answer
// 400; an unexpected persistence failure answers 500.
func TestNotifyTokensUpsertErrorMapping(t *testing.T) {
	web, _, tokens := newConfiguredNotifyTestServer(t)

	// Sentinel: missing token → 400 with the sentinel message.
	code, body := notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":""}`, true)
	if code != http.StatusBadRequest || !strings.Contains(string(body), "token required") {
		t.Fatalf("empty token: want 400 \"token required\", got %d %s", code, body)
	}

	// Sentinel: cap reached → 400. Pre-fill the registry (shared instance) to
	// the cap of 32 through the direct API.
	for i := 0; i < alerts.NotifyTokenCap; i++ {
		if err := tokens.Upsert("cap-token-"+strings.Repeat("x", i+1), "", ""); err != nil {
			t.Fatalf("prefill %d: %v", i, err)
		}
	}
	code, body = notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"token-over-cap"}`, true)
	if code != http.StatusBadRequest || !strings.Contains(string(body), "token limit reached") {
		t.Fatalf("cap token: want 400 \"token limit reached\", got %d %s", code, body)
	}
}

// TestNotifyTokensUpsertPersistence500 isolates the 500 path on its own
// server: the registry's target path is occupied by a directory, so the
// atomic persist fails and the route answers 500 (not 400).
func TestNotifyTokensUpsertPersistence500(t *testing.T) {
	// Build the fixture manually (the registry path must be sabotaged BEFORE
	// NewTokenRegistry loads) — same wiring as newConfiguredNotifyTestServer.
	stateDir := t.TempDir()
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"t","expires_in":3600}`))
	}))
	defer tokenSrv.Close()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	cj, _ := json.Marshal(map[string]string{
		"project_id":   "p",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "bot@p.iam.gserviceaccount.com",
		"token_uri":    tokenSrv.URL,
	})
	credsPath := filepath.Join(stateDir, "creds.json")
	if err := os.WriteFile(credsPath, cj, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	c := cfg.Get()
	c.Notify = &alerts.NotifyConfig{CredentialsFile: credsPath, ProjectID: "p"}
	if err := cfg.Replace(c); err != nil {
		t.Fatal(err)
	}
	// Sabotage: the registry's persistence target is a directory → rename
	// fails → Upsert returns a non-sentinel error.
	if err := os.Mkdir(filepath.Join(stateDir, "notify-tokens.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	pres := alerts.NewPresence()
	engine := alerts.NewEngine(cfg, pres, alerts.NewDispatcher(cfg, pres))
	tokens := alerts.NewTokenRegistry(stateDir)
	notifier, err := alerts.NewNotifier(cfg, pres, tokens)
	if err != nil {
		t.Fatalf("NewNotifier: %v", err)
	}
	engine.SetNotifier(notifier)

	oc := httptest.NewServer(http.NotFoundHandler())
	defer oc.Close()
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: tokens})
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	code, body := notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"persist-will-fail"}`, true)
	if code != http.StatusInternalServerError {
		t.Fatalf("persistence failure: want 500, got %d (body=%s)", code, body)
	}
	if strings.Contains(string(body), "token required") || strings.Contains(string(body), "token limit") {
		t.Fatalf("500 body must not carry a sentinel message: %s", body)
	}
}

// --- v3: push_policy + probe observability surface ---

// TestNotifyTokensPushPolicy pins the route contract for per-token push
// policy: a legacy POST without push_policy registers when_unattended
// (backward compatible), push_policy=always counts under "always", a re-POST
// without the field resets the policy (upsert = full desired state), and an
// invalid policy answers 400 with the contract body.
func TestNotifyTokensPushPolicy(t *testing.T) {
	web, _, _ := newConfiguredNotifyTestServer(t)

	getPolicies := func() (int, map[string]int, string, string) {
		t.Helper()
		code, body := notifyGet(t, web.URL+"/vh/notify/tokens")
		if code != http.StatusOK {
			t.Fatalf("probe: want 200, got %d (body=%s)", code, body)
		}
		var probe struct {
			Count       int            `json:"count"`
			Policies    map[string]int `json:"policies"`
			LastAttempt string         `json:"last_attempt"`
			LastError   string         `json:"last_error"`
		}
		if err := json.Unmarshal(body, &probe); err != nil {
			t.Fatalf("probe body: %v (%s)", err, body)
		}
		return probe.Count, probe.Policies, probe.LastAttempt, probe.LastError
	}

	// Legacy POST (no push_policy) → when_unattended, 200.
	code, body := notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"tok-wu","label":"pixel"}`, true)
	if code != http.StatusOK || !strings.Contains(string(body), `"ok":true`) {
		t.Fatalf("legacy POST: want 200 ok:true, got %d %s", code, body)
	}
	// always POST → 200 and both buckets counted.
	if code, _ := notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"tok-always","label":"tab","push_policy":"always"}`, true); code != http.StatusOK {
		t.Fatalf("always POST: want 200, got %d", code)
	}
	count, policies, lastAttempt, lastErr := getPolicies()
	if count != 2 || policies["when_unattended"] != 1 || policies["always"] != 1 {
		t.Fatalf("probe = count %d policies %v, want 2 {wu:1 always:1}", count, policies)
	}
	if lastAttempt != "" || lastErr != "" {
		t.Fatalf("before any send attempt: last_attempt/last_error = (%q, %q), want empty", lastAttempt, lastErr)
	}

	// Re-POST the always token WITHOUT push_policy → policy resets to the
	// default (the POST body is the full desired state).
	if code, _ := notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"tok-always","label":"tab"}`, true); code != http.StatusOK {
		t.Fatalf("policy-reset POST: want 200, got %d", code)
	}
	_, policies, _, _ = getPolicies()
	if policies["when_unattended"] != 2 || policies["always"] != 0 {
		t.Fatalf("post-reset policies = %v, want {wu:2 always:0}", policies)
	}

	// Invalid policies answer 400 with the contract body.
	code, body = notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"tok-x","push_policy":"never"}`, true)
	if code != http.StatusBadRequest {
		t.Fatalf("push_policy=never: want 400, got %d (body=%s)", code, body)
	}
	var e struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &e); err != nil || e.OK || e.Error != "invalid push_policy" {
		t.Fatalf("invalid-policy body = %s, want {\"ok\":false,\"error\":\"invalid push_policy\"}", body)
	}
	if code, _ := notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"tok-x","push_policy":"Sometimes"}`, true); code != http.StatusBadRequest {
		t.Fatalf("mixed-case invalid policy: want 400, got %d", code)
	}
}

// TestNotifyTokensProbeHealthSurface pins the operator-checkable channel
// surface over HTTP: last_attempt/last_error are empty before any attempt,
// then a failed send (OAuth exchange failure — the mock token endpoint
// answers 500) surfaces a RFC3339 last_attempt and the sanitized
// last_error, with NO token material anywhere in the probe body.
func TestNotifyTokensProbeHealthSurface(t *testing.T) {
	stateDir := t.TempDir()

	var oauthFail atomic.Bool
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if oauthFail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"internal"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"t","expires_in":3600}`))
	}))
	t.Cleanup(tokenSrv.Close)

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa keygen: %v", err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	cj, _ := json.Marshal(map[string]string{
		"project_id":   "p",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "bot@p.iam.gserviceaccount.com",
		"token_uri":    tokenSrv.URL,
	})
	credsPath := filepath.Join(stateDir, "creds.json")
	if err := os.WriteFile(credsPath, cj, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatalf("alerts.NewStore: %v", err)
	}
	c := cfg.Get()
	c.Notify = &alerts.NotifyConfig{CredentialsFile: credsPath, ProjectID: "p"}
	if err := cfg.Replace(c); err != nil {
		t.Fatal(err)
	}
	pres := alerts.NewPresence()
	engine := alerts.NewEngine(cfg, pres, alerts.NewDispatcher(cfg, pres))
	tokens := alerts.NewTokenRegistry(stateDir)
	notifier, err := alerts.NewNotifier(cfg, pres, tokens)
	if err != nil {
		t.Fatalf("alerts.NewNotifier: %v", err)
	}
	// d-F4: no production stderr — the notifier's default logger is the
	// daemon's shared vhlog logger, and this test deliberately drives a
	// FAILED send (oauthFail below), which would emit a real Warn line per
	// attempt into the test run's output. Swap to a discard handler; the
	// assertions read the sanitized probe surface, not the log stream.
	notifier.SetLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	engine.SetNotifier(notifier)
	if !engine.NotifyReady() {
		t.Fatal("test premise: NotifyReady must be true")
	}

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: tokens})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	probeState := func() (string, string, []byte) {
		t.Helper()
		code, body := notifyGet(t, web.URL+"/vh/notify/tokens")
		if code != http.StatusOK {
			t.Fatalf("probe: want 200, got %d (body=%s)", code, body)
		}
		var probe struct {
			LastAttempt string `json:"last_attempt"`
			LastError   string `json:"last_error"`
		}
		if err := json.Unmarshal(body, &probe); err != nil {
			t.Fatalf("probe body: %v (%s)", err, body)
		}
		return probe.LastAttempt, probe.LastError, body
	}

	// Before any attempt: empty/empty.
	if at, le, _ := probeState(); at != "" || le != "" {
		t.Fatalf("before any attempt: (%q, %q), want empty/empty", at, le)
	}

	// Register a distinctive token through the ROUTE (with a label), flip
	// the OAuth endpoint to failing, and drive one send through the real
	// notifier.
	const secret = "SECRET-PROBE-TOKEN-never-in-body"
	if code, body := notifyPost(t, web.URL+"/vh/notify/tokens", `{"token":"`+secret+`","label":"pixel","push_policy":"always"}`, true); code != http.StatusOK {
		t.Fatalf("token POST: want 200, got %d (body=%s)", code, body)
	}
	oauthFail.Store(true)
	engine.Notifier().Send(alerts.Notice{Type: alerts.TypeFinished, SessionID: "s1", Root: "s1", Project: "p", Ts: 1})

	// The failed attempt must surface: RFC3339 last_attempt + sanitized
	// last_error ("oauth exchange failed").
	deadline := time.Now().Add(2 * time.Second)
	var lastAttempt, lastErr string
	var raw []byte
	for time.Now().Before(deadline) {
		lastAttempt, lastErr, raw = probeState()
		if lastErr == "oauth exchange failed" && lastAttempt != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if lastErr != "oauth exchange failed" || lastAttempt == "" {
		t.Fatalf("probe after failed send: last_attempt=%q last_error=%q", lastAttempt, lastErr)
	}
	if _, err := time.Parse(time.RFC3339, lastAttempt); err != nil {
		t.Fatalf("last_attempt %q is not RFC3339: %v", lastAttempt, err)
	}
	// Secrets discipline: neither the token VALUE nor its label appears in
	// the probe body.
	if strings.Contains(string(raw), secret) || strings.Contains(string(raw), `"pixel"`) {
		t.Fatalf("probe body carries token material: %s", raw)
	}
}
