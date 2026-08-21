package fixtures

// Tests for the OpenCode message-id contract the queue reconciler (Slice 6)
// depends on:
//
//   - caller-id-wins: POST /session/:sid/prompt_async with a body.messageID
//     persists the user message under that EXACT id (both CommitThenDropResponse
//     and Normal modes); an empty/absent messageID falls back to the fake's own
//     u%n id.
//   - exact-GET: GET /session/:sid/message/:mid returns 200 {info,parts} iff
//     the composite (sid, mid) matches a persisted USER message, else 404; a
//     non-msg_-prefixed id → 400.
//
// These close the Slice-5 DEFER F2 (fixture caller-id-wins honoring had no
// unit test and go test ./pkg/fixtures/ was not in the Slice-5 validation run).

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// startFixtureHTTP stands up the fake on an httptest server. Returns the server
// and a cleanup.
func startFixtureHTTP(t *testing.T, f *FakeOpenCode) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(f.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func postJSON(t *testing.T, srv *httptest.Server, path, body string) (*http.Response, []byte) {
	t.Helper()
	resp, err := srv.Client().Post(srv.URL+path, "application/json", strings.NewReader(body))
	// The CommitThenDropResponse mode hijacks+closes the connection, so the
	// client observes a transport error (EOF / connection reset) — that is the
	// modeled "response lost" outcome. Surface it as a synthetic 502 so the
	// caller can proceed to verify the commit happened via a GET.
	if err != nil {
		return &http.Response{StatusCode: http.StatusBadGateway}, nil
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func get(t *testing.T, srv *httptest.Server, path string) (*http.Response, []byte) {
	t.Helper()
	resp, err := srv.Client().Get(srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

// TestPromptAsyncCallerIDWins_CommitThenDropResponse verifies that in the
// ambiguous-receipt mode the user message is committed under the caller-supplied
// EXACT id, so a later exact-GET finds it (the reconciler's authority).
func TestPromptAsyncCallerIDWins_CommitThenDropResponse(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncCommitThenDropResponse)
	srv := startFixtureHTTP(t, f)

	const sid = "rcov-1" // unseeded session so the commit count is exactly 1
	const mid = "msg_testcallerid001"
	body := `{"parts":[{"type":"text","text":"hello"}],"messageID":` + jsonQuote(mid) + `}`
	resp, _ := postJSON(t, srv, "/session/"+sid+"/prompt_async", body)
	if resp.StatusCode != http.StatusBadGateway {
		// Response was intentionally dropped (the modeled "lost" outcome).
		t.Fatalf("commit-then-drop: want ~502 (dropped), got %d", resp.StatusCode)
	}
	if f.UserMessageCount(sid) != 1 {
		t.Fatalf("UserMessageCount: got %d want 1 (committed despite dropped response)", f.UserMessageCount(sid))
	}

	// Exact-GET finds the persisted user message under the caller's id.
	gr, gb := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("exact-GET: got %d want 200 (body=%s)", gr.StatusCode, gb)
	}
	var got struct {
		Info struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"info"`
	}
	if err := json.Unmarshal(gb, &got); err != nil {
		t.Fatalf("unmarshal: %v (body=%s)", err, gb)
	}
	if got.Info.ID != mid || got.Info.Role != "user" {
		t.Fatalf("caller-id-wins: got info{ID:%q Role:%q} want {ID:%q Role:user}", got.Info.ID, got.Info.Role, mid)
	}
}

// TestPromptAsyncCallerIDWins_Normal verifies the faithful path also persists
// the caller-supplied exact id (caller-id-wins holds in every mode).
func TestPromptAsyncCallerIDWins_Normal(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncNormal)
	srv := startFixtureHTTP(t, f)

	const sid = "rcov-2"
	const mid = "msg_normalcallerid002"
	body := `{"parts":[{"type":"text","text":"hi"}],"messageID":` + jsonQuote(mid) + `}`
	resp, _ := postJSON(t, srv, "/session/"+sid+"/prompt_async", body)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("normal: got %d want 204", resp.StatusCode)
	}
	gr, _ := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("exact-GET (normal): got %d want 200", gr.StatusCode)
	}
}

// TestPromptAsyncEmptyMessageIDFallsBack verifies an absent/empty messageID
// makes the fake mint its own u%n id (the pre-Slice-5 path), and that a
// caller-supplied msg_ id does NOT collide with it.
func TestPromptAsyncEmptyMessageIDFallsBack(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncCommitThenDropResponse)
	srv := startFixtureHTTP(t, f)

	const sid = "rcov-3"
	// No messageID field at all.
	postJSON(t, srv, "/session/"+sid+"/prompt_async", `{"parts":[{"type":"text","text":"fallback"}]}`)
	if f.UserMessageCount(sid) != 1 {
		t.Fatalf("UserMessageCount: got %d want 1", f.UserMessageCount(sid))
	}
	// A GET for any msg_-prefixed id must 404 (the fake minted a u%n id).
	gr, _ := get(t, srv, "/session/"+sid+"/message/msg_neverminted003")
	if gr.StatusCode != http.StatusNotFound {
		t.Fatalf("empty-messageID fallback: got %d want 404", gr.StatusCode)
	}
}

// TestExactGET_NotFoundForWrongID verifies the composite-key miss returns 404
// (a wrong id under the right session is a clean miss).
func TestExactGET_NotFoundForWrongID(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncCommitThenDropResponse)
	srv := startFixtureHTTP(t, f)

	const sid = "rcov-4"
	const mid = "msg_realid004"
	postJSON(t, srv, "/session/"+sid+"/prompt_async", `{"parts":[{"type":"text","text":"x"}],"messageID":`+jsonQuote(mid)+`}`)

	// A different msg_ id under the same session → 404.
	gr, _ := get(t, srv, "/session/"+sid+"/message/msg_differentid005")
	if gr.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong id: got %d want 404", gr.StatusCode)
	}
}

// TestExactGET_NotFoundForWrongSession verifies session isolation: a message
// committed under one session is NOT visible under another session's path even
// with the same id.
func TestExactGET_NotFoundForWrongSession(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncCommitThenDropResponse)
	srv := startFixtureHTTP(t, f)

	const mid = "msg_sesiso006"
	postJSON(t, srv, "/session/rcov-5a/prompt_async", `{"parts":[{"type":"text","text":"x"}],"messageID":`+jsonQuote(mid)+`}`)
	// Committed under rcov-5a; a GET under rcov-5b must 404 (composite key).
	gr, _ := get(t, srv, "/session/rcov-5b/message/"+mid)
	if gr.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong session: got %d want 404", gr.StatusCode)
	}
}

// TestExactGET_400ForNonMsgPrefix verifies a non-msg_-prefixed id is rejected
// with 400 (caller bug), matching real OpenCode.
func TestExactGET_400ForNonMsgPrefix(t *testing.T) {
	f := New()
	srv := startFixtureHTTP(t, f)

	gr, _ := get(t, srv, "/session/rcov-6/message/u1")
	if gr.StatusCode != http.StatusBadRequest {
		t.Fatalf("non-msg_ prefix: got %d want 400", gr.StatusCode)
	}
}

// jsonQuote is a tiny helper to embed a Go string as a JSON string literal.
func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// countEvents reads the subscriber channel until deadline, returning the count
// of events whose payload contains all of the given substrings (AND). Used by
// the stall-leak regression test to count session.idle emits for a session.
func countEvents(t *testing.T, ch <-chan string, deadline time.Time, contains ...string) int {
	t.Helper()
	n := 0
	for time.Now().Before(deadline) {
		select {
		case raw := <-ch:
			ok := true
			for _, s := range contains {
				if !strings.Contains(raw, s) {
					ok = false
					break
				}
			}
			if ok {
				n++
			}
		case <-time.After(200 * time.Millisecond):
		}
	}
	return n
}

// TestFixtureReset_SuppressesLeakedStallIdle is the regression guard for the
// scroll-follow.spec.ts :693 flake. A [[stall]] goroutine leaked past a
// /fixture/reset (tests 4/9 sleep ~5s server-side and do not wait for idle)
// used to emit a deferred session.idle AFTER the reset — racing a later test's
// session.status busy and clearing working() mid-turn, so .working-text never
// appeared. The fix bumps a per-session resetGen on reset; simulatePrompt's
// deferred idle is gated on the turn-start generation and is suppressed when a
// reset has invalidated it.
//
// This test drives a stall, resets mid-stall, and asserts that ONLY the reset's
// session.idle is observed — the stall's deferred idle is suppressed. Without
// the gate the stall's defer would emit a second session.idle ~5s after the
// prompt_async, and this test would see 2.
//
// Runs ~6s (the stall sleeps 5s); t.Parallel keeps it off the critical path.
func TestFixtureReset_SuppressesLeakedStallIdle(t *testing.T) {
	t.Parallel()
	f := New()
	srv := startFixtureHTTP(t, f)
	ch, unsub := f.subscribe()
	defer unsub()

	// 1. Start a [[stall]] turn — spawns a goroutine that sleeps ~5s then
	//    (without the gate) emits a deferred session.idle.
	postJSON(t, srv, "/session/demo/prompt_async",
		`{"parts":[{"type":"text","text":"[[stall]] leak probe"}]}`)
	// 2. Let the stall goroutine capture its generation + emit busy BEFORE the
	//    reset, so this models the LEAK scenario (prior test's stall, current
	//    test's beforeEach reset). 100ms is ample for the goroutine to start.
	time.Sleep(100 * time.Millisecond)
	// 3. Reset mid-stall: bumps resetGen and emits the reset's own session.idle.
	postJSON(t, srv, "/fixture/reset?session=demo", "")

	// 4. Collect until well past the stall's 5s sleep. With the gate, only the
	//    reset's idle is seen (1). Without the gate, the stall's deferred idle
	//    fires ~5s after the prompt_async (2).
	idles := countEvents(t, ch, time.Now().Add(6500*time.Millisecond),
		`"session.idle"`, `"demo"`)
	if idles != 1 {
		t.Fatalf("expected exactly 1 session.idle (reset only; leaked stall defer must be suppressed), got %d", idles)
	}
}

// TestFixtureReset_PreservesUnresetStallIdle locks in the gate does NOT
// over-suppress: when NO reset invalidates the turn, the deferred session.idle
// fires normally (every stall-based e2e test depends on this). Companion to
// TestFixtureReset_SuppressesLeakedStallIdle. Runs ~6s; t.Parallel.
func TestFixtureReset_PreservesUnresetStallIdle(t *testing.T) {
	t.Parallel()
	f := New()
	srv := startFixtureHTTP(t, f)
	ch, unsub := f.subscribe()
	defer unsub()

	postJSON(t, srv, "/session/demo/prompt_async",
		`{"parts":[{"type":"text","text":"[[stall]] baseline probe"}]}`)
	// NO reset — the stall's deferred idle must fire normally ~5s later.
	idles := countEvents(t, ch, time.Now().Add(6500*time.Millisecond),
		`"session.idle"`, `"demo"`)
	if idles < 1 {
		t.Fatalf("expected the stall's deferred session.idle to fire when no reset occurred, got %d", idles)
	}
}

// TestFixtureReset_EmitsMessageRemovedForAccumulated pins the
// handleFixtureReset → emit("message.removed") crux at opencode.go:1707-1709.
//
// WHY THIS TEST EXISTS. pkg/state reconcileMessagesLocked is upsert-only
// ("absence never deletes", hydration.go), so once the aggregator store has
// absorbed a message the only way a /fixture/reset can make the store DROP it
// is by emitting message.removed (translate.go → deleteMessageLocked). Prompt-
// sending e2e tests (scroll-follow 4/9/10b/11/12) leave user+assistant turns in
// the fixture; without the emit block those turns accumulate across serial
// Playwright --repeat-each iterations, growing scrollHeight until the
// scroll-follow geometry drifts stale and the cross-repeat follow-to-tail flake
// (fixed in 2f6e697) resurfaces. Because the committed e2e runs repeat-each=1,
// a silent revert of the emit block passes CI and only reappears as an
// intermittent flake — this test makes that revert deterministic and CI-fast.
//
// THE CRUX. The fixture-side f.messages restore (opencode.go:1633-1637) clears
// the fixture's OWN transcript regardless; that is NOT what this test pins. This
// test pins the AGGREGATOR-store-clear emit: that message.removed is emitted for
// EACH accumulated (non-baseline) message ID and NOT for any baseline ID. Remove
// the emit block (1707-1709) and removedFor is empty → this test fails, even
// though f.messages is still restored to baseline (the belt, asserted last,
// deliberately passes either way so it cannot mask the emit crux).
//
// Sibling to TestFixtureReset_SuppressesLeakedStallIdle (which pins the
// resetGen/busy axis); this pins the message-removal axis of the same reset.
func TestFixtureReset_EmitsMessageRemovedForAccumulated(t *testing.T) {
	t.Parallel()
	f := New()
	srv := startFixtureHTTP(t, f)
	ch, unsub := f.subscribe()
	defer unsub()

	// 1. Record the seeded baseline IDs for "demo" (m1..m6) so we can assert
	//    reset never emits message.removed for a baseline message.
	f.mu.Lock()
	baselineIDs := map[string]bool{}
	for _, m := range f.baseline["demo"] {
		if id, _ := m.Info["id"].(string); id != "" {
			baselineIDs[id] = true
		}
	}
	f.mu.Unlock()
	if len(baselineIDs) == 0 {
		t.Fatalf("setup: expected a non-empty seeded baseline for \"demo\"")
	}

	// 2. Append non-baseline messages modeling the accumulation vector: a user
	//    turn + an assistant reply (the exact shape simulatePrompt appends — a
	//    u%n user id and an a%n assistant id). Direct mutation is the
	//    deterministic seam: handleFixtureReset reasons over f.messages, not
	//    over how the messages got there, and direct mutation avoids
	//    simulatePrompt's ~720ms streaming race. No f.emit here — the channel
	//    receives only the reset's emits below.
	const accUser = "u7"
	const accAsst = "a7"
	f.mu.Lock()
	f.messages["demo"] = append(f.messages["demo"],
		messageWithParts{Info: map[string]any{"id": accUser, "sessionID": "demo", "role": "user"}},
		messageWithParts{Info: map[string]any{"id": accAsst, "sessionID": "demo", "role": "assistant"}},
	)
	f.mu.Unlock()

	// 3. POST /fixture/reset?session=demo — the reset endpoint the sibling
	//    TestFixtureReset_* tests use.
	postJSON(t, srv, "/fixture/reset?session=demo", "")

	// 4. Drain emitted events. The reset handler emits synchronously (every
	//    f.emit runs before writeJSON returns), so by the time postJSON returns
	//    every payload is already in the subscriber channel. session.idle is the
	//    handler's FINAL emit — seeing it proves the drain captured a complete
	//    emit sequence (no early cut). Early-exit on it; the 1s deadline is belt.
	removedFor := map[string]bool{}
	sawIdle := false
	deadline := time.Now().Add(time.Second)
	for !sawIdle && time.Now().Before(deadline) {
		select {
		case raw := <-ch:
			var ev struct {
				Type       string `json:"type"`
				Properties struct {
					SessionID string `json:"sessionID"`
					MessageID string `json:"messageID"`
				} `json:"properties"`
			}
			if json.Unmarshal([]byte(raw), &ev) != nil {
				continue
			}
			if ev.Properties.SessionID != "demo" {
				continue
			}
			switch ev.Type {
			case "message.removed":
				removedFor[ev.Properties.MessageID] = true
			case "session.idle":
				sawIdle = true
			}
		case <-time.After(100 * time.Millisecond):
		}
	}
	if !sawIdle {
		t.Fatalf("never observed session.idle sentinel — reset handler did not complete its emit block")
	}

	// 5. CRUX: message.removed emitted for EACH accumulated (non-baseline) id.
	for _, id := range []string{accUser, accAsst} {
		if !removedFor[id] {
			t.Errorf("expected message.removed for accumulated message %q, not emitted (removedFor=%v)", id, removedFor)
		}
	}
	// 6. CRUX: message.removed NOT emitted for any baseline id (reset clears
	//    accumulated msgs only; the baseline transcript is preserved).
	for id := range removedFor {
		if baselineIDs[id] {
			t.Errorf("baseline message %q must NOT be removed (reset clears accumulated msgs only), but got message.removed", id)
		}
	}

	// BELT: f.messages restored to baseline. This deliberately passes even if
	// the emit block (1707-1709) is reverted — the restore at 1633-1637 is
	// independent of the emit — so it cannot mask the emit crux above; it only
	// confirms the fixture-side transcript is also clean.
	f.mu.Lock()
	gotIDs := map[string]bool{}
	for _, m := range f.messages["demo"] {
		if id, _ := m.Info["id"].(string); id != "" {
			gotIDs[id] = true
		}
	}
	f.mu.Unlock()
	for id := range baselineIDs {
		if !gotIDs[id] {
			t.Errorf("belt: baseline message %q missing from f.messages after reset", id)
		}
	}
	if gotIDs[accUser] || gotIDs[accAsst] {
		t.Errorf("belt: accumulated messages still present in f.messages after reset (gotIDs=%v)", gotIDs)
	}
}

// TestFixtureOrphan_ScriptsIncompleteTail pins the handleFixtureOrphan
// contract the orphan-tail e2e specs (web/tests/e2e/session-completion.spec.ts)
// depend on: a scripted session whose LAST turn is an assistant message with NO
// time.completed and parts (reasoning + text) carrying time.start with NO
// time.end, activity ending idle, and SILENCE thereafter (no completion
// bookend ever arrives — the "instance died mid-generation" state). Also pins
// re-arm stripping and the /fixture/reset removal of the scripting.
func TestFixtureOrphan_ScriptsIncompleteTail(t *testing.T) {
	t.Parallel()
	f := New()
	srv := startFixtureHTTP(t, f)
	ch, unsub := f.subscribe()
	defer unsub()

	// 1. Arm later=0 (orphan is the newest message). The handler emits
	// synchronously, so every event is already in the channel when the POST
	// returns.
	resp, _ := postJSON(t, srv, "/fixture/orphan?session=other&later=0", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("arm later=0: got %d want 200", resp.StatusCode)
	}

	// 2. Fixture-side transcript shape: user(completed) → assistant orphan.
	f.mu.Lock()
	msgs := append([]messageWithParts(nil), f.messages["other"]...)
	f.mu.Unlock()
	if len(msgs) != 2 {
		t.Fatalf("later=0: fixture transcript len=%d want 2 (user + orphan assistant)", len(msgs))
	}
	if id, _ := msgs[0].Info["id"].(string); id != "orph-u" {
		t.Fatalf("later=0: first message id=%q want orph-u (user)", id)
	}
	orphan := msgs[1]
	if id, _ := orphan.Info["id"].(string); id != "orph-a" {
		t.Fatalf("later=0: second message id=%q want orph-a (orphan assistant)", id)
	}
	if tm, _ := orphan.Info["time"].(map[string]any); tm != nil {
		if _, has := tm["completed"]; has {
			t.Fatalf("orphan assistant must NOT carry time.completed (the death bookend never arrives)")
		}
	}
	sawReason, sawText := false, false
	for _, p := range orphan.Parts {
		pt, _ := p["time"].(map[string]any)
		hasStart := pt != nil && pt["start"] != nil
		hasEnd := pt != nil && pt["end"] != nil
		switch p["type"] {
		case "reasoning":
			sawReason = true
			if !hasStart || hasEnd {
				t.Errorf("orphan reasoning part must carry time.start WITHOUT time.end (got start=%v end=%v)", pt["start"], pt["end"])
			}
		case "text":
			sawText = true
			if !hasStart || hasEnd {
				t.Errorf("orphan text part must carry time.start WITHOUT time.end (got start=%v end=%v)", pt["start"], pt["end"])
			}
		}
	}
	if !sawReason || !sawText {
		t.Fatalf("orphan assistant must carry a reasoning AND a text part (reason=%v text=%v)", sawReason, sawText)
	}

	// 3. Event sequence: collect everything the arm emitted; the LAST event
	// must be session.idle, and NO message.updated for orph-a may carry
	// "completed" (nothing after the death stamps the tail).
	var events []string
	completedOnOrphan := false
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case raw := <-ch:
			events = append(events, raw)
		case <-time.After(100 * time.Millisecond):
		}
	}
	if len(events) == 0 {
		t.Fatalf("no events observed for the arm sequence")
	}
	last := events[len(events)-1]
	if !strings.Contains(last, "session.idle") {
		t.Fatalf("last scripted event must be session.idle (silence thereafter), got %s", last)
	}
	for _, raw := range events {
		if strings.Contains(raw, "message.updated") && strings.Contains(raw, "orph-a") && strings.Contains(raw, "completed") {
			completedOnOrphan = true
		}
	}
	if completedOnOrphan {
		t.Fatalf("a message.updated for the orphan assistant carried time.completed — the scripted death shape is wrong")
	}

	// 4. SILENCE: no further events for the session after the terminal idle.
	if extra := countEvents(t, ch, time.Now().Add(400*time.Millisecond), "other"); extra != 0 {
		t.Fatalf("silence violated: %d events observed after the scripted session.idle", extra)
	}

	// 5. Re-arm with later=1: strips the prior scripting (fixture + emit side)
	//    and appends a completed resumed turn, making the orphan mid-history.
	resp2, body2 := postJSON(t, srv, "/fixture/orphan?session=other&later=1", "")
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("re-arm later=1: got %d want 200", resp2.StatusCode)
	}
	if !strings.Contains(string(body2), `"stripped":2`) {
		t.Fatalf("re-arm must report stripping the 2 prior scripted ids, body=%s", body2)
	}
	f.mu.Lock()
	msgs2 := append([]messageWithParts(nil), f.messages["other"]...)
	f.mu.Unlock()
	if len(msgs2) != 4 {
		t.Fatalf("later=1: fixture transcript len=%d want 4 (user, orphan, resumed user, resumed assistant)", len(msgs2))
	}
	lastInfo := msgs2[3].Info
	if id, _ := lastInfo["id"].(string); id != "orph-la" {
		t.Fatalf("later=1: last message id=%q want orph-la (completed resumed assistant)", id)
	}
	if tm, _ := lastInfo["time"].(map[string]any); tm == nil || tm["completed"] == nil {
		t.Fatalf("later=1: resumed assistant must carry time.completed (the contrast shape)")
	}

	// 6. /fixture/reset removes the scripting entirely (scratch session: no
	//    seeded baseline → the whole transcript is non-baseline).
	postJSON(t, srv, "/fixture/reset?session=other", "")
	f.mu.Lock()
	remaining := len(f.messages["other"])
	f.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("after /fixture/reset: f.messages[other] len=%d want 0 (scripting must be removable for serial-suite hygiene)", remaining)
	}
}
