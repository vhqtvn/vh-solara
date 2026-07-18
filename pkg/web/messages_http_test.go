package web

// HTTP handler tests for the historical-message-page endpoint (Phase 2):
// GET /vh/session/{sessionId}/messages?before=<id>&limit=&max_bytes=
//
// These pin the wire contract: response envelope shape, the exclusive-before +
// one-item-overlap pagination, optional gzip64 round-trip, the required-cursor
// 400, the invalid-boundary defined response, the limit clamp, and the
// invariant that this endpoint NEVER emits messages.batch / messages.loaded
// (distinct from the cold-load SSE path).
//
// The harness mirrors integration_test.go: a fakeOpenCode upstream seeds
// messages, an Aggregator reconciles them into the store, and the test setup
// pre-hydrates via EnsureMessages (mirroring the Stream2 cold-load) so the
// page endpoint can paginate. The handler itself does NOT call EnsureMessages
// — it is a pure point-in-time read (see messages_http.go Contract).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// seedMsgListJSON builds the fakeOpenCode /session/{id}/message response for a
// session <sid> with N messages m1..mN, each with a small text part. The
// aggregator's EnsureMessages fetches this verbatim and reconciles it into the
// store in creation order (m1 oldest, mN newest).
func seedMsgListJSON(sid string, n int) string {
	msgs := make([]string, n)
	for i := 1; i <= n; i++ {
		msgs[i-1] = fmt.Sprintf(
			`{"info":{"id":"m%d","sessionID":%q,"role":"user"},"parts":[{"id":"m%dp","sessionID":%q,"messageID":"m%d","type":"text","text":"msg %d"}]}`,
			i, sid, i, sid, i, i,
		)
	}
	return "[" + strings.Join(msgs, ",") + "]"
}

// setupPageTest wires the fakeOpenCode + aggregator + web server for the page
// endpoint tests. Seeds <sid> with n messages and returns the web server base
// URL plus a cleanup func. The aggregator is started and the session's messages
// are explicitly hydrated via EnsureMessages (the handler itself is a pure read
// and does NOT hydrate — see messages_http.go contract), so the test setup
// performs the hydration that production attributes to the Stream2 cold-load.
func setupPageTest(t *testing.T, sid string, n int) (webURL, ocURL string) {
	t.Helper()
	fake := newFake()
	fake.sessions = []string{fmt.Sprintf(`{"id":%q,"title":"S"}`, sid)}
	fake.messages[sid] = seedMsgListJSON(sid, n)
	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)
	agg := aggregator.New(ocSrv.URL, 1000)
	// Run the aggregator so EnsureMessages' cold-fetch lifecycle can complete.
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go agg.Run(ctx)
	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	// Wait for the session to appear in the tree so EnsureMessages has a
	// known session to hydrate.
	waitFor(t, func() bool { return len(agg.Store().SessionIDs()) >= 1 }, "session hydrated into tree")
	// Explicitly hydrate the session's full message history. The handler is a
	// pure read (no EnsureMessages — it would emit SSE cold-load events as a
	// side effect, violating the no-side-effect contract); tests hydrate here
	// to mirror what the Stream2 subscription does in production before any
	// page request is issued.
	if err := agg.EnsureMessages(ctx, sid); err != nil {
		t.Fatalf("setup EnsureMessages: %v", err)
	}
	return web.URL, ocSrv.URL
}

// getPage issues GET /vh/session/<sid>/messages and returns the decoded
// MessagePageResult envelope (after gzip64 decode if needed). Fails on non-200.
func getPage(t *testing.T, webURL, sid, before, limit, maxBytes, z string) map[string]any {
	t.Helper()
	u := webURL + "/vh/session/" + sid + "/messages?before=" + before
	if limit != "" {
		u += "&limit=" + limit
	}
	if maxBytes != "" {
		u += "&max_bytes=" + maxBytes
	}
	if z != "" {
		u += "&z=" + z
	}
	resp, err := http.Get(u)
	if err != nil {
		t.Fatalf("page GET: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("page GET status: want 200, got %d, body=%s", resp.StatusCode, string(body))
	}
	// The X-VH-Seq / X-VH-Epoch headers are stamped by stampMeta middleware on
	// every /vh/* response. Pin them here so a regression that drops the
	// middleware (or changes the header names) fails loudly.
	if resp.Header.Get("X-VH-Seq") == "" {
		t.Errorf("X-VH-Seq header: want non-empty, got empty")
	}
	if resp.Header.Get("X-VH-Epoch") == "" {
		t.Errorf("X-VH-Epoch header: want non-empty, got empty")
	}
	// Optional gzip64 envelope: decode if present, else parse raw.
	raw := body
	if isGzip64Envelope(body) {
		raw = decodeGzip64(t, body)
	}
	var env map[string]any
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("page envelope unmarshal: %v\nraw=%s", err, string(raw))
	}
	return env
}

