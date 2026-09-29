package e2e

// fleet_stream_e2e_test.go — lane-3 proof for GET /vh/fleet/stream (Slice 1
// of tmp/agent-runs/android-push-20260928/stream-readstate-brief.md).
//
// This drives the SSE surface through the SHARED pattern's REAL stack end to
// end: held HTTP connection → controller user edge (userMux + hostInterceptor
// carve-out under a per-worker-subdomain Host) → fleet-status service →
// bootstrap generation built through Proxy.FetchWorkerJSONBounded → real
// yamux tunnel → the worker's real pkg/web server — then a second full
// snapshot after a real generation change (TTL expiry + one plain GET forces
// the next publication, whose wake pushes the frame down the open stream).
//
// A 200 text/event-stream response is also the lane-3 proof that the real
// middleware chain preserves write-deadline control (the handler refuses to
// stream — 503 — when http.ResponseController cannot enforce finite write
// deadlines; scs's session wrapper implements Unwrap, so the controller
// reaches the connection).
//
// The lane-1 suite (pkg/server/status_stream_test.go) pins the protocol and
// service invariants with the acquisition seam faked; the demand-refresh
// loop's cadence is proven there with tightened intervals and is not re-waited
// (15s) here.

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// streamFrame is one parsed SSE block.
type streamFrame struct {
	event string
	data  string
	raw   string
}

// openE2EStream connects one watchdog-bounded stream client to the cluster's
// controller edge. host may override the request Host (worker-subdomain
// carve-out proof).
func openE2EStream(c *Cluster, t *testing.T, host string) (<-chan streamFrame, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.ControllerURL+"/vh/fleet/stream", nil)
	if err != nil {
		cancel()
		t.Fatalf("stream request: %v", err)
	}
	if host != "" {
		req.Host = host
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("stream connect: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		cancel()
		t.Fatalf("stream connect: want 200, got %d: %s", resp.StatusCode, b)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		resp.Body.Close()
		cancel()
		t.Fatalf("stream Content-Type: want text/event-stream, got %q", ct)
	}
	frames := make(chan streamFrame, 64)
	go func() {
		defer close(frames)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
			if atEOF && len(data) == 0 {
				return 0, nil, nil
			}
			if i := strings.Index(string(data), "\n\n"); i >= 0 {
				return i + 2, data[:i], nil
			}
			if atEOF {
				return len(data), data, nil
			}
			return 0, nil, nil
		})
		for sc.Scan() {
			block := sc.Text()
			if block == "" {
				continue
			}
			var f streamFrame
			f.raw = block
			for _, ln := range strings.Split(block, "\n") {
				if e, ok := strings.CutPrefix(ln, "event: "); ok {
					f.event = e
				}
				if d, ok := strings.CutPrefix(ln, "data: "); ok {
					f.data = d
				}
			}
			select {
			case frames <- f:
			case <-ctx.Done():
				return
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		for range frames { // drain until the reader exits
		}
	})
	return frames, cancel
}

// nextE2EFrame waits for one frame with a hard watchdog.
func nextE2EFrame(t *testing.T, frames <-chan streamFrame, what string, timeout time.Duration) streamFrame {
	t.Helper()
	select {
	case f, ok := <-frames:
		if !ok {
			t.Fatalf("stream ended while waiting for %s", what)
		}
		return f
	case <-time.After(timeout):
		t.Fatalf("timed out (%s) waiting for %s", timeout, what)
	}
	return streamFrame{}
}

