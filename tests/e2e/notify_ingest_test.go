package e2e

// notify_ingest_test.go — lane-3 e2e for the notify controller-hub S3: the
// controller PULL LOOP + central transactional ledger, over the REAL
// controller daemon + REAL worker agent + actual yamux tunnel
// (StartCluster), with a file-backed notify store (WithNotifyStore) so the
// ledger journal and the enrolled-sources anchor are durable.
//
// Proven here, end to end:
//   1. the spine: worker spool append → pull loop fetch → ATOMIC ledger
//      commit (event+cursor+dedupe+gap as one journal line) → worker ACK —
//      observed through the ledger read API and the worker spool's
//      AckedSeq;
//   2. worker restart mid-stream: the replacement worker (fresh token,
//      same persisted epoch/seq space) is caught up from the COMMITTED
//      cursor — no dupes, no skips;
//   3. controller restart mid-stream: StopNotifyIngest + re-LoadNotifyStore
//      (journal replay) + restart resumes from the committed cursor with a
//      non-regressing head — no dupes, no skips.
//
// Partial-page FAILURE INJECTION is deliberately NOT here: there is no
// worker-side seam to sabotage a page mid-body without touching production
// code paths (the S2 empty-page cursor race already has the deterministic
// HTTP-boundary test, pkg/web TestInternalNotifyFeedEmptyPage-
// NeverSkipsDurableAppend), so commit-or-nothing + retry-from-old-cursor is
// pinned at unit level (pkg/server TestNotifyIngestCommitFailure-
// RetriesFromOldCursor + the notify_ledger_test.go crash matrix).

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/agent"
	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/server"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

const ingestPollInterval = 50 * time.Millisecond

// startNotifyIngestCluster boots the full S3 posture: the S2 worker arming
// (startNotifyCluster's shape) PLUS the controller's file-backed notify
// store (durable ledger) and the running pull loop.
func startNotifyIngestCluster(t *testing.T) *Cluster {
	t.Helper()
	t.Setenv("VH_STATE_DIR", filepath.Join(t.TempDir(), "vh-state"))
	storePath := filepath.Join(t.TempDir(), "notify-store.json")
	c, err := StartClusterWithOptions(
		WithNotifyEnrollment(),
		WithHostPattern("$ID.localhost"),
		WithRegSecret("e2e-reg-secret"),
		WithNotifyStore(storePath),
		WithNotifyIngest(ingestPollInterval),
	)
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	t.Cleanup(c.Close)
	if c.NotifyStorePath == "" {
		t.Fatal("harness must arm the file-backed notify store")
	}
	return c
}

// appendToSpool appends n waiting/permission records to an engine's spool.
func appendToSpool(t *testing.T, eng *alerts.Engine, n int, firstSession int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := eng.Source().Append(alerts.Notice{
			Type:      alerts.TypeWaiting,
			Kind:      alerts.KindPermission,
			SessionID: fmt.Sprintf("ses-%d", firstSession+i),
			Title:     "Review requested",
			Detail:    "ingest e2e record",
			Ts:        time.Now().UnixMilli(),
		}, alerts.DetectionContext{Attended: true, IdleSec: 60, ProfileEligible: true}); err != nil {
			t.Fatalf("spool Append %d: %v", firstSession+i, err)
		}
	}
}

// waitLedger polls the controller's ledger read API until cond passes.
func waitLedger(t *testing.T, c *Cluster, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("ledger never reached: %s", what)
}

// assertMergedStream pins the merged-stream shape: contiguous ids from 1,
// matching source seqs ascending under the enrolled epoch, worker
// attribution, and the §9.1 condition.
func assertMergedStream(t *testing.T, c *Cluster, epoch string, wantN int) {
	t.Helper()
	evs := c.Daemon.NotifyEventsSince(0, 500)
	if len(evs) != wantN {
		t.Fatalf("merged stream has %d events, want %d: %+v", len(evs), wantN, evs)
	}
	for i, ev := range evs {
		if ev.ID != int64(i+1) {
			t.Fatalf("event %d has id %d — ids must be contiguous 1..N in commit order", i, ev.ID)
		}
		if ev.Seq != int64(i+1) {
			t.Fatalf("event id %d carries source seq %d — no dupes, no skips", ev.ID, ev.Seq)
		}
		if ev.Epoch != epoch {
			t.Fatalf("event %d epoch %q != enrolled %q", ev.ID, ev.Epoch, epoch)
		}
		if ev.WorkerID != c.WorkerID || ev.WorkerName == "" {
			t.Fatalf("event %d worker attribution: %+v", ev.ID, ev)
		}
		if ev.Kind != "permission_pending" || ev.Type != alerts.TypeWaiting {
			t.Fatalf("event %d condition mapping: kind=%q type=%q", ev.ID, ev.Kind, ev.Type)
		}
	}
}

// --- 1: the spine — worker notice → ledger commit → ACK ----------------------

