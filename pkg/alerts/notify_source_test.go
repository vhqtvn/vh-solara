package alerts

// notify_source_test.go — lane-1 tests for the durable worker notice source
// (notify controller-hub S1 / v4 §9.2, §9.8): durable identity, crash
// recovery, epoch rotation ONLY on genuine replacement, overflow accounting,
// visible persistence failures, and the detection-time snapshot the engine
// captures into every record.

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func mustAppend(t *testing.T, s *SourceSpool, n Notice, dctx DetectionContext) SourceRecord {
	t.Helper()
	// The bare-spool posture (spool without a ring): no correlation key is
	// stamped — the ring-carrying tap is pinned by the dedicated t1b tests.
	rec, err := s.Append(n, dctx)
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	return rec
}

// writeSourceDoc plants a handcrafted document at the spool path — the
// on-disk shapes this code would never write itself (damaged docs for the
// t1b-F1 validation regressions).
func writeSourceDoc(t *testing.T, dir string, doc sourceFile) {
	t.Helper()
	b, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notify-source.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// mustHaveReplaced asserts the spool took the GENUINE-REPLACEMENT path for a
// damaged document: fresh epoch (never the damaged doc's), allocation counter
// reset, rotation discontinuity stamped, replacement head persisted cleanly.
func mustHaveReplaced(t *testing.T, s *SourceSpool, docEpoch string) {
	t.Helper()
	if s.Epoch() == docEpoch {
		t.Fatalf("invalid doc must NOT be loaded under its persisted epoch %q", docEpoch)
	}
	if s.LastSeq() != 0 {
		t.Fatalf("replacement must reset the allocation counter, got lastSeq %d", s.LastSeq())
	}
	if s.RotatedAt() == 0 {
		t.Fatal("replacement must stamp the rotation discontinuity (rotatedAt)")
	}
	if got := s.LastPersistError(); got != "" {
		t.Fatalf("replacement init must persist cleanly, got %q", got)
	}
}

// TestSourceSpoolAppendPersistsIdentityAndContext pins the §2-step-1 record:
// the notice payload, numeric ts, attendance snapshot, profile eligibility,
// and the source-prefixed cooldown key — persisted under the (epoch, seq)
// identity.
func TestSourceSpoolAppendPersistsIdentityAndContext(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "bason", 0)
	dctx := DetectionContext{Attended: true, IdleSec: 120, ProfileEligible: true}
	rec := mustAppend(t, s, Notice{
		Type: TypeWaiting, Kind: KindQuestion, SessionID: "s1", Root: "s1",
		Project: "/w", Title: "Review requested", Detail: "Question pending", Ts: 1792454400000,
	}, dctx)

	if rec.Seq != 1 {
		t.Fatalf("first seq = %d, want 1", rec.Seq)
	}
	if rec.Kind != KindQuestion || rec.Attended != true || rec.IdleSec != 120 || rec.ProfileEligible != true {
		t.Fatalf("detection context drift: %+v", rec)
	}
	if rec.CooldownKey != "bason|waiting" {
		t.Fatalf("cooldown key = %q, want bason|waiting", rec.CooldownKey)
	}
	if rec.Ts != 1792454400000 {
		t.Fatalf("record payload drift: %+v", rec)
	}
	if s.LastSeq() != 1 || s.Epoch() == "" {
		t.Fatalf("head drift: lastSeq=%d epoch=%q", s.LastSeq(), s.Epoch())
	}

	// The persisted document carries the same identity + record.
	raw, err := os.ReadFile(filepath.Join(dir, "notify-source.json"))
	if err != nil {
		t.Fatalf("spool file: %v", err)
	}
	var f sourceFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("spool doc: %v", err)
	}
	if f.Epoch != s.Epoch() || f.LastSeq != 1 || len(f.Records) != 1 || f.Records[0].Seq != 1 {
		t.Fatalf("persisted doc drift: %+v", f)
	}
	// Timestamps stay NUMERIC in the durable source (v4 (b): only the public
	// DTO stringifies).
	if f.Records[0].Ts != 1792454400000 {
		t.Fatalf("persisted ts not numeric: %+v", f.Records[0])
	}
}

// TestSourceSpoolCrashRecoverySeqContinuesEpochStable pins §9.2's
// epoch-stability rule: an ordinary restart (reload from the same file)
// preserves the epoch and continues the seq — no seq reuse, no epoch rotation.
func TestSourceSpoolCrashRecoverySeqContinuesEpochStable(t *testing.T) {
	dir := t.TempDir()
	s1 := NewSourceSpool(dir, "w", 0)
	mustAppend(t, s1, Notice{Type: TypeFinished, Ts: 1}, DetectionContext{})
	mustAppend(t, s1, Notice{Type: TypeFinished, Ts: 2}, DetectionContext{})
	firstEpoch := s1.Epoch()

	// "Crash": a fresh instance loads only what was persisted.
	s2 := NewSourceSpool(dir, "w", 0)
	if s2.Epoch() != firstEpoch {
		t.Fatalf("epoch rotated across ordinary restart: %q -> %q", firstEpoch, s2.Epoch())
	}
	if s2.LastSeq() != 2 {
		t.Fatalf("lastSeq after reload = %d, want 2", s2.LastSeq())
	}
	rec := mustAppend(t, s2, Notice{Type: TypeFinished, Ts: 3}, DetectionContext{})
	if rec.Seq != 3 {
		t.Fatalf("seq after restart = %d, want 3 (continues, no reuse)", rec.Seq)
	}
	if _, ok := s2.LookupBySeq(1); !ok {
		t.Fatal("reloaded spool lost a retained record")
	}
}

