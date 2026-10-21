package integration

// notify_lifecycle_test.go — the /vh/notify/* production-wiring proof (closes
// the slice-2 gate defer): the REAL InitAlerts construction (engine + FCM
// notifier + shared token registry + notify feature, exactly as
// pkg/web/alerts_feature.go wires them in cmd/client-daemon-vh.go), a device
// token registered through the real route, a waiting-question notice driven
// through the real engine event path (question.asked applied into the shared
// state store → watcher fire → notifier.Send), and the resulting data-only
// FCM HTTP v1 message captured by a mock FCM server.
//
// The FCM API root is production-fixed (https://fcm.googleapis.com) and has no
// config override, so the mock is reached by a test-scoped http.DefaultTransport
// wrapper that rewrites fcm.googleapis.com requests to the local mock — the
// notifier's client resolves DefaultTransport per request. Everything else
// (OAuth token endpoint via the credentials file's token_uri, routes, engine,
// store) is the untouched production path. The wrapper delegates all other
// hosts to the prior default transport and is restored on cleanup; this
// package's tests run strictly serially (no t.Parallel anywhere).
//
// NOT covered here and intentionally so: controller-mediated access. The
// controller (pkg/server/daemon.go hostInterceptor) carves /vh/notify/* out
// as controller-owned and serves its own pre-existing notification handlers —
// a different, older surface. This test drives the WORKER daemon's routes
// directly (loopback), which is the only path where this contract is
// currently reachable (see docs/architecture/notify-fcm.md §7).

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// fcmRedirectTransport rewrites https://fcm.googleapis.com requests to a local
// mock server, delegating everything else to the wrapped transport.
type fcmRedirectTransport struct {
	inner  http.RoundTripper
	target string // host:port of the mock FCM server
}

func (t fcmRedirectTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme == "https" && req.URL.Hostname() == "fcm.googleapis.com" {
		r2 := req.Clone(req.Context())
		r2.URL.Scheme = "http"
		r2.URL.Host = t.target
		return t.inner.RoundTrip(r2)
	}
	return t.inner.RoundTrip(req)
}

// notifyFCMReceipt is one captured FCM HTTP v1 send request.
type notifyFCMReceipt struct {
	Path          string
	Authorization string
	Raw           []byte
}

type notifyFCMMock struct {
	mu       sync.Mutex
	count    int
	receipts chan notifyFCMReceipt
}

func (m *notifyFCMMock) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	m.mu.Lock()
	m.count++
	m.mu.Unlock()
	m.receipts <- notifyFCMReceipt{Path: r.URL.Path, Authorization: r.Header.Get("Authorization"), Raw: b}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("{}"))
}

func (m *notifyFCMMock) requests() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.count
}