func TestNotifyIngestEndToEndOverRealTunnel(t *testing.T) {
	c := startNotifyIngestCluster(t)
	en := waitEnrolled(t, c)

	// Worker emits 5 durable notices (the spool's seq space 1..5).
	appendToSpool(t, c.AlertsEngine, 5, 0)

	// The pull loop ingests them: one central event per source record,
	// ids 1..5 in commit order, full §3.1 shape.
	waitLedger(t, c, "5 ingested events", func() bool {
		return c.Daemon.NotifyLedgerHead() == 5
	})
	assertMergedStream(t, c, en.Epoch, 5)

	// Cursor + coverage: the committed cursor is 5 and the source is
	// complete (no worker-side loss observed).
	epoch, cursor, _, ok := c.Daemon.NotifySourceCursor(c.WorkerID)
	if !ok || epoch != en.Epoch || cursor != 5 {
		t.Fatalf("ledger cursor: epoch=%q cursor=%d ok=%v", epoch, cursor, ok)
	}
	if !c.Daemon.NotifyCoverage().Complete {
		t.Fatal("a fully-covered source must report complete coverage")
	}

	// Commit-then-ACK reached the WORKER over the real tunnel: the spool's
	// accepted watermark advanced to the committed cursor, and the LEDGER
	// recorded that acceptance (read AFTER the wait — the loop ACKs
	// incrementally as pages commit).
	waitLedger(t, c, "worker ACK 5", func() bool {
		return c.AlertsEngine.Source().AckedSeq() == 5
	})
	if _, cursor, acked, ok := c.Daemon.NotifySourceCursor(c.WorkerID); !ok || cursor != 5 || acked != 5 {
		t.Fatalf("ledger cursor/ack: cursor=%d acked=%d ok=%v", cursor, acked, ok)
	}

	// The worker trimmed the confirmed prefix (lazy trim driven by the
	// durable watermark — brief §2 step 5).
	waitLedger(t, c, "worker trim", func() bool {
		return c.AlertsEngine.Source().FirstSeq() > 1
	})

	// Secret hygiene: the journal NEVER carries the feed token.
	raw, err := os.ReadFile(c.NotifyStorePath + ".ledger")
	if err != nil {
		t.Fatalf("read ledger journal: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("ledger journal must exist with committed records")
	}
	if strings.Contains(string(raw), c.NotifyToken) {
		t.Fatal("ledger journal must not carry the feed token")
	}
	for _, secret := range []string{"e2e-reg-secret"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("ledger journal must not carry secrets (found %q)", secret)
		}
	}

	// More emissions stream incrementally (the loop keeps pulling).
	appendToSpool(t, c.AlertsEngine, 2, 5)
	waitLedger(t, c, "7 ingested events", func() bool {
		return c.Daemon.NotifyLedgerHead() == 7
	})
	assertMergedStream(t, c, en.Epoch, 7)
}

// --- 2: worker restart mid-stream + catch-up ----------------------------------

