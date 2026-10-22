package e2e

// notify_central_test.go — lane-3 e2e for the notify controller-hub S5:
// the PUBLIC CENTRAL HISTORY (GET /vh/notify/history) served from the
// central ledger over the REAL tunnel, plus the §9.7 rollout matrix as
// e2e-feasible:
//
//	New/New       → two enrolled workers, ONE controller registration
//	                surface: notices from BOTH merge into one history with
//	                unique central ids + per-worker attribution;
//	fence         → in controller mode the worker NEVER arms local FCM —
//	                zero requests to a worker-local OAuth mock while the
//	                notices flow to the central history;
//	restart       → controller restart mid-stream: the PUBLIC history
//	                survives with stable ids/lastId (S3 pinned the ledger;
//	                this pins the served surface);
//	New-ctrl /
//	Old-worker    → a legacy (nil-block) worker registers but stays
//	                notify-ineligible: its notices are absent from the
//	                public history, with no errors;
//	conformance   → the served JSON conforms to the v4 golden fixtures
//	                (pkg/server/testdata/notify_v4/history_response*.json)
//	                modulo the configured host pattern — ts as DECIMAL
//	                STRING, additive fields, label, per-worker attribution,
//	                ui_url query order, daemon-level shape, paging.
//
// (Old-ctrl/New-worker is a deploy-state row — an old controller binary —
// and is not in-process testable; §9.7 pins it as "unsupported".)

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/agent"
	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/server"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// centralGet fetches the PUBLIC central history (no-auth cluster: the
// /vh/notify/* family rides the session-cookie middleware, which on this
// posture is a no-op) and decodes it as a raw map — golden-style field
// traversal with exact-key assertions needs the raw shape, not a DTO.
func centralGet(t *testing.T, c *Cluster, query string) map[string]any {
	t.Helper()
	resp, err := http.Get(c.ControllerURL + "/vh/notify/history" + query)
	if err != nil {
		t.Fatalf("GET /vh/notify/history%s: %v", query, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read history body: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("GET /vh/notify/history%s: status %d (%s)", query, resp.StatusCode, b)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("history JSON: %v (%s)", err, b)
	}
	return m
}

// centralEvents returns the events array as raw maps.
func centralEvents(t *testing.T, m map[string]any) []map[string]any {
	t.Helper()
	raw, ok := m["events"].([]any)
	if !ok {
		t.Fatalf("events must be an array, got %T", m["events"])
	}
	out := make([]map[string]any, 0, len(raw))
	for i, e := range raw {
		obj, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("events[%d] must be an object, got %T", i, e)
		}
		out = append(out, obj)
	}
	return out
}

// centralStr/centralInt/centralObj are the strict getters (a missing or
// mistyped field fails with its golden name).
func centralStr(t *testing.T, ctx string, m map[string]any, key string) string {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("%s: missing required field %q", ctx, key)
	}
	s, ok := v.(string)
	if !ok {
		t.Fatalf("%s: field %q must be a string, got %T", ctx, key, v)
	}
	return s
}

func centralInt(t *testing.T, ctx string, m map[string]any, key string) int64 {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("%s: missing required field %q", ctx, key)
	}
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("%s: field %q must be a number, got %T", ctx, key, v)
	}
	return int64(f)
}

func centralObj(t *testing.T, ctx string, m map[string]any, key string) map[string]any {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("%s: missing required field %q", ctx, key)
	}
	obj, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("%s: field %q must be an object, got %T", ctx, key, v)
	}
	return obj
}

// assertCentralTs pins the v4 ts contract: a DECIMAL STRING of unix ms.
func assertCentralTs(t *testing.T, ctx, ts string) int64 {
	t.Helper()
	if ts == "" {
		t.Fatalf("%s: ts must be present", ctx)
	}
	n, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		t.Fatalf("%s: ts %q must be a decimal integer string", ctx, ts)
	}
	if n <= 0 {
		t.Fatalf("%s: ts %q must be unix ms", ctx, ts)
	}
	return n
}