// TestSourceSpoolEpochRotatesOnlyOnGenuineReplacement pins that a CORRUPT
// spool (unreadable state = genuine source replacement, §9.2) rotates the
// epoch and resets seq — while a healthy reload never does.
func TestSourceSpoolEpochRotatesOnlyOnGenuineReplacement(t *testing.T) {
	dir := t.TempDir()
	s1 := NewSourceSpool(dir, "w", 0)
	mustAppend(t, s1, Notice{Type: TypeFinished, Ts: 1}, DetectionContext{})
	oldEpoch := s1.Epoch()

	// Corrupt the persisted document.
	path := filepath.Join(dir, "notify-source.json")
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s2 := NewSourceSpool(dir, "w", 0)
	if s2.Epoch() == oldEpoch {
		t.Fatal("corrupt spool must rotate the epoch")
	}
	if s2.LastSeq() != 0 {
		t.Fatalf("seq after rotation = %d, want reset to 0", s2.LastSeq())
	}
	rec := mustAppend(t, s2, Notice{Type: TypeFinished, Ts: 2}, DetectionContext{})
	if rec.Seq != 1 {
		t.Fatalf("seq after rotation restarts at 1, got %d", rec.Seq)
	}

	// The rotation is detectable centrally: rotatedAt is stamped in the doc.
	raw, _ := os.ReadFile(path)
	var f sourceFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("post-rotation doc unreadable: %v", err)
	}
	if f.RotatedAt == 0 || f.Epoch != s2.Epoch() {
		t.Fatalf("rotation not persisted: %+v", f)
	}
}

// TestSourceSpoolInvalidDocMissingLastSeqRejected is the t1b-F1 regression
// (a): a parseable document that carries a record but NO lastSeq field must
// be rejected to the genuine-replacement path — fresh epoch, rotation
// stamped — never loaded as-is. Loading it would reset the allocation
// counter to 0, and the next Append would re-allocate AND persist seq 1
// under the SAME epoch: two durable records sharing one (source, epoch,
// seq) identity (the LookupBySeq join and future controller dedupe would
// silently resolve/drop the wrong notice).
func TestSourceSpoolInvalidDocMissingLastSeqRejected(t *testing.T) {
	dir := t.TempDir()
	s1 := NewSourceSpool(dir, "w", 0)
	mustAppend(t, s1, Notice{Type: TypeFinished, Ts: 1}, DetectionContext{})
	oldEpoch := s1.Epoch()

	// Damage the PERSISTED document: identical content, lastSeq dropped
	// (the reviewer's exact shape — records survive, head counter lost).
	path := filepath.Join(dir, "notify-source.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	delete(doc, "lastSeq")
	damaged, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, damaged, 0o600); err != nil {
		t.Fatal(err)
	}

	// Reload + one append, then scan the PERSISTED document. The scan runs
	// FIRST so a regression to the accepting loader fails on the
	// identity-reuse symptom itself, not just a downstream assertion.
	s2 := NewSourceSpool(dir, "w", 0)
	mustAppend(t, s2, Notice{Type: TypeFinished, Ts: 2}, DetectionContext{})
	raw2, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f2 sourceFile
	if err := json.Unmarshal(raw2, &f2); err != nil {
		t.Fatal(err)
	}
	seen := make(map[int64]int, len(f2.Records))
	for _, r := range f2.Records {
		seen[r.Seq]++
		if seen[r.Seq] > 1 {
			t.Fatalf("identity reuse: seq %d appears %d times under epoch %q — one durable (epoch, seq) identity must map to exactly one record",
				r.Seq, seen[r.Seq], f2.Epoch)
		}
	}

	// The rejection routed to genuine replacement: fresh epoch (never the
	// damaged doc's), rotation stamped, only the post-replacement record
	// retained under the fresh epoch.
	if s2.Epoch() == oldEpoch {
		t.Fatal("damaged doc (missing lastSeq) must be rejected to a fresh epoch, not loaded")
	}
	if s2.RotatedAt() == 0 {
		t.Fatal("rejection must stamp the rotation discontinuity (rotatedAt)")
	}
	if len(f2.Records) != 1 || f2.Records[0].Seq != 1 || f2.Epoch != s2.Epoch() {
		t.Fatalf("post-replacement doc = %+v, want exactly one record (seq 1) under the fresh epoch", f2)
	}
}

// TestSourceSpoolInvalidDocRegressedLastSeqRejected is regression (b): a doc
// whose lastSeq trails its own retained records (1 < 2) is damaged — loading
// it would re-allocate seq 2 on the next Append. Rejected to the replacement
// path.
func TestSourceSpoolInvalidDocRegressedLastSeqRejected(t *testing.T) {
	dir := t.TempDir()
	writeSourceDoc(t, dir, sourceFile{
		Epoch: "ep-regressed", LastSeq: 1, FirstSeq: 1,
		Records: []SourceRecord{{Seq: 1, Type: TypeFinished}, {Seq: 2, Type: TypeFinished}},
	})
	mustHaveReplaced(t, NewSourceSpool(dir, "w", 0), "ep-regressed")
}

