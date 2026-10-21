package alerts

// notify_ackfeed_test.go — lane-1 tests for the S2 spool extensions (notify
// controller-hub S2 / v4 §2 steps 3-4): the private-feed page semantics
// (ascending, since-bounded, DURABLE-bounded), the controller watermark ACK
// (idempotent, monotone, never beyond the durable head, coherent retention
// accounting), and the DEFER F1 epoch-label fix on the
// parseable-but-invalid rotation path.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// ackNotice builds a minimal distinguishable notice for feed/ACK tests.
func ackNotice(i int) Notice {
	return Notice{Type: TypeFinished, SessionID: "ses", Title: "t", Detail: "d", Ts: int64(1000 + i)}
}

func appendN(t *testing.T, s *SourceSpool, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := s.Append(ackNotice(i), DetectionContext{Attended: true, IdleSec: 30, ProfileEligible: true}); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}
}

// --- DEFER F1: the parseable-but-invalid rotation names the departed epoch ---

func TestSourceSpoolParseableInvalidNamesDepartedEpoch(t *testing.T) {
	// A document that PARSES and carries a known epoch but fails the
	// sequence invariants (duplicate seqs — damaged, not written by this
	// code) must take the replacement path WITH prevEpoch carrying the
	// departed epoch, so the coverage surface can attribute the rotation
	// gap to the old epoch instead of the fresh one.
	dir := t.TempDir()
	writeSourceDoc(t, dir, sourceFile{
		Epoch: "departed-epoch", LastSeq: 3, FirstSeq: 1,
		Records: []SourceRecord{
			{Seq: 1, Type: TypeFinished, CooldownKey: "w|finished"},
			{Seq: 1, Type: TypeFinished, CooldownKey: "w|finished"}, // duplicate → invalid
		},
	})
	s := NewSourceSpool(dir, "w", 0)
	mustHaveReplaced(t, s, "departed-epoch")
	if got := s.PrevEpoch(); got != "departed-epoch" {
		t.Fatalf("DEFER F1: rotation must name the departed epoch in prevEpoch, got %q", got)
	}

	// The label persists: reload the replacement document and the departed
	// epoch is still nameable (the coverage gap stays attributed).
	s2 := NewSourceSpool(dir, "w", 0)
	if got := s2.PrevEpoch(); got != "departed-epoch" {
		t.Fatalf("prevEpoch must survive the reload, got %q", got)
	}
	if s2.Epoch() == "departed-epoch" || s2.Epoch() != s.Epoch() {
		t.Fatalf("reload must resume the replacement epoch %q, got %q", s.Epoch(), s2.Epoch())
	}
}

func TestSourceSpoolUnparseableRotationKeepsPrevEpochEmpty(t *testing.T) {
	// The counterpart: an UNPARSEABLE document's epoch is unknowable, so
	// prevEpoch stays empty (the honest posture) — the fresh epoch value is
	// the discontinuity signal.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notify-source.json"), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewSourceSpool(dir, "w", 0)
	mustHaveReplaced(t, s, "")
	if got := s.PrevEpoch(); got != "" {
		t.Fatalf("unparseable rotation must keep prevEpoch empty, got %q", got)
	}
}

// --- ACK: idempotence, monotonicity, durable-head bound ---

