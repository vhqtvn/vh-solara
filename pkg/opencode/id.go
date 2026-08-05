package opencode

// Caller-minted OpenCode message IDs.
//
// OpenCode mints message IDs via Identifier.ascending("message")
// (sst/opencode packages/opencode/src/id/id.ts). prompt_async's body accepts an
// optional `messageID` and — on v1.17.18 — persists it verbatim
// (`input.messageID ?? MessageID.ascending()`), so a caller that supplies a
// correctly-formatted ID gets that EXACT ID back on the persisted user message.
// That lets vh-solara's queue correlate a dispatched item to the OpenCode
// message it became, and later look it up by exact ID
// (GET /session/:sid/message/:mid) to reconcile delivered-but-stuck items.
//
// MintMessageID replicates the ascending format byte-for-byte so caller-minted
// IDs interleave correctly with real OpenCode IDs under OpenCode's string-based
// latest()/pagination ordering. It is NOT a re-implementation for our own IDs —
// the value is handed to OpenCode and must sort as if OpenCode minted it.

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// Cross-file mirror — KEEP IN SYNC:
// tests/e2e-docker/mint_msg_id.py replicates MintMessageID's byte layout in
// Python for the docker-gold e2e harness (it mints pre-known IDs the assert
// helpers match on). It is NOT exercised by Go tests. If you change ANY part
// of the layout — the "msg_" prefix, the 6-byte/12-hex time prefix, the
// 14-char base62 suffix, opencodeIDAlphabet, opencodeIDSuffixLen, or the
// now = unixMilli*0x1000 + counter encoding — you MUST co-update
// tests/e2e-docker/mint_msg_id.py or the docker-gold e2e assertions will
// silently drift. (mint_msg_id.py:4-8 already points back here.) The Go
// format-invariant test TestMintMessageID_Format (id_test.go) covers the Go
// side; it is NOT duplicated for Python.

// opencodeIDAlphabet mirrors sst/opencode's base62 alphabet (id.ts randomBase62):
// digits, then UPPER-case, then lower-case. The ordering within the alphabet does
// not affect sort order (ordering is carried by the time-ordered hex prefix); only
// the length (14) and the 62-symbol charset matter for format fidelity.
const opencodeIDAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// opencodeIDSuffixLen is the total suffix length after "msg_" (LENGTH in id.ts).
// The suffix is 12 hex chars (the 6-byte time-ordered prefix) + 14 base62 chars.
const opencodeIDSuffixLen = 26

// mintState carries the per-process monotonic counter for MintMessageID,
// mirroring id.ts's module-level lastTimestamp/counter. Guarded by mintMu so
// concurrent mints never collide on (millisecond, counter).
var (
	mintMu      sync.Mutex
	mintLastMs  int64
	mintCounter uint64
)

