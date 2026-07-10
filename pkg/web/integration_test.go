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
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
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
	// msgFullGets counts ONLY full-history GETs (no ?limit= query) — the
	// single-flight invariant. Cold-seed tail fetches (?limit=) and other
	// partial GETs are excluded so a test can assert "exactly ONE full fetch
	// served all concurrent callers" robustly, independent of background
	// cold-seed tail noise. Mirrors the msgFullGetReady signal's full-vs-tail
	// discrimination.
	msgFullGets map[string]int
	holdMu      sync.Mutex
	// msgHold lets a test BLOCK the full-message GET for a session until the
	// chan is closed — used by the async-hydration test to assert the snapshot
	// lands BEFORE the upstream fetch completes. nil (default) = no hold.
	msgHold map[string]chan struct{}
	// msgFullGetReady, if non-nil, is signalled (non-blocking) once per
	// FULL-history message GET — a request with no ?limit= query — right
	// BEFORE it blocks on msgHold[id]. A sync-path test (the /vh/snapshot
	// EnsureMessages path) uses it to deterministically wait for the GET to be
	// in flight: by the time the fake receives that request, EnsureMessages
	// has ALREADY called MarkColdFetchStart, so the test can safely inject
	// live events that must tag their entries. nil (default) = no signal, so
	// existing tests are unaffected. Cold-seed tail GETs carry ?limit= and are
	// never signalled here.
	msgFullGetReady chan struct{}
}

func newFake() *fakeOpenCode {
	return &fakeOpenCode{
		messages:    map[string]string{},
		msgGets:     map[string]int{},
		msgFullGets: map[string]int{},
		msgHold:     map[string]chan struct{}{},
		events:      make(chan string, 16),
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
		// Optional per-session hold: if a test registered a chan for this id,
		// block here until it's closed. Wait OUTSIDE f.mu so the session-list
		// endpoint (which also locks f.mu) can't deadlock against a held fetch.
		f.holdMu.Lock()
		hold := f.msgHold[id]
		f.holdMu.Unlock()
		// Optional rendezvous for sync-path tests: signal that a FULL-history
		// GET (no ?limit=) has arrived and is about to block on the hold — at
		// which point EnsureMessages has already set coldFetchActive. Tail
		// GETs (?limit=) are not signalled. Non-blocking; default-dropped if
		// the test isn't reading, so it can never wedge the handler.
		if hold != nil && r.URL.Query().Get("limit") == "" && f.msgFullGetReady != nil {
			select {
			case f.msgFullGetReady <- struct{}{}:
			default:
			}
		}
		if hold != nil {
			<-hold
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			f.prompts = append(f.prompts, string(body))
			fmt.Fprint(w, "{}")
			return
		}
		f.msgGets[id]++
		// Full-history GET only (no ?limit=) — the single-flight invariant
		// counter. Tail GETs (?limit=) are excluded.
		if r.URL.Query().Get("limit") == "" {
			f.msgFullGets[id]++
		}
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

// readSSEFrame reads one full SSE frame (until the terminating blank line) and
// returns its event name + the (single) data payload. Used by the async test
// which needs to inspect the snapshot body, not just the event kind.
func readSSEFrame(t *testing.T, r *bufio.Reader) (event, data string) {
	t.Helper()
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("read stream: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if event != "" {
				return event, data
			}
			continue // leading blank / separator
		}
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
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

// TestStreamAsyncHydration verifies the Stream-2 first-open path no longer
// blocks the snapshot behind the synchronous full-message fetch (Slice C).
// Selecting an unloaded session must send a partial snapshot IMMEDIATELY (before
// the upstream GET /session/:id/message completes), then forward the
// reconciled content + the messages.loaded completion over the SAME open
// connection as the background fetch reconciles. Because the held fetch is a
// cold-load for this session (msgLoaded was false at entry), the cold-load
// contract pinned by store_test.go::TestColdLoadEmitsSingleMessagesBatch sends
// the reconciled content as a single KindMessagesBatch ("messages.batch") event
// (NOT per-message message.upsert events) followed by messages.loaded.
func TestStreamAsyncHydration(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	fake.messages["a"] = `[{"info":{"id":"m1","sessionID":"a","role":"user"},"parts":[{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"hi"}]}]`
	// Hold the full-message GET open so the snapshot observably lands first.
	hold := make(chan struct{})
	fake.msgHold["a"] = hold

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(map[string]bool{}).Sessions) == 1 }, "hydrate session a")

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Fresh Stream-2 client for session "a". The snapshot must land BEFORE the
	// held full-message fetch completes — the old sync path (ensureMessages)
	// would have blocked here until GET /session/a/message returned.
	resp, err := http.Get(web.URL + "/vh/stream?sessions=a")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)

	ev, data := readSSEFrame(t, reader)
	if ev != "snapshot" {
		t.Fatalf("first frame want 'snapshot', got %q", ev)
	}
	var snap struct {
		Messages map[string][]json.RawMessage `json:"messages"`
		Gate     map[string]struct {
			MessagesLoaded bool `json:"messagesLoaded"`
		} `json:"gate"`
	}
	if err := json.Unmarshal([]byte(data), &snap); err != nil {
		t.Fatal(err)
	}
	if len(snap.Messages["a"]) != 0 {
		t.Fatalf("async snapshot must NOT carry messages while fetch in flight, got %d", len(snap.Messages["a"]))
	}
	// Gate is built for every known session regardless of the message filter, so
	// "a" must be present and report NOT-yet-loaded.
	if g, ok := snap.Gate["a"]; !ok {
		t.Fatal("async snapshot gate missing session a")
	} else if g.MessagesLoaded {
		t.Fatal("async snapshot gate must report messagesLoaded=false while fetch in flight")
	}

	// Release the held fetch — the background hydration now completes and the
	// SAME connection receives the reconciled content (a single messages.batch
	// for this cold-load, per the contract above) + the messages.loaded
	// completion event.
	close(hold)

	var sawMessagesBatch, sawLoaded bool
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !(sawMessagesBatch && sawLoaded) {
		ev, _ = readSSEFrame(t, reader)
		switch ev {
		case "messages.batch":
			sawMessagesBatch = true
		case "messages.loaded":
			sawLoaded = true
		}
	}
	if !sawMessagesBatch {
		t.Fatal("stream must forward messages.batch after the background fetch reconciles the cold-load")
	}
	if !sawLoaded {
		t.Fatal("stream must forward messages.loaded completion after the background fetch")
	}
	// The completion marked the session loaded server-side.
	waitFor(t, func() bool { return agg.Store().IsMessagesLoaded("a") }, "session a loaded after completion")
}

