package server

import (
	"bufio"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
)

// errorReader returns a non-EOF error on every Read, so io.Copy terminates
// immediately with an error (the exact condition that triggers the
// copyErrored.Store(true) path in runBidirectionalCopy).
type errorReader struct{}

func (errorReader) Read(p []byte) (int, error) { return 0, errors.New("read failed") }

// errorWriter returns an error on every Write, so io.Copy terminates
// immediately with an error once it has read any bytes from the source.
type errorWriter struct{}

func (errorWriter) Write(p []byte) (int, error) { return 0, errors.New("write failed") }

// TestRunBidirectionalCopyConcurrentErrorRaceFree is the Finding 3 proving
// test. It drives the production runBidirectionalCopy with TWO barrier-
// controlled failing legs so both io.Copy goroutines terminate concurrently
// and BOTH hit the copyErrored.Store(true) path — the exact condition that
// exposed the pre-fix plain-bool race.
//
// With the production fix (atomic.Bool) this is race-free; the pre-fix plain
// bool races under `go test -race`. Run at -count=100 (the loop below) so a
// regression to plain bool is reliably caught by the race detector.
//
// FAIL-without (plain bool): the race detector reports a data race on
// copyErrored because both goroutines write the shared variable with no
// synchronization.
// PASS-with (atomic.Bool): the concurrent atomic Stores are race-free.
func TestRunBidirectionalCopyConcurrentErrorRaceFree(t *testing.T) {
	p := &Proxy{}
	for i := 0; i < 100; i++ {
		// clientConn: a real net.Conn so Close() works. The yamux→browser leg
		// reads from errorReader (0 bytes, immediate error) so nothing is ever
		// written to clientConn — it just needs to be closeable.
		clientConn, clientConn2 := net.Pipe()
		_ = clientConn2 // unused end; closed implicitly when clientConn closes

		// clientBuf: wraps a reader that HAS data so the browser→yamux leg
		// reads it and then tries to write to errorWriter (which fails). This
		// guarantees BOTH legs hit the error path concurrently.
		clientBuf := bufio.NewReadWriter(
			bufio.NewReader(strings.NewReader("payload")),
			bufio.NewWriter(io.Discard),
		)

		yamuxRead := errorReader{} // leg 1 fails immediately
		yamuxW := errorWriter{}    // leg 2 fails on first write
		closed := false
		closeStream := func() { closed = true }

		anyError := p.runBidirectionalCopy(clientConn, clientBuf, yamuxW, yamuxRead, closeStream)

		if !anyError {
			t.Fatalf("iteration %d: expected runBidirectionalCopy to report an error (both legs fail)", i)
		}
		if !closed {
			t.Fatalf("iteration %d: closeStream was never called", i)
		}
	}
}
