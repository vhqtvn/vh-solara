package web

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// F3 (remote-latency brief, 2026-10-12) — reconnect-storm damping, server
// side: the SSE hello frame's `retry:` hint is JITTERED per connection. The
// fixed `retry: 2000` made every pane's EventSource retry in lockstep during
// tunnel-down windows (2,254 controller-side rejections, 11.3% of stream
// opens in a ~2.9h snapshot). Jitter spreads the fleet's reconnect attempts
// across [base, base+jitter).
func TestSSERetryHintBounds(t *testing.T) {
	distinct := map[int]bool{}
	for i := 0; i < 2000; i++ {
		v := sseRetryHintMs()
		if v < sseRetryBaseMs || v >= sseRetryBaseMs+sseRetryJitterMs {
			t.Fatalf("sseRetryHintMs() = %d, want [%d, %d)", v, sseRetryBaseMs, sseRetryBaseMs+sseRetryJitterMs)
		}
		distinct[v] = true
	}
	// The jitter must actually vary: 2000 draws over a 1000-value range should
	// produce far more than one distinct value (guards against a regression to
	// a fixed constant — the lockstep storm this fix exists to break).
	if len(distinct) < 100 {
		t.Fatalf("sseRetryHintMs() barely varies: %d distinct values in 2000 draws — jitter regressed to a constant?", len(distinct))
	}
}

// TestStreamHelloCarriesJitteredRetry drives the REAL /vh/stream handler and
// asserts the first flushed frame is a hello comment carrying an in-bounds
// retry hint — the wire shape the browser's native EventSource consumes.
func TestStreamHelloCarriesJitteredRetry(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	defer oc.Close()
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	retryRe := regexp.MustCompile(`(?m)^retry: (\d+)$`)
	seen := map[int]bool{}
	for i := 0; i < 8; i++ {
		res, err := http.Get(web.URL + "/vh/stream")
		if err != nil {
			t.Fatalf("stream %d: %v", i, err)
		}
		br := bufio.NewReader(res.Body)
		hello, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("stream %d: read hello line: %v", i, err)
		}
		if hello != ": hello\n" {
			t.Fatalf("stream %d: first frame = %q, want \": hello\\n\"", i, hello)
		}
		retryLine, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("stream %d: read retry line: %v", i, err)
		}
		m := retryRe.FindStringSubmatch(retryLine)
		if m == nil {
			t.Fatalf("stream %d: retry line = %q, want \"retry: <ms>\"", i, retryLine)
		}
		v, err := strconv.Atoi(m[1])
		if err != nil {
			t.Fatalf("stream %d: retry value %q: %v", i, m[1], err)
		}
		if v < sseRetryBaseMs || v >= sseRetryBaseMs+sseRetryJitterMs {
			t.Fatalf("stream %d: advertised retry %d outside [%d, %d)", i, v, sseRetryBaseMs, sseRetryBaseMs+sseRetryJitterMs)
		}
		seen[v] = true
		res.Body.Close()
	}
	// With 8 draws over a 1000-value range this is probabilistic, but P(all 8
	// identical) ≈ 1000^-7 — effectively zero; a single distinct value means
	// the jitter never reached the wire.
	if len(seen) < 2 {
		t.Fatalf("8 stream opens advertised a single retry value (%v) — per-connection jitter not on the wire", seen)
	}
}
