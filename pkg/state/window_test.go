package state

// This file pins the transcript-windowing bounded projection (Phase 1): the
// initial cold-load view ships only a bounded recent tail of a session's
// transcript (100 messages / 1 MiB dual bound), and older messages arrive via
// the historical HTTP page endpoint (Phase 2+). The per-part text cap
// (part_cap_test.go) is a separate stopgap that bounds individual parts; this
// is the STRUCTURAL fix that bounds the aggregate.
//
// The projector (projectMessageWindow) is PURE and DETERMINISTIC — same input
// → same bounded list + same WindowMeta. This is what preserves the monotonic
// revision-validation contract under windowing: the same captured state always
// projects to the same bytes, so publishColdBatch's msgRev equality check
// remains sound (no false staleness discard).

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// withWindowBounds sets the per-instance dual message-window bound (count +
// bytes) on a Config (the GAP-S5-promoted tunables), returning the modified
// Config for chaining. Pair with mustNew so the values flow through
// Config.validate() at construction — no Store instance field is mutated
// post-construction. Mirrors withPartTextCap / withFlushInterval. Tests that
// exercise the PURE projector (projectMessageWindow) with explicit params do
// NOT need this — the helper only affects the store read path
// (SnapshotMessagesPage / captureMessagesBatchLocked / materializeSnapshot).
func withWindowBounds(cfg Config, maxCount, maxBytes int) Config {
	cfg.WindowMaxCount = maxCount
	cfg.WindowMaxBytes = maxBytes
	return cfg
}

// winMsg builds a MessageWithParts with id <id> and one text part of <textSize>
// 'x' bytes. For pure-projector tests (no store). The serialized size is
// len(Info) + len(Part), computable via messageSerializedBytes.
func winMsg(id string, textSize int) MessageWithParts {
	info := json.RawMessage(`{"id":"` + id + `","sessionID":"s","role":"user"}`)
	part := json.RawMessage(`{"id":"` + id + `-p0","type":"text","text":"` + strings.Repeat("x", textSize) + `"}`)
	return MessageWithParts{Info: info, Parts: []json.RawMessage{part}}
}

// msgIDs extracts the ordered message ids from a []MessageWithParts (via
// messageIDFromInfo) for assertion readability.
func msgIDs(list []MessageWithParts) []string {
	out := make([]string, len(list))
	for i, m := range list {
		out[i] = messageIDFromInfo(m.Info)
	}
	return out
}

// TestWindow_CountBound is required test (a): more messages than maxCount → the
// window carries exactly maxCount NEWEST messages, has_older is true, and
// count_limited is the binding constraint. Messages stay atomic and ordered
// (oldest first in the result, matching the wire shape).
func TestWindow_CountBound(t *testing.T) {
	// Pure-projector test: passes explicit (maxCount, maxBytes) to
	// projectMessageWindow, so no store / no instance bound needed (the
	// withWindowBounds helper exists for the store read path only).

	list := []MessageWithParts{
		winMsg("m1", 10),
		winMsg("m2", 10),
		winMsg("m3", 10),
		winMsg("m4", 10),
		winMsg("m5", 10),
	}
	bounded, meta := projectMessageWindow(list, 3, 1<<20, true)

	if got := msgIDs(bounded); !equalStrings(got, []string{"m3", "m4", "m5"}) {
		t.Fatalf("count-bound window must be the 3 newest in creation order: got %v", got)
	}
	if meta.MessageCount != 3 {
		t.Fatalf("MessageCount: want 3, got %d", meta.MessageCount)
	}
	if !meta.HasOlder {
		t.Fatalf("HasOlder: want true (m1,m2 exist beyond window)")
	}
	if !meta.CountLimited {
		t.Fatalf("CountLimited: want true (stopped at maxCount)")
	}
	if meta.BytesLimited {
		t.Fatalf("BytesLimited: want false (byte budget not hit)")
	}
	if meta.OversizedItem {
		t.Fatalf("OversizedItem: want false")
	}
	if meta.OldestLoadedID != "m3" {
		t.Fatalf("OldestLoadedID: want m3 (oldest in window), got %q", meta.OldestLoadedID)
	}
}

