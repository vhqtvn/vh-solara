package server

// notify_ingest_test.go — lane-1 co-located tests for the controller pull
// loop (notify controller-hub S3; see notify_ingest.go). The transport is
// a scripted fake (the REAL tunnel path is lane 3,
// tests/e2e/notify_ingest_test.go); these tests pin the loop's own
// semantics:
//
//   - commit-then-ACK ordering (the ACK fires only against committed state);
//   - epoch reconciliation (F6): reset + open-end gap + re-pull from the
//     new epoch's head, never a mixed-epoch commit;
//   - overflow gap (worker prefix loss) recording;
//   - ineligible sources are never fetched;
//   - dead-source backoff + the fresh-credentials reset (F7);
//   - commit failure ⇒ commit-or-nothing ⇒ retry from the OLD cursor with
//     no duplicates and no skips;
//   - offline workers are skipped without backoff;
//   - the §9.1 notice-type→condition mapping at ingest.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// --- fakes ------------------------------------------------------------------

// fakePageResp is one scripted feed answer.
type fakePageResp struct {
	meta    notifyFeedMetaWire
	records []alerts.SourceRecord
	next    int64
	fail    bool // answer with a transport-style error
}

// fakeNotifyFeedClient scripts FetchNotifyFeedPage/PostNotifyAck.
type fakeNotifyFeedClient struct {
	mu      sync.Mutex
	fetches []string // "src|since|token"
	acks    []string // "src|watermark"
	pages   map[string][]fakePageResp
	// onAck, when set, runs inside PostNotifyAck BEFORE the answer is
	// recorded — the hook the ordering test uses to observe ledger state
	// at ACK time.
	onAck func(src string, watermark int64)
	// ackFails scripts the next N ack calls to fail.
	ackFails int
}

func newFakeNotifyFeedClient() *fakeNotifyFeedClient {
	return &fakeNotifyFeedClient{pages: map[string][]fakePageResp{}}
}

func (f *fakeNotifyFeedClient) queue(sourceID string, resp ...fakePageResp) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pages[sourceID] = append(f.pages[sourceID], resp...)
}

// caughtUp is the empty-page answer for a source at since: records=[] and
// nextSince=since (the feed's B1 empty-page contract), with a meta that
// claims no overflow.
func caughtUp(sourceID, epoch string, since int64) fakePageResp {
	return fakePageResp{
		meta: notifyFeedMetaWire{SourceID: sourceID, Epoch: epoch, FirstSeq: since + 1, LastSeq: since, DurableSq: since},
		next: since,
	}
}

// page builds a records answer under an epoch.
func pageResp(sourceID, epoch string, firstSeq int64, next int64, records ...alerts.SourceRecord) fakePageResp {
	return fakePageResp{
		meta:    notifyFeedMetaWire{SourceID: sourceID, Epoch: epoch, FirstSeq: firstSeq, LastSeq: next, DurableSq: next},
		records: records,
		next:    next,
	}
}

func (f *fakeNotifyFeedClient) FetchNotifyFeedPage(ctx context.Context, worker *Worker, token string, sinceSeq int64, limit int, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fetches = append(f.fetches, fmt.Sprintf("%s|%d|%s", worker.ID, sinceSeq, token))
	var resp fakePageResp
	if q := f.pages[worker.ID]; len(q) > 0 {
		resp = q[0]
		f.pages[worker.ID] = q[1:]
	} else {
		resp = caughtUp(worker.ID, "e1", sinceSeq)
	}
	if resp.fail {
		return nil, fmt.Errorf("worker %s: scripted failure", worker.ID)
	}
	body, err := json.Marshal(notifyFeedPageWire{Source: resp.meta, Records: resp.records, NextSince: resp.next})
	if err != nil {
		return nil, err
	}
	return body, nil
}

func (f *fakeNotifyFeedClient) PostNotifyAck(ctx context.Context, worker *Worker, token string, watermark int64, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
	f.mu.Lock()
	if f.ackFails > 0 {
		f.ackFails--
		f.mu.Unlock()
		return nil, fmt.Errorf("worker %s: scripted ack failure", worker.ID)
	}
	f.acks = append(f.acks, fmt.Sprintf("%s|%d", worker.ID, watermark))
	hook := f.onAck
	f.mu.Unlock()
	if hook != nil {
		hook(worker.ID, watermark)
	}
	return []byte(`{"ok":true}`), nil
}

func (f *fakeNotifyFeedClient) calls() (fetches, acks []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.fetches...), append([]string(nil), f.acks...)
}

// fakeFleet scripts worker liveness.
type fakeFleet struct {
	online map[string]bool
}

func (f *fakeFleet) GetWorker(workerID string) (*Worker, bool) {
	if f.online[workerID] {
		return &Worker{ID: workerID}, true
	}
	return nil, false
}

