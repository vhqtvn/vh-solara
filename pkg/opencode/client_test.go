package opencode

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
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

// messageStatusServer is an httptest server for the Message() method: it
// inspects GET /session/:sid/message/:mid and replies with the caller-supplied
// status + body, capturing the requested path for assertions.
func messageStatusServer(t *testing.T, status int, respBody string) (*httptest.Server, *string) {
	t.Helper()
	var gotPath string
	mux := http.NewServeMux()
	mux.HandleFunc("/session/", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if status == http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(respBody))
			return
		}
		http.Error(w, respBody, status)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &gotPath
}

// TestMessage200 verifies a successful exact-GET returns the raw body.
func TestMessage200(t *testing.T) {
	body := `{"info":{"id":"msg_abc","role":"user","sessionID":"s1"},"parts":[]}`
	srv, gotPath := messageStatusServer(t, http.StatusOK, body)
	c := New(srv.URL)

	got, err := c.Message(context.Background(), "s1", "msg_abc")
	if err != nil {
		t.Fatalf("Message: unexpected error: %v", err)
	}
	if string(got) != body {
		t.Fatalf("Message body mismatch:\n got %q\nwant %q", got, body)
	}
	if want := "/session/s1/message/msg_abc"; *gotPath != want {
		t.Fatalf("request path: got %q want %q", *gotPath, want)
	}
}

// TestMessage404 verifies a 404 maps to ErrMessageNotFound (the sentinel the
// reconciler uses to fail-closed on a definitive "not persisted" verdict).
func TestMessage404(t *testing.T) {
	srv, _ := messageStatusServer(t, http.StatusNotFound, "not found")
	c := New(srv.URL)

	_, err := c.Message(context.Background(), "s1", "msg_missing")
	if !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("want ErrMessageNotFound, got %v", err)
	}
}

// TestMessage400 verifies a 400 maps to an *Error{Status:400} (caller bug) the
// reconciler treats as immediate-terminal.
func TestMessage400(t *testing.T) {
	srv, _ := messageStatusServer(t, http.StatusBadRequest, "bad id")
	c := New(srv.URL)

	_, err := c.Message(context.Background(), "s1", "not-a-msg-id")
	var opErr *Error
	if !errors.As(err, &opErr) {
		t.Fatalf("want *Error, got %T %v", err, err)
	}
	if opErr.Status != http.StatusBadRequest {
		t.Fatalf("status: got %d want 400", opErr.Status)
	}
}

// TestMessage5xx verifies a 5xx maps to an *Error carrying the upstream status
// (the reconciler treats 5xx as retryable within its budget).
func TestMessage5xx(t *testing.T) {
	srv, _ := messageStatusServer(t, http.StatusInternalServerError, "boom")
	c := New(srv.URL)

	_, err := c.Message(context.Background(), "s1", "msg_x")
	var opErr *Error
	if !errors.As(err, &opErr) {
		t.Fatalf("want *Error, got %T %v", err, err)
	}
	if opErr.Status != http.StatusInternalServerError {
		t.Fatalf("status: got %d want 500", opErr.Status)
	}
	// A 5xx must NOT be mistaken for a 404.
	if errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("5xx must not satisfy ErrMessageNotFound")
	}
}

// TestMessagesTailNextCursor pins the has-older truthfulness contract at the
// transport seam: the tail GET (?limit=N, no before) carries X-Next-Cursor IFF
// more history exists beyond the window (upstream MessageV2.page computes
// more=rows.length>limit independent of `before` — message-v2.ts:457-465,
// handlers/session.ts:130-144, pinned by httpapi-session.test.ts:955-973), so
// MessagesTail must surface it as the authoritative exhaustion verdict:
// header present ⇒ nextCursor != "" (older exists); absent ⇒ "" (the tail IS
// the whole transcript).
func TestMessagesTailNextCursor(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/session/s1/message", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "2" {
			http.Error(w, "expected ?limit=2", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		// More-history case: 3 messages exist, window is the newest 2.
		w.Header().Set("X-Next-Cursor", "Y3Vyc29yLXRva2Vu")
		w.Write([]byte(`[{"info":{"id":"m2"}},{"info":{"id":"m3"}}]`))
	})
	mux.HandleFunc("/session/s2/message", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Exhausted case: everything fits in the window — NO header at all.
		w.Write([]byte(`[{"info":{"id":"only"}}]`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New(srv.URL)

	items, next, err := c.MessagesTail(context.Background(), "s1", 2)
	if err != nil {
		t.Fatalf("MessagesTail (more history): %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("items: want 2, got %d", len(items))
	}
	if next != "Y3Vyc29yLXRva2Vu" {
		t.Fatalf("nextCursor: want the X-Next-Cursor header value, got %q", next)
	}

	items2, next2, err := c.MessagesTail(context.Background(), "s2", 2)
	if err != nil {
		t.Fatalf("MessagesTail (exhausted): %v", err)
	}
	if len(items2) != 1 {
		t.Fatalf("items: want 1, got %d", len(items2))
	}
	if next2 != "" {
		t.Fatalf("nextCursor: want empty (no header — tail is the whole transcript), got %q", next2)
	}
}

// TestClientSetBaseURLConcurrent — P1-API-003: SetBaseURL retargets a Client
// that may be mid-request (the RUNNING daemon swaps the serve target after a
// fresh-port restart while the aggregator's fetches and reconnect loop keep
// issuing requests). Concurrent SetBaseURL + request traffic must be
// race-free (run under -race) and every request must land intact on ONE of
// the two targets — a torn base URL would fail to parse/dial and surface as
// a request error.
func TestClientSetBaseURLConcurrent(t *testing.T) {
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`)) // a valid empty session page for ListSessions
	}
	s1 := httptest.NewServer(http.HandlerFunc(handler))
	t.Cleanup(s1.Close)
	s2 := httptest.NewServer(http.HandlerFunc(handler))
	t.Cleanup(s2.Close)

	c := New(s1.URL)
	if got := c.BaseURL(); got != s1.URL {
		t.Fatalf("BaseURL: want %q, got %q", s1.URL, got)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})
	var reqErr atomic.Int64

	// Writers flip the target between the two servers.
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if i%2 == 0 {
					c.SetBaseURL(s1.URL)
				} else {
					c.SetBaseURL(s2.URL)
				}
			}
		}(i)
	}
	// Readers issue real requests; every one must succeed against one of the
	// two live targets.
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if _, err := c.ListSessions(context.Background()); err != nil {
					reqErr.Add(1)
				}
			}
		}()
	}

	time.Sleep(300 * time.Millisecond)
	close(stop)
	wg.Wait()

	if n := reqErr.Load(); n != 0 {
		t.Fatalf("%d concurrent requests failed while SetBaseURL raced them — a torn target escaped the guard", n)
	}
	// Trailing slash normalization survives the swap path too.
	c.SetBaseURL(s2.URL + "/")
	if got := c.BaseURL(); got != s2.URL {
		t.Fatalf("SetBaseURL must TrimRight('/'): want %q, got %q", s2.URL, got)
	}
}
