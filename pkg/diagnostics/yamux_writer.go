package diagnostics

import (
	"io"
	"time"

	"github.com/hashicorp/yamux"
)

// YamuxWriteMonitor wraps an io.Writer (a *yamux.Stream used as a write
// destination) and times each Write, recording per-write duration into the
// direction-specific YamuxWriteStats for Probe 4 (yamux stream-write
// pressure). Each Write produces a single atomic-bucket observation; the only
// lock is the scoped IncidentRing append on a slow write (rare — only when the
// write exceeds SlowStreamWriteNs).
//
// Finding 1: the monitor is direction-aware. The SAME monitor type is used on
// BOTH yamux write legs:
//
//   - worker local-service → yamux.Stream (pkg/agent/daemon.go handleRawProxy)
//     — direction YamuxWriteResponse. This is the PRIMARY egress signal: it is
//     where yamux flow-control / send-window backpressure accumulates.
//   - controller browser → yamux.Stream (pkg/server/proxy.go handleRawProxy)
//     — direction YamuxWriteRequest. Preserved as the request-egress signal.
//
// yamux.Stream does NOT implement io.WriterTo or io.ReaderFrom (verified via
// `go doc`), so wrapping it does NOT change io.Copy's code path: io.Copy keeps
// using its generic buffered copy loop either way. Wrapping is therefore a
// pure observation with no behavior change to the copy mechanism.
type YamuxWriteMonitor struct {
	W    io.Writer
	dir  int
	sess *yamux.Session // optional, for per-incident NumStreams() sampling
}

// NewYamuxWriteMonitor wraps w (typically a *yamux.Stream) for Probe 4 timing
// in the given direction (YamuxWriteResponse or YamuxWriteRequest). Use
// WithSession to attach a yamux.Session for per-incident NumStreams sampling.
func NewYamuxWriteMonitor(w io.Writer, dir int) *YamuxWriteMonitor {
	if dir < 0 || dir >= numYamuxWriteDirs {
		dir = YamuxWriteResponse // safe default — never panic on a bad dir
	}
	return &YamuxWriteMonitor{W: w, dir: dir}
}

// WithSession attaches the yamux.Session the wrapped stream belongs to so a
// slow-write incident can sample THAT session's NumStreams() for per-session
// correlation. Without this, the incident's Aux field is 0. This is the
// per-session correlation channel for the "additional concern": the global
// ActiveStreams gauge is now a true inc/dec counter (no longer a per-session
// sample), so the per-session signal rides on each incident instead.
func (m *YamuxWriteMonitor) WithSession(s *yamux.Session) *YamuxWriteMonitor {
	m.sess = s
	return m
}

// Write times the underlying Write and records it into the direction-specific
// YamuxWriteStats. On a slow write it samples THIS monitor's session
// (if attached) NumStreams() into the incident's Aux field so the operator
// can see "slow write while N streams were active IN THIS SESSION" — the
// per-session correlation survives a multi-worker controller (where the global
// ActiveStreams gauge would otherwise be the last-sampled worker's count).
func (m *YamuxWriteMonitor) Write(p []byte) (int, error) {
	start := time.Now()
	n, err := m.W.Write(p)
	durNs := int64(time.Since(start))

	y := &Default.Yamux
	wd := &y.WriteByDir[m.dir]
	wd.Bytes.Add(uint64(n))
	if err == nil {
		wd.Dur.Observe(durNs)
		if durNs >= SlowStreamWriteNs {
			wd.SlowWrites.Inc()
			var aux int64
			if m.sess != nil {
				aux = int64(m.sess.NumStreams())
			}
			wd.SlowWriteIncidents.Push(Incident{
				At:    start.UnixNano(),
				Kind:  "yamux_stream_write",
				Bytes: uint64(n),
				Dur:   durNs,
				Aux:   aux,
			})
		}
	}
	return n, err
}