func (f *fakeFleet) WorkerTransport(workerID string) (*tunnel.MuxTransport, bool) {
	if f.online[workerID] {
		return &tunnel.MuxTransport{}, true // non-nil = reachable
	}
	return nil, true
}

// --- harness ------------------------------------------------------------------

func enroll(t *testing.T, reg *notifySourceRegistry, sourceID, epoch, token string) {
	t.Helper()
	ok := reg.RecordNotifyEnrollment(&tunnel.NotifyEnrollment{
		SourceID: sourceID, Epoch: epoch, NotifyCap: 1,
		Mode: "controller", Token: token,
	}, sourceID, sourceID)
	if !ok {
		t.Fatalf("enroll %s failed", sourceID)
	}
}

func srec(seq int64, typ, kind, sessionID string) alerts.SourceRecord {
	title := "t"
	if typ == "stalled" && sessionID == "" {
		title = "OpenCode" // the EmitDaemonNotice shape
	}
	return alerts.SourceRecord{
		Seq: seq, Type: typ, Kind: kind, SessionID: sessionID, Root: sessionID,
		Project: "/p", Title: title, Detail: "d", Ts: time.Now().UnixMilli(),
		Attended: true, IdleSec: 5, ProfileEligible: true, CooldownKey: sourceIDOf(seq) + "|" + typ,
	}
}

func sourceIDOf(int64) string { return "wrk" }

type ingestFixture struct {
	led    *notifyLedger
	reg    *notifySourceRegistry
	fleet  *fakeFleet
	client *fakeNotifyFeedClient
	mgr    *notifyIngestManager
}

func newIngestFixture(t *testing.T, retention int) *ingestFixture {
	t.Helper()
	led := newMemoryNotifyLedger()
	reg := newNotifySourceRegistry()
	fleet := &fakeFleet{online: map[string]bool{}}
	client := newFakeNotifyFeedClient()
	mgr := newNotifyIngestManager(led, reg, fleet, client, NotifyIngestConfig{PollInterval: 10 * time.Millisecond})
	return &ingestFixture{led: led, reg: reg, fleet: fleet, client: client, mgr: mgr}
}

func (fx *ingestFixture) tick() {
	fx.mgr.tickOnce(context.Background())
}

// --- 1: commit-then-ACK ordering ---------------------------------------------

func TestNotifyIngestCommitThenAckOrder(t *testing.T) {
	fx := newIngestFixture(t, 0)
	enroll(t, fx.reg, "wrk", "e1", "token-0123456789abcdef")
	fx.fleet.online["wrk"] = true

	// Observe the ledger state INSIDE the ACK call: the commit must already
	// be durable-visible (cursor ≥ watermark) — the ordering invariant.
	var ackCursor, ackHead int64
	fx.client.mu.Lock()
	fx.client.onAck = func(src string, wm int64) {
		st, _ := fx.led.SourceState(src)
		ackCursor, ackHead = st.HighSeq, fx.led.Head()
	}
	fx.client.mu.Unlock()

	fx.client.queue("wrk",
		pageResp("wrk", "e1", 1, 3, srec(1, "finished", "", "s1"), srec(2, "finished", "", "s2"), srec(3, "finished", "", "s3")),
		caughtUp("wrk", "e1", 3),
	)
	fx.tick()

	fetches, acks := fx.client.calls()
	if len(fetches) == 0 {
		t.Fatal("expected a fetch")
	}
	if len(acks) != 1 || acks[0] != "wrk|3" {
		t.Fatalf("acks = %v, want exactly [wrk|3] (the committed cursor)", acks)
	}
	if ackCursor != 3 {
		t.Fatalf("at ACK time the committed cursor was %d, want 3 — ACK may only follow the commit", ackCursor)
	}
	if ackHead != 3 {
		t.Fatalf("at ACK time head was %d, want 3", ackHead)
	}
	epoch, cursor, acked, ok := fx.daemonlessCursor("wrk")
	if !ok || epoch != "e1" || cursor != 3 || acked != 3 {
		t.Fatalf("post-tick source state: epoch=%q cursor=%d acked=%d ok=%v", epoch, cursor, acked, ok)
	}
	// Central events carry the full §3.1 shape: worker attribution + source
	// identity + detection snapshot.
	evs := fx.led.EventsSince(0, 10)
	if len(evs) != 3 || evs[0].ID != 1 || evs[0].Seq != 1 || evs[0].WorkerID != "wrk" || evs[0].Epoch != "e1" {
		t.Fatalf("committed events: %+v", evs)
	}

	// A second tick with nothing new: NO redundant ACK (watermark already
	// accepted), no phantom events.
	fx.tick()
	_, acks = fx.client.calls()
	if len(acks) != 1 {
		t.Fatalf("a caught-up source must not re-ACK: %v", acks)
	}

	// A failed ACK is deferred and retried on a later poll — and the retry
	// carries the SAME (still-committed) watermark.
	fx.client.mu.Lock()
	fx.client.ackFails = 1
	fx.client.mu.Unlock()
	fx.client.queue("wrk", pageResp("wrk", "e1", 4, 4, srec(4, "finished", "", "s4")), caughtUp("wrk", "e1", 4))
	fx.tick() // commit 4 succeeds, first ACK attempt fails
	fx.tick() // retried (no new records needed)
	_, acks = fx.client.calls()
	if len(acks) != 2 || acks[1] != "wrk|4" {
		t.Fatalf("deferred ACK must be retried with the committed watermark: %v", acks)
	}
}