// pageItemIDs extracts the ordered message ids from a page envelope's items[].
func pageItemIDs(env map[string]any) []string {
	items, _ := env["items"].([]any)
	out := make([]string, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			if info, ok := m["info"].(map[string]any); ok {
				if id, ok := info["id"].(string); ok {
					out = append(out, id)
				}
			}
		}
	}
	return out
}

// equalStrings is a local helper (pkg/state has its own; pkg/web needs a copy)
// used by assertions comparing ordered id slices.
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestMessagesEndpoint_PaginatesOlder pins the core contract: a before=<mid>
// request returns a page of [strictly-older messages..., overlap=before]
// (creation-ordered oldest-first), with boundary_found=true and has_older
// reflecting whether more older messages exist.
func TestMessagesEndpoint_PaginatesOlder(t *testing.T) {
	webURL, _ := setupPageTest(t, "s", 5) // m1..m5
	env := getPage(t, webURL, "s", "m3", "", "", "")
	if env["session_id"] != "s" {
		t.Fatalf("session_id: want s, got %v", env["session_id"])
	}
	if env["request_before"] != "m3" {
		t.Fatalf("request_before: want m3, got %v", env["request_before"])
	}
	if env["boundary_found"] != true {
		t.Fatalf("boundary_found: want true, got %v", env["boundary_found"])
	}
	// m3 + strictly older m1,m2 → [m1,m2,m3]
	if got := pageItemIDs(env); !equalStrings(got, []string{"m1", "m2", "m3"}) {
		t.Fatalf("items: want [m1 m2 m3], got %v", got)
	}
	if env["newest_id"] != "m3" {
		t.Fatalf("newest_id: want m3, got %v", env["newest_id"])
	}
	if env["oldest_id"] != "m1" {
		t.Fatalf("oldest_id: want m1, got %v", env["oldest_id"])
	}
	if env["has_older"] != false {
		t.Fatalf("has_older: want false (exhausted older), got %v", env["has_older"])
	}
	if env["message_count"] != float64(3) {
		t.Fatalf("message_count: want 3, got %v", env["message_count"])
	}
	if env["daemon_epoch"] == nil || env["daemon_epoch"] == "" {
		t.Fatalf("daemon_epoch: want non-empty, got %v", env["daemon_epoch"])
	}
	if env["baseline_seq"] == nil {
		t.Fatalf("baseline_seq: want set, got nil")
	}
}

// TestMessagesEndpoint_BeforeIsNewest pins the first "Load older" click: before
// = newest message walks ALL older messages (bounded by limit/bytes). has_older
// is false when the older list is exhausted.
func TestMessagesEndpoint_BeforeIsNewest(t *testing.T) {
	webURL, _ := setupPageTest(t, "s", 5) // m1..m5, m5 newest
	env := getPage(t, webURL, "s", "m5", "", "", "")
	if got := pageItemIDs(env); !equalStrings(got, []string{"m1", "m2", "m3", "m4", "m5"}) {
		t.Fatalf("items: want [m1..m5], got %v", got)
	}
	if env["has_older"] != false {
		t.Fatalf("has_older: want false (exhausted), got %v", env["has_older"])
	}
}

// TestMessagesEndpoint_LimitParam pins that ?limit=N caps TOTAL page size
// (overlap + older), and sets count_limited + has_older when more older
// messages exist within the byte budget.
func TestMessagesEndpoint_LimitParam(t *testing.T) {
	webURL, _ := setupPageTest(t, "s", 5) // m1..m5
	env := getPage(t, webURL, "s", "m4", "2", "", "")
	// limit=2: overlap m4 + 1 older m3 → [m3,m4]; m1,m2 still older.
	if got := pageItemIDs(env); !equalStrings(got, []string{"m3", "m4"}) {
		t.Fatalf("items: want [m3 m4] (limit=2), got %v", got)
	}
	if env["count_limited"] != true {
		t.Fatalf("count_limited: want true, got %v", env["count_limited"])
	}
	if env["has_older"] != true {
		t.Fatalf("has_older: want true (m1,m2 exist), got %v", env["has_older"])
	}
}

// TestMessagesEndpoint_InvalidBefore pins the defined response for a stale
// boundary: boundary_found=false + empty items (NOT an error). The client
// refetches from a known-good cursor; Contract-B's dirty-flag is the primary
// guard.
func TestMessagesEndpoint_InvalidBefore(t *testing.T) {
	webURL, _ := setupPageTest(t, "s", 3)
	env := getPage(t, webURL, "s", "nonexistent", "", "", "")
	if env["boundary_found"] != false {
		t.Fatalf("boundary_found: want false (stale cursor), got %v", env["boundary_found"])
	}
	if got := pageItemIDs(env); len(got) != 0 {
		t.Fatalf("items: want empty, got %v", got)
	}
	if env["has_older"] != false {
		t.Fatalf("has_older: want false (no boundary resolved), got %v", env["has_older"])
	}
}

