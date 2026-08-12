package state

// part_append_streaming_test.go — Slice 2 of the part-append-streaming redesign
// (see docs/ai/wire-protocols/part-append-streaming.md). These tests pin the
// server-side suffix-emission contract at the store layer:
//
//   - opted-in (Interest.WantsPartDelta) subscribers receive KindPartAppend
//     suffix frames {sessionID,messageID,partID,field,start,text} for the
//     allowlisted top-level fields (text/reasoning), with start advancing
//     contiguously by the suffix length;
//   - legacy (non-opted-in) subscribers on the SAME store receive a synthesized
//     full KindPartUpsert at the SAME seq — one encoding per connection, never
//     both for the same (part,field) flush;
//   - the first delta of a burst flushes immediately despite a long throttle
//     interval (immediate-first-token latency preserved);
//   - the shared replay ring records KindPartAppend (so opted-in resume works)
//     in monotonic sequence order alongside the other event kinds;
//   - non-allowlisted fields (anything other than text/reasoning) and
//     sealed-at-cap fields stay on the full part.upsert path for BOTH classes;
//   - an authoritative part.updated snapshot reseeds the sent offset so the
//     next suffix starts at the new base length (no double-send);
//   - the offset clamps defensively if it ever exceeds the accumulated text
//     length (self-healing: the next flush recovers).
//
// Slice 3 (FE) and slice 4 (egress conflation / linearity-under-load) are out
// of scope here; the O(L²)→O(L) WIRE benefit for opted-in connections is
// asserted at unit level, but the load-bearing linearity-under-load crux is
// slice 4's to close.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// partAppendSuffix decodes a KindPartAppend payload into its {start, text}.
// Used by assertions that verify the suffix offset + bytes.
func partAppendSuffix(t *testing.T, payload json.RawMessage) (start int, text string) {
	t.Helper()
	var p struct {
		Start int    `json:"start"`
		Text  string `json:"text"`
		Field string `json:"field"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		t.Fatalf("part.append payload unmarshal failed: %v (payload=%s)", err, string(payload))
	}
	return p.Start, p.Text
}

// assertPartAppendIDs decodes a part.append payload and asserts the id triple
// + field are present (the FE needs all four to route the suffix).
func assertPartAppendIDs(t *testing.T, payload json.RawMessage, wantSession, wantMsg, wantPart, wantField string) {
	t.Helper()
	var p struct {
		SessionID string `json:"sessionID"`
		MessageID string `json:"messageID"`
		PartID    string `json:"partID"`
		Field     string `json:"field"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		t.Fatalf("part.append id unmarshal failed: %v", err)
	}
	if p.SessionID != wantSession || p.MessageID != wantMsg || p.PartID != wantPart || p.Field != wantField {
		t.Errorf("part.append ids: got {sess=%q msg=%q part=%q field=%q}, want {sess=%q msg=%q part=%q field=%q}",
			p.SessionID, p.MessageID, p.PartID, p.Field, wantSession, wantMsg, wantPart, wantField)
	}
}

// partUpsertText decodes a KindPartUpsert payload's "text" field.
func partUpsertText(t *testing.T, payload json.RawMessage) string {
	t.Helper()
	var p struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		t.Fatalf("part.upsert text unmarshal failed: %v", err)
	}
	return p.Text
}

// filterKind returns the subset of events whose Kind matches. Used after a
// single drainAll so multiple kind counts can be taken from the SAME channel
// snapshot (drainKind itself drains+discards non-matching, so a second call on
// the same channel would see an empty set).
func filterKind(events []ClientEvent, kind string) []ClientEvent {
	var out []ClientEvent
	for _, e := range events {
		if e.Kind == kind {
			out = append(out, e)
		}
	}
	return out
}

