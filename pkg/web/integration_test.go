package web

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// fakeOpenCode is a minimal stand-in for `opencode serve`: a session list, a
// per-session message endpoint, and a controllable /event SSE stream.
type fakeOpenCode struct {
	mu       sync.Mutex
	sessions []string // raw JSON session objects
	messages map[string]string
	events   chan string    // raw JSON event payloads ({id,type,properties})
	prompts  []string       // bodies POSTed to /session/:id/message (prompt passthrough)
	msgGets  map[string]int // GET /session/:id/message hit counts (lazy-hydration test)
}

func newFake() *fakeOpenCode {
	return &fakeOpenCode{
		messages: map[string]string{},
		msgGets:  map[string]int{},
		events:   make(chan string, 16),
	}
}

func (f *fakeOpenCode) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		fmt.Fprintf(w, "[%s]", strings.Join(f.sessions, ","))
	})
	mux.HandleFunc("/session/", func(w http.ResponseWriter, r *http.Request) {
		// /session/{id}/message — GET lists, POST is a prompt.
		id := strings.TrimPrefix(r.URL.Path, "/session/")
		id = strings.TrimSuffix(id, "/message")
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			f.prompts = append(f.prompts, string(body))
			fmt.Fprint(w, "{}")
			return
		}
		f.msgGets[id]++
		if m, ok := f.messages[id]; ok {
			fmt.Fprint(w, m)
			return
		}
		fmt.Fprint(w, "[]")
	})
	mux.HandleFunc("/vcs/diff", func(w http.ResponseWriter, r *http.Request) {
		// Echo the mode so the test can assert query passthrough.
		mode := r.URL.Query().Get("mode")
		fmt.Fprintf(w, `[{"file":"main.go","patch":"@@ -1 +1 @@\n-old\n+new","additions":1,"deletions":1,"status":"modified","mode":%q}]`, mode)
	})
	mux.HandleFunc("/event", func(w http.ResponseWriter, r *http.Request) {
		fl, _ := w.(http.Flusher)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n")
		fl.Flush()
		for {
			select {
			case <-r.Context().Done():
				return
			case payload := <-f.events:
				fmt.Fprintf(w, "data: %s\n\n", payload)
				fl.Flush()
			}
		}
	})
	return mux
}

func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for: %s", msg)
}

func TestEndToEndAggregateAndServe(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{
		`{"id":"root","title":"Root","time":{"updated":2}}`,
		`{"id":"sub","parentID":"root","title":"Subsession","time":{"updated":1}}`,
	}
	fake.messages["root"] = `[{"info":{"id":"m1","sessionID":"root","role":"user"},"parts":[{"id":"p1","sessionID":"root","messageID":"m1","type":"text","text":"hello"}]}]`

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)

	// Hydration should populate the tree (root + subsession).
	waitFor(t, func() bool { return len(agg.Store().Snapshot(nil).Sessions) == 2 }, "hydrate 2 sessions")

	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Snapshot endpoint, scoped to all messages.
	resp, err := http.Get(web.URL + "/vh/snapshot?sessions=all")
	if err != nil {
		t.Fatal(err)
	}
	var snap struct {
		Sessions []json.RawMessage `json:"sessions"`
		Messages map[string]any    `json:"messages"`
	}
	json.NewDecoder(resp.Body).Decode(&snap)
	resp.Body.Close()
	if len(snap.Sessions) != 2 {
		t.Fatalf("snapshot want 2 sessions, got %d", len(snap.Sessions))
	}
	if _, ok := snap.Messages["root"]; !ok {
		t.Fatal("snapshot missing root messages")
	}

	// Stream endpoint: fresh client gets a snapshot event, then a live event.
	streamResp, err := http.Get(web.URL + "/vh/stream?sessions=")
	if err != nil {
		t.Fatal(err)
	}
	defer streamResp.Body.Close()
	reader := bufio.NewReader(streamResp.Body)

	gotSnapshot := readSSEEvent(t, reader)
	if gotSnapshot != "snapshot" {
		t.Fatalf("first stream event want 'snapshot', got %q", gotSnapshot)
	}

	// Push a live session.created via the fake event stream.
	fake.events <- `{"type":"session.created","properties":{"info":{"id":"root2","title":"Second root"}}}`
	gotLive := readSSEEvent(t, reader)
	if gotLive != "session.upsert" {
		t.Fatalf("live event want 'session.upsert', got %q", gotLive)
	}
	waitFor(t, func() bool { return len(agg.Store().Snapshot(nil).Sessions) == 3 }, "live event applied")
}

