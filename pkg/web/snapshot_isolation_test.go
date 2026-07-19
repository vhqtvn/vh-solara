package web

// Project-isolation tests for the cross-project message-leak fix
// (FIX-SNAPSHOT-LEAK). Three HTTP handlers — handleSnapshot, handleStream,
// handleSessionsCloseout — used to pass user-supplied session ids straight to
// EnsureMessages / agg.Client().Messages without checking membership in the
// request's project store. OpenCode's /session/<id>/message endpoint is
// project-blind, so a request from project B carrying a session id that
// belongs to project A would fetch and cache project A's messages into project
// B's store. The fix has three layers:
//
//  1. HTTP-boundary guard (projectScopedFilter on handleSnapshot / handleStream;
//     inline ShouldServeSession guard in handleSessionsCloseout): drop foreign
//     ids SILENTLY (HTTP 200, foreign id absent from the response) — never 400,
//     never partial-content.
//  2. Defense-in-depth backstop in the aggregator (EnsureMessages and
//     EnsureMessagesAsync short-circuit when armed && HasSession==false):
//     turns any future buggy caller into a silent no-op rather than a leak.
//  3. Synchronous arming inside aggFor (a.Arm() before storing / returning the
//     per-directory aggregator): closes the first-request TOCTOU where a GET
//     to a freshly-opened project would race RunManaged's goroutine scheduling
//     and observe armed=false (fail-open). Regression-tested by
//     TestCloseoutFirstRequestNoRace.
//
// These tests pin all three layers using one shared fake whose /session/<id>/
// message endpoint serves content project-blind (the same surface that made
// the leak possible). The canonical fixture injects "leakMe" into the DEFAULT
// project's store ONLY; dirB's store is empty. An unguarded GET would return
// fake.messages["leakMe"] under either project.

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// dirBPath is the per-project directory the leak-leak tests run against. It
// MUST differ from the default aggregator's dir ("") so aggFor creates a
// SEPARATE store; the fake's project-blind /session handler then becomes the
// leak surface under test.
const dirBPath = "/tmp/proj-B-leak-isolation"

// leakMessageContent is the assistant-text payload served by the fake for
// "leakMe" under ANY project (project-blind). An unguarded call to
// /session/leakMe/message returns this; a guarded handler must NOT issue the
// GET, so fake.msgGets["leakMe"] stays 0.
const leakMessageContent = `[{"info":{"id":"m1","sessionID":"leakMe","role":"assistant","time":{"created":1}},"parts":[{"id":"p1","sessionID":"leakMe","messageID":"m1","type":"text","text":"secret-from-project-A"}]}]`

// leakSessionEnvelope is the session.created payload injected into the DEFAULT
// store so HasSession("leakMe") returns true there. dirB's store is left empty
// (the fake's session list is empty), so HasSession("leakMe") is false there.
const leakSessionEnvelope = `{"info":{"id":"leakMe","title":"Leak","time":{"updated":1}}}`

// newIsolationServer builds the canonical leak fixture: ONE web.Server against
// ONE shared project-blind fake, with "leakMe" seeded into the DEFAULT store
// ONLY and dirB materialized as a separate (empty) project. Returns the web
// server (for HTTP requests), the fake (for msgGets assertions), and both
// aggregators (default + dirB) so direct-coupling tests can call into the
// aggregator layer. Teardown is consolidated via newReloadServer's t.Cleanup.
func newIsolationServer(t *testing.T) (
	webSrv *httptest.Server,
	fake *fakeOpenCode,
	defaultAgg, dirBAgg *aggregator.Aggregator,
) {
	t.Helper()
	srv, fake, ocSrv, web := newReloadServer(t)

	// Inject leakMe into the DEFAULT store only. Apply(session.created) routes
	// through upsertSessionLocked, which seeds s.sessions["leakMe"]. The default
	// aggregator is already running (newReloadServer started it), so the store
	// is live; direct Apply is safe because it only touches s.sessions and is
	// what the live event path would do for a session.created event.
	defaultAgg = srv.agg
	defaultAgg.Store().Apply(opencode.Event{
		Type:       "session.created",
		Properties: json.RawMessage(leakSessionEnvelope),
	})
	waitFor(t, func() bool { return defaultAgg.Store().HasSession("leakMe") },
		"default store must have leakMe seeded after Apply")

	// fake.messages is project-blind — the same content is served for ANY
	// /session/leakMe/message GET regardless of dir. An unguarded handler
	// would return this; a guarded one must not issue the GET.
	fake.messages["leakMe"] = leakMessageContent

	// Materialize dirB. Its aggregator polls /session, gets the empty list
	// (fake.sessions is empty), and never knows about leakMe — so its store's
	// HasSession("leakMe") is false even though an upstream GET would still
	// return content. aggFor arms the aggregator SYNCHRONOUSLY before
	// returning (see server.go), so dirBAgg is already armed at this point;
	// the waitFor below is belt-and-suspenders defense.
	dirBAgg = srv.aggFor(dirBPath)

	// Defensive arming check: ShouldServeSession of a probe id guaranteed-
	// not-in-store returns true ONLY while unarmed (the bare-test contract),
	// and false once armed. Under the aggFor-arms-synchronously fix this
	// passes immediately; if a future refactor moves arming back inside the
	// Run goroutine, this wait is what keeps the backstop test below correct.
	const armProbe = "__isolation_arm_probe_not_a_real_session__"
	waitFor(t, func() bool { return !dirBAgg.ShouldServeSession(armProbe) },
		"dirB aggregator must arm its project-isolation backstop (Run started)")
	if dirBAgg.Store().HasSession("leakMe") {
		t.Fatal("dirB store must NOT have leakMe — fixture invariant broken")
	}

	_ = ocSrv
	return web, fake, defaultAgg, dirBAgg
}