// TestSourceSpoolInvalidDocDuplicateSeqsRejected is regression (c): two
// retained records claiming the same seq already violate the one-identity-
// one-record invariant inside the document itself. Rejected to the
// replacement path.
func TestSourceSpoolInvalidDocDuplicateSeqsRejected(t *testing.T) {
	dir := t.TempDir()
	writeSourceDoc(t, dir, sourceFile{
		Epoch: "ep-dup", LastSeq: 2, FirstSeq: 1,
		Records: []SourceRecord{{Seq: 1, Type: TypeFinished}, {Seq: 1, Type: TypeWaiting}},
	})
	mustHaveReplaced(t, NewSourceSpool(dir, "w", 0), "ep-dup")
}

// TestSourceSpoolInvalidDocUnorderedSeqsRejected is regression (d): record
// seqs out of order in the slice break the binary-search join contract.
// Rejected to the replacement path.
func TestSourceSpoolInvalidDocUnorderedSeqsRejected(t *testing.T) {
	dir := t.TempDir()
	writeSourceDoc(t, dir, sourceFile{
		Epoch: "ep-unordered", LastSeq: 2, FirstSeq: 2, Overflow: 1,
		Records: []SourceRecord{{Seq: 2, Type: TypeFinished}, {Seq: 1, Type: TypeWaiting}},
	})
	mustHaveReplaced(t, NewSourceSpool(dir, "w", 0), "ep-unordered")
}

// TestSourceSpoolInvalidDocShapesRejectedToReplacement sweeps the remaining
// validator rules over raw handcrafted documents (shapes persistLocked never
// writes): every damaged shape routes to the replacement path, while the
// minimal VALID empty document keeps epoch continuity (the firstSeq-0
// normalization the loader has always tolerated).
func TestSourceSpoolInvalidDocShapesRejectedToReplacement(t *testing.T) {
	invalid := []struct {
		name string
		doc  string
	}{
		{"negative lastSeq", `{"epoch":"ep-neg","lastSeq":-1,"firstSeq":1,"overflow":0,"records":null}`},
		{"non-positive record seq", `{"epoch":"ep-zero","lastSeq":1,"firstSeq":1,"overflow":0,"records":[{"seq":0},{"seq":1}]}`},
		{"interior seq gap", `{"epoch":"ep-gap","lastSeq":3,"firstSeq":1,"overflow":0,"records":[{"seq":1},{"seq":3}]}`},
		{"firstSeq contradicts slice", `{"epoch":"ep-fseq","lastSeq":2,"firstSeq":2,"overflow":1,"records":[{"seq":1},{"seq":2}]}`},
		{"overflow contradicts firstSeq", `{"epoch":"ep-ovf","lastSeq":2,"firstSeq":1,"overflow":5,"records":[{"seq":1},{"seq":2}]}`},
		{"empty records but lastSeq", `{"epoch":"ep-empty","lastSeq":4,"firstSeq":5,"overflow":4,"records":null}`},
		{"lastSeq null", `{"epoch":"ep-null","lastSeq":null,"firstSeq":1,"overflow":0,"records":null}`},
		{"slice ends short of lastSeq", `{"epoch":"ep-short","lastSeq":5,"firstSeq":1,"overflow":0,"records":[{"seq":1},{"seq":2}]}`},
	}
	for _, tc := range invalid {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "notify-source.json"), []byte(tc.doc), 0o600); err != nil {
				t.Fatal(err)
			}
			var f sourceFile
			if err := json.Unmarshal([]byte(tc.doc), &f); err != nil {
				t.Fatalf("premise: doc must be parseable: %v", err)
			}
			mustHaveReplaced(t, NewSourceSpool(dir, "w", 0), f.Epoch)
		})
	}

	// The minimal VALID empty document loads with continuity: same epoch,
	// allocation resumes from 0, no rotation.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notify-source.json"), []byte(`{"epoch":"ep-min","lastSeq":0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewSourceSpool(dir, "w", 0)
	if s.Epoch() != "ep-min" || s.LastSeq() != 0 || s.RotatedAt() != 0 {
		t.Fatalf("valid minimal doc must load with continuity: epoch=%q lastSeq=%d rotatedAt=%d",
			s.Epoch(), s.LastSeq(), s.RotatedAt())
	}
	if rec := mustAppend(t, s, Notice{Type: TypeFinished, Ts: 1}, DetectionContext{}); rec.Seq != 1 {
		t.Fatalf("seq after minimal-doc load = %d, want 1", rec.Seq)
	}
}

// TestSourceSpoolOverflowEvictsOldestWithAccounting pins §9.8: a bounded
// spool evicts the OLDEST records and the eviction is ACCOUNTED (overflow
// total + firstSeq head floor) — never silent.
func TestSourceSpoolOverflowEvictsOldestWithAccounting(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 3) // small bound for the test
	for i := 0; i < 5; i++ {
		mustAppend(t, s, Notice{Type: TypeFinished, Ts: int64(i + 1)}, DetectionContext{})
	}
	if got := s.OverflowTotal(); got != 2 {
		t.Fatalf("overflow total = %d, want 2", got)
	}
	if got := s.FirstSeq(); got != 3 {
		t.Fatalf("firstSeq = %d, want 3 (oldest retained)", got)
	}
	if _, ok := s.LookupBySeq(1); ok {
		t.Fatal("evicted record must not resolve")
	}
	if _, ok := s.LookupBySeq(3); !ok {
		t.Fatal("retained record must resolve")
	}
	// lastSeq keeps counting: seqs are never reused.
	rec := mustAppend(t, s, Notice{Type: TypeFinished, Ts: 9}, DetectionContext{})
	if rec.Seq != 6 {
		t.Fatalf("seq after overflow = %d, want 6", rec.Seq)
	}
}

