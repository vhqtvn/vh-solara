package state

// This file pins the Option C / P1-AGG-004 contract: the message.part.delta
// reducer (appendPartDeltaLocked) no longer does an O(n²) full-text copy +
// per-delta full JSON round-trip. Instead it appends to a native
// strings.Builder accumulator per (messageID, partID, field) and
// time-throttles the marshal+emit of part.upsert, while preserving:
//   - exact final field text (concatenation of all deltas);
//   - authoritative-snapshot-wins reconciliation (message.part.updated /
//     history-fetch overwrite buffered text);
//   - an unchanged part.upsert wire payload (only its frequency drops);
//   - the busy-on-token-flow indicator;
//   - no new goroutine (lazy time check on the Apply path under s.mu).
//
// It also folds in P1-AGG-005: a drift test pinning store's exact-constant
// message-class classification (isMessageClassKind) against web sendable()'s
// string-prefix equivalent, so the two filter layers cannot silently diverge.

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// withFlushInterval temporarily overrides the package-level deltaFlushInterval
// (a var precisely so tests can make throttle behavior deterministic) and
// restores it on cleanup. Not safe under t.Parallel — none of the throttle
// tests parallelize.
func withFlushInterval(t *testing.T, d time.Duration) {
	t.Helper()
	prev := deltaFlushInterval
	deltaFlushInterval = d
	t.Cleanup(func() { deltaFlushInterval = prev })
}

// applyDelta is a tiny local helper: it builds the canonical
// message.part.delta event payload and applies it.
func applyDelta(s *Store, sessionID, messageID, partID, field, delta string) {
	s.Apply(ev("message.part.delta",
		fmt.Sprintf(`{"sessionID":%q,"messageID":%q,"partID":%q,"field":%q,"delta":%q}`,
			sessionID, messageID, partID, field, delta)))
}

// TestDeltaCoalesce_ExactTextLongStream is acceptance gate #1 (and stresses
// the O(n²) fix): 500 single-char deltas with no intervening authoritative
// snapshot must produce a stored part whose field text is the EXACT
// concatenation of all 500 deltas. With the old reducer this was O(n²) in the
// accumulated length (full unmarshal + string copy + full marshal per char);
// with the native accumulator it is amortized O(n). The throttle window is
// stretched to an hour so all but the first delta land in the buffer and the
// final Snapshot() is what materializes them — proving the accumulator, not
// per-delta flushes, holds the truth.
func TestDeltaCoalesce_ExactTextLongStream(t *testing.T) {
	withFlushInterval(t, time.Hour)

	s := New(1000)
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"sess","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":""}}`))

	const n = 500
	var want strings.Builder
	for i := 0; i < n; i++ {
		ch := string(rune('a' + (i % 26)))
		want.WriteString(ch)
		applyDelta(s, "sess", "m1", "p1", "text", ch)
	}

	got := partText(s.Snapshot(nil), "sess", "p1")
	if got != want.String() {
		t.Fatalf("exact-text invariant broken: want %d chars %q…, got %d chars %q…",
			want.Len(), want.String()[:min(40, want.Len())], len(got), got[:min(40, len(got))])
	}
}

// TestDeltaCoalesce_AuthoritativeReconciliation is acceptance gate #2: an
// authoritative message.part.updated snapshot ALWAYS wins over buffered (and
// even already-flushed) streaming text, and deltas arriving AFTER the snapshot
// append onto the snapshot's base.
func TestDeltaCoalesce_AuthoritativeReconciliation(t *testing.T) {
	withFlushInterval(t, time.Hour)

	s := New(1000)
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"sess","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":""}}`))

	// Stream some text, then materialize it via Snapshot (forces a flush).
	applyDelta(s, "sess", "m1", "p1", "text", "abc")
	if got := partText(s.Snapshot(nil), "sess", "p1"); got != "abc" {
		t.Fatalf("pre-snapshot text: want %q got %q", "abc", got)
	}

	// An authoritative snapshot overwrites — even though "abc" was already
	// flushed into me.parts. Buffered unflushed text never overrides it.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":"SNAPSHOT"}}`))
	if got := partText(s.Snapshot(nil), "sess", "p1"); got != "SNAPSHOT" {
		t.Fatalf("authoritative snapshot must win: want %q got %q", "SNAPSHOT", got)
	}

	// Deltas AFTER the snapshot append onto the snapshot's base (the new
	// accumulator seeds from the snapshot's field value).
	applyDelta(s, "sess", "m1", "p1", "text", "def")
	applyDelta(s, "sess", "m1", "p1", "text", "ghi")
	if got := partText(s.Snapshot(nil), "sess", "p1"); got != "SNAPSHOTdefghi" {
		t.Fatalf("post-snapshot deltas must append onto snapshot base: want %q got %q", "SNAPSHOTdefghi", got)
	}
}