// TestSnapshotProjectIsolation pins the HTTP-boundary guard on handleSnapshot:
// a request from project B carrying a session id that belongs to project A
// must NOT trigger an upstream GET, and the foreign id must be absent from the
// snapshot's Messages map. The silent-drop policy: HTTP 200, foreign id simply
// not present — never 400, never partial-content.
func TestSnapshotProjectIsolation(t *testing.T) {
	web, fake, _, _ := newIsolationServer(t)

	resp, err := http.Get(web.URL + "/vh/snapshot?sessions=leakMe&dir=" + dirBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d, body=%s", resp.StatusCode, string(body))
	}
	body, _ := io.ReadAll(resp.Body)
	var snap struct {
		Messages map[string]json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(body, &snap); err != nil {
		t.Fatalf("snapshot unmarshal: %v\nraw=%s", err, string(body))
	}
	if _, present := snap.Messages["leakMe"]; present {
		t.Fatalf("snapshot must NOT carry leakMe under dirB (foreign id); got messages[leakMe]=%s",
			string(snap.Messages["leakMe"]))
	}
	if got := fake.msgGets["leakMe"]; got != 0 {
		t.Fatalf("upstream /session/leakMe/message GET count: want 0 (guarded), got %d", got)
	}
}

// TestStreamProjectIsolation pins the HTTP-boundary guard on handleStream:
// opening an SSE stream under dirB with ?sessions=leakMe must NOT trigger an
// EnsureMessagesAsync fetch, must NOT forward any messages.batch / message.* /
// part.* frame for the foreign id, and must still deliver a usable snapshot
// frame so the client's stream-open cycle is not broken.
func TestStreamProjectIsolation(t *testing.T) {
	web, fake, _, _ := newIsolationServer(t)

	// Bind the request to a short context so the body read unblocks promptly
	// once we have observed enough frames — without waiting for the server's
	// 15s ping. When the ctx is cancelled the response body Read returns
	// immediately and readSSEFrameSilent yields ("", "").
	ctx, cancel := context.WithTimeout(context.Background(), streamIsolationDrainDelay)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		web.URL+"/vh/stream?sessions=leakMe&dir="+dirBPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)

	// First frame is always the snapshot (fresh client, no cursor). The
	// snapshot must NOT carry messages for leakMe.
	ev, data := readSSEFrame(t, reader)
	if ev != "snapshot" {
		t.Fatalf("first frame want 'snapshot', got %q (data=%s)", ev, data)
	}
	var snap struct {
		Messages map[string]json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal([]byte(data), &snap); err != nil {
		t.Fatalf("snapshot unmarshal: %v", err)
	}
	if _, present := snap.Messages["leakMe"]; present {
		t.Fatalf("stream snapshot must NOT carry leakMe under dirB; got %s",
			string(snap.Messages["leakMe"]))
	}

	// Drain subsequent frames until the ctx deadline closes the body. Assert
	// no message-class frame for leakMe arrives in the window — the bug would
	// emit messages.batch right after the snapshot if EnsureMessagesAsync had
	// been triggered. The drain window is bounded by streamIsolationDrainDelay
	// via the request ctx above; once the body closes, readSSEFrameSilent
	// returns ("", "") on every call and we exit.
	for {
		ev, data := readSSEFrameSilent(reader)
		if ev == "" {
			if got := fake.msgGets["leakMe"]; got != 0 {
				t.Fatalf("upstream GET count: want 0 (guarded), got %d", got)
			}
			return
		}
		if isMessageClassFrame(ev) && strings.Contains(data, `"leakMe"`) {
			t.Fatalf("stream forwarded %s frame for foreign id leakMe: %s", ev, data)
		}
	}
}

// isMessageClassFrame reports whether an SSE event name carries per-session
// message content (the leak surface). Structural events (session.*, activity.*)
// are not leak surfaces — they describe the tree, not message bodies.
func isMessageClassFrame(ev string) bool {
	return strings.HasPrefix(ev, "message.") ||
		strings.HasPrefix(ev, "messages.") ||
		strings.HasPrefix(ev, "part.")
}

// readSSEFrameSilent is readSSEFrame with a non-fatal end-of-stream: if the
// body read returns an error (ctx-cancelled / closed), it returns ("", "")
// instead of failing the test. Used by TestStreamProjectIsolation so a
// correctly-silent stream (the success case) exits cleanly when the request
// ctx closes the body.
func readSSEFrameSilent(r *bufio.Reader) (event, data string) {
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return "", ""
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if event != "" {
				return event, data
			}
			continue
		}
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		}
	}
}

