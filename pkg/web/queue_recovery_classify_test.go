package web

// Certified-redelivery classification tests (slice 2b phase 2): the pure
// classifier matrix (the operator-accepted three-class ladder + the
// excluded arms), the requeue lifecycle (same-msgid + mint-at-claim +
// bookkeeping reset + budget cap), the passive-terminal re-open rules, the
// epoch-boundary cache invalidation (T1C-F3), the no-filesystem-effects
// refusal ordering (tier1_b-F1's Linux-runnable arm), and the session.error
// detail-only signal.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// mkClassifyItem builds a custody-era item shape for the pure classifier.
func mkClassifyItem(claimGen uint64, attempts ...QueueAttempt) QueueItem {
	return QueueItem{
		ID:              "q_x",
		State:           QueueUnknown,
		OpencodeMsgID:   "msg_x",
		ClaimGeneration: claimGen,
		Attempts:        attempts,
	}
}

func TestClassifyCertifiedRedeliveryMatrix(t *testing.T) {
	cases := []struct {
		name        string
		it          QueueItem
		ocGenNow    uint64
		barrierCert bool
		get404      bool
		want        certifiedClass
	}{
		{
			name: "legacy claim is never certifiable (design: legacy unknown chips)",
			it:   mkClassifyItem(0), want: classNone,
		},
		{
			name: "legacy claim with connect_failed journal is STILL uncertifiable",
			it:   mkClassifyItem(0, QueueAttempt{TransportClass: QueueAttemptConnectFailed}), want: classNone,
		},
		{
			name: "C1 never-started: custody claim, zero attempts",
			it:   mkClassifyItem(7), want: classNeverStarted,
		},
		{
			name: "C2 connect_failed receipt",
			it:   mkClassifyItem(7, QueueAttempt{TransportClass: QueueAttemptConnectFailed}), want: classConnectFailed,
		},
		{
			name: "C5 server_error wins even after an earlier connect_failed",
			it: mkClassifyItem(7,
				QueueAttempt{TransportClass: QueueAttemptConnectFailed},
				QueueAttempt{TransportClass: QueueAttemptServerError}), want: classServerErrno,
		},
		{
			name: "C4 open attempt, OC alive: live-uncertain (never redeliver)",
			it:   mkClassifyItem(7, QueueAttempt{OCGeneration: 3}), ocGenNow: 3, barrierCert: true, get404: true, want: classAmbiguous,
		},
		{
			name: "C4 accepted_2xx, OC alive, 404: live-uncertain (BLK-A2)",
			it:   mkClassifyItem(7, QueueAttempt{OCGeneration: 3, TransportClass: QueueAttemptAccepted2xx}), ocGenNow: 3, barrierCert: true, get404: true, want: classAmbiguous,
		},
		{
			name: "C4 written_unknown, OC alive, 404: live-uncertain",
			it:   mkClassifyItem(7, QueueAttempt{OCGeneration: 3, TransportClass: QueueAttemptWrittenUnknown}), ocGenNow: 3, barrierCert: true, get404: true, want: classAmbiguous,
		},
		{
			name: "C3 restart + 404 + certified barrier",
			it:   mkClassifyItem(7, QueueAttempt{OCGeneration: 3, TransportClass: QueueAttemptAccepted2xx}), ocGenNow: 4, barrierCert: true, get404: true, want: classRestartBarrier,
		},
		{
			name: "A2 exclusion: restart + 404 but barrier NOT certified (external OC / non-Linux)",
			it:   mkClassifyItem(7, QueueAttempt{OCGeneration: 3, TransportClass: QueueAttemptAccepted2xx}), ocGenNow: 4, barrierCert: false, get404: true, want: classAmbiguous,
		},
		{
			name: "restart but generation UNKNOWN at attempt time (OCGeneration 0): fail-closed",
			it:   mkClassifyItem(7, QueueAttempt{TransportClass: QueueAttemptAccepted2xx}), ocGenNow: 4, barrierCert: true, get404: true, want: classAmbiguous,
		},
		{
			name: "no restart (same generation) + 404: live-uncertain",
			it:   mkClassifyItem(7, QueueAttempt{OCGeneration: 4, TransportClass: QueueAttemptAccepted2xx}), ocGenNow: 4, barrierCert: true, get404: true, want: classAmbiguous,
		},
		{
			name: "restart but GET transient (NOT 404): barrier uncertified — fail-closed",
			it:   mkClassifyItem(7, QueueAttempt{OCGeneration: 3, TransportClass: QueueAttemptAccepted2xx}), ocGenNow: 4, barrierCert: true, get404: false, want: classAmbiguous,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyCertifiedRedelivery(tc.it, tc.ocGenNow, tc.barrierCert, tc.get404)
			if got != tc.want {
				t.Fatalf("classify = %q, want %q (item %+v ocGen=%d barrier=%v get404=%v)", got, tc.want, tc.it, tc.ocGenNow, tc.barrierCert, tc.get404)
			}
		})
	}
}