// readSSEEvent reads frames until it sees an `event:` line and returns its value,
// skipping `: ping` comments. Fails on timeout via the underlying read.
func readSSEEvent(t *testing.T, r *bufio.Reader) string {
	t.Helper()
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("read stream: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(line, "event:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
	}
}

func TestPromptPassthrough(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"root","title":"Root"}`}
	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 100)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// The composer POSTs here; /oc prefix is stripped and proxied to OpenCode.
	body := `{"parts":[{"type":"text","text":"hello"}]}`
	req, _ := http.NewRequest(http.MethodPost, web.URL+"/oc/session/root/message", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(csrfHeader, "1") // CSRF guard requires it on mutating /oc requests
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	waitFor(t, func() bool {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return len(fake.prompts) == 1 && strings.Contains(fake.prompts[0], "hello")
	}, "prompt reached opencode via passthrough")
}

func TestVcsDiffPassthrough(t *testing.T) {
	fake := newFake()
	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 100)
	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// GitView fetches this; /oc prefix stripped, query (mode) preserved.
	resp, err := http.Get(web.URL + "/oc/vcs/diff?mode=branch")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"file":"main.go"`) {
		t.Fatalf("vcs diff not proxied: %s", body)
	}
	if !strings.Contains(string(body), `"mode":"branch"`) {
		t.Fatalf("query param not preserved through passthrough: %s", body)
	}
}

func TestStreamResumeReplaysFromCursor(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(nil).Sessions) == 1 }, "hydrate")

	headBefore := agg.Store().Snapshot(nil).Seq

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Emit one more event so there's something to replay past the cursor.
	fake.events <- `{"type":"session.created","properties":{"info":{"id":"b","title":"B"}}}`
	waitFor(t, func() bool { return agg.Store().Snapshot(nil).Seq > headBefore }, "live event recorded")

	// Resume from headBefore: should replay the newer event(s), not a snapshot.
	resp, err := http.Get(fmt.Sprintf("%s/vh/stream?cursor=%d", web.URL, headBefore))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	first := readSSEEvent(t, reader)
	if first == "snapshot" {
		t.Fatal("resume from valid cursor should replay events, not send a snapshot")
	}
	if first != "session.upsert" {
		t.Fatalf("want replayed 'session.upsert', got %q", first)
	}
}