// centralNotice appends one durable record with explicit session/project
// identity — the deterministic ui_url/label/ts assertions need the fields
// set (the shared appendToSpool helper leaves Root/Project empty).
func centralNotice(t *testing.T, eng *alerts.Engine, ts int64, typ, kind, session, project, title string) {
	t.Helper()
	if _, err := eng.Source().Append(alerts.Notice{
		Type: typ, Kind: kind, SessionID: session, Root: session, Project: project,
		Title: title, Detail: "central e2e record", Ts: ts,
	}, alerts.DetectionContext{Attended: true, IdleSec: 60, ProfileEligible: true}); err != nil {
		t.Fatalf("spool Append(%s): %v", session, err)
	}
}

// waitForSource polls the controller's source registry until sourceID is
// enrolled (the second worker's registration is asynchronous).
func waitForSource(t *testing.T, c *Cluster, sourceID string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range c.Daemon.DescribeNotifySources() {
			if e.SourceID == sourceID {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("source %s never enrolled", sourceID)
}

// bootSecondWorker builds a SECOND enrolled worker stack against the
// cluster's controller and dials the real tunnel with the registration
// secret — the automatic-enrollment path of §9.7 row New/New. The worker
// grounds its alerts state in its OWN VH_STATE_DIR (flipped for the
// construction window only: one spool file per state dir, so a shared dir
// would fuse the two workers' (epoch, seq) spaces and break attribution).
func bootSecondWorker(t *testing.T, c *Cluster, workerID, workerName string) *alerts.Engine {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	prev := os.Getenv("VH_STATE_DIR")
	if err := os.Setenv("VH_STATE_DIR", filepath.Join(t.TempDir(), "vh-state-2")); err != nil {
		t.Fatal(err)
	}
	agg := aggregator.New(c.fakeSrv.URL, ringCap)
	go agg.Run(ctx)
	wsrv, err := web.NewServer(agg, c.fakeSrv.URL, ringCap)
	if err != nil {
		t.Fatalf("second worker web server: %v", err)
	}
	eng, aerr := wsrv.InitAlerts(ctx, web.AlertsOptions{
		ControllerURL: "ws://" + c.DaemonAddr + "/vh-solara/ws",
		WorkerID:      workerID,
		WorkerName:    workerName,
	})
	if err := os.Setenv("VH_STATE_DIR", prev); err != nil {
		t.Fatal(err)
	}
	if aerr != nil {
		t.Fatalf("second worker InitAlerts: %v", aerr)
	}
	wsrv.EnableInternalNotify(eng, web.NewInternalNotifyToken(), true)
	srv := httptest.NewServer(wsrv.Handler())
	t.Cleanup(func() {
		shutdownCtx, sc := context.WithTimeout(context.Background(), 5*time.Second)
		_ = wsrv.Shutdown(shutdownCtx)
		sc()
		srv.Close()
	})
	port, err := portOf(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	ag := agent.NewDaemon("ws://"+c.DaemonAddr+"/vh-solara/ws", workerID, workerName, "test",
		map[string]string{"X-VH-Worker-Secret": "e2e-reg-secret"}, agent.NewProxy(port))
	ag.SetNotifyEnroll(wsrv.NotifyEnrollment)
	go ag.Start()
	return eng
}

// --- §9.7 New/New: two enrolled workers, one merged central history ------------

// TestNotifyCentralHistoryTwoWorkersMerge is the S5 rollout crux: ONE
// controller hub, TWO enrolled workers (the second registers through the
// normal authenticated tunnel — automatic enrollment, no controller-side
// manual step): notices from BOTH merge into one public history with
// unique contiguous central ids and per-worker attribution (id, name, and
// each worker's OWN epoch; per-source seq spaces restart at 1).
func TestNotifyCentralHistoryTwoWorkersMerge(t *testing.T) {
	c := startNotifyIngestCluster(t)
	en1 := waitEnrolled(t, c)
	waitEnrolled(t, c) // stability: worker-1 fully caught up before worker-2 joins

	eng2 := bootSecondWorker(t, c, "worker-e2e-2", "worker-two")
	waitForSource(t, c, "worker-e2e-2")

	now := time.Now().UnixMilli()
	centralNotice(t, c.AlertsEngine, now, alerts.TypeWaiting, alerts.KindPermission, "ses-w1-a", "/w/one", "Review A")
	centralNotice(t, c.AlertsEngine, now+1, alerts.TypeWaiting, alerts.KindQuestion, "ses-w1-b", "/w/one", "Review B")
	waitLedger(t, c, "worker-1 events committed", func() bool { return c.Daemon.NotifyLedgerHead() == 2 })

	centralNotice(t, eng2, now+2, alerts.TypeWaiting, alerts.KindPermission, "ses-w2-a", "/w/two", "Review C")
	centralNotice(t, eng2, now+3, alerts.TypeSessionStarted, "", "ses-w2-b", "/w/two", "Fix login")
	waitLedger(t, c, "worker-2 events committed", func() bool { return c.Daemon.NotifyLedgerHead() == 4 })

	hist := centralGet(t, c, "?limit=50")
	evs := centralEvents(t, hist)
	if len(evs) != 4 {
		t.Fatalf("merged history has %d events, want 4: %+v", len(evs), evs)
	}
	if got := centralInt(t, "history", hist, "lastId"); got != 4 {
		t.Fatalf("lastId = %d, want the committed head 4", got)
	}

	type want struct {
		id                    int64
		worker, name, session string
	}
	wants := []want{
		{1, c.WorkerID, "worker", "ses-w1-a"},
		{2, c.WorkerID, "worker", "ses-w1-b"},
		{3, "worker-e2e-2", "worker-two", "ses-w2-a"},
		{4, "worker-e2e-2", "worker-two", "ses-w2-b"},
	}
	epochs := map[string]string{c.WorkerID: en1.Epoch, "worker-e2e-2": ""}
	for i, w := range wants {
		ctx := fmt.Sprintf("event %d", i)
		ev := evs[i]
		if got := centralInt(t, ctx, ev, "id"); got != w.id {
			t.Fatalf("%s: id = %d, want %d (unique contiguous central ids across the merge)", ctx, got, w.id)
		}
		wobj := centralObj(t, ctx, ev, "worker")
		if got := centralStr(t, ctx, wobj, "id"); got != w.worker {
			t.Fatalf("%s: worker.id = %q, want %q", ctx, got, w.worker)
		}
		if got := centralStr(t, ctx, wobj, "name"); got != w.name {
			t.Fatalf("%s: worker.name = %q, want %q", ctx, got, w.name)
		}
		if got := centralStr(t, ctx, ev, "sessionID"); got != w.session {
			t.Fatalf("%s: sessionID = %q, want %q", ctx, got, w.session)
		}
		label := centralStr(t, ctx, ev, "label")
		if want := w.name + " — " + centralStr(t, ctx, ev, "title"); label != want {
			t.Fatalf("%s: label = %q, want %q", ctx, label, want)
		}
		src := centralObj(t, ctx, ev, "source")
		epoch := centralStr(t, ctx, src, "epoch")
		if epoch == "" {
			t.Fatalf("%s: source.epoch must carry the worker's OWN epoch", ctx)
		}
		if w.worker == c.WorkerID && epoch != en1.Epoch {
			t.Fatalf("%s: worker-1 epoch = %q, want the enrolled %q", ctx, epoch, en1.Epoch)
		}
		if prev := epochs["worker-e2e-2"]; w.worker == "worker-e2e-2" {
			if prev != "" && epoch != prev {
				t.Fatalf("%s: worker-2 epoch drifted: %q vs %q", ctx, epoch, prev)
			}
			epochs["worker-e2e-2"] = epoch
		}
		if en1.Epoch == epoch && w.worker != c.WorkerID {
			t.Fatalf("%s: the two workers must carry DIFFERENT epochs (got the same %q)", ctx, epoch)
		}
		assertCentralTs(t, ctx, centralStr(t, ctx, ev, "ts"))
	}

	// Per-source seq spaces restart at 1 (worker-2's first event is seq 1
	// even though the central stream is at id 3).
	src2 := centralObj(t, "event 2", evs[2], "source")
	if got := centralInt(t, "event 2 source", src2, "seq"); got != 1 {
		t.Fatalf("worker-2's first committed event carries source seq %d, want 1", got)
	}

	// Both workers fully covered: one complete merged history.
	cov := centralObj(t, "history", hist, "coverage")
	if comp, _ := cov["complete"].(bool); !comp {
		t.Fatalf("coverage of two fully-pulled workers must be complete: %+v", cov)
	}
}

// --- §9.7 fence: zero worker-local FCM while notices flow centrally ------------

// TestNotifyCentralHistoryWorkerLocalFCMFenced pins the S1 fence at the
// PUBLIC-HISTORY level: the worker's alerts.jsonc carries loadable FCM
// credentials whose token_uri points at a LOCAL mock, yet in controller
// mode InitAlerts attaches NO sender — zero requests ever reach the mock
// while the same notices land in the central history through the tunnel.
func TestNotifyCentralHistoryWorkerLocalFCMFenced(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "vh-state")
	t.Setenv("VH_STATE_DIR", stateDir)

	var hits atomic.Int32
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"never","expires_in":3600,"token_type":"Bearer"}`))
	}))
	t.Cleanup(tokenSrv.Close)

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	creds, _ := json.Marshal(map[string]string{
		"type":         "service_account",
		"project_id":   "proj-worker-local",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "bot@proj-worker-local.iam.gserviceaccount.com",
		"token_uri":    tokenSrv.URL,
	})
	credsPath := filepath.Join(t.TempDir(), "fcm-creds.json")
	if err := os.WriteFile(credsPath, creds, 0o600); err != nil {
		t.Fatal(err)
	}
	// Pre-write the alerts config so InitAlerts finds a CONFIGURED channel
	// (the fence's premise: credentials exist and load — only the fence can
	// stop the sender).
	cfg, _ := json.Marshal(map[string]any{
		"channels": []any{}, "profiles": []any{}, "active_profile": "",
		"detect": map[string]any{},
		"notify": map[string]any{"credentials_file": credsPath, "project_id": "proj-worker-local"},
	})
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "alerts.jsonc"), cfg, 0o600); err != nil {
		t.Fatal(err)
	}

	c, err := StartClusterWithOptions(
		WithNotifyEnrollment(),
		WithHostPattern("$ID.localhost"),
		WithRegSecret("e2e-reg-secret"),
		WithNotifyStore(filepath.Join(t.TempDir(), "notify-store.json")),
		WithNotifyIngest(ingestPollInterval),
	)
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	t.Cleanup(c.Close)

	waitEnrolled(t, c)
	if c.AlertsEngine.Notifier() != nil || c.AlertsEngine.NotifyReady() {
		t.Fatal("controller mode: the worker must never arm a local FCM sender")
	}

	centralNotice(t, c.AlertsEngine, time.Now().UnixMilli(), alerts.TypeWaiting, alerts.KindPermission, "ses-fenced", "/w/one", "Review")
	waitLedger(t, c, "fenced worker notice committed centrally", func() bool { return c.Daemon.NotifyLedgerHead() == 1 })

	hist := centralGet(t, c, "?limit=10")
	evs := centralEvents(t, hist)
	if len(evs) != 1 || centralStr(t, "event 0", evs[0], "sessionID") != "ses-fenced" {
		t.Fatalf("the fenced worker's notice must still reach the central history: %+v", evs)
	}

	if n := hits.Load(); n != 0 {
		t.Fatalf("worker-local FCM made %d token-endpoint requests while fenced (must be ZERO)", n)
	}
}

// --- §9.7 restart: the PUBLIC history survives with stable ids/lastId ----------

// TestNotifyCentralHistorySurvivesControllerRestart pins the served
// surface across a controller restart mid-stream: the public history's
// ids, lastId, and rendered events are IDENTICAL after the journal
// replays, and the stream continues without dupes or skips.
func TestNotifyCentralHistorySurvivesControllerRestart(t *testing.T) {
	c := startNotifyIngestCluster(t)
	waitEnrolled(t, c)

	now := time.Now().UnixMilli()
	centralNotice(t, c.AlertsEngine, now, alerts.TypeWaiting, alerts.KindPermission, "ses-r1", "/w/one", "Review 1")
	centralNotice(t, c.AlertsEngine, now+1, alerts.TypeWaiting, alerts.KindPermission, "ses-r2", "/w/one", "Review 2")
	centralNotice(t, c.AlertsEngine, now+2, alerts.TypeWaiting, alerts.KindPermission, "ses-r3", "/w/one", "Review 3")
	waitLedger(t, c, "3 events committed", func() bool { return c.Daemon.NotifyLedgerHead() == 3 })

	before := centralGet(t, c, "?limit=50")

	c.Daemon.StopNotifyIngest()
	if err := c.Daemon.LoadNotifyStore(c.NotifyStorePath); err != nil {
		t.Fatalf("controller re-load: %v", err)
	}
	if err := c.Daemon.StartNotifyIngest(server.NotifyIngestConfig{PollInterval: ingestPollInterval}); err != nil {
		t.Fatalf("restart ingest: %v", err)
	}

	after := centralGet(t, c, "?limit=50")
	if got := centralInt(t, "history", after, "lastId"); got != 3 {
		t.Fatalf("lastId after restart = %d, want the stable 3", got)
	}
	bEvs, aEvs := centralEvents(t, before), centralEvents(t, after)
	if len(aEvs) != 3 || len(bEvs) != 3 {
		t.Fatalf("events before/after restart = %d/%d, want 3/3", len(bEvs), len(aEvs))
	}
	for i := range bEvs {
		bj, _ := json.Marshal(bEvs[i])
		aj, _ := json.Marshal(aEvs[i])
		if string(bj) != string(aj) {
			t.Fatalf("event %d changed across the restart:\n before %s\n after  %s", i, bj, aj)
		}
	}

	// The stream continues: ids 4..5, no dupes, no skips.
	centralNotice(t, c.AlertsEngine, now+3, alerts.TypeWaiting, alerts.KindPermission, "ses-r4", "/w/one", "Review 4")
	centralNotice(t, c.AlertsEngine, now+4, alerts.TypeWaiting, alerts.KindPermission, "ses-r5", "/w/one", "Review 5")
	waitLedger(t, c, "resume to 5 events", func() bool { return c.Daemon.NotifyLedgerHead() == 5 })

	resumed := centralGet(t, c, "?limit=50")
	if got := centralInt(t, "history", resumed, "lastId"); got != 5 {
		t.Fatalf("lastId after resume = %d, want 5", got)
	}
	rEvs := centralEvents(t, resumed)
	for i, ev := range rEvs {
		if got := centralInt(t, "resumed", ev, "id"); got != int64(i+1) {
			t.Fatalf("resumed stream id %d at position %d — ids must stay contiguous 1..5", got, i)
		}
	}
}

// --- §9.7 New-ctrl/Old-worker: the legacy worker stays notify-ineligible -------

// TestNotifyCentralHistoryLegacyWorkerIneligible pins the mixed-version
// row at the PUBLIC-HISTORY level: a legacy worker (authenticated
// registration WITHOUT a notify block) registers and serves its tunnel
// normally, but never becomes a notify source — its notices are absent
// from the public history and the route serves the empty posture without
// errors.
func TestNotifyCentralHistoryLegacyWorkerIneligible(t *testing.T) {
	t.Setenv("VH_STATE_DIR", filepath.Join(t.TempDir(), "vh-state"))
	c, err := StartClusterWithOptions(
		WithHostPattern("$ID.localhost"),
		WithRegSecret("e2e-reg-secret"),
		WithNotifyStore(filepath.Join(t.TempDir(), "notify-store.json")),
		WithNotifyIngest(ingestPollInterval),
		// NO WithNotifyEnrollment: the worker carries no notify block —
		// the §9.7 legacy posture.
	)
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	t.Cleanup(c.Close)

	// The worker IS registered and online (the tunnel itself is healthy).
	w, ok := c.Daemon.Registry.GetWorker(c.WorkerID)
	if !ok || w == nil {
		t.Fatal("the legacy worker must register normally")
	}

	// But it never becomes a notify source.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(c.Daemon.DescribeNotifySources()) != 0 {
			t.Fatalf("a nil-block worker must stay notify-ineligible, got sources: %+v", c.Daemon.DescribeNotifySources())
		}
		time.Sleep(50 * time.Millisecond)
	}

	hist := centralGet(t, c, "?limit=50")
	if evs := centralEvents(t, hist); len(evs) != 0 {
		t.Fatalf("legacy worker history must be empty, got %+v", evs)
	}
	if got := centralInt(t, "history", hist, "lastId"); got != 0 {
		t.Fatalf("lastId = %d, want 0", got)
	}
	cov := centralObj(t, "history", hist, "coverage")
	if comp, _ := cov["complete"].(bool); !comp {
		t.Fatalf("empty history must report complete coverage: %+v", cov)
	}
}

// --- §9.7 conformance: the served history matches the v4 golden fixtures -------

// TestNotifyCentralHistoryGoldenConformance pins the SERVED output shape
// against the golden fixtures' contract (the S0-review "served-output
// conformance" defer, closed over the REAL tunnel): exactly three
// top-level keys {events,lastId,coverage}; every event carries the v4
// base+additive fields with ts as DECIMAL STRING; ui_url follows the
// golden session-first query order; the daemon-level event renders the
// stalled/OpenCode/empty-session/bare-/app shape; paging behaves v3-
// identically (since>0 ascending, default newest-limit ascending).
func TestNotifyCentralHistoryGoldenConformance(t *testing.T) {
	c := startNotifyIngestCluster(t)
	waitEnrolled(t, c)

	now := time.Now().UnixMilli()
	centralNotice(t, c.AlertsEngine, now, alerts.TypeWaiting, alerts.KindQuestion, "ses-gold-q", "/home/op/repo-alpha", "Review requested")
	centralNotice(t, c.AlertsEngine, now+10, alerts.TypeSessionStarted, "", "ses-gold-s", "/home/op/repo-beta", "Fix login")
	centralNotice(t, c.AlertsEngine, now+20, alerts.TypeFinished, "", "ses-gold-q", "/home/op/repo-alpha", "Review requested")
	c.AlertsEngine.EmitDaemonNotice("opencode serve pid 9 exited (signal TERM/15)")
	waitLedger(t, c, "4 golden-shape events committed", func() bool { return c.Daemon.NotifyLedgerHead() == 4 })

	hist := centralGet(t, c, "?limit=50")
	for _, k := range []string{"events", "lastId", "coverage"} {
		if _, ok := hist[k]; !ok {
			t.Fatalf("missing top-level key %q (exactly events/lastId/coverage)", k)
		}
	}
	if len(hist) != 3 {
		keys := make([]string, 0, len(hist))
		for k := range hist {
			keys = append(keys, k)
		}
		t.Fatalf("top-level keys = %v, want exactly [events lastId coverage]", keys)
	}
	if got := centralInt(t, "history", hist, "lastId"); got != 4 {
		t.Fatalf("lastId = %d, want 4", got)
	}

	evs := centralEvents(t, hist)
	if len(evs) != 4 {
		t.Fatalf("served %d events, want 4", len(evs))
	}

	base := "https://" + c.WorkerID + ".localhost/app"
	dirAlpha := url.QueryEscape("/home/op/repo-alpha")
	type gold struct {
		typ, kind, session, title, ui string
		ts                            int64
	}
	golds := []gold{
		{"waiting", "question_pending", "ses-gold-q", "Review requested", base + "?session=ses-gold-q&dir=" + dirAlpha, now},
		{"session_started", "session_started", "ses-gold-s", "Fix login", base + "?session=ses-gold-s&dir=" + url.QueryEscape("/home/op/repo-beta"), now + 10},
		{"finished", "session_unread", "ses-gold-q", "Review requested", base + "?session=ses-gold-q&dir=" + dirAlpha, now + 20},
		{"stalled", "worker_down", "", "OpenCode", base, 0}, // daemon-level: EmitDaemonNotice stamps its own ts
	}
	for i, g := range golds {
		ctx := fmt.Sprintf("event %d", i)
		ev := evs[i]
		if got := centralInt(t, ctx, ev, "id"); got != int64(i+1) {
			t.Fatalf("%s: id = %d, want %d", ctx, got, i+1)
		}
		for _, k := range []string{"type", "sessionID", "root", "project", "title", "detail", "ts", "kind", "count", "label", "worker", "source"} {
			if _, ok := ev[k]; !ok {
				t.Fatalf("%s: missing v4 event field %q", ctx, k)
			}
		}
		if got := centralStr(t, ctx, ev, "type"); got != g.typ {
			t.Fatalf("%s: type = %q, want %q", ctx, got, g.typ)
		}
		if got := centralStr(t, ctx, ev, "kind"); got != g.kind {
			t.Fatalf("%s: kind = %q, want %q", ctx, got, g.kind)
		}
		if got := centralStr(t, ctx, ev, "sessionID"); got != g.session {
			t.Fatalf("%s: sessionID = %q, want %q", ctx, got, g.session)
		}
		if got := centralStr(t, ctx, ev, "title"); got != g.title {
			t.Fatalf("%s: title = %q, want %q", ctx, got, g.title)
		}
		if got := centralInt(t, ctx, ev, "count"); got != 1 {
			t.Fatalf("%s: count = %d, want 1", ctx, got)
		}
		ts := assertCentralTs(t, ctx, centralStr(t, ctx, ev, "ts"))
		if g.ts != 0 && ts != g.ts {
			t.Fatalf("%s: ts = %d, want the spool-stamped %d", ctx, ts, g.ts)
		}
		if got := centralStr(t, ctx, ev, "label"); got != "worker — "+g.title {
			t.Fatalf("%s: label = %q, want %q", ctx, got, "worker — "+g.title)
		}
		w := centralObj(t, ctx, ev, "worker")
		if got := centralStr(t, ctx, w, "id"); got != c.WorkerID {
			t.Fatalf("%s: worker.id = %q", ctx, got)
		}
		if got := centralStr(t, ctx, w, "name"); got != "worker" {
			t.Fatalf("%s: worker.name = %q", ctx, got)
		}
		src := centralObj(t, ctx, ev, "source")
		assertCentralTs(t, ctx, strconv.FormatInt(centralInt(t, ctx, src, "seq"), 10))
		if got := centralStr(t, ctx, ev, "ui_url"); got != g.ui {
			t.Fatalf("%s: ui_url = %q, want the golden-ordered %q", ctx, got, g.ui)
		}
	}

	// The daemon-level event's empty-session shape (golden: stalled +
	// title OpenCode + empty sessionID/root/project + bare /app).
	daemon := evs[3]
	for _, k := range []string{"sessionID", "root", "project"} {
		if got := centralStr(t, "daemon event", daemon, k); got != "" {
			t.Fatalf("daemon-level event %s = %q, want empty", k, got)
		}
	}

	// Paging (v3-identical): since=2&limit=2 → ascending ids 3..4.
	paged := centralGet(t, c, "?since=2&limit=2")
	pevs := centralEvents(t, paged)
	if len(pevs) != 2 || centralInt(t, "paged 0", pevs[0], "id") != 3 || centralInt(t, "paged 1", pevs[1], "id") != 4 {
		t.Fatalf("since=2&limit=2 must serve ascending ids 3..4, got %+v", pevs)
	}
	if got := centralInt(t, "paged", paged, "lastId"); got != 4 {
		t.Fatalf("paged lastId = %d, want the committed head 4", got)
	}

	// The history route is the PUBLIC family: no CSRF token needed on GET
	// (regression guard for the family posture).
	if _, ok := centralGet(t, c, "?limit=1")["events"]; !ok {
		t.Fatal("bare GET without CSRF must serve history")
	}
}
