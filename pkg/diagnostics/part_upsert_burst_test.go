package diagnostics

import (
	"encoding/json"
	"strings"
	"testing"
)

// part_upsert_burst_test.go — unit tests for the slice-4A upsert-path burst
// characterization probe (see part_upsert_burst.go and
// tmp/agent-runs/compaction-burst-brief/brief.md §"Slice 4A detail"). The
// incident-shaped fixture that answers the slice-4B decision question lives in
// pkg/state/part_upsert_burst_fixture_test.go (it needs the Store); these tests
// pin the probe's own mechanics in isolation.

func toolPart(id, sid, mid, output string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"id": id, "sessionID": sid, "messageID": mid,
		"type": "tool", "tool": "bash",
		"state": map[string]any{"status": "completed", "output": output},
	})
	return b
}

func textPart(id, sid, mid, text string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"id": id, "sessionID": sid, "messageID": mid,
		"type": "text", "text": text,
	})
	return b
}

// TestPartUpsertBurst_ClassifiesIdenticalVsChanged is the load-bearing probe
// mechanic for the O2 decision: a re-upsert of the SAME capped part bytes must
// classify as "identical", a re-upsert with DIFFERENT bytes (or a brand-new
// part) must classify as "changed".
func TestPartUpsertBurst_ClassifiesIdenticalVsChanged(t *testing.T) {
	var p PartUpsertBurstStats
	tool := toolPart("p1", "s", "m", "out")

	// First upsert: no resident → changed (a new part is NOT a no-op).
	p.Observe(tool, "tool", "s", "m", "p1", nil)
	if got := p.Events.Load(); got != 1 {
		t.Fatalf("events = %d, want 1", got)
	}
	if got := p.ChangedEvents.Load(); got != 1 {
		t.Fatalf("first upsert changed = %d, want 1 (new part is changed)", got)
	}
	if got := p.IdenticalEvents.Load(); got != 0 {
		t.Fatalf("first upsert identical = %d, want 0", got)
	}

	// Second upsert: SAME bytes, resident == incoming → identical.
	p.Observe(tool, "tool", "s", "m", "p1", tool)
	if got := p.IdenticalEvents.Load(); got != 1 {
		t.Fatalf("identical re-upsert = %d, want 1", got)
	}
	if got := p.ChangedEvents.Load(); got != 1 {
		t.Fatalf("changed after identical re-upsert = %d, want 1 (unchanged)", got)
	}

	// Third upsert: DIFFERENT bytes → changed.
	tool2 := toolPart("p1", "s", "m", "different output")
	p.Observe(tool2, "tool", "s", "m", "p1", tool)
	if got := p.IdenticalEvents.Load(); got != 1 {
		t.Fatalf("identical after changed re-upsert = %d, want 1 (unchanged)", got)
	}
	if got := p.ChangedEvents.Load(); got != 2 {
		t.Fatalf("changed = %d, want 2", got)
	}
}

// TestPartUpsertBurst_ToolSubsetClassification confirms the TOOL subset counters
// key on part type == "tool" (the observed compaction-burst population), so the
// burst's composition is visible without per-event logging.
func TestPartUpsertBurst_ToolSubsetClassification(t *testing.T) {
	var p PartUpsertBurstStats
	tool := toolPart("p1", "s", "m", "out")
	text := textPart("p2", "s", "m", "hi")

	p.Observe(tool, "tool", "s", "m", "p1", nil)
	p.Observe(text, "text", "s", "m", "p2", nil)

	if got := p.ToolEvents.Load(); got != 1 {
		t.Fatalf("tool events = %d, want 1", got)
	}
	if got := p.ToolBytes.Load(); got != uint64(len(tool)) {
		t.Fatalf("tool bytes = %d, want %d", got, len(tool))
	}
	// text part is counted in the totals but NOT the tool subset.
	if got := p.Events.Load(); got != 2 {
		t.Fatalf("total events = %d, want 2", got)
	}
	if got := p.ToolEvents.Load(); got != 1 {
		t.Fatalf("tool events after text = %d, want 1 (text is not tool)", got)
	}
}

