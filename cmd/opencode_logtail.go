package cmd

import (
	"io"
	"os"
	"sync"
	"time"
)

// Detached-OpenCode log follower.
//
// INCIDENT (2026-10-02, BaSon): the detached child's stdout/stderr used to be
// an io.MultiWriter(disk log, lifecycle ring) — which exec realizes as a PIPE
// read by a copy goroutine in the daemon. The child survives a daemon restart
// by design, but the pipe's read end dies with the daemon: every later write
// hits EPIPE, the disk log freezes at the restart, and the reattached daemon
// seeds its ring from a file that no longer grows.
//
// The child now writes the disk log file DIRECTLY (a real fd that outlives the
// daemon), and the ring is fed by tailing that file. One follower per log
// path: a new follow (spawn, restart respawn, reattach) takes over from the
// previous one at its read offset, so the ring never sees a byte twice across
// a restart overlap and never misses the bytes in between.

var (
	ocLogTailPoll = 500 * time.Millisecond
	// ocLogTailMaxChunk bounds one read so a burst (or a huge backlog after a
	// takeover) is fed to the ring in pieces instead of one giant Append.
	ocLogTailMaxChunk = 64 << 10
)

type ocLogFollower struct {
	stop  chan struct{}
	done  chan struct{}
	flush chan chan struct{}
	off   int64 // guarded by ocLogTails.mu once the follower has stopped
}

var ocLogTails = struct {
	mu  sync.Mutex
	cur map[string]*ocLogFollower
}{cur: map[string]*ocLogFollower{}}

// followDetachedLog feeds bytes appended to path after offset `from` into w,
// until pid exits (and its final output is drained) or a later follow on the
// same path supersedes this one. A superseding follow resumes from where the
// previous follower stopped instead of `from`. w == nil is a no-op.
func followDetachedLog(path string, pid int, from int64, w io.Writer) {
	if w == nil {
		return
	}
	ocLogTails.mu.Lock()
	if prev := ocLogTails.cur[path]; prev != nil {
		close(prev.stop)
		ocLogTails.mu.Unlock()
		<-prev.done
		ocLogTails.mu.Lock()
		from = prev.off
	}
	f := &ocLogFollower{stop: make(chan struct{}), done: make(chan struct{}), flush: make(chan chan struct{}), off: from}
	ocLogTails.cur[path] = f
	poll := ocLogTailPoll
	ocLogTails.mu.Unlock()
	go f.run(path, pid, w, poll)
}

// flushDetachedLog synchronously drains path's current follower (if any), so
// a caller about to report "ready" has everything the child printed so far
// in the ring. Bounded: a follower that cannot answer is not waited out.
func flushDetachedLog(path string) {
	ocLogTails.mu.Lock()
	f := ocLogTails.cur[path]
	ocLogTails.mu.Unlock()
	if f == nil {
		return
	}
	ack := make(chan struct{})
	timeout := time.NewTimer(2 * time.Second)
	defer timeout.Stop()
	select {
	case f.flush <- ack:
	case <-f.done:
		return
	case <-timeout.C:
		return
	}
	select {
	case <-ack:
	case <-timeout.C:
	}
}

func (f *ocLogFollower) run(path string, pid int, w io.Writer, poll time.Duration) {
	defer close(f.done)
	buf := make([]byte, ocLogTailMaxChunk)
	off := f.off
	defer func() {
		ocLogTails.mu.Lock()
		f.off = off
		if ocLogTails.cur[path] == f {
			delete(ocLogTails.cur, path)
		}
		ocLogTails.mu.Unlock()
	}()
	t := time.NewTicker(poll)
	defer t.Stop()
	var ack chan struct{}
	for {
		// Sample liveness BEFORE draining, so output written just before the
		// child exited is still delivered on the final pass.
		alive := ocProcessAlive(pid)
		off = drainLog(path, off, buf, w)
		if ack != nil {
			close(ack)
			ack = nil
		}
		if !alive {
			return
		}
		select {
		case <-f.stop:
			return
		case ack = <-f.flush:
		case <-t.C:
		}
	}
}

// drainLog copies path[off:EOF] into w and returns the new offset. A file
// shorter than off was truncated/replaced: restart from 0. Errors are
// non-fatal (missing file, transient read error) — the next poll retries.
func drainLog(path string, off int64, buf []byte, w io.Writer) int64 {
	fh, err := os.Open(path)
	if err != nil {
		return off
	}
	defer fh.Close()
	if st, err := fh.Stat(); err == nil && st.Size() < off {
		off = 0
	}
	if _, err := fh.Seek(off, io.SeekStart); err != nil {
		return off
	}
	for {
		n, err := fh.Read(buf)
		if n > 0 {
			_, _ = w.Write(buf[:n])
			off += int64(n)
		}
		if err != nil || n == 0 {
			return off
		}
	}
}

// logSize is the current size of path, 0 when absent.
func logSize(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.Size()
}
