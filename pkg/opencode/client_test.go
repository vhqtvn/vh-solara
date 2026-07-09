package opencode

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// silentEventServer accepts the /event subscription (HTTP 200 + headers) and
// then holds the connection open without ever sending a body byte — the
// dead-but-open condition (half-open TCP / stalled peer). It returns when the
// client disconnects (the caller closing resp.Body on idle/cancel), so test
// teardown is clean.
func silentEventServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/event", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// withIdleTimeout temporarily overrides the package-level idleTimeout for a
// test (SubscribeEvents's stall detector) and restores it on cleanup. Tests in
// this package are not run in parallel.
func withIdleTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	prev := idleTimeout
	idleTimeout = d
	t.Cleanup(func() { idleTimeout = prev })
}

// TestSubscribeEventsDeadButOpen is the regression test for the silent-freeze
// bug: when OpenCode's SSE connection goes half-open (accepts the subscription
// then sends nothing), SubscribeEvents must return within ~idleTimeout+slack
// instead of blocking forever. Returning an error is exactly the trigger the
// aggregator's reconnect loop needs; a hang here means dead live updates.
func TestSubscribeEventsDeadButOpen(t *testing.T) {
	withIdleTimeout(t, 120*time.Millisecond)
	srv := silentEventServer(t)
	c := New(srv.URL)

	start := time.Now()
	err := c.SubscribeEvents(context.Background(), func(Event) error { return nil })
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected idle-timeout error on dead-but-open stream, got nil")
	}
	// Must NOT hang: return within a generous slack of the idle timeout.
	if elapsed > 2*time.Second {
		t.Fatalf("SubscribeEvents took too long to detect dead stream: %v (want ~%v)", elapsed, idleTimeout)
	}
	// And must not return faster than the idle timeout itself.
	if elapsed < idleTimeout {
		t.Fatalf("returned faster than idleTimeout: %v < %v", elapsed, idleTimeout)
	}
}

// TestSubscribeEventsHappyPath verifies a normally-sent SSE data frame is
// parsed and dispatched to the handler.
func TestSubscribeEventsHappyPath(t *testing.T) {
	withIdleTimeout(t, 5*time.Second)
	mux := http.NewServeMux()
	mux.HandleFunc("/event", func(w http.ResponseWriter, r *http.Request) {
		fl, _ := w.(http.Flusher)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"server.heartbeat\",\"properties\":{}}\n\n")
		if fl != nil {
			fl.Flush()
		}
		// Hold the connection so the client doesn't see an immediate EOF
		// racing the event read; it unblocks when the client disconnects.
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	c := New(srv.URL)
	got := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := c.SubscribeEvents(ctx, func(ev Event) error {
		select {
		case got <- ev.Type:
		default:
		}
		cancel() // received one event; end the subscription
		return nil
	})

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled after handler-initiated cancel, got %v", err)
	}
	select {
	case ev := <-got:
		if ev != "server.heartbeat" {
			t.Fatalf("want dispatched event server.heartbeat, got %q", ev)
		}
	default:
		t.Fatal("no event dispatched to handler")
	}
}

// TestSubscribeEventsCtxCancel verifies that cancelling the context while the
// read is blocked on a silent server returns promptly with ctx.Err() — the
// pre-fix code's `select { default: }` outside the blocking read could not do
// this on an idle stream.
func TestSubscribeEventsCtxCancel(t *testing.T) {
	// Long idle timeout: the context cancel must win, not the idle timer.
	withIdleTimeout(t, 30*time.Second)
	srv := silentEventServer(t)
	c := New(srv.URL)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(80 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	err := c.SubscribeEvents(ctx, func(Event) error { return nil })
	elapsed := time.Since(start)

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("SubscribeEvents took too long to honor ctx cancel: %v", elapsed)
	}
}
