package state

// This file pins the per-part text cap guardrail (P1-AGG-006): the store never
// holds a part whose accumulated text exceeds partTextCap, regardless of how
// the text arrived (streaming deltas, wholesale upsert, or history-fetch
// reconcile). External latency analysis (17.8k sessions / 13 GB) found one bash
// `tool` part whose unbounded stdout grew to 100 MB; this cap bounds that
// pathological case at ~1 MiB while leaving under-cap output byte-identical.
//
// The cap is a STOPGAP guardrail. A larger transcript-windowing fix is
// intentionally out of scope here.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// withPartTextCap temporarily overrides the package-level partTextCap (a var
// precisely so tests can shrink it for deterministic truncation assertions) and
// restores it on cleanup. Not safe under t.Parallel — none of the cap tests
// parallelize. Mirrors the withFlushInterval helper.
func withPartTextCap(t *testing.T, n int) {
	t.Helper()
	prev := partTextCap
	partTextCap = n
	t.Cleanup(func() { partTextCap = prev })
}

// seedCapSession builds a session <sid> with one assistant message m1 and one
// empty text part p1. Returns nothing (state is in the store).
func seedCapSession(s *Store, sid string) {
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"`+sid+`","role":"assistant","time":{"created":1}}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"`+sid+`","messageID":"m1","type":"text","text":""}}`))
}

// TestPartCap_SealsDeltasAtCap is required test (a): deltas appending past the
// cap → the part seals at the cap, the truncation marker is appended, and the
// omitted byte count records the overflow.
//
// Mechanism: with a tiny partTextCap, push one delta to exactly the cap (no
// truncation), then a further delta that overflows it. The accumulator must
// seal: total text length == partTextCap, the tail matches the truncation
// marker pattern, and the omitted count in the marker equals the overflow.
func TestPartCap_SealsDeltasAtCap(t *testing.T) {
	withFlushInterval(t, time.Hour) // hold everything in the accumulator; first delta flushes once
	withPartTextCap(t, 256)

	s := New(100)
	seedCapSession(s, "cap")

	// Fill exactly to the cap (no truncation yet). One single-char delta fires
	// the initial flush; the bulk stays buffered under time.Hour.
	fill := strings.Repeat("a", 256)
	applyDelta(s, "cap", "m1", "p1", "text", fill)

	// Sanity: at-cap text is unchanged (no marker yet).
	if got := partText(s.Snapshot(map[string]bool{"cap": true}), "cap", "p1"); got != fill {
		t.Fatalf("at-cap text must be unchanged: want %d 'a', got %d bytes %q…", len(fill), len(got), truncPrefix(got, 40))
	}

	// Overflow by 1000 bytes. The accumulator crosses the cap → truncate to
	// (cap - marker) and append the marker; the omitted count is the overflow.
	overflow := strings.Repeat("b", 1000)
	applyDelta(s, "cap", "m1", "p1", "text", overflow)

	got := partText(s.Snapshot(map[string]bool{"cap": true}), "cap", "p1")
	if len(got) != 256 {
		t.Fatalf("sealed part length: want exactly partTextCap (256), got %d", len(got))
	}
	// The tail must match the truncation marker pattern with omitted = 1000.
	// The marker format is "\n…[output truncated: <N> further bytes omitted]…".
	if !strings.Contains(got, "[output truncated: 1000 further bytes omitted]") {
		t.Fatalf("sealed part missing truncation marker with omitted=1000; tail=%q", truncPrefix(got, 80))
	}
	// The marker must be the tail (not embedded mid-text).
	marker := "\n…[output truncated: 1000 further bytes omitted]…"
	if !strings.HasSuffix(got, marker) {
		t.Fatalf("sealed part must END with the truncation marker; tail=%q", truncPrefix(got, len(marker)+10))
	}
	// The retained prefix must be the leading 'a's (the original head). With
	// cap=256 and the marker 50 bytes, the retained prefix is 206 'a's.
	wantPrefixLen := 256 - len(marker)
	if wantPrefixLen < 0 {
		wantPrefixLen = 0
	}
	if got[:wantPrefixLen] != strings.Repeat("a", wantPrefixLen) {
		t.Fatalf("sealed part prefix must be leading 'a's, got %q…", truncPrefix(got, wantPrefixLen+10))
	}
}

// TestPartCap_UpsertOverCap is required test (b): a wholesale part.upsert whose
// text field exceeds the cap is truncated to the cap with the marker. The
// upsert path (upsertPartLocked → capPartJSON) bounds a single huge payload.
func TestPartCap_UpsertOverCap(t *testing.T) {
	withPartTextCap(t, 128)

	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"u"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"u","role":"assistant"}}`))

	// Build a part.upsert whose "text" field is 5x the cap.
	huge := strings.Repeat("Z", 128*5)
	payload := struct {
		Part map[string]string `json:"part"`
	}{Part: map[string]string{
		"id": "p1", "sessionID": "u", "messageID": "m1", "type": "text", "text": huge,
	}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	s.Apply(ev("message.part.updated", string(raw)))

	got := partText(s.Snapshot(map[string]bool{"u": true}), "u", "p1")
	if len(got) != 128 {
		t.Fatalf("wholesale upsert sealed length: want exactly partTextCap (128), got %d", len(got))
	}
	// omitted = original total - cap = 5*128 - 128 = 512.
	if !strings.HasSuffix(got, "\n…[output truncated: 512 further bytes omitted]…") {
		t.Fatalf("wholesale upsert missing/incorrect marker; tail=%q", truncPrefix(got, 80))
	}
	// The retained prefix is the leading 'Z's of the original huge string.
	wantPrefixLen := 128 - len("\n…[output truncated: 512 further bytes omitted]…")
	if got[:wantPrefixLen] != strings.Repeat("Z", wantPrefixLen) {
		t.Fatalf("wholesale upsert prefix must be leading 'Z's, got %q…", truncPrefix(got, wantPrefixLen+10))
	}
}