// TestDeltaCoalesce_AuthoritativeReconciliation_BufferedTextDropped is the
// sharper variant: text that is STILL BUFFERED (unflushed) when an
// authoritative snapshot arrives must be discarded, not later re-applied on
// top of the snapshot.
func TestDeltaCoalesce_AuthoritativeReconciliation_BufferedTextDropped(t *testing.T) {
	withFlushInterval(t, time.Hour)

	s := New(1000)
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"sess","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":"BASE"}}`))

	// The first delta flushes immediately (deltaLastEmit starts at zero → elapsed
	// huge). The SECOND delta (and any later one) lands genuinely UNFLUSHED in
	// deltaBuf, held back by the hour-long throttle window — this is the stale
	// buffer discardPartDeltaLocked must drop when the snapshot arrives.
	applyDelta(s, "sess", "m1", "p1", "text", "buffered-not-yet-flushed")
	applyDelta(s, "sess", "m1", "p1", "text", "more-buffered")
	// Authoritative snapshot arrives before the second delta ever flushes.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":"AUTHORITATIVE"}}`))

	// The unflushed "more-buffered" text must be DISCARDED (not later re-applied
	// on top of the snapshot): the result reflects the authoritative text alone.
	if got := partText(s.Snapshot(nil), "sess", "p1"); got != "AUTHORITATIVE" {
		t.Fatalf("buffered text leaked past authoritative snapshot: want %q got %q", "AUTHORITATIVE", got)
	}
}

// TestDeltaCoalesce_ThrottleBoundedEmits is acceptance gate #3 (C3a): a fast
// burst of N deltas within one throttle window must emit FAR fewer than N
// part.upsert events (only the first delta flushes), the final text must still
// be exactly correct, and busy must still be asserted on the token flow.
func TestDeltaCoalesce_ThrottleBoundedEmits(t *testing.T) {
	withFlushInterval(t, time.Hour)

	s := New(1000)
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"sess","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":""}}`))

	// Firehose subscriber so emitted part.upsert events are observable. A big
	// buffer so no drop-on-overflow muddies the count.
	ch, unsub := s.Subscribe(1024)
	defer unsub()
	drainAll(ch) // drop the part.upsert from message.part.updated above

	const n = 200
	var want strings.Builder
	for i := 0; i < n; i++ {
		ch2 := string(rune('a' + (i % 26)))
		want.WriteString(ch2)
		applyDelta(s, "sess", "m1", "p1", "text", ch2)
	}

	emits := len(drainKind(ch, KindPartUpsert))
	// Exactly 1: the first delta of the burst (deltaLastEmit was zero) flushes;
	// the remaining n-1 are buffered within the (hour-long) window.
	if emits != 1 {
		t.Fatalf("throttle failed: want exactly 1 part.upsert emit for %d deltas in one window, got %d", n, emits)
	}

	// Final text must still be exactly correct (Snapshot forces the buffered flush).
	if got := partText(s.Snapshot(nil), "sess", "p1"); got != want.String() {
		t.Fatalf("final text wrong despite throttle: want len %d, got len %d", want.Len(), len(got))
	}

	// Busy-on-token-flow must be preserved even when emits are skipped.
	if got := s.Snapshot(nil).Activity["sess"]; got != ActivityBusy {
		t.Fatalf("busy indicator must track token flow even when throttled: want %q got %q", ActivityBusy, got)
	}
}

// TestDeltaCoalesce_ConcurrentNoRace is acceptance gate #4 (-race): concurrent
// delta streams across distinct sessions, plus a concurrent structural event
// and a concurrent Snapshot reader, must not race and must let the structural
// event through. Run with: go test -race ./pkg/state/...
func TestDeltaCoalesce_ConcurrentNoRace(t *testing.T) {
	s := New(10000)

	// A draining firehose consumer so emits don't wedge on a full channel.
	ch, unsub := s.Subscribe(4096)
	defer unsub()
	var drainDone sync.WaitGroup
	drainDone.Add(1)
	go func() {
		defer drainDone.Done()
		for range ch {
		}
	}()

	const sessions = 8
	const deltasPerSession = 250
	var wg sync.WaitGroup
	wg.Add(sessions)
	for si := 0; si < sessions; si++ {
		sid := fmt.Sprintf("s%d", si)
		go func() {
			defer wg.Done()
			s.Apply(ev("session.created", fmt.Sprintf(`{"info":{"id":%q}}`, sid)))
			s.Apply(ev("message.updated", fmt.Sprintf(`{"info":{"id":"m","sessionID":%q,"role":"assistant"}}`, sid)))
			s.Apply(ev("message.part.updated", fmt.Sprintf(`{"part":{"id":"p","sessionID":%q,"messageID":"m","type":"text","text":""}}`, sid)))
			for i := 0; i < deltasPerSession; i++ {
				applyDelta(s, sid, "m", "p", "text", "x")
			}
		}()
	}

	// A concurrent structural event on yet another session.
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.Apply(ev("session.created", `{"info":{"id":"structural"}}`))
	}()

	// A concurrent Snapshot reader (exercises the Snapshot→flush path racing
	// against the delta appends).
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			_ = s.Snapshot(nil)
		}
	}()

	wg.Wait()
	unsub()
	drainDone.Wait()

	// Every session's part must hold its exact concatenated text.
	want := strings.Repeat("x", deltasPerSession)
	for si := 0; si < sessions; si++ {
		sid := fmt.Sprintf("s%d", si)
		if got := partText(s.Snapshot(nil), sid, "p"); got != want {
			t.Fatalf("session %s: want %d chars, got %d (%q)", sid, len(want), len(got), got[:min(20, len(got))])
		}
	}
}

// TestDeltaCoalesce_HistoryFetchResetsAccumulator checks the history-fetch
// reconciliation path (reconcileMessagesLocked): a messages.loaded reconcile
// resets the accumulator, so deltas re-seed from the fetched (authoritative)
// parts rather than building on stale live bases.
func TestDeltaCoalesce_HistoryFetchResetsAccumulator(t *testing.T) {
	withFlushInterval(t, time.Hour)

	s := New(1000)
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"sess","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":""}}`))

	// Stream live text (buffered — the hour-long window holds it unflushed).
	applyDelta(s, "sess", "m1", "p1", "text", "live-prefix")

	// A history fetch lands (lazy hydration) carrying an authoritative part
	// that does NOT include the live-prefix. This drives the REAL reconcile
	// path: Store.SetSessionMessages → reconcileMessagesLocked, which resets
	// me.deltaBuf / me.deltaLastEmit and overwrites me.parts.
	s.SetSessionMessages("sess", []MessageWithParts{{
		Info:  json.RawMessage(`{"id":"m1","sessionID":"sess","role":"assistant"}`),
		Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":"FROM-HISTORY"}`)},
	}})

	// A delta after the reconcile must seed a FRESH accumulator from the
	// authoritative part (FROM-HISTORY), not append to the discarded
	// live-prefix buffer.
	applyDelta(s, "sess", "m1", "p1", "text", "+tail")

	got := partText(s.Snapshot(nil), "sess", "p1")
	if want := "FROM-HISTORY+tail"; got != want {
		t.Fatalf("history fetch did not reset accumulator: want %q got %q (stale live-prefix leaked)", want, got)
	}
}

