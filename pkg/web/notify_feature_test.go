package web

// notify_feature_test.go — lane-1 tests for the /vh/notify/* routes
// (pkg/web/notify_feature.go). The crux test drives notices through the REAL
// engine (alerts.Engine.EmitDaemonNotice with a suppressing profile) and reads
// them back over HTTP — no handler faking.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
		Enabled bool `json:"enabled"`
		Count   int  `json:"count"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		t.Fatalf("probe body: %v (%s)", err, body)
	}
	if probe.Enabled || probe.Count != 0 {
		t.Fatalf("unconfigured probe = %+v, want enabled:false count:0", probe)
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