// TestRequeueCertifiedRedeliveryLifecycle: the requeue preserves the
// correlation id VERBATIM (mint-at-claim — only Claim mints, and the
// requeue path bypasses Claim on purpose), stamps the RequeuePending marker,
// resets the reconciliation bookkeeping, refuses an in-flight dispatch, and
// terminalizes at the attempt budget. itemForResume consumes the marker
// exactly once.
func TestRequeueCertifiedRedeliveryLifecycle(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	s := &sessionQueueStore{path: queuePath(root, "rq")}
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()

	// Custody-claim an item and let its attempt fail connect_failed.
	it, _, err := s.EnqueueWithAttemptID("i-1", "requeue probe", nil, QueueSendConfig{Agent: "build"}, "")
	if err != nil {
		t.Fatal(err)
	}
	claimed, won, err := s.ClaimForCustody(tok)
	if err != nil || !won {
		t.Fatalf("claim: err=%v won=%v", err, won)
	}
	minted := claimed.OpencodeMsgID
	if minted == "" || claimed.ClaimGeneration != tok.Generation() {
		t.Fatalf("claim did not stamp the era marker: %+v", claimed)
	}
	idx, err := s.BeginDispatchAttempt(tok, it.ID, 3)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RecordAttemptOutcome(tok, it.ID, idx, QueueAttemptConnectFailed, "dial refused"); err != nil {
		t.Fatal(err)
	}

	// In-flight refusal: a fresh DispatchStartedAt must be rejected (the
	// loop's own dispatch is running).
	if err := s.RequeueForCertifiedRedelivery(tok, it.ID, requeueJustificationConnectFailed); err == nil {
		t.Fatal("requeue of an in-flight (fresh) dispatch accepted — must refuse")
	}

	// Age it past the threshold (test override shrinks the window).
	SetStaleDispatchThresholdForTest(50 * time.Millisecond)
	t.Cleanup(func() { SetStaleDispatchThresholdForTest(0) })
	time.Sleep(80 * time.Millisecond)

	// Pre-seed passive bookkeeping to prove the reset.
	s.mu.Lock()
	for i := range s.items {
		if s.items[i].ID == it.ID {
			s.items[i].ReconcileAttempts = 2
		}
	}
	s.save()
	s.mu.Unlock()

	if err := s.RequeueForCertifiedRedelivery(tok, it.ID, requeueJustificationConnectFailed); err != nil {
		t.Fatalf("requeue: %v", err)
	}
	got := journalItemByText(t, s, "requeue probe")
	if got.State != QueueDispatching || !got.RequeuePending {
		t.Fatalf("after requeue = %+v, want dispatching + RequeuePending", got)
	}
	if got.OpencodeMsgID != minted {
		t.Fatalf("correlation id changed across requeue: %q -> %q (mint-at-claim: same-msgid redelivery only)", minted, got.OpencodeMsgID)
	}
	if got.ReconcileAttempts != 0 || got.ReconcileTerminal {
		t.Fatalf("bookkeeping not reset: %+v", got)
	}
	if !strings.Contains(got.Detail, "Certified redelivery (connect failed)") {
		t.Fatalf("requeue detail = %q, want the design.md-justified class text", got.Detail)
	}

	// itemForResume consumes the marker exactly once.
	first, ok, err := s.itemForResume(it.ID)
	if err != nil || !ok {
		t.Fatalf("first resume: ok=%v err=%v", ok, err)
	}
	if first.OpencodeMsgID != minted || first.RequeuePending {
		t.Fatalf("resumed item = %+v, want same msgid with marker consumed", first)
	}
	if _, ok, _ := s.itemForResume(it.ID); ok {
		t.Fatal("second itemForResume succeeded — the marker must be single-consumption")
	}

	// Budget cap: drive attempts to maxCertifiedRedeliveries and requeue
	// again — the item terminalizes instead of redelivering forever.
	// [deferred C-F2] The seed PRE-SETS AmbiguousDelivery: the budget branch
	// must CLEAR the marker (exhaustion ≠ uncertainty) alongside
	// RequeuePending — a stale marker must not survive into slice 3's FE.
	s.mu.Lock()
	for i := range s.items {
		if s.items[i].ID == it.ID {
			at := make([]QueueAttempt, maxCertifiedRedeliveries)
			for j := range at {
				at[j] = QueueAttempt{TransportClass: QueueAttemptConnectFailed}
			}
			s.items[i].Attempts = at
			s.items[i].RequeuePending = true
			s.items[i].AmbiguousDelivery = true
		}
	}
	s.save()
	s.mu.Unlock()
	time.Sleep(80 * time.Millisecond) // stale again
	if err := s.RequeueForCertifiedRedelivery(tok, it.ID, requeueJustificationConnectFailed); err != nil {
		t.Fatalf("budget requeue call: %v", err)
	}
	got = journalItemByText(t, s, "requeue probe")
	if got.State != QueueUnknown || !got.ReconcileTerminal || got.RequeuePending {
		t.Fatalf("budget-exhausted item = %+v, want terminal unknown (budget detail), no marker", got)
	}
	if !strings.Contains(got.Detail, "budget exhausted") {
		t.Fatalf("budget detail = %q", got.Detail)
	}
	if got.AmbiguousDelivery {
		t.Fatalf("exhaustion is NOT delivery uncertainty — no ambiguous marker: %+v", got)
	}
}