func TestNotifyIngestWorkerRestartCatchUp(t *testing.T) {
	c := startNotifyIngestCluster(t)
	en := waitEnrolled(t, c)
	appendToSpool(t, c.AlertsEngine, 3, 0)
	waitLedger(t, c, "3 ingested events", func() bool { return c.Daemon.NotifyLedgerHead() == 3 })
	waitLedger(t, c, "worker ACK 3", func() bool { return c.AlertsEngine.Source().AckedSeq() == 3 })

	// Kill the worker. The agent has no public stop; the sanctioned
	// teardown is its OWN self-cancel path (pkg/agent daemon.go): with
	// HealthCheck returning false and the local web port dead, the next
	// raw-proxy dial failure cancels the agent's reconnect context. Drive
	// that dial deterministically with one direct tunnel fetch, then close
	// the tunnel from the controller side — exactly what the WS-close
	// handler does when a worker process dies (MarkWorkerOffline) — so the
	// cancelled agent's accept loop unblocks and exits WITHOUT reconnecting.
	if c.agent == nil {
		t.Fatal("harness must expose the worker agent for the restart scenario")
	}
	c.agent.HealthCheck = func() bool { return false }
	c.workerSrv.Close()
	w, wok := c.Daemon.Registry.GetWorker(c.WorkerID)
	if !wok {
		t.Fatal("worker must be registered before the kill")
	}
	_, _ = c.Daemon.Proxy.FetchNotifyFeedPage(context.Background(), w, c.NotifyToken, 0, 1, 5*time.Second, 1<<20)
	c.Daemon.Registry.MarkWorkerOffline(c.WorkerID)

	// Wait for the offline state (the tunnel is closed; the replacement
	// may now register — the duplicate-online rejection only bars ONLINE
	// duplicates).
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if tr, _ := c.Daemon.Registry.WorkerTransport(c.WorkerID); tr == nil {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if tr, _ := c.Daemon.Registry.WorkerTransport(c.WorkerID); tr != nil {
		t.Fatal("old worker must be offline before the replacement registers (duplicate-online rejection)")
	}

	// Downtime activity: the REPLACEMENT worker stack — same VH_STATE_DIR
	// (the spool persists: same epoch, seq space continues), fresh token
	// (every worker process mints one) — accumulates 3 records the
	// controller cannot reach yet.
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	agg := aggregator.New(c.fakeSrv.URL, ringCap)
	go agg.Run(ctx)
	wsrv2, err := web.NewServer(agg, c.fakeSrv.URL, ringCap)
	if err != nil {
		t.Fatalf("replacement web server: %v", err)
	}
	eng2, aerr := wsrv2.InitAlerts(ctx, web.AlertsOptions{
		ControllerURL: "ws://" + c.DaemonAddr + "/vh-solara/ws",
		WorkerID:      c.WorkerID,
		WorkerName:    "worker",
	})
	if aerr != nil {
		t.Fatalf("replacement InitAlerts: %v", aerr)
	}
	newToken := "replacement-token-0123456789abcdef"
	wsrv2.EnableInternalNotify(eng2, newToken, true)
	workerSrv2 := httptest.NewServer(wsrv2.Handler())
	t.Cleanup(func() {
		shutdownCtx, sc := context.WithTimeout(context.Background(), 5*time.Second)
		_ = wsrv2.Shutdown(shutdownCtx)
		sc()
		workerSrv2.Close()
	})
	port2, err := portOf(workerSrv2.URL)
	if err != nil {
		t.Fatal(err)
	}
	if got := eng2.Source().Epoch(); got != en.Epoch {
		t.Fatalf("replacement spool epoch %q != original %q (ordinary restart must not rotate)", got, en.Epoch)
	}
	appendToSpool(t, eng2, 3, 3) // seqs 4..6 while unreachable

	// The replacement agent registers (fresh token, same identity); the
	// controller's F7 freshness path must pull with the NEW credentials
	// from the COMMITTED cursor 3 — catching up 4..6, no dupes, no skips.
	ag2 := agent.NewDaemon("ws://"+c.DaemonAddr+"/vh-solara/ws", c.WorkerID, "worker", "test",
		map[string]string{"X-VH-Worker-Secret": "e2e-reg-secret"}, agent.NewProxy(port2))
	ag2.SetNotifyEnroll(wsrv2.NotifyEnrollment)
	go ag2.Start()
	c.agent = ag2

	waitLedger(t, c, "catch-up to 6 events", func() bool { return c.Daemon.NotifyLedgerHead() == 6 })
	assertMergedStream(t, c, en.Epoch, 6)
	waitLedger(t, c, "replacement worker ACK 6", func() bool {
		return eng2.Source().AckedSeq() == 6
	})
	if _, cursor, _, ok := c.Daemon.NotifySourceCursor(c.WorkerID); !ok || cursor != 6 {
		t.Fatal("cursor must be 6 after catch-up")
	}
}

// --- 3: controller restart mid-stream ------------------------------------------

func TestNotifyIngestControllerRestartResumesFromCommittedCursor(t *testing.T) {
	c := startNotifyIngestCluster(t)
	en := waitEnrolled(t, c)
	appendToSpool(t, c.AlertsEngine, 4, 0)
	waitLedger(t, c, "4 ingested events", func() bool { return c.Daemon.NotifyLedgerHead() == 4 })

	// Controller restart: stop the loop, re-load the durable stores (the
	// journal replays; the enrolled-sources anchor reloads), restart. The
	// committed head must SURVIVE exactly — never regress, never restart
	// at 1.
	c.Daemon.StopNotifyIngest()
	if err := c.Daemon.LoadNotifyStore(c.NotifyStorePath); err != nil {
		t.Fatalf("controller re-load: %v", err)
	}
	if got := c.Daemon.NotifyLedgerHead(); got != 4 {
		t.Fatalf("head after controller restart = %d, want 4 (committed head survives)", got)
	}
	if got := len(c.Daemon.NotifyEventsSince(0, 500)); got != 4 {
		t.Fatalf("retained events after restart = %d, want 4", got)
	}
	if err := c.Daemon.StartNotifyIngest(server.NotifyIngestConfig{PollInterval: ingestPollInterval}); err != nil {
		t.Fatalf("restart ingest: %v", err)
	}

	// The worker kept emitting during the controller downtime.
	appendToSpool(t, c.AlertsEngine, 3, 4) // seqs 5..7

	// Resume: no dupes (the cursor was committed, dedupe replays absorbed),
	// no skips (the cursor never advanced past the commit).
	waitLedger(t, c, "resume to 7 events", func() bool { return c.Daemon.NotifyLedgerHead() == 7 })
	assertMergedStream(t, c, en.Epoch, 7)
	waitLedger(t, c, "worker ACK 7", func() bool { return c.AlertsEngine.Source().AckedSeq() == 7 })
	if _, cursor, acked, ok := c.Daemon.NotifySourceCursor(c.WorkerID); !ok || cursor != 7 || acked != 7 {
		t.Fatalf("post-restart cursor/ack: cursor=%d acked=%d ok=%v", cursor, acked, ok)
	}
}