// TestStreamAsyncHydrationLiveUpdateDuringFetch pins the O2 background-hydration
// ordering contract that TestStreamAsyncHydration does NOT cover: a LIVE upstream
// message/part update landing on the event tail WHILE the unbounded full-history
// GET is in flight, then the stale-but-now-arriving full reconciliation must NOT
// clobber the newer live state.
//
// The store's reconcile (SetSessionMessages -> reconcileMessagesLocked) treats the
// fetched list as authoritative: messages present in the store but ABSENT from the
// fetch are deleted (store.go ~2047-2057). When a live event arrives during the
// in-flight fetch, the fetch snapshot is stale relative to that live state, so the
// reconciliation must not discard the live message. This test forces the
// live-arrives-first ordering deterministically (waitFor m2 in store BEFORE
// releasing the held GET) so the only variable is whether reconcile preserves m2.
func TestStreamAsyncHydrationLiveUpdateDuringFetch(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	// The stale full-history GET returns ONLY m1 (the pre-live state). m2 is
	// injected purely via the live event tail and is deliberately ABSENT from
	// the fetched list, so a presence-based reconcile would delete it.
	fake.messages["a"] = `[{"info":{"id":"m1","sessionID":"a","role":"user"},"parts":[{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"hi"}]}]`
	hold := make(chan struct{})
	fake.msgHold["a"] = hold

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(map[string]bool{}).Sessions) == 1 }, "hydrate session a")

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Open the stream for session "a": this triggers EnsureMessagesAsync, whose
	// background GET blocks on the hold. The partial snapshot proves the GET is
	// in flight (the frame lands before the upstream fetch completes).
	resp, err := http.Get(web.URL + "/vh/stream?sessions=a")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	ev, _ := readSSEFrame(t, reader)
	if ev != "snapshot" {
		t.Fatalf("first frame want 'snapshot', got %q", ev)
	}

	// WHILE the full GET is held, inject LIVE upstream updates via the event tail
	// (the same path the daemon subscribes to in production):
	//  - m2: a brand-new assistant message, deliberately ABSENT from the fetch
	//    (not added to fake.messages) so a presence-based message reconcile would
	//    delete it. This pins the message delete-missing gate.
	//  - p2: m2's text part (under the live m2).
	//  - p1b: a brand-new text part under m1 — the FETCHED message. m1 is in the
	//    fetch but only with p1, so p1b is absent from the fetched part list; a
	//    presence-based PART reconcile would delete it. This pins the part
	//    delete-missing gate (the same bug class, on the per-message part loop).
	fake.events <- `{"type":"message.updated","properties":{"info":{"id":"m2","sessionID":"a","role":"assistant","agent":"test"}}}`
	fake.events <- `{"type":"message.part.updated","properties":{"part":{"id":"p2","sessionID":"a","messageID":"m2","type":"text","text":"live!"}}}`
	fake.events <- `{"type":"message.part.updated","properties":{"part":{"id":"p1b","sessionID":"a","messageID":"m1","type":"text","text":"live-extra"}}}`

	// Snapshot helpers to read the reconciled store state.
	msgIDs := func() map[string]bool {
		ids := map[string]bool{}
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var env struct {
				ID string `json:"id"`
			}
			json.Unmarshal(mwp.Info, &env)
			ids[env.ID] = true
		}
		return ids
	}
	partIDs := func(msgID string) map[string]bool {
		ids := map[string]bool{}
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var env struct {
				ID string `json:"id"`
			}
			json.Unmarshal(mwp.Info, &env)
			if env.ID != msgID {
				continue
			}
			for _, part := range mwp.Parts {
				var pe struct {
					ID string `json:"id"`
				}
				json.Unmarshal(part, &pe)
				ids[pe.ID] = true
			}
		}
		return ids
	}
	// partExists scans every message's parts in session a (regardless of message
	// Info), so it also observes a part attached to a placeholder message whose
	// info is still nil (the upsertPartLocked "part before message.updated"
	// placeholder created when a live part lands before its fetched message).
	partExists := func(partID string) bool {
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			for _, part := range mwp.Parts {
				var pe struct {
					ID string `json:"id"`
				}
				json.Unmarshal(part, &pe)
				if pe.ID == partID {
					return true
				}
			}
		}
		return false
	}

	// Guarantee the live events have been applied to the store BEFORE releasing
	// the held GET. This removes all timing nondeterminism: the only remaining
	// variable is whether reconcileMessagesLocked preserves m2 and p1b.
	waitFor(t, func() bool { return msgIDs()["m2"] }, "live message m2 applied to store during in-flight fetch")
	waitFor(t, func() bool { return partExists("p1b") }, "live part p1b applied to store during in-flight fetch")

	// Release the held stale GET -> the background reconciliation completes.
	close(hold)
	waitFor(t, func() bool { return agg.Store().IsMessagesLoaded("a") }, "session a loaded after stale reconcile")

	// CONTRACT: the final store must reflect BOTH the reconciled full history
	// (m1) AND the newer live updates (m2 + p1b). The stale reconciliation must
	// NOT have deleted a live message/part merely because it was absent from the
	// fetch snapshot.
	ids := msgIDs()
	if !ids["m1"] {
		t.Errorf("reconciled full history missing m1: %v", ids)
	}
	if !ids["m2"] {
		t.Errorf("LIVE UPDATE CLOBBERED: stale reconcile deleted m2 (absent from fetch snapshot) — store has %v", ids)
	}
	// m1's parts: the fetched p1 AND the live-arrived p1b must both survive.
	m1Parts := partIDs("m1")
	if !m1Parts["p1"] {
		t.Errorf("reconciled full history missing m1/p1: %v", m1Parts)
	}
	if !m1Parts["p1b"] {
		t.Errorf("LIVE PART CLOBBERED: stale reconcile deleted m1/p1b (absent from fetch snapshot) — m1 parts %v", m1Parts)
	}
	// m2's live part p2 must survive (it lives under the live message m2).
	m2Parts := partIDs("m2")
	if !m2Parts["p2"] {
		t.Errorf("live part m2/p2 missing after reconcile: %v", m2Parts)
	}
}

