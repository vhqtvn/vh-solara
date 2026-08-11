package diagnostics

import (
	"encoding/json"
	"strings"

	"testing"
)

// TestPartDeltaFieldsObserveDistinctAndRepeat verifies the core probe contract:
// a first observation of a (partType, field) pair claims an empty slot; a
// repeat increments count/bytes on the SAME slot without claiming another; and
// distinct pairs claim distinct slots. This is the bounded-cardinality
// behavior the /vh/diag/latency reader relies on.
func TestPartDeltaFieldsObserveDistinctAndRepeat(t *testing.T) {
	resetAndRestore(t)

	// Two distinct pairs.
	Default.PartDeltaFields.Observe("text", "text", 10)
	Default.PartDeltaFields.Observe("text", "text", 5) // repeat → same slot
	Default.PartDeltaFields.Observe("reasoning", "reasoning", 3)

	slots := claimedSlots(t)
	if len(slots) != 2 {
		t.Fatalf("claimed slots = %d, want 2 (two distinct pairs)", len(slots))
	}
	byPair := map[[2]string]partDeltaFieldObsJSON{}
	for _, s := range slots {
		byPair[[2]string{s.PartType, s.Field}] = s
	}
	tt := byPair[[2]string{"text", "text"}]
	if tt.Count != 2 {
		t.Fatalf("(text,text) count = %d, want 2", tt.Count)
	}
	if tt.Bytes != 15 {
		t.Fatalf("(text,text) bytes = %d, want 15", tt.Bytes)
	}
	rr := byPair[[2]string{"reasoning", "reasoning"}]
	if rr.Count != 1 {
		t.Fatalf("(reasoning,reasoning) count = %d, want 1", rr.Count)
	}
	if rr.Bytes != 3 {
		t.Fatalf("(reasoning,reasoning) bytes = %d, want 3", rr.Bytes)
	}
}

// TestPartDeltaFieldsOverflow verifies that observations past the slot cap land
// in the overflow counter (and that the overflow is attributable: a repeat of
// an already-claimed pair does NOT overflow, only a NEW pair past the cap does).
func TestPartDeltaFieldsOverflow(t *testing.T) {
	resetAndRestore(t)

	// Claim every slot with distinct pairs.
	for i := 0; i < MaxPartDeltaFieldSlots; i++ {
		Default.PartDeltaFields.Observe("t", string(rune('a'+i)), 1)
	}
	snap := Snapshot()
	if snap.Probes.PartDeltaFieldOverflow != 0 {
		t.Fatalf("overflow after filling slots = %d, want 0", snap.Probes.PartDeltaFieldOverflow)
	}
	if len(snap.Probes.PartDeltaFields) != MaxPartDeltaFieldSlots {
		t.Fatalf("claimed slots = %d, want %d", len(snap.Probes.PartDeltaFields), MaxPartDeltaFieldSlots)
	}

	// A NEW pair past the cap overflows.
	Default.PartDeltaFields.Observe("t", "zzz", 1)
	snap = Snapshot()
	if snap.Probes.PartDeltaFieldOverflow != 1 {
		t.Fatalf("overflow after new pair past cap = %d, want 1", snap.Probes.PartDeltaFieldOverflow)
	}

	// A REPEAT of an already-claimed pair does NOT overflow (it is still
	// attributable) — it increments the existing slot.
	Default.PartDeltaFields.Observe("t", "a", 1)
	snap = Snapshot()
	if snap.Probes.PartDeltaFieldOverflow != 1 {
		t.Fatalf("overflow changed after a repeat = %d, want 1 (repeats are attributable)", snap.Probes.PartDeltaFieldOverflow)
	}
}

// TestPartDeltaFieldsJSONShape verifies the probe surfaces in /vh/diag/latency
// with the documented field names so a reader (human or SPA) can rely on the
// shape declared in docs/ai/wire-protocols/part-append-streaming.md §6.
func TestPartDeltaFieldsJSONShape(t *testing.T) {
	resetAndRestore(t)

	Default.PartDeltaFields.Observe("text", "text", 42)

	var raw strings.Builder
	enc := json.NewEncoder(&raw)
	if err := enc.Encode(Snapshot()); err != nil {
		t.Fatalf("encode snapshot: %v", err)
	}
	body := raw.String()
	for _, want := range []string{
		`"part_delta_fields"`,
		`"part_type":"text"`,
		`"field":"text"`,
		`"count":1`,
		`"bytes":42`,
		`"part_delta_field_overflow":0`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("snapshot JSON missing %q\nbody:\n%s", want, body)
		}
	}
}

// TestPartDeltaFieldsEmptyOmitsSlots verifies an unobserved probe reports an
// empty (but present) array, not a sparse array of nulls — so the JSON shape
// stays dense and stable for diffing repeat snapshots.
func TestPartDeltaFieldsEmptyOmitsSlots(t *testing.T) {
	resetAndRestore(t)

	snap := Snapshot()
	if snap.Probes.PartDeltaFields == nil {
		t.Fatalf("part_delta_fields is nil, want non-nil empty slice")
	}
	if len(snap.Probes.PartDeltaFields) != 0 {
		t.Fatalf("part_delta_fields len = %d, want 0 (no observations yet)", len(snap.Probes.PartDeltaFields))
	}
	if snap.Probes.PartDeltaFieldOverflow != 0 {
		t.Fatalf("part_delta_field_overflow = %d, want 0", snap.Probes.PartDeltaFieldOverflow)
	}
}

// claimedSlots reads the probe via Snapshot() and returns its non-empty slot
// list. Centralized so the distinct/repeat/overflow tests share one reader.
func claimedSlots(t *testing.T) []partDeltaFieldObsJSON {
	t.Helper()
	snap := Snapshot()
	out := make([]partDeltaFieldObsJSON, 0, len(snap.Probes.PartDeltaFields))
	out = append(out, snap.Probes.PartDeltaFields...)
	return out
}