// TestCertifySnapshotReopenRules: passive-terminalized items re-open ONLY
// for certified shapes (journal-proven C1/C2, barrier-shapeable C3); the
// terminal ambiguous item stays closed.
func TestCertifySnapshotReopenRules(t *testing.T) {
	root := t.TempDir()
	s := &sessionQueueStore{path: queuePath(root, "reopen")}
	SetStaleDispatchThresholdForTest(50 * time.Millisecond)
	t.Cleanup(func() { SetStaleDispatchThresholdForTest(0) })

	// Build items by hand on the store (all passive-terminalized: the
	// re-open rules are what's under test).
	s.mu.Lock()
	s.items = []QueueItem{
		{ID: "c1", State: QueueUnknown, OpencodeMsgID: "m1", ClaimGeneration: 5, ReconcileTerminal: true},
		{ID: "c2", State: QueueUnknown, OpencodeMsgID: "m2", ClaimGeneration: 5, ReconcileTerminal: true,
			Attempts: []QueueAttempt{{TransportClass: QueueAttemptConnectFailed}}},
		{ID: "c3", State: QueueUnknown, OpencodeMsgID: "m3", ClaimGeneration: 5, ReconcileTerminal: true,
			Attempts: []QueueAttempt{{OCGeneration: 2, TransportClass: QueueAttemptAccepted2xx}}},
		{ID: "amb", State: QueueUnknown, OpencodeMsgID: "m4", ClaimGeneration: 5, ReconcileTerminal: true,
			Attempts: []QueueAttempt{{OCGeneration: 3, TransportClass: QueueAttemptAccepted2xx}}},
		{ID: "legacy", State: QueueUnknown, OpencodeMsgID: "m5", ReconcileTerminal: true},
	}
	s.loaded = true
	s.mu.Unlock()

	got := s.snapshotCertifyCandidates(time.Now(), 3 /* ocGen */, true /* barrier */)
	seen := map[string]bool{}
	for _, c := range got {
		seen[c.ID] = true
	}
	for _, want := range []string{"c1", "c2", "c3"} {
		if !seen[want] {
			t.Fatalf("candidate %s missing from re-open set: %v", want, seen)
		}
	}
	for _, no := range []string{"amb", "legacy"} {
		if seen[no] {
			t.Fatalf("%s must NOT re-open (ambiguous-without-shape / legacy): %v", no, seen)
		}
	}
}