// TestLazyHydration verifies messages are NOT fetched per-session at startup,
// only when a client opens a session (GET /vh/snapshot?sessions=id).
func TestLazyHydration(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{
		`{"id":"a","title":"A","time":{"updated":2}}`,
		`{"id":"b","title":"B","time":{"updated":1}}`,
	}
	fake.messages["a"] = `[{"info":{"id":"m1","sessionID":"a","role":"user"},"parts":[]}]`
	fake.messages["b"] = `[{"info":{"id":"m2","sessionID":"b","role":"user"},"parts":[]}]`

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(map[string]bool{}).Sessions) == 2 }, "hydrate 2 sessions")

	// At startup, no session's FULL message history is hydrated — the aggregator
	// fetches only a lightweight message tail per session (to seed lastAgent for
	// the tree's per-agent chips on a cold tree), never the full transcript. The
	// lazy contract is "full transcripts load on open", which the tree-only
	// snapshot confirms: its Messages map is empty.
	if agg.Store().IsMessagesLoaded("a") || agg.Store().IsMessagesLoaded("b") {
		t.Fatal("startup must not fully hydrate any session's messages (lazy)")
	}
	if got := len(agg.Store().Snapshot(map[string]bool{}).Messages); got != 0 {
		t.Fatalf("tree-only snapshot must carry no full transcripts, got %d sessions", got)
	}

	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Opening session "a" loads only a's messages.
	resp, err := http.Get(web.URL + "/vh/snapshot?sessions=a")
	if err != nil {
		t.Fatal(err)
	}
	var snap struct {
		Messages map[string][]json.RawMessage `json:"messages"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&snap)
	resp.Body.Close()
	if len(snap.Messages["a"]) != 1 {
		t.Fatalf("expected a's 1 message after open, got %d", len(snap.Messages["a"]))
	}

	// Opening "a" fully hydrates only a; "b" stays lazy (never opened). The raw
	// fetch count is no longer the invariant (a lightweight tail is fetched per
	// session at startup for lastAgent chips); the invariant is which sessions
	// have their FULL transcript loaded.
	if !agg.Store().IsMessagesLoaded("a") {
		t.Fatal("opening 'a' must fully hydrate its messages")
	}
	if agg.Store().IsMessagesLoaded("b") {
		t.Fatal("'b' must remain un-hydrated (never opened)")
	}
}

// TestCSRFGuard verifies state-changing API requests require the custom header,
// reads don't, and the side-effect-free /vh/render is exempt.
func TestCSRFGuard(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	ws := httptest.NewServer(csrfGuard(next))
	defer ws.Close()

	post := func(path string, withHeader bool) int {
		req, _ := http.NewRequest(http.MethodPost, ws.URL+path, nil)
		if withHeader {
			req.Header.Set(csrfHeader, "1")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if got := post("/oc/session/x/message", false); got != http.StatusForbidden {
		t.Fatalf("POST /oc without header: want 403, got %d", got)
	}
	if got := post("/oc/session/x/message", true); got != http.StatusOK {
		t.Fatalf("POST /oc with header: want 200, got %d", got)
	}
	if got := post("/vh/reload", false); got != http.StatusForbidden {
		t.Fatalf("POST /vh/reload without header: want 403, got %d", got)
	}
	if got := post("/vh/render", false); got != http.StatusOK {
		t.Fatalf("POST /vh/render is exempt: want 200, got %d", got)
	}
	// Reads are never guarded.
	resp, err := http.Get(ws.URL + "/oc/session")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /oc: want 200, got %d", resp.StatusCode)
	}
}

// TestCORS verifies the origin allowlist: allowed origins get CORS headers
// (incl. the CSRF header) and preflight; disallowed origins get none.
func TestCORS(t *testing.T) {
	fake := newFake()
	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()
	srv, _ := NewServer(aggregator.New(ocSrv.URL, 10), ocSrv.URL, 1000)
	srv.SetCORSOrigins([]string{"https://app.example.com"})
	ws := httptest.NewServer(srv.Handler())
	defer ws.Close()

	// Preflight from an allowed origin → 204 with CORS headers incl. X-VH-CSRF.
	req, _ := http.NewRequest(http.MethodOptions, ws.URL+"/oc/session/x/message", nil)
	req.Header.Set("Origin", "https://app.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight want 204, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Fatalf("ACAO want allowed origin, got %q", got)
	}
	if h := resp.Header.Get("Access-Control-Allow-Headers"); !strings.Contains(h, csrfHeader) {
		t.Fatalf("allow-headers should include %s, got %q", csrfHeader, h)
	}

	// Disallowed origin → no CORS headers.
	req2, _ := http.NewRequest(http.MethodOptions, ws.URL+"/oc/session/x/message", nil)
	req2.Header.Set("Origin", "https://evil.example.com")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if got := resp2.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("disallowed origin must get no ACAO, got %q", got)
	}
}

// TestSecurityHeaders verifies the CSP (and friends) are sent on the document.
func TestSecurityHeaders(t *testing.T) {
	fake := newFake()
	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()
	srv, _ := NewServer(aggregator.New(ocSrv.URL, 10), ocSrv.URL, 1000)
	ws := httptest.NewServer(srv.Handler())
	defer ws.Close()

	resp, err := http.Get(ws.URL + "/vh/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	csp := resp.Header.Get("Content-Security-Policy")
	// Dev-relaxed script-src, but external resource loading/exfiltration stays
	// blocked: no external origins in default-src/connect-src/img-src.
	if !strings.Contains(csp, "default-src 'self'") {
		t.Fatalf("CSP missing default-src 'self': %q", csp)
	}
	if !strings.Contains(csp, "connect-src 'self'") {
		t.Fatalf("CSP must keep connect-src 'self' to block exfiltration: %q", csp)
	}
	if !strings.Contains(csp, "img-src 'self' data: blob:") {
		t.Fatalf("CSP must restrict img-src to self/data/blob: %q", csp)
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing X-Content-Type-Options: nosniff")
	}
	// SAMEORIGIN (not DENY): the app frames its own code viewer same-origin;
	// cross-origin framing stays blocked.
	if resp.Header.Get("X-Frame-Options") != "SAMEORIGIN" {
		t.Fatal("expected X-Frame-Options: SAMEORIGIN")
	}
	if !strings.Contains(csp, "frame-ancestors 'self'") {
		t.Fatalf("CSP frame-ancestors should be 'self': %q", csp)
	}
}
