package diagnostics

import "sync/atomic"

// MaxPartDeltaFieldSlots is the cap on distinct (partType, field) pairs tracked
// by PartDeltaFieldStats. Bounded so the probe's cardinality is fixed for the
// lifetime of the process — the same discipline as every other probe here (no
// per-session / per-stream-id / per-URL labels). 8 is comfortably above the v1
// allowlist (text/reasoning × a handful of part types); a non-zero overflow
// counter signals the cap is too low for the workload, not that data was lost
// unattributably.
const MaxPartDeltaFieldSlots = 8

// partDeltaFieldPair is the immutable label pair for a PartDeltaFieldObs slot.
// Once a slot is claimed, a pointer to this struct is published atomically and
// the strings are never mutated; readers Load the pointer then read the
// immutable fields. Allocation happens only on slot claim (≤
// MaxPartDeltaFieldSlots times per process); the steady-state hot path is pure
// atomics.
type partDeltaFieldPair struct {
	partType string
	field    string
}

// PartDeltaFieldObs is one slot in the bounded distinct-(partType,field)
// observation table for the part-delta flush path (flushPartDeltasLocked in
// pkg/state/reducers.go). The slot is reserved by the first matching
// observation; subsequent matches increment count/bytes with pure atomics.
//
// pair is published via atomic.Pointer.CompareAndSwap so the /vh/diag/latency
// snapshot reader (lock-free) never observes a torn label: the writer sets the
// immutable pair fields, then publishes the pointer; readers that Load a non-nil
// pointer see a fully-initialized pair. count/bytes may momentarily lag the
// pair publication (a reader can see a claimed pair with count=0 before the
// first Inc lands) — acceptable for point-in-time diagnostic counters.
type PartDeltaFieldObs struct {
	pair  atomic.Pointer[partDeltaFieldPair]
	count Counter
	bytes Counter
}

// PartDeltaFieldStats is the bounded distinct-(partType,field) probe for the
// part-delta flush path. It resolves open-question #1 of the part-append
// streaming redesign ("does nested tool output / state.output flow through the
// append-delta path today?") by making the answer empirically confirmable via
// /vh/diag/latency, and it gives slice 4 a per-field byte baseline.
//
// Counter / atomic.Pointer only — no Histogram, so NO initSentinels entry is
// needed (see primitives.go: only Histograms require the uninitialized-min
// sentinel). Safe for concurrent use: the flush-path writer is serialized under
// the store's s.mu, but Observe uses only atomics so it is correct regardless;
// the Snapshot() reader is lock-free.
//
// See docs/ai/wire-protocols/part-append-streaming.md §5.1 (open-question #1)
// and §6 (this probe).
type PartDeltaFieldStats struct {
	slots [MaxPartDeltaFieldSlots]PartDeltaFieldObs
	// overflow counts observations that arrived after every slot was claimed
	// by a DIFFERENT pair. Non-zero means the slot cap is too low for the
	// workload, not that data was lost unattributably (the aggregate
	// probes.emit.class_bytes["part"] still carries the total).
	overflow Counter
}

// Observe records one part-delta flush observation for (partType, field) with
// the flushed field-text byte length (the O(L)-per-flush quantity; summed
// across flushes this is the O(L²) cost the suffix protocol removes). Pure
// atomics: a single linear scan over the bounded slot array to find a matching
// claimed pair, else a second scan to claim the first empty slot via
// CompareAndSwap. Allocation occurs ONLY on a first-ever distinct pair (≤
// MaxPartDeltaFieldSlots total across the process lifetime); the steady-state
// repeat path allocates nothing.
func (p *PartDeltaFieldStats) Observe(partType, field string, fieldBytes int) {
	// Fast path: find an already-claimed slot whose pair matches.
	for i := range p.slots {
		pair := p.slots[i].pair.Load()
		if pair == nil {
			continue
		}
		if pair.partType == partType && pair.field == field {
			p.slots[i].count.Inc()
			p.slots[i].bytes.Add(uint64(fieldBytes))
			return
		}
	}
	// Slow path (bounded ≤ MaxPartDeltaFieldSlots times per process): claim an
	// empty slot for this new pair. CAS publishes the immutable pair pointer,
	// so readers never see a torn label.
	np := &partDeltaFieldPair{partType: partType, field: field}
	for i := range p.slots {
		if p.slots[i].pair.Load() != nil {
			continue
		}
		if p.slots[i].pair.CompareAndSwap(nil, np) {
			p.slots[i].count.Inc()
			p.slots[i].bytes.Add(uint64(fieldBytes))
			return
		}
		// Lost the CAS: re-read the winner — it may be our pair (another
		// goroutine claimed the same labels concurrently), in which case we
		// count against it rather than falling through.
		if winner := p.slots[i].pair.Load(); winner != nil &&
			winner.partType == partType && winner.field == field {
			p.slots[i].count.Inc()
			p.slots[i].bytes.Add(uint64(fieldBytes))
			return
		}
		// Someone else claimed this slot for a different pair; keep scanning.
	}
	// Every slot is claimed by a distinct pair, none match, and the table is
	// full. Bounded overflow — see field comment.
	p.overflow.Inc()
}
