package web

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// providerUpstream is a counting fake for the upstream GET /provider that
// the /oc/provider passthrough reverse-proxies to (S4 single-flight tests).
//
//   - every GET is counted on ARRIVAL (before any gate) so a mid-flight
//     assertion can prove how many requests actually reached upstream;
//   - an optional gate holds every GET inside the handler until closed,
//     standing in for the ~600ms provider compute window;
//   - fail=true makes the response a 500 "boom" (failure-propagation);
//   - the body echoes the request's project dir and the upstream GET
//     number, so "fresh fetch vs replayed result" is airtight: a replayed
//     flight re-serves the SAME served_by_get number, a fresh upstream
//     fetch serves the next one.
type providerUpstream struct {
	gate chan struct{}
	fail atomic.Bool
	gets atomic.Int32

	mu     sync.Mutex
	perDir map[string]int
}

func newProviderUpstream() *providerUpstream {
	return &providerUpstream{perDir: map[string]int{}}
}

func (u *providerUpstream) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := u.gets.Add(1) // count on arrival, before the gate
		dir := r.Header.Get("x-opencode-directory")
		u.mu.Lock()
		u.perDir[dir]++
		u.mu.Unlock()
		if u.gate != nil {
			<-u.gate
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("X-VH-Fixture-Marker", "provider-shape")
		if u.fail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprintf(w, `{"dir":%q,"error":"boom"}`, dir)
			return
		}
		fmt.Fprintf(w, `{"dir":%q,"served_by_get":%d}`, dir, n)
	})
}

// ensureGateClosed is the Fatalf-safety net for gated tests: it closes the
// gate exactly once so t.Cleanup's ts.Close() cannot deadlock on handlers
// still parked inside the upstream. Only the main test goroutine ever
// closes the gate, so the check-then-close is race-free.
func (u *providerUpstream) ensureGateClosed() {
	select {
	case <-u.gate:
	default:
		close(u.gate)
	}
}

// newProviderTestServer boots the real Server + handler chain around an
// upstream, exactly like the browser path: httptest → mux → middleware →
// handlePassthrough → reverse proxy → upstream.
func newProviderTestServer(t *testing.T, up *httptest.Server) *httptest.Server {
	t.Helper()
	agg := aggregator.New(up.URL, 64)
	srv, err := NewServer(agg, up.URL, 64)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

type providerResult struct {
	status int
	header http.Header
	body   string
	err    error
}

// getProvider issues ONE GET /oc/provider for a project dir. It never
// Fatals (wave goroutines call it; t.Fatalf is illegal off the test
// goroutine) — failures come back as err.
func getProvider(ts *httptest.Server, dir string) providerResult {
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/oc/provider", nil)
	if err != nil {
		return providerResult{err: err}
	}
	req.Header.Set("x-opencode-directory", dir)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return providerResult{err: err}
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return providerResult{err: err}
	}
	return providerResult{status: res.StatusCode, header: res.Header, body: string(b)}
}

// waveProvider fires n concurrent GETs for the same dir and collects their
// results (order not preserved).
func waveProvider(n int, ts *httptest.Server, dir string) []providerResult {
	results := make(chan providerResult, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- getProvider(ts, dir)
		}()
	}
	wg.Wait()
	close(results)
	out := make([]providerResult, 0, n)
	for r := range results {
		out = append(out, r)
	}
	return out
}

