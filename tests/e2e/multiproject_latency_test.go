package e2e

// TestMultiProjectContentionBaseline is the Phase-A1 MEASUREMENT slice
// (tmp/agent-runs/multiproject-contention-20260918/brief.md §6): it gives the
// repo a ruler for multi-project contention — N populated projects on ONE
// worker, browser-shaped demand client-side through the REAL yamux tunnel vs
// direct — so a later decision can pick between recovery-fix / browser-fix /
// tunnel-knob / tunnel-fairness options with numbers. It measures and
// REPORTS; the only pass criteria are STRUCTURAL (requests succeed, data is
// correct, the test completes). No latency thresholds are asserted.
//
// What it measures (all client-side, from this test process):
//
//  1. DIRECT vs TUNNEL: the same demand against the worker's local web server
//     (WorkerVHURL, loopback) vs through the controller's per-worker
//     subdomain RAW tunnel proxy (hostInterceptor → yamux → worker) — the
//     production browser path, exercised with the SPA's real endpoint shapes:
//     tree stream   GET /vh/stream?dir=<dir>&z=1&tree=2          (Stream 1)
//     session strm  GET /vh/stream?sessions=<sid>&dir=<dir>&z=1&part_delta=1 (Stream 2)
//     small probe   GET /vh/snapshot?dir=<dir>                    (one-shot list)
//  2. PROJECT COUNT: 1 / 3 / 7 populated projects, concurrent per-project
//     demand (tree + selected-session stream per project = the per-tab core
//     demand class; E08 of the brief).
//  3. BULK-vs-SMALL (head-of-line probe): while one project streams a ~600 KiB
//     poorly-compressible part, measure small-request latency on OTHER
//     projects — direct vs tunnel, each against its own idle baseline. This
//     contrast discriminates "tunnel contention" from "uniformly slow".
//  4. RECOVERY (best-effort): sever the controller-side yamux session, let the
//     worker agent's reconnect loop redial, then measure the 7-project
//     re-snapshot burst through the tunnel.
//
// Cold/warm discipline: per level TWO fresh clusters are booted — cluster A
// measures direct-COLD then tunnel-WARM; cluster B measures tunnel-COLD then
// direct-WARM — so each route gets a message-cold first-contact measurement
// on its own fresh substrate and an order-balanced warm measurement. Bulk
// sessions are opened exactly once each (b0 → direct probe, b1 → tunnel
// probe) so both bulk transfers are cold.
//
// LOOPBACK CAVEAT (inherited from tunnel_gate_test.go): the in-process yamux
// tunnel runs over loopback (near-zero RTT, huge bandwidth), so results
// UNDER-REPRESENT production-network throughput. Slow-on-loopback implicates
// compute/serialization/mux; fast-on-loopback does NOT exonerate the tunnel
// on a constrained network.
//
// This file deliberately does NOT use StartCluster: it boots its own cluster
// (same package helpers) for two reasons — (1) the controller must run with a
// host pattern for the subdomain raw proxy, and (2) the controller-side
// *server.Daemon must be retained for the tunnel-sever recovery probe. Both
// stay local to this measurement so the shared harness surface is untouched.

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/agent"
	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/server"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// mpWorkerHostPattern / mpWorkerHost: the per-worker subdomain routing this
// measurement boots the controller with (mirrors the production browser path
// and tests/e2e/layouts_proxy_test.go's pattern).
const (
	mpWorkerHostPattern = "$ID.localhost"
	mpWorkerHost        = "worker-e2e.localhost"
)

// mpSSEDeadline bounds ONE SSE read (generous: these complete in ms; the
// bound only guards against a wedged substrate so the failure is loud).
const mpSSEDeadline = 60 * time.Second

// --- self-bootstrapped cluster (controller with host pattern + daemon ref) ---

// mpCluster is a StartCluster-shaped stack plus the retained controller
// daemon (for the sever probe). Close() = Cluster.Close().
type mpCluster struct {
	*Cluster
	ctrl *server.Daemon
}