// seedPartStream prepares a store + session/message/part for delta tests.
// The part is seeded with text="" so suffixes start at offset 0. Returns the
// store configured with the given flush interval.
func seedPartStream(t *testing.T, flushInterval time.Duration) *Store {
	t.Helper()
	s := mustNew(t, withFlushInterval(DefaultConfig(1000), flushInterval))
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"sess","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":""}}`))
	return s
}

// TestPartAppend_OptedInGetsSuffixLegacyGetsFullUpsert is the core slice-2
// contract: for an allowlisted text field, an opted-in subscriber receives
// KindPartAppend suffixes (O(len(suffix)) per flush) while a legacy subscriber
// on the SAME store receives a synthesized full KindPartUpsert at the SAME seq.
// One encoding per connection — neither receives both for the same flush.
func TestPartAppend_OptedInGetsSuffixLegacyGetsFullUpsert(t *testing.T) {
	s := seedPartStream(t, time.Nanosecond) // every delta flushes

	optedIn, stop1 := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop1()
	legacy, stop2 := s.SubscribeWith(256, Interest{}) // firehose + legacy encoding
	defer stop2()

	applyDelta(s, "sess", "m1", "p1", "text", "a")
	applyDelta(s, "sess", "m1", "p1", "text", "b")
	applyDelta(s, "sess", "m1", "p1", "text", "c")

	// Drain each channel ONCE (drainKind discards non-matching on read, so a
	// second drainKind on the same channel would see an empty set).
	optEvents := drainAll(optedIn)
	legEvents := drainAll(legacy)
	optAppends := filterKind(optEvents, KindPartAppend)
	legUpserts := filterKind(legEvents, KindPartUpsert)
	legAppends := filterKind(legEvents, KindPartAppend)
	optUpserts := filterKind(optEvents, KindPartUpsert)

	if len(optAppends) != 3 {
		t.Fatalf("opted-in: want 3 part.append suffixes, got %d", len(optAppends))
	}
	if len(legUpserts) != 3 {
		t.Fatalf("legacy: want 3 part.upsert (full), got %d", len(legUpserts))
	}
	if len(legAppends) != 0 {
		t.Errorf("legacy must NEVER receive part.append (one encoding per connection): got %d", len(legAppends))
	}
	if len(optUpserts) != 0 {
		t.Errorf("opted-in must not receive part.upsert for allowlisted suffix flushes (got %d) — dual-emit leak", len(optUpserts))
	}

	// Opted-in: starts 0,1,2 contiguous; texts "a","b","c"; concatenation "abc".
	wantStarts := []int{0, 1, 2}
	wantTexts := []string{"a", "b", "c"}
	var concat strings.Builder
	for i, ev := range optAppends {
		start, text := partAppendSuffix(t, ev.Payload)
		if start != wantStarts[i] {
			t.Errorf("append[%d]: start got %d want %d", i, start, wantStarts[i])
		}
		if text != wantTexts[i] {
			t.Errorf("append[%d]: text got %q want %q", i, text, wantTexts[i])
		}
		concat.WriteString(text)
		assertPartAppendIDs(t, ev.Payload, "sess", "m1", "p1", "text")
	}
	if got := concat.String(); got != "abc" {
		t.Errorf("suffix concatenation: got %q want %q", got, "abc")
	}

	// Legacy: each upsert carries the GROWING full text "a","ab","abc".
	wantFull := []string{"a", "ab", "abc"}
	for i, ev := range legUpserts {
		if got := partUpsertText(t, ev.Payload); got != wantFull[i] {
			t.Errorf("legacy upsert[%d]: text got %q want %q", i, got, wantFull[i])
		}
	}

	// Shared seq: each flush advanced seq once; opted-in suffix and legacy
	// upsert for the SAME flush share the SAME seq.
	for i := range optAppends {
		if optAppends[i].Seq != legUpserts[i].Seq {
			t.Errorf("flush[%d]: opted-in seq %d != legacy seq %d (must share one seq per flush)",
				i, optAppends[i].Seq, legUpserts[i].Seq)
		}
	}
}

// TestPartAppend_ImmediateFirstDeltaFlushes asserts the first delta of a burst
// flushes INSTANTLY despite a long throttle interval (deltaLastEmit zero →
// elapsed huge). This is the first-token-latency invariant carried over from
// the legacy part.upsert path. A second delta within the interval must NOT
// flush (it stays buffered).
func TestPartAppend_ImmediateFirstDeltaFlushes(t *testing.T) {
	s := seedPartStream(t, time.Hour) // long interval
	optedIn, stop := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop()

	applyDelta(s, "sess", "m1", "p1", "text", "first")
	first := drainKind(optedIn, KindPartAppend)
	if len(first) != 1 {
		t.Fatalf("first delta of burst must flush immediately despite long interval: got %d part.append", len(first))
	}
	start, text := partAppendSuffix(t, first[0].Payload)
	if start != 0 || text != "first" {
		t.Errorf("first flush suffix: got {start=%d text=%q}, want {0, %q}", start, text, "first")
	}

	// Second delta within the interval stays buffered — no flush.
	applyDelta(s, "sess", "m1", "p1", "text", "second")
	if got := drainKind(optedIn, KindPartAppend); len(got) != 0 {
		t.Errorf("second delta within throttle interval must NOT flush: got %d part.append", len(got))
	}
}

// TestPartAppend_RingCarriesPartAppendSeqOrdered asserts KindPartAppend events
// occupy the shared replay ring in monotonic sequence order (spec §4: resume
// works for opted-in clients). An opted-in client reconnecting with a valid
// cursor must replay the suffix frames. This holds regardless of whether any
// subscriber is currently live — the ring always records part.append for
// allowlisted fields (the design point of §4.3: a legacy replay containing a
// part.append falls back to snapshot, so the ring is the source of truth).
func TestPartAppend_RingCarriesPartAppendSeqOrdered(t *testing.T) {
	s := seedPartStream(t, time.Nanosecond)
	// No subscriber needed: the flush path records into the ring unconditionally.
	applyDelta(s, "sess", "m1", "p1", "text", "a")
	applyDelta(s, "sess", "m1", "p1", "text", "b")
	applyDelta(s, "sess", "m1", "p1", "text", "c")

	events, _, ok := s.Replay(0)
	if !ok {
		t.Fatalf("Replay(0) returned replayOK=false")
	}
	var appends []ClientEvent
	for _, ev := range events {
		if ev.Kind == KindPartAppend {
			appends = append(appends, ev)
		}
	}
	if len(appends) != 3 {
		t.Fatalf("ring replay: want 3 part.append, got %d", len(appends))
	}
	// Seq strictly monotonic.
	for i := 1; i < len(appends); i++ {
		if appends[i].Seq <= appends[i-1].Seq {
			t.Errorf("ring seq not monotonic at [%d]: %d <= %d", i, appends[i].Seq, appends[i-1].Seq)
		}
	}
	// Starts contiguous 0,1,2 — an opted-in client replaying concatenates them.
	wantStarts := []int{0, 1, 2}
	wantTexts := []string{"a", "b", "c"}
	for i, ev := range appends {
		start, text := partAppendSuffix(t, ev.Payload)
		if start != wantStarts[i] || text != wantTexts[i] {
			t.Errorf("ring append[%d]: got {start=%d text=%q}, want {%d %q}", i, start, text, wantStarts[i], wantTexts[i])
		}
	}
}

// TestPartAppend_NonAllowlistedFieldStaysFullUpsert asserts that a field NOT on
// the v1 allowlist (anything other than text/reasoning — spec §5) emits a full
// KindPartUpsert to BOTH opted-in and legacy, never a suffix. Tool output and
// nested state.output ride the snapshot path, not the delta path.
func TestPartAppend_NonAllowlistedFieldStaysFullUpsert(t *testing.T) {
	s := seedPartStream(t, time.Nanosecond)
	optedIn, stop1 := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop1()
	legacy, stop2 := s.SubscribeWith(256, Interest{})
	defer stop2()

	// "customField" is not text/reasoning → full upsert path for both.
	applyDelta(s, "sess", "m1", "p1", "customField", "payload")

	optEvents := drainAll(optedIn)
	legEvents := drainAll(legacy)
	if got := filterKind(optEvents, KindPartAppend); len(got) != 0 {
		t.Errorf("non-allowlisted field: opted-in must NOT get part.append, got %d", len(got))
	}
	optUpsert := filterKind(optEvents, KindPartUpsert)
	legUpsert := filterKind(legEvents, KindPartUpsert)
	if len(optUpsert) != 1 || len(legUpsert) != 1 {
		t.Fatalf("non-allowlisted field: want 1 upsert each (opted-in got %d, legacy got %d)", len(optUpsert), len(legUpsert))
	}
	// Both carry the full field text.
	var p map[string]any
	_ = json.Unmarshal(optUpsert[0].Payload, &p)
	if v, _ := p["customField"].(string); v != "payload" {
		t.Errorf("non-allowlisted upsert text: got %q want %q", v, "payload")
	}
}

// TestPartAppend_ReasoningFieldAlsoSuffixes asserts the reasoning top-level
// field is on the v1 allowlist alongside text (spec §5).
func TestPartAppend_ReasoningFieldAlsoSuffixes(t *testing.T) {
	s := seedPartStream(t, time.Nanosecond)
	optedIn, stop := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop()

	applyDelta(s, "sess", "m1", "p1", "reasoning", "because")
	applyDelta(s, "sess", "m1", "p1", "reasoning", " therefore")

	appends := drainKind(optedIn, KindPartAppend)
	if len(appends) != 2 {
		t.Fatalf("reasoning field: want 2 part.append, got %d", len(appends))
	}
	s0, t0 := partAppendSuffix(t, appends[0].Payload)
	s1, t1 := partAppendSuffix(t, appends[1].Payload)
	if s0 != 0 || t0 != "because" {
		t.Errorf("reasoning append[0]: got {start=%d text=%q}, want {0, %q}", s0, t0, "because")
	}
	if s1 != len("because") || t1 != " therefore" {
		t.Errorf("reasoning append[1]: got {start=%d text=%q}, want {%d, %q}", s1, t1, len("because"), " therefore")
	}
	assertPartAppendIDs(t, appends[0].Payload, "sess", "m1", "p1", "reasoning")
}

// TestPartAppend_SealedAtCapStaysFullUpsert asserts that a field sealed at the
// part-text cap emits a full KindPartUpsert to BOTH opted-in and legacy (the
// authoritative cap repair), never a suffix. The sealed path must reach
// opted-in clients as full text so the truncation marker is authoritative.
func TestPartAppend_SealedAtCapStaysFullUpsert(t *testing.T) {
	s := mustNew(t, withPartTextCap(withFlushInterval(DefaultConfig(1000), time.Nanosecond), 5))
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"sess","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":""}}`))

	optedIn, stop1 := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop1()
	legacy, stop2 := s.SubscribeWith(256, Interest{})
	defer stop2()

	// A single delta that crosses the cap seals the field in one step.
	applyDelta(s, "sess", "m1", "p1", "text", "abcdefghij") // 10 chars > cap 5

	optEvents := drainAll(optedIn)
	legEvents := drainAll(legacy)
	if got := filterKind(optEvents, KindPartAppend); len(got) != 0 {
		t.Errorf("sealed-at-cap field: opted-in must NOT get part.append, got %d", len(got))
	}
	optUpsert := filterKind(optEvents, KindPartUpsert)
	legUpsert := filterKind(legEvents, KindPartUpsert)
	if len(optUpsert) != 1 || len(legUpsert) != 1 {
		t.Fatalf("sealed field: want 1 full upsert each (opted-in got %d, legacy got %d)", len(optUpsert), len(legUpsert))
	}
	// The capped text carries the truncation marker (applyCapToString appends one).
	if !strings.Contains(partUpsertText(t, optUpsert[0].Payload), "…") {
		t.Errorf("sealed upsert should carry the truncation marker, got %q", partUpsertText(t, optUpsert[0].Payload))
	}
}