// TestStreamAsyncHydrationContentPrecedenceDuringFetch pins C-F2: the cold-load
// reconcile must NOT overwrite the BODY of an existing entry whose content a
// live event updated during the in-flight full-history GET. The stale fetched
// body (captured before the live update) must lose to the newer live body.
//
// Sibling to TestStreamAsyncHydrationLiveUpdateDuringFetch, which pins the
// PRESENCE case (live-arrived entries absent from the fetch must survive — the
// 248c402 delete-missing gate). This test pins the CONTENT case: an entry
// present in BOTH the fetch and the store, where the store copy is newer
// because a live event touched it mid-fetch. The common streaming scenario is
// an assistant part appending text while the background GET is in flight.
func TestStreamAsyncHydrationContentPrecedenceDuringFetch(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	// The stale full-history GET returns m1 with p1 text "fetched-stale" and
	// role "user" (the pre-live state). During the in-flight GET, LIVE events
	// will UPDATE both p1's body and m1's body to NEWER content.
	fake.messages["a"] = `[{"info":{"id":"m1","sessionID":"a","role":"user"},"parts":[{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"fetched-stale"}]}]`
	hold := make(chan struct{})
	fake.msgHold["a"] = hold

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(map[string]bool{}).Sessions) == 1 }, "hydrate session a")

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Open the stream for session "a" → EnsureMessagesAsync → background GET
	// blocks on the hold. The partial snapshot proves the GET is in flight.
	resp, err := http.Get(web.URL + "/vh/stream?sessions=a")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	ev, _ := readSSEFrame(t, reader)
	if ev != "snapshot" {
		t.Fatalf("first frame want 'snapshot', got %q", ev)
	}

	// Helpers to read reconciled store content.
	partText := func(msgID, partID string) string {
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var mi struct {
				ID string `json:"id"`
			}
			json.Unmarshal(mwp.Info, &mi)
			if mi.ID != msgID {
				continue
			}
			for _, part := range mwp.Parts {
				var pe struct {
					ID   string `json:"id"`
					Text string `json:"text"`
				}
				json.Unmarshal(part, &pe)
				if pe.ID == partID {
					return pe.Text
				}
			}
		}
		return ""
	}
	msgRoleCompleted := func(msgID string) (role string, completed bool) {
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var mi struct {
				ID   string `json:"id"`
				Role string `json:"role"`
				Time struct {
					Completed *float64 `json:"completed"`
				} `json:"time"`
			}
			json.Unmarshal(mwp.Info, &mi)
			if mi.ID == msgID {
				return mi.Role, mi.Time.Completed != nil
			}
		}
		return "", false
	}

	// WHILE the full GET is held, inject LIVE updates to EXISTING entries
	// (same IDs as the fetched list) with NEWER content — the common
	// streaming-overwrite case:
	//  - p1 text "fetched-stale" → "live-newer" (a content body overwrite).
	//  - m1 body role "user" → "assistant" + completion (a message body
	//    overwrite — the cached role/completed fields are also at stake).
	fake.events <- `{"type":"message.part.updated","properties":{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"live-newer"}}}`
	fake.events <- `{"type":"message.updated","properties":{"info":{"id":"m1","sessionID":"a","role":"assistant","agent":"test","time":{"completed":999}}}}`

	// Guarantee the live events have been applied BEFORE releasing the held GET
	// (removes all timing nondeterminism — the only variable is whether
	// reconcileMessagesLocked preserves the live content).
	waitFor(t, func() bool { return partText("m1", "p1") == "live-newer" }, "live part p1 content applied to store during in-flight fetch")
	waitFor(t, func() bool {
		role, completed := msgRoleCompleted("m1")
		return role == "assistant" && completed
	}, "live message m1 body applied to store during in-flight fetch")

	// Release the held stale GET → the cold reconcile completes.
	close(hold)
	waitFor(t, func() bool { return agg.Store().IsMessagesLoaded("a") }, "session a loaded after stale reconcile")

	// CONTRACT (C-F2): the LIVE body must survive the stale reconcile. The
	// fetched body ("fetched-stale" / role "user") must NOT overwrite the
	// live-newer body that arrived during the fetch window.
	if got := partText("m1", "p1"); got != "live-newer" {
		t.Errorf("LIVE PART BODY CLOBBERED: p1 text after reconcile want %q, got %q (stale fetched body won)", "live-newer", got)
	}
	role, completed := msgRoleCompleted("m1")
	if role != "assistant" {
		t.Errorf("LIVE MESSAGE BODY CLOBBERED: m1 role after reconcile want %q, got %q (stale fetched role won)", "assistant", role)
	}
	if !completed {
		t.Errorf("LIVE MESSAGE BODY CLOBBERED: m1 completion lost after reconcile (stale fetched body won)")
	}
}