func startMPCluster(t *testing.T) *mpCluster {
	t.Helper()
	log.SetOutput(io.Discard) // agent/controller log verbosely; keep output clean

	ctx, cancel := context.WithCancel(context.Background())
	c := &Cluster{WorkerID: "worker-e2e", APIToken: "e2e-token", cancel: cancel}

	// 1. Fake opencode.
	c.Fake = fixtures.New()
	c.fakeSrv = httptest.NewServer(c.Fake.Handler())

	// 2. Worker web server over the fake (aggregator running).
	agg := aggregator.New(c.fakeSrv.URL, ringCap)
	go agg.Run(ctx)
	wsrv, err := web.NewServer(agg, c.fakeSrv.URL, ringCap)
	if err != nil {
		cancel()
		t.Fatalf("mp web.NewServer: %v", err)
	}
	c.webSrv = wsrv
	c.workerSrv = httptest.NewServer(wsrv.Handler())
	c.WorkerVHURL = c.workerSrv.URL
	webPort, err := portOf(c.workerSrv.URL)
	if err != nil {
		cancel()
		t.Fatalf("mp portOf: %v", err)
	}

	// 3. Controller daemon WITH the host pattern (subdomain raw proxy on).
	userAddr, err := freeAddr()
	if err != nil {
		cancel()
		t.Fatalf("mp freeAddr: %v", err)
	}
	daemonAddr, err := freeAddr()
	if err != nil {
		cancel()
		t.Fatalf("mp freeAddr: %v", err)
	}
	d := server.NewDaemon(userAddr, daemonAddr, mpWorkerHostPattern)
	d.APIToken = c.APIToken
	go func() { _ = d.Start() }()
	c.ControllerURL = "http://" + userAddr
	if err := waitHTTP(c.ControllerURL+"/api/coord/workers", c.APIToken, 200, 10*time.Second); err != nil {
		cancel()
		t.Fatalf("mp controller did not come up: %v", err)
	}

	// 4. Worker agent: dial the tunnel endpoint, proxy to the worker web port.
	proxy := agent.NewProxy(webPort)
	ag := agent.NewDaemon("ws://"+daemonAddr+"/vh-solara/ws", c.WorkerID, "worker", "test", nil, proxy)
	go ag.Start()

	if err := waitWorkerOnline(c, 15*time.Second); err != nil {
		cancel()
		t.Fatalf("mp worker did not come online: %v", err)
	}
	return &mpCluster{Cluster: c, ctrl: d}
}

// severTunnel closes the CONTROLLER-side yamux session for this cluster's
// worker — the sanctioned test hook for the recovery probe (measurement-only;
// no product change). The worker agent's reconnect loop detects the closed
// session, sleeps its backoff floor (1s), and redials; the controller accepts
// the re-registration (the old entry's transport is closed, so it is a
// reconnect, not a duplicate).
func (m *mpCluster) severTunnel(t *testing.T) {
	t.Helper()
	w, ok := m.ctrl.Registry.GetWorker(m.WorkerID)
	if !ok || w.Transport == nil {
		t.Fatalf("sever: worker %s not registered", m.WorkerID)
	}
	if err := w.Transport.Close(); err != nil {
		t.Logf("sever: transport close returned %v (continuing — close is best-effort)", err)
	}
}

// --- routes ---

// mpRoute addresses the worker either directly (loopback) or through the
// controller's per-worker subdomain raw tunnel proxy.
type mpRoute struct {
	name string
	base string // scheme://host:port the request is sent to
	host string // req.Host override ("" = none); routes via hostInterceptor
}

func mpDirect(c *Cluster) mpRoute { return mpRoute{name: "direct", base: c.WorkerVHURL} }
func mpTunnel(c *Cluster) mpRoute {
	return mpRoute{name: "tunnel", base: c.ControllerURL, host: mpWorkerHost}
}

// --- SSE reader ---

// mpSSEStat is one measured SSE open.
type mpSSEStat struct {
	FirstByteMs float64
	TotalMs     float64
	Bytes       int64
	OK          bool // terminator fired
	Note        string
}