// TestPartAppend_AuthoritativeSnapshotReseedsOffset asserts that an
// authoritative message.part.updated snapshot — which discards the accumulator
// via discardPartDeltaLocked — also clears the sent-offset tracker, so the next
// suffix burst starts at the NEW base length (no double-send of bytes the
// client already replaced wholesale). The opted-in client receives the base
// upsert, then suffixes that append onto it.
func TestPartAppend_AuthoritativeSnapshotReseedsOffset(t *testing.T) {
	s := seedPartStream(t, time.Nanosecond)
	optedIn, stop := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop()

	// Burst 1: suffixes "a","b","c" → deltaSentLen advances to 3.
	applyDelta(s, "sess", "m1", "p1", "text", "a")
	applyDelta(s, "sess", "m1", "p1", "text", "b")
	applyDelta(s, "sess", "m1", "p1", "text", "c")
	drainKind(optedIn, KindPartAppend) // consume burst 1

	// Authoritative snapshot replaces the text wholesale → discardPartDeltaLocked
	// clears deltaSentLen for this part.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess","messageID":"m1","type":"text","text":"SNAPSHOT"}}`))
	snapUpsert := drainKind(optedIn, KindPartUpsert)
	if len(snapUpsert) != 1 || partUpsertText(t, snapUpsert[0].Payload) != "SNAPSHOT" {
		t.Fatalf("authoritative snapshot: want 1 part.upsert text=%q, got %+v", "SNAPSHOT", snapUpsert)
	}

	// Burst 2: a delta appends onto the new base. The accumulator reseeds from
	// "SNAPSHOT" (len 8), so deltaSentLen[key]=8 and the suffix starts at 8.
	applyDelta(s, "sess", "m1", "p1", "text", "X")
	burst2 := drainKind(optedIn, KindPartAppend)
	if len(burst2) != 1 {
		t.Fatalf("post-snapshot burst: want 1 part.append, got %d", len(burst2))
	}
	start, text := partAppendSuffix(t, burst2[0].Payload)
	if start != len("SNAPSHOT") {
		t.Errorf("post-snapshot suffix start: got %d want %d (reseeded from new base)", start, len("SNAPSHOT"))
	}
	if text != "X" {
		t.Errorf("post-snapshot suffix text: got %q want %q", text, "X")
	}
}