// TestStreamAsyncHydrationDeltaPrecedenceDuringFetch pins the C-F2 delta path:
// a streaming message.part.delta that accumulates live text while the async
// full-history GET is in flight must survive the cold reconcile. It is the
// streaming-text sibling of TestStreamAsyncHydrationContentPrecedenceDuringFetch
// (which pins the message.part.updated snapshot path): both exercise the same
// live-touched-part guard, but this one drives it through the delta accumulator
// (appendPartDeltaLocked → liveTouchedParts tag at store.go ~1416) instead of an
// authoritative part snapshot.
//
// The fetched GET returns p1 with stale text "fetched-stale"; LIVE deltas
// accumulate "live-newer" on p1 while the GET is held. The cold reconcile must
// preserve the live-accumulated text, not clobber it with "fetched-stale".
//
// NOTE on deltaBuf isolation: the deltaBuf-survives-reconcile guard
// (store.go ~2090) is exercised only when delta text is STILL UNFLUSHED in the
// accumulator at reconcile time. Snapshot flushes the accumulator on every read
// (flushPartDeltasLocked emit=false), and deltaFlushInterval is an unexported
// pkg/state var this package cannot override without touching store.go. So this
// test asserts the flushed accumulated-text win (the part-body guard,
// store.go ~2108, applied to delta-derived content + the appendPartDeltaLocked
// tag). Asserting the deltaBuf-only path is left as a follow-up (it needs a
// pkg/state test or an exported test hook).
func TestStreamAsyncHydrationDeltaPrecedenceDuringFetch(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	// The stale full-history GET returns m1 with p1 text "fetched-stale". LIVE
	// deltas arriving mid-fetch will accumulate "live-newer" on p1 instead.
	fake.messages["a"] = `[{"info":{"id":"m1","sessionID":"a","role":"user"},"parts":[{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"fetched-stale"}]}]`
	hold := make(chan struct{})
	fake.msgHold["a"] = hold
	// RENDEZVOUS (CF3): the fake non-blocking-signals here once the FULL-history
	// GET (no ?limit=) arrives and is about to block on the hold — at which
	// point the async goroutine has ALREADY run MarkColdFetchStart (it precedes
	// client.Messages inside the goroutine), so coldFetchActive["a"] is set.
	// Waiting on this before injecting deltas removes the race where the deltas
	// apply before the flag is set (goroutine not yet scheduled) → tags unset →
	// intermittent failure. Mirrors the sync test's msgFullGetReady hook. nil by
	// default so unrelated tests are unaffected.
	notify := make(chan struct{}, 1)
	fake.msgFullGetReady = notify

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(map[string]bool{}).Sessions) == 1 }, "hydrate session a")

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Open the stream for session "a" → EnsureMessagesAsync → background GET
	// blocks on the hold. The partial snapshot proves the GET is in flight.
	resp, err := http.Get(web.URL + "/vh/stream?sessions=a")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	ev, _ := readSSEFrame(t, reader)
	if ev != "snapshot" {
		t.Fatalf("first frame want 'snapshot', got %q", ev)
	}

	// RENDEZVOUS (CF3): block until the async fetch goroutine has reached the
	// full GET (blocked on the hold). By construction MarkColdFetchStart ran
	// before client.Messages, so coldFetchActive["a"] is now deterministically
	// set and the live deltas injected below will tag liveTouchedParts.
	<-notify

	partText := func(msgID, partID string) string {
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var mi struct {
				ID string `json:"id"`
			}
			json.Unmarshal(mwp.Info, &mi)
			if mi.ID != msgID {
				continue
			}
			for _, part := range mwp.Parts {
				var pe struct {
					ID   string `json:"id"`
					Text string `json:"text"`
				}
				json.Unmarshal(part, &pe)
				if pe.ID == partID {
					return pe.Text
				}
			}
		}
		return ""
	}

	// WHILE the full GET is held, inject LIVE streaming deltas on p1 (the same
	// wire shape the daemon's event tail delivers). Two deltas accumulate to
	// "live-newer" via appendPartDeltaLocked's native accumulator. A
	// message.updated for m1 first establishes the assistant-message shell the
	// deltas stream into (the realistic cold-streaming case: an assistant turn
	// generating while the history GET is in flight) and gives m1 an info.id so
	// partText can locate it; the part CONTENT comes only from the deltas.
	// Because coldFetchActive is set (the async path marks it before the GET),
	// the message.updated tags liveTouchedBody and each delta tags
	// liveTouchedParts["p1"]=true.
	fake.events <- `{"type":"message.updated","properties":{"info":{"id":"m1","sessionID":"a","role":"assistant","agent":"test"}}}`
	fake.events <- `{"type":"message.part.delta","properties":{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"live-"}}`
	fake.events <- `{"type":"message.part.delta","properties":{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"newer"}}`

	// Guarantee BOTH live deltas have been applied BEFORE releasing the held
	// GET. This read deterministically flushes the accumulator (Snapshot calls
	// flushPartDeltasLocked), so once it returns "live-newer" both deltas are
	// applied AND persisted into me.parts[p1]. Removes all timing
	// nondeterminism: the only remaining variable is whether the reconcile
	// preserves the live-accumulated text.
	waitFor(t, func() bool { return partText("m1", "p1") == "live-newer" }, "live deltas accumulated on p1 during in-flight fetch")

	// Release the held stale GET → the cold reconcile completes.
	close(hold)
	waitFor(t, func() bool { return agg.Store().IsMessagesLoaded("a") }, "session a loaded after stale reconcile")

	// CONTRACT (C-F2): the LIVE-accumulated delta text must survive the stale
	// reconcile. The fetched body ("fetched-stale") must NOT overwrite the
	// "live-newer" text that the streaming deltas produced during the fetch
	// window. Without the appendPartDeltaLocked live-touched tag the entry is
	// untagged and the reconcile clobbers it with "fetched-stale".
	if got := partText("m1", "p1"); got != "live-newer" {
		t.Errorf("LIVE DELTA TEXT CLOBBERED: p1 text after reconcile want %q, got %q (stale fetched body won)", "live-newer", got)
	}
}