// TestPartCap_DropsPostSealDeltas is required test (c): once a part's
// accumulator is sealed, further streaming deltas to that (partID, field) are
// DROPPED — the part is frozen at the cap with the marker. Deltas to a DIFFERENT
// field of the same part still accumulate normally (the cap is per-field).
func TestPartCap_DropsPostSealDeltas(t *testing.T) {
	withFlushInterval(t, time.Hour)
	withPartTextCap(t, 64)

	s := New(100)
	seedCapSession(s, "d")

	// Seal the "text" field: cross the cap once.
	applyDelta(s, "d", "m1", "p1", "text", strings.Repeat("a", 64))
	applyDelta(s, "d", "m1", "p1", "text", strings.Repeat("b", 500))

	atSeal := partText(s.Snapshot(map[string]bool{"d": true}), "d", "p1")
	if len(atSeal) != 64 {
		t.Fatalf("pre-drop seal length: want 64, got %d", len(atSeal))
	}

	// Push more deltas to the now-sealed (p1, text) accumulator. They MUST be
	// dropped — the sealed text is identical byte-for-byte after the drop.
	for i := 0; i < 10; i++ {
		applyDelta(s, "d", "m1", "p1", "text", strings.Repeat("c", 100))
	}

	afterDrops := partText(s.Snapshot(map[string]bool{"d": true}), "d", "p1")
	if afterDrops != atSeal {
		t.Fatalf("post-seal deltas must be dropped: sealed text changed\n atSeal=%d bytes %q…\n after =%d bytes %q…",
			len(atSeal), truncPrefix(atSeal, 80), len(afterDrops), truncPrefix(afterDrops, 80))
	}
	// The dropped 'c' bytes must not have grown the sealed text. The byte-
	// identical check above is the strict assertion (the marker itself contains
	// 'c' in the word "truncated", so a naive ContainsRune('c') would be a false
	// positive). Add a length bound as a defense-in-depth sanity check: 10
	// dropped deltas × 100 'c's each would otherwise have grown the sealed text
	// by 1000 bytes.
	if len(afterDrops) > 64 {
		t.Fatalf("post-seal text grew past cap: want <= 64 bytes, got %d", len(afterDrops))
	}
}