// mpReadSSE opens a GET (SSE) on the route and reads frames until onFrame
// returns true (terminator), the server closes, or the deadline hits.
// onFrame receives each COMPLETE frame's event name and joined data payload;
// returning true stops the read (OK). First-byte is measured at client.Do
// return — the worker flushes SSE headers (a `:` comment) at handler entry,
// so first-byte ≈ pure transport/tunnel-setup cost ("conn" in the SPA's own
// measurements), not snapshot compute.
func mpReadSSE(route mpRoute, rawQuery string, onFrame func(event, data string) bool) mpSSEStat {
	req, err := http.NewRequest(http.MethodGet, route.base+"/vh/stream?"+rawQuery, nil)
	if err != nil {
		return mpSSEStat{OK: false, Note: "new request: " + err.Error()}
	}
	if route.host != "" {
		req.Host = route.host
	}
	req.Header.Set("Accept", "text/event-stream")
	ctx, cancel := context.WithTimeout(context.Background(), mpSSEDeadline)
	defer cancel()
	req = req.WithContext(ctx)

	client := &http.Client{Timeout: 0} // bounded by the request context, not the client
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return mpSSEStat{OK: false, Note: "do: " + err.Error()}
	}
	firstByte := float64(time.Since(start).Microseconds()) / 1000.0
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return mpSSEStat{FirstByteMs: firstByte, OK: false, Note: fmt.Sprintf("status %d", resp.StatusCode)}
	}

	br := bufio.NewReader(resp.Body)
	curEvent := ""
	var dataParts []string
	var total int64
	for {
		line, rerr := br.ReadString('\n')
		total += int64(len(line))
		trim := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trim, "event:"):
			curEvent = strings.TrimSpace(strings.TrimPrefix(trim, "event:"))
		case strings.HasPrefix(trim, "data:"):
			dataParts = append(dataParts, strings.TrimSpace(strings.TrimPrefix(trim, "data:")))
		case trim == "": // blank line = end of SSE frame
			if curEvent != "" && onFrame(curEvent, strings.Join(dataParts, "\n")) {
				return mpSSEStat{FirstByteMs: firstByte, TotalMs: float64(time.Since(start).Microseconds()) / 1000.0, Bytes: total, OK: true}
			}
			curEvent = ""
			dataParts = nil
		}
		if rerr != nil {
			return mpSSEStat{FirstByteMs: firstByte, TotalMs: float64(time.Since(start).Microseconds()) / 1000.0, Bytes: total, OK: false, Note: "read: " + rerr.Error()}
		}
	}
}

// mpGetStat is one measured one-shot HTTP GET.
type mpGetStat struct {
	FirstByteMs float64
	TotalMs     float64
	Bytes       int64
	Status      int
	OK          bool
	Note        string
}

// mpGetJSON issues a one-shot GET on the route and decodes the JSON body into
// out (nil out = skip decode).
func mpGetJSON(route mpRoute, path string, out any) mpGetStat {
	req, err := http.NewRequest(http.MethodGet, route.base+path, nil)
	if err != nil {
		return mpGetStat{OK: false, Note: "new request: " + err.Error()}
	}
	if route.host != "" {
		req.Host = route.host
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req = req.WithContext(ctx)
	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return mpGetStat{OK: false, Note: "do: " + err.Error()}
	}
	firstByte := float64(time.Since(start).Microseconds()) / 1000.0
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return mpGetStat{FirstByteMs: firstByte, Status: resp.StatusCode, OK: false, Note: "read: " + err.Error()}
	}
	st := mpGetStat{FirstByteMs: firstByte, TotalMs: float64(time.Since(start).Microseconds()) / 1000.0, Bytes: int64(len(body)), Status: resp.StatusCode, OK: resp.StatusCode == 200}
	if out != nil && st.OK {
		if jerr := json.Unmarshal(body, out); jerr != nil {
			st.OK = false
			st.Note = "decode: " + jerr.Error()
		}
	}
	return st
}

// mpMaybeDecodeGzip64 decodes the worker's application-level gzip64 envelope
// ({"encoding":"gzip64","data":"<b64>"} — maybeCompressSnapshot) or returns
// the raw payload when it is not enveloped.
func mpMaybeDecodeGzip64(data string) []byte {
	var env struct {
		Encoding string `json:"encoding"`
		Data     string `json:"data"`
	}
	if json.Unmarshal([]byte(data), &env) == nil && env.Encoding == "gzip64" {
		if raw, err := base64.StdEncoding.DecodeString(env.Data); err == nil {
			if zr, err := gzip.NewReader(bytes.NewReader(raw)); err == nil {
				if out, err := io.ReadAll(zr); err == nil {
					return out
				}
			}
		}
		// A declared-but-undecodable envelope is a wire bug: surface it loudly
		// by returning the raw payload (the caller's decode will fail visibly).
	}
	return []byte(data)
}

