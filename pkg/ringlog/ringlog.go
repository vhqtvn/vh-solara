// Package ringlog provides a bounded byte ring buffer suitable for capturing a
// process's merged stdout/stderr tail. It is the shared backing store for
// process-log views across packages: procmgr managed processes, the OpenCode
// lifecycle diagnostics (pkg/oclife), and the worker's forthcoming
// /vh/opencode/logs endpoint.
//
// A Ring retains the last `cap` bytes appended. Reads return copies, so callers
// can hold slices safely across further appends. It is safe for concurrent use.
//
// This package is the lifted, exported form of what was previously a private
// logRing inside pkg/procmgr; the semantics are identical so the migration is
// behavior-preserving.
package ringlog

import (
	"io"
	"sync"
)

// DefaultCap is the default ring size: 256 KiB — enough for a substantial
// startup/error tail while bounding total memory across many rings (one per
// managed process + the OpenCode lifecycle).
const DefaultCap = 256 << 10

// Ring is a bounded byte ring retaining the last `cap` bytes appended to it.
type Ring struct {
	mu  sync.Mutex
	buf []byte
	cap int
}

// New returns a Ring that retains the last cap bytes. A non-positive cap is
// clamped to DefaultCap so a zero-value ("give me a ring") is always useful.
func New(cap int) *Ring {
	if cap <= 0 {
		cap = DefaultCap
	}
	return &Ring{cap: cap}
}

// Append appends s to the ring, evicting the oldest bytes once cap is exceeded.
func (r *Ring) Append(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, s...)
	if len(r.buf) > r.cap {
		r.buf = append([]byte(nil), r.buf[len(r.buf)-r.cap:]...)
	}
}

// Writer returns an io.Writer that appends raw bytes into the ring. It is the
// bridge for wiring a process's stdout/stderr (or an io.MultiWriter fan-out
// that also keeps the inherited sink) into the ring.
func (r *Ring) Writer() io.Writer { return &writer{ring: r} }

type writer struct{ ring *Ring }

func (w *writer) Write(b []byte) (int, error) {
	w.ring.Append(string(b))
	return len(b), nil
}

// Snapshot returns a full copy of the retained bytes.
func (r *Ring) Snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]byte, len(r.buf))
	copy(out, r.buf)
	return out
}

// Tail returns up to the last max bytes of the retained buffer. A non-positive
// max returns the whole retained buffer (a full snapshot copy).
func (r *Ring) Tail(max int) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	b := r.buf
	if max > 0 && len(b) > max {
		b = b[len(b)-max:]
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out
}