func TestSourceSpoolAckWatermarkIdempotentAndMonotone(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)
	appendN(t, s, 5) // durable seqs 1..5

	trimmed, err := s.AckWatermark(3)
	if err != nil {
		t.Fatalf("ACK 3: %v", err)
	}
	if trimmed != 3 {
		t.Fatalf("ACK 3 must trim the 3 consumed records, got %d", trimmed)
	}
	if s.AckedSeq() != 3 || s.AckedTrimTotal() != 3 || s.FirstSeq() != 4 {
		t.Fatalf("post-ACK state: acked=%d trim=%d firstSeq=%d (want 3/3/4)", s.AckedSeq(), s.AckedTrimTotal(), s.FirstSeq())
	}

	// Idempotent replay (the lost-ACK retry shape): no-op success.
	trimmed, err = s.AckWatermark(3)
	if err != nil || trimmed != 0 {
		t.Fatalf("replayed ACK 3 must be a no-op success, got trimmed=%d err=%v", trimmed, err)
	}
	// Older watermark (delayed duplicate): never regresses.
	if _, err = s.AckWatermark(1); err != nil {
		t.Fatalf("older ACK 1: %v", err)
	}
	if s.AckedSeq() != 3 {
		t.Fatalf("ackedSeq must never regress, got %d", s.AckedSeq())
	}
	// Partial overlap: 4 and 5 still retained.
	if got := s.FeedPage(0, 100); len(got) != 2 || got[0].Seq != 4 || got[1].Seq != 5 {
		t.Fatalf("post-ACK feed must serve 4..5, got %+v", got)
	}

	// New append, then ACK everything: the ACK-all shape.
	appendN(t, s, 1) // seq 6
	if _, err = s.AckWatermark(6); err != nil {
		t.Fatalf("ACK 6: %v", err)
	}
	if got := s.FeedPage(0, 100); len(got) != 0 {
		t.Fatalf("ACK-all must trim every retained record, got %+v", got)
	}
	if s.FirstSeq() != 7 || s.AckedTrimTotal() != 6 {
		t.Fatalf("ACK-all accounting: firstSeq=%d ackedTrim=%d (want 7/6)", s.FirstSeq(), s.AckedTrimTotal())
	}
	// Appends resume cleanly after ACK-all.
	appendN(t, s, 1) // seq 7
	if got := s.FeedPage(0, 100); len(got) != 1 || got[0].Seq != 7 {
		t.Fatalf("post-ACK-all append must resume at seq 7, got %+v", got)
	}
	if s.OverflowTotal() != 0 {
		t.Fatalf("ACK trims must not count as capacity overflow, got %d", s.OverflowTotal())
	}
}

func TestSourceSpoolAckBeyondDurableHeadRefused(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)

	// Sabotage the persist target so appends land in memory only.
	path := filepath.Join(dir, "notify-source.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	rec, err := s.Append(ackNotice(0), DetectionContext{})
	if err == nil {
		t.Fatal("append must surface the persist failure")
	}
	if rec.Seq != 1 {
		t.Fatalf("in-memory identity still allocated, got seq %d", rec.Seq)
	}
	// The undurable record exists in memory but seq 1 > durableSeq 0.
	_, err = s.AckWatermark(1)
	if !errors.Is(err, ErrAckBeyondDurableHead) {
		t.Fatalf("ACK of an undurable seq must fail with ErrAckBeyondDurableHead, got %v", err)
	}
	// v4 §9.8: never ACK non-durable events — and never TRIM them either.
	if s.AckedSeq() != 0 || s.AckedTrimTotal() != 0 {
		t.Fatalf("refused ACK must change nothing, got acked=%d trim=%d", s.AckedSeq(), s.AckedTrimTotal())
	}

	// Recover persistence (clear the directory), land the record durably,
	// and the same watermark is now acceptable.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append(ackNotice(1), DetectionContext{}); err != nil {
		t.Fatalf("recovery append: %v", err)
	}
	if _, err := s.AckWatermark(1); err != nil {
		t.Fatalf("ACK 1 after the record became durable: %v", err)
	}
}

