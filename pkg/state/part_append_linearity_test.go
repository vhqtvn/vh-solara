package state

// part_append_linearity_test.go — Slice 4 deliverable 1 (THE load-bearing crux):
// a deterministic proof that an opted-in (Interest.WantsPartDelta) connection's
// part-class wire bytes scale O(L) with final text length L, while a legacy
// connection on the SAME stream scales O(L²). This is the OBSERVED-OUTCOME proof
// of the whole part-append-streaming redesign.
//
// Why per-subscriber channel bytes (not the emit-level class_bytes aggregate):
// emitPartAppend records ONE KindPartAppend in the ring + accounts its SUFFIX
// bytes into probes.emit.class_bytes["part"] — so the emit aggregate is already
// ~linear for opted-in. But that aggregate HIDES the legacy O(L²) cost, because
// the legacy synthesized full upsert is fanned out to legacy subscribers at the
// SAME seq WITHOUT being separately ringed or accounted (the legacy bytes ride
// the fanout, not the ring). Measuring PER-SUBSCRIBER wire bytes from real
// subscriber channels captures BOTH encodings honestly: opted-in channel sums
// the suffix payloads (O(L)); legacy channel sums the growing-full-text upsert
// payloads (O(L²)).
//
// See docs/ai/wire-protocols/part-append-streaming.md (spec §1/§2) and
// tmp/agent-runs/part-stream-redesign-brief/brief.md slice 4 ("linear part
// bytes").

import (
	"strings"
	"testing"
	"time"
)

// measurePartWireBytes subscribes one opted-in and one legacy subscriber to the
// same session stream, drives nDeltas deltas of deltaLen bytes each (every delta
// flushes at a 1ns interval so the measurement is deterministic — no host
// scheduling dependence), drains both channels, and returns the summed JSON
// payload bytes each subscriber received for that part's frames (KindPartAppend
// for opted-in, KindPartUpsert for legacy) plus the final field length L.
//
// Both subscribers are real Interest subscribers on the real Store fanout; the
// byte sum is len(ClientEvent.Payload) per received frame — the exact quantity
// the SSE pump writes to the wire for that subscriber (the per-frame data: bytes
// before SSE framing overhead, which is itself O(1) per frame and identical for
// both encodings, so it does not affect the divergence).
func measurePartWireBytes(t *testing.T, nDeltas, deltaLen int) (optedInBytes, legacyBytes, finalLen int) {
	t.Helper()
	s := seedPartStream(t, time.Nanosecond) // every delta flushes

	optedIn, stop1 := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop1()
	legacy, stop2 := s.SubscribeWith(256, Interest{}) // firehose + legacy encoding
	defer stop2()

	// Fixed ASCII delta so byte length == rune length (deterministic, no escape
	// overhead in the JSON text field).
	delta := strings.Repeat("a", deltaLen)
	for i := 0; i < nDeltas; i++ {
		applyDelta(s, "sess", "m1", "p1", "text", delta)
	}

	optEvents := drainAll(optedIn)
	legEvents := drainAll(legacy)

	// Sum JSON payload bytes for the relevant part-class kind on each channel.
	// Filtering by kind makes the measurement immune to any stray non-part event
	// (there are none here — the seed ran before subscribe — but the filter keeps
	// the proof honest about WHAT bytes are being attributed).
	for _, ev := range optEvents {
		if ev.Kind == KindPartAppend {
			optedInBytes += len(ev.Payload)
		}
	}
	for _, ev := range legEvents {
		if ev.Kind == KindPartUpsert {
			legacyBytes += len(ev.Payload)
		}
	}
	finalLen = nDeltas * deltaLen
	return
}