// TestWindow_ByteBound is required test (b): messages whose aggregate exceeds
// maxBytes → the window stops BEFORE the message that would cross the budget,
// has_older is true, and bytes_limited is the binding constraint. The excluded
// message is the oldest (the walk is newest-to-oldest).
func TestWindow_ByteBound(t *testing.T) {
	m1 := winMsg("m1", 100)
	m2 := winMsg("m2", 100)
	m3 := winMsg("m3", 100)
	size1 := messageSerializedBytes(m1)

	// Budget fits m3 + m2 exactly, but adding m1 would exceed. So the window is
	// {m2, m3} and m1 is the excluded older message.
	budget := size1 * 2 // fits exactly 2 messages (the 2 newest)
	bounded, meta := projectMessageWindow([]MessageWithParts{m1, m2, m3}, 100, budget, true)

	if got := msgIDs(bounded); !equalStrings(got, []string{"m2", "m3"}) {
		t.Fatalf("byte-bound window must be the 2 newest that fit: got %v", got)
	}
	if meta.MessageCount != 2 {
		t.Fatalf("MessageCount: want 2, got %d", meta.MessageCount)
	}
	if !meta.HasOlder {
		t.Fatalf("HasOlder: want true (m1 exists beyond window)")
	}
	if !meta.BytesLimited {
		t.Fatalf("BytesLimited: want true (adding m1 would exceed budget)")
	}
	if meta.CountLimited {
		t.Fatalf("CountLimited: want false (count budget not hit)")
	}
	if meta.OldestLoadedID != "m2" {
		t.Fatalf("OldestLoadedID: want m2, got %q", meta.OldestLoadedID)
	}
}

// TestWindow_OversizedNewest is required test (c): when the single NEWEST
// message alone exceeds the byte budget, the projector returns it ALONE (always
// include at least one) + oversized_item/actual_bytes/budget_bytes diagnostics.
// has_older reflects whether older messages exist beyond it. This is the
// pathological-runaway-tool-output case (the measured 102MB max).
func TestWindow_OversizedNewest(t *testing.T) {
	small := winMsg("m1", 10)
	huge := winMsg("m2", 5000) // 5 KiB — far over a tiny budget

	bounded, meta := projectMessageWindow([]MessageWithParts{small, huge}, 100, 1000, true)

	if got := msgIDs(bounded); !equalStrings(got, []string{"m2"}) {
		t.Fatalf("oversized window must be the newest alone: got %v", got)
	}
	if meta.MessageCount != 1 {
		t.Fatalf("MessageCount: want 1, got %d", meta.MessageCount)
	}
	if !meta.HasOlder {
		t.Fatalf("HasOlder: want true (m1 exists beyond the oversized newest)")
	}
	if !meta.OversizedItem {
		t.Fatalf("OversizedItem: want true")
	}
	if meta.ActualBytes != messageSerializedBytes(huge) {
		t.Fatalf("ActualBytes: want %d, got %d", messageSerializedBytes(huge), meta.ActualBytes)
	}
	if meta.BudgetBytes != 1000 {
		t.Fatalf("BudgetBytes: want 1000, got %d", meta.BudgetBytes)
	}
	if meta.CountLimited || meta.BytesLimited {
		t.Fatalf("CountLimited/BytesLimited: want false (oversized short-circuits before either)")
	}
}

// TestWindow_OversizedNewest_SingleMessage: the oversized newest is the ONLY
// message. has_older must be false (nothing older exists).
func TestWindow_OversizedNewest_SingleMessage(t *testing.T) {
	huge := winMsg("only", 5000)
	bounded, meta := projectMessageWindow([]MessageWithParts{huge}, 100, 1000, true)

	if got := msgIDs(bounded); !equalStrings(got, []string{"only"}) {
		t.Fatalf("oversized single-message window: got %v", got)
	}
	if meta.HasOlder {
		t.Fatalf("HasOlder: want false (no older messages exist)")
	}
	if !meta.OversizedItem {
		t.Fatalf("OversizedItem: want true")
	}
}