func TestSourceSpoolAckPersistFailureRetriedOnReplay(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)
	appendN(t, s, 3)

	// Sabotage: the tmp staging path is a directory, so the ACK persist
	// fails while the in-memory watermark was applied (ackDirty armed).
	tmp := filepath.Join(dir, "notify-source.json.tmp")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AckWatermark(2); err == nil {
		t.Fatal("ACK with a sabotaged persist must surface the failure")
	}
	if s.AckedSeq() != 2 {
		t.Fatalf("in-memory watermark applied despite the persist failure, got %d", s.AckedSeq())
	}
	if s.LastPersistError() == "" {
		t.Fatal("the failed ACK persist must be visible on LastPersistError")
	}

	// Repair and REPLAY the same watermark: the otherwise-idempotent call
	// must retry the persist (ackDirty) — a watermark is never reported
	// durable while it exists in memory only.
	if err := os.Remove(tmp); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AckWatermark(2); err != nil {
		t.Fatalf("replayed ACK must retry the persist: %v", err)
	}
	// A1: the SUCCESSFUL retry must clear the visible error surface too —
	// the old `if applied` guard left the stale "ack persist failed"
	// error on this path even though the retry had just repaired it.
	if s.LastPersistError() != "" {
		t.Fatalf("successful ackDirty-retry persist must clear LastPersistError, got %q", s.LastPersistError())
	}
	// The retry also landed the trimmed prefix: reload and verify.
	s2 := NewSourceSpool(dir, "w", 0)
	if s2.AckedSeq() != 2 || s2.AckedTrimTotal() != 2 || s2.FirstSeq() != 3 {
		t.Fatalf("reloaded ACK state: acked=%d trim=%d firstSeq=%d (want 2/2/3)", s2.AckedSeq(), s2.AckedTrimTotal(), s2.FirstSeq())
	}
}

func TestSourceSpoolAckStateSurvivesReload(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)
	appendN(t, s, 6)
	if _, err := s.AckWatermark(2); err != nil {
		t.Fatal(err)
	}
	s2 := NewSourceSpool(dir, "w", 0)
	if s2.AckedSeq() != 2 || s2.AckedTrimTotal() != 2 || s2.FirstSeq() != 3 || s2.LastSeq() != 6 {
		t.Fatalf("reload must preserve ACK state, got acked=%d trim=%d first=%d last=%d",
			s2.AckedSeq(), s2.AckedTrimTotal(), s2.FirstSeq(), s2.LastSeq())
	}
	if got := s2.FeedPage(0, 100); len(got) != 4 || got[0].Seq != 3 {
		t.Fatalf("reloaded feed must resume past the ACKed prefix, got %+v", got)
	}
	// A reload may ACK further (the cursor is durable).
	if _, err := s2.AckWatermark(4); err != nil {
		t.Fatal(err)
	}
	if got := s2.FeedPage(0, 100); len(got) != 2 || got[0].Seq != 5 {
		t.Fatalf("post-reload ACK must trim, got %+v", got)
	}
}

// --- coherent retention accounting under mixed trims + capacity eviction ---

func TestSourceSpoolMixedAckAndOverflowAccounting(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 4) // tight cap forces capacity eviction
	appendN(t, s, 4)
	if _, err := s.AckWatermark(1); err != nil { // ACK trim: ackedTrim=1
		t.Fatal(err)
	}
	appendN(t, s, 2) // seqs 5,6 → capacity evicts seq 2 (overflow=1)
	if s.OverflowTotal() != 1 || s.AckedTrimTotal() != 1 || s.FirstSeq() != 3 {
		t.Fatalf("mixed accounting: overflow=%d ackedTrim=%d firstSeq=%d (want 1/1/3)",
			s.OverflowTotal(), s.AckedTrimTotal(), s.FirstSeq())
	}
	if s.OverflowTotal()+s.AckedTrimTotal() != s.FirstSeq()-1 {
		t.Fatal("invariant overflow+ackedTrim == firstSeq-1 must hold under mixed removal")
	}
	// The persisted document reloads coherently (validateSourceFile accepts).
	s2 := NewSourceSpool(dir, "w", 0)
	if s2.OverflowTotal() != 1 || s2.AckedTrimTotal() != 1 || s2.FirstSeq() != 3 {
		t.Fatalf("mixed accounting must survive reload, got overflow=%d ackedTrim=%d first=%d",
			s2.OverflowTotal(), s2.AckedTrimTotal(), s2.FirstSeq())
	}
}

// --- feed page semantics ---