// notFoundHandler is the trivial 404 handler for the placeholder upstream
// (net/http is otherwise unused in this file — the GET outcomes are modeled
// by opencode.ErrMessageNotFound / explicit bodies, not raw HTTP).
func notFoundHandler() http.Handler { return http.NotFoundHandler() }

// TestCertifiedRecoveryPassActions drives ONE Server-level pass against a
// scripted resolver: C2 requeues (same msgid), ambiguous items bump to
// terminal with the marker, and 200-exact heals to sent.
func TestCertifiedRecoveryPassActions(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()

	oc := httptest.NewServer(notFoundHandler())
	t.Cleanup(oc.Close)
	agg := aggregator.New(oc.URL, 10)
	srv, err := NewServer(agg, oc.URL, 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	SetStaleDispatchThresholdForTest(50 * time.Millisecond)
	t.Cleanup(func() { SetStaleDispatchThresholdForTest(0) })

	s := srv.queues.store(root, "s1")
	mk := func(id string, attempts ...QueueAttempt) {
		t.Helper()
		s.mu.Lock()
		s.load()
		s.order++
		s.items = append(s.items, QueueItem{
			ID: id, Order: s.order, State: QueueUnknown, OpencodeMsgID: "msg_" + id,
			ClaimGeneration: tok.Generation(), Attempts: attempts,
		})
		s.save()
		s.mu.Unlock()
	}
	mk("cf", QueueAttempt{OCGeneration: 1, TransportClass: QueueAttemptConnectFailed})
	mk("amb", QueueAttempt{OCGeneration: 1, TransportClass: QueueAttemptAccepted2xx})
	mk("heal", QueueAttempt{OCGeneration: 1, TransportClass: QueueAttemptAccepted2xx})

	// Resolver: everything 404s except msg_heal (200 exact user message).
	resolve := func(_ context.Context, _, messageID string) ([]byte, error) {
		if messageID == "msg_heal" {
			return []byte(`{"info":{"id":"msg_heal","role":"user"}}`), nil
		}
		return nil, opencode.ErrMessageNotFound
	}

	// Drive enough passes for the ambiguous budget (reconcileMaxAttempts) to
	// terminalize, pacing past the throttle window between passes. NOTE:
	// assertions on the REQUEUED item read RAW DISK — List() would run
	// stale-dispatch recovery on the fresh requeue (dispatching, timestamp
	// older than the shrunken threshold) and flip it to unknown, which is
	// the LOOP's next input, not a defect.
	if err := srv.certifiedRecoveryPass(root, "s1", tok, resolve); err != nil {
		t.Fatalf("first pass: %v", err)
	}
	rawAfterFirst := readQueueItemsRaw(t, s.path)
	if len(rawAfterFirst) != 3 {
		t.Fatalf("raw items after first pass = %d, want 3", len(rawAfterFirst))
	}
	var cfItem QueueItem
	for _, it := range rawAfterFirst {
		if it.ID == "cf" {
			cfItem = it
		}
	}
	if cfItem.State != QueueDispatching || !cfItem.RequeuePending || cfItem.OpencodeMsgID != "msg_cf" {
		t.Fatalf("C2 item after pass = %+v, want requeued dispatching (same msgid, marker set)", cfItem)
	}
	for i := 0; i < reconcileMaxAttempts+1; i++ {
		if err := srv.certifiedRecoveryPass(root, "s1", tok, resolve); err != nil {
			t.Fatalf("pass %d: %v", i, err)
		}
		time.Sleep(60 * time.Millisecond)
	}

	items, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]QueueItem{}
	for _, it := range items {
		byID[it.ID] = it
	}
	heal := byID["heal"]
	if heal.State != QueueSent {
		t.Fatalf("200-exact item after pass = %+v, want sent (exact-ID GET is the only delivery claim)", heal)
	}
	amb := byID["amb"]
	if amb.State != QueueUnknown || !amb.ReconcileTerminal || !amb.AmbiguousDelivery {
		t.Fatalf("live-uncertain item after budget = %+v, want terminal unknown + AmbiguousDelivery marker (never redelivered)", amb)
	}
	if amb.RequeuePending {
		t.Fatalf("live-uncertain item was REQUEUED — the prohibited auto-redelivery class fired: %+v", amb)
	}
}