// TestE2E_FleetStreamThroughRealStack is the lane-3 crux: the controller
// serves the stream under a WORKER SUBDOMAIN host (carve-out; a proxied
// request would 502), the bootstrap frame is a real-tunnel rollup, and a
// real generation change pushes a subsequent full snapshot down the already
// open connection.
func TestE2E_FleetStreamThroughRealStack(t *testing.T) {
	c, err := StartClusterWithOptions(WithHostPattern("$ID.stream.example"))
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	t.Cleanup(c.Close)

	// Method posture over real HTTP: GET-only (the mux's 405 for POST).
	resp405, body405, err := c.Do(http.MethodPost, "/vh/fleet/stream", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp405.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST /vh/fleet/stream: want 405, got %d: %s", resp405.StatusCode, body405)
	}

	// Open the stream with the WORKER-SUBDOMAIN Host: the hostInterceptor
	// carve-out must keep it on the controller (a proxied stream would die
	// with 502 on the raw tunnel path).
	frames, _ := openE2EStream(c, t, c.WorkerID+".stream.example")

	// First block: the reconnect hint.
	if f := nextE2EFrame(t, frames, "retry preamble", 10*time.Second); f.raw != "retry: 2000" {
		t.Fatalf("first block: want %q, got %q", "retry: 2000", f.raw)
	}

	// Bootstrap frame: a full rollup whose worker observation came through
	// the REAL tunnel (worker `ok`, complete coverage in a one-worker
	// discovered fleet).
	boot := nextE2EFrame(t, frames, "bootstrap fleet.status", 10*time.Second)
	if boot.event != "fleet.status" {
		t.Fatalf("bootstrap event: want fleet.status, got %q", boot.event)
	}
	var rollup struct {
		Schema  int    `json:"schema"`
		Overall string `json:"overall"`
		Workers []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"workers"`
		Coverage struct {
			Complete bool `json:"complete"`
		} `json:"coverage"`
		GeneratedAt string `json:"generated_at"`
	}
	if err := json.Unmarshal([]byte(boot.data), &rollup); err != nil {
		t.Fatalf("bootstrap frame is not the rollup JSON: %v (%s)", err, boot.data)
	}
	if rollup.Schema != 1 {
		t.Fatalf("bootstrap schema: want 1, got %d", rollup.Schema)
	}
	if len(rollup.Workers) != 1 || rollup.Workers[0].ID != c.WorkerID || rollup.Workers[0].Status != "ok" {
		t.Fatalf("bootstrap workers: want exactly [%s ok] through the real tunnel, got %+v", c.WorkerID, rollup.Workers)
	}
	if !rollup.Coverage.Complete {
		t.Fatalf("bootstrap coverage must be complete for the one real worker, got %+v", rollup.Coverage)
	}

	// Subsequent full snapshot: cross the generation TTL (default 5s), then
	// one plain GET forces the next publication — its subscriber wake must
	// push the NEW full snapshot down the already-open stream without any
	// reconnect.
	time.Sleep(5500 * time.Millisecond) // just past the 5s generation TTL
	respGET, bodyGET, err := c.Do(http.MethodGet, "/vh/fleet/status", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if respGET.StatusCode != http.StatusOK {
		t.Fatalf("trigger GET: want 200, got %d: %s", respGET.StatusCode, bodyGET)
	}

	// Read frames until one differs from the bootstrap (a demand tick racing
	// the GET's publication is fine — any newer generation proves the push).
	deadline := time.Now().Add(10 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatal("no subsequent fleet.status frame arrived within 10s of the generation change")
		}
		f := nextE2EFrame(t, frames, "subsequent fleet.status", time.Until(deadline))
		if f.event != "fleet.status" {
			continue // a ping or coalesced wake in between
		}
		if f.data == boot.data {
			continue // same generation re-sent (coalesced wake) — keep reading
		}
		var next struct {
			Schema      int    `json:"schema"`
			GeneratedAt string `json:"generated_at"`
		}
		if err := json.Unmarshal([]byte(f.data), &next); err != nil || next.Schema != 1 {
			t.Fatalf("subsequent frame is not a schema-1 rollup: %v (%s)", err, f.data)
		}
		t.Logf("subsequent snapshot pushed: generated_at %s -> %s", rollup.GeneratedAt, next.GeneratedAt)
		break
	}
}