// TestProviderSingleRequestParity pins the single-request response shape:
// body bytes, Content-Type, passthrough marker header, Content-Length, and
// the no-server-caching posture (Cache-Control absent — the service worker
// owns /oc/provider caching; the daemon must not stamp anything). This test
// is the pre-change receipt AND the post-change parity proof: the exact
// same assertions must hold before and after single-flight lands.
func TestProviderSingleRequestParity(t *testing.T) {
	up := newProviderUpstream()
	upstream := httptest.NewServer(up.handler())
	t.Cleanup(upstream.Close)
	ts := newProviderTestServer(t, upstream)

	res := getProvider(ts, "/proj")
	if res.err != nil {
		t.Fatalf("GET /oc/provider: %v", res.err)
	}
	if res.status != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.status)
	}
	want := `{"dir":"/proj","served_by_get":1}`
	if res.body != want {
		t.Fatalf("body = %q, want %q", res.body, want)
	}
	if ct := res.header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want application/json; charset=utf-8", ct)
	}
	if m := res.header.Get("X-VH-Fixture-Marker"); m != "provider-shape" {
		t.Fatalf("X-VH-Fixture-Marker = %q, want provider-shape (passthrough)", m)
	}
	if cl := res.header.Get("Content-Length"); cl != fmt.Sprint(len(want)) {
		t.Fatalf("Content-Length = %q, want %d", cl, len(want))
	}
	if _, ok := res.header["Cache-Control"]; ok {
		t.Fatalf("Cache-Control = %q, want absent (SW owns provider caching)", res.header.Get("Cache-Control"))
	}
	if got := up.gets.Load(); got != 1 {
		t.Fatalf("upstream gets = %d, want 1", got)
	}
}

// TestProviderSingleFlight: N concurrent identical GETs (same project dir)
// → exactly ONE upstream fetch, all N responses equivalent.
func TestProviderSingleFlight(t *testing.T) {
	up := newProviderUpstream()
	up.gate = make(chan struct{})
	defer up.ensureGateClosed()
	upstream := httptest.NewServer(up.handler())
	t.Cleanup(upstream.Close)
	ts := newProviderTestServer(t, upstream)

	const n = 8
	done := make(chan []providerResult, 1)
	go func() { done <- waveProvider(n, ts, "/proj") }()

	time.Sleep(150 * time.Millisecond) // let all 8 arrive and join the flight
	if got := up.gets.Load(); got != 1 {
		t.Fatalf("during flight window: upstream gets = %d, want exactly 1 (leader only)", got)
	}
	close(up.gate)

	results := <-done
	if len(results) != n {
		t.Fatalf("got %d results, want %d", len(results), n)
	}
	want := `{"dir":"/proj","served_by_get":1}`
	for i, res := range results {
		if res.err != nil {
			t.Fatalf("result %d: %v", i, res.err)
		}
		if res.status != http.StatusOK {
			t.Fatalf("result %d: status = %d, want 200", i, res.status)
		}
		if res.body != want {
			t.Fatalf("result %d: body = %q, want %q", i, res.body, want)
		}
	}
	if got := up.gets.Load(); got != 1 {
		t.Fatalf("after settle: upstream gets = %d, want 1 (single flight)", got)
	}
}

// TestProviderSingleFlightPerDir: 2 dirs × concurrent requests → exactly
// one upstream fetch PER DIR (2 total), not 1 (over-merging) and not N.
func TestProviderSingleFlightPerDir(t *testing.T) {
	up := newProviderUpstream()
	up.gate = make(chan struct{})
	defer up.ensureGateClosed()
	upstream := httptest.NewServer(up.handler())
	t.Cleanup(upstream.Close)
	ts := newProviderTestServer(t, upstream)

	const perDir = 4
	doneA := make(chan []providerResult, 1)
	doneB := make(chan []providerResult, 1)
	go func() { doneA <- waveProvider(perDir, ts, "/proj/a") }()
	go func() { doneB <- waveProvider(perDir, ts, "/proj/b") }()

	time.Sleep(150 * time.Millisecond)
	if got := up.gets.Load(); got != 2 {
		t.Fatalf("during flight window: upstream gets = %d, want exactly 2 (one leader per dir)", got)
	}
	up.mu.Lock()
	a, b := up.perDir["/proj/a"], up.perDir["/proj/b"]
	up.mu.Unlock()
	if a != 1 || b != 1 {
		t.Fatalf("per-dir upstream gets: a=%d b=%d, want a=1 b=1", a, b)
	}
	close(up.gate)

	rsA, rsB := <-doneA, <-doneB
	if len(rsA) != perDir || len(rsB) != perDir {
		t.Fatalf("wave sizes: a=%d b=%d, want %d each", len(rsA), len(rsB), perDir)
	}
	for i, res := range append(rsA, rsB...) {
		if res.err != nil {
			t.Fatalf("result %d: %v", i, res.err)
		}
		if res.status != http.StatusOK {
			t.Fatalf("result %d: status = %d, want 200", i, res.status)
		}
	}
	for i := 1; i < perDir; i++ {
		if rsA[i].body != rsA[0].body {
			t.Fatalf("dir a result %d body = %q, want %q (shared flight)", i, rsA[i].body, rsA[0].body)
		}
		if rsB[i].body != rsB[0].body {
			t.Fatalf("dir b result %d body = %q, want %q (shared flight)", i, rsB[i].body, rsB[0].body)
		}
	}
	if rsA[0].body == rsB[0].body {
		t.Fatalf("dir a and dir b share a flight: both bodies %q", rsA[0].body)
	}
}