// TestSyncSnapshotContentPrecedenceDuringFetch pins C-F2 on the SYNCHRONOUS
// path: GET /vh/snapshot drives EnsureMessages (the blocking full-history GET),
// which must — like EnsureMessagesAsync — mark cold-fetch-active for the
// duration of the GET. A live event arriving during that blocking GET must tag
// its entries so the cold reconcile preserves the newer live content instead of
// clobbering it with the stale fetched body. Before the F2 fix EnsureMessages
// did NOT call MarkColdFetchStart, so a live update landing mid-fetch was
// untagged and the reconcile overwrote it (C-F2 on the sync path).
//
// Sibling to TestStreamAsyncHydrationContentPrecedenceDuringFetch, which pins
// the same contract on the ASYNC (stream) path. This test drives the one-shot
// sync endpoint directly: the snapshot request blocks inside EnsureMessages on
// the held upstream GET, live events are injected mid-fetch, then the hold is
// released and the reconciled snapshot response is asserted to carry the LIVE
// content (not the stale fetched body).
func TestSyncSnapshotContentPrecedenceDuringFetch(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	// The stale full-history GET returns m1 with p1 text "fetched-stale" and
	// role "user" (the pre-live state). During the in-flight GET, LIVE events
	// UPDATE both p1's body and m1's body to NEWER content.
	fake.messages["a"] = `[{"info":{"id":"m1","sessionID":"a","role":"user"},"parts":[{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"fetched-stale"}]}]`
	hold := make(chan struct{})
	fake.msgHold["a"] = hold
	// Rendezvous: the fake signals here when the FULL-history GET (no ?limit=)
	// arrives and is about to block on the hold — i.e. EnsureMessages has
	// reached client.Messages, which means MarkColdFetchStart has run. Cold-seed
	// tail GETs (?limit=) do not signal, so this specifically captures the
	// snapshot path's GET.
	notify := make(chan struct{}, 1)
	fake.msgFullGetReady = notify

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(map[string]bool{}).Sessions) == 1 }, "hydrate session a")

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Drive the SYNC snapshot endpoint in a goroutine: it blocks inside
	// EnsureMessages on the held GET and won't return until the hold is
	// released. GET /vh/snapshot is read-only — no X-VH-CSRF header required
	// (csrfGuard only blocks unsafe methods).
	type snapResult struct {
		resp *http.Response
		err  error
	}
	resCh := make(chan snapResult, 1)
	go func() {
		r, e := http.Get(web.URL + "/vh/snapshot?sessions=a")
		resCh <- snapResult{r, e}
	}()
	// Wait until EnsureMessages' full GET is in flight. By construction the
	// fake only signals this AFTER the request reached the handler, which is
	// AFTER EnsureMessages called MarkColdFetchStart — so coldFetchActive["a"]
	// is now set. Injecting the live events here is the deterministic
	// equivalent of "a live update lands during the in-flight sync GET".
	<-notify

	// Helpers to read reconciled store content.
	partText := func(msgID, partID string) string {
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var mi struct {
				ID string `json:"id"`
			}
			json.Unmarshal(mwp.Info, &mi)
			if mi.ID != msgID {
				continue
			}
			for _, part := range mwp.Parts {
				var pe struct {
					ID   string `json:"id"`
					Text string `json:"text"`
				}
				json.Unmarshal(part, &pe)
				if pe.ID == partID {
					return pe.Text
				}
			}
		}
		return ""
	}
	msgRoleCompleted := func(msgID string) (role string, completed bool) {
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var mi struct {
				ID   string `json:"id"`
				Role string `json:"role"`
				Time struct {
					Completed *float64 `json:"completed"`
				} `json:"time"`
			}
			json.Unmarshal(mwp.Info, &mi)
			if mi.ID == msgID {
				return mi.Role, mi.Time.Completed != nil
			}
		}
		return "", false
	}

	// WHILE the full GET is held, inject LIVE updates with NEWER content:
	//  - p1 text "fetched-stale" → "live-newer".
	//  - m1 role "user" → "assistant" + completion.
	// coldFetchActive is set, so these tag the entries live-touched.
	fake.events <- `{"type":"message.part.updated","properties":{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"live-newer"}}}`
	fake.events <- `{"type":"message.updated","properties":{"info":{"id":"m1","sessionID":"a","role":"assistant","agent":"test","time":{"completed":999}}}}`

	// Guarantee the live events have been applied BEFORE releasing the held GET
	// (removes all timing nondeterminism).
	waitFor(t, func() bool { return partText("m1", "p1") == "live-newer" }, "live part p1 content applied to store during in-flight sync fetch")
	waitFor(t, func() bool {
		role, completed := msgRoleCompleted("m1")
		return role == "assistant" && completed
	}, "live message m1 body applied to store during in-flight sync fetch")

	// Release the held stale GET → the sync reconcile completes and the
	// snapshot endpoint returns its response.
	close(hold)
	res := <-resCh
	if res.err != nil {
		t.Fatalf("snapshot GET: %v", res.err)
	}
	var snapResp struct {
		Messages map[string][]json.RawMessage `json:"messages"`
	}
	if err := json.NewDecoder(res.resp.Body).Decode(&snapResp); err != nil {
		t.Fatalf("decode snapshot response: %v", err)
	}
	res.resp.Body.Close()
	if len(snapResp.Messages["a"]) == 0 {
		t.Fatalf("snapshot response carries no messages for session a")
	}

	// CONTRACT (C-F2, sync path): the LIVE content must survive the stale
	// reconcile — in BOTH the store and the response body the endpoint
	// returned. Without the EnsureMessages MarkColdFetchStart wiring, the live
	// events would be untagged and the fetched "fetched-stale"/role "user"
	// would overwrite them.
	if got := partText("m1", "p1"); got != "live-newer" {
		t.Errorf("LIVE PART BODY CLOBBERED (store): p1 text after reconcile want %q, got %q", "live-newer", got)
	}
	role, completed := msgRoleCompleted("m1")
	if role != "assistant" {
		t.Errorf("LIVE MESSAGE BODY CLOBBERED (store): m1 role after reconcile want %q, got %q", "assistant", role)
	}
	if !completed {
		t.Errorf("LIVE MESSAGE BODY CLOBBERED (store): m1 completion lost after reconcile")
	}
	// The response must also carry the reconciled LIVE content (proving the
	// sync endpoint served the protected state, not the stale fetch).
	respPartText := ""
	for _, raw := range snapResp.Messages["a"] {
		var mwp struct {
			Info  json.RawMessage   `json:"info"`
			Parts []json.RawMessage `json:"parts"`
		}
		json.Unmarshal(raw, &mwp)
		var mi struct {
			ID string `json:"id"`
		}
		json.Unmarshal(mwp.Info, &mi)
		if mi.ID != "m1" {
			continue
		}
		for _, part := range mwp.Parts {
			var pe struct {
				ID   string `json:"id"`
				Text string `json:"text"`
			}
			json.Unmarshal(part, &pe)
			if pe.ID == "p1" {
				respPartText = pe.Text
			}
		}
	}
	if respPartText != "live-newer" {
		t.Errorf("LIVE PART BODY CLOBBERED (response): snapshot response p1 text want %q, got %q", "live-newer", respPartText)
	}
}