// MintMessageID mints a fresh OpenCode message ID that replicates
// Identifier.ascending("message") from sst/opencode v1.17.18
// (packages/opencode/src/id/id.ts), so a caller-minted ID sorts correctly
// relative to real OpenCode IDs under OpenCode's string-based latest()/
// pagination ordering.
//
// Byte layout (EXACT, verified against id.ts at tag v1.17.18):
//
//	"msg_" + hex(6 bytes) + base62(14)
//
// where the 6 bytes are the big-endian low 48 bits of
//
//	now = unixMilli * 0x1000 + counter
//
// counter resets to 0 when the millisecond advances, then increments to 1 on
// the first mint within that ms (exactly id.ts's `counter = 0; counter++`).
// The 12-hex-char prefix is monotonically non-decreasing with wall-clock time
// within a 2^48 `now` window, so lexicographic string ordering of the full ID
// matches chronological ordering (the property OpenCode's latest()/pagination
// rely on). The trailing 14 base62 chars are random and carry no ordering
// information.
//
// Fresh per call; NEVER reused; never derived from message text; never
// regenerated after a timeout. Used by the queue (Claim) as the authoritative
// correlation ID threaded into prompt_async's `messageID` body field.
func MintMessageID() string {
	mintMu.Lock()
	// Read the wall clock INSIDE the lock and forward-clamp it so mintLastMs is
	// non-decreasing. time.Now().UnixMilli() is pure wall clock (not Go's
	// monotonic clock) and can step backwards under NTP/settimeofday; clamping
	// honors the format's ascending intent over raw wall-clock under skew.
	ms := time.Now().UnixMilli()
	if ms < mintLastMs {
		ms = mintLastMs
	}
	if ms != mintLastMs {
		mintLastMs = ms
		mintCounter = 0
	}
	mintCounter++
	// Saturate at 0xFFF so the counter can never bleed into the timestamp bits.
	// id.ts's `counter++` is unbounded and WOULD bleed past 0x1000 (carrying into
	// the ms bits) if >4095 IDs were minted in one millisecond — and a bleed
	// breaks the very monotonicity this format exists to provide: a bled prefix
	// (effective ms = real_ms + carry) sorts AFTER the prefix minted when the
	// next millisecond actually advances and the counter resets to 1. id.ts never
	// hits this because a single user session mints far fewer than 4096/ms, but
	// our port shares one counter across all callers (dense test loops, multiple
	// test functions, -count iterations) and CAN exceed 4096/ms. Saturating
	// preserves the byte layout and the now = ms*0x1000 + counter encoding
	// exactly (counter ∈ [1, 4095]); in the >4095/ms regime — unreachable in
	// production (the queue mints one ID per Enqueue, gated by fsync) — the
	// saturated counter holds a stable prefix instead of bleeding, and the
	// random 14-char tail still guarantees uniqueness. This is a strictly better
	// realization of id.ts's ascending intent than replicating its latent bleed.
	if mintCounter > 0xFFF {
		mintCounter = 0xFFF
	}
	counter := mintCounter
	mintMu.Unlock()

	// now = ms * 0x1000 + counter, mirroring id.ts's
	// `BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)`. counter
	// mirrors id.ts exactly (starts at 1 within a ms) and is saturated at 0xFFF
	// above, so it never carries into the timestamp bits.
	now := uint64(ms)*0x1000 + counter

	// Low 48 bits of `now`, big-endian, as 6 bytes → 12 lowercase hex chars.
	// Mirrors id.ts's timeBytes loop: byte i = (now >> (40 - 8*i)) & 0xff.
	var tb [6]byte
	for i := uint(0); i < 6; i++ {
		tb[i] = byte(now >> (40 - 8*i))
	}
	return "msg_" + hex.EncodeToString(tb[:]) + randomBase62(opencodeIDSuffixLen-12)
}

// randomBase62 returns n base62 chars drawn from crypto/rand, mirroring id.ts's
// randomBase62 (bytes[i] % 62 over opencodeIDAlphabet). The modulo bias is
// intentional fidelity to the upstream format; it affects neither sort order
// (the random tail is unordered) nor uniqueness (crypto/rand + 62^14 space).
func randomBase62(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	out := make([]byte, n)
	for i, b := range buf {
		out[i] = opencodeIDAlphabet[int(b)%len(opencodeIDAlphabet)]
	}
	return string(out)
}

// ParseMessageIDTime extracts the millisecond timestamp encoded in an
// ascending OpenCode message ID (the inverse of the time-prefix half of
// MintMessageID). It mirrors id.ts's `timestamp()`: parse the 12 hex chars after
// "msg_" as big-endian, then divide by 0x1000. TEST/DEBUG aid — production
// reconciliation matches by exact ID, not by decoded time. Returns ok=false for
// a malformed (non-msg_ / too-short) id.
func ParseMessageIDTime(id string) (ms int64, ok bool) {
	const prefix = "msg_"
	if len(id) < len(prefix)+12 || id[:len(prefix)] != prefix {
		return 0, false
	}
	var enc uint64
	for _, c := range []byte(id[len(prefix) : len(prefix)+12]) {
		v, ok := hexNibble(c)
		if !ok {
			return 0, false
		}
		enc = enc<<4 | uint64(v)
	}
	return int64(enc / 0x1000), true
}

func hexNibble(c byte) (uint8, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}