// TestWindow_EmptySession: an empty (but PRESENT) message list returns a
// NON-NIL empty slice + zero-value meta. This distinguishes "0-message session,
// emit an empty batch so the client knows it loaded as empty" from "session
// gone (nil list), emit nothing." The distinction is what makes
// TestColdBatchInvalidatedByMessageRemoved work (deleted message → 0-message
// session → empty batch emitted, not silently dropped).
func TestWindow_EmptySession(t *testing.T) {
	bounded, meta := projectMessageWindow([]MessageWithParts{}, 100, 1<<20, true)

	if bounded == nil {
		t.Fatalf("empty-session window must be NON-NIL ([]MessageWithParts{}) so it is not mistaken for a gone session")
	}
	if len(bounded) != 0 {
		t.Fatalf("empty-session window length: want 0, got %d", len(bounded))
	}
	if meta.MessageCount != 0 {
		t.Fatalf("MessageCount: want 0, got %d", meta.MessageCount)
	}
	if meta.HasOlder {
		t.Fatalf("HasOlder: want false")
	}
	if meta.OldestLoadedID != "" {
		t.Fatalf("OldestLoadedID: want empty, got %q", meta.OldestLoadedID)
	}
}

// TestWindow_SingleMessage: one message under both bounds → returns it alone,
// has_older=false (the window IS the whole transcript).
func TestWindow_SingleMessage(t *testing.T) {
	m := winMsg("solo", 100)
	bounded, meta := projectMessageWindow([]MessageWithParts{m}, 100, 1<<20, true)

	if got := msgIDs(bounded); !equalStrings(got, []string{"solo"}) {
		t.Fatalf("single-message window: got %v", got)
	}
	if meta.MessageCount != 1 {
		t.Fatalf("MessageCount: want 1, got %d", meta.MessageCount)
	}
	if meta.HasOlder {
		t.Fatalf("HasOlder: want false")
	}
	if meta.CountLimited || meta.BytesLimited || meta.OversizedItem {
		t.Fatalf("no limit flags should be set for a single under-bound message")
	}
}

// TestWindow_ExactFit: exactly maxCount messages, all comfortably under the byte
// budget → ALL included, has_older=false, no limit flags. The boundary must not
// false-positive (maxCount messages is the cap, not cap-1).
func TestWindow_ExactFit(t *testing.T) {
	list := []MessageWithParts{
		winMsg("m1", 10),
		winMsg("m2", 10),
		winMsg("m3", 10),
	}
	bounded, meta := projectMessageWindow(list, 3, 1<<20, true)

	if got := msgIDs(bounded); !equalStrings(got, []string{"m1", "m2", "m3"}) {
		t.Fatalf("exact-fit window must include all 3: got %v", got)
	}
	if meta.MessageCount != 3 {
		t.Fatalf("MessageCount: want 3, got %d", meta.MessageCount)
	}
	if meta.HasOlder {
		t.Fatalf("HasOlder: want false (all messages included)")
	}
	if meta.CountLimited || meta.BytesLimited {
		t.Fatalf("no limit flags should be set at exact fit")
	}
}

// TestWindow_Determinism: the projector is PURE — same input produces the same
// bounded list (byte-identical) + same WindowMeta across repeated calls. This is
// what preserves the revision-validation contract (no false staleness discard).
func TestWindow_Determinism(t *testing.T) {
	list := []MessageWithParts{
		winMsg("m1", 50),
		winMsg("m2", 60),
		winMsg("m3", 70),
		winMsg("m4", 80),
		winMsg("m5", 90),
	}
	b1, m1 := projectMessageWindow(list, 3, 500, false)
	b2, m2 := projectMessageWindow(list, 3, 500, false)

	if !equalMessageLists(b1, b2) {
		t.Fatalf("determinism: repeated projection produced different message lists")
	}
	if m1 != m2 {
		t.Fatalf("determinism: repeated projection produced different WindowMeta:\n m1=%+v\n m2=%+v", m1, m2)
	}
}