// mpSnapshotSessionCount decodes a snapshot JSON payload (raw or gzip64) and
// returns len(sessions).
func mpSnapshotSessionCount(data string) (int, bool) {
	var snap map[string]any
	if json.Unmarshal(mpMaybeDecodeGzip64(data), &snap) != nil {
		return 0, false
	}
	sess, ok := snap["sessions"].([]any)
	return len(sess), ok
}

// mpSessionStreamDone builds the terminator for a selected-session stream
// open on sid. COLD open: the snapshot carries no messages; hydration
// completes when the `messages.loaded` event for sid arrives. WARM re-open:
// the snapshot itself inlines the loaded transcript (snap.messages[sid]), so
// the snapshot frame is the completion boundary. Both shapes terminate.
func mpSessionStreamDone(sid string) func(event, data string) bool {
	return func(event, data string) bool {
		if event == "messages.loaded" {
			var m map[string]any
			if json.Unmarshal([]byte(data), &m) == nil {
				if got, _ := m["sessionID"].(string); got == sid {
					return true
				}
			}
			return false
		}
		if event == "snapshot" {
			var snap map[string]any
			if json.Unmarshal(mpMaybeDecodeGzip64(data), &snap) != nil {
				return false
			}
			if msgs, ok := snap["messages"].(map[string]any); ok {
				if arr, ok := msgs[sid].([]any); ok && len(arr) > 0 {
					return true
				}
			}
		}
		return false
	}
}

// --- per-project substrate ---

// mpDirInfo is one populated project as the measurement sees it.
type mpDirInfo struct {
	Dir      string
	Selected string   // ordinary session the tab selects (mp<i>_s0)
	Bulk     []string // bulk session ids (mp<i>_b0, mp<i>_b1) — cold until the bulk probe
	Sessions int      // expected session count in this dir's store listing
}

// mpBootstrapDirs seeds the multi-project fixture and waits until every dir's
// per-directory aggregator has hydrated its session rows — WITHOUT loading
// any messages (the tree-only poll stream uses filter={} which never
// hydrates; see triggerMessageLoad). This makes every subsequent measurement
// run on an identical substrate: aggregators born + session rows resident,
// message transcripts COLD.
func mpBootstrapDirs(t *testing.T, c *Cluster, projects int) []mpDirInfo {
	t.Helper()
	spec := fixtures.DefaultMultiProjectSpec()
	spec.Projects = projects
	dirs := c.Fake.SeedMultiProject(spec)
	if len(dirs) != projects {
		t.Fatalf("SeedMultiProject: %d dirs, want %d", len(dirs), projects)
	}
	want := spec.SessionsPerProj + spec.BulkSessions
	route := mpDirect(c)
	out := make([]mpDirInfo, 0, len(dirs))
	for i, dir := range dirs {
		deadline := time.Now().Add(20 * time.Second)
		ready := false
		for time.Now().Before(deadline) {
			var snapData string
			q := url.Values{}
			q.Set("dir", dir)
			q.Set("z", "1")
			q.Set("tree", "2")
			st := mpReadSSE(route, q.Encode(), func(event, data string) bool {
				if event == "snapshot" {
					snapData = data // tree=2 legacy detail snapshot ships RAW
				}
				return event == "snapshot.complete"
			})
			if st.OK {
				if n, ok := mpSnapshotSessionCount(snapData); ok && n == want {
					ready = true
					break
				}
			}
			time.Sleep(200 * time.Millisecond)
		}
		if !ready {
			t.Fatalf("dir %s never reached %d store sessions", dir, want)
		}
		// Cross-check the FIXTURE directly through the worker (client-shaped
		// list; also proves the seeded set is dir-scoped on the real path).
		var inv struct {
			Sessions []map[string]any `json:"sessions"`
		}
		if st := mpGetJSON(route, "/vh/sessions?dir="+url.QueryEscape(dir), &inv); !st.OK {
			t.Fatalf("/vh/sessions dir=%s: %+v (%s)", dir, st, st.Note)
		}
		if len(inv.Sessions) != want {
			t.Fatalf("/vh/sessions dir=%s: %d sessions, want %d", dir, len(inv.Sessions), want)
		}
		out = append(out, mpDirInfo{
			Dir:      dir,
			Selected: fmt.Sprintf("mp%d_s0", i),
			Bulk:     []string{fmt.Sprintf("mp%d_b0", i), fmt.Sprintf("mp%d_b1", i)},
			Sessions: want,
		})
	}
	return out
}