// TestSourceSpoolPersistFailureVisible pins the §9.8 visibility bar: a
// persistence failure is RETURNED from Append and exposed on
// LastPersistError — never silently acknowledged as durable.
func TestSourceSpoolPersistFailureVisible(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)

	// Sabotage the persist target after construction: replace the spool
	// file with a directory so the atomic rename fails.
	path := filepath.Join(dir, "notify-source.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	rec, err := s.Append(Notice{Type: TypeFinished, Ts: 1}, DetectionContext{})
	if err == nil {
		t.Fatal("Append must surface the persist failure")
	}
	if rec.Seq != 1 {
		t.Fatalf("record identity still allocated: %+v", rec)
	}
	if s.LastPersistError() == "" {
		t.Fatal("LastPersistError must expose the failure for health surfaces")
	}
}

// TestSourceSpoolConcurrentAppendsUniqueSeqs pins that concurrent appends
// serialize: every record gets a unique strictly-increasing seq and the
// persisted head matches the append count.
func TestSourceSpoolConcurrentAppendsUniqueSeqs(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)
	const n = 32
	seen := make(map[int64]bool, n)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec, err := s.Append(Notice{Type: TypeFinished, Ts: int64(i)}, DetectionContext{})
			if err != nil {
				t.Errorf("Append %d: %v", i, err)
				return
			}
			mu.Lock()
			if seen[rec.Seq] {
				t.Errorf("seq %d handed out twice", rec.Seq)
			}
			seen[rec.Seq] = true
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	if s.LastSeq() != n {
		t.Fatalf("lastSeq = %d, want %d", s.LastSeq(), n)
	}
}

// TestEngineRecordsDetectionTimeAttendanceAndEligibility pins the v4 (h)
// snapshot at the TAP: the engine captures attendance (with the idle window)
// and the active profile's wantsType verdict at DETECTION time, into the
// durable record — not at Send time.
func TestEngineRecordsDetectionTimeAttendanceAndEligibility(t *testing.T) {
	dir := t.TempDir()
	cfg, err := NewStore(dir + "/alerts.jsonc")
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	pres := NewPresence()
	engine := NewEngine(cfg, pres, NewDispatcher(cfg, pres))
	ring := NewHistory(dir)
	engine.SetHistory(ring)
	spool := NewSourceSpool(dir, "w", 0)
	engine.SetSource(spool)

	// Unattended (no devices): attended=false, default profile wants all types.
	engine.EmitDaemonNotice("down-spell-a")
	// Attended: a live, non-idle device heartbeated within the idle window.
	pres.Heartbeat(Device{ID: "tab-1", LastInteraction: time.Now()})
	engine.EmitDaemonNotice("down-spell-b")

	// The engine tap appends the spool record FIRST; lookups join BY SEQ
	// (the spool-owned correlation key, t1b-F1).
	first, ok := spool.LookupBySeq(1)
	if !ok {
		t.Fatal("first notice not recorded in the spool")
	}
	second, ok := spool.LookupBySeq(2)
	if !ok {
		t.Fatal("second notice not recorded in the spool")
	}
	if first.Attended {
		t.Fatal("first record must capture UNATTENDED (detection-time, no devices)")
	}
	if !second.Attended {
		t.Fatal("second record must capture ATTENDED (device heartbeated before detection)")
	}
	if second.IdleSec != cfg.Get().Detect.IdleSec {
		t.Fatalf("idle window drift: %d vs %d", second.IdleSec, cfg.Get().Detect.IdleSec)
	}
	if !second.ProfileEligible {
		t.Fatal("default profile (empty types) must be eligible")
	}

	// Eligibility follows the ACTIVE profile's wantsType verdict, frozen at
	// detection: a profile that filters stalled out makes the NEXT record
	// ineligible (the already-recorded one keeps its detection-time verdict).
	c := cfg.Get()
	c.Profiles = append([]Profile{{Name: "NoStalled", ChannelPolicy: PolicyNever, Types: []string{TypeFinished}}}, c.Profiles...)
	c.Active = "NoStalled"
	if err := cfg.Replace(c); err != nil {
		t.Fatalf("cfg.Replace: %v", err)
	}
	engine.EmitDaemonNotice("down-spell-c")
	third, _ := spool.LookupBySeq(3)
	if third.ProfileEligible {
		t.Fatal("record must capture the active profile's exclusion of stalled")
	}
	if second.ProfileEligible != true {
		t.Fatal("earlier record's detection-time verdict must not be rewritten")
	}
}