// TestPartCap_UnderCapByteIdentical is required test (d): under-cap parts are
// byte-identical to today's behavior — no truncation, no marker, exact text
// preserved across both the streaming-delta and wholesale-upsert paths. This is
// the regression guard: normal output is untouched.
func TestPartCap_UnderCapByteIdentical(t *testing.T) {
	// Use the real production cap (1 MiB) so we exercise the default and prove
	// normal output is untouched at the actual configured threshold.
	withPartTextCap(t, 1<<20)
	withFlushInterval(t, time.Hour)

	s := New(100)
	seedCapSession(s, "ok")

	// Streaming path: a handful of small deltas accumulate to "Hello, world".
	for _, d := range []string{"Hello", ", ", "world"} {
		applyDelta(s, "ok", "m1", "p1", "text", d)
	}
	if got := partText(s.Snapshot(map[string]bool{"ok": true}), "ok", "p1"); got != "Hello, world" {
		t.Fatalf("streaming under-cap text: want %q, got %q", "Hello, world", got)
	}

	// Wholesale path: an under-cap upsert carries the text byte-identically
	// through capPartJSON's fast path (the entire JSON envelope < cap → no
	// unmarshal+marshal pair).
	s2 := New(100)
	s2.Apply(ev("session.created", `{"info":{"id":"u"}}`))
	s2.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"u","role":"assistant"}}`))
	payload := `{"part":{"id":"p1","sessionID":"u","messageID":"m1","type":"text","text":"line1\nline2\ttab"}}`
	s2.Apply(ev("message.part.updated", payload))
	got := partText(s2.Snapshot(map[string]bool{"u": true}), "u", "p1")
	if got != "line1\nline2\ttab" {
		t.Fatalf("wholesale under-cap text: want %q, got %q", "line1\nline2\ttab", got)
	}
	// The full raw JSON of the part must round-trip unchanged. The Apply
	// reducer strips the {"part":...} envelope, so me.parts holds the inner
	// object directly — verify that inner form is byte-identical to what
	// capPartJSON's fast path (envelope < cap → no unmarshal+marshal pair)
	// passed through.
	wantInner := `{"id":"p1","sessionID":"u","messageID":"m1","type":"text","text":"line1\nline2\ttab"}`
	for _, mw := range s2.Snapshot(map[string]bool{"u": true}).Messages["u"] {
		for _, raw := range mw.Parts {
			var probe struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(raw, &probe) == nil && probe.ID == "p1" {
				if string(raw) != wantInner {
					t.Fatalf("wholesale under-cap raw JSON re-marshaled (capPartJSON fast path must pass through):\n want %s\n  got %s", wantInner, string(raw))
				}
			}
		}
	}
}

// TestPartCap_TruncationDeterministicForRevision is required test (e): a
// truncated part flows through the cold-batch (publishColdBatch) path correctly
// — truncation is deterministic, so the captured projection is stable and the
// monotonic revision validation does not falsely discard the batch.
//
// Mechanism: seed a truncated part via deltas (so the accumulator + me.parts
// hold the capped text + marker). Run a cold-batch SetSessionMessages whose
// fetched list contains the SAME truncated part. publishColdBatch captures the
// projection, validates the revision token, and emits exactly one batch
// carrying the truncated text intact. A nondeterministic truncation (or a cap
// that bumped the revision post-capture) would either discard+retry or emit
// different text.
func TestPartCap_TruncationDeterministicForRevision(t *testing.T) {
	// deltaFlushInterval=0 so EVERY delta flushes buf.String() into me.parts —
	// the sealing delta (which truncates the buffer) is reflected in me.parts
	// immediately. With a large interval the sealing delta would stay buffered
	// and me.parts would lag at the un-sealed text.
	withFlushInterval(t, 0)
	withPartTextCap(t, 100)

	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"rev"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"rev","role":"assistant","time":{"created":1}}}`))
	// Cross the cap → me.parts holds the truncated text + marker after the
	// first delta's flush. me.parts[p1].text is exactly 100 bytes.
	applyDelta(s, "rev", "m1", "p1", "text", strings.Repeat("x", 100))
	applyDelta(s, "rev", "m1", "p1", "text", strings.Repeat("y", 200))

	truncated := partText(s.Snapshot(map[string]bool{"rev": true}), "rev", "p1")
	if len(truncated) != 100 {
		t.Fatalf("truncated part length: want exactly cap (100), got %d", len(truncated))
	}

	// Subscribe and drain the backlog so only the cold-batch events remain.
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	// Run a cold-load SetSessionMessages whose fetched list carries the SAME
	// truncated part body the store already holds. The revision machinery must
	// validate cleanly: exactly one batch, with the truncated text intact.
	// Build the fetched part JSON from the store's current me.parts[p1] so the
	// text is byte-identical to what truncation produced.
	var storePart json.RawMessage
	s.mu.Lock()
	storePart = s.messages["rev"].byID["m1"].parts["p1"]
	s.mu.Unlock()

	s.SetSessionMessages("rev", []MessageWithParts{
		{Info: json.RawMessage(`{"id":"m1","sessionID":"rev","role":"assistant","time":{"created":1}}`),
			Parts: []json.RawMessage{storePart}},
	})
	s.EmitMessagesLoaded("rev", 1, 1)

	// Exactly one batch carrying the truncated text.
	var batches []ClientEvent
	for _, e := range drainAll(ch) {
		if e.Kind == KindMessagesBatch {
			batches = append(batches, e)
		}
	}
	if len(batches) != 1 {
		t.Fatalf("revision validation on truncated part: want exactly 1 batch (no false staleness discard), got %d", len(batches))
	}
	gotText := partTextFromBatch(t, batches[0].Payload, "rev", "m1", "p1")
	if gotText != truncated {
		t.Fatalf("batch text on truncated part must equal the captured truncated text:\n want %d bytes %q…\n  got %d bytes %q…",
			len(truncated), truncPrefix(truncated, 80), len(gotText), truncPrefix(gotText, 80))
	}
}