// --- stats + report rows ---

// mpRow is one aggregated report line.
type mpRow struct {
	Scenario  string  `json:"scenario"` // cold | warm | recovery | bulk-small | bulk-baseline
	Route     string  `json:"route"`    // direct | tunnel
	Projects  int     `json:"projects"`
	Class     string  `json:"class"` // tree | session | bulk | small
	N         int     `json:"n"`
	FBMin     float64 `json:"fb_min_ms"`
	FBMed     float64 `json:"fb_med_ms"`
	FBMax     float64 `json:"fb_max_ms"`
	TotMin    float64 `json:"total_min_ms"`
	TotMed    float64 `json:"total_med_ms"`
	TotMax    float64 `json:"total_max_ms"`
	BytesMean int64   `json:"bytes_mean"`
	WallMs    float64 `json:"wall_ms"`
}

var mpRows []mpRow

func mpMinMaxMed(vals []float64) (mn, med, mx float64) {
	if len(vals) == 0 {
		return 0, 0, 0
	}
	s := append([]float64(nil), vals...)
	sort.Float64s(s)
	return s[0], s[len(s)/2], s[len(s)-1]
}

func mpAddRow(t *testing.T, scenario, route string, projects int, class string, fbs, totals []float64, bytesMean int64, wallMs float64) {
	t.Helper()
	fbMin, fbMed, fbMax := mpMinMaxMed(fbs)
	tMin, tMed, tMax := mpMinMaxMed(totals)
	mpRows = append(mpRows, mpRow{
		Scenario: scenario, Route: route, Projects: projects, Class: class, N: len(totals),
		FBMin: fbMin, FBMed: fbMed, FBMax: fbMax,
		TotMin: tMin, TotMed: tMed, TotMax: tMax,
		BytesMean: bytesMean, WallMs: wallMs,
	})
	r := mpRows[len(mpRows)-1]
	t.Logf("[%-8s %-6s p=%d %-7s] n=%d fb(min/med/max)=%.2f/%.2f/%.2fms total=%.2f/%.2f/%.2fms bytes_mean=%d wall=%.1fms",
		scenario, route, projects, class, r.N, fbMin, fbMed, fbMax, tMin, tMed, tMax, bytesMean, wallMs)
}

// --- the tab burst ---