// TestWindow_OrderingPreserved: the result is always in CREATION ORDER (oldest
// first), matching the wire shape the client expects for prepend-on-load-more.
// The internal walk is newest-to-oldest (for the budget), but the output is
// re-reversed.
func TestWindow_OrderingPreserved(t *testing.T) {
	list := []MessageWithParts{
		winMsg("oldest", 10),
		winMsg("mid", 10),
		winMsg("newest", 10),
	}
	// Force a window that drops the oldest (count-bound at 2).
	bounded, _ := projectMessageWindow(list, 2, 1<<20, false)
	if got := msgIDs(bounded); !equalStrings(got, []string{"mid", "newest"}) {
		t.Fatalf("ordering: want [mid newest] (creation order), got %v", got)
	}
}

// TestWindow_SnapshotBoundsMessages: the Snapshot output (the cold-load initial
// window source) applies the projector per session. A session with >maxCount
// messages yields a bounded Messages[sid] + a MessageWindows[sid] carrying
// has_older/count. Tree-only snapshots (messagesFor={}) carry no messages and no
// windows.
func TestWindow_SnapshotBoundsMessages(t *testing.T) {
	s := mustNew(t, withWindowBounds(DefaultConfig(100), 2, 1<<20))

	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	for i := 1; i <= 5; i++ {
		s.Apply(ev("message.updated", `{"info":{"id":"m`+itoa(i)+`","sessionID":"sess","role":"user"}}`))
	}

	// Selected-session snapshot: bounded.
	scoped := s.Snapshot(map[string]bool{"sess": true})
	if got := scoped.Messages["sess"]; len(got) != 2 {
		t.Fatalf("scoped snapshot messages: want 2 (WindowMaxCount), got %d", len(got))
	}
	meta, ok := scoped.MessageWindows["sess"]
	if !ok {
		t.Fatalf("scoped snapshot must carry MessageWindows[sess]")
	}
	if meta.MessageCount != 2 {
		t.Fatalf("MessageWindows[sess].MessageCount: want 2, got %d", meta.MessageCount)
	}
	if !meta.HasOlder {
		t.Fatalf("MessageWindows[sess].HasOlder: want true (3 messages dropped)")
	}
	if !meta.CountLimited {
		t.Fatalf("MessageWindows[sess].CountLimited: want true")
	}

	// Tree-only snapshot: no messages, no windows.
	tree := s.Snapshot(map[string]bool{})
	if len(tree.Messages) != 0 {
		t.Fatalf("tree-only snapshot must carry no messages, got %d sessions", len(tree.Messages))
	}
	if len(tree.MessageWindows) != 0 {
		t.Fatalf("tree-only snapshot must carry no windows, got %d sessions", len(tree.MessageWindows))
	}
}

// TestWindow_SnapshotFirehoseBoundsAllSessions: the firehose path
// (messagesFor=nil, "all sessions") also applies the projector per session, so
// an admin ?sessions=all request cannot ship an unbounded transcript per
// session. Each session with messages gets its own WindowMeta.
func TestWindow_SnapshotFirehoseBoundsAllSessions(t *testing.T) {
	s := mustNew(t, withWindowBounds(DefaultConfig(100), 2, 1<<20))

	for _, sid := range []string{"a", "b"} {
		s.Apply(ev("session.created", `{"info":{"id":"`+sid+`"}}`))
		for i := 1; i <= 4; i++ {
			s.Apply(ev("message.updated", `{"info":{"id":"m`+itoa(i)+`","sessionID":"`+sid+`","role":"user"}}`))
		}
	}

	firehose := s.Snapshot(nil)
	for _, sid := range []string{"a", "b"} {
		if got := len(firehose.Messages[sid]); got != 2 {
			t.Fatalf("firehose Messages[%s]: want 2 (bounded), got %d", sid, got)
		}
		meta, ok := firehose.MessageWindows[sid]
		if !ok {
			t.Fatalf("firehose must carry MessageWindows[%s]", sid)
		}
		if !meta.HasOlder {
			t.Fatalf("firehose MessageWindows[%s].HasOlder: want true", sid)
		}
	}
}