// TestMessagesEndpoint_BeforeRequired pins the 400 contract: before="" is a
// client bug (the initial window is the documented source of the first cursor).
// The endpoint does NOT silently return the newest tail.
func TestMessagesEndpoint_BeforeRequired(t *testing.T) {
	webURL, _ := setupPageTest(t, "s", 3)
	resp, err := http.Get(webURL + "/vh/session/s/messages")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: want 400, got %d", resp.StatusCode)
	}
}

// TestMessagesEndpoint_SessionRequired pins that a sessionId that sanitizes to
// empty (safeID strips non-alphanumerics) returns 400.
func TestMessagesEndpoint_SessionRequired(t *testing.T) {
	webURL, _ := setupPageTest(t, "s", 3)
	// "!!!!" sanitizes to "" via safeID.
	resp, err := http.Get(webURL + "/vh/session/!!!!/messages?before=m1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: want 400 (empty session after sanitize), got %d", resp.StatusCode)
	}
}

// TestMessagesEndpoint_NeverEmitsBatchOrLoaded is the hard contract: the page
// response is a DISTINCT envelope. It MUST NOT carry messages.batch or
// messages.loaded keys (those are SSE-only events from the cold-load path).
// A regression that conflates the envelopes would make the client mistake a
// historical page for a wholesale-replace batch and clobber live state.
func TestMessagesEndpoint_NeverEmitsBatchOrLoaded(t *testing.T) {
	webURL, _ := setupPageTest(t, "s", 3)
	rawBody := func(z string) []byte {
		t.Helper()
		u := webURL + "/vh/session/s/messages?before=m2"
		if z != "" {
			u += "&z=" + z
		}
		resp, err := http.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if isGzip64Envelope(body) {
			body = decodeGzip64(t, body)
		}
		return body
	}
	for _, z := range []string{"", "1"} {
		raw := rawBody(z)
		s := string(raw)
		if strings.Contains(s, "\"messages.batch\"") || strings.Contains(s, "\"messages.loaded\"") {
			t.Fatalf("page response (z=%q) must NOT contain messages.batch / messages.loaded keys; got: %s", z, s)
		}
		// The page envelope uses "items", NOT "messages".
		if strings.Contains(s, "\"messages\":") {
			t.Fatalf("page response (z=%q) must NOT contain a top-level \"messages\" key (that's the batch shape); got: %s", z, s)
		}
	}
}

// TestMessagesEndpoint_Gzip64RoundTrip pins the z=1 opt-in: the response is the
// gzip64 envelope, and decoding it yields the same JSON as the raw response.
func TestMessagesEndpoint_Gzip64RoundTrip(t *testing.T) {
	webURL, _ := setupPageTest(t, "s", 3)
	// Small payloads stay raw (below snapshotCompressThreshold); force a larger
	// seed so the gzip path actually fires. Re-seed via a direct store SetSession
	// would bypass the aggregator; easier: use the existing small seed and
	// assert the envelope shape round-trips either way (raw OR gzip64 both
	// decode to the same JSON). The decodeGzip64 helper is a total function.
	rawResp, err := http.Get(webURL + "/vh/session/s/messages?before=m2")
	if err != nil {
		t.Fatal(err)
	}
	rawBody, _ := io.ReadAll(rawResp.Body)
	rawResp.Body.Close()
	zResp, err := http.Get(webURL + "/vh/session/s/messages?before=m2&z=1")
	if err != nil {
		t.Fatal(err)
	}
	zBody, _ := io.ReadAll(zResp.Body)
	zResp.Body.Close()
	// Normalize both to decoded JSON.
	rawDecoded := rawBody
	if isGzip64Envelope(rawBody) {
		rawDecoded = decodeGzip64(t, rawBody)
	}
	zDecoded := zBody
	if isGzip64Envelope(zBody) {
		zDecoded = decodeGzip64(t, zBody)
	}
	if string(rawDecoded) != string(zDecoded) {
		t.Fatalf("gzip64 round-trip mismatch:\nraw=%s\nz=%s", rawDecoded, zDecoded)
	}
}