// readQueueItemsRaw reads queue.json WITHOUT the store's List-time recovery
// passes — the raw durable state, for asserting shapes (a fresh requeue)
// that List's stale-dispatch recovery would legally mutate.
func readQueueItemsRaw(t *testing.T, path string) []QueueItem {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc queueFile
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Items
}

// TestAcquireInvalidatesStaleLazyLoadCache (T1C-F3): a store cached BEFORE
// custody acquisition must not mask a queue.json write that landed outside
// the epoch — acquisition invalidates the cache and the next custody
// mutation re-reads disk.
func TestAcquireInvalidatesStaleLazyLoadCache(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	path := queuePath(root, "stale")
	st := &sessionQueueStore{path: path}
	mustEnqueue(t, st, "cached-item")

	// Simulate a foreign (pre-epoch legacy browser) write: hand-edit
	// queue.json on disk, adding an item the cached store has never seen.
	st.mu.Lock()
	loaded := st.loaded
	st.mu.Unlock()
	if !loaded {
		t.Fatal("precondition: store must be cached before acquisition")
	}
	foreign := &sessionQueueStore{path: path}
	if _, err := foreign.Enqueue("foreign-item", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}

	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()
	// The registry-level invalidation is what production runs; drive it via
	// the same helper.
	qr := newQueueRegistry()
	qr.stores[storeKey(root, "stale")] = st
	qr.invalidateStoresUnderRoot(root)

	// The next custody mutation must SEE the foreign item: claim twice —
	// the first claims "cached-item", the second "foreign-item". (Claiming
	// both proves the cache was invalidated; a stale cache would claim
	// "cached-item" and then report nothing pending, overwriting the
	// foreign write with the cached view on save.)
	first, won, err := st.ClaimForCustody(tok)
	if err != nil || !won {
		t.Fatalf("first claim: err=%v won=%v", err, won)
	}
	if first.Text != "cached-item" {
		t.Fatalf("first claim = %q, want cached-item (FIFO)", first.Text)
	}
	second, won, err := st.ClaimForCustody(tok)
	if err != nil {
		t.Fatalf("second claim: %v (the invalidated cache must reload disk)", err)
	}
	if !won || second.Text != "foreign-item" {
		t.Fatalf("second claim = %+v won=%v — the pre-epoch foreign write was MASKED by a stale lazy-load cache", second, won)
	}
}

// TestCustodyRefusalCreatesNoFilesystemEffects (tier1_b-F1, the
// Linux-runnable arm): every PRE-LOCK refusal path (capability off; the
// platform gate is the same ordering — see the !linux twin) must fire
// BEFORE the .vh-solara directory is created. Fail-closed means
// fail-BEFORE-effects.
func TestCustodyRefusalCreatesNoFilesystemEffects(t *testing.T) {
	SetQueueCustodyEnabledForTest(false)
	SetDaemonDispatchEnabled(false)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	if _, err := AcquireQueueCustody(root); !errors.Is(err, errQueueCustodyDisabled) {
		t.Fatalf("refusal err = %v, want errQueueCustodyDisabled", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".vh-solara")); !os.IsNotExist(err) {
		t.Fatalf("refusal created .vh-solara (%v) — fail-closed must happen BEFORE any filesystem effect", err)
	}
}