// TestSourceSpoolInitPersistFailureVisible pins B2: a fresh-source or
// corrupt-source rotation whose INITIAL head persist fails is never silently
// acknowledged as durable — LastPersistError is non-empty from construction
// (the epoch exists in memory only), on both init paths (missing file and
// corrupt file).
func TestSourceSpoolInitPersistFailureVisible(t *testing.T) {
	sabotage := func(dir string) {
		t.Helper()
		// notify-source.json.tmp occupied by a directory: the tmp write
		// inside persistLocked fails (open on a directory), so the initial
		// head persist fails while construction still succeeds.
		if err := os.Mkdir(filepath.Join(dir, "notify-source.json.tmp"), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	// Missing-file path (fresh source): init persist fails visibly.
	dir := t.TempDir()
	sabotage(dir)
	s := NewSourceSpool(dir, "w", 0)
	if s.Epoch() == "" {
		t.Fatal("in-memory epoch must still be allocated")
	}
	if s.LastPersistError() == "" {
		t.Fatal("fresh-source init persist failure must surface on LastPersistError")
	}

	// Corrupt-file path (rotation): init persist fails visibly too.
	dir2 := t.TempDir()
	path := filepath.Join(dir2, "notify-source.json")
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	sabotage(dir2)
	s2 := NewSourceSpool(dir2, "w", 0)
	if s2.RotatedAt() == 0 {
		t.Fatal("corrupt spool must still record its rotation")
	}
	if s2.LastPersistError() == "" {
		t.Fatal("corrupt-source init persist failure must surface on LastPersistError")
	}

	// The undurable range is empty in both cases (no records yet), so the
	// error surface — not a gap — is the honest signal (B1 degrades
	// complete on the error alone).
	if from, to := s.UndurableSeqRange(); !(from > to) {
		t.Fatalf("no-record init failure must have an empty undurable range, got [%d,%d]", from, to)
	}
}

// TestSourceSpoolPersistFailureRecoversAndClearsError pins C3/B4: a visible
// persist failure is CLEARED by the next successful append —
// LastPersistError() documents "" when the last persist was clean, and the
// recovered whole-document write carries the previously undurable record.
func TestSourceSpoolPersistFailureRecoversAndClearsError(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)

	// Sabotage: replace the spool file with a directory so the atomic
	// rename fails.
	path := filepath.Join(dir, "notify-source.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append(Notice{Type: TypeFinished, Ts: 1}, DetectionContext{}); err == nil {
		t.Fatal("Append must surface the persist failure")
	}
	if s.LastPersistError() == "" {
		t.Fatal("failure must be visible before recovery")
	}
	if from, to := s.UndurableSeqRange(); from != 1 || to != 1 {
		t.Fatalf("undurable range = [%d,%d], want [1,1]", from, to)
	}

	// Restore the write path and append again: the whole document —
	// including the previously undurable record — persists cleanly.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append(Notice{Type: TypeFinished, Ts: 2}, DetectionContext{}); err != nil {
		t.Fatalf("Append after recovery: %v", err)
	}
	if got := s.LastPersistError(); got != "" {
		t.Fatalf("LastPersistError after clean persist = %q, want \"\"", got)
	}
	if from, to := s.UndurableSeqRange(); !(from > to) {
		t.Fatalf("undurable range after recovery = [%d,%d], want empty", from, to)
	}
	// Both records are durable now: a reload keeps them.
	s2 := NewSourceSpool(dir, "w", 0)
	if _, ok := s2.LookupBySeq(1); !ok {
		t.Fatal("recovered record must be durable after reload")
	}
	if _, ok := s2.LookupBySeq(2); !ok {
		t.Fatal("post-recovery record must be durable after reload")
	}
}