// TestWindow_ColdBatchCarriesWindowMeta: the KindMessagesBatch payload (the SSE
// cold-load event) carries the window field in the OUTER envelope so a client
// reads has_older/count WITHOUT decompressing the gzip'd messages array. The
// window meta must reflect the bound applied to the emitted (bounded) message
// list, not the full transcript.
func TestWindow_ColdBatchCarriesWindowMeta(t *testing.T) {
	s := mustNew(t, withWindowBounds(DefaultConfig(100), 2, 1<<20))

	seedFourMessages(t, s, "cb")
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	s.SetSessionMessages("cb", fourMessageList("cb"))
	s.EmitMessagesLoaded("cb", 1, 1)

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 cold batch, got %d", len(batches))
	}
	msgs := decodeBatchMessages(t, batches[0].Payload)
	if len(msgs) != 2 {
		t.Fatalf("batch messages: want 2 (WindowMaxCount), got %d", len(msgs))
	}
	meta := decodeBatchWindow(t, batches[0].Payload)
	if meta.MessageCount != 2 {
		t.Fatalf("batch window.MessageCount: want 2, got %d", meta.MessageCount)
	}
	if !meta.HasOlder {
		t.Fatalf("batch window.HasOlder: want true (2 messages dropped)")
	}
	if !meta.CountLimited {
		t.Fatalf("batch window.CountLimited: want true")
	}
	if meta.OldestLoadedID != "m3" {
		t.Fatalf("batch window.OldestLoadedID: want m3 (oldest in the {m3,m4} window), got %q", meta.OldestLoadedID)
	}
}

// TestWindow_ColdBatchRevisionValidationHoldsUnderBound: the bounded projection
// is deterministic (same captured state → same bytes + same meta), so the
// monotonic revision validation in publishColdBatch does NOT falsely discard a
// batch captured at a stable revision. This is the gate-integrity test under
// windowing: without determinism, the revision equality check would be
// meaningless (each retry would project differently and the batch would loop).
//
// Mechanism: seed 4 messages, subscribe, then SetSessionMessages with the SAME 4
// messages (a stable reconcile — no mutation during packaging). publishColdBatch
// captures, packages the bounded window, validates (rev==rev), and emits exactly
// one batch. A nondeterministic projection would either retry-spam or emit
// inconsistent windows.
func TestWindow_ColdBatchRevisionValidationHoldsUnderBound(t *testing.T) {
	s := mustNew(t, withWindowBounds(DefaultConfig(100), 3, 1<<20))

	seedFourMessages(t, s, "rv")
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	s.SetSessionMessages("rv", fourMessageList("rv"))
	s.EmitMessagesLoaded("rv", 1, 1)

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("revision validation under bound: want exactly 1 batch (no false staleness discard), got %d", len(batches))
	}
	msgs := decodeBatchMessages(t, batches[0].Payload)
	if len(msgs) != 3 {
		t.Fatalf("batch messages: want 3 (WindowMaxCount), got %d", len(msgs))
	}
}

