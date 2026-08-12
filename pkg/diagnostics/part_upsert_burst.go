package diagnostics

import (
	"bytes"
	"encoding/json"
	"sync/atomic"
)

// MaxPartUpsertDistinctSlots is the cap on distinct part identities tracked by
// PartUpsertBurstStats' distinct-part table. Bounded so the probe's cardinality
// is fixed for the lifetime of the process — the same discipline as
// PartDeltaFieldStats and every other probe here. 256 is comfortably above the
// observed incident burst (~49 TOOL parts) and gives a real production burst
// headroom before the overflow counter fires; a non-zero overflow signals the
// cap is too low for the workload (the cumulative events/bytes counters still
// carry the authoritative totals regardless).
const MaxPartUpsertDistinctSlots = 256

// PartUpsertBurstStats is the bounded upsert-path burst characterization probe
// for the part-streaming redesign's compaction-burst axis (slice 4A — see
// docs/ai/wire-protocols/compaction-burst-axis.md §"Slice 4A detail"). It is a
// SEPARATE probe from PartDeltaFieldStats: that probe instruments the DELTA
// flush path (flushPartDeltasLocked); THIS probe instruments the AUTHORITATIVE
// upsert path (upsertPartLocked in pkg/state/reducers.go), which is the path
// compaction rewrites ride (message.part.updated → NormPartUpsert).
//
// It answers the load-bearing question for the slice-4B decision gate: of the
// authoritative part.upsert events in a burst, how many are byte-identical
// re-upserts of the currently-resident representation (candidates for O2
// ingress no-op suppression) vs materially changed? Plus the burst's event/byte
// volume, the TOOL-part subset, the distinct-part count, and a global
// subscriber-channel events high-water (does the burst fill the queue?).
//
// All fields are Counter / atomic.Uint64 / atomic.Int64 — NO Histogram, so NO
// initSentinels entry is needed (see primitives.go: only Histograms require the
// uninitialized-min sentinel). Safe for concurrent use: the upsert-path writer
// is serialized under the store's s.mu, but Observe uses only atomics so it is
// correct regardless; the Snapshot() reader is lock-free.
//
// No transcript content, part IDs, session IDs, or message IDs appear in
// diagnostics: the distinct-part table keys on a non-reversible FNV-1a hash of
// (sessionID, messageID, partID), stored as a bare uint64. The hash cannot be
// inverted to recover the ids.
type PartUpsertBurstStats struct {
	// Cumulative authoritative part.upsert observation counters (pure atomics).
	// These are process-lifetime totals; a point-in-time burst is characterized
	// by resetting the probe immediately before the burst (tests use
	// ResetForTest; production attributes via the rate since started_at).
	Events Counter // total authoritative part.upsert events observed
	Bytes  Counter // total post-cap serialized part bytes (len of the emitted payload)
	// TOOL-part subset (type == "tool"). TOOL parts are the observed
	// compaction-burst population; the subset split lets an operator see the
	// burst's composition without per-event logging.
	ToolEvents Counter
	ToolBytes  Counter
	// Exact-identical vs changed split — THE load-bearing metric for the O2
	// decision. "Identical" = the capped incoming part is byte-for-byte equal
	// to the part currently resident in the store (a pure re-persist candidate
	// for no-op suppression). "Changed" = the incoming part differs from the
	// resident (or there was no prior resident — a genuinely new part counts as
	// changed; it is not a no-op).
	IdenticalEvents Counter
	IdenticalBytes  Counter
	ChangedEvents   Counter
	ChangedBytes    Counter

	// distinct is the bounded distinct-part-identity table. Each slot is keyed
	// by a non-reversible FNV-1a hash of (sessionID, messageID, partID). A
	// repeat upsert of the SAME part (same id triple) hits the same slot and
	// increments its count; a NEW distinct part claims an empty slot via CAS.
	// The claimed-slot count (read by Snapshot) is the distinct-part count.
	// Allocation happens ONLY on slot claim (≤ MaxPartUpsertDistinctSlots times
	// per process); the steady-state repeat path is pure atomics.
	distinct [MaxPartUpsertDistinctSlots]partUpsertDistinctObs
	// distinctOverflow counts observations that arrived after every slot was
	// claimed by a DIFFERENT hash. Non-zero means the slot cap is too low for
	// the workload, not that data was lost unattributably (the cumulative
	// Events/Bytes counters still carry the totals).
	distinctOverflow Counter

	// SubChanEventsHighWater is the global max len(subscriber.ch) observed at
	// the emit fanout (updated in pkg/state/subscriptions.go emit /
	// emitPartAppend after a successful channel push). It is the cheap
	// production sentinel for "did the burst fill a subscriber queue": a value
	// approaching the 256-event subscriber buffer under load is the queue-fill
	// signature. atomic.Int64 (updated under s.mu in emit, so the CAS is
	// uncontended — effectively a guarded Store; read lock-free by Snapshot).
	// This is a GLOBAL high-water across ALL subscribers, not specifically the
	// selected-session subscriber; the slice-4A fixture measures the selected-
	// session subscriber's high-water directly for the precise figure.
	SubChanEventsHighWater atomic.Int64
}

// partUpsertDistinctObs is one slot in the bounded distinct-part-identity
// table. hash==0 means the slot is unclaimed; a non-zero hash is a claimed slot
// (FNV-1a output, guarded non-zero by Observe so the empty sentinel is
// unambiguous). count/bytes are the per-identity totals.
type partUpsertDistinctObs struct {
	hash  atomic.Uint64
	count Counter
	bytes Counter
}