// TestPartAppend_OffsetClampSelfHeals asserts the defensive clamp: if the
// sent-offset ever exceeds len(fullText) (e.g. a concurrent authoritative
// overwrite shortened the base beneath the last sent offset), the clamp caps
// start at len(fullText), the suffix is empty (no spurious emit), and the
// offset recovers to len(fullText) so the NEXT flush emits correctly.
func TestPartAppend_OffsetClampSelfHeals(t *testing.T) {
	s := seedPartStream(t, time.Hour) // long interval: only first delta flushes
	optedIn, stop := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop()

	applyDelta(s, "sess", "m1", "p1", "text", "a") // first flushes: suffix{0,"a"}, deltaSentLen=1
	drainKind(optedIn, KindPartAppend)

	// Corrupt the sent-offset past the accumulated length (simulating the race).
	s.mu.Lock()
	if me := s.messages["sess"].byID["m1"]; me != nil && me.deltaSentLen != nil {
		me.deltaSentLen["p1\x00text"] = 999
	}
	s.mu.Unlock()

	// Append "b" — buf is now "ab" (len 2). A flush would compute start=999,
	// clamped to 2 → suffix "" → no part.append emitted. deltaSentLen recovers to 2.
	// Use a forced flush by lowering the interval effect: bump deltaLastEmit to zero.
	s.mu.Lock()
	if me := s.messages["sess"].byID["m1"]; me != nil {
		me.deltaLastEmit = time.Time{} // force the throttle to fire on the next delta
	}
	s.mu.Unlock()
	applyDelta(s, "sess", "m1", "p1", "text", "b")
	if got := drainKind(optedIn, KindPartAppend); len(got) != 0 {
		t.Errorf("clamped flush (start>len): must emit NO part.append (empty suffix), got %d", len(got))
	}

	// Next delta "c": buf="abc", start=2 (recovered), suffix="c". Self-healed.
	s.mu.Lock()
	if me := s.messages["sess"].byID["m1"]; me != nil {
		me.deltaLastEmit = time.Time{}
	}
	s.mu.Unlock()
	applyDelta(s, "sess", "m1", "p1", "text", "c")
	healed := drainKind(optedIn, KindPartAppend)
	if len(healed) != 1 {
		t.Fatalf("post-clamp flush: want 1 part.append (self-healed), got %d", len(healed))
	}
	start, text := partAppendSuffix(t, healed[0].Payload)
	if start != 2 || text != "c" {
		t.Errorf("post-clamp suffix: got {start=%d text=%q}, want {2, %q}", start, text, "c")
	}
}