// TestSourceSpoolSeqOwnedJoinSurvivesRingRollback is the t1b-F1 reviewer
// repro at the storage level: a ring persist FAILURE is rolled back to the
// last readable ring file, so the ring RE-ALLOCATES an id the spool already
// holds a record for. With the spool-owned key, the reused-id event carries
// its OWN (epoch, seq): the join resolves the NEW record — never the OLD
// same-id record's kind/source (the mis-attribution the old (ringGen, id)
// join exhibited one failure mode out).
func TestSourceSpoolSeqOwnedJoinSurvivesRingRollback(t *testing.T) {
	dir := t.TempDir()
	ring1 := NewHistory(dir)
	spool1 := NewSourceSpool(dir, "w", 0)

	// Healthy pre-state: one durable notice (ring id 1, spool seq 1).
	rec0, err := spool1.Append(Notice{Type: TypeFinished, SessionID: "s0", Root: "s0", Ts: 1}, DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ring1.Record(Notice{Type: TypeFinished, SessionID: "s0", Root: "s0", Ts: 1}, rec0.Seq, spool1.Epoch()); err != nil {
		t.Fatal(err)
	}

	// Sabotage ONLY the ring's tmp-write target: the real ring file stays
	// readable, the next ring persist fails VISIBLY, and the spool (whose
	// write path is untouched) durably records the question notice as
	// seq 2 — an orphan: no durable ring event references it.
	if err := os.Mkdir(filepath.Join(dir, "notify-history.json.tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	question := Notice{Type: TypeWaiting, Kind: KindQuestion, SessionID: "s1", Root: "s1",
		Project: "/w", Title: "Review requested", Detail: "Question pending", Ts: 100}
	recQ, err := spool1.Append(question, DetectionContext{})
	if err != nil {
		t.Fatalf("spool append must succeed while only the ring is sabotaged: %v", err)
	}
	evQ, err := ring1.Record(question, recQ.Seq, spool1.Epoch())
	if err == nil {
		t.Fatal("premise: the ring persist must fail under sabotage")
	}
	if evQ.ID != 2 {
		t.Fatalf("premise: the failed event still allocates id 2, got %d", evQ.ID)
	}
	if got := ring1.LastPersistError(); got == "" {
		t.Fatal("premise: the ring failure must be visible (LastPersistError)")
	}

	// Rollback: reload both stores. The ring restarts from the last READABLE
	// file (lastID 1) — id 2 is RE-ALLOCATED for the permission notice,
	// while the spool kept the orphan question record at seq 2.
	if err := os.Remove(filepath.Join(dir, "notify-history.json.tmp")); err != nil {
		t.Fatal(err)
	}
	ring2 := NewHistory(dir)
	spool2 := NewSourceSpool(dir, "w", 0)

	permission := Notice{Type: TypeWaiting, Kind: KindPermission, SessionID: "s2", Root: "s2",
		Project: "/w", Title: "Deploy blocked", Detail: "Permission pending", Ts: 200}
	recP, err := spool2.Append(permission, DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	evP, err := ring2.Record(permission, recP.Seq, spool2.Epoch())
	if err != nil {
		t.Fatalf("ring persist must succeed after the sabotage is lifted: %v", err)
	}
	if evP.ID != 2 {
		t.Fatalf("test premise: the ring must re-allocate id 2, got %d", evP.ID)
	}
	if evP.SpoolSeq != recP.Seq || evP.SpoolEpoch != spool2.Epoch() {
		t.Fatalf("reused-id event must carry its OWN key: (%d, %q), want (%d, %q)",
			evP.SpoolSeq, evP.SpoolEpoch, recP.Seq, spool2.Epoch())
	}

	// CRUX: joining the reused-id event by ITS carried key resolves the
	// permission record — never the question orphan the spool still holds.
	got, ok := spool2.LookupBySeq(evP.SpoolSeq)
	if !ok {
		t.Fatal("the reused-id event's own record must resolve")
	}
	if got.Kind != KindPermission || got.SessionID != "s2" || got.Seq != recP.Seq {
		t.Fatalf("join returned the OLD record's tuple (mis-attribution): %+v", got)
	}
	// The orphan question record is still retained (harmless — no ring
	// event references it) and never joins: the reused id is irrelevant.
	orphan, ok := spool2.LookupBySeq(recQ.Seq)
	if !ok || orphan.Kind != KindQuestion {
		t.Fatalf("orphan record = (%+v, %v) — retained but unreachable by the join", orphan, ok)
	}
}

// TestSourceSpoolSeqOwnedJoinSurvivesRingFileLoss pins the same t1b-F1
// invariant for the OTHER ring-id reuse mode: the ring FILE is lost outright,
// ids restart at 1, and a reused id still resolves its OWN record — the
// carried (epoch, seq) key, not the ring id, is the join.
func TestSourceSpoolSeqOwnedJoinSurvivesRingFileLoss(t *testing.T) {
	dir := t.TempDir()
	ring1 := NewHistory(dir)
	spool1 := NewSourceSpool(dir, "w", 0)

	question := Notice{Type: TypeWaiting, Kind: KindQuestion, SessionID: "s1", Root: "s1",
		Project: "/w", Title: "Review requested", Detail: "Question pending", Ts: 100}
	recQ, err := spool1.Append(question, DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ring1.Record(question, recQ.Seq, spool1.Epoch()); err != nil {
		t.Fatal(err)
	}

	// Ring file lost (only the ring — the spool survives): ids restart at 1.
	if err := os.Remove(filepath.Join(dir, "notify-history.json")); err != nil {
		t.Fatal(err)
	}
	ring2 := NewHistory(dir)
	spool2 := NewSourceSpool(dir, "w", 0)

	permission := Notice{Type: TypeWaiting, Kind: KindPermission, SessionID: "s2", Root: "s2",
		Project: "/w", Title: "Deploy blocked", Detail: "Permission pending", Ts: 200}
	recP, err := spool2.Append(permission, DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	evP, err := ring2.Record(permission, recP.Seq, spool2.Epoch())
	if err != nil {
		t.Fatal(err)
	}
	if evP.ID != 1 {
		t.Fatalf("test premise: the ring must reuse id 1, got %d", evP.ID)
	}

	got, ok := spool2.LookupBySeq(evP.SpoolSeq)
	if !ok || got.Kind != KindPermission || got.SessionID != "s2" || got.Seq != recP.Seq {
		t.Fatalf("reused-id join = (%+v, %v), want the NEW permission record", got, ok)
	}
}

// TestSourceSpoolLossWithPostS1RingEvidenceStampsRotation pins t1b-F2's core:
// a MISSING notify-source.json re-inits as a LOSS — not a first run — when
// the ring document bears post-S1 evidence (a non-empty generation, or events
// recorded through the spool-carrying tap). The rotation discontinuity is
// stamped exactly as the corrupt-file case: fresh epoch, rotatedAt set,
// prevEpoch unknowable, so coverage degrades with the empty-range gap.
func TestSourceSpoolLossWithPostS1RingEvidenceStampsRotation(t *testing.T) {
	dir := t.TempDir()
	ring := NewHistory(dir)
	spool1 := NewSourceSpool(dir, "w", 0)

	// Persist notices through the spool-carrying tap: the ring file now
	// carries a generation AND spool-keyed events (post-S1 evidence).
	for i := 0; i < 2; i++ {
		n := Notice{Type: TypeFinished, SessionID: "s", Root: "s", Ts: int64(i + 1)}
		rec, err := spool1.Append(n, DetectionContext{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ring.Record(n, rec.Seq, spool1.Epoch()); err != nil {
			t.Fatal(err)
		}
	}
	oldEpoch := spool1.Epoch()

	// Lose ONLY the spool file; reload. The witness (ring generation
	// non-empty) proves the spool existed ⇒ rotation discontinuity stamped.
	if err := os.Remove(filepath.Join(dir, "notify-source.json")); err != nil {
		t.Fatal(err)
	}
	spool2 := NewSourceSpool(dir, "w", 0)
	if spool2.Epoch() == oldEpoch {
		t.Fatal("lost spool must re-init under a fresh epoch")
	}
	if spool2.RotatedAt() == 0 {
		t.Fatal("lost spool with post-S1 ring evidence must stamp the rotation (rotatedAt)")
	}
	if spool2.PrevEpoch() != "" {
		t.Fatalf("prevEpoch = %q, want \"\" (unknowable from a deleted file)", spool2.PrevEpoch())
	}
	if spool2.LastSeq() != 0 || spool2.OverflowTotal() != 0 || spool2.LastPersistError() != "" {
		t.Fatalf("loss re-init head drift: lastSeq=%d overflow=%d lastErr=%q",
			spool2.LastSeq(), spool2.OverflowTotal(), spool2.LastPersistError())
	}
	// The stamped rotation persists across the next restart.
	spool3 := NewSourceSpool(dir, "w", 0)
	if spool3.Epoch() != spool2.Epoch() || spool3.RotatedAt() != spool2.RotatedAt() {
		t.Fatalf("loss rotation not durable across restart: %q/%d vs %q/%d",
			spool3.Epoch(), spool3.RotatedAt(), spool2.Epoch(), spool2.RotatedAt())
	}
}

// TestSourceSpoolMissingFileCleanInitWithoutRingEvidence pins t1b-F2's
// complement: with NO post-S1 ring evidence a missing spool file is a true
// first run (or a pre-S1 upgrade where no spool ever existed) — clean init,
// no rotation stamp, coverage honestly complete.
func TestSourceSpoolMissingFileCleanInitWithoutRingEvidence(t *testing.T) {
	// True first run: no ring file at all.
	dir := t.TempDir()
	s := NewSourceSpool(dir, "w", 0)
	if s.RotatedAt() != 0 {
		t.Fatalf("first run must not stamp a rotation, got %d", s.RotatedAt())
	}
	if s.LastPersistError() != "" {
		t.Fatalf("clean init must persist its head, got %q", s.LastPersistError())
	}

	// Pre-S1 upgrade posture: a legacy ring doc exists ("" generation, no
	// spool-keyed events) and no spool file — no spool ever existed.
	dir2 := t.TempDir()
	legacy := `{"lastId":2,"events":[{"id":1,"type":"waiting","sessionID":"s1","root":"s1","project":"p","title":"t","detail":"d","ts":1},{"id":2,"type":"finished","sessionID":"s2","root":"s2","project":"p","title":"t","detail":"d","ts":2}],"generation":""}`
	if err := os.WriteFile(filepath.Join(dir2, "notify-history.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	s2 := NewSourceSpool(dir2, "w", 0)
	if s2.RotatedAt() != 0 {
		t.Fatalf("legacy-era ring with no spool file must init clean, got rotatedAt %d", s2.RotatedAt())
	}

	// And the witness DOES fire on a legacy-era ring once post-S1 notices
	// were recorded into it (events carrying spool seqs — the ""-generation
	// upgrade edge the generation alone could not decide).
	rec, err := s2.Append(Notice{Type: TypeFinished, Ts: 3}, DetectionContext{})
	if err != nil {
		t.Fatal(err)
	}
	// The legacy-era ring keeps "" across the upgrade; its newly recorded
	// event carries the spool key (the per-event witness).
	ring := NewHistory(dir2)
	if ring.Generation() != "" {
		t.Fatalf("premise: the legacy ring must keep its empty era, got %q", ring.Generation())
	}
	if _, err := ring.Record(Notice{Type: TypeFinished, Ts: 3}, rec.Seq, s2.Epoch()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir2, "notify-source.json")); err != nil {
		t.Fatal(err)
	}
	s3 := NewSourceSpool(dir2, "w", 0)
	if s3.RotatedAt() == 0 {
		t.Fatal("legacy-era ring WITH spool-keyed events must witness the loss (rotation stamped)")
	}
}

// TestSourceSpoolUnreadableButPresentIsPreservedNotReplaced is the b-F1
// regression: a spool file that EXISTS but cannot be READ is neither missing
// nor corrupt, and must NEVER be treated as either. The old loader funneled
// every ReadFile error into the missing-file path: fresh epoch + tmp+rename
// overwrite — silently destroying the retained durable records of an
// intact-but-currently-unreadable file (rename needs directory permissions,
// not file read permission).
//
// Unreadability is produced by a self-referencing symlink loop (ELOOP — an
// error class that is NOT os.IsNotExist and that even a root test process
// cannot bypass, unlike chmod 0000). A loop is used instead of a directory
// precisely because rename CAN replace a symlink: the "no tmp+rename
// overwrite" assertion below is load-bearing (with a directory the rename
// would fail on its own, masking the bug).
//
// Pinned end to end:
//   - degraded init: NO fresh epoch (empty-but-preserved identity), no
//     rotation stamp, visible init error on LastPersistError;
//   - Append still allocates and records in memory AND reports the skipped
//     persist honestly;
//   - the unread path is NOT replaced after the Append attempt (still the
//     symlink; no tmp residue — the persist is skipped before any write);
//   - recovery (restore readability + reload, the documented out-of-band
//     path): the ORIGINAL epoch and records are byte-for-byte intact and
//     allocation resumes — no seq reuse, no rotation, normal persistence.
func TestSourceSpoolUnreadableButPresentIsPreservedNotReplaced(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notify-source.json")
	s1 := NewSourceSpool(dir, "w", 0)
	mustAppend(t, s1, Notice{Type: TypeFinished, Ts: 1}, DetectionContext{})
	mustAppend(t, s1, Notice{Type: TypeFinished, Ts: 2}, DetectionContext{})
	oldEpoch := s1.Epoch()
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	// Park the authoritative inode aside (hardlink): the degraded session
	// must leave these exact bytes untouched, and the restore step puts
	// them back at the spool path.
	saved := path + ".saved"
	if err := os.Link(path, saved); err != nil {
		t.Fatal(err)
	}

	// Make the spool path unreadable-but-present: replace the file with a
	// symlink whose target resolves back to itself. ReadFile then fails
	// with ELOOP — NOT IsNotExist — for every user, root included.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("notify-source.json", path); err != nil {
		t.Fatal(err)
	}
	if _, rerr := os.ReadFile(path); rerr == nil || os.IsNotExist(rerr) {
		t.Fatalf("premise: spool path must fail to read with a non-IsNotExist error, got %v", rerr)
	}

	// Degraded init: preserved, not replaced.
	s2 := NewSourceSpool(dir, "w", 0)
	if s2.Epoch() != "" {
		t.Fatalf("unreadable-but-present spool must NOT fresh-init (minted fresh epoch %q) — the state is preserved, not replaced", s2.Epoch())
	}
	if s2.RotatedAt() != 0 {
		t.Fatal("nothing was replaced — no rotation stamp may be invented")
	}
	if s2.LastPersistError() == "" {
		t.Fatal("degraded init must surface the unreadable-file error on LastPersistError")
	}

	// Append still allocates/records in memory and reports the persist
	// outcome honestly (skipped ⇒ error, never silently acknowledged).
	rec, aerr := s2.Append(Notice{Type: TypeFinished, Ts: 3}, DetectionContext{})
	if aerr == nil {
		t.Fatal("Append in the degraded state must report the skipped persist")
	}
	if rec.Seq != 1 {
		t.Fatalf("in-memory allocation must continue in the degraded state, got seq %d", rec.Seq)
	}
	if s2.LastPersistError() == "" {
		t.Fatal("the skipped persist must remain visible after Append")
	}

	// No overwrite: the spool path is STILL the unread symlink (the buggy
	// loader's tmp+rename would have replaced it), and no tmp residue
	// exists — the persist is skipped before any write.
	fi, lerr := os.Lstat(path)
	if lerr != nil || fi.Mode()&fs.ModeSymlink == 0 {
		t.Fatalf("unread spool path must be left untouched (no tmp+rename), lstat: %+v %v", fi, lerr)
	}
	if _, terr := os.Lstat(path + ".tmp"); !os.IsNotExist(terr) {
		t.Fatalf("persist must be skipped before any tmp write, found tmp residue (%v)", terr)
	}

	// Recovery — the documented out-of-band path: restore readability,
	// reload. The ORIGINAL epoch + records are intact, allocation resumes.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(saved, path); err != nil {
		t.Fatal(err)
	}
	now, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(now) != string(original) {
		t.Fatal("authoritative bytes changed during the degraded session")
	}
	s3 := NewSourceSpool(dir, "w", 0)
	if s3.Epoch() != oldEpoch {
		t.Fatalf("recovered spool epoch = %q, want the ORIGINAL %q", s3.Epoch(), oldEpoch)
	}
	if s3.RotatedAt() != 0 {
		t.Fatal("recovery must not stamp a rotation — the state was never replaced")
	}
	if s3.LastSeq() != 2 {
		t.Fatalf("recovered lastSeq = %d, want 2", s3.LastSeq())
	}
	for seq := int64(1); seq <= 2; seq++ {
		if _, ok := s3.LookupBySeq(seq); !ok {
			t.Fatalf("recovered spool lost retained record seq %d", seq)
		}
	}
	if rec3 := mustAppend(t, s3, Notice{Type: TypeFinished, Ts: 4}, DetectionContext{}); rec3.Seq != 3 {
		t.Fatalf("allocation after recovery = %d, want 3 (resumes, no reuse)", rec3.Seq)
	}
	if got := s3.LastPersistError(); got != "" {
		t.Fatalf("recovered spool must resume normal persistence, got %q", got)
	}
}
