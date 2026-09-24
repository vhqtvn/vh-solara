package fixtures

// Regression test for the A2 cascade wedge (CI run 36042537218, lane 6):
//
// FakeOpenCode.emit closes a subscriber's bounded channel on overflow
// (close-on-full). handleEvent's receive loop never checked channel-closed, so
// after such a close the handler spun forever on zero-value receives, writing
// empty "data: \n\n" frames (and heartbeats) — the connection looked alive to
// pkg/opencode's idle-timeout client while delivering nothing, so the
// reconnect+rehydrate path never ran and every downstream spec saw a frozen
// store (55-failure cascade).
//
// This test pins the contract: once the subscriber channel is closed by
// overflow, the SSE handler MUST return (end the response → client EOF →
// reconnect).
//
// Determinism: the gateWriter blocks the handler inside its preamble write, so
// the handler provably cannot drain its channel while the test overflows it —
// no timing race between emit and the receive loop.

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// gateWriter is an http.ResponseWriter whose Write blocks until gate is
// closed. Flush is a no-op; Header is a plain map (never read by the test).
type gateWriter struct {
	h    http.Header
	gate chan struct{}
}

func (w *gateWriter) Header() http.Header { return w.h }
func (w *gateWriter) WriteHeader(int)     {}
func (w *gateWriter) Write(p []byte) (int, error) {
	<-w.gate
	return len(p), nil
}
func (w *gateWriter) Flush() {}

func TestEventStreamHandlerReturnsAfterOverflowClose(t *testing.T) {
	f := New()
	gate := make(chan struct{})
	w := &gateWriter{h: make(http.Header), gate: gate}
	r := httptest.NewRequest(http.MethodGet, "/event", nil)

	done := make(chan struct{})
	go func() {
		f.handleEvent(w, r)
		close(done)
	}()

	// Wait until the handler has subscribed and is blocked in its preamble
	// write (subscribe happens before the first write).
	for deadline := time.Now().Add(2 * time.Second); f.ActiveEventSubs() == 0; {
		if time.Now().After(deadline) {
			t.Fatal("handler never subscribed to the event bus")
		}
		time.Sleep(2 * time.Millisecond)
	}

	// Overflow the 64-cap subscriber channel while the handler cannot drain
	// (blocked in the preamble write). The 65th emit takes emit's
	// close-on-full path: counted drop + channel close + unsubscribe.
	for i := 0; i < 70; i++ {
		f.emit("server.heartbeat", map[string]any{})
	}
	if dropped := atomic.LoadUint64(&f.emitDroppedTotal); dropped == 0 {
		t.Fatalf("expected overflow drops on the subscriber channel, got %d", dropped)
	}

	// Release the writer: the handler drains the 64 buffered payloads, then
	// observes the closed channel. It MUST return — pre-fix it spun forever
	// on zero-value receives, which is the permanent wedge.
	close(gate)
	select {
	case <-done:
		// green: handler ended the SSE response after the overflow close
	case <-time.After(5 * time.Second):
		t.Fatal("handleEvent did not return after its subscriber channel was closed by overflow — the SSE handler spins on the closed channel (A2 cascade wedge, CI run 36042537218)")
	}
}