// TestProviderSingleFlightFailureSemantics: an upstream failure in-flight
// reaches every waiter of that flight, and the NEXT request after the
// failed flight performs a FRESH upstream fetch (no negative caching).
func TestProviderSingleFlightFailureSemantics(t *testing.T) {
	up := newProviderUpstream()
	up.gate = make(chan struct{})
	up.fail.Store(true)
	defer up.ensureGateClosed()
	upstream := httptest.NewServer(up.handler())
	t.Cleanup(upstream.Close)
	ts := newProviderTestServer(t, upstream)

	const n = 3
	done := make(chan []providerResult, 1)
	go func() { done <- waveProvider(n, ts, "/proj") }()

	time.Sleep(150 * time.Millisecond)
	if got := up.gets.Load(); got != 1 {
		t.Fatalf("during flight window: upstream gets = %d, want exactly 1", got)
	}
	close(up.gate)

	results := <-done
	if len(results) != n {
		t.Fatalf("got %d results, want %d", len(results), n)
	}
	for i, res := range results {
		if res.err != nil {
			t.Fatalf("result %d: %v", i, res.err)
		}
		if res.status != http.StatusInternalServerError {
			t.Fatalf("result %d: status = %d, want 500 (failure shared by all waiters)", i, res.status)
		}
		if res.body != `{"dir":"/proj","error":"boom"}` {
			t.Fatalf("result %d: body = %q, want the boom body", i, res.body)
		}
	}

	// No negative caching: the next request starts a FRESH upstream fetch
	// (upstream GET counter advances and its fresh body is served).
	up.fail.Store(false)
	res := getProvider(ts, "/proj")
	if res.err != nil {
		t.Fatalf("post-failure GET: %v", res.err)
	}
	if res.status != http.StatusOK {
		t.Fatalf("post-failure status = %d, want 200 (fresh flight, no negative cache)", res.status)
	}
	if res.body != `{"dir":"/proj","served_by_get":2}` {
		t.Fatalf("post-failure body = %q, want served_by_get:2 (fresh upstream fetch)", res.body)
	}
	if got := up.gets.Load(); got != 2 {
		t.Fatalf("upstream gets after recovery = %d, want 2", got)
	}
}

// TestProviderNoCachingBeyondInFlight: sequential requests each hit
// upstream — the daemon must not cache provider results beyond the
// in-flight window (the service worker owns /oc/provider caching).
func TestProviderNoCachingBeyondInFlight(t *testing.T) {
	up := newProviderUpstream()
	upstream := httptest.NewServer(up.handler())
	t.Cleanup(upstream.Close)
	ts := newProviderTestServer(t, upstream)

	r1 := getProvider(ts, "/proj")
	r2 := getProvider(ts, "/proj")
	if r1.err != nil || r2.err != nil {
		t.Fatalf("sequential GETs: %v / %v", r1.err, r2.err)
	}
	if r1.status != 200 || r2.status != 200 {
		t.Fatalf("statuses = %d/%d, want 200/200", r1.status, r2.status)
	}
	if r1.body == r2.body {
		t.Fatalf("both sequential responses served %q — result caching beyond the in-flight window", r1.body)
	}
	if got := up.gets.Load(); got != 2 {
		t.Fatalf("upstream gets = %d, want 2 (no caching)", got)
	}
}