// TestRecordSessionErrorSignalDetailOnly: the projector-pin posture — a
// session.error text is recorded on delivery-uncertain items as a DETAIL
// signal and NEVER changes state.
func TestRecordSessionErrorSignalDetailOnly(t *testing.T) {
	root := t.TempDir()
	s := &sessionQueueStore{path: queuePath(root, "sig")}
	SetStaleDispatchThresholdForTest(50 * time.Millisecond)
	t.Cleanup(func() { SetStaleDispatchThresholdForTest(0) })
	now := time.Now().UnixMilli()
	s.mu.Lock()
	s.load()
	s.order++
	s.items = []QueueItem{
		{ID: "unc", Order: 1, State: QueueUnknown, OpencodeMsgID: "m1"},
		{ID: "sent", Order: 2, State: QueueSent, OpencodeMsgID: "m2"},
		{ID: "inf", Order: 3, State: QueueDispatching, OpencodeMsgID: "m3", DispatchStartedAt: now},
	}
	s.save()
	s.loaded = true
	s.mu.Unlock()

	s.recordSessionErrorSignal("Unknown: the model exploded")

	items, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]QueueItem{}
	for _, it := range items {
		byID[it.ID] = it
	}
	if got := byID["unc"]; got.SessionError == "" || got.SessionErrorAt == 0 || got.State != QueueUnknown {
		t.Fatalf("uncertain item after signal = %+v, want SessionError stamped with state unchanged", got)
	}
	if got := byID["sent"]; got.SessionError != "" {
		t.Fatalf("resolved item received the signal: %+v (only uncertain items carry it)", got)
	}
	if got := byID["inf"]; got.SessionError != "" {
		t.Fatalf("in-flight item received the signal: %+v", got)
	}
}