// TestWindow_TruncatedTailLight_HasOlderTrue is THE regression pin for the
// has-older lie: a cold tail of EXACTLY maxCount light messages (aggregate far
// under the byte budget) trips NEITHER dual bound, yet the resident list was
// truncated at FETCH time — older history exists in opencode beyond it. The
// caller-threaded exhaustion flag (historyExhausted=false, learned from the
// tail GET's X-Next-Cursor) must surface has_older=true so the SPA renders the
// Load-older affordance and pages history (repro: ses_ff9d55010ffer8bsHjyJ4Q4pMr,
// 1074 messages, newest-100 tail ~803KB < 1MiB, old code reported
// has_older=false + count_limited=false).
func TestWindow_TruncatedTailLight_HasOlderTrue(t *testing.T) {
	const maxCount = 100
	list := make([]MessageWithParts, 0, maxCount)
	for i := 1; i <= maxCount; i++ {
		list = append(list, winMsg("m"+itoa(i), 10))
	}
	bounded, meta := projectMessageWindow(list, maxCount, 1<<20, false)

	if len(bounded) != maxCount {
		t.Fatalf("window: want all %d light messages, got %d", maxCount, len(bounded))
	}
	if meta.MessageCount != maxCount {
		t.Fatalf("MessageCount: want %d, got %d", maxCount, meta.MessageCount)
	}
	if !meta.HasOlder {
		t.Fatalf("HasOlder: want TRUE (fetch-truncated tail, cursor evidence says older history exists) — the has-older lie regression")
	}
	if meta.CountLimited {
		t.Fatalf("CountLimited: want false (resident len == maxCount, no resident message was dropped)")
	}
	if meta.BytesLimited {
		t.Fatalf("BytesLimited: want false (light tail under the byte budget)")
	}
	if meta.OversizedItem {
		t.Fatalf("OversizedItem: want false")
	}
}

// TestWindow_FullyLoadedNoInverseLie pins the opposite direction: a session the
// store KNOWS is fully loaded (historyExhausted=true — the tail GET returned no
// X-Next-Cursor) must NOT advertise has_older, including the exact-fit edge
// (len == maxCount) where the old len<limit heuristic would have guessed
// "not exhausted" and forced a wasted self-correcting fetch. Cursor evidence
// settles both directions without guessing.
func TestWindow_FullyLoadedNoInverseLie(t *testing.T) {
	cases := []struct {
		name string
		n    int
	}{
		{"small session (n < maxCount)", 42},
		{"exact fit (n == maxCount)", 100},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			list := make([]MessageWithParts, 0, tc.n)
			for i := 1; i <= tc.n; i++ {
				list = append(list, winMsg("m"+itoa(i), 10))
			}
			bounded, meta := projectMessageWindow(list, 100, 1<<20, true)
			if len(bounded) != tc.n {
				t.Fatalf("window: want all %d messages resident, got %d", tc.n, len(bounded))
			}
			if meta.HasOlder {
				t.Fatalf("HasOlder: want FALSE (fully loaded, cursor said exhausted — no inverse lie)")
			}
			if meta.CountLimited || meta.BytesLimited || meta.OversizedItem {
				t.Fatalf("no limit flags should be set: %+v", meta)
			}
		})
	}
}

// TestWindow_OversizedExhaustionDirections: the oversized-newest short-circuit
// also honors the exhaustion input — a lone oversized resident that IS the whole
// transcript keeps has_older=false (exhausted=true), while one that may have
// older history beyond the fetch-bounded resident (exhausted=false) reports
// has_older=true.
func TestWindow_OversizedExhaustionDirections(t *testing.T) {
	huge := winMsg("huge", 5000)

	bounded, meta := projectMessageWindow([]MessageWithParts{huge}, 100, 1000, true)
	if len(bounded) != 1 || !meta.OversizedItem {
		t.Fatalf("oversized single-message shape: len=%d oversized=%v", len(bounded), meta.OversizedItem)
	}
	if meta.HasOlder {
		t.Fatalf("oversized + exhausted: HasOlder want false (the lone resident IS the whole transcript)")
	}

	_, meta2 := projectMessageWindow([]MessageWithParts{huge}, 100, 1000, false)
	if !meta2.HasOlder {
		t.Fatalf("oversized + NOT exhausted: HasOlder want true (older history may exist beyond the truncated resident)")
	}
}

