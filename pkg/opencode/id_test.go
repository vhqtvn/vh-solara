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
// milliseconds it is non-decreasing while counter < 0x1000.
//
// NOTE on the counter-bleed edge: id.ts's formula is `now = ms*0x1000 + counter`
// with NO cap on counter, so minting MORE than 0x1000 (4096) IDs in one ms lets
// counter overflow into the timestamp bits and can break cross-ms monotonicity
// — that is opencode's own behavior and MintMessageID replicates it exactly for
// format fidelity. It is UNREACHABLE in production: the queue mints one ID per
// Enqueue, and Enqueue is gated by an atomic temp-write + fsync + rename (a few
// ms each), so >4096 enqueues in a single millisecond cannot occur. This test
// therefore caps the run well below the bleed threshold (≤3000 mints) so it
// exercises realistic rates and both the within-ms and cross-ms transitions.
func TestMintMessageID_TimePrefixMonotonic(t *testing.T) {
	const n = 3000 // < 0x1000: stays below the counter-bleed threshold
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