// TestNotifyLifecycleThroughRealInitAlerts is the production-delivery
// behavioral-closure proof for the /vh/notify/* FCM channel: real InitAlerts
// wiring → waiting-question notice through the real engine event path → FCM
// receipt + history entry + probe enabled:true with the registered count.
func TestNotifyLifecycleThroughRealInitAlerts(t *testing.T) {
	log.SetOutput(io.Discard) // keep test output clean (dir convention)

	// --- fixture: state dir, mock OAuth token endpoint, service-account
	// credentials, alerts.jsonc with a notify section, mock FCM server ---
	stateDir := t.TempDir()
	t.Setenv("VH_STATE_DIR", stateDir) // stateBaseDir() reads it live

	var tmu sync.Mutex
	exchanges := 0
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tmu.Lock()
		exchanges++
		tmu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"integration-access-token","expires_in":3600,"token_type":"Bearer"}`))
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
		"project_id":   "proj-int",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "bot@proj-int.iam.gserviceaccount.com",
		"token_uri":    tokenSrv.URL,
	}
	cj, _ := json.Marshal(creds)
	credsPath := filepath.Join(stateDir, "fcm-creds.json")
	if err := os.WriteFile(credsPath, cj, 0o600); err != nil {
		t.Fatal(err)
	}

	// Write alerts.jsonc via the production config writer: a notify section
	// pointing at the credentials fixture. InitAlerts must find it on disk.
	cfgStore, err := alerts.NewStore(alerts.ConfigPath(stateDir))
	if err != nil {
		t.Fatalf("alerts.NewStore: %v", err)
	}
	c := cfgStore.Get()
	c.Notify = &alerts.NotifyConfig{CredentialsFile: credsPath, ProjectID: "proj-int", TtlSec: 3600}
	if err := cfgStore.Replace(c); err != nil {
		t.Fatalf("alerts Replace: %v", err)
	}

	fcm := &notifyFCMMock{receipts: make(chan notifyFCMReceipt, 8)}
	fcmSrv := httptest.NewServer(fcm)
	t.Cleanup(fcmSrv.Close)

	// Redirect the production FCM API root to the mock (restored on cleanup).
	fcmURL, err := url.Parse(fcmSrv.URL)
	if err != nil {
		t.Fatal(err)
	}
	prevTransport := http.DefaultTransport
	http.DefaultTransport = fcmRedirectTransport{inner: prevTransport, target: fcmURL.Host}
	t.Cleanup(func() { http.DefaultTransport = prevTransport })

	// --- the production boot order (cmd/client-daemon-vh.go): aggregator Run
	// goroutine, then InitAlerts, then the HTTP handler ---
	oc := httptest.NewServer(http.NotFoundHandler()) // OpenCode up-ness is irrelevant here
	t.Cleanup(oc.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	agg := aggregator.New(oc.URL, 512)
	go agg.Run(ctx)

	srv, err := web.NewServer(agg, oc.URL, 512)
	if err != nil {
		t.Fatalf("web.NewServer: %v", err)
	}
	engine, err := srv.InitAlerts(ctx, web.AlertsOptions{}) // the REAL production wiring (standalone posture: local FCM active)
	if err != nil {
		t.Fatalf("InitAlerts: %v", err)
	}
	if !engine.NotifyReady() {
		t.Fatal("test premise: NotifyReady must be true with a loadable notify section at init")
	}
	webSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(webSrv.Close)

	// --- route: probe before any registration ---
	code, body := notifyHTTPGet(t, webSrv.URL+"/vh/notify/tokens")
	var probe struct {
		Enabled bool `json:"enabled"`
		Count   int  `json:"count"`
	}
	if err := json.Unmarshal(body, &probe); err != nil || code != http.StatusOK {
		t.Fatalf("probe before registration: %d %s (%v)", code, body, err)
	}
	if !probe.Enabled || probe.Count != 0 {
		t.Fatalf("configured-but-empty probe = %+v, want enabled:true count:0", probe)
	}

	// --- route: register a device token (mutation → X-VH-CSRF) ---
	code, body = notifyHTTPPost(t, webSrv.URL+"/vh/notify/tokens", `{"token":"integration-device-token","label":"ci-phone"}`)
	if code != http.StatusOK {
		t.Fatalf("POST /vh/notify/tokens: %d %s", code, body)
	}
	code, body = notifyHTTPGet(t, webSrv.URL+"/vh/notify/tokens")
	if err := json.Unmarshal(body, &probe); err != nil || code != http.StatusOK {
		t.Fatalf("probe after registration: %d %s (%v)", code, body, err)
	}
	if !probe.Enabled || probe.Count != 1 {
		t.Fatalf("post-registration probe = %+v, want enabled:true count:1", probe)
	}

	// --- engine event path: touch the default project so aggFor("") fires
	// InitAlerts' SetAggHook → engine.Attach over the shared store ---
	if code, body := notifyHTTPGet(t, webSrv.URL+"/vh/snapshot"); code != http.StatusOK {
		t.Fatalf("GET /vh/snapshot (attaches the engine watcher): %d %s", code, body)
	}

	// Drive question.asked events into the shared store (the same Apply the
	// aggregator's SSE loop uses). The watcher attaches asynchronously, and a
	// pre-subscription Apply is invisible (live-subscriber fan-out), so retry
	// with unique question ids until the FCM message arrives. The per-
	// (type,token) cooldown bounds the fan-out to exactly ONE delivery no
	// matter how many retries fire.
	store := agg.Store()
	var receipt *notifyFCMReceipt
	for i := 1; i <= 25 && receipt == nil; i++ {
		payload, _ := json.Marshal(map[string]string{"id": fmt.Sprintf("q-%d", i), "sessionID": "sess-question-1"})
		store.Apply(opencode.Event{Type: "question.asked", Properties: payload})
		select {
		case r := <-fcm.receipts:
			receipt = &r
		case <-time.After(400 * time.Millisecond):
		}
	}
	if receipt == nil {
		t.Fatal("no FCM message arrived within the retry budget")
	}

	// --- the message contract ---
	if receipt.Path != "/v1/projects/proj-int/messages:send" {
		t.Fatalf("FCM path = %q", receipt.Path)
	}
	if receipt.Authorization != "Bearer integration-access-token" {
		t.Fatalf("Authorization = %q", receipt.Authorization)
	}
	var env struct {
		Message struct {
			Token   string            `json:"token"`
			Data    map[string]string `json:"data"`
			Android *struct {
				Priority    string `json:"priority"`
				CollapseKey string `json:"collapse_key"`
				TTL         string `json:"ttl"`
			} `json:"android"`
		} `json:"message"`
	}
	if err := json.Unmarshal(receipt.Raw, &env); err != nil {
		t.Fatalf("FCM body decode (all-strings data contract): %v (%s)", err, receipt.Raw)
	}
	m := env.Message
	if m.Token != "integration-device-token" {
		t.Fatalf("message.token = %q", m.Token)
	}
	for k, want := range map[string]string{
		"vh_kind":      "notice",
		"vh_event":     "waiting",
		"vh_condition": "question_pending",
		"vh_count":     "1",
	} {
		if got := m.Data[k]; got != want {
			t.Fatalf("data[%s] = %q, want %q", k, got, want)
		}
	}
	if ts := m.Data["vh_ts"]; len(ts) < 13 { // unix millis from the fire site
		t.Fatalf("vh_ts = %q, want unix-millis digits", ts)
	}
	if m.Android == nil {
		t.Fatal("missing android config")
	}
	if m.Android.Priority != "HIGH" {
		t.Fatalf("android.priority = %q, want HIGH (waiting must beat Doze)", m.Android.Priority)
	}
	if m.Android.CollapseKey != "waiting" {
		t.Fatalf("android.collapse_key = %q, want waiting", m.Android.CollapseKey)
	}
	if m.Android.TTL != "3600s" {
		t.Fatalf("android.ttl = %q, want 3600s (config ttl_sec)", m.Android.TTL)
	}
	if jsonHasNotificationBlock(receipt.Raw) {
		t.Fatalf("message must be data-only (no notification block): %s", receipt.Raw)
	}

	// --- delivery hygiene: exactly ONE FCM request and ONE OAuth exchange
	// served the whole lifecycle (cooldown + cache) ---
	time.Sleep(300 * time.Millisecond) // let any stray retry surface
	if got := fcm.requests(); got != 1 {
		t.Fatalf("FCM requests = %d, want exactly 1 (cooldown bounds the retry fan-out)", got)
	}
	tmu.Lock()
	gotExchanges := exchanges
	tmu.Unlock()
	if gotExchanges != 1 {
		t.Fatalf("OAuth exchanges = %d, want exactly 1", gotExchanges)
	}

	// --- history: the notice is retained and served ---
	code, body = notifyHTTPGet(t, webSrv.URL+"/vh/notify/history")
	if code != http.StatusOK {
		t.Fatalf("GET /vh/notify/history: %d %s", code, body)
	}
	var hist struct {
		Events []struct {
			ID        int64  `json:"id"`
			Type      string `json:"type"`
			SessionID string `json:"sessionID"`
		} `json:"events"`
		LastID int64 `json:"lastId"`
	}
	if err := json.Unmarshal(body, &hist); err != nil {
		t.Fatalf("history decode: %v (%s)", err, body)
	}
	if len(hist.Events) == 0 {
		t.Fatal("history is empty; the waiting-question notice must be retained")
	}
	for i, ev := range hist.Events {
		if ev.Type != "waiting" || ev.SessionID != "sess-question-1" {
			t.Fatalf("history event %d drift: %+v", i, ev)
		}
		if ev.ID != int64(i+1) {
			t.Fatalf("history ids not ascending-contiguous: %+v", hist.Events)
		}
	}
	if hist.LastID != int64(len(hist.Events)) {
		t.Fatalf("lastId = %d, want %d (fresh ring; counter == event count)", hist.LastID, len(hist.Events))
	}
}

// --- small local helpers (no clash with opencode_lifecycle_test.go's) ---

func notifyHTTPGet(t *testing.T, url string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func notifyHTTPPost(t *testing.T, url, body string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-VH-CSRF", "1") // state-changing /vh/* requests require it
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// jsonHasNotificationBlock reports whether a top-level "notification" key
// appears in the raw FCM body (the data-only contract forbids it).
func jsonHasNotificationBlock(raw []byte) bool {
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) != nil {
		return true // undecodable bodies fail closed
	}
	_, ok := probe["notification"]
	return ok
}

// bootNotifyLifecycle assembles the same production fixture
// TestNotifyLifecycleThroughRealInitAlerts builds inline (state dir, mock
// OAuth token endpoint, service-account credentials, notify-configured
// alerts.jsonc, mock FCM server via the DefaultTransport redirect, aggregator
// + web.NewServer + the REAL InitAlerts wiring + an HTTP server). Returns
// the live pieces the caller drives. The existing test is left untouched;
// this helper exists so later legs (the v3 session_started sweep proof) can
// share the exact same boot order without duplicating it a second time.
func bootNotifyLifecycle(t *testing.T) (*httptest.Server, *notifyFCMMock, *state.Store) {
	t.Helper()
	stateDir := t.TempDir()
	t.Setenv("VH_STATE_DIR", stateDir) // stateBaseDir() reads it live

	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"integration-access-token","expires_in":3600,"token_type":"Bearer"}`))
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
	cj, _ := json.Marshal(map[string]string{
		"type":         "service_account",
		"project_id":   "proj-int",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "bot@proj-int.iam.gserviceaccount.com",
		"token_uri":    tokenSrv.URL,
	})
	credsPath := filepath.Join(stateDir, "fcm-creds.json")
	if err := os.WriteFile(credsPath, cj, 0o600); err != nil {
		t.Fatal(err)
	}

	cfgStore, err := alerts.NewStore(alerts.ConfigPath(stateDir))
	if err != nil {
		t.Fatalf("alerts.NewStore: %v", err)
	}
	c := cfgStore.Get()
	c.Notify = &alerts.NotifyConfig{CredentialsFile: credsPath, ProjectID: "proj-int", TtlSec: 3600}
	if err := cfgStore.Replace(c); err != nil {
		t.Fatalf("alerts Replace: %v", err)
	}

	fcm := &notifyFCMMock{receipts: make(chan notifyFCMReceipt, 8)}
	fcmSrv := httptest.NewServer(fcm)
	t.Cleanup(fcmSrv.Close)

	fcmURL, err := url.Parse(fcmSrv.URL)
	if err != nil {
		t.Fatal(err)
	}
	prevTransport := http.DefaultTransport
	http.DefaultTransport = fcmRedirectTransport{inner: prevTransport, target: fcmURL.Host}
	t.Cleanup(func() { http.DefaultTransport = prevTransport })

	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	agg := aggregator.New(oc.URL, 512)
	go agg.Run(ctx)

	srv, err := web.NewServer(agg, oc.URL, 512)
	if err != nil {
		t.Fatalf("web.NewServer: %v", err)
	}
	engine, err := srv.InitAlerts(ctx, web.AlertsOptions{}) // the REAL production wiring (standalone posture: local FCM active)
	if err != nil {
		t.Fatalf("InitAlerts: %v", err)
	}
	if !engine.NotifyReady() {
		t.Fatal("test premise: NotifyReady must be true with a loadable notify section at init")
	}
	webSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(webSrv.Close)
	return webSrv, fcm, agg.Store()
}