// TestWindow_StoreSnapshot_TruncatedTailHasOlder: STORE-level pin for the
// SNAPSHOT WindowMeta producer (materializeSnapshot): a cold load installed via
// SetSessionMessagesExhausted with cursor evidence (a) not-exhausted → snapshot
// has_older=true even though neither dual bound fires on the light exact-window
// resident; (b) exhausted → has_older=false (no inverse lie). The exhaustion
// flag must travel through the snapshot CAPTURE (captured under the same lock
// as the message lists) into the projector.
func TestWindow_StoreSnapshot_TruncatedTailHasOlder(t *testing.T) {
	s := mustNew(t, withWindowBounds(DefaultConfig(100), 4, 1<<20))

	seedFourMessages(t, s, "trunc")
	seedFourMessages(t, s, "full")
	// "trunc": a 4-message resident at an exact 4-message window (the truncated
	// tail shape) whose tail GET carried X-Next-Cursor → NOT exhausted.
	// "full": a 3-message resident under the window whose tail GET carried NO
	// cursor → exhausted.
	s.SetSessionMessagesExhausted("trunc", fourMessageList("trunc"), false)
	s.SetSessionMessagesExhausted("full", fourMessageList("full")[:3], true)

	snap := s.Snapshot(map[string]bool{"trunc": true, "full": true})
	mt, ok := snap.MessageWindows["trunc"]
	if !ok {
		t.Fatalf("snapshot must carry MessageWindows[trunc]")
	}
	if !mt.HasOlder {
		t.Fatalf("snapshot MessageWindows[trunc].HasOlder: want true (fetch-truncated exact-window tail, not exhausted) — the has-older lie regression")
	}
	if mt.CountLimited || mt.BytesLimited {
		t.Fatalf("snapshot MessageWindows[trunc]: want no limit flags (light tail), got %+v", mt)
	}
	mf, ok := snap.MessageWindows["full"]
	if !ok {
		t.Fatalf("snapshot must carry MessageWindows[full]")
	}
	if mf.HasOlder {
		t.Fatalf("snapshot MessageWindows[full].HasOlder: want false (fully loaded, exhausted) — no inverse lie")
	}
}

// TestWindow_StoreColdBatch_TruncatedTailHasOlder: STORE-level pin for the COLD
// messages.batch WindowMeta producer (captureMessagesBatchLocked →
// publishColdBatch): the same truthful has_older as the snapshot — a
// cursor-evidenced not-exhausted exact-window light tail carries
// window.has_older=true in the OUTER batch envelope (the field the SPA's
// history.ts reads without decompressing), and an exhausted small session
// carries false.
func TestWindow_StoreColdBatch_TruncatedTailHasOlder(t *testing.T) {
	s := mustNew(t, withWindowBounds(DefaultConfig(100), 4, 1<<20))

	seedFourMessages(t, s, "trunc")
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	s.SetSessionMessagesExhausted("trunc", fourMessageList("trunc"), false)
	s.EmitMessagesLoaded("trunc", 1, 1)

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 cold batch, got %d", len(batches))
	}
	meta := decodeBatchWindow(t, batches[0].Payload)
	if len(decodeBatchMessages(t, batches[0].Payload)) != 4 {
		t.Fatalf("batch messages: want all 4 (exact window fit), got %d", len(decodeBatchMessages(t, batches[0].Payload)))
	}
	if !meta.HasOlder {
		t.Fatalf("batch window.HasOlder: want TRUE (fetch-truncated tail, not exhausted) — the has-older lie regression")
	}
	if meta.CountLimited || meta.BytesLimited {
		t.Fatalf("batch window: want no limit flags (light tail), got %+v", meta)
	}
}