// TestSyncSnapshotAsyncCrossPathSingleFlight pins C-F2's single-flight extension
// to EnsureMessages on the MOST REACHABLE trigger: a sync GET /vh/snapshot for a
// session whose async full-history GET (EnsureMessagesAsync, from a concurrent
// /vh/stream first-open) is ALREADY in flight. Before C-F2 the two paths were
// uncoordinated (msgInflight only deduped async-vs-async), so the sync caller
// issued a SECOND full GET; whichever reconcile ran second was a WARM resync
// (coldLoad==false) and authoritatively clobbered the live-arrived content with
// the stale fetched body. After C-F2 the sync caller finds the async winner's
// msgInflight slot, WAITS on its done chan, and re-reads the now-loaded store —
// exactly ONE upstream GET, exactly ONE (cold) reconcile, live content preserved.
//
// Deterministic via rendezvous hooks (msgHold + msgFullGetReady), no sleeps.
func TestSyncSnapshotAsyncCrossPathSingleFlight(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	// The stale full-history GET returns m1/p1 "fetched-stale" + role "user".
	// LIVE events during the in-flight fetch update both to NEWER content.
	fake.messages["a"] = `[{"info":{"id":"m1","sessionID":"a","role":"user"},"parts":[{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"fetched-stale"}]}]`
	hold := make(chan struct{})
	fake.msgHold["a"] = hold
	// Rendezvous: signals when the async winner's full GET is in flight (blocked
	// on the hold) — by then MarkColdFetchStart has run AND the msgInflight slot
	// is registered, so the sync caller is guaranteed to observe the slot.
	notify := make(chan struct{}, 1)
	fake.msgFullGetReady = notify

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(map[string]bool{}).Sessions) == 1 }, "hydrate session a")

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// (1) ASYNC winner: open the stream for session "a" → EnsureMessagesAsync
	// registers the msgInflight slot synchronously and launches the background
	// GET, which blocks on the hold. The partial snapshot proves it is in flight.
	resp, err := http.Get(web.URL + "/vh/stream?sessions=a")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	ev, _ := readSSEFrame(t, reader)
	if ev != "snapshot" {
		t.Fatalf("first frame want 'snapshot', got %q", ev)
	}
	// Wait until the async winner's GET is blocked on the hold — the slot is
	// registered and coldFetchActive is set.
	<-notify

	// (2) SYNC caller: drive GET /vh/snapshot for the SAME cold session in a
	// goroutine. With C-F2 EnsureMessages finds the async slot and WAITS (no
	// second GET); without C-F2 it issues its own GET (also blocks on the hold).
	type snapResult struct {
		resp *http.Response
		err  error
	}
	resCh := make(chan snapResult, 1)
	go func() {
		r, e := http.Get(web.URL + "/vh/snapshot?sessions=a")
		resCh <- snapResult{r, e}
	}()

	// Helpers to read reconciled store content.
	partText := func(msgID, partID string) string {
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var mi struct {
				ID string `json:"id"`
			}
			json.Unmarshal(mwp.Info, &mi)
			if mi.ID != msgID {
				continue
			}
			for _, part := range mwp.Parts {
				var pe struct {
					ID   string `json:"id"`
					Text string `json:"text"`
				}
				json.Unmarshal(part, &pe)
				if pe.ID == partID {
					return pe.Text
				}
			}
		}
		return ""
	}
	msgRole := func(msgID string) string {
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var mi struct {
				ID   string `json:"id"`
				Role string `json:"role"`
			}
			json.Unmarshal(mwp.Info, &mi)
			if mi.ID == msgID {
				return mi.Role
			}
		}
		return ""
	}

	// (3) WHILE the callers are parked on the held GET, inject LIVE updates with
	// NEWER content. coldFetchActive is set, so these tag the entries live-touched
	// and the subsequent cold reconcile must preserve them. These are gated by
	// waitFor below so the hold is never released before they are applied.
	fake.events <- `{"type":"message.part.updated","properties":{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"live-newer"}}}`
	fake.events <- `{"type":"message.updated","properties":{"info":{"id":"m1","sessionID":"a","role":"assistant","agent":"test"}}}`
	waitFor(t, func() bool { return partText("m1", "p1") == "live-newer" }, "live part p1 applied during in-flight fetch")
	waitFor(t, func() bool { return msgRole("m1") == "assistant" }, "live message m1 role applied during in-flight fetch")

	// (4) Release the held stale GET → the async winner's cold reconcile completes
	// (preserving the live content). The sync waiter wakes (IsMessagesLoaded →
	// true) and the snapshot endpoint returns the reconciled LIVE content.
	close(hold)
	res := <-resCh
	if res.err != nil {
		t.Fatalf("snapshot GET: %v", res.err)
	}
	var snapResp struct {
		Messages map[string][]json.RawMessage `json:"messages"`
	}
	if err := json.NewDecoder(res.resp.Body).Decode(&snapResp); err != nil {
		t.Fatalf("decode snapshot response: %v", err)
	}
	res.resp.Body.Close()
	waitFor(t, func() bool { return agg.Store().IsMessagesLoaded("a") }, "session a loaded after reconcile")

	// CONTRACT (C-F2, sync↔async cross-path): the LIVE content must survive — in
	// both the store and the snapshot response. Without single-flight the sync
	// caller's GET produced a SECOND reconcile (warm resync, coldLoad==false)
	// that clobbered the live content with the stale fetched body.
	if got := partText("m1", "p1"); got != "live-newer" {
		t.Errorf("LIVE PART BODY CLOBBERED (store): p1 text after reconcile want %q, got %q (sync↔async cross-path warm-resync clobber)", "live-newer", got)
	}
	if got := msgRole("m1"); got != "assistant" {
		t.Errorf("LIVE MESSAGE BODY CLOBBERED (store): m1 role after reconcile want %q, got %q", "assistant", got)
	}
	// The snapshot response must carry the reconciled LIVE content too.
	respPartText := ""
	for _, raw := range snapResp.Messages["a"] {
		var mwp struct {
			Info  json.RawMessage   `json:"info"`
			Parts []json.RawMessage `json:"parts"`
		}
		json.Unmarshal(raw, &mwp)
		var mi struct {
			ID string `json:"id"`
		}
		json.Unmarshal(mwp.Info, &mi)
		if mi.ID != "m1" {
			continue
		}
		for _, part := range mwp.Parts {
			var pe struct {
				ID   string `json:"id"`
				Text string `json:"text"`
			}
			json.Unmarshal(part, &pe)
			if pe.ID == "p1" {
				respPartText = pe.Text
			}
		}
	}
	if respPartText != "live-newer" {
		t.Errorf("LIVE PART BODY CLOBBERED (response): snapshot response p1 text want %q, got %q", "live-newer", respPartText)
	}

	// DIRECT GET-count assertion (single-flight dedup observed at the upstream,
	// not just via the clobber symptom): exactly ONE full-history GET for session
	// a — the async winner's. The sync caller found the in-flight slot and
	// WAITED (no second GET). msgFullGets counts ONLY full GETs (no ?limit=), so
	// the cold-seed tail fetch from agg.Run is excluded and the assertion is
	// robust to background hydration ordering.
	fake.mu.Lock()
	fullGets := fake.msgFullGets["a"]
	fake.mu.Unlock()
	if fullGets != 1 {
		t.Errorf("CROSS-PATH SINGLE-FLIGHT: want exactly 1 full-history GET for session a (async winner only), got %d (sync caller bypassed the in-flight slot and issued a redundant fetch)", fullGets)
	}
}

