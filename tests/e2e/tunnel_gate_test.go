package e2e

// TestTunnelGateScaling is a MEASUREMENT probe (read-only on the live stack;
// it does not assert correctness thresholds). It scales the fake-opencode
// fixture's session count to reproduce the large-dir detail-snapshot payload,
// then measures the cold Stream-1 detail-bootstrap wall-clock + bytes:
//   - worker-direct   : GET {WorkerVHURL}/vh/stream?dir=...         (loopback, no tunnel)
//   - through-tunnel  : GET {ControllerURL}/api/workers/{id}/events  (real controller→yamux→worker)
// and captures /vh/diag/latency yamux setup/open/write/ack durations to isolate
// mux-mechanics from compute/serialization.
//
// Skipped unless VH_TUNNEL_GATE=1 (long-running; measurement-only).
//
// LOOPBACK CAVEAT (encoded in tunnel-gate.md): in-process e2e runs the yamux
// tunnel over loopback (near-zero RTT, huge bandwidth), so it UNDER-REPRESENTS
// production-network throughput. A slow-on-loopback result implicates
// compute/serialization/mux; a fast-on-loopback result does NOT exonerate the
// tunnel for a constrained production network.

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestTunnelGateScaling(t *testing.T) {
	if os.Getenv("VH_TUNNEL_GATE") == "" {
		t.Skip("set VH_TUNNEL_GATE=1 to run the tunnel-gate measurement probe")
	}
	const dir = "/work/demo" // fixtures.DemoDir() default

	// Scaling sweep. FRESH CLUSTER PER LEVEL: each level seeds the fake BEFORE the
	// first ?dir= request so the lazily-created per-dir aggregator hydrates from
	// GET /session with the full seeded set (authoritative) — avoiding racy
	// live-event ingest. The reported N is the ACTUAL hydrated session count.
	seedTargets := []int{50, 200, 980}
	type row struct {
		n            int
		bytes        int
		directMs     float64
		tunnelMs     float64
		yamuxRespMs  float64 // avg response-write dur over the tunnel runs (ns→ms)
		yamuxAckMs   float64
		yamuxSetupMs float64
	}
	var rows []row

	for _, seedN := range seedTargets {
		c, err := StartCluster()
		if err != nil {
			t.Fatalf("StartCluster (seed=%d): %v", seedN, err)
		}
		// Seed BEFORE the first ?dir= request (which lazily creates the per-dir
		// aggregator). SeedFlatSessions appends under the fake's lock; the
		// per-dir aggregator's subsequent hydrate reads them via GET /session.
		c.Fake.SeedFlatSessions(seedN)

		var baseLat map[string]any
		// First ?dir= creates the per-dir aggregator + triggers hydrate.
		waitForSessions(t, c, dir, 1)
		got := countSessions(t, c, dir)
		baseLat = diagLatency(t, c)

		directBytes, directMs := medianColdBootstrap(t, c.WorkerVHURL+"/vh/stream?dir="+dir, nil, "worker-direct", got)
		tunnelBytes, tunnelMs := medianColdBootstrap(t,
			c.ControllerURL+"/api/workers/"+c.WorkerID+"/events?dir="+dir,
			map[string]string{"Authorization": "Bearer " + c.APIToken},
			"through-tunnel", got)
		afterLat := diagLatency(t, c)
		respAvg, ackAvg, setupAvg := yamuxDeltas(baseLat, afterLat)

		if directBytes != tunnelBytes && directBytes > 0 {
			t.Logf("WARN N=%d byte mismatch direct=%d tunnel=%d (route param forwarding differs)", got, directBytes, tunnelBytes)
		}
		rows = append(rows, row{got, directBytes, directMs, tunnelMs, respAvg, ackAvg, setupAvg})
		c.Close()
	}

	// Result table.
	t.Logf("=== TUNNEL-GATE SCALING (cold Stream-1 detail bootstrap) ===")
	t.Logf("dir=%s  loopback yamux tunnel  (runs/sample=3, median ms)", dir)
	t.Logf("%-6s %-12s %-12s %-12s %-12s %-12s %-12s", "N", "bytes", "direct_ms", "tunnel_ms", "ymx_resp_ms", "ymx_ack_ms", "ymx_setup_ms")
	for _, r := range rows {
		t.Logf("%-6d %-12d %-12.2f %-12.2f %-12.3f %-12.3f %-12.3f",
			r.n, r.bytes, r.directMs, r.tunnelMs, r.yamuxRespMs, r.yamuxAckMs, r.yamuxSetupMs)
	}
	for _, r := range rows {
		overhead := r.tunnelMs - r.directMs
		t.Logf("N=%-4d tunnel-overhead=%.2fms (tunnel-direct)  ratio tunnel/direct=%.2fx", r.n, overhead, safeRatio(r.tunnelMs, r.directMs))
	}
}

// medianColdBootstrap runs the cold bootstrap `runs` times, returns median
// wall-clock (ms) and mean bytes. A cold bootstrap = GET with no cursor; the
// server emits the legacy detail `snapshot` frame (the session+gate volume that
// is the bottleneck) then live frames. We terminate at the end of the FIRST
// `event: snapshot` frame — that is the cold-bootstrap payload. NOTE:
// `snapshot.complete` is a tree=2-only frame, and the controller STRIPS tree=2
// from the tunneled route, so the tunnel path never emits snapshot.complete;
// the detail `snapshot` frame is the correct apples-to-apples termination for
// both paths.
func medianColdBootstrap(t *testing.T, url string, headers map[string]string, label string, n int) (bytes int, ms float64) {
	const runs = 3
	var allMs []float64
	var bytesAcc int
	for i := 0; i < runs; i++ {
		b, durMs, ok := readUntilDetailSnapshot(url, headers)
		if !ok {
			t.Logf("  [%s N=%d run=%d] did not observe detail snapshot frame (partial=%d bytes)", label, n, i, b)
		}
		allMs = append(allMs, durMs)
		bytesAcc += b
	}
	sort.Float64s(allMs)
	median := allMs[len(allMs)/2]
	t.Logf("  [%s N=%d] runs=%v ms; median=%.2f; meanBytes=%d", label, n, allMs, median, bytesAcc/runs)
	return bytesAcc / runs, median
}

