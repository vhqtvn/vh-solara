// Package diagnostics holds passive, bounded, lock-free latency/throughput
// aggregates for vh-solara's data pipeline. It exists to attribute the
// "random slowness" symptom across the legs
//
//	[upstream OpenCode] → [aggregator/store emit]
//	                     → [SSE write] → [yamux tunnel]
//	                     → [controller proxy io.Copy] → [browser]
//
// WITHOUT changing any observable behavior. Every primitive here is:
//
//   - atomic / lock-free on the hot path (the only mutex is the IncidentRing
//     append, which fires only when a slow-incident threshold is crossed — a
//     rare event, never per-frame),
//   - bounded in cardinality (fixed classes, fixed sides, fixed directions,
//     fixed stream classes; NO per-session / per-stream-id / per-URL labels),
//   - aggregate-only (counts, bytes, durations, ages; NEVER raw transcript
//     content or message text).
//
// All probes report into a single package-level Default registry, exposed
// read-only via an authenticated GET handler. Nothing here mutates any
// pipeline behavior; it only observes.
package diagnostics

import (
	"sync"
	"sync/atomic"
	"time"
)

// Counter is an atomic uint64 counter. All methods are safe for concurrent
// use; Add/Load are pure atomic ops (no lock).
type Counter struct {
	v atomic.Uint64
}

// Add atomically adds n to the counter.
func (c *Counter) Add(n uint64) { c.v.Add(n) }

// Inc atomically adds 1.
func (c *Counter) Inc() { c.v.Add(1) }

// Load returns the current value.
func (c *Counter) Load() uint64 { return c.v.Load() }

// reset clears the counter. Test-only; never called from production code.
func (c *Counter) reset() { c.v.Store(0) }

// latencyBucketsNs are the fixed histogram boundaries (nanoseconds) covering
// the full range of interest from sub-microsecond to tens of seconds. Latency
// observations are bucketed by the SMALLEST boundary they fit under; the final
// bucket is overflow. The bucket edges are chosen so the interesting ranges for
// each leg (a few µs for an uncontended atomic; single-digit ms for a healthy
// SSE write; hundreds of ms for a slow tunnel) each land in a distinct bucket.
//
// NOTE: every element MUST be strictly positive and strictly increasing — both
// the bucket lookup (Observe walks until d <= edge) and the overflow sentinel
// (latencyBucketsNs[len-1]*overflowFactor) rely on the last real edge being
// non-zero. A zero in the array produces a degenerate "matches everything"
// lowest edge and an overflow sentinel of 0 (any slow observation appears
// instantaneous in the percentile projection). See TestHistogramEdgesPositive
// and TestHistogramOverflowPercentile for the regression.
var latencyBucketsNs = [12]int64{
	1_000,           // < 1µs
	10_000,          // < 10µs
	100_000,         // < 100µs
	1_000_000,       // < 1ms
	10_000_000,      // < 10ms
	50_000_000,      // < 50ms
	100_000_000,     // < 100ms
	500_000_000,     // < 500ms
	1_000_000_000,   // < 1s
	5_000_000_000,   // < 5s
	10_000_000_000,  // < 10s
	100_000_000_000, // < 100s (overflow bucket boundary — keeps the sentinel derivation sane)
}

// numBuckets is len(latencyBucketsNs)+1 (the last bucket is overflow).
const numBuckets = len(latencyBucketsNs) + 1

// overflowSentinelNs is the projected value returned for percentiles that land
// in the overflow bucket. Derived from the largest real boundary (NOT a hard-
// coded magic number) so it can never collapse to 0 even if the array above is
// edited: any percentile in overflow is reported as 10× the highest finite edge.
var overflowSentinelNs = latencyBucketsNs[len(latencyBucketsNs)-1] * 10

// Histogram is a fixed-bucket latency histogram updated with atomic ops only.
// Observe is safe for concurrent use and never blocks. Buckets are cumulative
// upper-bound edges: an observation of duration d increments the bucket whose
// edge is the smallest edge >= d; if d exceeds all edges it increments the
// overflow bucket.
//
// min/max/sum/count are maintained with atomic CAS loops. min starts
// "uninitialized" and is seeded by the first observation — INCLUDING a
// legitimate zero observation. We use a separate initialized flag (encoded in
// the high bit of min via minUninitializedBit) so a clamped-to-zero observation
// is not silently overwritten by a later, larger value.
type Histogram struct {
	count atomic.Int64
	sum   atomic.Int64 // total nanoseconds (can exceed 2^31 but not 2^63 for realistic windows)
	min   atomic.Int64
	max   atomic.Int64
	bucks [numBuckets]atomic.Int64
}