// TestPartAppend_ReplayContiguousResume simulates the full opted-in reconnect:
// a client that consumed suffixes up to some cursor reconnects and replays the
// suffixes it missed, concatenating them contiguously. This is the §4
// incremental-resume happy path (currentFieldLen == start).
func TestPartAppend_ReplayContiguousResume(t *testing.T) {
	s := seedPartStream(t, time.Nanosecond)
	// Produce 5 suffixes; capture the seq after the 3rd as the resume cursor.
	applyDelta(s, "sess", "m1", "p1", "text", "a")
	applyDelta(s, "sess", "m1", "p1", "text", "b")
	applyDelta(s, "sess", "m1", "p1", "text", "c")
	cursor := s.seq
	applyDelta(s, "sess", "m1", "p1", "text", "d")
	applyDelta(s, "sess", "m1", "p1", "text", "e")

	// Replay from cursor: only suffixes 4 and 5 (text "d","e") should return.
	events, _, ok := s.Replay(cursor)
	if !ok {
		t.Fatalf("Replay(cursor=%d): replayOK=false", cursor)
	}
	var appends []ClientEvent
	for _, ev := range events {
		if ev.Kind == KindPartAppend {
			appends = append(appends, ev)
		}
	}
	if len(appends) != 2 {
		t.Fatalf("resume replay: want 2 part.append (d,e), got %d", len(appends))
	}
	// The client held text through "abc" (len 3) at the cursor. The replayed
	// suffixes must start at 3 and 4 — contiguous resume.
	s0, t0 := partAppendSuffix(t, appends[0].Payload)
	s1, t1 := partAppendSuffix(t, appends[1].Payload)
	if s0 != 3 || t0 != "d" {
		t.Errorf("resume append[0]: got {start=%d text=%q}, want {3, %q}", s0, t0, "d")
	}
	if s1 != 4 || t1 != "e" {
		t.Errorf("resume append[1]: got {start=%d text=%q}, want {4, %q}", s1, t1, "e")
	}
}