// TestPartCap_NestedToolStateOutput is the regression test for the slice's
// motivating case: a bash `tool` part whose pathological stdout lives at the
// NESTED path state.output (two levels deep), not at any top-level field. A
// top-level-only cap walk would miss it entirely and the store would still
// hold a 100 MB part. The recursive capStringsInPlace MUST reach state.output
// (and any other nested string) so the cap bounds the actual pathological
// payload regardless of where in the part JSON it lives.
//
// This pins the production wire shape used by opencode tool parts
// ({"part":{"id":...,"type":"tool","tool":"bash","state":{"output":"..."}}});
// the Apply reducer strips the {"part":...} envelope, so me.parts holds the
// inner object directly.
func TestPartCap_NestedToolStateOutput(t *testing.T) {
	withPartTextCap(t, 256)

	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"tool"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"tool","role":"assistant"}}`))

	// Production bash tool-part shape: pathological stdout at state.output,
	// stderr at state.error, both nested under the state object. Input/command
	// and other short metadata sit alongside them and MUST pass through
	// untouched.
	hugeOut := strings.Repeat("O", 1024) // state.output — 4x cap
	hugeErr := strings.Repeat("E", 512)  // state.error — 2x cap
	payload := `{"part":{"id":"p1","sessionID":"tool","messageID":"m1","type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls -la"},"output":"` + hugeOut + `","error":"` + hugeErr + `","time":{"start":1000,"end":2000}}}}`
	s.Apply(ev("message.part.updated", payload))

	// Read the stored part raw (NOT via partText — that reads the top-level
	// "text" field, which does not exist on a tool part) and inspect the
	// nested state.output / state.error directly.
	snap := s.Snapshot(map[string]bool{"tool": true})
	var stored json.RawMessage
	for _, mw := range snap.Messages["tool"] {
		for _, raw := range mw.Parts {
			var probe struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(raw, &probe) == nil && probe.ID == "p1" {
				stored = raw
				break
			}
		}
	}
	if stored == nil {
		t.Fatalf("tool part p1 missing from snapshot")
	}

	// Fast-path bypass check: the entire JSON envelope is way over the cap, so
	// capPartJSON must have taken the slow recursive path and re-marshaled.
	// Total envelope would be ~1.5 KiB without the cap; with the cap it must
	// be ≈ (cap × 2) + small metadata overhead, well under 1 KiB.
	if len(stored) > 1024 {
		t.Fatalf("nested tool part envelope not bounded: want <= 1 KiB (2 capped fields + metadata), got %d bytes", len(stored))
	}

	var part struct {
		Type  string `json:"type"`
		Tool  string `json:"tool"`
		State struct {
			Status string `json:"status"`
			Input  struct {
				Command string `json:"command"`
			} `json:"input"`
			Output string `json:"output"`
			Error  string `json:"error"`
		} `json:"state"`
	}
	if err := json.Unmarshal(stored, &part); err != nil {
		t.Fatalf("unmarshal capped tool part: %v\nraw=%s", err, truncPrefix(string(stored), 200))
	}

	// Top-level + sibling nested metadata MUST be untouched (the cap touches
	// only over-cap strings; short fields pass through byte-identical).
	if part.Type != "tool" || part.Tool != "bash" {
		t.Fatalf("tool metadata corrupted: type=%q tool=%q", part.Type, part.Tool)
	}
	if part.State.Status != "completed" || part.State.Input.Command != "ls -la" {
		t.Fatalf("state metadata corrupted: status=%q command=%q", part.State.Status, part.State.Input.Command)
	}

	// state.output MUST be capped: length <= cap, ends with the marker, and the
	// marker's omitted count = original (1024) - cap (256) = 768.
	if len(part.State.Output) > 256 {
		t.Fatalf("state.output not bounded: want <= 256 bytes, got %d", len(part.State.Output))
	}
	if !strings.HasSuffix(part.State.Output, "\n…[output truncated: 768 further bytes omitted]…") {
		t.Fatalf("state.output missing/incorrect marker; tail=%q", truncPrefix(part.State.Output, 80))
	}
	if !strings.HasPrefix(part.State.Output, strings.Repeat("O", 10)) {
		t.Fatalf("state.output prefix must be leading 'O's, got %q…", truncPrefix(part.State.Output, 20))
	}

	// state.error MUST ALSO be capped independently — multi-field coverage so
	// the recursive walk is exercised for more than one string per object.
	if len(part.State.Error) > 256 {
		t.Fatalf("state.error not bounded: want <= 256 bytes, got %d", len(part.State.Error))
	}
	if !strings.HasSuffix(part.State.Error, "\n…[output truncated: 256 further bytes omitted]…") {
		t.Fatalf("state.error missing/incorrect marker; tail=%q", truncPrefix(part.State.Error, 80))
	}
}

// TestPartCap_UTF8RuneBoundary exercises the multi-byte rune-boundary backup
// in applyCapToString. The cut point is computed in BYTES (cap - marker), but
// tool output frequently contains multi-byte UTF-8 (CJK, emoji in stderr,
// accented Latin-1). A naive byte cut would split a codepoint, which
// encoding/json would then re-encode as U+FFFD — lossy AND nondeterministic
// across decoders. applyCapToString backs the cut up to the largest rune
// boundary <= cut, so the result is always valid UTF-8.
func TestPartCap_UTF8RuneBoundary(t *testing.T) {
	withPartTextCap(t, 100)

	s := New(100)
	seedCapSession(s, "utf8")

	// 17 × '世' (3 bytes each = 51 bytes) followed by 200 ASCII 'X'. Total =
	// 251 bytes, well over the 100-byte cap. The byte cut would land at
	// byte 50 (= cap - marker); byte 50 is the 3rd byte of rune 17 (a UTF-8
	// continuation byte, NOT a RuneStart), so the backup loop must back up to
	// byte 48 (start of rune 17) — yielding 16 complete '世' runes (48 bytes)
	// + the marker.
	runePrefix := strings.Repeat("世", 17)
	tail := strings.Repeat("X", 200)
	applyDelta(s, "utf8", "m1", "p1", "text", runePrefix+tail)

	got := partText(s.Snapshot(map[string]bool{"utf8": true}), "utf8", "p1")

	// MUST be valid UTF-8 — a mid-rune cut would have produced invalid bytes
	// that json.Marshal would have re-encoded as U+FFFD replacement chars.
	if !utf8.ValidString(got) {
		t.Fatalf("capped text is not valid UTF-8 (mid-rune cut not backed up): %q…", truncPrefix(got, 80))
	}

	// Total = 16 runes × 3 bytes + len(marker) < cap (the backup shortens by
	// up to 3 bytes). Assert the bound rather than the exact byte count.
	if len(got) > 100 {
		t.Fatalf("capped text exceeds cap: want <= 100 bytes, got %d", len(got))
	}

	// The retained prefix MUST be a whole number of '世' runes — no partial
	// codepoint. Decode runes and count.
	prefixEnd := strings.Index(got, "\n…[output truncated:")
	if prefixEnd < 0 {
		t.Fatalf("marker missing from capped text: %q…", truncPrefix(got, 80))
	}
	prefix := got[:prefixEnd]
	runeCount := utf8.RuneCountInString(prefix)
	if runeCount*3 != len(prefix) {
		t.Fatalf("capped prefix is not whole '世' runes: %d runes, %d bytes (expected %d bytes)", runeCount, len(prefix), runeCount*3)
	}
	if runeCount < 15 {
		t.Fatalf("capped prefix rune count implausibly small: got %d (expected ~16)", runeCount)
	}
}

// truncPrefix returns the first n bytes of s as a debugging-safe prefix,
// replacing any embedded NUL or non-printable with '?'. Used only for error
// message readability in cap-test failures (the assertions compare exact text).
func truncPrefix(s string, n int) string {
	if len(s) < n {
		n = len(s)
	}
	out := make([]byte, 0, n)
	for i := 0; i < n; i++ {
		b := s[i]
		if b < 0x20 || b == 0x7f {
			b = '?'
		}
		out = append(out, b)
	}
	return string(out)
}