// minUninitializedBit is OR'd into Histogram.min to mark "no observation has
// been recorded yet". A real observation can never be negative (Observe clamps
// negatives to 0), so the high bit is a free sentinel that lets CAS tell apart
// "0 because nothing observed" from "0 because a legitimate 0 was observed".
// Using the high bit keeps the encoding inside the existing atomic.Int64 with
// no extra field.
const minUninitializedBit int64 = -1 << 63 // 0x8000_0000_0000_0000

// Observe records a single duration (nanoseconds). Pure atomics; no lock.
// A negative d is clamped to 0 (should not happen in practice; defensive).
func (h *Histogram) Observe(d int64) {
	if d < 0 {
		d = 0
	}
	h.count.Add(1)
	h.sum.Add(d)
	// seed min via CAS against the uninitialized sentinel. A genuine 0
	// observation must win the CAS the same way a positive value does.
	for {
		cur := h.min.Load()
		if cur&minUninitializedBit == 0 {
			// already initialized — only swap if d is strictly smaller.
			if cur <= d {
				break
			}
			if h.min.CompareAndSwap(cur, d) {
				break
			}
			continue
		}
		// uninitialized: seed with d (any d, including 0, is valid).
		if h.min.CompareAndSwap(cur, d) {
			break
		}
	}
	for {
		cur := h.max.Load()
		if cur >= d {
			break
		}
		if h.max.CompareAndSwap(cur, d) {
			break
		}
	}
	for i, edge := range latencyBucketsNs {
		if d <= edge {
			h.bucks[i].Add(1)
			return
		}
	}
	h.bucks[numBuckets-1].Add(1) // overflow
}

// percentile returns an APPROXIMATE percentile (0-100) from the cumulative
// bucket counts. The returned value is the upper edge of the bucket containing
// the requested percentile (a slight over-estimate), which is appropriate for
// "how bad is the tail" questions. Returns 0 if no observations.
func (h *Histogram) percentile(p float64) int64 {
	n := h.count.Load()
	if n == 0 {
		return 0
	}
	target := int64(p/100*float64(n) + 0.5)
	if target < 1 {
		target = 1
	}
	var cum int64
	for i, edge := range latencyBucketsNs {
		cum += h.bucks[i].Load()
		if cum >= target {
			return edge
		}
	}
	return overflowSentinelNs // overflow: return a large sentinel derived from the last real edge
}

// reset clears the histogram. Test-only.
func (h *Histogram) reset() {
	h.count.Store(0)
	h.sum.Store(0)
	h.min.Store(minUninitializedBit) // re-mark uninitialized so a 0 observation seeds cleanly
	h.max.Store(0)
	for i := range h.bucks {
		h.bucks[i].Store(0)
	}
}

// histogramSnapshot is the JSON-serialized view of a Histogram. All durations
// are in nanoseconds (so the consumer can format); p50/p95/p99 are approximate
// bucketed percentile upper edges.
type histogramSnapshot struct {
	Count int64   `json:"count"`
	Sum   int64   `json:"sum_ns"`
	Min   int64   `json:"min_ns"`
	Max   int64   `json:"max_ns"`
	P50   int64   `json:"p50_ns"`
	P95   int64   `json:"p95_ns"`
	P99   int64   `json:"p99_ns"`
	Avg   float64 `json:"avg_ns"`
}

func (h *Histogram) snapshot() histogramSnapshot {
	n := h.count.Load()
	s := histogramSnapshot{
		Count: n,
		Sum:   h.sum.Load(),
		Min:   h.min.Load(),
		Max:   h.max.Load(),
		P50:   h.percentile(50),
		P95:   h.percentile(95),
		P99:   h.percentile(99),
	}
	// If no observation was recorded, Min still carries the uninitialized
	// sentinel — collapse it to 0 on the read side so the JSON shape stays
	// clean (a fresh histogram reports min_ns=0).
	if s.Min&minUninitializedBit != 0 {
		s.Min = 0
	}
	if n > 0 {
		s.Avg = float64(s.Sum) / float64(n)
	}
	return s
}

// maxIncidents is the fixed cap of the slow-incident ring. Bounded so retention
// can never grow unbounded; the oldest incident is evicted when full.
const maxIncidents = 32

// Incident is one recorded slow-incident record. All fields are fixed-size
// numerics or short fixed-string enums — NO payloads, session IDs, URLs, or
// transcript content. At is a unix-nano wall clock for rough ordering; the
// Durations are in nanoseconds.
type Incident struct {
	At     int64  `json:"at_ns"`
	Kind   string `json:"kind"`             // short fixed label, e.g. "sse_write", "ws_writemsg"
	Bytes  uint64 `json:"bytes,omitempty"`  // bytes in the slow frame, if applicable
	Dur    int64  `json:"dur_ns"`           // total duration of the slow operation
	Detail int64  `json:"detail,omitempty"` // a secondary duration (e.g. mutex-wait) when relevant
	Aux    int64  `json:"aux,omitempty"`    // active-stream count or similar scalar sampled at the event
}