// TestPartAppend_SnapshotDuringThrottleCoherentOffset is the B-F1 regression:
// a cursorless snapshot taken while deltas sit buffered behind the throttle
// must project a field baseline that AGREES with the next suffix offset.
//
// Pre-fix (the defect): the snapshot projected the full accumulated text (via
// captureDeltaText) but deltaSentLen was NOT advanced → the next flush computed
// start from the stale deltaSentLen and emitted a suffix whose start < the
// client's now-longer field length (byte-offset contract violation per spec
// §4.1/§4.2 AND re-send of bytes already delivered in the snapshot).
//
// Post-fix (the B-F1 mechanism): the snapshot flushes the buffered deltas
// BEFORE projecting (flushAllBufferedDeltasLocked), so the projected baseline
// == deltaSentLen == the client's field length. The flush ACTUALLY EMITS the
// buffered bytes to every opted-in subscriber (it does not silently advance
// deltaSentLen), so a subscriber already watching receives them as a coherent
// suffix in seq order.
//
// This test FAILS on the pre-fix code (the snapshot emits no flush, and the
// next suffix starts at the stale deltaSentLen behind the snapshot length).
func TestPartAppend_SnapshotDuringThrottleCoherentOffset(t *testing.T) {
	s := seedPartStream(t, time.Hour) // long interval: only first delta flushes

	// Subscriber A: already watching (opted-in). Proves the flush actually
	// EMITS the buffered bytes to every opted-in subscriber — not just
	// advances deltaSentLen (which would skip them for A).
	subA, stopA := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stopA()

	// Burst setup: delta "a" flushes immediately (deltaLastEmit zero → first
	// delta of a burst always flushes). Suffix {0,"a"}, deltaSentLen=1.
	applyDelta(s, "sess", "m1", "p1", "text", "a")
	firstSuffixes := drainKind(subA, KindPartAppend)
	if len(firstSuffixes) != 1 {
		t.Fatalf("first delta: want 1 part.append, got %d", len(firstSuffixes))
	}

	// Deltas "b","c" buffer behind the hour-long throttle. buf="abc",
	// deltaSentLen=1. me.parts lags at "a".
	applyDelta(s, "sess", "m1", "p1", "text", "b")
	applyDelta(s, "sess", "m1", "p1", "text", "c")
	// Confirm nothing flushed during buffering.
	if buffered := drainKind(subA, KindPartAppend); len(buffered) != 0 {
		t.Fatalf("throttled deltas must NOT flush: got %d part.append", len(buffered))
	}

	// === THE B-F1 SCENARIO ===
	// A new opted-in connection takes a cursorless snapshot. Pre-fix: projects
	// "abc" (len 3) but deltaSentLen stays 1. Post-fix: flushes "bc" first,
	// emitting suffix {1,"bc"} to subscriber A, then projects "abc" (len 3)
	// with deltaSentLen=3.
	snap := s.Snapshot(map[string]bool{"sess": true})

	// Subscriber A (already watching) receives the flush's suffix {1,"bc"}.
	flushSuffixes := drainKind(subA, KindPartAppend)
	if len(flushSuffixes) != 1 {
		t.Fatalf("snapshot-coherence flush: want 1 part.append (buffered 'bc' emitted to existing subscriber), got %d", len(flushSuffixes))
	}
	flushStart, flushText := partAppendSuffix(t, flushSuffixes[0].Payload)
	if flushStart != 1 || flushText != "bc" {
		t.Errorf("flush suffix: got {start=%d text=%q}, want {1, %q} (buffered bytes emitted, not silently skipped)", flushStart, flushText, "bc")
	}

	// Record the snapshot field text + byte length — this is the new client's
	// baseline.
	snapField := partText(snap, "sess", "p1")
	snapLen := len(snapField)
	if snapField != "abc" {
		t.Fatalf("snapshot field text: got %q want %q", snapField, "abc")
	}

	// Delta "d" arrives. Force the throttle to fire so the flush is
	// deterministic (independent of host scheduling).
	forceNextFlush := func() {
		s.mu.Lock()
		if me := s.messages["sess"].byID["m1"]; me != nil {
			me.deltaLastEmit = time.Time{}
		}
		s.mu.Unlock()
	}
	forceNextFlush()
	applyDelta(s, "sess", "m1", "p1", "text", "d")

	// === THE B-F1 ASSERTION ===
	// The post-snapshot suffix MUST start at snapLen (the snapshot field byte
	// length) and carry ONLY the newly-appended byte "d" — NOT "bcd" (which
	// would re-send bytes already in the snapshot).
	postSuffixes := drainKind(subA, KindPartAppend)
	if len(postSuffixes) != 1 {
		t.Fatalf("post-snapshot flush: want 1 part.append, got %d", len(postSuffixes))
	}
	postStart, postText := partAppendSuffix(t, postSuffixes[0].Payload)
	if postStart != snapLen {
		t.Errorf("B-F1 VIOLATION: post-snapshot suffix start got %d want %d (snapshot field byte length) — suffix starts behind client baseline", postStart, snapLen)
	}
	if postText != "d" {
		t.Errorf("post-snapshot suffix text: got %q want %q (only the newly-appended byte, NOT bytes already in the snapshot)", postText, "d")
	}

	// === COHERENCE CHECK (subscriber A) ===
	// Subscriber A's suffix stream is contiguous: offsets 0→1 (a), 1→3 (bc),
	// 3→4 (d). No skipped bytes, no re-sent bytes. The concatenation == "abcd".
	var concat strings.Builder
	for _, ev := range append(append(firstSuffixes, flushSuffixes...), postSuffixes...) {
		_, text := partAppendSuffix(t, ev.Payload)
		concat.WriteString(text)
	}
	if got := concat.String(); got != "abcd" {
		t.Errorf("subscriber A suffix concatenation: got %q want %q (contiguous offsets, no skipped bytes)", got, "abcd")
	}
}