// readUntilDetailSnapshot opens the SSE stream and stops at the end of the first
// `event: snapshot` frame (frame boundary = blank line). Returns bytes read +
// wall-clock (ms) + whether the snapshot frame was observed.
func readUntilDetailSnapshot(url string, headers map[string]string) (bytes int, ms float64, ok bool) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return 0, 0, false
	}
	req.Header.Set("Accept", "text/event-stream")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return 0, float64(time.Since(start).Microseconds()) / 1000.0, false
	}
	defer resp.Body.Close()
	br := bufio.NewReader(resp.Body)
	curEvent := ""
	for {
		line, err := br.ReadString('\n')
		bytes += len(line)
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "event:") {
			curEvent = strings.TrimSpace(strings.TrimPrefix(trim, "event:"))
		}
		if trim == "" { // blank line = end of SSE frame
			if curEvent == "snapshot" {
				return bytes, float64(time.Since(start).Microseconds()) / 1000.0, true
			}
			curEvent = ""
		}
		if err != nil {
			return bytes, float64(time.Since(start).Microseconds()) / 1000.0, false
		}
	}
}

func countSessions(t *testing.T, c *Cluster, dir string) int {
	// Worker-direct /vh/snapshot?dir= both triggers aggFor(dir) (creating the
	// per-dir aggregator on first call — see queue_recovery_test openProjectForDir)
	// and returns the scoped session list.
	req, _ := http.NewRequest(http.MethodGet, c.WorkerVHURL+"/vh/snapshot?dir="+dir, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
		}
		return 0
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var snap map[string]any
	if json.Unmarshal(b, &snap) != nil {
		return 0
	}
	if sess, ok := snap["sessions"].([]any); ok {
		return len(sess)
	}
	return 0
}

func waitForSessions(t *testing.T, c *Cluster, dir string, want int) {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if got := countSessions(t, c, dir); got >= want {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("sessions never reached %d (last=%d) for dir=%s", want, countSessions(t, c, dir), dir)
}

// diagLatency fetches the worker's /vh/diag/latency (the raw probes map).
func diagLatency(t *testing.T, c *Cluster) map[string]any {
	req, _ := http.NewRequest(http.MethodGet, c.WorkerVHURL+"/vh/diag/latency", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("diag/latency: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("diag/latency unmarshal: %v", err)
	}
	return out
}

// yamuxDeltas computes the avg yamux response-write / ack / setup duration (ms)
// between two cumulative latency snapshots, from the per-direction write_by_dir
// (response) + ack_dur + setup_dur histograms.
func yamuxDeltas(a, b map[string]any) (respMs, ackMs, setupMs float64) {
	respMs = histAvgDelta(a, b, []string{"probes", "yamux", "write_by_dir"}, "response", "dur")
	ackMs = histAvgDelta(a, b, []string{"probes", "yamux", "ack_dur"}, "", "")
	setupMs = histAvgDelta(a, b, []string{"probes", "yamux", "setup_dur"}, "", "")
	return
}

// histAvgDelta: for a scalar histogram (path...→hist), delta avg = Δsum_ns/Δcount.
// For write_by_dir (array of {dir,...}), it locates the entry whose dir matches `wantDir`.
func histAvgDelta(a, b map[string]any, path []string, wantDir, _ string) float64 {
	ha := getHist(a, path, wantDir)
	hb := getHist(b, path, wantDir)
	dCount := toInt64(hb["count"]) - toInt64(ha["count"])
	dSum := toInt64(hb["sum_ns"]) - toInt64(ha["sum_ns"])
	if dCount <= 0 {
		return float64(dSum) / 1e6 // fallback: cumulative avg if no new samples
	}
	return (float64(dSum) / float64(dCount)) / 1e6
}

func getHist(m map[string]any, path []string, wantDir string) map[string]any {
	cur := any(m)
	for i, p := range path {
		mp, ok := cur.(map[string]any)
		if !ok {
			return map[string]any{}
		}
		if p == "write_by_dir" && i == len(path)-1 {
			arr, ok := mp["write_by_dir"].([]any)
			if !ok {
				return map[string]any{}
			}
			for _, e := range arr {
				if em, ok := e.(map[string]any); ok {
					if d, _ := em["dir"].(string); d == wantDir || strings.Contains(strings.ToLower(d), wantDir) {
						if h, ok := em["dur"].(map[string]any); ok {
							return h
						}
					}
				}
			}
			// fallback: first entry
			if len(arr) > 0 {
				if em, ok := arr[0].(map[string]any); ok {
					if h, ok := em["dur"].(map[string]any); ok {
						return h
					}
				}
			}
			return map[string]any{}
		}
		cur = mp[p]
	}
	if h, ok := cur.(map[string]any); ok {
		return h
	}
	return map[string]any{}
}

func toInt64(v any) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case int64:
		return x
	case int:
		return int64(x)
	}
	return 0
}

func safeRatio(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}