// mpTabBurst fires the per-tab core demand for every project CONCURRENTLY:
// one tree stream + one selected-session stream per project (the two
// persistent SSE connections a selected-project tab holds — brief E08). All
// 2×N opens race, approximating N tabs restoring at once. When reps>1 the
// burst repeats and all samples land in ONE row (warm rows use this so the
// median resists single collisions with the substrate's periodic background
// work — the per-dir aggregators' 5s tree-reconcile polls and the worker's
// 10s heartbeat stream — which intermittently inflate one burst by ~10-20ms;
// that phenomenon is REAL production-shaped behavior and shows up in the max
// columns). Structural gates: every stream terminates, and every tree
// stream's detail snapshot carries exactly the expected session count (data
// correctness, not timing).
func mpTabBurst(t *testing.T, c *Cluster, route mpRoute, dirs []mpDirInfo, scenario string, reps int) {
	t.Helper()
	if reps < 1 {
		reps = 1
	}
	type cls struct {
		fbs, totals []float64
		bytes       int64
	}
	agg := map[string]*cls{"tree": {}, "session": {}}
	var walls []float64
	failures := 0
	for rep := 0; rep < reps; rep++ {
		type res struct {
			class string
			st    mpSSEStat
			note  string
		}
		var wg sync.WaitGroup
		resCh := make(chan res, len(dirs)*2)
		start := time.Now()
		for _, d := range dirs {
			d := d
			// Tree stream (Stream 1): the SPA's tree transport URL shape.
			wg.Add(1)
			go func() {
				defer wg.Done()
				q := url.Values{}
				q.Set("dir", d.Dir)
				q.Set("z", "1")
				q.Set("tree", "2")
				var snapData string
				st := mpReadSSE(route, q.Encode(), func(event, data string) bool {
					if event == "snapshot" {
						snapData = data
					}
					return event == "snapshot.complete"
				})
				note := ""
				if st.OK {
					if n, ok := mpSnapshotSessionCount(snapData); !ok || n != d.Sessions {
						st.OK = false
						note = fmt.Sprintf("tree detail snapshot sessions=%d (ok=%v), want %d", n, ok, d.Sessions)
					}
				}
				resCh <- res{"tree", st, note}
			}()
			// Selected-session stream (Stream 2): the SPA's session-stream URL
			// shape, part_delta=1 opt-in included (default-on in the client).
			wg.Add(1)
			go func() {
				defer wg.Done()
				q := url.Values{}
				q.Set("sessions", d.Selected)
				q.Set("dir", d.Dir)
				q.Set("z", "1")
				q.Set("part_delta", "1")
				st := mpReadSSE(route, q.Encode(), mpSessionStreamDone(d.Selected))
				note := ""
				if st.OK && st.Bytes <= 0 {
					st.OK = false
					note = "session stream terminated with zero bytes"
				}
				resCh <- res{"session", st, note}
			}()
		}
		wg.Wait()
		close(resCh)
		walls = append(walls, float64(time.Since(start).Microseconds())/1000.0)
		for r := range resCh {
			if !r.st.OK {
				failures++
				t.Errorf("burst %s/%s p=%d rep=%d %s failed: %+v note=%q", scenario, route.name, len(dirs), rep, r.class, r.st, r.note)
				continue
			}
			a := agg[r.class]
			a.fbs = append(a.fbs, r.st.FirstByteMs)
			a.totals = append(a.totals, r.st.TotalMs)
			a.bytes += r.st.Bytes
		}
	}
	if failures > 0 {
		return // structural gate tripped; numbers would be misleading
	}
	var wallMean float64
	for _, w := range walls {
		wallMean += w
	}
	wallMean /= float64(len(walls))
	for _, class := range []string{"tree", "session"} {
		a := agg[class]
		mpAddRow(t, scenario, route.name, len(dirs), class, a.fbs, a.totals, a.bytes/int64(len(a.totals)), wallMean)
	}
}

// --- bulk-vs-small (head-of-line) probe ---

// mpSmallSeries fires n SEQUENTIAL small one-shot snapshot GETs cycling the
// given dirs (per-request latency probes on warm aggregators — the
// interactive-traffic stand-in).
func mpSmallSeries(route mpRoute, dirs []mpDirInfo, n int) ([]float64, []float64, bool) {
	var fbs, totals []float64
	for i := 0; i < n; i++ {
		d := dirs[i%len(dirs)]
		var snap map[string]any
		st := mpGetJSON(route, "/vh/snapshot?dir="+url.QueryEscape(d.Dir), &snap)
		if !st.OK {
			return fbs, totals, false
		}
		fbs = append(fbs, st.FirstByteMs)
		totals = append(totals, st.TotalMs)
	}
	return fbs, totals, true
}