// TestEnsureMessagesTOCTOURecheckUnderLock pins the under-lock IsMessagesLoaded
// re-check (commit-reviewer tier1_b:F1). The ONLY pre-fix loaded-gate in
// EnsureMessages was the UNLOCKED fast-path read, with NO re-check between it
// and the msgMu.Lock. A caller (A) that reads the unlocked gate ==false and is
// then descheduled across a PRIOR winner's (B's) FULL cold-fetch lifecycle — B
// wins the slot, B's GET returns, B's SetSessionMessages sets msgLoaded=true,
// B's defer reclaims the slot under msgMu — will, after re-scheduling, acquire
// msgMu, find NO slot, and become a FRESH winner: a redundant second GET whose
// warm-resync reconcile (coldLoad==false, msgLoaded already true)
// authoritatively clobbers live-arrived content. This is the C-F2 symptom via a
// different path than the synchronous-duplicate-winner case the existing
// single-flight fix already covers.
//
// The fix adds an IsMessagesLoaded re-check UNDER msgMu (after the lock, before
// the slot check): because B sets msgLoaded BEFORE its defer acquires msgMu to
// delete the slot, a caller that acquires msgMu after that defer is guaranteed
// to observe msgLoaded==true and return nil — no second GET, no clobber.
//
// DETERMINISTIC via the test-only SetMsgGateHook rendezvous: the hook fires
// right after the unlocked-gate read, so the test parks caller A there, lets B
// complete its full lifecycle, then releases A. No agg.Run() (so no cold-seed
// tail GET noise); live content is injected directly via Store().Apply while
// B's GET is held (coldFetchActive is set, so the live part is tagged and B's
// cold reconcile preserves it). Verified to FAIL without the under-lock
// re-check (asserts GET count 2 + clobber) and PASS with it.
func TestEnsureMessagesTOCTOURecheckUnderLock(t *testing.T) {
	fake := newFake()
	fake.messages["a"] = `[{"info":{"id":"m1","sessionID":"a","role":"user"},"parts":[{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"fetched"}]}]`
	// Hold the full-history GET so the test controls B's fetch lifecycle.
	hold := make(chan struct{})
	fake.msgHold["a"] = hold
	// notify fires when B's full GET arrives at the fake (about to block on the
	// hold) — by then EnsureMessages has run MarkColdFetchStart, so
	// coldFetchActive["a"] is set and a live part injected now will be tagged.
	notify := make(chan struct{}, 1)
	fake.msgFullGetReady = notify

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()
	agg := aggregator.New(ocSrv.URL, 1000)

	// Test-only rendezvous: park the SECOND EnsureMessages("a") caller right
	// after its unlocked-gate read (the first caller, B, passes through). The
	// test starts B and waits for its GET to be in flight (notify) BEFORE
	// starting A, so the hook's first invocation is deterministically B.
	var gateCount int32
	gateReached := make(chan struct{})
	gateRelease := make(chan struct{})
	agg.SetMsgGateHook(func(sid string) {
		if sid != "a" {
			return
		}
		if atomic.AddInt32(&gateCount, 1) == 1 {
			return // B (the first caller) passes through to win the slot.
		}
		// A (the second caller) is parked here — AFTER the unlocked-gate false
		// read, BEFORE msgMu.Lock — across B's full lifecycle.
		close(gateReached)
		<-gateRelease
	})

	// (1) Winner B: direct EnsureMessages call. Reads the unlocked gate (false),
	// passes the hook, wins the slot, and its GET blocks on the hold.
	// coldFetchActive["a"] is now set.
	bDone := make(chan error, 1)
	go func() { bDone <- agg.EnsureMessages(context.Background(), "a") }()
	<-notify

	// (2) Inject LIVE content while B's GET is held. coldFetchActive is set, so
	// the part is tagged live-touched and B's subsequent cold reconcile preserves
	// it (instead of clobbering it with the stale fetched body "fetched").
	agg.Store().Apply(opencode.Event{Type: "message.updated", Properties: []byte(`{"info":{"id":"m1","sessionID":"a","role":"user"}}`)})
	agg.Store().Apply(opencode.Event{Type: "message.part.updated", Properties: []byte(`{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"live-newer"}}`)})

	// (3) Caller A: started AFTER B's GET is in flight. A reads the unlocked
	// gate (still false — B hasn't reconciled), hits the hook, and PARKS. A has
	// NOT acquired msgMu yet — it is suspended in the TOCTOU window.
	aDone := make(chan error, 1)
	go func() { aDone <- agg.EnsureMessages(context.Background(), "a") }()
	<-gateReached

	// (4) Release B's hold → B completes its FULL lifecycle: GET returns, cold
	// reconcile (preserves the live part), SetSessionMessages sets
	// msgLoaded["a"]=true, defer deletes the slot under msgMu. A is still parked.
	close(hold)
	if err := <-bDone; err != nil {
		t.Fatalf("B EnsureMessages: %v", err)
	}
	if !agg.Store().IsMessagesLoaded("a") {
		t.Fatal("B should have loaded session a")
	}

	// (5) Release A from the hook. A acquires msgMu, finds NO slot (B deleted
	// it). With the under-lock re-check: IsMessagesLoaded==true → return nil (no
	// second GET). WITHOUT the re-check: A becomes a fresh winner → GET #2 →
	// warm-resync reconcile (coldLoad==false) clobbers the live part body.
	close(gateRelease)
	if err := <-aDone; err != nil {
		t.Fatalf("A EnsureMessages: %v", err)
	}

	// CONTRACT 1 (direct GET-count, not just the clobber symptom): exactly ONE
	// upstream full GET for session a (B's). A's under-lock re-check returned
	// nil; without it A would issue a redundant second GET. (msgGets is clean
	// here because agg.Run is never called — no cold-seed tail fetches.)
	fake.mu.Lock()
	gets := fake.msgGets["a"]
	fullGets := fake.msgFullGets["a"]
	fake.mu.Unlock()
	if gets != 1 {
		t.Errorf("TOCTOU: want exactly 1 upstream GET for session a, got %d (A bypassed the under-lock re-check and issued a redundant fetch)", gets)
	}
	if fullGets != 1 {
		t.Errorf("TOCTOU: want exactly 1 full-history GET for session a, got %d", fullGets)
	}

	// CONTRACT 2 (no clobber): the LIVE part body survives. A's warm-resync
	// reconcile (had it run) would have overwritten "live-newer" with the stale
	// fetched body "fetched".
	partText := func(msgID, partID string) string {
		for _, mwp := range agg.Store().Snapshot(map[string]bool{"a": true}).Messages["a"] {
			var mi struct {
				ID string `json:"id"`
			}
			json.Unmarshal(mwp.Info, &mi)
			if mi.ID != msgID {
				continue
			}
			for _, part := range mwp.Parts {
				var pe struct {
					ID   string `json:"id"`
					Text string `json:"text"`
				}
				json.Unmarshal(part, &pe)
				if pe.ID == partID {
					return pe.Text
				}
			}
		}
		return ""
	}
	if got := partText("m1", "p1"); got != "live-newer" {
		t.Errorf("LIVE PART BODY CLOBBERED: p1 text want %q, got %q (A's redundant warm-resync reconcile overwrote the live body)", "live-newer", got)
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

// TestStreamTreeOnlySurvivesTokenFlood is the end-to-end wiring proof for the
// event-delivery latency fix (Option A): a tree-only SSE stream (?sessions=,
// empty filter — drops ALL message-class events) must keep delivering structural
// events promptly while a background session floods token deltas. Before the
// fix, the store subscription queued every message.part.delta (re-emitted as
// part.upsert) into the stream's 256-slot channel; the egress sendable() filter
// discarded them only AFTER they were already queued, so a trailing
// session.upsert landed behind the flood ("session appeared late"). Now the
// interest filter is pushed upstream into store.SubscribeWith, so message-class
// events never enter the channel at all.
func TestStreamTreeOnlySurvivesTokenFlood(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(nil).Sessions) == 1 }, "hydrate session a")

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Tree-only stream: ?sessions= → empty filter → Interest drops ALL
	// message-class events upstream.
	resp, err := http.Get(web.URL + "/vh/stream?sessions=")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	if first := readSSEEvent(t, reader); first != "snapshot" {
		t.Fatalf("first stream event want 'snapshot', got %q", first)
	}

	// Flood: a background session emitting many token deltas, then a trailing
	// structural session.created the operator must see promptly.
	for i := 0; i < 60; i++ {
		fake.events <- `{"type":"message.part.delta","properties":{"sessionID":"bg","messageID":"m1","partID":"p1","field":"text","delta":"x"}}`
	}
	fake.events <- `{"type":"session.created","properties":{"info":{"id":"late","title":"Late"}}}`

	// Wait until the structural event is applied to the store (proves the flood
	// and the session.created both flowed through the aggregator).
	waitFor(t, func() bool {
		for _, s := range agg.Store().Snapshot(nil).Sessions {
			if string(s) == `{"id":"late"}` || strings.Contains(string(s), `"id":"late"`) {
				return true
			}
		}
		return false
	}, "late session applied to store")

	// Read SSE events until the trailing session.upsert arrives. NONE of the
	// events seen along the way may be message-class (message.*/part.*/messages.*)
	// — that would mean a token event leaked past the upstream interest filter.
	// Structural events (activity, etc.) are expected and fine. Bounded by a
	// timeout so a regression fails fast instead of hanging on a lost event.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		kind := readSSEEventWithTimeout(t, reader, 3*time.Second)
		if isMessageClassSSE(kind) {
			t.Fatalf("tree-only stream received message-class event %q — upstream interest filter leaked it", kind)
		}
		if kind == "session.upsert" {
			return // success: structural event arrived, no token event leaked
		}
	}
	t.Fatal("timed out waiting for the trailing session.upsert on the tree-only stream")
}