// TestNotifySessionStartedSweepToFCM is the v3-change-3 lane-2 behavioral
// closure: a root session going RUNNING after the watcher's first-sweep
// baseline produces a session_started FCM receipt (data-only, NORMAL,
// collapse_key=session_started) through the REAL InitAlerts wiring and the
// REAL 20s sweep ticker — no detector shortcut, no test hook.
//
// Timing (the honest cost of riding the production ticker): the watcher
// attaches when the first snapshot request fires SetAggHook (t0); its FIRST
// tick (t0+20s) establishes the running-root baseline WITHOUT firing, so the
// busy status is applied only after that tick has certainly passed (sleep
// > one sweep interval); the SECOND tick (t0+40s) detects the increase and
// fires. Wall time ≈ 50s.
func TestNotifySessionStartedSweepToFCM(t *testing.T) {
	log.SetOutput(io.Discard) // keep test output clean (dir convention)

	webSrv, fcm, store := bootNotifyLifecycle(t)

	// Register a device token through the real route (mutation → CSRF).
	code, body := notifyHTTPPost(t, webSrv.URL+"/vh/notify/tokens", `{"token":"integration-device-token","label":"ci-phone"}`)
	if code != http.StatusOK {
		t.Fatalf("POST /vh/notify/tokens: %d %s", code, body)
	}

	// Attach the engine watcher: touch the default project (aggFor("") fires
	// InitAlerts' SetAggHook → engine.Attach over the shared store).
	if code, body := notifyHTTPGet(t, webSrv.URL+"/vh/snapshot"); code != http.StatusOK {
		t.Fatalf("GET /vh/snapshot (attaches the engine watcher): %d %s", code, body)
	}

	// Wait past the FIRST sweep tick (20s + margin): the baseline (zero
	// running roots) must be established before the session goes running,
	// or the increase would be swallowed by the baseline rule.
	time.Sleep(22 * time.Second)

	// A NEW root session goes RUNNING after the baseline: session.updated
	// (title — properties wrap the session in {info}, the wire shape the
	// translator/reducer parse) then session.status busy — the same Apply
	// the aggregator's SSE loop performs on live OpenCode events.
	store.Apply(opencode.Event{Type: "session.updated", Properties: json.RawMessage(`{"info":{"id":"sess-started-1","title":"Kick off the release"}}`)})
	store.Apply(opencode.Event{Type: "session.status", Properties: json.RawMessage(`{"sessionID":"sess-started-1","status":{"type":"busy"}}`)})

	// The next sweep tick (t0+40s) detects the increase and fires; the FCM
	// delivery goroutine follows within seconds.
	var receipt *notifyFCMReceipt
	deadline := time.Now().Add(30 * time.Second)
	for receipt == nil && time.Now().Before(deadline) {
		select {
		case r := <-fcm.receipts:
			receipt = &r
		case <-time.After(400 * time.Millisecond):
		}
	}
	if receipt == nil {
		t.Fatal("no session_started FCM message arrived within the sweep budget (tick at t0+40s)")
	}

	// --- the message contract (data-only, NORMAL, session_started) ---
	if receipt.Path != "/v1/projects/proj-int/messages:send" {
		t.Fatalf("FCM path = %q", receipt.Path)
	}
	if receipt.Authorization != "Bearer integration-access-token" {
		t.Fatalf("Authorization = %q", receipt.Authorization)
	}
	var env struct {
		Message struct {
			Token   string            `json:"token"`
			Data    map[string]string `json:"data"`
			Android *struct {
				Priority    string `json:"priority"`
				CollapseKey string `json:"collapse_key"`
				TTL         string `json:"ttl"`
			} `json:"android"`
		} `json:"message"`
	}
	if err := json.Unmarshal(receipt.Raw, &env); err != nil {
		t.Fatalf("FCM body decode (all-strings data contract): %v (%s)", err, receipt.Raw)
	}
	m := env.Message
	if m.Token != "integration-device-token" {
		t.Fatalf("message.token = %q", m.Token)
	}
	for k, want := range map[string]string{
		"vh_kind":      "notice",
		"vh_event":     "session_started",
		"vh_condition": "session_started",
		"vh_count":     "1",
	} {
		if got := m.Data[k]; got != want {
			t.Fatalf("data[%s] = %q, want %q", k, got, want)
		}
	}
	if ts := m.Data["vh_ts"]; len(ts) < 13 { // unix millis from the fire site
		t.Fatalf("vh_ts = %q, want unix-millis digits", ts)
	}
	if m.Android == nil {
		t.Fatal("missing android config")
	}
	if m.Android.Priority != "NORMAL" {
		t.Fatalf("android.priority = %q, want NORMAL (only waiting is HIGH)", m.Android.Priority)
	}
	if m.Android.CollapseKey != "session_started" {
		t.Fatalf("android.collapse_key = %q, want session_started", m.Android.CollapseKey)
	}
	if m.Android.TTL != "3600s" {
		t.Fatalf("android.ttl = %q, want 3600s (config ttl_sec)", m.Android.TTL)
	}
	if jsonHasNotificationBlock(receipt.Raw) {
		t.Fatalf("message must be data-only (no notification block): %s", receipt.Raw)
	}

	// --- history: the session_started notice is retained (pre-gating tap)
	// and carries the newly-running root's identity + title ---
	code, body = notifyHTTPGet(t, webSrv.URL+"/vh/notify/history")
	if code != http.StatusOK {
		t.Fatalf("GET /vh/notify/history: %d %s", code, body)
	}
	var hist struct {
		Events []struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionID"`
			Root      string `json:"root"`
			Title     string `json:"title"`
		} `json:"events"`
	}
	if err := json.Unmarshal(body, &hist); err != nil {
		t.Fatalf("history decode: %v (%s)", err, body)
	}
	found := false
	for _, ev := range hist.Events {
		if ev.Type == "session_started" {
			found = true
			if ev.SessionID != "sess-started-1" || ev.Root != "sess-started-1" {
				t.Fatalf("session_started history event drift: %+v", ev)
			}
			if ev.Title != "Kick off the release" {
				t.Fatalf("session_started title = %q, want the root's title", ev.Title)
			}
		}
	}
	if !found {
		t.Fatalf("history must retain the session_started notice: %s", body)
	}

	// --- delivery hygiene: exactly ONE FCM request (once-per-increase;
	// subsequent sweeps see an unchanged running set) ---
	time.Sleep(300 * time.Millisecond) // let any stray duplicate surface
	if got := fcm.requests(); got != 1 {
		t.Fatalf("FCM requests = %d, want exactly 1 (once per increase)", got)
	}
}
