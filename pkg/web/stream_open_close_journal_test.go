package web

// stream_open_close_journal_test.go — P4 incident self-capture (2026-10-31
// post-mortem, Gap 1): the /vh/stream handler must emit exactly ONE always-on
// Info "stream open" line per connection carrying the client-identity
// discriminators the post-mortem found missing (User-Agent — THE phone-PWA vs
// desktop discriminator — plus the raw resume cursor, the sessions=/tree=
// query shape, and the remote address), and exactly ONE "stream close" line
// per teardown carrying the disconnect-reason token, the stream lifetime, and
// the UA. Volume discipline is pinned too: a burst of store events flowing
// over an open stream must NOT add journal lines — the two lifecycle lines per
// connection are the whole budget (per-event trace stays behind VH_DEBUG).
//
// The lines are Info (always-on) so capture works on the production binary;
// vhlog.SetOutput intercepts them here (same pattern as
// stream_baseline_fallback_reason_test.go).

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// captureStreamJournal swaps the vhlog sink around `do`, polling (the close
// line lands asynchronously in the handler's defer goroutine after the client
// closes the body) until `done` reports the expected content is present or a
// bounded deadline passes. Returns every captured "stream open" / "stream
// close" line.
//
// vhlog.SetOutput is PROCESS-WIDE: these tests must never call t.Parallel()
// (and no test in pkg/web/pkg/state currently does) without first converting
// this to a test-scoped logger — the same constraint the established
// captureBaselines helper already carries implicitly.
func captureStreamJournal(t *testing.T, done func(have string) bool, do func()) []string {
	t.Helper()
	var mu sync.Mutex
	var buf bytes.Buffer
	prev := vhlog.SetOutput(lockedWriter{&mu, &buf})
	defer vhlog.SetOutput(prev)
	do()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		have := buf.String()
		mu.Unlock()
		if done(have) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	var lines []string
	for _, l := range strings.Split(buf.String(), "\n") {
		if strings.Contains(l, `"stream open"`) || strings.Contains(l, `"stream close"`) {
			lines = append(lines, l)
		}
	}
	return lines
}

// countJournal counts captured lifecycle lines of one kind ("open"/"close").
func countJournal(t *testing.T, lines []string, kind string) int {
	t.Helper()
	want := `"stream ` + kind + `"`
	n := 0
	for _, l := range lines {
		if strings.Contains(l, want) {
			n++
		}
	}
	return n
}

// TestStreamJournal_OpenCloseAttribution — one tree=2 selected-session connect
// with a distinguishing UA and a compound cursor: the open line must name the
// client (ua, remote) and the request shape (class, tree2, sessions, cursor
// raw string, capability flags); closing the body must produce exactly one
// close line with the disconnect reason, a lifetime, and the echoed UA.
//
// Volume discipline is demonstrated against REAL live delivery (the F3
// receipt): the sessions=s1 interest lets the message-class burst actually
// flow over this stream (asserted received on the wire), and the lifecycle
// line count stays exactly 1 open + 1 close — per-event trace remains behind
// VH_DEBUG.
func TestStreamJournal_OpenCloseAttribution(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	const ua = "vh-test-PWA/1.0 (mobile; Android)"
	lines := captureStreamJournal(t,
		func(have string) bool {
			return strings.Count(have, `"stream open"`) >= 1 && strings.Count(have, `"stream close"`) >= 1
		},
		func() {
			req, _ := http.NewRequest("GET", web.URL+"/vh/stream?sessions=s1&tree=2&cursor=42.7&part_delta=1&z=1", nil)
			req.Header.Set("User-Agent", ua)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close() // FailNow-safe: the handler must exit for httptest.Server.Close
			ch := startSSEReader(t, resp.Body)
			// Phase 1: wait out the bootstrap (snapshot frames). Applying the
			// burst before the subscribe+capture completes would race the
			// capture — the events land INSIDE the snapshot (ev.Seq <=
			// baseline → correctly suppressed as covered) and the receipt
			// below would flake.
			drainIdle(ch, 400*time.Millisecond)
			// Phase 2: land a burst of message-class store events over the
			// OPEN stream for the SUBSCRIBED session — these genuinely flow
			// to this client (message.upsert frames, asserted below) — and
			// none of them may add journal lines: the two lifecycle lines
			// per connection are the whole budget (per-event trace is
			// VH_DEBUG-gated).
			for i := 0; i < 5; i++ {
				store.Apply(ev("message.updated", `{"info":{"id":"m`+string(rune('a'+i))+`","sessionID":"s1","role":"assistant"}}`))
			}
			live := drainIdle(ch, 400*time.Millisecond)
			if !hasEvent(live, "message.upsert") {
				t.Errorf("volume exercise must demonstrate LIVE delivery (message.upsert received), got: %v", eventNames(live))
			}
			// resp.Body.Close() runs via defer — client disconnect →
			// r.Context().Done() → the close line.
		})

	if n := countJournal(t, lines, "open"); n != 1 {
		t.Fatalf("captured %d stream-open lines, want exactly 1: %v", n, lines)
	}
	if n := countJournal(t, lines, "close"); n != 1 {
		t.Fatalf("captured %d stream-close lines, want exactly 1: %v", n, lines)
	}

	var openLine, closeLine string
	for _, l := range lines {
		switch {
		case strings.Contains(l, `"stream open"`):
			openLine = l
		case strings.Contains(l, `"stream close"`):
			closeLine = l
		}
	}

	// Open line: client identity + request shape.
	for _, want := range []string{
		`msg="stream open"`,
		"class=selected",
		"tree2=true",
		"sessions=s1",
		"cursor=42.7", // RAW resume string, compound form preserved
		"part_delta=true",
		"z=true",
		`ua="` + ua + `"`, // THE phone-vs-desktop discriminator
		"remote=127.0.0.1:",
	} {
		if !strings.Contains(openLine, want) {
			t.Errorf("open line missing %q: %s", want, openLine)
		}
	}

	// Close line: reason token + lifetime + self-attributing UA.
	for _, want := range []string{
		`msg="stream close"`,
		"class=selected",
		"reason=request_ctx_closed", // browser closed (default) — the Disc token, not a bare int
		"dur_ms=",
		`ua="` + ua + `"`,
	} {
		if !strings.Contains(closeLine, want) {
			t.Errorf("close line missing %q: %s", want, closeLine)
		}
	}
}

