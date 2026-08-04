package opencode

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

// MintMessageID replicates sst/opencode v1.17.18 Identifier.ascending("message")
// (packages/opencode/src/id/id.ts). These tests pin the byte layout, sort
// fidelity, uniqueness, and charset — the properties the queue's caller-minted
// correlation ID relies on (prompt_async persists it verbatim; later
// GET /session/:sid/message/:mid matches it exactly).

var (
	idFormatRe = regexp.MustCompile(`^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	base62Set  = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)

func inSet(s, set string) bool {
	for _, r := range s {
		if !strings.ContainsRune(set, r) {
			return false
		}
	}
	return true
}

// 1. Format: "msg_" + 12 lowercase hex + 14 base62 (total length 30).
func TestMintMessageID_Format(t *testing.T) {
	id := MintMessageID()
	if len(id) != 30 {
		t.Fatalf("length: got %d (%q), want 30", len(id), id)
	}
	if !strings.HasPrefix(id, "msg_") {
		t.Fatalf("prefix: got %q, want \"msg_\"", id)
	}
	if !idFormatRe.MatchString(id) {
		t.Fatalf("format: %q does not match msg_<12 hex><14 base62>", id)
	}
	tail := id[4+12:]
	if !inSet(tail, base62Set) {
		t.Fatalf("tail not base62: %q", tail)
	}
}

// 2. Uniqueness: many rapid mints are all distinct (the per-ms counter + random
// tail together guarantee it).
func TestMintMessageID_Unique(t *testing.T) {
	const n = 5000
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		id := MintMessageID()
		if _, dup := seen[id]; dup {
			t.Fatalf("duplicate id minted: %q (after %d mints)", id, i)
		}
		seen[id] = struct{}{}
	}
}

// 3. Sort fidelity: the time-ordered hex prefix is monotonically non-decreasing
// across successive mints, so string-sort matches chronological order (the
// property OpenCode's latest()/pagination rely on). Within a single millisecond
// the prefix strictly increases (counter adds to the low bits); across
// milliseconds it is non-decreasing — the counter saturates at 0xFFF (see
// MintMessageID in id.go), so it never carries into the ms bits.
//
// NOTE on the >4095/ms edge: id.ts's `counter++` is unbounded and WOULD bleed
// past 0x1000 (carrying into the ms bits and breaking cross-ms monotonicity) if
// >4095 IDs were minted in one ms. MintMessageID DIVERGES from id.ts here: it
// saturates the counter at 0xFFF (id.go), honoring id.ts's ascending INTENT
// (monotonic sort) over replicating its latent bleed. The byte layout and the
// now = ms*0x1000 + counter encoding are unchanged; divergence occurs only in
// the >4095/ms regime, unreachable in production (the queue mints one ID per
// Enqueue, gated by fsync). This test caps the run at n=3000 not to avoid a
// bleed (one cannot occur post-saturation) but to exercise realistic rates
// including the within-ms and cross-ms transitions; the saturation branch
// itself is exercised under dense minting by a dedicated test below.
func TestMintMessageID_TimePrefixMonotonic(t *testing.T) {
	const n = 3000 // realistic rate; bleed is impossible post-saturation
	prevPrefix := ""
	prevMs := time.Now().UnixMilli()
	sawAdvance := false
	for i := 0; i < n; i++ {
		id := MintMessageID()
		cur := id[4 : 4+12]
		if cur < prevPrefix {
			t.Fatalf("time prefix DECREASED at i=%d: prev=%q cur=%q (sort fidelity broken)", i, prevPrefix, cur)
		}
		ms := time.Now().UnixMilli()
		if ms > prevMs {
			sawAdvance = true
		}
		prevMs = ms
		prevPrefix = cur
	}
	if !sawAdvance {
		t.Logf("note: loop ran within a single ms (cross-ms advance not observed); monotonicity still holds within-ms")
	}
}

// 4. Cross-millisecond strict ordering: two mints separated by a real sleep
// that crosses a ms boundary produce strictly-increasing IDs (full string sort).
// This is the sort property the reconciler's "interleave with real OpenCode IDs"
// rationale rests on.
func TestMintMessageID_CrossMillisecondStrictOrder(t *testing.T) {
	a := MintMessageID()
	// Spin until the wall-clock millisecond advances, then mint b. A tight loop
	// is used (not a fixed sleep) so the test is fast and deterministic about
	// crossing exactly one ms boundary.
	start := time.Now().UnixMilli()
	for time.Now().UnixMilli() == start {
	}
	b := MintMessageID()
	if !(b > a) {
		t.Fatalf("cross-ms mint did not strictly increase: a=%q b=%q", a, b)
	}
}

// Saturation branch: under dense minting (>4095 IDs in one wall-ms) the counter
// saturates at 0xFFF (id.go) and monotonicity must hold THROUGH the saturation.
// TestMintMessageID_TimePrefixMonotonic caps at n=3000 so the cap never fires
// there; this test mints a large N to drive density and guard the saturated path
// directly.
//
// PROBABILISTIC on coverage, not on correctness. The non-decreasing-prefix
// assertion holds post-fix regardless of density (it is the property the
// saturation exists to preserve), so the test passes when the fix is present and
// FAILS if someone removes the saturation: without the cap, a bled prefix
// (effective ms = real_ms + carry) would sort AFTER the next ms's first
// counter=1 prefix. Whether the saturation branch (mintCounter > 0xFFF) actually
// executes depends on minting >4095 IDs within a single wall-ms, achievable on
// fast machines (each mint does a crypto/rand.Read of 14 bytes; prior
// instrumentation observed ~5762/ms) but not guaranteed on slow CI runners.
//   - assert every prefix is non-decreasing (the load-bearing regression guard);
//   - group prefixes by their ms portion and report the densest ms: counter
//     takes only 4095 distinct values per ms (1..0xFFF, since MintMessageID does
//     counter++ before use so 0 is never emitted), so a ms-group larger than
//     4095 proves the saturation branch fired this run.
//
// Coverage is logged honestly and never failed on (that would be flaky); under
// -count the branch is exercised on any run fast enough to cross 4096/ms.
func TestMintMessageID_SaturationMonotonic(t *testing.T) {
	const n = 20000
	prefixes := make([]string, n)
	for i := 0; i < n; i++ {
		prefixes[i] = MintMessageID()[4 : 4+12]
	}
	// Regression guard: prefixes must be non-decreasing.
	for i := 1; i < n; i++ {
		if prefixes[i] < prefixes[i-1] {
			t.Fatalf("time prefix DECREASED at i=%d: prev=%q cur=%q (monotonicity broken through saturation)", i-1, prefixes[i-1], prefixes[i])
		}
	}
	// Coverage probe: group by the ms portion of the prefix. The 12-hex prefix
	// is the low 48 bits of now = ms*0x1000 + counter; multiplying by 0x1000
	// shifts ms up by 3 hex digits, so prefix[0:9] is ms (mod 2^36) and
	// prefix[9:12] is the counter. counter emits only 4095 distinct values per
	// ms (1..0xFFF), so a group larger than 4095 means more mints hit that ms
	// than there are counter values — the saturation branch must have fired.
	const distinctCounterValues = 4095
	densest := 0
	msCounts := make(map[string]int)
	for _, p := range prefixes {
		k := p[:9]
		msCounts[k]++
		if msCounts[k] > densest {
			densest = msCounts[k]
		}
	}
	if densest > distinctCounterValues {
		t.Logf("densest-ms count = %d (> %d): saturation branch (mintCounter > 0xFFF -> 0xFFF) WAS exercised this run; monotonicity held through it", densest, distinctCounterValues)
	} else {
		t.Logf("densest-ms count = %d (<= %d): saturation branch NOT exercised this run (mint density too low for this machine); monotonicity still holds and is asserted above", densest, distinctCounterValues)
	}
}

// 5. ParseMessageIDTime round-trips the time prefix (mirrors id.ts's
// timestamp()). NOTE: the 48-bit encoding keeps the low 48 bits of
// `now = ms*0x1000 + counter`, so the decoded value is `ms mod 2^36`. Over the
// current era all IDs share the same wrap epoch, so the decoded value tracks
// wall-clock modulo 2^36 — a debug aid, not used for exact-match reconciliation.
func TestParseMessageIDTime_RoundTrip(t *testing.T) {
	before := time.Now().UnixMilli()
	id := MintMessageID()
	after := time.Now().UnixMilli()
	ms, ok := ParseMessageIDTime(id)
	if !ok {
		t.Fatalf("ParseMessageIDTime: ok=false for valid id %q", id)
	}
	if ms <= 0 {
		t.Fatalf("ParseMessageIDTime: got non-positive ms %d for %q", ms, id)
	}
	// The decoded value is ms mod 2^36; verify it tracks wall-clock within the
	// current era (the mint happened between `before` and `after`).
	const era = int64(1) << 36
	for _, wall := range []int64{before, after} {
		want := wall % era
		d := ms - want
		// Allow the wrap representation: |d| small, OR d near ±era (a boundary
		// crossing, astronomically unlikely here but handled defensively).
		if d < -1000 || d > 1000 {
			if d > era-1000 || d < -(era-1000) {
				continue // boundary representation — acceptable
			}
			t.Fatalf("decoded ms %d not within 1s of wall %d (mod 2^36) for %q", ms, want, id)
		}
	}
}

// 6. ParseMessageIDTime rejects malformed ids.
func TestParseMessageIDTime_Malformed(t *testing.T) {
	for _, bad := range []string{"", "msg_", "msg_short", "ses_abc", "msg_zzzzzzzzzzzzxxxx"} {
		if _, ok := ParseMessageIDTime(bad); ok {
			t.Errorf("ParseMessageIDTime(%q): want ok=false, got ok=true", bad)
		}
	}
}