// Observe records one authoritative part.upsert observation for burst
// characterization. It is called from upsertPartLocked AFTER capPartJSON and
// BEFORE the part is stored, so `resident` is the part currently in the store
// (the pre-overwrite value; nil/empty for a brand-new part). Pure atomics: a
// single linear scan over the bounded distinct-slot array to find/claim the
// matching hash, plus one allocation-free bytes.Equal for the identical/changed
// classification. The part type is THREADED IN as `partType` (extracted by the
// caller from its already-unmarshaled partEnvelope — see pkg/state/reducers.go
// upsertPartLocked), so Observe does NOT re-parse the part JSON. This mirrors
// the slice-1 PartDeltaFieldStats contract (pure atomics, ZERO hot-path
// allocation). Allocation occurs ONLY on a first-ever distinct-part slot claim
// (≤ MaxPartUpsertDistinctSlots total across the process lifetime); the
// steady-state repeat path allocates nothing — see
// TestPartUpsertBurst_ObserveZeroAllocSteadyState (test-enforced).
//
// `part` is the capped incoming part JSON (what will be emitted);
// `partType` is the part's top-level "type" field (e.g. "tool"/"text"), already
// parsed by the caller — never re-parsed here;
// `sid`/`mid`/`pid` are the session/message/part ids (used ONLY to derive the
// non-reversible distinct-identity hash — never stored or emitted raw);
// `resident` is the currently-resident part JSON (the byte-equality reference).
func (p *PartUpsertBurstStats) Observe(part json.RawMessage, partType string, sid, mid, pid string, resident json.RawMessage) {
	n := uint64(len(part))
	p.Events.Inc()
	p.Bytes.Add(n)

	// Part-type classification. partType is threaded in from the caller's
	// already-unmarshaled partEnvelope (no re-parse here); capPartJSON only
	// trims oversized string VALUES at depth, so the caller's parsed type is
	// the authoritative type of the capped part too.
	if partType == "tool" {
		p.ToolEvents.Inc()
		p.ToolBytes.Add(n)
	}

	// Exact-identical vs changed — THE O2 metric. bytes.Equal is allocation-
	// free O(len); for the authoritative upsert path (which already does an
	// env unmarshal + capPartJSON), this is marginal. A brand-new part (no
	// resident) is classified changed (it is not a no-op re-persist).
	if len(resident) > 0 && bytes.Equal(resident, part) {
		p.IdenticalEvents.Inc()
		p.IdenticalBytes.Add(n)
	} else {
		p.ChangedEvents.Inc()
		p.ChangedBytes.Add(n)
	}

	// Distinct-part table: hash the id triple (non-reversible; no raw ids in
	// diagnostics), then find-or-claim a slot. Bounded ≤ MaxPartUpsertDistinctSlots
	// distinct identities per process; overflow counter signals cap exceeded.
	h := hashPartIdentity(sid, mid, pid)
	// Fast path: an already-claimed slot whose hash matches.
	for i := range p.distinct {
		if p.distinct[i].hash.Load() == h {
			p.distinct[i].count.Inc()
			p.distinct[i].bytes.Add(n)
			return
		}
	}
	// Slow path (bounded ≤ MaxPartUpsertDistinctSlots times per process): claim
	// an empty slot for this new distinct identity. CAS publishes the hash; 0 is
	// the empty sentinel, so the hash is guarded non-zero below.
	for i := range p.distinct {
		if p.distinct[i].hash.Load() != 0 {
			continue
		}
		if p.distinct[i].hash.CompareAndSwap(0, h) {
			p.distinct[i].count.Inc()
			p.distinct[i].bytes.Add(n)
			return
		}
		// Lost the CAS: re-read the winner — it may be our hash (another
		// goroutine claimed the same identity concurrently), in which case we
		// count against it rather than overflowing.
		if w := p.distinct[i].hash.Load(); w == h {
			p.distinct[i].count.Inc()
			p.distinct[i].bytes.Add(n)
			return
		}
		// Someone else claimed this slot for a different identity; keep scanning.
	}
	// Every slot is claimed by a distinct identity, none match, and the table
	// is full. Bounded overflow — see field comment.
	p.distinctOverflow.Inc()
}

// distinctClaimedCount returns the number of distinct-part slots currently
// claimed (the distinct-part count). Read by Snapshot under no lock (atomic
// loads); a point-in-time value.
func (p *PartUpsertBurstStats) distinctClaimedCount() int {
	n := 0
	for i := range p.distinct {
		if p.distinct[i].hash.Load() != 0 {
			n++
		}
	}
	return n
}

// hashPartIdentity derives a non-reversible FNV-1a 64-bit hash of the
// (sessionID, messageID, partID) identity triple. The hash is the ONLY thing
// stored in the distinct-part table — the raw ids never appear in diagnostics
// and the hash cannot be inverted to recover them. A non-zero separator byte
// (0x01) is folded between fields so ("a","bc",_) != ("ab","c",_). Allocation-
// free: iterates the string bytes without concatenating. Guarded non-zero
// (returns 1 for the astronomically-unlikely FNV-1a zero output) so the
// distinct-slot CAS empty-sentinel (0) stays unambiguous.
func hashPartIdentity(sid, mid, pid string) uint64 {
	const (
		offset = uint64(14695981039346656037)
		prime  = uint64(1099511628211)
	)
	h := offset
	absorb := func(s string) {
		for i := 0; i < len(s); i++ {
			h ^= uint64(s[i])
			h *= prime
		}
		h ^= 0x01 // non-zero field separator
		h *= prime
	}
	absorb(sid)
	absorb(mid)
	absorb(pid)
	if h == 0 {
		h = 1 // guard the CAS empty-sentinel
	}
	return h
}