// TestDeltaCoalesce_ColdLoadPreservesUnflushedDeltaBuf pins the store.go:2090
// guard INDEPENDENTLY of the part-body guard (store.go:2108): on a cold-load
// reconcile, a message whose part was LIVE-touched during the in-flight cold GET
// must NOT have its unflushed deltaBuf accumulator wiped — the buffered streaming
// text is newer than the stale fetched body and must survive the reconcile so a
// later flush re-materializes the full live-accumulated text. Sibling to
// TestDeltaCoalesce_HistoryFetchResetsAccumulator, which exercises the OPPOSITE
// case (NO cold-fetch-active marker → the accumulator IS correctly reset by the
// authoritative history fetch).
//
// Removing the `coldLoad && len(me.liveTouchedParts) > 0` condition at
// store.go:2090 makes this test fail: the unflushed "tail" is nil'd and only the
// already-flushed "live-" prefix survives (the part-body guard at 2108 still
// keeps "live-", so the failure is specifically "live-" ≠ "live-tail").
func TestDeltaCoalesce_ColdLoadPreservesUnflushedDeltaBuf(t *testing.T) {
	withFlushInterval(t, time.Hour)

	s := New(1000)
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"sess","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":""}}`))

	// Open the cold-fetch window: while coldFetchActive is set, appendPartDeltaLocked
	// tags liveTouchedParts["p1"]=true so both reconcile guards preserve the part.
	s.MarkColdFetchStart("sess")

	// First delta flushes immediately (deltaLastEmit zero → elapsed huge); the
	// SECOND delta lands genuinely UNFLUSHED in deltaBuf, held by the hour-long
	// throttle window — this is the accumulator the store.go:2090 guard protects.
	applyDelta(s, "sess", "m1", "p1", "text", "live-")
	applyDelta(s, "sess", "m1", "p1", "text", "tail")

	// The cold-load reconcile arrives with a STALE fetched body for p1
	// ("fetched-stale") that must NOT win over the live-accumulated text.
	s.SetSessionMessages("sess", []MessageWithParts{{
		Info:  json.RawMessage(`{"id":"m1","sessionID":"sess","role":"assistant"}`),
		Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":"fetched-stale"}`)},
	}})

	// Snapshot forces a flush of the (surviving) deltaBuf → the FULL live-
	// accumulated text "live-tail" must be present: not the stale "fetched-stale"
	// (part-body guard) and not just the flushed prefix "live-" (deltaBuf guard).
	if got := partText(s.Snapshot(nil), "sess", "p1"); got != "live-tail" {
		t.Fatalf("unflushed deltaBuf lost across cold-load reconcile: want %q, got %q "+
			"(store.go:2090 guard failed — only the flushed prefix survived)", "live-tail", got)
	}
}