// TestPartUpsertBurst_DistinctPartCount confirms the bounded distinct-part
// table counts distinct identities (same id triple → same slot; new triple →
// new slot) without ever emitting the raw ids.
func TestPartUpsertBurst_DistinctPartCount(t *testing.T) {
	var p PartUpsertBurstStats
	tool := toolPart("p1", "s", "m", "out")

	// Three re-upserts of the SAME identity → 1 distinct slot, count 3.
	p.Observe(tool, "tool", "s", "m", "p1", nil)
	p.Observe(tool, "tool", "s", "m", "p1", tool)
	p.Observe(tool, "tool", "s", "m", "p1", tool)
	if got := p.distinctClaimedCount(); got != 1 {
		t.Fatalf("distinct parts after 3 same-id upserts = %d, want 1", got)
	}

	// A different identity → 2 distinct slots.
	p.Observe(toolPart("p2", "s", "m", "x"), "tool", "s", "m", "p2", nil)
	if got := p.distinctClaimedCount(); got != 2 {
		t.Fatalf("distinct parts after a new id = %d, want 2", got)
	}

	// Same part id but under a DIFFERENT session/message → distinct identity
	// (the id triple is the key, not the bare part id).
	p.Observe(toolPart("p1", "s2", "m2", "x"), "tool", "s2", "m2", "p1", nil)
	if got := p.distinctClaimedCount(); got != 3 {
		t.Fatalf("distinct parts after same-id-different-session = %d, want 3", got)
	}

	if got := p.distinctOverflow.Load(); got != 0 {
		t.Fatalf("distinct overflow = %d, want 0 (under cap)", got)
	}
}

// TestPartUpsertBurst_DistinctOverflowFiresUnderCap confirms the bounded
// distinct table saturates honestly (overflow counter) once the cap is
// exceeded, rather than silently losing data.
func TestPartUpsertBurst_DistinctOverflowFiresUnderCap(t *testing.T) {
	// Local probe with a shrunken cap is not possible (the slot array is a
	// fixed-size struct field), so this test instead verifies the overflow
	// counter mechanics by driving MORE distinct identities than
	// MaxPartUpsertDistinctSlots and asserting overflow > 0 while the
	// cumulative Events counter still carries every observation.
	var p PartUpsertBurstStats
	for i := 0; i < MaxPartUpsertDistinctSlots+50; i++ {
		// Each iteration is a brand-new identity triple.
		sid := "s"
		mid := "m"
		pid := "p" + itoa(i)
		p.Observe(toolPart(pid, sid, mid, "x"), "tool", sid, mid, pid, nil)
	}
	if got := p.Events.Load(); got != uint64(MaxPartUpsertDistinctSlots+50) {
		t.Fatalf("events = %d, want %d (cumulative counter is authoritative)", got, MaxPartUpsertDistinctSlots+50)
	}
	if got := p.distinctOverflow.Load(); got == 0 {
		t.Fatalf("distinct overflow = 0, want >0 (cap %d exceeded by 50)", MaxPartUpsertDistinctSlots)
	}
	// distinctClaimedCount saturates at the cap.
	if got := p.distinctClaimedCount(); got != MaxPartUpsertDistinctSlots {
		t.Fatalf("distinct claimed = %d, want %d (saturated at cap)", got, MaxPartUpsertDistinctSlots)
	}
}

// TestPartUpsertBurst_ObserveZeroAllocSteadyState is the test-enforced
// allocation contract for the probe (b-F1 fix, slice-4A commit-review). The
// steady-state repeat Observe — same identity (distinct slot already claimed)
// and same bytes (identical classification) — must allocate ZERO bytes: pure
// atomics (Counter wraps atomic.Uint64) + one allocation-free bytes.Equal +
// one allocation-free string compare for the type subset. The part type is
// THREADED IN (not re-parsed), so there is no json.Unmarshal on the hot path.
// This test guards against a regression that re-introduces a per-call
// unmarshal (the original contract drift the reviewer flagged).
func TestPartUpsertBurst_ObserveZeroAllocSteadyState(t *testing.T) {
	var p PartUpsertBurstStats
	tool := toolPart("p1", "s", "m", "out")

	// Pre-warm: claim the distinct slot + establish the resident so the
	// measured calls exercise the steady-state repeat path (same identity,
	// identical bytes), not the first-claim slow path.
	p.Observe(tool, "tool", "s", "m", "p1", nil)  // claim slot, new part → changed
	p.Observe(tool, "tool", "s", "m", "p1", tool) // identical re-upsert (resident now set)

	n := testing.AllocsPerRun(100, func() {
		p.Observe(tool, "tool", "s", "m", "p1", tool)
	})
	if n != 0 {
		t.Fatalf("steady-state Observe allocs/op = %v, want 0 (pure atomics + allocation-free bytes.Equal on the repeat path; part type threaded in, not re-parsed)", n)
	}
}