// mpBulkProbe measures the head-of-line contrast on one route: small-request
// latency on projects 1..N-1 while project 0's bulk session (one ~600 KiB
// poorly-compressible part, message-COLD — bulk sessions are never opened by
// bursts) streams through a fresh session-stream open. Each route uses its
// OWN bulk session (direct→b0, tunnel→b1) so both bulk transfers start cold.
func mpBulkProbe(t *testing.T, c *Cluster, route mpRoute, dirs []mpDirInfo, bulkIdx int) {
	t.Helper()
	if len(dirs) < 2 {
		t.Fatalf("bulk probe needs >=2 projects, got %d", len(dirs))
	}
	others := dirs[1:]
	bulkSid := dirs[0].Bulk[bulkIdx]
	const probes = 10

	// Idle baseline (no bulk in flight).
	idleFB, idleTot, ok := mpSmallSeries(route, others, probes)
	if !ok {
		t.Fatalf("bulk probe %s: idle small series failed", route.name)
	}
	mpAddRow(t, "bulk-base", route.name, len(dirs), "small", idleFB, idleTot, 0, 0)

	// Busy: bulk stream + the same small series concurrently.
	type bulkRes struct {
		st   mpSSEStat
		note string
	}
	bulkCh := make(chan bulkRes, 1)
	start := time.Now()
	go func() {
		q := url.Values{}
		q.Set("sessions", bulkSid)
		q.Set("dir", dirs[0].Dir)
		q.Set("z", "1")
		q.Set("part_delta", "1")
		st := mpReadSSE(route, q.Encode(), mpSessionStreamDone(bulkSid))
		note := ""
		if st.OK && st.Bytes < 100_000 {
			st.OK = false
			note = fmt.Sprintf("bulk stream moved only %d bytes — bulk part not delivered", st.Bytes)
		}
		bulkCh <- bulkRes{st, note}
	}()
	busyFB, busyTot, ok2 := mpSmallSeries(route, others, probes)
	br := <-bulkCh
	_ = start
	if !ok2 {
		t.Fatalf("bulk probe %s: busy small series failed", route.name)
	}
	if !br.st.OK {
		t.Fatalf("bulk probe %s: bulk stream failed: %+v note=%q", route.name, br.st, br.note)
	}
	mpAddRow(t, "bulk-small", route.name, len(dirs), "small", busyFB, busyTot, 0, br.st.TotalMs)
	mpAddRow(t, "bulk-small", route.name, len(dirs), "bulk", []float64{br.st.FirstByteMs}, []float64{br.st.TotalMs}, br.st.Bytes, br.st.TotalMs)

	_, idleMed, _ := mpMinMaxMed(idleTot)
	_, busyMed, _ := mpMinMaxMed(busyTot)
	t.Logf("[bulk-contrast %-6s] small-request median: idle=%.2fms busy=%.2fms delta=%+.2fms (%.1fx); bulk total=%.2fms bytes=%d",
		route.name, idleMed, busyMed, busyMed-idleMed, mpRatio(busyMed, idleMed), br.st.TotalMs, br.st.Bytes)
}

func mpRatio(a, b float64) float64 {
	if b <= 0 {
		return 0
	}
	return a / b
}

// --- recovery probe ---

// mpRecoveryProbe severs the controller-side tunnel, waits for the worker
// agent's reconnect (redial after its backoff floor), then measures the
// 7-project re-snapshot burst through the tunnel — the reconnect storm shape
// (every tab's EventSource retries and re-snapshots). Best-effort: if the
// worker does not come back online within the bound, the probe is DEFERRED
// with a log line (never a timing-based failure).
func mpRecoveryProbe(t *testing.T, m *mpCluster, dirs []mpDirInfo) {
	t.Helper()
	severedAt := time.Now()
	m.severTunnel(t)

	// Wait for the registry to observe the loss (old handler returns →
	// offline), bounded — a slow observe just means the online wait below
	// absorbs it.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if w, ok := m.ctrl.Registry.GetWorker(m.WorkerID); !ok || w.Transport == nil || w.Transport.IsClosed() {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err := waitWorkerOnline(m.Cluster, 45*time.Second); err != nil {
		t.Logf("[recovery] DEFERRED: worker did not return online within 45s of tunnel sever: %v", err)
		return
	}
	reconnectMs := float64(time.Since(severedAt).Microseconds()) / 1000.0
	t.Logf("[recovery] tunnel severed → worker back online in %.2fms; measuring the %d-project re-snapshot burst through the tunnel", reconnectMs, len(dirs))
	mpTabBurst(t, m.Cluster, mpTunnel(m.Cluster), dirs, "recovery", 1)
}

// --- final report ---

