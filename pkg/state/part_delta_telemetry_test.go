package state

import (
	"testing"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// newPartDeltaTelemetryStore builds a Store whose flush interval is 1ns so
// EVERY applied part delta flushes synchronously (the validated equivalent of a
// zero interval, which Config.validate() rejects — see delta_coalesce_test.go's
// BenchmarkApplyPartDeltaFlushEveryDelta for the precedent). This makes the
// telemetry assertions deterministic without depending on the 30ms throttle's
// first-delta-of-burst rule.
func newPartDeltaTelemetryStore(t *testing.T) *Store {
	t.Helper()
	return mustNew(t, withFlushInterval(DefaultConfig(100), time.Nanosecond))
}

// TestPartDeltaTelemetryRecordsTypeAndField is the slice-1 integration proof for
// the part-append-streaming contract (docs/ai/wire-protocols/part-append-streaming.md
// §5.1 / §6). It drives one streaming text delta through the store and asserts
// the (partType, field) pair the flush materialized landed in
// /vh/diag/latency's probes.part_delta_fields. This is the empirically-
// confirmable half of open-question #1's resolution (the static half is in the
// spec doc): the flush path records the flat top-level field it SET, and the
// probe is wired through to the diagnostic surface an operator reads.
func TestPartDeltaTelemetryRecordsTypeAndField(t *testing.T) {
	diag.ResetForTest()
	t.Cleanup(diag.ResetForTest)

	s := newPartDeltaTelemetryStore(t)
	s.Apply(ev("message.part.delta",
		`{"sessionID":"s","messageID":"m1","partID":"p1","field":"text","delta":"Hello"}`))

	snap := diag.Snapshot()
	var textCount, textBytes uint64
	found := false
	for _, e := range snap.Probes.PartDeltaFields {
		if e.PartType == "text" && e.Field == "text" {
			found = true
			textCount = e.Count
			textBytes = e.Bytes
			break
		}
	}
	if !found {
		t.Fatalf("probes.part_delta_fields has no (text,text) entry after a text delta flush; "+
			"full table = %+v", snap.Probes.PartDeltaFields)
	}
	if textCount != 1 {
		t.Fatalf("(text,text) count = %d, want 1 (one flush)", textCount)
	}
	if textBytes != 5 { // "Hello"
		t.Fatalf("(text,text) bytes = %d, want 5 (len of the flushed field text)", textBytes)
	}
	if snap.Probes.PartDeltaFieldOverflow != 0 {
		t.Fatalf("part_delta_field_overflow = %d, want 0", snap.Probes.PartDeltaFieldOverflow)
	}
}

// TestPartDeltaTelemetryDistinguishesField confirms the probe key is
// (partType, field), so a reasoning delta and a text delta land in distinct
// slots — the granularity the spec's allowlist (§5) and slice-4 byte baseline
// rely on. Two deltas on the same message/part but different fields both flush
// (1ns interval) and land in distinct slots.
func TestPartDeltaTelemetryDistinguishesField(t *testing.T) {
	diag.ResetForTest()
	t.Cleanup(diag.ResetForTest)

	s := newPartDeltaTelemetryStore(t)
	s.Apply(ev("message.part.delta",
		`{"sessionID":"s","messageID":"m1","partID":"p1","field":"text","delta":"hi"}`))
	s.Apply(ev("message.part.delta",
		`{"sessionID":"s","messageID":"m1","partID":"p1","field":"reasoning","delta":"hmm"}`))

	snap := diag.Snapshot()
	seen := map[[2]string]bool{}
	for _, e := range snap.Probes.PartDeltaFields {
		seen[[2]string{e.PartType, e.Field}] = true
	}
	if !seen[[2]string{"text", "text"}] {
		t.Fatalf("missing (text,text); table = %+v", snap.Probes.PartDeltaFields)
	}
	if !seen[[2]string{"text", "reasoning"}] {
		t.Fatalf("missing (text,reasoning); table = %+v", snap.Probes.PartDeltaFields)
	}
	if len(snap.Probes.PartDeltaFields) != 2 {
		t.Fatalf("expected exactly 2 distinct pairs, got %d: %+v", len(snap.Probes.PartDeltaFields), snap.Probes.PartDeltaFields)
	}
}