// TestPartUpsertBurst_HashIsDeterministicAndSeparatesFields confirms the
// non-reversible identity hash is deterministic (same triple → same hash) and
// separates field boundaries (so ("a","bc",x) != ("ab","c",x)).
func TestPartUpsertBurst_HashIsDeterministicAndSeparatesFields(t *testing.T) {
	h1 := hashPartIdentity("s", "m", "p1")
	h2 := hashPartIdentity("s", "m", "p1")
	if h1 != h2 {
		t.Fatalf("hash not deterministic: %d != %d", h1, h2)
	}
	if h1 == 0 {
		t.Fatalf("hash must be non-zero (CAS empty sentinel)")
	}
	// Field-boundary separation.
	if hashPartIdentity("a", "bc", "p") == hashPartIdentity("ab", "c", "p") {
		t.Fatalf("field-boundary separator failed: (a,bc,p) collides with (ab,c,p)")
	}
	// Different triples differ (probabilistically; FNV-1a collision over three
	// short distinct strings is astronomically unlikely).
	if hashPartIdentity("s", "m", "p1") == hashPartIdentity("s", "m", "p2") {
		t.Fatalf("distinct identities collided: (s,m,p1) == (s,m,p2)")
	}
}

// NOTE: the subscriber-channel high-water mechanic (PartUpsertBurst.
// SubChanEventsHighWater) is exercised through pkg/state's sampleSubChanHighWater
// helper, which lives in pkg/state/subscriptions.go (it takes a chan
// ClientEvent — a pkg/state type). Its test lives with the slice-4A fixture in
// pkg/state/part_upsert_burst_fixture_test.go.

// TestPartUpsertBurstJSONShape verifies the probe surfaces in /vh/diag/latency
// with the documented field names so a reader (human or SPA) can rely on the
// shape declared in tmp/agent-runs/compaction-burst-brief/brief.md §"Slice 4A
// detail". Mirrors the slice-1 probe's TestPartDeltaFieldsJSONShape.
func TestPartUpsertBurstJSONShape(t *testing.T) {
	resetAndRestore(t)

	// One identical tool-part re-upsert + one changed, so the identical/changed
	// + tool subset counters are all non-zero and surface in the JSON.
	tool := toolPart("p1", "s", "m", "out")
	Default.PartUpsertBurst.Observe(tool, "tool", "s", "m", "p1", nil)                           // new → changed
	Default.PartUpsertBurst.Observe(tool, "tool", "s", "m", "p1", tool)                          // identical
	Default.PartUpsertBurst.Observe(toolPart("p1", "s", "m", "x"), "tool", "s", "m", "p1", tool) // changed

	var raw strings.Builder
	enc := json.NewEncoder(&raw)
	if err := enc.Encode(Snapshot()); err != nil {
		t.Fatalf("encode snapshot: %v", err)
	}
	body := raw.String()
	for _, want := range []string{
		`"part_upsert_burst"`,
		`"events":3`,
		`"tool_events":3`,
		`"identical_events":1`,
		`"changed_events":2`,
		`"distinct_parts":1`,
		`"distinct_overflow":0`,
		`"sub_chan_events_high_water":0`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("snapshot JSON missing %q\nbody:\n%s", want, body)
		}
	}
}

// TestPartUpsertBurstEmptyState verifies an unobserved probe reports clean
// zeroes in the snapshot (so the JSON shape is stable from process start,
// before any authoritative part.upsert has been observed).
func TestPartUpsertBurstEmptyState(t *testing.T) {
	resetAndRestore(t)

	snap := Snapshot()
	pb := snap.Probes.PartUpsertBurst
	if pb.Events != 0 || pb.Bytes != 0 || pb.ToolEvents != 0 || pb.ToolBytes != 0 {
		t.Fatalf("empty probe has non-zero totals: %+v", pb)
	}
	if pb.IdenticalEvents != 0 || pb.ChangedEvents != 0 {
		t.Fatalf("empty probe has non-zero identical/changed: %+v", pb)
	}
	if pb.DistinctParts != 0 || pb.DistinctOverflow != 0 {
		t.Fatalf("empty probe has non-zero distinct: %+v", pb)
	}
	if pb.SubChanEventsHighWater != 0 {
		t.Fatalf("empty probe has non-zero high-water: %+v", pb)
	}
}

// itoa is a local strconv.Itoa to avoid importing strconv for one call.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
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