func TestSourceSpoolFeedPageSemantics(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)
	appendN(t, s, 10)

	// Full page from the oldest retained record.
	got := s.FeedPage(0, 100)
	if len(got) != 10 || got[0].Seq != 1 || got[9].Seq != 10 {
		t.Fatalf("full feed: %+v", got)
	}
	// Cursor: strictly above since_seq.
	got = s.FeedPage(7, 100)
	if len(got) != 3 || got[0].Seq != 8 || got[2].Seq != 10 {
		t.Fatalf("since-bounded feed: %+v", got)
	}
	// since at/beyond the head: empty page.
	if got = s.FeedPage(10, 100); len(got) != 0 {
		t.Fatalf("beyond-head cursor must be empty, got %+v", got)
	}
	// Limit bounds the page.
	got = s.FeedPage(0, 3)
	if len(got) != 3 || got[0].Seq != 1 || got[2].Seq != 3 {
		t.Fatalf("limited feed: %+v", got)
	}
	// Non-positive limit defensively becomes the documented default.
	if got = s.FeedPage(9, 0); len(got) != 1 || got[0].Seq != 10 {
		t.Fatalf("zero-limit default: %+v", got)
	}
	// The returned slice is a copy — mutating it must not alias spool state.
	got = s.FeedPage(0, 1)
	got[0].Title = "tampered"
	if again := s.FeedPage(0, 1); again[0].Title == "tampered" {
		t.Fatal("FeedPage must return copies, not aliases")
	}
	// Records carry the detection-time snapshot (v4 (h)) and numeric ts.
	rec := s.FeedPage(0, 1)[0]
	if !rec.Attended || rec.IdleSec != 30 || !rec.ProfileEligible || rec.Ts < 1000 {
		t.Fatalf("record snapshot mismatch: %+v", rec)
	}
	if rec.CooldownKey != "w|"+TypeFinished {
		t.Fatalf("cooldown key must be source-prefixed, got %q", rec.CooldownKey)
	}
}

func TestSourceSpoolFeedPageDurableBound(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)
	appendN(t, s, 2)

	// Sabotage persistence; two more records live in memory only.
	path := filepath.Join(dir, "notify-source.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append(ackNotice(2), DetectionContext{}); err == nil {
		t.Fatal("append must fail to persist")
	}
	if _, err := s.Append(ackNotice(3), DetectionContext{}); err == nil {
		t.Fatal("append must fail to persist")
	}
	if s.LastSeq() != 4 {
		t.Fatalf("in-memory allocations happened, lastSeq=%d", s.LastSeq())
	}
	// The feed serves ONLY the durable prefix (1..2) — never the undurable
	// tail, no matter the limit or cursor.
	if got := s.FeedPage(0, 100); len(got) != 2 || got[1].Seq != 2 {
		t.Fatalf("feed must stop at the durable head, got %+v", got)
	}
	if got := s.FeedPage(2, 100); len(got) != 0 {
		t.Fatalf("undurable tail must never feed, got %+v", got)
	}
	// LookupBySeq upholds the same bound structurally.
	if _, ok := s.LookupBySeq(3); ok {
		t.Fatal("LookupBySeq must refuse an undurable seq")
	}
	if _, ok := s.LookupBySeq(2); !ok {
		t.Fatal("LookupBySeq must serve a durable seq")
	}
}

// --- B1: the empty-page cursor race (single-snapshot atomicity) ---

// oldTwoLockFeedPage reproduces serveFeed's PRE-B1 composition exactly: the
// page and the cursor come from TWO separate spool critical sections. It is
// retained here (test-only) as the defect's executable documentation and the
// red-check target — the production path is FeedSnapshot.
func oldTwoLockFeedPage(s *SourceSpool, since int64, limit int) ([]SourceRecord, int64) {
	records := s.FeedPage(since, limit) // lock #1
	next := since
	if d := s.DurableSeq(); d > next { // lock #2 — a concurrent Append can land here
		next = d
	}
	if n := len(records); n > 0 {
		next = records[n-1].Seq
	}
	return records, next
}

