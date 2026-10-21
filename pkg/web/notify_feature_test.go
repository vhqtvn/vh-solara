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
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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
// InitAlerts wires it: history ring + durable source spool attached, token
// registry under stateDir, notifyFeature registered with the worker identity.
// `authOn` installs passphrase auth (the security-chain tests); otherwise the
// server is open (ModeNone posture).
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
	engine.SetSource(alerts.NewSourceSpool(stateDir, "w-test", alerts.SourceSpoolCap))

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-test", workerName: "Test Worker"})
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
			Ts        string `json:"ts"` // v4 Position C: decimal string
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
		if ts, err := strconv.ParseInt(ev.Ts, 10, 64); err != nil || ts <= 0 {
			t.Fatalf("daemon event %d ts must be a decimal-string epoch: %q (%v)", i, ev.Ts, err)
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

// --- v4 (notify controller-hub S1): public history DTO + fence ---

// TestNotifyHistoryV4DTOServed pins the served v4 event DTO end to end: the
// daemon notice rides the REAL engine tap (ring + spool correlate), the
// other notice types ride the same public surfaces the tap uses
// (History().Record + Source().Append — the tap itself is pinned in
// pkg/alerts). ts is a DECIMAL STRING (Position C), kind/count/label/worker/
// source are the additive v4 fields, ui_url is absent (standalone omit rule),
// and coverage reports complete.
func TestNotifyHistoryV4DTOServed(t *testing.T) {
	web, engine := newNotifyTestServer(t, false)

	// Session notices through the public ring+spool surfaces (the t1b-F1
	// tap order: spool FIRST — its durable seq is the correlation key —
	// then the ring event CARRYING (seq, epoch)), then the daemon-level
	// notice through the REAL emission path (so it lands LAST, matching
	// the assertion order below).
	tap := func(n alerts.Notice) alerts.HistoryEvent {
		rec, err := engine.Source().Append(n, alerts.DetectionContext{IdleSec: 120, ProfileEligible: true})
		if err != nil {
			t.Fatalf("spool append: %v", err)
		}
		ev, err := engine.History().Record(n, rec.Seq, engine.Source().Epoch())
		if err != nil {
			t.Fatalf("ring record: %v", err)
		}
		return ev
	}
	tap(alerts.Notice{Type: alerts.TypeWaiting, Kind: alerts.KindQuestion, SessionID: "s1", Root: "s1",
		Project: "/w", Title: "Review requested", Detail: "Question pending", Ts: 1792454330000})
	tap(alerts.Notice{Type: alerts.TypeSessionStarted, SessionID: "s2", Root: "s2",
		Project: "/w", Title: "Fix login", Detail: "Root session started running", Ts: 1792454355000})
	engine.EmitDaemonNotice("serve died")

	code, body := notifyGet(t, web.URL+"/vh/notify/history")
	if code != http.StatusOK {
		t.Fatalf("GET /vh/notify/history: want 200, got %d (body=%s)", code, body)
	}
	var resp struct {
		Events []struct {
			ID     int64  `json:"id"`
			Type   string `json:"type"`
			Ts     string `json:"ts"`
			Kind   string `json:"kind"`
			Count  int    `json:"count"`
			Label  string `json:"label"`
			Worker struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"worker"`
			Source *struct {
				Epoch string `json:"epoch"`
				Seq   int64  `json:"seq"`
			} `json:"source"`
		} `json:"events"`
		LastID   int64 `json:"lastId"`
		Coverage struct {
			Complete bool `json:"complete"`
			Gaps     []struct {
				SourceID string `json:"source_id"`
			} `json:"gaps"`
		} `json:"coverage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("history body: %v (%s)", err, body)
	}
	if len(resp.Events) != 3 {
		t.Fatalf("want 3 events, got %d (%s)", len(resp.Events), body)
	}

	// waiting + kind=question ⇒ question_pending (the subtype is retained
	// in BOTH stores; here the joined spool record is the authority).
	waiting := resp.Events[0]
	if waiting.Type != "waiting" || waiting.Kind != "question_pending" {
		t.Fatalf("waiting event: %+v", waiting)
	}
	if waiting.Ts != "1792454330000" {
		t.Fatalf("ts must be the decimal string of the internal millis: %q", waiting.Ts)
	}
	if waiting.Count != 1 {
		t.Fatalf("count = %d, want 1", waiting.Count)
	}
	if waiting.Label != "Test Worker — Review requested" {
		t.Fatalf("label = %q, want %q", waiting.Label, "Test Worker — Review requested")
	}
	if waiting.Worker.ID != "w-test" || waiting.Worker.Name != "Test Worker" {
		t.Fatalf("worker ref = %+v", waiting.Worker)
	}
	if waiting.Source == nil || waiting.Source.Epoch != engine.Source().Epoch() || waiting.Source.Seq != 1 {
		t.Fatalf("source ref = %+v, want epoch %q seq 1", waiting.Source, engine.Source().Epoch())
	}

	// session_started ⇒ identity condition mapping.
	started := resp.Events[1]
	if started.Kind != "session_started" {
		t.Fatalf("session_started kind = %q", started.Kind)
	}
	// Daemon-level stalled ⇒ worker_down (empty sessionID/root, title
	// "OpenCode"), source correlates to the spool record.
	daemon := resp.Events[2]
	if daemon.Kind != "worker_down" {
		t.Fatalf("daemon stalled kind = %q, want worker_down", daemon.Kind)
	}
	if daemon.Source == nil || daemon.Source.Seq != 3 {
		t.Fatalf("daemon source = %+v, want seq 3", daemon.Source)
	}
	if daemon.Label != "Test Worker — OpenCode" {
		t.Fatalf("daemon label = %q", daemon.Label)
	}

	// Coverage: single worker, nothing evicted ⇒ complete, empty gaps.
	if !resp.Coverage.Complete || len(resp.Coverage.Gaps) != 0 {
		t.Fatalf("coverage = %+v, want complete with no gaps", resp.Coverage)
	}

	// ts must be a JSON string in the RAW body (Position C: a JSON number
	// on a public history surface is a contract violation).
	var rawEvents []map[string]any
	var rawDoc map[string]json.RawMessage
	if err := json.Unmarshal(body, &rawDoc); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(rawDoc["events"], &rawEvents); err != nil {
		t.Fatal(err)
	}
	for i, ev := range rawEvents {
		if _, ok := ev["ts"].(string); !ok {
			t.Fatalf("event %d: ts is not a JSON string: %v", i, ev["ts"])
		}
		// ui_url omitted on the standalone surface (documented).
		if _, has := ev["ui_url"]; has {
			t.Fatalf("event %d: ui_url must be omitted on the standalone surface", i)
		}
	}
}

// v4CheckEvent validates one decoded history event against the golden v4
// shape (field names + JSON types). ui_url may be present (string) or absent
// (the standalone omission); source may be absent (ring-only legacy events).
func v4CheckEvent(t *testing.T, ev map[string]any, where string) {
	t.Helper()
	strFields := []string{"type", "sessionID", "root", "project", "title", "detail", "ts", "kind", "label"}
	for _, k := range strFields {
		v, ok := ev[k].(string)
		if !ok {
			t.Fatalf("%s: field %q missing or not a string: %v", where, k, ev[k])
		}
		if k == "ts" {
			if _, err := strconv.ParseInt(v, 10, 64); err != nil {
				t.Fatalf("%s: ts %q is not a decimal epoch string: %v", where, v, err)
			}
		}
	}
	for _, k := range []string{"id", "count"} {
		if _, ok := ev[k].(float64); !ok {
			t.Fatalf("%s: field %q missing or not a number: %v", where, k, ev[k])
		}
	}
	w, ok := ev["worker"].(map[string]any)
	if !ok {
		t.Fatalf("%s: worker missing or not an object: %v", where, ev["worker"])
	}
	if _, ok := w["id"].(string); !ok {
		t.Fatalf("%s: worker.id not a string: %v", where, w["id"])
	}
	if _, ok := w["name"].(string); !ok {
		t.Fatalf("%s: worker.name not a string: %v", where, w["name"])
	}
	if src, has := ev["source"]; has {
		s, ok := src.(map[string]any)
		if !ok {
			t.Fatalf("%s: source not an object: %v", where, src)
		}
		if _, ok := s["epoch"].(string); !ok {
			t.Fatalf("%s: source.epoch not a string: %v", where, s["epoch"])
		}
		if _, ok := s["seq"].(float64); !ok {
			t.Fatalf("%s: source.seq not a number: %v", where, s["seq"])
		}
	}
	if u, has := ev["ui_url"]; has {
		if _, ok := u.(string); !ok {
			t.Fatalf("%s: ui_url not a string: %v", where, u)
		}
	}
}

// v4CheckCoverage validates the coverage object (complete flag + gap entry
// field names/types per the golden fixtures).
func v4CheckCoverage(t *testing.T, cov map[string]any, where string) {
	t.Helper()
	if _, ok := cov["complete"].(bool); !ok {
		t.Fatalf("%s: coverage.complete missing or not a bool: %v", where, cov["complete"])
	}
	gaps, ok := cov["gaps"].([]any)
	if !ok {
		t.Fatalf("%s: coverage.gaps missing or not an array: %v", where, cov["gaps"])
	}
	for i, g := range gaps {
		gap, ok := g.(map[string]any)
		if !ok {
			t.Fatalf("%s: gap %d not an object: %v", where, i, g)
		}
		for _, k := range []string{"source_id", "epoch"} {
			if _, ok := gap[k].(string); !ok {
				t.Fatalf("%s: gap %d field %q not a string: %v", where, i, k, gap[k])
			}
		}
		for _, k := range []string{"from_seq", "to_seq"} {
			if _, ok := gap[k].(float64); !ok {
				t.Fatalf("%s: gap %d field %q not a number: %v", where, i, k, gap[k])
			}
		}
	}
}

// TestNotifyHistoryV4GoldenConformance pins the served shape against the
// frozen golden fixtures (pkg/server/testdata/notify_v4): the golden events
// themselves conform (fixture self-check from this lane's perspective), and
// the served response conforms to the SAME validator — modulo the documented
// standalone omissions (ui_url absent; source may be absent).
func TestNotifyHistoryV4GoldenConformance(t *testing.T) {
	// Validate the golden fixtures' event + coverage shapes.
	goldens := []string{
		"../server/testdata/notify_v4/history_response_v4.json",
		"../server/testdata/notify_v4/history_response_gaps.json",
	}
	for _, path := range goldens {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("golden fixture %s: %v", path, err)
		}
		var doc map[string]json.RawMessage
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		var events []map[string]any
		if err := json.Unmarshal(doc["events"], &events); err != nil {
			t.Fatalf("%s events: %v", path, err)
		}
		for i, ev := range events {
			v4CheckEvent(t, ev, filepath.Base(path)+fmt.Sprintf(" event %d", i))
		}
		var cov map[string]any
		if err := json.Unmarshal(doc["coverage"], &cov); err != nil {
			t.Fatalf("%s coverage: %v", path, err)
		}
		v4CheckCoverage(t, cov, filepath.Base(path))
	}

	// Serve a mixed page and validate it with the same validator.
	web, engine := newNotifyTestServer(t, false)
	engine.EmitDaemonNotice("serve died")
	perm := alerts.Notice{Type: alerts.TypeWaiting, Kind: alerts.KindPermission,
		SessionID: "s1", Root: "s1", Project: "/w", Title: "Deploy blocked", Detail: "Permission pending", Ts: 42}
	rec, err := engine.Source().Append(perm, alerts.DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.History().Record(perm, rec.Seq, engine.Source().Epoch()); err != nil {
		t.Fatal(err)
	}

	_, body := notifyGet(t, web.URL+"/vh/notify/history")
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("served body: %v (%s)", err, body)
	}
	if _, ok := doc["lastId"]; !ok {
		t.Fatalf("served body missing lastId: %s", body)
	}
	var lastID float64
	if err := json.Unmarshal(doc["lastId"], &lastID); err != nil {
		t.Fatalf("lastId not a number: %v", err)
	}
	var events []map[string]any
	if err := json.Unmarshal(doc["events"], &events); err != nil {
		t.Fatal(err)
	}
	for i, ev := range events {
		v4CheckEvent(t, ev, fmt.Sprintf("served event %d", i))
	}
	var cov map[string]any
	if err := json.Unmarshal(doc["coverage"], &cov); err != nil {
		t.Fatalf("served coverage: %v", err)
	}
	v4CheckCoverage(t, cov, "served")
}

// TestNotifyHistoryCoverageReportsSpoolOverflow pins the degraded-coverage
// accounting (§9.8): once the spool evicts oldest records to its bound, the
// history response reports complete:false with one gap naming the evicted
// seq range of the current epoch.
func TestNotifyHistoryCoverageReportsSpoolOverflow(t *testing.T) {
	stateDir := t.TempDir()
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	engine := alerts.NewEngine(cfg, alerts.NewPresence(), alerts.NewDispatcher(cfg, alerts.NewPresence()))
	engine.SetHistory(alerts.NewHistory(stateDir))
	spool := alerts.NewSourceSpool(stateDir, "w-ov", 2)
	engine.SetSource(spool)

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-ov", workerName: "Over"})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	for i := 0; i < 4; i++ {
		engine.EmitDaemonNotice("down") // ring + spool via the real tap
	}

	_, body := notifyGet(t, web.URL+"/vh/notify/history")
	var resp struct {
		Coverage struct {
			Complete bool `json:"complete"`
			Gaps     []struct {
				SourceID string `json:"source_id"`
				Epoch    string `json:"epoch"`
				FromSeq  int64  `json:"from_seq"`
				ToSeq    int64  `json:"to_seq"`
			} `json:"gaps"`
		} `json:"coverage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("body: %v (%s)", err, body)
	}
	if resp.Coverage.Complete {
		t.Fatalf("coverage must be incomplete after spool overflow: %s", body)
	}
	if len(resp.Coverage.Gaps) != 1 {
		t.Fatalf("want exactly one gap, got %+v (%s)", resp.Coverage.Gaps, body)
	}
	g := resp.Coverage.Gaps[0]
	if g.SourceID != "w-ov" || g.Epoch != spool.Epoch() || g.FromSeq != 1 || g.ToSeq != 2 {
		t.Fatalf("gap = %+v, want {w-ov, %q, 1, 2}", g, spool.Epoch())
	}
}

// coverageState fetches and decodes the coverage object off the live route.
func coverageState(t *testing.T, web *httptest.Server) (bool, []struct {
	SourceID string `json:"source_id"`
	Epoch    string `json:"epoch"`
	FromSeq  int64  `json:"from_seq"`
	ToSeq    int64  `json:"to_seq"`
}, []byte) {
	t.Helper()
	_, body := notifyGet(t, web.URL+"/vh/notify/history")
	var resp struct {
		Coverage struct {
			Complete bool `json:"complete"`
			Gaps     []struct {
				SourceID string `json:"source_id"`
				Epoch    string `json:"epoch"`
				FromSeq  int64  `json:"from_seq"`
				ToSeq    int64  `json:"to_seq"`
			} `json:"gaps"`
		} `json:"coverage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("coverage body: %v (%s)", err, body)
	}
	return resp.Coverage.Complete, resp.Coverage.Gaps, body
}