// streamIsolationDrainDelay bounds how long TestStreamProjectIsolation reads
// frames before letting the request ctx close the body. It is a small
// constant rather than a t.Deadline() derivation because the whole web suite
// is serial and we want this test to be cheap on the common (passing) path.
// Generous enough that a regressed EnsureMessagesAsync GET (which would emit
// messages.batch right after the snapshot) is reliably observed even on a
// loaded CI machine; tight enough that the test stays sub-second.
const streamIsolationDrainDelay = 400 * time.Millisecond

// TestCloseoutProjectIsolation pins the inline guard in
// handleSessionsCloseout: a request from project B for a session id that
// belongs to project A must NOT issue an upstream Messages GET, and the
// foreign id must map to {present:false, text:null} in the response —
// indistinguishable from an unknown id (silent-drop policy).
func TestCloseoutProjectIsolation(t *testing.T) {
	web, fake, _, _ := newIsolationServer(t)

	resp, err := http.Get(web.URL + "/vh/sessions/closeout?dir=" + dirBPath + "&id=leakMe")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d, body=%s", resp.StatusCode, string(body))
	}
	body, _ := io.ReadAll(resp.Body)
	var res struct {
		Dir       string `json:"dir"`
		Closeouts map[string]struct {
			Present bool    `json:"present"`
			Text    *string `json:"text"`
		} `json:"closeouts"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatalf("closeout unmarshal: %v\nraw=%s", err, string(body))
	}
	if res.Dir != dirBPath {
		t.Fatalf("closeout dir: want %q, got %q", dirBPath, res.Dir)
	}
	c, ok := res.Closeouts["leakMe"]
	if !ok {
		t.Fatal("closeouts[leakMe] must be present (silent-drop maps to present:false, NOT omitted)")
	}
	if c.Present {
		t.Fatalf("closeouts[leakMe].present: want false (foreign id), got true")
	}
	if c.Text != nil {
		t.Fatalf("closeouts[leakMe].text: want null (foreign id), got %q", *c.Text)
	}
	if got := fake.msgGets["leakMe"]; got != 0 {
		t.Fatalf("upstream GET count: want 0 (guarded), got %d", got)
	}
}

// TestSessionMessagesNoColdFetchRegression pins the existing safety comment
// at messages_http.go:93 ("deliberately NOT calling EnsureMessages"). A
// foreign-id request against the page endpoint must return an empty page
// (boundary_found=false) WITHOUT issuing an upstream GET — the same
// project-isolation contract as the snapshot path, enforced today by the
// handler's no-hydrate discipline and reinforced by the aggregator backstop.
// This test exists so a future refactor that removes the safety comment
// trips here before reaching production.
func TestSessionMessagesNoColdFetchRegression(t *testing.T) {
	web, fake, _, _ := newIsolationServer(t)

	resp, err := http.Get(web.URL + "/vh/session/leakMe/messages?before=m1&dir=" + dirBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d, body=%s", resp.StatusCode, string(body))
	}
	body, _ := io.ReadAll(resp.Body)
	var page map[string]any
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("page unmarshal: %v\nraw=%s", err, string(body))
	}
	// Empty MessagePageResult: boundary_found=false, no items. The exact
	// shape is documented in messages_http.go and tested in
	// messages_http_test.go (stale-cursor case); we re-pin only the
	// leak-relevant facets here.
	if bf, ok := page["boundary_found"].(bool); !ok || bf {
		t.Fatalf("boundary_found: want false (foreign id / not hydrated), got %v", page["boundary_found"])
	}
	items, _ := page["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("items: want empty (foreign id), got %d item(s)", len(items))
	}
	if got := fake.msgGets["leakMe"]; got != 0 {
		t.Fatalf("upstream GET count: want 0 (no hydrate on page path), got %d", got)
	}
}

// TestEnsureMessagesRejectsForeignSession is the coupling test for the
// aggregator backstop: calling EnsureMessages DIRECTLY with a foreign session
// id must return nil WITHOUT issuing an upstream GET. This pins the
// defense-in-depth layer so a future buggy caller of EnsureMessages (e.g. a
// refactor of handleSessionMessages that drops the safety comment) becomes a
// silent no-op rather than a leak.
func TestEnsureMessagesRejectsForeignSession(t *testing.T) {
	_, fake, _, dirBAgg := newIsolationServer(t)

	if err := dirBAgg.EnsureMessages(context.Background(), "leakMe"); err != nil {
		t.Fatalf("EnsureMessages on foreign id: want nil error, got %v", err)
	}
	if got := fake.msgGets["leakMe"]; got != 0 {
		t.Fatalf("upstream GET count: want 0 (backstop), got %d", got)
	}
	// And the same backstop must NOT have marked the session as loaded —
	// silent no-op, not a fake-success.
	if dirBAgg.Store().IsMessagesLoaded("leakMe") {
		t.Fatal("backstop must NOT mark a foreign id as loaded (would mask future real hydration)")
	}
}

// TestCloseoutFirstRequestNoRace is the regression test for the first-request
// TOCTOU flagged in commit-review (tier1_b-F1). Before the synchronous Arm()
// inside aggFor, aggFor returned the freshly-built per-directory aggregator
// BEFORE the RunManaged goroutine set armed=true; in that window a GET
// /vh/sessions/closeout?dir=<fresh-project>&id=<foreign-id> would see
// ShouldServeSession==true (fail-open) and leak the foreign project's message
// text via the project-blind upstream Client().Messages call.
//
// This test exercises the closeout path against a directory that has NEVER
// been opened (so the handler's internal aggFor call materializes the
// aggregator mid-request). There is NO pre-wait for arming — the test fires
// the HTTP request immediately and asserts the foreign id is silent-dropped.
// Under the fix (a.Arm() before aggFor stores/returns), armed=true is
// established synchronously and the race window is closed. Under the bug
// (arming only inside the Run goroutine), this test would flake / fail on the
// first request to win the schedule.
//
// "leakMe" is NOT seeded into any store here (we want the foreign-id path,
// not a known-member path), only into fake.messages so an unguarded fetch
// would return content.
func TestCloseoutFirstRequestNoRace(t *testing.T) {
	_, fake, _, web := newReloadServer(t)

	// Project-blind content for "leakMe". An unguarded closeout would fetch
	// this regardless of dir.
	fake.messages["leakMe"] = leakMessageContent

	// A directory never before opened. aggFor inside the handler materializes
	// the aggregator on this request; the fix requires armed=true to hold
	// BEFORE the handler reads ShouldServeSession.
	const freshDir = "/tmp/proj-C-fresh-first-request-no-race"

	resp, err := http.Get(web.URL + "/vh/sessions/closeout?dir=" + freshDir + "&id=leakMe")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d, body=%s", resp.StatusCode, string(body))
	}
	body, _ := io.ReadAll(resp.Body)
	var res struct {
		Closeouts map[string]struct {
			Present bool    `json:"present"`
			Text    *string `json:"text"`
		} `json:"closeouts"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatalf("closeout unmarshal: %v\nraw=%s", err, string(body))
	}
	c, ok := res.Closeouts["leakMe"]
	if !ok {
		t.Fatal("closeouts[leakMe] must be present (silent-drop maps to {present:false,text:null}, NOT omitted)")
	}
	if c.Present {
		t.Fatalf("closeouts[leakMe].present: want false (first-request race leaked foreign content), got true")
	}
	if c.Text != nil {
		t.Fatalf("closeouts[leakMe].text: want null (first-request race leaked foreign content), got %q", *c.Text)
	}
	if got := fake.msgGets["leakMe"]; got != 0 {
		t.Fatalf("first-request closeout issued upstream GET (race window open); "+
			"fake.msgGets[leakMe]: want 0, got %d", got)
	}
}