// TestSourceSpoolFeedSnapshotAtomicCursorUnderAppend proves the B1 fix: the
// page and the cursor of a feed response describe ONE spool state, so the
// empty-page cursor can never skip a durable record. In the old two-lock
// composition an empty page read at durable head N, a concurrent Append
// durably landing N+1 between the two locks, and DurableSeq then reading
// N+1 produced records=[] + nextSince=N+1 — the next fetch (seq > N+1)
// skipped record N+1 forever, with no overflow/trim marker naming it.
func TestSourceSpoolFeedSnapshotAtomicCursorUnderAppend(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)
	appendN(t, s, 3) // durable head 3

	// (a) DETERMINISTIC interleaving, forced in the OLD order: the page
	// read first, then the append, then the durable head. The two-lock
	// composition reproduces the skip exactly (precondition — if this ever
	// stops reproducing, the reproduction below has rotted and must be
	// fixed, not deleted).
	records, next := oldTwoLockFeedPage(s, 3, 10) // lock #1: empty at head 3
	if len(records) != 0 || next != 3 {
		t.Fatalf("precondition: page at head 3 must be empty with cursor 3, got %+v next=%d", records, next)
	}
	appendN(t, s, 1) // interleaved Append: seq 4 becomes durable
	// The old composition's SECOND lock (DurableSeq) now observes head 4 —
	// composing it with the STALE empty page from lock #1 IS the skip:
	// records=[] + nextSince=4 ⇒ the next fetch (seq>4) never serves 4.
	if headAfter := s.DurableSeq(); headAfter != 4 {
		t.Fatalf("precondition: the post-append durable head is 4, got %d", headAfter)
	}

	// (b) The SNAPSHOT composition cannot produce that shape — same
	// interleaving, one lock hold: either the record is present, or the
	// cursor parks at the head the EMPTY page was taken at.
	if snap := s.FeedSnapshot(3, 10); len(snap.Records) != 1 || snap.Records[0].Seq != 4 || snap.NextSince != 4 {
		t.Fatalf("snapshot after the append must serve seq 4, got %+v next=%d", snap.Records, snap.NextSince)
	}
	// Empty-page boundary at the caught-up cursor: parks AT the durable
	// head the page itself observed (4), never past it.
	if snap := s.FeedSnapshot(4, 10); len(snap.Records) != 0 || snap.NextSince != 4 {
		t.Fatalf("caught-up snapshot must be empty with cursor at the durable head, got %+v next=%d", snap.Records, snap.NextSince)
	}

	// (c) CONCURRENT hammer: appends race cursor-following snapshots; every
	// snapshot must satisfy the per-response invariant (no trims, no cap
	// eviction in this fixture ⇒ an empty page can only park at its OWN
	// cursor). limit covers the whole spool so emptiness is unambiguous.
	const hammerAppends = 400
	hammerDir := t.TempDir()
	hs := NewSourceSpool(hammerDir, "w", 0)
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // appender: durably lands seqs 1..hammerAppends
		defer wg.Done()
		defer close(done)
		for i := 0; i < hammerAppends; i++ {
			if _, err := hs.Append(ackNotice(i), DetectionContext{}); err != nil {
				t.Errorf("hammer Append %d: %v", i, err)
				return
			}
		}
	}()
	wg.Add(1)
	go func() { // snapshotter: follows the cursor like the controller pull
		defer wg.Done()
		since := int64(0)
		for {
			// limit 50: the invariants hold per page regardless of size;
			// a bounded page keeps the polling loop's allocation gentle.
			snap := hs.FeedSnapshot(since, 50)
			if len(snap.Records) == 0 {
				// B1 crux: an empty page must park at the cursor the EMPTY
				// page was taken at — never at a head an interleaved
				// append advanced past it.
				if snap.NextSince != since {
					t.Errorf("B1 SKIP SHAPE: empty page with nextSince=%d > since=%d", snap.NextSince, since)
					return
				}
			} else {
				last := snap.Records[len(snap.Records)-1].Seq
				if snap.NextSince != last {
					t.Errorf("non-empty page cursor must be the last record %d, got %d", last, snap.NextSince)
					return
				}
				for _, r := range snap.Records {
					if r.Seq <= since {
						t.Errorf("record %d not strictly above cursor %d", r.Seq, since)
						return
					}
				}
				since = snap.NextSince
			}
			select {
			case <-done:
				// Drain to the final head, then stop.
				for {
					snap := hs.FeedSnapshot(since, 50)
					if len(snap.Records) == 0 {
						if snap.NextSince != since {
							t.Errorf("final drain: empty page nextSince=%d since=%d", snap.NextSince, since)
						}
						return
					}
					since = snap.Records[len(snap.Records)-1].Seq
				}
			default:
				time.Sleep(20 * time.Microsecond)
			}
		}
	}()
	wg.Wait()

	// Every append reported durable must be drainable afterwards — no seq
	// was silently skipped by any cursor the hammer observed.
	final := hs.FeedSnapshot(0, hammerAppends+100)
	if want := int64(hammerAppends); final.Meta.DurableSeq != want || final.NextSince != want {
		t.Fatalf("hammer end state: durable=%d next=%d, want %d", final.Meta.DurableSeq, final.NextSince, want)
	}
	var seqs []int64
	drainSince := int64(0)
	for {
		snap := hs.FeedSnapshot(drainSince, 50)
		if len(snap.Records) == 0 {
			break
		}
		for _, r := range snap.Records {
			seqs = append(seqs, r.Seq)
		}
		drainSince = snap.Records[len(snap.Records)-1].Seq
	}
	for i, sq := range seqs {
		if sq != int64(i+1) {
			t.Fatalf("hammer drain must deliver every seq ascending: position %d got %d", i, sq)
		}
	}
}

