package server

// notify_ledger_test.go — lane-1 co-located tests for the central
// transactional notify ledger (notify controller-hub S3; see
// notify_ledger.go for the transaction design + recovery proof these tests
// pin). Every durability claim in the file header has a test here:
//
//   - atomic page commits (events+cursor+dedupe+gap as ONE journal line);
//   - crash/reload: an uncommitted (torn) tail is discarded and truncated,
//     the committed prefix reloads EXACTLY;
//   - fail-closed bars: mid-file corruption, a missing ledger beside
//     enrolled sources, head non-regression;
//   - prefix truncation with dedupe-tail survival (re-pulled old pages
//     after restart+truncation never re-insert);
//   - epoch-change reset + gap recording; ACK only after commit.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ledgerTestPaths builds a ledger path + sources-witness path pair under a
// fresh temp dir.
func ledgerTestPaths(t *testing.T) (ledgerPath, witness string) {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "store.ledger"), filepath.Join(dir, "store.sources")
}

// armTestLedger arms a file-backed ledger at a fresh location.
func armTestLedger(t *testing.T, retention int) (*notifyLedger, string, string) {
	t.Helper()
	ledgerPath, witness := ledgerTestPaths(t)
	l, err := armNotifyLedger(ledgerPath, witness, retention)
	if err != nil {
		t.Fatalf("armNotifyLedger: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l, ledgerPath, witness
}

// lrec builds one pre-id commit record.
func lrec(seq int64, typ string) NotifyEvent {
	return NotifyEvent{
		Type: typ, SessionID: fmt.Sprintf("s%d", seq), Root: fmt.Sprintf("s%d", seq),
		Project: "/p", Title: "t", Detail: "d", Ts: 1700000000000 + seq,
		Kind: "session_unread", Count: 1, Seq: seq,
		Attended: true, IdleSec: 10, ProfileEligible: true, CooldownKey: "src|" + typ,
	}
}

// page commits one page for a source (test driver).
func page(t *testing.T, l *notifyLedger, sourceID, epoch string, seqs ...int64) []NotifyEvent {
	t.Helper()
	return pageGap(t, l, sourceID, epoch, seqs, 0, nil)
}

// pageGap commits with an explicit AdvanceTo and optional gap.
func pageGap(t *testing.T, l *notifyLedger, sourceID, epoch string, seqs []int64, advanceTo int64, gap *NotifySourceGap) []NotifyEvent {
	t.Helper()
	recs := make([]NotifyEvent, 0, len(seqs))
	for _, s := range seqs {
		recs = append(recs, lrec(s, "finished"))
	}
	if advanceTo == 0 {
		advanceTo = seqs[len(seqs)-1]
	}
	evs, err := l.CommitPage(notifyPageCommit{
		SourceID: sourceID, WorkerID: sourceID, WorkerName: sourceID,
		Epoch: epoch, Records: recs, AdvanceTo: advanceTo, Gap: gap,
	})
	if err != nil {
		t.Fatalf("CommitPage(%s, %v): %v", sourceID, seqs, err)
	}
	return evs
}

func mustSourceState(t *testing.T, l *notifyLedger, sourceID string) notifySourceState {
	t.Helper()
	st, ok := l.SourceState(sourceID)
	if !ok {
		t.Fatalf("source %s missing", sourceID)
	}
	return st
}

// --- 1: interleaved multi-source commits in commit order -------------------

func TestNotifyLedgerInterleavedCommitsInCommitOrder(t *testing.T) {
	l, _, _ := armTestLedger(t, 0)

	a1 := page(t, l, "wrk-a", "ea", 1, 2)
	b1 := page(t, l, "wrk-b", "eb", 1, 2, 3)
	a2 := page(t, l, "wrk-a", "ea", 3, 4)
	if a1[0].ID != 1 || a1[1].ID != 2 {
		t.Fatalf("first page ids: %v", idsOf(a1))
	}
	if b1[0].ID != 3 || b1[1].ID != 4 || b1[2].ID != 5 {
		t.Fatalf("second page ids (interleaved): %v", idsOf(b1))
	}
	if a2[0].ID != 6 || a2[1].ID != 7 {
		t.Fatalf("third page ids: %v", idsOf(a2))
	}
	if got := l.Head(); got != 7 {
		t.Fatalf("head = %d, want 7", got)
	}
	all := l.EventsSince(0, 100)
	if len(all) != 7 {
		t.Fatalf("retained %d events, want 7", len(all))
	}
	for i, ev := range all {
		if ev.ID != int64(i+1) {
			t.Fatalf("event %d has id %d (ids must be contiguous 1..head in commit order)", i, ev.ID)
		}
	}
	// Worker attribution rides every event.
	for _, ev := range all {
		if ev.WorkerID == "" || ev.WorkerName == "" || ev.Epoch == "" {
			t.Fatalf("event %d missing worker/source attribution: %+v", ev.ID, ev)
		}
	}
	// Per-source cursors advanced independently.
	if st := mustSourceState(t, l, "wrk-a"); st.HighSeq != 4 || st.Epoch != "ea" {
		t.Fatalf("wrk-a state: %+v", st)
	}
	if st := mustSourceState(t, l, "wrk-b"); st.HighSeq != 3 || st.Epoch != "eb" {
		t.Fatalf("wrk-b state: %+v", st)
	}
	// v4 paging semantics: since>0 → strictly above, ascending; since=0 →
	// newest N ascending.
	if got := l.EventsSince(5, 2); len(got) != 2 || got[0].ID != 6 || got[1].ID != 7 {
		t.Fatalf("EventsSince(5,2): %v", idsOf(got))
	}
	if got := l.EventsSince(0, 3); len(got) != 3 || got[0].ID != 5 {
		t.Fatalf("EventsSince(0,3) must be the newest 3 ascending: %v", idsOf(got))
	}
}

func idsOf(evs []NotifyEvent) []int64 {
	out := make([]int64, 0, len(evs))
	for _, e := range evs {
		out = append(out, e.ID)
	}
	return out
}

// --- 2: duplicate-page replay dedupes --------------------------------------

func TestNotifyLedgerDuplicatePageReplayDedupe(t *testing.T) {
	l, _, _ := armTestLedger(t, 0)
	page(t, l, "wrk", "e1", 1, 2, 3)

	// Exact replay of the same page: idempotent no-op.
	evs, err := l.CommitPage(notifyPageCommit{
		SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
		Records:   []NotifyEvent{lrec(1, "finished"), lrec(2, "finished"), lrec(3, "finished")},
		AdvanceTo: 3,
	})
	if err != nil {
		t.Fatalf("replay commit: %v", err)
	}
	if evs != nil {
		t.Fatalf("pure replay must insert nothing, got %v", idsOf(evs))
	}
	if l.Head() != 3 {
		t.Fatalf("head after replay = %d, want 3", l.Head())
	}

	// Overlapping replay + one new record: only the new one inserts, ids
	// continue from head.
	evs = page(t, l, "wrk", "e1", 2, 3, 4)
	if len(evs) != 1 || evs[0].ID != 4 || evs[0].Seq != 4 {
		t.Fatalf("overlap replay must insert only seq 4: %+v", evs)
	}
	if got := len(l.EventsSince(0, 100)); got != 4 {
		t.Fatalf("retained %d events, want 4", got)
	}
	if st := mustSourceState(t, l, "wrk"); st.HighSeq != 4 {
		t.Fatalf("cursor after overlap: %+v", st)
	}
}

// --- 3: crash/reload recovery — the torn tail is discarded ------------------

func TestNotifyLedgerCrashReloadTornTailDiscarded(t *testing.T) {
	l, ledgerPath, _ := armTestLedger(t, 0)
	page(t, l, "wrk", "e1", 1, 2)
	page(t, l, "wrk", "e1", 3, 4)
	page(t, l, "wrk", "e1", 5, 6)

	raw, err := os.ReadFile(ledgerPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := splitLines(raw) // header, p1, p2, p3
	if len(lines) != 4 {
		t.Fatalf("journal must be header+3 pages, got %d lines", len(lines))
	}
	afterP2 := len(lines[0]) + len(lines[1]) + len(lines[2]) // committed prefix if p3 tears

	cases := []struct {
		name    string
		cut     int
		wantHd  int64
		wantCur int64
	}{
		{"exact boundary after p3 (clean)", len(raw), 6, 6},
		{"one byte torn off p3", len(raw) - 1, 4, 4},
		{"torn mid-p3", afterP2 + len(lines[3])/2, 4, 4},
		{"torn one byte into p3", afterP2 + 1, 4, 4},
		{"exact boundary after p2 (p3 fully gone)", afterP2, 4, 4},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(ledgerPath, raw[:tc.cut], 0o600); err != nil {
				t.Fatal(err)
			}
			_ = l.Close()
			l2, err := armNotifyLedger(ledgerPath, ledgerPath+".missing-witness", 0)
			if err != nil {
				t.Fatalf("reload after truncation at %d: %v", tc.cut, err)
			}
			defer l2.Close()
			if got := l2.Head(); got != tc.wantHd {
				t.Fatalf("head = %d, want %d", got, tc.wantHd)
			}
			if got := len(l2.EventsSince(0, 100)); int64(got) != tc.wantHd {
				t.Fatalf("retained %d events, want %d", got, tc.wantHd)
			}
			if st, ok := l2.SourceState("wrk"); !ok || st.HighSeq != tc.wantCur {
				t.Fatalf("cursor after reload: %+v ok=%v", st, ok)
			}
			// The reload truncated the torn bytes: the file ends exactly
			// after the last COMPLETE record (the last '\n' within the cut
			// prefix) — checked BEFORE the continuation commit below
			// appends.
			cutPrefix := raw[:tc.cut]
			wantSize := bytes.LastIndexByte(cutPrefix, '\n') + 1
			raw2, _ := os.ReadFile(ledgerPath)
			if len(raw2) != wantSize {
				t.Fatalf("reload must truncate the torn tail: file %d bytes, want %d", len(raw2), wantSize)
			}
			// The reloaded ledger CONTINUES cleanly: the next commit's ids
			// and cursor continue from the recovered state.
			evs := page(t, l2, "wrk", "e1", tc.wantCur+1)
			if evs[0].ID != tc.wantHd+1 {
				t.Fatalf("post-recovery id = %d, want %d (ids continue from recovered head)", evs[0].ID, tc.wantHd+1)
			}
		})
	}
}

func splitLines(raw []byte) [][]byte {
	var out [][]byte
	for _, ln := range strings.SplitAfter(string(raw), "\n") {
		if ln != "" {
			out = append(out, []byte(ln))
		}
	}
	return out
}

// --- 4: fail-closed bars ----------------------------------------------------

func TestNotifyLedgerCorruptMidFileFailsClosed(t *testing.T) {
	l, ledgerPath, _ := armTestLedger(t, 0)
	page(t, l, "wrk", "e1", 1, 2)
	page(t, l, "wrk", "e1", 3, 4)
	page(t, l, "wrk", "e1", 5, 6)
	raw, _ := os.ReadFile(ledgerPath)
	lines := splitLines(raw)

	// freshCompacted builds a whole compacted-shape journal (header + one
	// snapshot — the only position a snapshot is legal at).
	freshCompacted := func(snap ledgerSnapshot) []byte {
		hdr, _ := json.Marshal(ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecHeader})
		body, _ := json.Marshal(ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecSnapshot, Snapshot: &snap})
		out := append(hdr, '\n')
		out = append(out, body...)
		return append(out, '\n')
	}

	for name, mutate := range map[string]func([]byte) []byte{
		"malformed JSON mid-file": func(b []byte) []byte {
			// Corrupt the SECOND page record's JSON (a complete line — this
			// is corruption, NOT a torn tail).
			out := append([]byte(nil), b...)
			off := len(lines[0]) + len(lines[1])
			out[off+3] = 'x'
			out[off+4] = '@'
			out[off+5] = '}'
			return out
		},
		"unknown record type": func(b []byte) []byte {
			bad := []byte(`{"v":1,"type":"nonsense"}` + "\n")
			return append(append([]byte(nil), b...), bad...)
		},
		"ack beyond committed cursor": func(b []byte) []byte {
			bad, _ := json.Marshal(ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecAck, AckSource: "wrk", AckSeq: 99})
			return append(append([]byte(nil), b...), append(bad, '\n')...)
		},
		"epoch change without reset": func(b []byte) []byte {
			// A page under a NEW epoch with no epoch_reset record — a silent
			// cursor masquerade; replay must refuse it.
			rec := ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecPage,
				Events: []NotifyEvent{{ID: 7, Type: "finished", Ts: 1, Seq: 1, Epoch: "e2"}},
				Source: &notifySourceState{SourceID: "wrk", WorkerID: "wrk", Epoch: "e2", LowSeq: 1, HighSeq: 1}}
			bad, _ := json.Marshal(rec)
			return append(append([]byte(nil), b...), append(bad, '\n')...)
		},
		// b-F3(i): the header is the anchor of the whole grammar — a page
		// as the first record (no header) must never replay.
		"headerless page journal": func(b []byte) []byte {
			return append([]byte(nil), b[len(lines[0]):]...) // strip the header line
		},
		// b-F3(ii): a source's FIRST page validates on its own — ack may
		// never exceed the cursor even with no prior state to compare to.
		"first-page ack beyond cursor": func(b []byte) []byte {
			rec := ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecPage,
				Events: []NotifyEvent{{ID: 7, Type: "finished", Ts: 1, Seq: 2, Epoch: "e9"}},
				Source: &notifySourceState{SourceID: "wrk2", WorkerID: "wrk2", Epoch: "e9", LowSeq: 2, HighSeq: 2, AckedSeq: 5}}
			bad, _ := json.Marshal(rec)
			return append(append([]byte(nil), b...), append(bad, '\n')...)
		},
		// b-F3(ii): snapshot-carried source states validate on their own too.
		"snapshot source ack beyond cursor": func([]byte) []byte {
			return freshCompacted(ledgerSnapshot{Head: 2,
				Events:  []NotifyEvent{{ID: 1, Seq: 1, WorkerID: "wrk", Epoch: "e1"}, {ID: 2, Seq: 2, WorkerID: "wrk", Epoch: "e1"}},
				Sources: []notifySourceState{{SourceID: "wrk", WorkerID: "wrk", Epoch: "e1", LowSeq: 1, HighSeq: 2, AckedSeq: 3}}})
		},
		"snapshot source cursor below retained events": func([]byte) []byte {
			return freshCompacted(ledgerSnapshot{Head: 2,
				Events:  []NotifyEvent{{ID: 1, Seq: 1, WorkerID: "wrk", Epoch: "e1"}, {ID: 2, Seq: 2, WorkerID: "wrk", Epoch: "e1"}},
				Sources: []notifySourceState{{SourceID: "wrk", WorkerID: "wrk", Epoch: "e1", LowSeq: 1, HighSeq: 1, AckedSeq: 1}}})
		},
		// b-F3(iii): a snapshot behind prior content — the head-LOWERING
		// trailing snapshot (and any trailing snapshot at all) is outside
		// the compaction grammar: compaction rewrites the journal
		// wholesale, it never appends a snapshot behind existing records.
		"trailing head-lowering snapshot": func(b []byte) []byte {
			bad, _ := json.Marshal(ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecSnapshot,
				Snapshot: &ledgerSnapshot{Head: 3, Events: []NotifyEvent{{ID: 1}, {ID: 2}, {ID: 3}}}})
			return append(append([]byte(nil), b...), append(bad, '\n')...)
		},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "corrupt.ledger")
			if err := os.WriteFile(path, mutate(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			_ = l.Close()
			if lg, err := armNotifyLedger(path, path+".no-witness", 0); err == nil {
				lg.Close()
				t.Fatal("corrupt journal must fail closed, loaded fine")
			}
			// Re-arm the good copy for the next subtest.
			if err := os.WriteFile(ledgerPath, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			l2, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 0)
			if err != nil {
				t.Fatalf("restore good journal: %v", err)
			}
			l = l2
		})
	}
}