func mpReport(t *testing.T) {
	t.Helper()
	t.Logf("=== MULTI-PROJECT CONTENTION BASELINE (Phase A1) — %d rows ===", len(mpRows))
	t.Logf("%-9s %-6s %-4s %-7s %3s %10s %22s %24s %10s %9s",
		"scenario", "route", "proj", "class", "n", "", "first-byte ms (min/med/max)", "total ms (min/med/max)", "bytes_mean", "wall_ms")
	for _, r := range mpRows {
		t.Logf("%-9s %-6s %-4d %-7s %3d %10s %10.2f/%7.2f/%8.2f %10.2f/%7.2f/%8.2f %10d %9.1f",
			r.Scenario, r.Route, r.Projects, r.Class, r.N, "",
			r.FBMin, r.FBMed, r.FBMax, r.TotMin, r.TotMed, r.TotMax, r.BytesMean, r.WallMs)
	}
	// Route contrast per (scenario, projects, class): tunnel/direct total-median
	// ratio. COLD rows come from DIFFERENT clusters (A: direct-cold, B:
	// tunnel-cold) — the ratio is still the intended contrast: the same
	// scenario class on a fresh substrate per route.
	type key struct {
		sc string
		p  int
		cl string
		rt string
	}
	med := map[key]float64{}
	for _, r := range mpRows {
		if r.Class == "small" || r.Class == "bulk" {
			continue
		}
		med[key{r.Scenario, r.Projects, r.Class, r.Route}] = r.TotMed
	}
	t.Logf("--- tunnel/direct total-median ratios (stream classes) ---")
	for _, p := range []int{1, 3, 7} {
		for _, sc := range []string{"cold", "warm", "recovery"} {
			for _, cl := range []string{"tree", "session"} {
				d, dok := med[key{sc, p, cl, "direct"}]
				v, vok := med[key{sc, p, cl, "tunnel"}]
				if !dok || !vok {
					continue
				}
				t.Logf("ratio %-8s p=%d %-7s tunnel/direct total_med = %.2fx (direct=%.2fms tunnel=%.2fms)",
					sc, p, cl, mpRatio(v, d), d, v)
			}
		}
	}

	// Optional structured dump for offline analysis (never committed):
	if out := os.Getenv("VH_MP_BASELINE_OUT"); out != "" {
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err == nil {
			b, err := json.MarshalIndent(mpRows, "", "  ")
			if err == nil {
				if err := os.WriteFile(out, b, 0o644); err == nil {
					t.Logf("[baseline] wrote %d rows to %s", len(mpRows), out)
				} else {
					t.Logf("[baseline] write %s failed: %v", out, err)
				}
			}
		} else {
			t.Logf("[baseline] mkdir for %s failed: %v", out, err)
		}
	}
}

// TestMultiProjectContentionBaseline is the Phase-A1 lane-3 measurement.
// Serial by design (the package never runs parallel); runtime is dominated
// by cluster boots (~7 including the warmup) and is targeted well under 90s.
func TestMultiProjectContentionBaseline(t *testing.T) {
	// Throwaway warmup pass: the FIRST burst of the process pays one-time
	// costs (allocator, scheduler, yamux/diag paths, first hydrate) that have
	// nothing to do with the measured contrast — especially the single-sample
	// p=1 rows. Absorb them on a throwaway cluster so recorded rows start
	// from a warm process. Its rows are recorded under scenario "warmup" for
	// transparency but excluded from contrasts (mpReport skips non-contrast
	// scenarios).
	mw := startMPCluster(t)
	dirsW := mpBootstrapDirs(t, mw.Cluster, 1)
	mpTabBurst(t, mw.Cluster, mpDirect(mw.Cluster), dirsW, "warmup", 1)
	mpTabBurst(t, mw.Cluster, mpTunnel(mw.Cluster), dirsW, "warmup", 1)
	mw.Close()

	for _, level := range []int{1, 3, 7} {
		// Cluster A: direct COLD on a fresh substrate, then tunnel WARM.
		ma := startMPCluster(t)
		dirsA := mpBootstrapDirs(t, ma.Cluster, level)
		mpTabBurst(t, ma.Cluster, mpDirect(ma.Cluster), dirsA, "cold", 1)
		mpTabBurst(t, ma.Cluster, mpTunnel(ma.Cluster), dirsA, "warm", 3)
		ma.Close()

		// Cluster B: tunnel COLD on a fresh substrate, then direct WARM.
		// Level 7 also carries the bulk-vs-small probes (own cold bulk
		// sessions per route) and the tunnel-sever recovery probe.
		mb := startMPCluster(t)
		dirsB := mpBootstrapDirs(t, mb.Cluster, level)
		mpTabBurst(t, mb.Cluster, mpTunnel(mb.Cluster), dirsB, "cold", 1)
		mpTabBurst(t, mb.Cluster, mpDirect(mb.Cluster), dirsB, "warm", 3)
		if level == 7 {
			mpBulkProbe(t, mb.Cluster, mpDirect(mb.Cluster), dirsB, 0)
			mpBulkProbe(t, mb.Cluster, mpTunnel(mb.Cluster), dirsB, 1)
			mpRecoveryProbe(t, mb, dirsB)
		}
		mb.Close()
	}
	mpReport(t)
}