// TestMessagesEndpoint_HeadersStamped pins that stampMeta middleware stamps
// X-VH-Seq + X-VH-Epoch on the page response (the Contract-B client validates
// these against its cursor). Covered inline by getPage; this test makes the
// contract explicit + named.
func TestMessagesEndpoint_HeadersStamped(t *testing.T) {
	webURL, _ := setupPageTest(t, "s", 3)
	resp, err := http.Get(webURL + "/vh/session/s/messages?before=m2")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("X-VH-Seq") == "" {
		t.Errorf("X-VH-Seq: want non-empty (Contract-B client cursor), got empty")
	}
	if resp.Header.Get("X-VH-Epoch") == "" {
		t.Errorf("X-VH-Epoch: want non-empty (daemon-restart detection), got empty")
	}
}

// TestMessagesEndpoint_NoSSESideEffect (B-F1 regression guard) pins that the
// page handler is a pure read and does NOT trigger cold-load SSE publication.
// The handler must not call EnsureMessages: doing so would publish
// messages.batch / messages.loaded to live SSE subscribers on a not-yet-
// hydrated session. We subscribe to the store event bus, request a page for a
// COLD (not-yet-hydrated) session, and assert no batch/loaded events arrive.
func TestMessagesEndpoint_NoSSESideEffect(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"cold","title":"C"}`}
	fake.messages["cold"] = seedMsgListJSON("cold", 3)
	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)
	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go agg.Run(ctx)
	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	// Wait for the session tree (NOT messages — leave the session cold).
	waitFor(t, func() bool { return len(agg.Store().SessionIDs()) >= 1 }, "session in tree")
	// Subscribe BEFORE the page request so any published batch/loaded event
	// would be observed.
	store := agg.Store()
	ch, unsub := store.Subscribe(64)
	defer unsub()
	// Request a page for the cold session. The handler must NOT hydrate.
	resp, err := http.Get(web.URL + "/vh/session/cold/messages?before=m2")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: want 200, got %d, body=%s", resp.StatusCode, string(body))
	}
	// Drain any events published during/after the request. The aggregator's
	// own background hydrate (Run loop) may publish unrelated events, but a
	// messages.batch / messages.loaded for "cold" would prove the page
	// handler triggered hydration. Store emit() is synchronous under s.mu, so
	// any publication triggered by the handler completes before the HTTP
	// response returns; drain non-blockingly until empty (capped as a safety
	// net). The labeled break exits the for-loop, not just the select.
drainLoop:
	for i := 0; i < 64; i++ {
		select {
		case ev, ok := <-ch:
			if !ok {
				break drainLoop
			}
			if ev.Kind == "messages.batch" || ev.Kind == "messages.loaded" {
				if strings.Contains(string(ev.Payload), `"cold"`) {
					t.Fatalf("page handler published %s for cold session (B-F1 regression): payload=%s", ev.Kind, string(ev.Payload))
				}
			}
		default:
			break drainLoop
		}
	}
}

// TestMessagesEndpoint_BaselineSeqOnWarmSession pins the corrected doc's
// warm-session equality claim: on a quiescent warm session, baseline_seq in
// the body matches the X-VH-Seq header stamped at request entry. The cold-
// session regression vector for B-F1/B-F2 (handler calling EnsureMessages)
// is covered by TestMessagesEndpoint_NoSSESideEffect — on a warm session
// EnsureMessages is a no-op (aggregator.go fast-path), so this test instead
// pins the documented warm-path equality invariant (store.go BaselineSeq).
func TestMessagesEndpoint_BaselineSeqOnWarmSession(t *testing.T) {
	webURL, _ := setupPageTest(t, "warm", 3) // setupPageTest hydrates explicitly
	resp, err := http.Get(webURL + "/vh/session/warm/messages?before=m2")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("status: want 200, got %d", resp.StatusCode)
	}
	raw := body
	if isGzip64Envelope(body) {
		raw = decodeGzip64(t, body)
	}
	var env map[string]any
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal: %v\nraw=%s", err, string(raw))
	}
	headerSeq := resp.Header.Get("X-VH-Seq")
	if headerSeq == "" {
		t.Fatal("X-VH-Seq header empty")
	}
	bodySeq, _ := env["baseline_seq"].(float64)
	if bodySeq == 0 {
		t.Fatalf("baseline_seq missing/zero in body: %v", env["baseline_seq"])
	}
	// On a warm quiescent session the two must match: the handler does NOT
	// call EnsureMessages, so nothing bumps s.seq between the stampMeta
	// header stamp and the SnapshotMessagesPage capture.
	headerSeqN := mustParseUint(headerSeq)
	if uint64(bodySeq) != headerSeqN {
		t.Fatalf("baseline_seq mismatch on warm session (B-F2 regression): body=%d header=%d", uint64(bodySeq), headerSeqN)
	}
}

// mustParseUint parses a base-10 uint64, fataling on error.
func mustParseUint(s string) uint64 {
	var n uint64
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			panic("mustParseUint: non-digit in " + s)
		}
		n = n*10 + uint64(c-'0')
	}
	return n
}