// isMessageClassSSE mirrors state.isMessageClassKind over the SSE event names
// the server emits (see server.go sendable()). Kept local to avoid a web→state
// kind-name dependency in test code.
func isMessageClassSSE(event string) bool {
	switch event {
	case "message.upsert", "message.delete",
		"part.upsert", "part.delete",
		"messages.loaded", "messages.error":
		return true
	}
	return false
}

// readSSEEventWithTimeout wraps readSSEEvent with a deadline so a missing event
// fails the test fast instead of hanging on the blocking SSE read.
func readSSEEventWithTimeout(t *testing.T, r *bufio.Reader, d time.Duration) string {
	t.Helper()
	type res struct {
		v   string
		err error
	}
	c := make(chan res, 1)
	go func() {
		v, err := readSSEEventErr(r)
		c <- res{v, err}
	}()
	select {
	case got := <-c:
		if got.err != nil {
			t.Fatalf("read stream: %v", got.err)
		}
		return got.v
	case <-time.After(d):
		t.Fatal("timed out reading SSE event")
		return ""
	}
}

// readSSEEventErr is readSSEEvent but returns the error instead of fataling, so
// it can run in a goroutine.
func readSSEEventErr(r *bufio.Reader) (string, error) {
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return "", err
		}
		line = strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(line, "event:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "event:")), nil
		}
	}
}