// TestNotifyHistoryCoverageDegradesOnPersistFailure pins B1 case (a): while
// the spool's last persist has failed (record in memory, not durable), the
// history route serves coverage.complete:false with a gap naming the KNOWN
// undurable seq range of the current epoch — and recovers to complete:true
// (gap gone) once a later append persists cleanly (the whole-document write
// carries the undurable record along).
func TestNotifyHistoryCoverageDegradesOnPersistFailure(t *testing.T) {
	stateDir := t.TempDir()
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	engine := alerts.NewEngine(cfg, alerts.NewPresence(), alerts.NewDispatcher(cfg, alerts.NewPresence()))
	engine.SetHistory(alerts.NewHistory(stateDir))
	spool := alerts.NewSourceSpool(stateDir, "w-pf", 0)
	engine.SetSource(spool)

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-pf", workerName: "PF"})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	engine.EmitDaemonNotice("down #1") // durable (seq 1)
	if got := spool.LastPersistError(); got != "" {
		t.Fatalf("premise: clean start, got persist error %q", got)
	}

	// Sabotage the persist target, then emit: the record lands in memory
	// only, visibly.
	path := filepath.Join(stateDir, "notify-source.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	engine.EmitDaemonNotice("down #2") // seq 2, NOT durable
	if got := spool.LastPersistError(); got == "" {
		t.Fatal("premise: the append persist must have failed visibly")
	}

	complete, gaps, body := coverageState(t, web)
	if complete {
		t.Fatalf("coverage must degrade to complete:false while a persist has failed: %s", body)
	}
	if len(gaps) != 1 {
		t.Fatalf("want exactly one (undurable-range) gap, got %+v (%s)", gaps, body)
	}
	if g := gaps[0]; g.SourceID != "w-pf" || g.Epoch != spool.Epoch() || g.FromSeq != 2 || g.ToSeq != 2 {
		t.Fatalf("undurable gap = %+v, want {w-pf, %q, 2, 2}", g, spool.Epoch())
	}

	// Recover the write path: the next append persists the whole document
	// (carrying seq 2 along) — coverage is honestly complete again.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	engine.EmitDaemonNotice("down #3") // seq 3, durable — and 2 with it
	if got := spool.LastPersistError(); got != "" {
		t.Fatalf("recovered persist must clear LastPersistError, got %q", got)
	}
	complete, gaps, body = coverageState(t, web)
	if !complete || len(gaps) != 0 {
		t.Fatalf("after recovery coverage must be complete with no gaps, got complete=%v gaps=%+v (%s)", complete, gaps, body)
	}
}

// TestNotifyHistoryCoverageDegradesOnPersistFailureFromInit pins B1 case (a)
// at INIT (B2's surface): a spool whose initial head persist failed (epoch in
// memory only, LastPersistError set from construction) degrades coverage to
// complete:false even though no record exists yet — no gap is nameable, the
// error is the signal.
func TestNotifyHistoryCoverageDegradesOnPersistFailureFromInit(t *testing.T) {
	stateDir := t.TempDir()
	// The tmp write target is occupied: construction's initial persist fails.
	if err := os.Mkdir(filepath.Join(stateDir, "notify-source.json.tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	engine := alerts.NewEngine(cfg, alerts.NewPresence(), alerts.NewDispatcher(cfg, alerts.NewPresence()))
	engine.SetHistory(alerts.NewHistory(stateDir))
	spool := alerts.NewSourceSpool(stateDir, "w-pi", 0)
	engine.SetSource(spool)
	if got := spool.LastPersistError(); got == "" {
		t.Fatal("premise: init persist failure must be visible from construction")
	}

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-pi", workerName: "PI"})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	complete, gaps, body := coverageState(t, web)
	if complete {
		t.Fatalf("init persist failure must degrade coverage: %s", body)
	}
	if len(gaps) != 0 {
		t.Fatalf("no record exists — no gap is nameable, the error is the signal; got %+v", gaps)
	}
}

// TestNotifyHistoryCoverageDegradesOnRotation pins B1 case (b): after an
// epoch rotation (corrupt spool file — genuine source-state replacement),
// the prior range is discontinuous and UNRECOVERABLE, so the route serves
// complete:false with the empty-range gap entry (from_seq:1, to_seq:0)
// carrying the CURRENT epoch (the old epoch value is unknowable from a
// corrupt document). Pre-rotation ring events lose their source refs (the
// rotated spool no longer holds their records).
func TestNotifyHistoryCoverageDegradesOnRotation(t *testing.T) {
	stateDir := t.TempDir()
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	engine := alerts.NewEngine(cfg, alerts.NewPresence(), alerts.NewDispatcher(cfg, alerts.NewPresence()))
	engine.SetHistory(alerts.NewHistory(stateDir))
	engine.SetSource(alerts.NewSourceSpool(stateDir, "w-rot", 0))

	engine.EmitDaemonNotice("down #1") // epoch E1, seq 1
	engine.EmitDaemonNotice("down #2") // epoch E1, seq 2

	// Corrupt the spool file and "restart" the spool alone: epoch rotates
	// (rotatedAt stamped), records gone, ring untouched.
	if err := os.WriteFile(filepath.Join(stateDir, "notify-source.json"), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	spool2 := alerts.NewSourceSpool(stateDir, "w-rot", 0)
	if spool2.RotatedAt() == 0 {
		t.Fatal("premise: corrupt spool must rotate (rotatedAt stamped)")
	}
	engine.SetSource(spool2)
	engine.EmitDaemonNotice("down #3") // new epoch, seq 1

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-rot", workerName: "Rot"})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	complete, gaps, body := coverageState(t, web)
	if complete {
		t.Fatalf("rotation discontinuity must degrade coverage: %s", body)
	}
	if len(gaps) != 1 {
		t.Fatalf("want exactly the rotation gap, got %+v (%s)", gaps, body)
	}
	g := gaps[0]
	if g.SourceID != "w-rot" || g.Epoch != spool2.Epoch() || g.FromSeq != 1 || g.ToSeq != 0 {
		t.Fatalf("rotation gap = %+v, want {w-rot, <current %q>, 1, 0} (empty range = unrecoverable)", g, spool2.Epoch())
	}

	// Pre-rotation ring events read as ring-only legacy events (source
	// omitted); the post-rotation event carries the new epoch's identity.
	_, body = notifyGet(t, web.URL+"/vh/notify/history")
	var resp struct {
		Events []struct {
			ID     int64 `json:"id"`
			Source *struct {
				Epoch string `json:"epoch"`
				Seq   int64  `json:"seq"`
			} `json:"source"`
		} `json:"events"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Events) != 3 {
		t.Fatalf("want 3 ring events, got %d (%s)", len(resp.Events), body)
	}
	for _, ev := range resp.Events[:2] {
		if ev.Source != nil {
			t.Fatalf("pre-rotation event %d must lose its source ref after rotation: %+v", ev.ID, ev.Source)
		}
	}
	last := resp.Events[2]
	if last.Source == nil || last.Source.Epoch != spool2.Epoch() || last.Source.Seq != 1 {
		t.Fatalf("post-rotation event source = %+v, want {%q, 1}", last.Source, spool2.Epoch())
	}
}

// TestNotifyHistoryV4RingResetDoesNotMisAttribute pins t1b-F1 at the route
// level for the ring-FILE-LOSS reuse mode: the spool survives while the RING
// file is lost, so the ring restarts its ids at 1. The new permission-kind
// notice at the reused historyID 1 must be served with ITS OWN identity —
// never the old question-kind record's source tuple or kind — because the
// event carries its OWN spool (epoch, seq) and the join resolves by THAT.
func TestNotifyHistoryV4RingResetDoesNotMisAttribute(t *testing.T) {
	stateDir := t.TempDir()
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	ring1 := alerts.NewHistory(stateDir)
	spool1 := alerts.NewSourceSpool(stateDir, "w-rst", 0)

	// Era 1: a question-kind notice (spool seq 1; the t1b-F1 tap order —
	// spool first, then the ring event carrying the key).
	notice1 := alerts.Notice{Type: alerts.TypeWaiting, Kind: alerts.KindQuestion, SessionID: "s1", Root: "s1",
		Project: "/w", Title: "Review requested", Detail: "Question pending", Ts: 100}
	rec1, err := spool1.Append(notice1, alerts.DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ring1.Record(notice1, rec1.Seq, spool1.Epoch()); err != nil {
		t.Fatal(err)
	}

	// Lose ONLY the ring file; reload both. The ring restarts ids at 1;
	// the spool keeps its records.
	if err := os.Remove(filepath.Join(stateDir, "notify-history.json")); err != nil {
		t.Fatal(err)
	}
	ring2 := alerts.NewHistory(stateDir)
	spool2 := alerts.NewSourceSpool(stateDir, "w-rst", 0)

	// Era 2: a permission-kind notice at the REUSED id 1 (spool seq 2).
	notice2 := alerts.Notice{Type: alerts.TypeWaiting, Kind: alerts.KindPermission, SessionID: "s2", Root: "s2",
		Project: "/w", Title: "Deploy blocked", Detail: "Permission pending", Ts: 200}
	rec2, err := spool2.Append(notice2, alerts.DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	ev2, err := ring2.Record(notice2, rec2.Seq, spool2.Epoch())
	if err != nil {
		t.Fatal(err)
	}
	if ev2.ID != 1 {
		t.Fatalf("premise: ring must reuse id 1, got %d", ev2.ID)
	}

	engine := alerts.NewEngine(cfg, alerts.NewPresence(), alerts.NewDispatcher(cfg, alerts.NewPresence()))
	engine.SetHistory(ring2)
	engine.SetSource(spool2)
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-rst", workerName: "Rst"})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	_, body := notifyGet(t, web.URL+"/vh/notify/history")
	var resp struct {
		Events []struct {
			ID     int64  `json:"id"`
			Kind   string `json:"kind"`
			Source *struct {
				Epoch string `json:"epoch"`
				Seq   int64  `json:"seq"`
			} `json:"source"`
		} `json:"events"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Events) != 1 || resp.Events[0].ID != 1 {
		t.Fatalf("the reset ring serves exactly its one event (id 1), got %+v (%s)", resp.Events, body)
	}
	served := resp.Events[0]
	// CRUX: the served event carries the NEW record's identity — the new
	// kind (permission_pending) and the new source tuple (seq 2) — or no
	// source at all; NEVER the old question record's kind/source (seq 1).
	if served.Kind == "question_pending" {
		t.Fatalf("mis-attribution: new permission event served with the OLD question kind: %s", body)
	}
	if served.Kind != "permission_pending" {
		t.Fatalf("served kind = %q, want permission_pending (the spool preserves the subtype)", served.Kind)
	}
	if served.Source == nil {
		t.Fatal("the current-era record must join and carry a source ref")
	}
	if served.Source.Epoch != spool2.Epoch() || served.Source.Seq != rec2.Seq || served.Source.Seq == 1 {
		t.Fatalf("served source = %+v, want the NEW record's identity (epoch %q seq %d, never seq 1)",
			served.Source, spool2.Epoch(), rec2.Seq)
	}
}

// TestNotifyHistoryV4RingRollbackReuseNoMisAttribution is the t1b-F1
// reviewer's repro at the route level: a ring persist FAILURE is silently
// rolled back to the last READABLE ring file (the ring re-allocates the id),
// while the spool durably holds the failed event's record. The re-used-id
// permission event must be served with permission_pending and ITS OWN new
// source seq — never the old question record's tuple (what the old
// (ringGen, id) join served one failure mode out).
func TestNotifyHistoryV4RingRollbackReuseNoMisAttribution(t *testing.T) {
	stateDir := t.TempDir()
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	ring1 := alerts.NewHistory(stateDir)
	spool1 := alerts.NewSourceSpool(stateDir, "w-rb", 0)

	// Healthy pre-state: one durable notice (ring id 1, spool seq 1) — the
	// "older readable ring" the rollback restarts from.
	healthy := alerts.Notice{Type: alerts.TypeFinished, SessionID: "s0", Root: "s0", Project: "/w",
		Title: "Done", Detail: "finished", Ts: 1}
	rec0, err := spool1.Append(healthy, alerts.DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ring1.Record(healthy, rec0.Seq, spool1.Epoch()); err != nil {
		t.Fatal(err)
	}

	// Sabotage ONLY the ring tmp-write target: the question notice gets
	// spool seq 2 (durable), while the ring's write for id 2 FAILS —
	// visibly, t1b-F1's enabling-condition fix.
	if err := os.Mkdir(filepath.Join(stateDir, "notify-history.json.tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	question := alerts.Notice{Type: alerts.TypeWaiting, Kind: alerts.KindQuestion, SessionID: "s1", Root: "s1",
		Project: "/w", Title: "Review requested", Detail: "Question pending", Ts: 100}
	recQ, err := spool1.Append(question, alerts.DetectionContext{})
	if err != nil {
		t.Fatalf("spool append must succeed while only the ring is sabotaged: %v", err)
	}
	if _, err := ring1.Record(question, recQ.Seq, spool1.Epoch()); err == nil {
		t.Fatal("premise: the ring persist must fail under sabotage")
	}
	if got := ring1.LastPersistError(); got == "" {
		t.Fatal("premise: the ring failure must be visible")
	}

	// Restart from the last READABLE ring (lastID 1); lift the sabotage;
	// emit the permission notice: the ring RE-ALLOCATES id 2, the spool
	// grants it seq 3.
	if err := os.Remove(filepath.Join(stateDir, "notify-history.json.tmp")); err != nil {
		t.Fatal(err)
	}
	ring2 := alerts.NewHistory(stateDir)
	spool2 := alerts.NewSourceSpool(stateDir, "w-rb", 0)
	permission := alerts.Notice{Type: alerts.TypeWaiting, Kind: alerts.KindPermission, SessionID: "s2", Root: "s2",
		Project: "/w", Title: "Deploy blocked", Detail: "Permission pending", Ts: 200}
	recP, err := spool2.Append(permission, alerts.DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	evP, err := ring2.Record(permission, recP.Seq, spool2.Epoch())
	if err != nil {
		t.Fatalf("ring persist must succeed after the sabotage is lifted: %v", err)
	}
	if evP.ID != 2 {
		t.Fatalf("premise: the ring must re-allocate id 2, got %d", evP.ID)
	}

	engine := alerts.NewEngine(cfg, alerts.NewPresence(), alerts.NewDispatcher(cfg, alerts.NewPresence()))
	engine.SetHistory(ring2)
	engine.SetSource(spool2)
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-rb", workerName: "Rb"})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	_, body := notifyGet(t, web.URL+"/vh/notify/history")
	var resp struct {
		Events []struct {
			ID     int64  `json:"id"`
			Kind   string `json:"kind"`
			Source *struct {
				Epoch string `json:"epoch"`
				Seq   int64  `json:"seq"`
			} `json:"source"`
		} `json:"events"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Events) != 2 || resp.Events[1].ID != 2 {
		t.Fatalf("the rolled-back ring serves the healthy event plus the re-allocated id 2, got %+v (%s)", resp.Events, body)
	}
	served := resp.Events[1]
	// CRUX: permission_pending with the record's OWN new source seq (3) —
	// never the question record's kind or tuple (seq 2).
	if served.Kind == "question_pending" {
		t.Fatalf("mis-attribution: re-allocated event served with the OLD question kind: %s", body)
	}
	if served.Kind != "permission_pending" {
		t.Fatalf("served kind = %q, want permission_pending", served.Kind)
	}
	if served.Source == nil {
		t.Fatal("the re-allocated event must join its OWN record and carry a source ref")
	}
	if served.Source.Epoch != spool2.Epoch() || served.Source.Seq != recP.Seq || served.Source.Seq == 2 {
		t.Fatalf("served source = %+v, want the NEW record's identity (epoch %q seq %d, never the question seq 2)",
			served.Source, spool2.Epoch(), recP.Seq)
	}
	// And the healthy event still joins its own record (seq 1).
	first := resp.Events[0]
	if first.Source == nil || first.Source.Seq != 1 {
		t.Fatalf("healthy event source = %+v, want seq 1", first.Source)
	}
}

// TestNotifyHistoryV4QuestionServesPendingThroughSpoolPersistFailure is the
// F3 contract_drift regression (a): a NEW question notice whose spool append
// could not durably persist leaves the ring event key-less — and must still
// serve kind=question_pending (§9.1), source omitted. The pre-fix code
// computed the condition BEFORE the spool branch from a Kind-less ring event,
// mis-serving these as permission_pending.
func TestNotifyHistoryV4QuestionServesPendingThroughSpoolPersistFailure(t *testing.T) {
	stateDir := t.TempDir()
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	engine := alerts.NewEngine(cfg, alerts.NewPresence(), alerts.NewDispatcher(cfg, alerts.NewPresence()))
	engine.SetHistory(alerts.NewHistory(stateDir))
	spool := alerts.NewSourceSpool(stateDir, "w-qpf", 0)
	engine.SetSource(spool)

	// Sabotage the spool's persist target (the CoverageDegradesOnPersistFailure
	// shape): the append lands in memory only and FAILS visibly.
	path := filepath.Join(stateDir, "notify-source.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}

	// The tap's failed-append branch (engine.recordNotice): the spool Append
	// errors, so the ring event is recorded key-less — (0, "") — while the
	// ring retains the notice's OWN subtype.
	question := alerts.Notice{Type: alerts.TypeWaiting, Kind: alerts.KindQuestion, SessionID: "s1", Root: "s1",
		Project: "/w", Title: "Review requested", Detail: "Question pending", Ts: 100}
	if _, err := spool.Append(question, alerts.DetectionContext{}); err == nil {
		t.Fatal("premise: the spool append must fail under sabotage")
	}
	if _, err := engine.History().Record(question, 0, ""); err != nil {
		t.Fatalf("ring record: %v", err)
	}

	// A subtype-less waiting record with no join (the pre-S1 legacy posture:
	// no ring Kind, no spool key) — the ONLY shape that may serve the
	// permission_pending default.
	legacy := alerts.Notice{Type: alerts.TypeWaiting, SessionID: "s2", Root: "s2",
		Project: "/w", Title: "Old waiting", Detail: "pre-S1", Ts: 200}
	if _, err := engine.History().Record(legacy, 0, ""); err != nil {
		t.Fatalf("ring record (legacy): %v", err)
	}

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-qpf", workerName: "Qpf"})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	_, body := notifyGet(t, web.URL+"/vh/notify/history")
	var resp struct {
		Events []struct {
			ID     int64  `json:"id"`
			Kind   string `json:"kind"`
			Source *struct {
				Epoch string `json:"epoch"`
				Seq   int64  `json:"seq"`
			} `json:"source"`
		} `json:"events"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("history body: %v (%s)", err, body)
	}
	if len(resp.Events) != 2 {
		t.Fatalf("want 2 events, got %d (%s)", len(resp.Events), body)
	}

	// CRUX (a): question_pending through the failed spool append, source omitted.
	q := resp.Events[0]
	if q.Kind != "question_pending" {
		t.Fatalf("question through spool persist failure: kind = %q, want question_pending (never permission_pending)", q.Kind)
	}
	if q.Source != nil {
		t.Fatalf("failed-append event must omit source: %+v", q.Source)
	}

	// The fallback stays RESTRICTED: only the subtype-less legacy record
	// serves the permission_pending default.
	l := resp.Events[1]
	if l.Kind != "permission_pending" {
		t.Fatalf("subtype-less legacy waiting record: kind = %q, want the permission_pending default", l.Kind)
	}
	if l.Source != nil {
		t.Fatalf("legacy record must omit source: %+v", l.Source)
	}
}

// TestNotifyHistoryV4QuestionServesPendingThroughSpoolRotation is the F3
// contract_drift regression (b): a question notice durably recorded and
// retained in the ring loses its spool record to an epoch ROTATION (the join
// misses on the epoch guard) — and must still serve kind=question_pending,
// source omitted. The pre-fix code lost the subtype with the join.
func TestNotifyHistoryV4QuestionServesPendingThroughSpoolRotation(t *testing.T) {
	stateDir := t.TempDir()
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	ring := alerts.NewHistory(stateDir)
	spool1 := alerts.NewSourceSpool(stateDir, "w-qrot", 0)

	// Era 1: the question notice through the tap-order public surfaces
	// (spool first — seq 1 — then the ring event carrying the key).
	question := alerts.Notice{Type: alerts.TypeWaiting, Kind: alerts.KindQuestion, SessionID: "s1", Root: "s1",
		Project: "/w", Title: "Review requested", Detail: "Question pending", Ts: 100}
	recQ, err := spool1.Append(question, alerts.DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ring.Record(question, recQ.Seq, spool1.Epoch()); err != nil {
		t.Fatal(err)
	}

	// Corrupt the spool file and "restart" the spool alone: the epoch
	// rotates, the era-1 records are gone, the ring is untouched.
	if err := os.WriteFile(filepath.Join(stateDir, "notify-source.json"), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	spool2 := alerts.NewSourceSpool(stateDir, "w-qrot", 0)
	if spool2.RotatedAt() == 0 {
		t.Fatal("premise: corrupt spool must rotate (rotatedAt stamped)")
	}
	if spool2.Epoch() == spool1.Epoch() {
		t.Fatal("premise: the rotation must mint a fresh epoch")
	}

	engine := alerts.NewEngine(cfg, alerts.NewPresence(), alerts.NewDispatcher(cfg, alerts.NewPresence()))
	engine.SetHistory(ring)
	engine.SetSource(spool2)
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-qrot", workerName: "Qrot"})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	_, body := notifyGet(t, web.URL+"/vh/notify/history")
	var resp struct {
		Events []struct {
			ID     int64  `json:"id"`
			Kind   string `json:"kind"`
			Source *struct {
				Epoch string `json:"epoch"`
				Seq   int64  `json:"seq"`
			} `json:"source"`
		} `json:"events"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("history body: %v (%s)", err, body)
	}
	if len(resp.Events) != 1 {
		t.Fatalf("the ring retains exactly the one event, got %d (%s)", len(resp.Events), body)
	}

	// CRUX (b): the epoch guard makes the join miss (the event carries the
	// OLD epoch), so source is omitted — but the ring's OWN retained subtype
	// still serves question_pending, never permission_pending.
	served := resp.Events[0]
	if served.Kind != "question_pending" {
		t.Fatalf("question after spool rotation: kind = %q, want question_pending (never permission_pending)", served.Kind)
	}
	if served.Source != nil {
		t.Fatalf("pre-rotation event must lose its source ref after rotation: %+v", served.Source)
	}
}

// TestNotifyHistoryCoverageDegradesOnSpoolLoss pins t1b-F2 at the route
// level: with post-S1 ring evidence present, a DELETED notify-source.json
// (filesystem loss — not corruption) re-inits as a rotation: the route serves
// complete:false with the empty-range gap {current epoch, 1, 0}. The
// clean-init complement (fresh state dir, no ring evidence) stays
// complete:true.
func TestNotifyHistoryCoverageDegradesOnSpoolLoss(t *testing.T) {
	stateDir := t.TempDir()
	cfg, err := alerts.NewStore(stateDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	engine := alerts.NewEngine(cfg, alerts.NewPresence(), alerts.NewDispatcher(cfg, alerts.NewPresence()))
	ring := alerts.NewHistory(stateDir)
	engine.SetHistory(ring)
	spool1 := alerts.NewSourceSpool(stateDir, "w-loss", 0)
	engine.SetSource(spool1)

	// Persist notices (post-S1 ring with generations): two durable records.
	engine.EmitDaemonNotice("down #1") // spool seq 1, ring id 1
	engine.EmitDaemonNotice("down #2") // spool seq 2, ring id 2

	// Delete ONLY the spool file; reload it onto the engine.
	if err := os.Remove(filepath.Join(stateDir, "notify-source.json")); err != nil {
		t.Fatal(err)
	}
	spool2 := alerts.NewSourceSpool(stateDir, "w-loss", 0)
	if spool2.RotatedAt() == 0 {
		t.Fatal("premise: spool loss with ring evidence must stamp the rotation")
	}
	engine.SetSource(spool2)

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv.RegisterFeature(notifyFeature{engine: engine, tokens: alerts.NewTokenRegistry(stateDir), workerID: "w-loss", workerName: "Loss"})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	complete, gaps, body := coverageState(t, web)
	if complete {
		t.Fatalf("spool file loss with post-S1 ring evidence must degrade coverage: %s", body)
	}
	if len(gaps) != 1 {
		t.Fatalf("want exactly the loss rotation gap, got %+v (%s)", gaps, body)
	}
	g := gaps[0]
	if g.SourceID != "w-loss" || g.Epoch != spool2.Epoch() || g.FromSeq != 1 || g.ToSeq != 0 {
		t.Fatalf("loss gap = %+v, want {w-loss, <current %q>, 1, 0} (empty range = unrecoverable)", g, spool2.Epoch())
	}

	// Clean-init complement: a fresh state dir (empty ring evidence, no
	// spool file) inits complete — the true-first-run posture.
	freshDir := t.TempDir()
	cfg2, err := alerts.NewStore(freshDir + "/alerts.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	engine2 := alerts.NewEngine(cfg2, alerts.NewPresence(), alerts.NewDispatcher(cfg2, alerts.NewPresence()))
	engine2.SetHistory(alerts.NewHistory(freshDir))
	engine2.SetSource(alerts.NewSourceSpool(freshDir, "w-fresh", 0))
	srv2, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv2.RegisterFeature(notifyFeature{engine: engine2, tokens: alerts.NewTokenRegistry(freshDir), workerID: "w-fresh", workerName: "Fresh"})
	web2 := httptest.NewServer(srv2.Handler())
	t.Cleanup(web2.Close)
	complete, gaps, body = coverageState(t, web2)
	if !complete || len(gaps) != 0 {
		t.Fatalf("clean first run must stay complete with no gaps, got complete=%v gaps=%+v (%s)", complete, gaps, body)
	}
}

// newInitAlertsFenceFixture builds the InitAlerts test fixture: an isolated
// VH_STATE_DIR carrying a CONFIGURED notify section (mock OAuth token_uri +
// real service-account creds file), a counting token endpoint, and the real
// web Server. Returns the server, state dir, creds path, and the request
// counter.
func newInitAlertsFenceFixture(t *testing.T) (*Server, string, string, *atomic.Int64) {
	t.Helper()
	stateDir := t.TempDir()
	t.Setenv("VH_STATE_DIR", stateDir)

	var hits atomic.Int64
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"t","expires_in":3600}`))
	}))
	t.Cleanup(tokenSrv.Close)

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	cj, _ := json.Marshal(map[string]string{
		"type":         "service_account",
		"project_id":   "p",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "bot@p.iam.gserviceaccount.com",
		"token_uri":    tokenSrv.URL,
	})
	credsPath := filepath.Join(stateDir, "creds.json")
	if err := os.WriteFile(credsPath, cj, 0o600); err != nil {
		t.Fatal(err)
	}
	// Pre-write the alerts config with the notify section so InitAlerts
	// finds a CONFIGURED channel (the fence test's premise: credentials
	// exist and load — only the fence can stop the sender).
	cfgDoc := map[string]any{
		"channels": []any{}, "profiles": []any{}, "active_profile": "",
		"detect": map[string]any{},
		"notify": map[string]any{"credentials_file": credsPath, "project_id": "p"},
	}
	cj2, _ := json.Marshal(cfgDoc)
	if err := os.WriteFile(filepath.Join(stateDir, "alerts.jsonc"), cj2, 0o600); err != nil {
		t.Fatal(err)
	}

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	return srv, stateDir, credsPath, &hits
}

// TestInitAlertsControllerModeFencesLocalFCM is the S1 fence CRUX: with a
// controller URL configured AND loadable credentials AND a registered token,
// InitAlerts(controller mode) attaches NO sender — nothing can send locally
// (zero token-endpoint requests after a notice, including none in flight at
// tunnel start), the probe reports the unconfigured shape, the ownership
// file records the fence, and detection still lands in the durable spool.
func TestInitAlertsControllerModeFencesLocalFCM(t *testing.T) {
	srv, stateDir, _, hits := newInitAlertsFenceFixture(t)

	engine, err := srv.InitAlerts(context.Background(), AlertsOptions{
		ControllerURL: "ws://controller.example/vh-solara/ws",
		WorkerID:      "bason",
		WorkerName:    "bason",
	})
	if err != nil {
		t.Fatalf("InitAlerts: %v", err)
	}
	if engine.Notifier() != nil {
		t.Fatal("controller mode: a local FCM sender must NEVER attach")
	}
	if engine.NotifyReady() {
		t.Fatal("controller mode: NotifyReady must be false (fenced)")
	}

	// The fence decision is persisted (mode=controller, H null).
	st, ok := alerts.ReadNotifyOwnership(stateDir)
	if !ok || st.Mode != alerts.OwnershipModeController || st.Watermark != nil {
		t.Fatalf("ownership state = %+v ok=%v, want controller mode + null H", st, ok)
	}

	// Durable source is live: a notice through the real engine path lands
	// with (epoch, seq) identity even while fenced. The correlation key is
	// the durable seq the tap stamped into the ring event (t1b-F1).
	engine.EmitDaemonNotice("serve died")
	if _, ok := engine.Source().LookupBySeq(1); !ok {
		t.Fatal("fenced worker must still record durably (detection continues)")
	}
	events, _ := engine.History().Query(0, 50)
	if len(events) != 1 || events[0].SpoolSeq != 1 || events[0].SpoolEpoch != engine.Source().Epoch() {
		t.Fatalf("the ring event must carry its record's (epoch, seq): %+v", events)
	}
	if engine.Source().Epoch() == "" || engine.Source().LastSeq() != 1 {
		t.Fatalf("durable identity drift: epoch=%q lastSeq=%d", engine.Source().Epoch(), engine.Source().LastSeq())
	}

	// The drain pin: no in-flight local sends at startup (the fence engages
	// BEFORE the tunnel; there is no sender to send). The mock token
	// endpoint must have seen ZERO requests.
	if n := hits.Load(); n != 0 {
		t.Fatalf("local FCM attempted %d token-endpoint requests while fenced", n)
	}
}

// TestInitAlertsStandaloneKeepsLocalFCM pins the v3 regression bar: the SAME
// fixture in standalone posture (zero options) attaches the sender and the
// ownership file records standalone — local FCM unchanged.
func TestInitAlertsStandaloneKeepsLocalFCM(t *testing.T) {
	srv, stateDir, _, _ := newInitAlertsFenceFixture(t)

	engine, err := srv.InitAlerts(context.Background(), AlertsOptions{})
	if err != nil {
		t.Fatalf("InitAlerts: %v", err)
	}
	if engine.Notifier() == nil || !engine.NotifyReady() {
		t.Fatal("standalone mode: local FCM must attach exactly as v3")
	}
	st, ok := alerts.ReadNotifyOwnership(stateDir)
	if !ok || st.Mode != alerts.OwnershipModeStandalone {
		t.Fatalf("ownership state = %+v ok=%v, want standalone", st, ok)
	}
}

// TestInitAlertsControllerAfterStandaloneStaysFenced pins the cutover at the
// InitAlerts level: a state dir that ran standalone flips to fenced when the
// daemon next launches in controller mode (and a later standalone relaunch
// does not unfence it).
func TestInitAlertsControllerAfterStandaloneStaysFenced(t *testing.T) {
	srv, stateDir, _, _ := newInitAlertsFenceFixture(t)

	if eng, err := srv.InitAlerts(context.Background(), AlertsOptions{}); err != nil || !eng.NotifyReady() {
		t.Fatalf("standalone first launch: err=%v ready=%v", err, eng.NotifyReady())
	}
	// Controller relaunch on the same state dir. New server (features are
	// per-server); same VH_STATE_DIR (t.Setenv still in effect).
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv2, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	eng2, err := srv2.InitAlerts(context.Background(), AlertsOptions{ControllerURL: "ws://c/x", WorkerID: "w", WorkerName: "w"})
	if err != nil {
		t.Fatal(err)
	}
	if eng2.Notifier() != nil || eng2.NotifyReady() {
		t.Fatal("controller relaunch must fence local FCM")
	}
	// And a subsequent STANDALONE relaunch stays fenced (never restore
	// local authority on a launch-flag change).
	srv3, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	eng3, err := srv3.InitAlerts(context.Background(), AlertsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if eng3.Notifier() != nil || eng3.NotifyReady() {
		t.Fatal("standalone relaunch after centralization must STAY fenced")
	}
	st, _ := alerts.ReadNotifyOwnership(stateDir)
	if st.Mode != alerts.OwnershipModeController {
		t.Fatalf("persisted mode = %q, want controller preserved", st.Mode)
	}
}