// --- validateSourceFile: the S2 ACK shapes and S1 back-compat ---

func TestValidateSourceFileAckShapes(t *testing.T) {
	mk := func(f sourceFile) []byte {
		b, err := json.Marshal(f)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	rec := func(seq int64) SourceRecord { return SourceRecord{Seq: seq, Type: TypeFinished} }

	// The ACK-all document: no records, everything consumed.
	all := sourceFile{Epoch: "e", LastSeq: 6, FirstSeq: 7, AckedSeq: 6, AckedTrim: 6}
	if err := validateSourceFile(mk(all), &all); err != nil {
		t.Fatalf("ACK-all document must validate: %v", err)
	}

	// S1 back-compat: no ackedSeq/ackedTrim fields decode as 0 and the
	// legacy overflow == firstSeq-1 rule holds.
	var s1 sourceFile
	if err := json.Unmarshal(mk(sourceFile{Epoch: "e", LastSeq: 3, FirstSeq: 2, Overflow: 1, Records: []SourceRecord{rec(2), rec(3)}}), &s1); err != nil {
		t.Fatal(err)
	}
	if err := validateSourceFile(mk(s1), &s1); err != nil {
		t.Fatalf("S1 document must still validate: %v", err)
	}

	bad := []sourceFile{
		// ackedSeq beyond lastSeq.
		{Epoch: "e", LastSeq: 3, FirstSeq: 4, AckedSeq: 4, AckedTrim: 3},
		// ACK-all without the watermark at the head.
		{Epoch: "e", LastSeq: 3, FirstSeq: 4, AckedSeq: 2, AckedTrim: 3},
		// ACK-all with incoherent accounting.
		{Epoch: "e", LastSeq: 3, FirstSeq: 4, AckedSeq: 3, AckedTrim: 2},
		// Fresh epoch (nothing allocated) with ACK state set.
		{Epoch: "e", LastSeq: 0, FirstSeq: 1, AckedSeq: 0, AckedTrim: 1},
		// Retained records with incoherent accounting (S1 rule violated via ackedTrim).
		{Epoch: "e", LastSeq: 3, FirstSeq: 2, Overflow: 0, AckedSeq: 0, AckedTrim: 2, Records: []SourceRecord{rec(2), rec(3)}},
		// Negative watermark.
		{Epoch: "e", LastSeq: 3, FirstSeq: 4, AckedSeq: -1, AckedTrim: 3},
	}
	for i, f := range bad {
		var probe sourceFile
		if err := json.Unmarshal(mk(f), &probe); err != nil {
			t.Fatal(err)
		}
		if err := validateSourceFile(mk(f), &probe); err == nil {
			t.Fatalf("case %d: %+v must be rejected", i, f)
		}
	}
}
