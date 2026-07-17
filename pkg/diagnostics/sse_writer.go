package diagnostics

import (
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// ClassifyEmitKind collapses a wire event kind into one of the fixed EmitClass
// values, keeping Probe 2's cardinality bounded regardless of how many
// distinct event types OpenCode introduces. Pure function; no allocation.
func ClassifyEmitKind(kind string) int {
	switch {
	case kind == "notice",
		strings.HasPrefix(kind, "session."),
		kind == "status",
		strings.HasPrefix(kind, "activity."),
		strings.HasPrefix(kind, "permission."),
		strings.HasPrefix(kind, "question."):
		return EmitClassStructural
	case strings.HasPrefix(kind, "messages."):
		return EmitClassMessagesBatch
	case strings.HasPrefix(kind, "message."):
		return EmitClassMessage
	case strings.HasPrefix(kind, "part."):
		return EmitClassPart
	default:
		return EmitClassOther
	}
}

// ClassifyStream derives the SSE stream class from the handleStream message
// filter: nil → firehose, empty → tree, non-empty → selected. The same logic
// pkg/web/server.go uses to choose the store Interest.
func ClassifyStream(filter map[string]bool) int {
	if filter == nil {
		return StreamClassFirehose
	}
	if len(filter) == 0 {
		return StreamClassTree
	}
	return StreamClassSelected
}

// StreamStatsWriter wraps an http.ResponseWriter to count bytes/writes/flushes
// and time them, preserving the http.Flusher interface the /vh/stream handler
// relies on. Per-call timing is pure atomics into the per-class accumulator
// (Default.Stream[class]); the only lock anywhere in Probe 3 is the scoped
// IncidentRing append, which fires ONLY when slowSSEWriteNs/slowSSEFlushNs is
// crossed — never on the hot path.
//
// IMPORTANT CAVEAT (recorded in comments here and at the call site): a
// successful ResponseWriter.Write only means the bytes reached the local
// kernel TCP send buffer. It does NOT mean they reached the browser. On the
// controller topology, the SSE bytes produced here are then re-read by the
// controller's io.Copy (Probe 6) and written into a yamux stream (Probe 4) and
// then the underlying tunnel WebSocket (Probe 5). So a healthy WriteDur here
// with a slow browser arrival must be attributed downstream — correlate with
// yamux WriteDur (Probe 4), wsWrite TotalDur (Probe 5), and copy Dur (Probe 6).
type StreamStatsWriter struct {
	http.ResponseWriter
	flusher http.Flusher
	stats   *StreamStats
	// lastWriteNano is the unix-nano of the previous Write on THIS connection,
	// for inter-arrival gap. atomic so the (single-threaded handler) write loop
	// stays consistent if a future flush-goroutine ever touches it.
	lastWriteNano atomic.Int64
}

// NewStreamStatsWriter wraps rw. The caller should re-derive any needed
// http.Flusher from the returned value (it implements http.Flusher). The class
// must be one of the StreamClass constants (use ClassifyStream).
func NewStreamStatsWriter(rw http.ResponseWriter, class int) *StreamStatsWriter {
	flusher, _ := rw.(http.Flusher)
	return &StreamStatsWriter{
		ResponseWriter: rw,
		flusher:        flusher,
		stats:          &Default.Stream[class],
	}
}

func (s *StreamStatsWriter) Write(p []byte) (int, error) {
	start := time.Now()
	n, err := s.ResponseWriter.Write(p)
	dur := time.Since(start)
	durNs := int64(dur)

	s.stats.Bytes.Add(uint64(n))
	s.stats.Writes.Inc()
	s.stats.WriteDur.Observe(durNs)

	// inter-arrival gap (per-connection)
	nowNs := start.UnixNano()
	prev := s.lastWriteNano.Swap(nowNs)
	if prev > 0 {
		s.stats.Interarrival.Observe(nowNs - prev)
	}

	if err != nil {
		s.stats.WriteErrors.Inc()
	} else if durNs >= slowSSEWriteNs {
		// rare slow-incident capture (scoped mutex only here, not the hot path)
		s.stats.SlowWrites.Push(Incident{
			At:    nowNs,
			Kind:  "sse_write",
			Bytes: uint64(n),
			Dur:   durNs,
		})
	}
	return n, err
}

// Flush times the underlying Flush call. If the wrapped ResponseWriter does not
// implement http.Flusher, this is a no-op (the handler already verified
// http.Flusher support at entry, so this branch is defensive only).
func (s *StreamStatsWriter) Flush() {
	if s.flusher == nil {
		return
	}
	start := time.Now()
	s.flusher.Flush()
	durNs := int64(time.Since(start))
	s.stats.Flushes.Inc()
	s.stats.FlushDur.Observe(durNs)
	if durNs >= slowSSEFlushNs {
		s.stats.SlowFlushes.Push(Incident{
			At:   start.UnixNano(),
			Kind: "sse_flush",
			Dur:  durNs,
		})
	}
}

// RecordOpen notes that a stream of this class opened. Called by the handler
// at entry.
func (s *StreamStatsWriter) RecordOpen() {
	s.stats.Opens.Inc()
}

// RecordPing records a ping Write+Flush combined duration (the delayed-ping
// sentinel of Probe 3). Called by the handler around the ping write+flush
// pair; ping frequency is UNCHANGED.
func (s *StreamStatsWriter) RecordPing(dur time.Duration) {
	s.stats.PingDur.Observe(int64(dur))
}

// RecordSnapshotPath notes which baseline branch handleStream took and the
// snapshot wire bytes (the maybeCompressSnapshot'd payload written).
func (s *StreamStatsWriter) RecordSnapshotPath(wireBytes int) {
	s.stats.SnapshotPath.Inc()
	s.stats.SnapshotBytes.Add(uint64(wireBytes))
}

// RecordReplayPath notes that handleStream took the cursor-replay branch.
func (s *StreamStatsWriter) RecordReplayPath() {
	s.stats.ReplayPath.Inc()
}

// RecordDisconnect notes why the stream ended. Called by the handler at each
// return point (or via defer).
func (s *StreamStatsWriter) RecordDisconnect(reason int) {
	if reason < 0 || reason >= numDiscReasons {
		return
	}
	s.stats.DiscReason[reason].Inc()
}