func TestNotifyLedgerMissingWithSourcesWitnessFailsClosed(t *testing.T) {
	ledgerPath, witness := ledgerTestPaths(t)
	// The witness (enrolled sources anchor) exists, the journal does not:
	// a ledger that had committed ids was destroyed — NEVER restart at 1.
	if err := os.WriteFile(witness, []byte(`{"schema":1,"sources":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if l, err := armNotifyLedger(ledgerPath, witness, 0); err == nil {
		l.Close()
		t.Fatal("missing ledger beside enrolled sources must fail closed")
	}

	// Pristine controller (neither file): fresh ledger, initialized eagerly
	// (header only) so a later missing-with-witness state is unambiguous.
	dir := t.TempDir()
	p2, w2 := filepath.Join(dir, "a.ledger"), filepath.Join(dir, "a.sources")
	l, err := armNotifyLedger(p2, w2, 0)
	if err != nil {
		t.Fatalf("pristine arm: %v", err)
	}
	if l.Head() != 0 {
		t.Fatalf("fresh head = %d", l.Head())
	}
	if _, err := os.Stat(p2); err != nil {
		t.Fatalf("fresh ledger must be initialized eagerly: %v", err)
	}
	// ...and a source commit creates real history; deleting the journal
	// afterwards (witness now exists via the sources registry's own persist,
	// simulated here by hand) must refuse to re-arm.
	page(t, l, "wrk", "e1", 1)
	l.Close()
	if err := os.WriteFile(w2, []byte(`{"schema":1,"sources":[{"source_id":"wrk"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(p2); err != nil {
		t.Fatal(err)
	}
	if l2, err := armNotifyLedger(p2, w2, 0); err == nil {
		l2.Close()
		t.Fatal("deleted-after-commit ledger must fail closed (head never regresses to 1)")
	}
}

func TestNotifyLedgerZeroByteFileReinit(t *testing.T) {
	ledgerPath, witness := ledgerTestPaths(t)
	// Crash between creation and the header write on a FIRST arm (no
	// witness — no enrollment ever persisted): nothing can have committed
	// (commits append only after the header) — re-init is exact.
	if err := os.WriteFile(ledgerPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := armNotifyLedger(ledgerPath, witness, 0)
	if err != nil {
		t.Fatalf("zero-byte ledger must re-init: %v", err)
	}
	defer l.Close()
	if l.Head() != 0 {
		t.Fatalf("head after re-init = %d", l.Head())
	}
	evs := page(t, l, "wrk", "e1", 1)
	if evs[0].ID != 1 {
		t.Fatalf("first id after re-init = %d", evs[0].ID)
	}
}

// b-F1: a zero-byte journal beside an existing sources witness is a
// TRUNCATED established journal — the exact state the missing-file bar
// refuses. The witness policy must be symmetric: re-initializing here
// would silently regress the global head every client already saw.
func TestNotifyLedgerZeroByteTruncationWithWitnessFailsClosed(t *testing.T) {
	l, ledgerPath, witness := armTestLedger(t, 0)
	page(t, l, "wrk", "e1", 1, 2, 3)
	if err := l.RecordAck("wrk", 3); err != nil {
		t.Fatalf("ack: %v", err)
	}
	// The enrolled-sources witness exists: this controller is established.
	if err := os.WriteFile(witness, []byte(`{"schema":1,"sources":[{"source_id":"wrk"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	l.Close()
	// TRUNCATE the journal to zero bytes, keeping .sources.
	if err := os.WriteFile(ledgerPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if l2, err := armNotifyLedger(ledgerPath, witness, 0); err == nil {
		l2.Close()
		t.Fatal("zero-byte (truncated) ledger beside enrolled sources must fail closed — never silently restart ids at 1")
	}
	// The pristine zero-byte posture (neither file) still re-inits —
	// pinned above in TestNotifyLedgerZeroByteFileReinit.
}

// --- 5: retention — prefix truncation + dedupe-tail survival ----------------

func TestNotifyLedgerRetentionPrefixTruncationAndDedupeSurvival(t *testing.T) {
	l, ledgerPath, _ := armTestLedger(t, 5) // tiny bound to force compaction
	for s := int64(1); s <= 10; s++ {
		page(t, l, "wrk", "e1", s)
	}
	if got := l.Head(); got != 10 {
		t.Fatalf("head = %d, want 10", got)
	}
	if got := l.FirstID(); got != 6 {
		t.Fatalf("prefix truncation: firstID = %d, want 6", got)
	}
	if got := len(l.EventsSince(0, 100)); got != 5 {
		t.Fatalf("retained %d, want 5", got)
	}
	st := mustSourceState(t, l, "wrk")
	if st.HighSeq != 10 || st.LowSeq != 1 {
		t.Fatalf("dedupe tail must survive truncation: %+v", st)
	}
	if st.PublicFloor != 6 {
		t.Fatalf("public floor must name the oldest retained seq (6), got %d", st.PublicFloor)
	}
	// Central prefix truncation is NOT a source gap (v4: "global-id gaps ≠
	// source gaps ... never fabricate one into the other"): coverage stays
	// complete — no worker-side loss happened — while PublicFloor carries
	// our-truncation knowledge for the admin/diagnostics surface (S5).
	if !l.Coverage().Complete {
		t.Fatal("our own retention truncation must not fabricate a source-gap")
	}

	// The re-pull of truncated-OLD pages (a worker replaying from 0) must
	// dedupe against the surviving per-source state — never re-insert.
	evs, err := l.CommitPage(notifyPageCommit{
		SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
		Records:   []NotifyEvent{lrec(1, "finished"), lrec(2, "finished"), lrec(3, "finished")},
		AdvanceTo: 3,
	})
	if err != nil {
		t.Fatalf("re-pull of truncated prefix: %v", err)
	}
	if evs != nil {
		t.Fatalf("re-pulled old pages must not re-insert, got %v", idsOf(evs))
	}
	if l.Head() != 10 || l.FirstID() != 6 {
		t.Fatalf("re-pull disturbed the ledger: head=%d firstID=%d", l.Head(), l.FirstID())
	}

	// And the compacted journal reloads exactly (header + one snapshot).
	l.Close()
	l2, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 5)
	if err != nil {
		t.Fatalf("reload compacted journal: %v", err)
	}
	defer l2.Close()
	if l2.Head() != 10 || l2.FirstID() != 6 {
		t.Fatalf("compacted reload: head=%d firstID=%d", l2.Head(), l2.FirstID())
	}
	st2 := mustSourceState(t, l2, "wrk")
	if st2.HighSeq != 10 || st2.LowSeq != 1 || st2.PublicFloor != 6 {
		t.Fatalf("compacted reload source state: %+v", st2)
	}
	// Post-reload dedupe still holds, and new commits continue the ids.
	page(t, l2, "wrk", "e1", 11)
	if got := l2.Head(); got != 11 {
		t.Fatalf("post-compaction id continuation: head = %d", got)
	}
	if got := l2.FirstID(); got != 7 {
		t.Fatalf("ongoing retention: firstID = %d, want 7", got)
	}
}

// c-F8: compaction crash windows. The staging dance is tmp-file + rename:
//   - crash BEFORE the rename ⇒ the old journal is intact and a (fully
//     written) .compact.tmp sits beside it: load must recover the
//     PRE-compaction state and ignore the tmp;
//   - crash AFTER the rename, before the reopen ⇒ the journal IS the
//     compacted file: load must recover the POST-compaction state;
//   - a stray/garbage tmp beside a valid journal is ignored (the next
//     compaction overwrites it wholesale).
//
// Never a mix of the two states.
func TestNotifyLedgerCompactionCrashWindows(t *testing.T) {
	// Drive a REAL compaction to get the genuine post-rename on-disk shape.
	dirA := t.TempDir()
	pathA := filepath.Join(dirA, "a.ledger")
	la, err := armNotifyLedger(pathA, filepath.Join(dirA, "a.sources"), 3)
	if err != nil {
		t.Fatal(err)
	}
	for s := int64(1); s <= 5; s++ {
		page(t, la, "wrk", "e1", s)
	}
	if la.FirstID() != 3 {
		t.Fatalf("compaction must have run: firstID = %d", la.FirstID())
	}
	la.Close()
	compacted, err := os.ReadFile(pathA)
	if err != nil {
		t.Fatal(err)
	}

	// Post-rename-pre-reopen: the compacted journal reloads to the
	// POST-compaction state (head preserved, prefix gone).
	la2, err := armNotifyLedger(pathA, filepath.Join(dirA, "a.sources"), 3)
	if err != nil {
		t.Fatalf("post-rename shape must reload: %v", err)
	}
	if la2.Head() != 5 || la2.FirstID() != 3 || len(la2.EventsSince(0, 100)) != 3 {
		t.Fatalf("post-compaction recovery: head=%d firstID=%d events=%d", la2.Head(), la2.FirstID(), len(la2.EventsSince(0, 100)))
	}
	if st := mustSourceState(t, la2, "wrk"); st.HighSeq != 5 {
		t.Fatalf("post-compaction cursor: %+v", st)
	}
	la2.Close()

	// Post-temp-pre-rename: the old journal intact + the fully written
	// tmp beside it ⇒ the PRE-compaction state (tmp ignored, never mixed).
	dirB := t.TempDir()
	pathB := filepath.Join(dirB, "b.ledger")
	lb, err := armNotifyLedger(pathB, filepath.Join(dirB, "b.sources"), 100)
	if err != nil {
		t.Fatal(err)
	}
	for s := int64(1); s <= 5; s++ {
		page(t, lb, "wrk", "e1", s)
	}
	lb.Close()
	if err := os.WriteFile(pathB+".compact.tmp", compacted, 0o600); err != nil {
		t.Fatal(err)
	}
	lb2, err := armNotifyLedger(pathB, filepath.Join(dirB, "b.sources"), 100)
	if err != nil {
		t.Fatalf("pre-rename shape must reload: %v", err)
	}
	if lb2.Head() != 5 || lb2.FirstID() != 1 || len(lb2.EventsSince(0, 100)) != 5 {
		t.Fatalf("pre-compaction recovery (tmp ignored): head=%d firstID=%d events=%d", lb2.Head(), lb2.FirstID(), len(lb2.EventsSince(0, 100)))
	}
	if st := mustSourceState(t, lb2, "wrk"); st.HighSeq != 5 {
		t.Fatalf("pre-compaction cursor: %+v", st)
	}

	// A stray GARBAGE tmp beside a valid journal is ignored, and the next
	// compaction overwrites it wholesale (never a stale-content mix).
	if err := os.WriteFile(pathB+".compact.tmp", []byte("garbage, not JSON\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lb3, err := armNotifyLedger(pathB, filepath.Join(dirB, "b.sources"), 4)
	if err != nil {
		t.Fatalf("stray tmp must not break the load: %v", err)
	}
	page(t, lb3, "wrk", "e1", 6) // pushes past retention 4 ⇒ compaction runs
	if lb3.FirstID() != 3 {
		t.Fatalf("compaction must have consumed the stray tmp: firstID=%d", lb3.FirstID())
	}
	lb3.Close()
	lb4, err := armNotifyLedger(pathB, filepath.Join(dirB, "b.sources"), 4)
	if err != nil {
		t.Fatalf("reload after compaction over a stray tmp: %v", err)
	}
	defer lb4.Close()
	if lb4.Head() != 6 || lb4.FirstID() != 3 || len(lb4.EventsSince(0, 100)) != 4 {
		t.Fatalf("post-compaction reload: head=%d firstID=%d events=%d", lb4.Head(), lb4.FirstID(), len(lb4.EventsSince(0, 100)))
	}
}

// --- 6: epoch reset + gap recording -----------------------------------------

func TestNotifyLedgerEpochResetRecordsGapAndResetsCursor(t *testing.T) {
	l, ledgerPath, _ := armTestLedger(t, 0)
	page(t, l, "wrk", "e1", 1, 2, 3)

	// A page under a NEW epoch without a reset is refused.
	if _, err := l.CommitPage(notifyPageCommit{
		SourceID: "wrk", WorkerID: "wrk", Epoch: "e2",
		Records: []NotifyEvent{lrec(1, "finished")}, AdvanceTo: 1,
	}); err == nil {
		t.Fatal("epoch mismatch must be refused (reset first)")
	}

	if err := l.ResetSourceEpoch("wrk", "e2"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	st := mustSourceState(t, l, "wrk")
	if st.Epoch != "e2" || st.HighSeq != 0 || st.LowSeq != 0 || st.AckedSeq != 0 {
		t.Fatalf("post-reset state: %+v", st)
	}
	if len(st.Gaps) != 1 || st.Gaps[0].Epoch != "e1" || st.Gaps[0].FromSeq != 4 ||
		!st.Gaps[0].OpenEnd || st.Gaps[0].Reason != "epoch_rotation" {
		t.Fatalf("rotation gap must be open-end under the departed epoch from cursor+1: %+v", st.Gaps)
	}
	// The new epoch's seq namespace restarts at 1 — a DIFFERENT namespace,
	// not a cursor regression.
	evs := page(t, l, "wrk", "e2", 1, 2)
	if evs[0].ID != 4 {
		t.Fatalf("new-epoch ids continue globally: %v", idsOf(evs))
	}
	if st := mustSourceState(t, l, "wrk"); st.HighSeq != 2 || st.Epoch != "e2" {
		t.Fatalf("new-epoch cursor: %+v", st)
	}
	cov := l.Coverage()
	if cov.Complete {
		t.Fatal("rotation gap must mark coverage incomplete")
	}
	// Idempotent reset to the same epoch: no double gap.
	if err := l.ResetSourceEpoch("wrk", "e2"); err != nil {
		t.Fatalf("idempotent reset: %v", err)
	}
	if len(mustSourceState(t, l, "wrk").Gaps) != 1 {
		t.Fatal("same-epoch reset must be a no-op")
	}

	// Reload: the reset + gap survive.
	l.Close()
	l2, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 0)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	defer l2.Close()
	st2 := mustSourceState(t, l2, "wrk")
	if st2.Epoch != "e2" || st2.HighSeq != 2 || len(st2.Gaps) != 1 {
		t.Fatalf("post-reload epoch state: %+v", st2)
	}
}

// --- 7: overflow gap (worker prefix loss) ------------------------------------

func TestNotifyLedgerOverflowGapWorkerPrefixLost(t *testing.T) {
	l, _, _ := armTestLedger(t, 0)
	page(t, l, "wrk", "e1", 1, 2)

	// The worker evicted 3..6 (overflow): the next page starts at 7. The
	// commit must carry the closed gap [3..6] to advance the cursor.
	gap := NotifySourceGap{Epoch: "e1", FromSeq: 3, ToSeq: 6, Reason: "worker_prefix_lost"}
	evs := pageGap(t, l, "wrk", "e1", []int64{7, 8}, 8, &gap)
	if len(evs) != 2 || evs[0].ID != 3 {
		t.Fatalf("post-gap page: %+v", evs)
	}
	st := mustSourceState(t, l, "wrk")
	if st.HighSeq != 8 {
		t.Fatalf("cursor must advance past the gap: %+v", st)
	}
	if len(st.Gaps) != 1 || st.Gaps[0].FromSeq != 3 || st.Gaps[0].ToSeq != 6 || st.Gaps[0].OpenEnd {
		t.Fatalf("overflow gap: %+v", st.Gaps)
	}

	// A cursor jump WITHOUT a covering gap is refused (silent skip): the
	// page carries seq 11 but claims nextSince 13 — seq 12 would be
	// silently skipped.
	if _, err := l.CommitPage(notifyPageCommit{
		SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
		Records: []NotifyEvent{lrec(11, "finished")}, AdvanceTo: 13,
	}); err == nil {
		t.Fatal("cursor advance beyond last record without a gap must be refused")
	}
}

// c-F6: a cursor jump that carries a gap must carry a gap that COVERS the
// jump — a gap ending short of the claimed cursor leaves the remainder of
// the skipped range silently un-ingested. An open-end gap covers onward
// by construction (unknown upper bound).
func TestNotifyLedgerCursorJumpRequiresCoveringGap(t *testing.T) {
	l, _, _ := armTestLedger(t, 0)
	page(t, l, "wrk", "e1", 1, 2)

	// Records through 8, a gap covering only [3,6], but the page claims
	// the cursor at 9: seq 9 would be silently skipped.
	short := NotifySourceGap{Epoch: "e1", FromSeq: 3, ToSeq: 6, Reason: "worker_prefix_lost"}
	if _, err := l.CommitPage(notifyPageCommit{
		SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
		Records:   []NotifyEvent{lrec(7, "finished"), lrec(8, "finished")},
		AdvanceTo: 9, Gap: &short,
	}); err == nil {
		t.Fatal("cursor jump past the covering gap's end must be refused (seq 9 silently skipped)")
	}
	if st := mustSourceState(t, l, "wrk"); st.HighSeq != 2 {
		t.Fatalf("refused jump must not advance the cursor: %+v", st)
	}
	// Open-end gap: unknown upper bound covers onward — accepted.
	og := NotifySourceGap{Epoch: "e1", FromSeq: 3, ToSeq: 3, OpenEnd: true, Reason: "worker_prefix_lost"}
	if _, err := l.CommitPage(notifyPageCommit{
		SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
		Records:   []NotifyEvent{lrec(7, "finished"), lrec(8, "finished")},
		AdvanceTo: 9, Gap: &og,
	}); err != nil {
		t.Fatalf("open-end gap covers onward by construction: %v", err)
	}
	if st := mustSourceState(t, l, "wrk"); st.HighSeq != 9 {
		t.Fatalf("open-end gap must advance the cursor to 9: %+v", st)
	}
}

// b-F1 (interval): CommitPage must validate the ENTIRE consumed interval
// (committed cursor, new cursor] — every seq in it is either a fresh record
// or covered by an explicit SAME-EPOCH gap entry. The trailing-edge rule
// alone (c-F6) let a page [seq 4] at cursor 2 commit silently and strand
// seq 3 forever (its later delivery is replay-discarded). Pinned at the
// LEDGER level: the ledger is the transactional authority — this bar must
// not lean on the pull loop's gap bookkeeping.
func TestNotifyLedgerCommitPageRefusesUncoveredIntervalHoles(t *testing.T) {
	t.Run("leading hole refused, gap-covered accepted", func(t *testing.T) {
		l, _, _ := armTestLedger(t, 0)
		page(t, l, "wrk", "e1", 1, 2) // committed cursor 2

		// The exact blocker shape: first fresh seq (4) above cursor+1 (3),
		// AdvanceTo == last record — the old rule never looked at it.
		if _, err := l.CommitPage(notifyPageCommit{
			SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
			Records: []NotifyEvent{lrec(4, "finished")}, AdvanceTo: 4,
		}); err == nil {
			t.Fatal("a leading hole (first record 4 at cursor 2, seq 3 unexplained) must be refused")
		}
		// A departed-epoch gap does not explain a hole in the CURRENT
		// epoch's interval — only a same-epoch gap covers.
		wrongEpoch := NotifySourceGap{Epoch: "e0", FromSeq: 3, ToSeq: 3, Reason: "epoch_rotation"}
		if _, err := l.CommitPage(notifyPageCommit{
			SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
			Records: []NotifyEvent{lrec(4, "finished")}, AdvanceTo: 4, Gap: &wrongEpoch,
		}); err == nil {
			t.Fatal("a wrong-epoch gap must not cover a hole in the page's epoch")
		}
		if st := mustSourceState(t, l, "wrk"); st.HighSeq != 2 || len(st.Gaps) != 0 {
			t.Fatalf("refused commits must not advance the cursor or record gaps: %+v", st)
		}
		// The explicit same-epoch gap explains [3,3]: accepted.
		cover := NotifySourceGap{Epoch: "e1", FromSeq: 3, ToSeq: 3, Reason: "worker_prefix_lost"}
		if _, err := l.CommitPage(notifyPageCommit{
			SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
			Records: []NotifyEvent{lrec(4, "finished")}, AdvanceTo: 4, Gap: &cover,
		}); err != nil {
			t.Fatalf("a leading hole covered by an explicit same-epoch gap must commit: %v", err)
		}
		if st := mustSourceState(t, l, "wrk"); st.HighSeq != 4 || len(st.Gaps) != 1 {
			t.Fatalf("gap-covered leading hole must advance the cursor to 4 and record the gap: %+v", st)
		}
	})

	t.Run("interior hole refused, gap-covered accepted", func(t *testing.T) {
		l, _, _ := armTestLedger(t, 0)
		page(t, l, "wrk", "e1", 1, 2)

		// Records 3 and 5: seq 4 in the middle of the page is silently
		// skipped — the old rule only checked the trailing edge.
		if _, err := l.CommitPage(notifyPageCommit{
			SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
			Records: []NotifyEvent{lrec(3, "finished"), lrec(5, "finished")}, AdvanceTo: 5,
		}); err == nil {
			t.Fatal("an interior hole (seq 4 between records 3 and 5) must be refused")
		}
		if st := mustSourceState(t, l, "wrk"); st.HighSeq != 2 {
			t.Fatalf("refused commit must not advance the cursor: %+v", st)
		}
		cover := NotifySourceGap{Epoch: "e1", FromSeq: 4, ToSeq: 4, Reason: "worker_prefix_lost"}
		if _, err := l.CommitPage(notifyPageCommit{
			SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
			Records: []NotifyEvent{lrec(3, "finished"), lrec(5, "finished")}, AdvanceTo: 5, Gap: &cover,
		}); err != nil {
			t.Fatalf("an interior hole covered by an explicit same-epoch gap must commit: %v", err)
		}
		if st := mustSourceState(t, l, "wrk"); st.HighSeq != 5 {
			t.Fatalf("gap-covered interior hole must advance the cursor to 5: %+v", st)
		}
	})

	t.Run("trailing jump refused", func(t *testing.T) {
		// The c-F6 rule, now one case of the interval walk (pinned in full
		// by TestNotifyLedgerCursorJumpRequiresCoveringGap above).
		l, _, _ := armTestLedger(t, 0)
		page(t, l, "wrk", "e1", 1, 2)
		if _, err := l.CommitPage(notifyPageCommit{
			SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
			Records: []NotifyEvent{lrec(3, "finished")}, AdvanceTo: 5,
		}); err == nil {
			t.Fatal("a trailing jump past the last covered seq without a covering gap must be refused")
		}
		if st := mustSourceState(t, l, "wrk"); st.HighSeq != 2 {
			t.Fatalf("refused jump must not advance the cursor: %+v", st)
		}
	})

	t.Run("full coverage happy path", func(t *testing.T) {
		// Ordinary traffic stays committable — the bar refuses UNEXPLAINED
		// holes, never contiguous pages, replay overlaps, or a fully
		// gap-explained advance-only page.
		l, _, _ := armTestLedger(t, 0)
		evs := page(t, l, "wrk", "e1", 1, 2, 3)
		if len(evs) != 3 || evs[2].ID != 3 {
			t.Fatalf("contiguous first page: %+v", evs)
		}
		evs = page(t, l, "wrk", "e1", 3, 4, 5) // replay overlap + new tail
		if len(evs) != 2 || evs[0].Seq != 4 || evs[1].Seq != 5 {
			t.Fatalf("overlapping contiguous page must commit its new tail only: %+v", evs)
		}
		cover := NotifySourceGap{Epoch: "e1", FromSeq: 6, ToSeq: 8, Reason: "worker_prefix_lost"}
		if _, err := l.CommitPage(notifyPageCommit{
			SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
			AdvanceTo: 8, Gap: &cover,
		}); err != nil {
			t.Fatalf("a fully gap-explained advance-only page must commit: %v", err)
		}
		if st := mustSourceState(t, l, "wrk"); st.HighSeq != 8 || st.LowSeq != 1 {
			t.Fatalf("advance-only page must advance the cursor to 8: %+v", st)
		}
	})
}

// d-F6 (write/replay symmetry): ResetSourceEpoch legally writes an
// epoch_reset for a source with no prior state; the journal it produces
// must reload. Replay accepts the establishing reset (the same rule as a
// first page) — a legally-writable journal may never become unreloadable.
func TestNotifyLedgerEpochResetUnknownSourceWritesAndReplays(t *testing.T) {
	l, ledgerPath, _ := armTestLedger(t, 0)
	if err := l.ResetSourceEpoch("ghost", "e9"); err != nil {
		t.Fatalf("reset for an unknown source is a legal write: %v", err)
	}
	page(t, l, "ghost", "e9", 1)
	l.Close()

	l2, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 0)
	if err != nil {
		t.Fatalf("a legally-written epoch_reset must replay: %v", err)
	}
	defer l2.Close()
	st := mustSourceState(t, l2, "ghost")
	if st.Epoch != "e9" || st.HighSeq != 1 || st.LowSeq != 1 {
		t.Fatalf("post-reload established source state: %+v", st)
	}
	if l2.Head() != 1 {
		t.Fatalf("head after reload = %d, want 1", l2.Head())
	}
}

// --- 8: ACK only after commit -------------------------------------------------

func TestNotifyLedgerAckOnlyAfterCommit(t *testing.T) {
	l, ledgerPath, _ := armTestLedger(t, 0)

	if err := l.RecordAck("ghost", 1); err == nil {
		t.Fatal("ack for an unknown source must fail")
	}
	page(t, l, "wrk", "e1", 1, 2, 3)
	if err := l.RecordAck("wrk", 4); err == nil {
		t.Fatal("ack beyond the committed cursor must fail (ACK only after commit)")
	}
	if err := l.RecordAck("wrk", 3); err != nil {
		t.Fatalf("ack at cursor: %v", err)
	}
	if err := l.RecordAck("wrk", 2); err != nil {
		t.Fatalf("older ack must be an idempotent no-op: %v", err)
	}
	if st := mustSourceState(t, l, "wrk"); st.AckedSeq != 3 {
		t.Fatalf("acked = %d, want 3 (monotone)", st.AckedSeq)
	}
	// The ACK's structural bar also holds on replay: an ack line beyond the
	// cursor is corruption (pinned in the corrupt-matrix above).
	l.Close()
	l2, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	if st := mustSourceState(t, l2, "wrk"); st.AckedSeq != 3 {
		t.Fatalf("acked after reload = %d", st.AckedSeq)
	}
}

// --- 9: head never regresses — reload observes the committed head exactly ----

func TestNotifyLedgerHeadNeverRegresses(t *testing.T) {
	l, ledgerPath, _ := armTestLedger(t, 0)
	for s := int64(1); s <= 5; s++ {
		page(t, l, "wrk", "e1", s)
	}
	l.Close()
	for i := 0; i < 3; i++ {
		l2, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 0)
		if err != nil {
			t.Fatal(err)
		}
		if got := l2.Head(); got != 5 {
			t.Fatalf("reload #%d head = %d, want 5 (head never regresses)", i, got)
		}
		l2.Close()
	}
	// And after new commits the reloaded head continues forward.
	l3, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer l3.Close()
	if evs := page(t, l3, "wrk", "e1", 6); evs[0].ID != 6 {
		t.Fatalf("id continuation across reloads: %v", idsOf(evs))
	}
}

// --- 10: failed rollback poisons the ledger (b-F4) ------------------------------

// TestNotifyLedgerFailedRollbackPoisons uses the test-only injection seams
// (testWrite/testSync/testTruncate — nil in production) to fail
// Write/Sync/Truncate deterministically:
//
//   - (i) a partial Write + SUCCESSFUL rollback: an explicit short-write
//     error (never %!w(<nil>), c-F2), and the retry commits cleanly;
//   - (ii) a rollback FAILURE: the ledger is poisoned — every further
//     mutation is refused as ErrNotifyLedgerPoisoned (fatal, not a
//     retryable source failure), and a restart reloads to the last
//     committed state (the surviving fragment is a torn tail: discarded).
func TestNotifyLedgerFailedRollbackPoisons(t *testing.T) {
	l, ledgerPath, _ := armTestLedger(t, 0)
	page(t, l, "wrk", "e1", 1)
	if err := l.RecordAck("wrk", 1); err != nil {
		t.Fatal(err)
	}

	// (i) partial write (real bytes on disk, short count, nil error) with
	// a working rollback.
	l.testWrite = func(f *os.File, b []byte) (int, error) {
		return f.Write(b[:len(b)/2])
	}
	_, err := l.CommitPage(notifyPageCommit{
		SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
		Records: []NotifyEvent{lrec(2, "finished"), lrec(3, "finished")}, AdvanceTo: 3,
	})
	if err == nil {
		t.Fatal("a partial write must fail the commit")
	}
	if !strings.Contains(err.Error(), "short write") {
		t.Fatalf("the error must name the short write explicitly, got %q", err)
	}
	if strings.Contains(err.Error(), "%!w") {
		t.Fatalf("the error must never carry a nil wrap, got %q", err)
	}
	l.testWrite = nil
	// The rollback restored the committed prefix: the retry is clean and
	// exact (no fragment, no duplicate ids).
	page(t, l, "wrk", "e1", 2, 3)
	if got := l.Head(); got != 3 {
		t.Fatalf("head after clean retry = %d, want 3", got)
	}

	// (ii) rollback FAILURE poisons: a fragment survives (truncate
	// injected to fail), so the ledger must refuse every mutation.
	l.testWrite = func(f *os.File, b []byte) (int, error) {
		return f.Write(b[:len(b)/2]) // real partial bytes land on disk
	}
	l.testTruncate = func(f *os.File, size int64) error {
		return fmt.Errorf("injected truncate failure")
	}
	_, err = l.CommitPage(notifyPageCommit{
		SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
		Records: []NotifyEvent{lrec(4, "finished")}, AdvanceTo: 4,
	})
	if err == nil || !errors.Is(err, ErrNotifyLedgerPoisoned) {
		t.Fatalf("a failed rollback must report ErrNotifyLedgerPoisoned, got %v", err)
	}
	// Every further mutation is refused — classified fatal, never a
	// retryable source failure.
	if _, err := l.CommitPage(notifyPageCommit{
		SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
		Records: []NotifyEvent{lrec(4, "finished")}, AdvanceTo: 4,
	}); err == nil || !errors.Is(err, ErrNotifyLedgerPoisoned) {
		t.Fatalf("a poisoned ledger must refuse CommitPage, got %v", err)
	}
	if err := l.RecordAck("wrk", 3); err == nil || !errors.Is(err, ErrNotifyLedgerPoisoned) {
		t.Fatalf("a poisoned ledger must refuse RecordAck, got %v", err)
	}
	if err := l.ResetSourceEpoch("wrk", "e2"); err == nil || !errors.Is(err, ErrNotifyLedgerPoisoned) {
		t.Fatalf("a poisoned ledger must refuse ResetSourceEpoch, got %v", err)
	}
	// The fragment is physically there (the rollback failed)...
	fi, _ := os.Stat(ledgerPath)
	raw, _ := os.ReadFile(ledgerPath)
	if int64(len(raw)) != fi.Size() || fi.Size() <= 0 {
		t.Fatalf("fragment must survive on disk: size=%d", fi.Size())
	}
	// ...and the restart recovers: the fragment is a torn tail (no trailing
	// newline) — discarded, truncated, the last COMMITTED state survives.
	l.Close()
	l2, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 0)
	if err != nil {
		t.Fatalf("restart after poison must recover from the committed prefix: %v", err)
	}
	defer l2.Close()
	if l2.Head() != 3 || len(l2.EventsSince(0, 100)) != 3 {
		t.Fatalf("recovered state: head=%d events=%d, want 3/3 (last committed)", l2.Head(), len(l2.EventsSince(0, 100)))
	}
	if st := mustSourceState(t, l2, "wrk"); st.HighSeq != 3 || st.AckedSeq != 1 {
		t.Fatalf("recovered source state: %+v", st)
	}
	// The recovered ledger CONTINUES cleanly from the committed state.
	if evs := page(t, l2, "wrk", "e1", 4); evs[0].ID != 4 {
		t.Fatalf("post-recovery continuation: %v", idsOf(evs))
	}
}

// --- 11: write/replay validation symmetry (tier1_b:F1) ------------------------
//
// CommitPage accepted and fsynced events with Type == "" or Ts == 0 and
// advanced the cursor, while replayRecord rejects exactly those shapes on
// reload ("event %d missing type/ts"): a correctly-identified page could
// commit + ACK (the worker trims its feed), and the controller would then
// refuse to restart from its own journal. The write side must mirror the
// replay grammar BEFORE anything durable changes — and ingest ACKs only on
// commit success, so ledger-level refusal is the whole bar.
func TestNotifyLedgerCommitPageRefusesReplayInvalidEvents(t *testing.T) {
	for name, breakEvent := range map[string]func(*NotifyEvent){
		"empty type": func(ev *NotifyEvent) { ev.Type = "" },
		"zero ts":    func(ev *NotifyEvent) { ev.Ts = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			l, ledgerPath, _ := armTestLedger(t, 0)
			page(t, l, "wrk", "e1", 1) // established source + committed prefix
			rawBefore, err := os.ReadFile(ledgerPath)
			if err != nil {
				t.Fatal(err)
			}

			bad := lrec(2, "finished")
			breakEvent(&bad)
			if evs, cerr := l.CommitPage(notifyPageCommit{
				SourceID: "wrk", WorkerID: "wrk", Epoch: "e1",
				Records: []NotifyEvent{bad}, AdvanceTo: 2,
			}); cerr == nil {
				t.Fatalf("CommitPage must refuse a replay-invalid event (the committed journal would not reopen), got commit %v", idsOf(evs))
			}
			// Nothing durable changed: the journal is byte-identical...
			rawAfter, err := os.ReadFile(ledgerPath)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(rawBefore, rawAfter) {
				t.Fatal("the journal must be byte-unchanged by the refused commit")
			}
			// ...and no memory advanced: head, cursor, retained events.
			if got := l.Head(); got != 1 {
				t.Fatalf("head = %d, want 1 (a refused commit must not advance memory)", got)
			}
			if got := len(l.EventsSince(0, 100)); got != 1 {
				t.Fatalf("retained %d events, want 1", got)
			}
			if st := mustSourceState(t, l, "wrk"); st.HighSeq != 1 {
				t.Fatalf("cursor = %d, want 1 (a refused commit must not advance the cursor)", st.HighSeq)
			}
			// No ACK may trail the refused page: the cursor never moved,
			// so an ack of its seq sits beyond the committed cursor —
			// the same structural bar replay enforces on ack lines.
			if err := l.RecordAck("wrk", 2); err == nil {
				t.Fatal("an ack for the refused page's seq must fail (beyond the committed cursor — no ack may trail a refused commit)")
			}
			// The byte-unchanged journal reopens cleanly.
			l.Close()
			l2, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 0)
			if err != nil {
				t.Fatalf("the unchanged journal must reopen cleanly: %v", err)
			}
			defer l2.Close()
			if l2.Head() != 1 || len(l2.EventsSince(0, 100)) != 1 {
				t.Fatalf("post-reload state: head=%d events=%d, want 1/1", l2.Head(), len(l2.EventsSince(0, 100)))
			}

			// Positive control on the same ledger: the same page shape
			// with valid type/ts still commits, and the journal it
			// produces still reopens.
			evs := page(t, l2, "wrk", "e1", 2)
			if len(evs) != 1 || evs[0].ID != 2 {
				t.Fatalf("valid control commit must land as event 2: %+v", evs)
			}
			l2.Close()
			l3, err := armNotifyLedger(ledgerPath, ledgerPath+".no-witness", 0)
			if err != nil {
				t.Fatalf("journal after the valid control commit must reopen: %v", err)
			}
			defer l3.Close()
			if l3.Head() != 2 {
				t.Fatalf("head after the valid control commit = %d, want 2", l3.Head())
			}
		})
	}
}