// TestWindow_SetSessionMessagesHeuristicFallback: the no-evidence entry
// (SetSessionMessages) keeps the len<windowMaxCount fallback for backward
// compatibility — a partial window ⇒ exhausted (has_older=false), a full window
// ⇒ assume older may exist (has_older=true, self-correcting via the
// boundary-demand floor walk). Fresh creation only: the lists are installed
// WITHOUT prior live Apply (a live-created sessionMessages carries the
// zero-value flag, which the heuristic path preserves — warm reconciles never
// re-derive it without evidence).
func TestWindow_SetSessionMessagesHeuristicFallback(t *testing.T) {
	s := mustNew(t, withWindowBounds(DefaultConfig(100), 4, 1<<20))

	s.Apply(ev("session.created", `{"info":{"id":"part"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"fit"}}`))
	s.SetSessionMessages("part", fourMessageList("part")[:3]) // partial → exhausted
	s.SetSessionMessages("fit", fourMessageList("fit"))       // exact → assume older

	snap := s.Snapshot(map[string]bool{"part": true, "fit": true})
	if snap.MessageWindows["part"].HasOlder {
		t.Fatalf("partial-window heuristic: has_older want false (len < windowMaxCount ⇒ exhausted)")
	}
	if !snap.MessageWindows["fit"].HasOlder {
		t.Fatalf("full-window heuristic: has_older want true (len == windowMaxCount ⇒ assume older may exist)")
	}
}

// --- helpers used only by window_test.go ---

// equalStrings is a shallow slice equality helper (testing/stdlib has none).
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// equalMessageLists compares two []MessageWithParts by byte content (for the
// determinism test). Order matters (the projector must produce stable ordering).
func equalMessageLists(a, b []MessageWithParts) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !bytes.Equal(a[i].Info, b[i].Info) {
			return false
		}
		if len(a[i].Parts) != len(b[i].Parts) {
			return false
		}
		for j := range a[i].Parts {
			if !bytes.Equal(a[i].Parts[j], b[i].Parts[j]) {
				return false
			}
		}
	}
	return true
}

// itoa is strconv.Itoa without the import (keeps the test file's imports lean).
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	neg := i < 0
	if neg {
		i = -i
	}
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// seedFourMessages builds a session <sid> with 4 user messages m1..m4, no parts.
// Used by the cold-batch window tests.
func seedFourMessages(t *testing.T, s *Store, sid string) {
	t.Helper()
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`"}}`))
	for i := 1; i <= 4; i++ {
		s.Apply(ev("message.updated", `{"info":{"id":"m`+itoa(i)+`","sessionID":"`+sid+`","role":"user"}}`))
	}
}

// fourMessageList builds a 4-message MessageWithParts list (m1..m4) for a cold
// fetch, matching the seedFourMessages shape (used so SetSessionMessages carries
// the same messages the store already holds — a stable reconcile).
func fourMessageList(sid string) []MessageWithParts {
	out := make([]MessageWithParts, 0, 4)
	for i := 1; i <= 4; i++ {
		out = append(out, MessageWithParts{
			Info: json.RawMessage(`{"id":"m` + itoa(i) + `","sessionID":"` + sid + `","role":"user"}`),
		})
	}
	return out
}

// decodeBatchWindow extracts the outer-payload window field from a
// KindMessagesBatch payload (WITHOUT decompressing the messages array). Asserts
// the envelope shape so a regression that drops the field fails loudly.
func decodeBatchWindow(t *testing.T, payload json.RawMessage) WindowMeta {
	t.Helper()
	var env struct {
		SessionID string     `json:"sessionID"`
		Encoding  string     `json:"encoding"`
		Data      string     `json:"data"`
		Window    WindowMeta `json:"window"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		t.Fatalf("batch payload unmarshal (for window): %v", err)
	}
	return env.Window
}

// Reference the compress/gzip + io + encoding/base64 imports so the test file
// compiles cleanly even when only decodeBatchWindow-adjacent helpers are
// refactored. (decodeBatchMessages in store_test.go uses these too; keeping the
// import surface stable here avoids churn.)
var _ = gzip.BestCompression
var _ = io.EOF
var _ = base64.StdEncoding