func (fx *ingestFixture) daemonlessCursor(src string) (string, int64, int64, bool) {
	st, ok := fx.led.SourceState(src)
	return st.Epoch, st.HighSeq, st.AckedSeq, ok
}

// --- 2: epoch reconciliation (F6) ----------------------------------------------

func TestNotifyIngestEpochChangeResetsAndRepulls(t *testing.T) {
	fx := newIngestFixture(t, 0)
	enroll(t, fx.reg, "wrk", "e1", "token-0123456789abcdef")
	fx.fleet.online["wrk"] = true

	// Old epoch: seqs 1-2 committed.
	fx.client.queue("wrk",
		pageResp("wrk", "e1", 1, 2, srec(1, "finished", "", "s1"), srec(2, "finished", "", "s2")),
	)
	fx.tick()
	st, _ := fx.led.SourceState("wrk")
	if st.Epoch != "e1" || st.HighSeq != 2 {
		t.Fatalf("pre-rotation state: %+v", st)
	}

	// The worker rotated: every fetch now serves epoch e2 (from its head).
	// The loop's FIRST pull still uses the committed cursor (2) under e1;
	// the e2 answer must trigger reset + re-pull from 0.
	fx.client.queue("wrk",
		pageResp("wrk", "e2", 1, 2, srec(1, "waiting", "permission", "s1"), srec(2, "waiting", "permission", "s2")),
		pageResp("wrk", "e2", 1, 2, srec(1, "waiting", "permission", "s1"), srec(2, "waiting", "permission", "s2")),
		caughtUp("wrk", "e2", 2),
	)
	fx.tick()

	st, ok := fx.led.SourceState("wrk")
	if !ok || st.Epoch != "e2" || st.HighSeq != 2 {
		t.Fatalf("post-rotation state: %+v ok=%v (cursor must restart under the new epoch)", st, ok)
	}
	if len(st.Gaps) != 1 || st.Gaps[0].Epoch != "e1" || st.Gaps[0].FromSeq != 3 || !st.Gaps[0].OpenEnd || st.Gaps[0].Reason != "epoch_rotation" {
		t.Fatalf("rotation gap: %+v", st.Gaps)
	}
	// Both epochs' events coexist in the GLOBAL stream (ids contiguous);
	// the new epoch's seq namespace restarted at 1.
	evs := fx.led.EventsSince(0, 10)
	if len(evs) != 4 {
		t.Fatalf("global stream after rotation: %d events, want 4", len(evs))
	}
	if evs[2].ID != 3 || evs[2].Epoch != "e2" || evs[2].Seq != 1 {
		t.Fatalf("new-epoch event shape (first): %+v", evs[2])
	}
	if evs[3].ID != 4 || evs[3].Epoch != "e2" || evs[3].Seq != 2 {
		t.Fatalf("new-epoch event shape (second): %+v", evs[3])
	}
	// The stale-epoch page was fetched with the OLD cursor — and that
	// knowledge was reconciled, never committed as continuity.
	fetches, _ := fx.client.calls()
	sawOldCursor := false
	for _, f := range fetches {
		if strings.HasSuffix(f, "|2|token-0123456789abcdef") {
			sawOldCursor = true
		}
	}
	if !sawOldCursor {
		t.Fatalf("expected a fetch at the old committed cursor before reconciliation: %v", fetches)
	}
	if cov := fx.led.Coverage(); cov.Complete {
		t.Fatal("rotation gap must surface in coverage")
	}
}

// --- 2b: identity validation precedes every durable mutation (b-F2) -------