// IncidentRing is a fixed-capacity (maxIncidents) ring of recent slow
// incidents. Push acquires a scoped mutex — this is ONLY called when an
// observation exceeds a slow-incident threshold (rare), NEVER on the hot path.
// Snapshot copies the ring under the same lock.
type IncidentRing struct {
	mu  sync.Mutex
	buf [maxIncidents]Incident
	len int
	// head is the index of the newest entry (ring is newest-first in snapshot).
	head int
}

// Push appends an incident, evicting the oldest if full. Caller-supplied
// Incident is copied by value. NOT hot-path.
func (r *IncidentRing) Push(in Incident) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.len < maxIncidents {
		// not yet full: prepend into the logical newest slot
		r.head = (r.head + 1) % maxIncidents
		r.buf[r.head] = in
		r.len++
		return
	}
	// full: overwrite the oldest (head+1 in ring order), advance head
	r.head = (r.head + 1) % maxIncidents
	r.buf[r.head] = in
}

// Snapshot returns a newest-first copy of the ring. Empty if no incidents.
func (r *IncidentRing) Snapshot() []Incident {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.len == 0 {
		return nil
	}
	out := make([]Incident, r.len)
	for i := 0; i < r.len; i++ {
		idx := (r.head - i + maxIncidents) % maxIncidents
		out[i] = r.buf[idx]
	}
	return out
}

func (r *IncidentRing) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.len = 0
	r.head = 0
	for i := range r.buf {
		r.buf[i] = Incident{}
	}
}

// nowNano returns the current unix-nano timestamp. Centralized so tests can
// reason about it (it is just time.Now().UnixNano()).
func nowNano() int64 { return time.Now().UnixNano() }

// monoBase is captured once at package init via time.Now(), which records BOTH
// the wall-clock and monotonic clock readings. All latency-age measurements
// (ingest→emit, stream write ages) are derived from this base via monoNow(),
// which uses time.Since(monoBase) — Go's time.Since uses the monotonic component
// when the base time carries one, so the elapsed value is immune to wall-clock
// adjustments (NTP jumps, manual date changes, daylight-saving leaps). A
// wall-clock-only timestamp (time.Now().UnixNano()) would discard the monotonic
// component and could make recorded ages negative or falsely large when the
// system clock moves. See TestMonoAgeIgnoresWallClockJump for the regression.
var monoBase = time.Now()

// MonoNow returns monotonic-clock-derived nanoseconds elapsed since monoBase.
// The returned value is process-stable (always starts near 0 at process start
// and only ever increases with real elapsed time) and is used to stamp
// diagnostic-only ages (ingest timestamp, emit timestamp). It is NOT a wall-
// clock and MUST NOT be used for anything that needs absolute time ordering
// across processes; it is for measuring elapsed-within-this-process only.
func MonoNow() int64 { return int64(time.Since(monoBase)) }

// initSentinels marks every Histogram in the registry as "uninitialized min"
// by setting the minUninitializedBit on each one's min field. A zero-value
// Histogram has min=0 with no sentinel, which would let the CAS in Observe
// treat it as "already initialized with a 0 observation" — so a freshly
// constructed Registry MUST call this once before any Observe to make the
// first-observation seeding path work (see TestHistogramMinZeroObservation).
func (r *Registry) initSentinels() {
	mark := func(h *Histogram) { h.min.Store(minUninitializedBit) }
	mark(&r.Ingest.DispatchDur)
	mark(&r.Ingest.BytesHist)
	mark(&r.Emit.EmitAge)
	for i := range r.Stream {
		mark(&r.Stream[i].WriteDur)
		mark(&r.Stream[i].FlushDur)
		mark(&r.Stream[i].Interarrival)
		mark(&r.Stream[i].PingDur)
	}
	mark(&r.Yamux.OpenDur)
	for i := range r.Yamux.WriteByDir {
		mark(&r.Yamux.WriteByDir[i].Dur)
	}
	for i := range r.WSWrite {
		mark(&r.WSWrite[i].MutexWaitDur)
		mark(&r.WSWrite[i].WriteMsgDur)
		mark(&r.WSWrite[i].TotalDur)
		mark(&r.WSWrite[i].ActiveStreamsAtWrite)
	}
	for i := range r.Copy {
		mark(&r.Copy[i].Dur)
	}
}