// --- P1-AGG-005: classification-drift test ---
//
// store classifies message-class events by exact Kind constant
// (isMessageClassKind); the web layer's sendable() classifies by string prefix
// (HasPrefix "message." / "part." / "messages."). The two MUST agree for every
// Kind constant, or an event could be filtered upstream but always-streamed
// downstream (or vice versa). This test pins them together so adding a new
// Kind constant without updating both layers fails loudly.
//
// Advisory finding D1 from the P1-AGG-003 review.

// hasMessageClassPrefix replicates the web layer's sendable() prefix match
// (pkg/web/server.go). Kept local (not imported from pkg/web) so this test
// stays a pure pkg/state unit test with no import cycle.
func hasMessageClassPrefix(kind string) bool {
	return strings.HasPrefix(kind, "message.") ||
		strings.HasPrefix(kind, "part.") ||
		strings.HasPrefix(kind, "messages.")
}

// allKinds is the exhaustive list of exported Kind* constants. The length
// guard below turns "forgot to add a new constant here" into a test failure.
func allKinds() []string {
	return []string{
		KindSessionUpsert, KindSessionDelete,
		KindMessageUpsert, KindMessageDelete,
		KindPartUpsert, KindPartDelete,
		KindMessagesLoaded, KindMessagesError,
		KindMessagesBatch,
		KindTodo,
		KindPermissionSet, KindPermissionClear,
		KindStatus, KindActivity, KindActivityVerb,
		KindQuestionSet, KindQuestionClear,
		KindUnreadSet, KindUnreadClear,
		KindLastAgentSet,
		KindNotice,
	}
}

func TestMessageClassKind_NoDriftFromWebPrefix(t *testing.T) {
	kinds := allKinds()
	const want = 21
	if len(kinds) != want {
		t.Fatalf("allKinds() has %d entries — if you added/removed a Kind constant, update this list and the count", len(kinds))
	}

	seen := map[string]bool{}
	for _, k := range kinds {
		if seen[k] {
			t.Fatalf("duplicate Kind in allKinds(): %q", k)
		}
		seen[k] = true

		storeSays := isMessageClassKind(k)
		webSays := hasMessageClassPrefix(k)
		if storeSays != webSays {
			t.Errorf("classification drift for Kind %q: store isMessageClassKind=%v but web sendable() prefix=%v — "+
				"update isMessageClassKind and/or the constant's prefix so both layers agree", k, storeSays, webSays)
		}
	}
}

// --- benchmarks (acceptance gate #5) ---
//
// BenchmarkApplyPartDeltaFlushEveryDelta isolates the REDUCER cost independent
// of the throttle: deltaFlushInterval is forced to 0 so EVERY delta flushes.
// This proves the accumulator fix dropped per-delta work from O(accumulated
// text length) [old: full unmarshal + O(n²) string copy + full marshal] to
// amortized O(1) append + one O(n) marshal, and that allocs/op no longer scale
// with the accumulated text length. Compare against the P1-AGG-003 baseline of
// ~129µs / 53 allocs per single-char delta (on a growing part).
func BenchmarkApplyPartDeltaFlushEveryDelta(b *testing.B) {
	prev := deltaFlushInterval
	deltaFlushInterval = 0
	defer func() { deltaFlushInterval = prev }()

	s := New(10000)
	s.Apply(ev("session.created", `{"info":{"id":"s"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s","role":"assistant"}}`))
	s.Apply(ev("message.part.delta", `{"sessionID":"s","messageID":"m1","partID":"p1","field":"text","delta":"x"}`))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.Apply(ev("message.part.delta", `{"sessionID":"s","messageID":"m1","partID":"p1","field":"text","delta":"x"}`))
	}
}