// b-F2: ResetSourceEpoch is a DURABLE journal write (it clears the source's
// cursor/dedupe/ack); it must never fire on behalf of a response that is
// not provably the enrolled source's. A wrong-source page — here also
// carrying a foreign epoch, the exact shape that used to trigger the reset
// BEFORE the identity check — must leave the journal byte-identical: no
// reset, no commit, no ack, only a failure/backoff cycle. And the
// epoch-change reset must still fire — but ONLY for the correctly
// identified source whose epoch differs.
func TestNotifyIngestWrongSourcePageMutatesNothing(t *testing.T) {
	// File-backed ledger: the journal bytes are the mutation receipt.
	dir := t.TempDir()
	ledPath := filepath.Join(dir, "store.ledger")
	led, err := armNotifyLedger(ledPath, filepath.Join(dir, "absent.sources"), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer led.Close()
	reg := newNotifySourceRegistry()
	fleet := &fakeFleet{online: map[string]bool{"wrk": true}}
	client := newFakeNotifyFeedClient()
	enroll(t, reg, "wrk", "e1", "token-0123456789abcdef")
	mgr := newNotifyIngestManager(led, reg, fleet, client, NotifyIngestConfig{PollInterval: 10 * time.Millisecond})

	// Committed state to defend: epoch e1, cursor 2, acked 2.
	client.queue("wrk", pageResp("wrk", "e1", 1, 2, srec(1, "finished", "", "s1"), srec(2, "finished", "", "s2")))
	mgr.tickOnce(context.Background())
	st, ok := led.SourceState("wrk")
	if !ok || st.Epoch != "e1" || st.HighSeq != 2 || st.AckedSeq != 2 {
		t.Fatalf("pre-attack state: %+v ok=%v", st, ok)
	}
	before, err := os.ReadFile(ledPath)
	if err != nil {
		t.Fatal(err)
	}

	// The wrong-source response: names ANOTHER source and a foreign epoch.
	// The old ordering ran ResetSourceEpoch("wrk", "e2") on exactly this
	// page — poisoning the enrolled source's dedupe floor before the
	// identity check ever ran.
	client.queue("wrk", pageResp("other-wrk", "e2", 1, 2, srec(1, "finished", "", "x1"), srec(2, "finished", "", "x2")))
	mgr.tickOnce(context.Background())

	// ZERO durable writes: the journal is byte-identical.
	after, err := os.ReadFile(ledPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("a wrong-source page must leave the journal byte-identical: %d bytes -> %d bytes", len(before), len(after))
	}
	st, ok = led.SourceState("wrk")
	if !ok || st.Epoch != "e1" || st.HighSeq != 2 || st.AckedSeq != 2 || len(st.Gaps) != 0 {
		t.Fatalf("a wrong-source page must not touch the enrolled source's state: %+v ok=%v", st, ok)
	}
	if got := led.Head(); got != 2 {
		t.Fatalf("head = %d, want 2 (no events may land from a wrong-source page)", got)
	}
	if _, acks := client.calls(); len(acks) != 1 { // only the pre-attack ack
		t.Fatalf("a wrong-source page must not ACK: %v", acks)
	}
	// The source stays healthy: the rejection classified as an ordinary
	// source failure (log + backoff), never a wedge.
	mgr.mu.Lock()
	failN := mgr.failN["wrk"]
	eligibleAt := mgr.eligibleAt["wrk"]
	mgr.mu.Unlock()
	if failN != 1 || !time.Now().Before(eligibleAt) {
		t.Fatalf("wrong-source response must engage ordinary backoff: failN=%d eligibleAt=%v", failN, eligibleAt)
	}

	// The exact-once hazard stays closed: a later VALID same-epoch page
	// continues from the committed cursor — committed seqs are never
	// re-imported under new central ids.
	mgr.mu.Lock()
	delete(mgr.eligibleAt, "wrk")
	delete(mgr.failN, "wrk")
	mgr.mu.Unlock()
	client.queue("wrk", pageResp("wrk", "e1", 3, 3, srec(3, "finished", "", "s3")))
	mgr.tickOnce(context.Background())
	evs := led.EventsSince(0, 10)
	if len(evs) != 3 || evs[2].ID != 3 || evs[2].Seq != 3 {
		t.Fatalf("post-attack valid page must continue ids/seqs exactly (no dedupe-floor poisoning): %+v", evs)
	}

	// The epoch-change reset still fires — but only for the CORRECTLY
	// identified source whose epoch differs. (The wrong-source page above
	// also carried epoch e2 and fired nothing.)
	client.queue("wrk",
		pageResp("wrk", "e2", 1, 1, srec(1, "waiting", "permission", "n1")), // fetched at the e1 cursor
		pageResp("wrk", "e2", 1, 1, srec(1, "waiting", "permission", "n1")), // the post-reset re-pull from 0
	)
	mgr.tickOnce(context.Background())
	st, ok = led.SourceState("wrk")
	if !ok || st.Epoch != "e2" || st.HighSeq != 1 {
		t.Fatalf("a correctly-identified epoch change must still reset: %+v ok=%v", st, ok)
	}
	var rot *NotifySourceGap
	for i := range st.Gaps {
		if st.Gaps[i].Reason == "epoch_rotation" {
			rot = &st.Gaps[i]
		}
	}
	if rot == nil || rot.Epoch != "e1" || rot.FromSeq != 4 || !rot.OpenEnd {
		t.Fatalf("rotation gap must be open-end under e1 from the committed cursor+1 (4): %+v", st.Gaps)
	}
	if evs := led.EventsSince(0, 10); len(evs) != 4 || evs[3].Epoch != "e2" || evs[3].Seq != 1 {
		t.Fatalf("post-rotation event must continue global ids under the new epoch: %+v", evs)
	}
}

// --- 3: overflow gap (worker prefix loss) ---------------------------------------

func TestNotifyIngestRecordsWorkerPrefixLossGap(t *testing.T) {
	fx := newIngestFixture(t, 0)
	enroll(t, fx.reg, "wrk", "e1", "token-0123456789abcdef")
	fx.fleet.online["wrk"] = true

	fx.client.queue("wrk",
		pageResp("wrk", "e1", 1, 2, srec(1, "finished", "", "s1"), srec(2, "finished", "", "s2")),
	)
	fx.tick()

	// The worker evicted seqs 3-6 (overflow): the feed now starts at 7.
	fx.client.queue("wrk",
		pageResp("wrk", "e1", 7, 8, srec(7, "finished", "", "s7"), srec(8, "finished", "", "s8")),
	)
	fx.tick()

	st, _ := fx.led.SourceState("wrk")
	if st.HighSeq != 8 {
		t.Fatalf("cursor after overflow page: %+v", st)
	}
	var gap *NotifySourceGap
	for i := range st.Gaps {
		if st.Gaps[i].Reason == "worker_prefix_lost" {
			gap = &st.Gaps[i]
		}
	}
	if gap == nil || gap.Epoch != "e1" || gap.FromSeq != 3 || gap.ToSeq != 6 || gap.OpenEnd {
		t.Fatalf("worker_prefix_lost gap must be the closed range [3,6]: %+v", st.Gaps)
	}
	if got := len(fx.led.EventsSince(0, 10)); got != 4 {
		t.Fatalf("events after overflow: %d, want 4 (1,2,7,8)", got)
	}
}

// --- 4: ineligible sources are never pulled --------------------------------------

func TestNotifyIngestIneligibleNeverPulled(t *testing.T) {
	fx := newIngestFixture(t, 0)
	fx.reg.MarkNotifyIneligible("wrk-refused", "wrk-refused")
	fx.fleet.online["wrk-refused"] = true
	fx.tick()

	fetches, acks := fx.client.calls()
	if len(fetches) != 0 || len(acks) != 0 {
		t.Fatalf("ineligible source must never be pulled: fetches=%v acks=%v", fetches, acks)
	}
	// And an eligible source in the same sweep IS pulled (the skip is
	// per-source, not a wedged loop).
	enroll(t, fx.reg, "wrk-ok", "e1", "token-0123456789abcdef")
	fx.fleet.online["wrk-ok"] = true
	fx.client.queue("wrk-ok", pageResp("wrk-ok", "e1", 1, 1, srec(1, "finished", "", "s1")), caughtUp("wrk-ok", "e1", 1))
	fx.tick()
	fetches, _ = fx.client.calls()
	if len(fetches) != 1 || !strings.HasPrefix(fetches[0], "wrk-ok|") {
		t.Fatalf("eligible source must be pulled: %v", fetches)
	}
}

// --- 5: backoff + fresh-credentials reset (F7) ------------------------------------

func TestNotifyIngestBackoffAndFreshCredentialReset(t *testing.T) {
	fx := newIngestFixture(t, 0)
	enroll(t, fx.reg, "wrk", "e1", "token-0123456789abcdef")
	fx.fleet.online["wrk"] = true

	// First fetch fails (worker 404/auth/transport — same classification).
	fx.client.queue("wrk", fakePageResp{fail: true})
	fx.tick()
	fetches, _ := fx.client.calls()
	if len(fetches) != 1 {
		t.Fatalf("expected exactly one fetch, got %v", fetches)
	}

	// Backoff engaged: an immediate tick does NOT re-fetch.
	fx.tick()
	if fetches, _ = fx.client.calls(); len(fetches) != 1 {
		t.Fatalf("backoff must suppress the immediate re-fetch: %v", fetches)
	}
	fx.mgr.mu.Lock()
	eligibleAt := fx.mgr.eligibleAt["wrk"]
	failN := fx.mgr.failN["wrk"]
	fx.mgr.mu.Unlock()
	if failN != 1 || !time.Now().Before(eligibleAt) {
		t.Fatalf("backoff state: failN=%d eligibleAt=%v", failN, eligibleAt)
	}

	// F7 — the worker re-enrolled with a FRESH token: the failure described
	// the old credentials, so the retry is immediate and uses the new one.
	enroll(t, fx.reg, "wrk", "e1", "token-NEW-0123456789ab")
	fx.client.queue("wrk", caughtUp("wrk", "e1", 0))
	fx.tick()
	fetches, _ = fx.client.calls()
	if len(fetches) != 2 || !strings.HasSuffix(fetches[1], "token-NEW-0123456789ab") {
		t.Fatalf("fresh credentials must be retried immediately with the NEW token: %v", fetches)
	}
	fx.mgr.mu.Lock()
	failN = fx.mgr.failN["wrk"]
	fx.mgr.mu.Unlock()
	if failN != 0 {
		t.Fatalf("credential refresh must clear the failure count, got %d", failN)
	}

	// Same-credential failures DOUBLE the backoff (no hammering dead
	// entries): two consecutive failures under the SAME credentials push
	// eligibility past 2× poll.
	fx.client.queue("wrk", fakePageResp{fail: true})
	fx.tick() // failure #1 under the new credentials (counter restarted by F7)
	fx.mgr.mu.Lock()
	delete(fx.mgr.eligibleAt, "wrk") // simulate the backoff window elapsing
	fx.mgr.mu.Unlock()
	fx.client.queue("wrk", fakePageResp{fail: true})
	fx.tick() // failure #2 — must at least double
	fx.mgr.mu.Lock()
	eligible2 := fx.mgr.eligibleAt["wrk"]
	fx.mgr.mu.Unlock()
	poll := fx.mgr.cfg.PollInterval
	if !time.Now().Add(poll).Before(eligible2) {
		t.Fatalf("second failure must at least double the backoff: eligibleAt=%v poll=%v", eligible2, poll)
	}
}

// --- 6: commit failure ⇒ commit-or-nothing ⇒ retry from the old cursor ------------

func TestNotifyIngestCommitFailureRetriesFromOldCursor(t *testing.T) {
	// File-backed ledger (the failure seam: a closed journal handle fails
	// the append, exactly like a full/crashing disk would).
	dir := t.TempDir()
	ledPath := filepath.Join(dir, "store.ledger")
	led, err := armNotifyLedger(ledPath, filepath.Join(dir, "absent.sources"), 0)
	if err != nil {
		t.Fatal(err)
	}
	reg := newNotifySourceRegistry()
	fleet := &fakeFleet{online: map[string]bool{"wrk": true}}
	client := newFakeNotifyFeedClient()
	enroll(t, reg, "wrk", "e1", "token-0123456789abcdef")
	mgr := newNotifyIngestManager(led, reg, fleet, client, NotifyIngestConfig{PollInterval: 10 * time.Millisecond})

	// The commit target dies mid-page: the fetch succeeds, the commit fails
	// — commit-or-nothing, no ACK, nothing half-ingested.
	_ = led.Close()
	client.queue("wrk", pageResp("wrk", "e1", 1, 3, srec(1, "finished", "", "s1"), srec(2, "finished", "", "s2"), srec(3, "finished", "", "s3")))
	mgr.tickOnce(context.Background())
	if got := len(led.EventsSince(0, 10)); got != 0 {
		t.Fatalf("failed commit must leave zero events, got %d", got)
	}
	if _, acks := client.calls(); len(acks) != 0 {
		t.Fatalf("no ACK may follow a failed commit: %v", acks)
	}
	if st, ok := led.SourceState("wrk"); ok && st.HighSeq != 0 {
		t.Fatalf("cursor must not advance on failure: %+v", st)
	}

	// The controller recovers (re-arm from the committed journal — empty)
	// and the SAME page is retried from the OLD cursor: all three records
	// land exactly once, ids from 1.
	led2, err := armNotifyLedger(ledPath, filepath.Join(dir, "absent.sources"), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer led2.Close()
	mgr.ledger = led2
	// Clear the failure backoff (the recovery is not the worker's fault).
	mgr.mu.Lock()
	delete(mgr.eligibleAt, "wrk")
	delete(mgr.failN, "wrk")
	mgr.mu.Unlock()
	client.queue("wrk",
		pageResp("wrk", "e1", 1, 3, srec(1, "finished", "", "s1"), srec(2, "finished", "", "s2"), srec(3, "finished", "", "s3")),
		caughtUp("wrk", "e1", 3),
	)
	mgr.tickOnce(context.Background())

	evs := led2.EventsSince(0, 10)
	if len(evs) != 3 || evs[0].ID != 1 || evs[2].ID != 3 || evs[2].Seq != 3 {
		t.Fatalf("retry must ingest the page exactly once, ids 1..3: %+v", evs)
	}
	_, acks := client.calls()
	if len(acks) != 1 || acks[0] != "wrk|3" {
		t.Fatalf("retry must ACK only after its commit: %v", acks)
	}
}

// --- 7: offline workers are skipped without backoff ---------------------------------

func TestNotifyIngestOfflineWorkerSkippedWithoutBackoff(t *testing.T) {
	fx := newIngestFixture(t, 0)
	enroll(t, fx.reg, "wrk", "e1", "token-0123456789abcdef")
	// fleet.online has no "wrk": the worker is registered-offline posture.
	fx.tick()
	if fetches, _ := fx.client.calls(); len(fetches) != 0 {
		t.Fatalf("offline worker must not be fetched: %v", fetches)
	}
	fx.mgr.mu.Lock()
	_, backed := fx.mgr.eligibleAt["wrk"]
	fx.mgr.mu.Unlock()
	if backed {
		t.Fatal("offline skip must not engage failure backoff (transient by nature)")
	}
	// Reconnect: pulled on the very next tick.
	fx.fleet.online["wrk"] = true
	fx.client.queue("wrk", pageResp("wrk", "e1", 1, 1, srec(1, "finished", "", "s1")), caughtUp("wrk", "e1", 1))
	fx.tick()
	if fetches, _ := fx.client.calls(); len(fetches) != 1 {
		t.Fatalf("reconnected worker must be pulled immediately: %v", fetches)
	}
}

// --- 8: the §9.1 condition mapping at ingest -----------------------------------------

func TestNotifyIngestConditionMapping(t *testing.T) {
	fx := newIngestFixture(t, 0)
	enroll(t, fx.reg, "wrk", "e1", "token-0123456789abcdef")
	fx.fleet.online["wrk"] = true

	records := []alerts.SourceRecord{
		srec(1, "waiting", "permission", "s1"),
		srec(2, "waiting", "question", "s2"),
		srec(3, "waiting", "", "s3"), // legacy ring record: permission default
		srec(4, "finished", "", "s4"),
		srec(5, "stuck-thinking", "", "s5"),
		srec(6, "runaway", "", "s6"),
		srec(7, "stalled", "", "s7"), // session-level
		srec(8, "stalled", "", ""),   // daemon-level → worker_down
		srec(9, "session_started", "", "s9"),
	}
	fx.client.queue("wrk", pageResp("wrk", "e1", 1, 9, records...), caughtUp("wrk", "e1", 9))
	fx.tick()

	want := map[int64]string{
		1: "permission_pending", 2: "question_pending", 3: "permission_pending",
		4: "session_unread", 5: "degraded_thinking", 6: "degraded_runaway",
		7: "degraded_stalled", 8: "worker_down", 9: "session_started",
	}
	evs := fx.led.EventsSince(0, 20)
	if len(evs) != len(want) {
		t.Fatalf("committed %d events, want %d", len(evs), len(want))
	}
	for _, ev := range evs {
		if ev.Kind != want[ev.Seq] {
			t.Fatalf("seq %d (%s/%s): kind %q, want %q", ev.Seq, ev.Type, ev.SessionID, ev.Kind, want[ev.Seq])
		}
		if ev.Count != 1 {
			t.Fatalf("count must default to 1: %+v", ev)
		}
	}
}

// --- 9: StopNotifyIngest joins in-flight pulls (b-F2) --------------------------

// gatingFeedClient gates its FIRST fetch: it signals entry and blocks
// until the gate closes, then answers a full page (seqs 1..3). Later
// fetches serve from the current cursor (seqs since+1..3, then caught up).
type gatingFeedClient struct {
	entered chan struct{}
	gate    chan struct{}

	mu      sync.Mutex
	fetches int
	acks    []string
}

func (g *gatingFeedClient) FetchNotifyFeedPage(ctx context.Context, worker *Worker, token string, sinceSeq int64, limit int, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
	g.mu.Lock()
	n := g.fetches
	g.fetches++
	g.mu.Unlock()
	meta := notifyFeedMetaWire{SourceID: worker.ID, Epoch: "e1"}
	var recs []alerts.SourceRecord
	if n == 0 {
		recs = []alerts.SourceRecord{srec(1, "finished", "", "s1"), srec(2, "finished", "", "s2"), srec(3, "finished", "", "s3")}
		g.entered <- struct{}{} // the pull is now in-flight inside the fetch
		<-g.gate                // hold it there until the test releases
		meta.FirstSeq, meta.LastSeq, meta.DurableSq = 1, 3, 3
		return json.Marshal(notifyFeedPageWire{Source: meta, Records: recs, NextSince: 3})
	}
	for s := sinceSeq + 1; s <= 3; s++ {
		recs = append(recs, srec(s, "finished", "", fmt.Sprintf("s%d", s)))
	}
	if len(recs) > 0 {
		meta.FirstSeq, meta.LastSeq, meta.DurableSq = sinceSeq+1, 3, 3
		return json.Marshal(notifyFeedPageWire{Source: meta, Records: recs, NextSince: 3})
	}
	meta.FirstSeq, meta.LastSeq, meta.DurableSq = sinceSeq+1, sinceSeq, sinceSeq
	return json.Marshal(notifyFeedPageWire{Source: meta, Records: recs, NextSince: sinceSeq})
}

func (g *gatingFeedClient) PostNotifyAck(ctx context.Context, worker *Worker, token string, watermark int64, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
	g.mu.Lock()
	g.acks = append(g.acks, fmt.Sprintf("%s|%d", worker.ID, watermark))
	g.mu.Unlock()
	return []byte(`{"ok":true}`), nil
}

func (g *gatingFeedClient) stats() (fetches int, acks []string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.fetches, append([]string(nil), g.acks...)
}

// b-F2: a stop during an in-flight pull must JOIN the sweep before
// StopNotifyIngest returns, and a cancelled pull must never commit: an
// old pull committing/ACKing against a ledger the stopper replaced (the
// LoadNotifyStore re-arm path) is the duplicate-id / phantom-trim hazard.
// After the stop, an immediate restart runs exactly one manager.
func TestNotifyIngestStopJoinsInFlightPull(t *testing.T) {
	// File-backed ledger: the receipt also asserts the on-disk journal.
	dir := t.TempDir()
	ledPath := filepath.Join(dir, "store.ledger")
	led, err := armNotifyLedger(ledPath, filepath.Join(dir, "absent.sources"), 0)
	if err != nil {
		t.Fatal(err)
	}
	reg := newNotifySourceRegistry()
	enroll(t, reg, "wrk", "e1", "token-0123456789abcdef")
	fleet := &fakeFleet{online: map[string]bool{"wrk": true}}
	gc := &gatingFeedClient{entered: make(chan struct{}), gate: make(chan struct{})}
	m := newNotifyIngestManager(led, reg, fleet, gc, NotifyIngestConfig{PollInterval: 10 * time.Millisecond})

	// The Daemon stop path, armed exactly as StartNotifyIngest would arm
	// it (in-package white-box so the gating fake can ride it).
	d := &Daemon{}
	ctx, cancel := context.WithCancel(context.Background())
	d.notifyIngest = m
	d.notifyIngestCancel = cancel
	go m.Run(ctx)

	select {
	case <-gc.entered: // the pull is in-flight inside its fetch
	case <-time.After(5 * time.Second):
		t.Fatal("the pull never reached its fetch")
	}

	stopDone := make(chan struct{})
	go func() {
		d.StopNotifyIngest()
		close(stopDone)
	}()
	<-ctx.Done()   // the stop's cancellation is now observable
	close(gc.gate) // release the page — the cancelled pull must refuse it
	<-stopDone     // Stop returned: the sweep must have drained FIRST

	// No commit, no ACK — nothing landed because of (or after) the stop.
	if got := led.Head(); got != 0 {
		t.Fatalf("head = %d after stop: a cancelled pull must never commit", got)
	}
	if evs := led.EventsSince(0, 10); len(evs) != 0 {
		t.Fatalf("events landed after stop: %+v", evs)
	}
	if st, ok := led.SourceState("wrk"); ok && (st.HighSeq != 0 || st.AckedSeq != 0) {
		t.Fatalf("source state advanced despite the stop: %+v", st)
	}
	if _, acks := gc.stats(); len(acks) != 0 {
		t.Fatalf("no ACK may follow a cancelled pull: %v", acks)
	}
	// Grace window: a zombie pull (a sweep that outlived the stop) would
	// commit the released page exactly here.
	time.Sleep(150 * time.Millisecond)
	if got := led.Head(); got != 0 {
		t.Fatalf("head = %d after the stop grace window: no pull goroutine may outlive StopNotifyIngest", got)
	}
	// Deterministically: the old manager's Run has exited (Stop joined it).
	select {
	case <-m.done:
	default:
		t.Fatal("the old manager's Run must have exited before Stop returned")
	}
	// On disk: the journal carries ONLY its header.
	raw, err := os.ReadFile(ledPath)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(splitLines(raw)); n != 1 {
		t.Fatalf("journal must be header-only after the stop, has %d lines", n)
	}
	d.notifyIngestMu.Lock()
	cleared := d.notifyIngest == nil && d.notifyIngestCancel == nil
	d.notifyIngestMu.Unlock()
	if !cleared {
		t.Fatal("StopNotifyIngest must clear the manager/cancel fields")
	}

	// Immediate restart: exactly one manager sweeps — one more fetch, one
	// commit, one ACK, ids from 1 (no duplicates from the refused pull).
	m2 := newNotifyIngestManager(led, reg, fleet, gc, NotifyIngestConfig{PollInterval: 10 * time.Millisecond})
	m2.tickOnce(context.Background())
	fetches, acks := gc.stats()
	if fetches != 2 {
		t.Fatalf("exactly one fetch before and one after the restart, got %d", fetches)
	}
	evs := led.EventsSince(0, 10)
	if len(evs) != 3 || evs[0].ID != 1 || evs[2].ID != 3 {
		t.Fatalf("restart must commit the page exactly once, ids 1..3: %+v", evs)
	}
	if len(acks) != 1 || acks[0] != "wrk|3" {
		t.Fatalf("restart ACK must follow its commit: %v", acks)
	}
}