// TestQueueSessionErrorSignalPipeline (D-F1): the END-TO-END pin. A real
// session.error WIRE event fed through the state pipeline's normal ingestion
// path (Store.Apply → Translate → the reducers' shared status-family arm →
// emit → the subscriber installQueueSessionErrorSignal arms) must stamp
// SessionError/SessionErrorAt on the session's delivery-uncertain queue
// item. The regression this closes: the subscriber originally matched the
// WIRE kind ("session.error"), but the pipeline NORMALIZES the event and
// re-emits it as Kind "status" — no Kind "session.error" ever exists on the
// client-event stream, so SessionError could never populate in production
// (the direct-call test above bypassed the wiring). Status-family payloads
// WITHOUT the error object must not stamp.
func TestQueueSessionErrorSignalPipeline(t *testing.T) {
	const deadURL = "http://127.0.0.1:1"
	agg := aggregator.New(deadURL, 100)
	srv, err := NewServer(agg, deadURL, 100)
	if err != nil {
		t.Fatal(err)
	}
	// LIFO cleanup: agg.Stop FIRST (closes the store's subscribers →
	// retires the signal goroutine → lifecycleWG drains), THEN Shutdown —
	// reversed, Shutdown would wait out its full ctx on the live subscriber.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	t.Cleanup(agg.Stop)

	root := t.TempDir()
	s := srv.queues.store(root, "ses1")
	s.mu.Lock()
	s.load()
	s.order++
	s.items = []QueueItem{
		{ID: "unc", Order: 1, State: QueueUnknown, OpencodeMsgID: "m1"},
		{ID: "sent", Order: 2, State: QueueSent, OpencodeMsgID: "m2"},
	}
	s.save()
	s.loaded = true
	s.mu.Unlock()

	srv.installQueueSessionErrorSignal(root, agg)

	// Discriminator arm: status-family payloads WITHOUT a top-level error
	// object (a session.status busy snapshot; a bare session.error carrying
	// no error detail) must NOT stamp the item.
	agg.Store().Apply(ev("session.status", `{"sessionID":"ses1","status":{"type":"busy"}}`))
	agg.Store().Apply(ev("session.error", `{"sessionID":"ses1"}`))
	time.Sleep(150 * time.Millisecond)
	for _, it := range readQueueItemsRaw(t, s.path) {
		if it.SessionError != "" {
			t.Fatalf("item %s stamped from a status payload without an error object: %+v", it.ID, it)
		}
	}

	// Positive arm: the real wire shape (sst/opencode promptAsync catchCause)
	// through the REAL pipeline.
	agg.Store().Apply(ev("session.error", `{"sessionID":"ses1","error":{"name":"Unknown","message":"the model exploded"}}`))

	var unc, sent QueueItem
	deadline := time.Now().Add(3 * time.Second)
	for {
		unc, sent = QueueItem{}, QueueItem{}
		for _, it := range readQueueItemsRaw(t, s.path) {
			switch it.ID {
			case "unc":
				unc = it
			case "sent":
				sent = it
			}
		}
		if unc.SessionError == "Unknown: the model exploded" && unc.SessionErrorAt != 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("session.error wire event never stamped the uncertain item via the store pipeline (D-F1: subscriber kind/payload mismatch?): unc=%+v", unc)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if unc.State != QueueUnknown {
		t.Fatalf("signal changed item state (signal is detail-only): %+v", unc)
	}
	if sent.SessionError != "" {
		t.Fatalf("resolved item received the signal: %+v (only uncertain items carry it)", sent)
	}
}

// TestAmbiguousTerminalStampsMarker: the passive bump path terminalizing a
// journal-bearing item sets the durable AmbiguousDelivery marker (the FE's
// slice-3 render input); since the slice-5 legacy migration (review B-F1)
// the no-journal (pre-custody legacy) path stamps the SAME marker — legacy
// unknown items upgrade to the distinct ambiguous_absent surface — with the
// pre-custody detail framing.
func TestAmbiguousTerminalStampsMarker(t *testing.T) {
	jour := &sessionQueueStore{path: queuePath(t.TempDir(), "jour")}
	gen := &sessionQueueStore{path: queuePath(t.TempDir(), "gen")}
	seed := func(st *sessionQueueStore, id string, journal bool) {
		st.mu.Lock()
		st.load()
		it := QueueItem{ID: id, Order: 1, State: QueueUnknown, OpencodeMsgID: "m"}
		if journal {
			it.ClaimGeneration = 9
			it.Attempts = []QueueAttempt{{OCGeneration: 1, TransportClass: QueueAttemptAccepted2xx}}
		}
		st.items = []QueueItem{it}
		st.save()
		st.loaded = true
		st.mu.Unlock()
	}
	seed(jour, "ij", true)
	seed(gen, "ig", false)
	for i := 0; i < reconcileMaxAttempts; i++ {
		jour.bumpReconcileAttempt("ij", reconcileTerminal404DetailFmt, restartFenceTerminal404DetailFmt)
		gen.bumpReconcileAttempt("ig", reconcileTerminal404DetailFmt, restartFenceTerminal404DetailFmt)
	}
	items, _ := jour.List()
	if len(items) != 1 || !items[0].ReconcileTerminal || !items[0].AmbiguousDelivery {
		t.Fatalf("journal-bearing terminal = %+v, want ReconcileTerminal + AmbiguousDelivery", items)
	}
	items, _ = gen.List()
	if len(items) != 1 || !items[0].ReconcileTerminal {
		t.Fatalf("legacy terminal = %+v, want terminal", items)
	}
	if !items[0].AmbiguousDelivery {
		t.Fatalf("legacy (no-journal) item missing the ambiguous marker: %+v — slice 5 migrates legacy unknown items to ambiguous_absent (distinct surface, GET-only, never resent)", items[0])
	}
	if !strings.Contains(items[0].Detail, "Pre-custody message") {
		t.Fatalf("legacy terminal detail = %q, want the pre-custody ambiguous framing", items[0].Detail)
	}
}