// TestPartAppend_Linearity_OptedInLinearLegacyQuadratic is the PRIMARY CRUX of
// the part-append-streaming redesign. It drives a part to three final lengths L
// (8/16/32 KiB) and asserts the O(L²)→O(L) reduction as an OBSERVED OUTCOME:
//
//  1. opted-in wire bytes are bounded by a small constant multiple of L (O(L));
//  2. opted-in scales ~linearly (when L doubles, opted-in ≈ doubles);
//  3. legacy wire bytes scale ~quadratically (when L doubles, legacy ≈ 4×);
//  4. the legacy/opted-in ratio grows monotonically with L (the win widens);
//  5. at the largest L, legacy ≥ 50× opted-in (the headline divergence).
//
// The exact byte counts are logged via t.Logf so the output is observable and
// the assertion thresholds are intentionally generous (they assert the SHAPE of
// the scaling — linear vs quadratic — not exact framing constants).
func TestPartAppend_Linearity_OptedInLinearLegacyQuadratic(t *testing.T) {
	const deltaLen = 128
	// (nDeltas, wantKiB): finalLen L = nDeltas*deltaLen bytes.
	cases := []struct {
		nDeltas int
		wantKiB int
	}{
		{64, 8},   // L =  8 KiB
		{128, 16}, // L = 16 KiB
		{256, 32}, // L = 32 KiB
	}
	type result struct{ opt, leg, L int }
	var results []result
	for _, c := range cases {
		opt, leg, L := measurePartWireBytes(t, c.nDeltas, deltaLen)
		if gotKiB := L / 1024; gotKiB != c.wantKiB {
			t.Fatalf("case nDeltas=%d: finalLen=%d KiB, want %d KiB", c.nDeltas, gotKiB, c.wantKiB)
		}
		results = append(results, result{opt, leg, L})
		t.Logf("L=%5dB (%2dKiB) nDeltas=%3d: opted-in=%7dB (%.2fxL)  legacy=%8dB (%.2fxL)  ratio=%.1fx",
			L, L/1024, c.nDeltas, opt, float64(opt)/float64(L), leg, float64(leg)/float64(L), ratio(leg, opt))
	}

	// 1. Opted-in is O(L): bounded by a small constant multiple of L. The only
	//    super-linear term is per-frame JSON framing, which is itself O(nDeltas)
	//    = O(L/deltaLen) = O(L), so the total stays a small constant × L.
	for _, r := range results {
		if got := float64(r.opt) / float64(r.L); got > 3.0 {
			t.Errorf("L=%dB: opted-in wire bytes %dB = %.2fxL (want <= 3xL — not O(L)-bounded)", r.L, r.opt, got)
		}
	}

	// 2. Opted-in scales ~linearly over the full 4× length range (8KiB→32KiB).
	//    Linear predicts ~4× growth; quadratic would be ~16×.
	r0, r2 := results[0], results[2]
	if optGrowth := ratio(r2.opt, r0.opt); optGrowth > 6.0 {
		t.Errorf("opted-in growth over 4x length range: %.2fx (want < 6 = linear; quadratic would be ~16x)", optGrowth)
	}

	// 3. Legacy scales ~quadratically: when L doubles, legacy ≈ 4× (linear would
	//    be 2×). Assert >= 3 to land clearly in the quadratic regime.
	for i := 1; i < len(results); i++ {
		prev, cur := results[i-1], results[i]
		if legGrowth := ratio(cur.leg, prev.leg); legGrowth < 3.0 {
			t.Errorf("L %dKiB→%dKiB: legacy growth %.2fx (want >= 3 = quadratic; linear would be 2x)",
				prev.L/1024, cur.L/1024, legGrowth)
		}
	}

	// 4. The legacy/opted-in ratio grows monotonically with L (the O(L²)→O(L) win
	//    widens as the part grows — the whole point of the redesign).
	for i := 1; i < len(results); i++ {
		prevRatio := ratio(results[i-1].leg, results[i-1].opt)
		curRatio := ratio(results[i].leg, results[i].opt)
		if curRatio <= prevRatio {
			t.Errorf("ratio L=%dKiB (%.1fx) did not exceed L=%dKiB (%.1fx) — win not widening",
				results[i].L/1024, curRatio, results[i-1].L/1024, prevRatio)
		}
	}

	// 5. Headline divergence at the largest L: legacy >= 50× opted-in.
	r := results[len(results)-1]
	if headRatio := ratio(r.leg, r.opt); headRatio < 50.0 {
		t.Errorf("L=%dKiB headline ratio: legacy/opted-in = %.1fx, want >= 50x", r.L/1024, headRatio)
	}
}

// ratio is a tiny divide-or-return-huge helper so a zero denominator never
// produces a misleading 0 or +Inf in an assertion message.
func ratio(a, b int) float64 {
	if b == 0 {
		return 1e9
	}
	return float64(a) / float64(b)
}