// TestStreamJournal_OpenLineSessionsShape — the sessions= label must mirror
// messageFilter's three-way parse (all / none / joined ids) and the cursor
// field must reflect the handler's Last-Event-ID-over-query precedence.
func TestStreamJournal_OpenLineSessionsShape(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	const ua = "vh-test-desktop/1.0"
	connect := func(url, lastEventID string) {
		t.Helper()
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("User-Agent", ua)
		if lastEventID != "" {
			req.Header.Set("Last-Event-ID", lastEventID)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		drainIdle(startSSEReader(t, resp.Body), 300*time.Millisecond)
		resp.Body.Close()
	}

	lines := captureStreamJournal(t,
		func(have string) bool {
			return strings.Count(have, `"stream open"`) >= 3 && strings.Count(have, `"stream close"`) >= 3
		},
		func() {
			// 1. firehose: sessions=all → label "all", class firehose.
			connect(web.URL+"/vh/stream?sessions=all&cursor=legacy7", "")
			// 2. selected: sessions=s1 → label "s1", class selected.
			connect(web.URL+"/vh/stream?sessions=s1&cursor=1", "")
			// 3. Last-Event-ID header WINS over the cursor query param
			//    (handler precedence — the open line must show the header).
			connect(web.URL+"/vh/stream?sessions=&cursor=1", "9.4")
		})

	if n := countJournal(t, lines, "open"); n != 3 {
		t.Fatalf("captured %d stream-open lines, want 3: %v", n, lines)
	}
	if n := countJournal(t, lines, "close"); n != 3 {
		t.Fatalf("captured %d stream-close lines, want 3: %v", n, lines)
	}

	var all, selected, headerWon string
	for _, l := range lines {
		switch {
		case strings.Contains(l, "sessions=all"):
			all = l
		case strings.Contains(l, "sessions=s1"):
			selected = l
		case strings.Contains(l, "cursor=9.4"):
			headerWon = l
		}
	}
	if all == "" || !strings.Contains(all, "class=firehose") || !strings.Contains(all, "cursor=legacy7") {
		t.Errorf("firehose open line shape: %q", all)
	}
	if selected == "" || !strings.Contains(selected, "class=selected") {
		t.Errorf("selected open line shape: %q", selected)
	}
	if headerWon == "" {
		t.Errorf("Last-Event-ID reconnect line not found (header must win over cursor query param): lines=%v", lines)
	} else if strings.Contains(headerWon, "cursor=1") {
		// The header-won line must carry the WINNING resume string only —
		// the losing query cursor must not appear anywhere in the line.
		t.Errorf("open line must carry the WINNING resume string only: %q", headerWon)
	}
}
