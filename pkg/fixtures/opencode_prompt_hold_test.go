package fixtures

// Prompt-hold latch tests (queue-delivery-custody e2e, brief F2): the hold
// parks the next normal-mode prompt_async turn BEFORE simulatePrompt — no
// persistence, no events while held; release delivers under the EXACT
// caller-supplied correlation id; reset and deadline cancel with no late
// effects; reset joins a parked goroutine before returning.
//
// These pin the FIXTURE's latch semantics only. The daemon/browser delivery
// chain is the dedicated Playwright lane (web/tests/e2e/
// queue-delivery-custody.spec.ts).

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// holdWitness is the decoded /fixture/prompt-hold/state shape.
type holdWitness struct {
	Armed            bool     `json:"armed"`
	Held             bool     `json:"held"`
	Tokens           uint64   `json:"tokens"`
	Arrivals         []string `json:"arrivals"`
	PersistedUserIDs []string `json:"persistedUserIDs"`
}

// promptHoldStateGET reads the witness over the fixture HTTP surface (the
// same route the e2e reaches through the daemon's /oc proxy).
func promptHoldStateGET(t *testing.T, srv *httptest.Server, session string) holdWitness {
	t.Helper()
	_, b := get(t, srv, "/fixture/prompt-hold/state?session="+session)
	var w holdWitness
	if err := json.Unmarshal(b, &w); err != nil {
		t.Fatalf("decode witness: %v (body %s)", err, b)
	}
	return w
}

// waitHeld polls the witness until held==true (the detached prompt_async
// goroutine reached the park).
func waitHeld(t *testing.T, srv *httptest.Server, session string) holdWitness {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		w := promptHoldStateGET(t, srv, session)
		if w.Held {
			return w
		}
		if time.Now().After(deadline) {
			t.Fatalf("prompt hold never engaged (held=false after 3s): %+v", w)
		}
		time.Sleep(15 * time.Millisecond)
	}
}

// waitForPersisted polls the witness until at least min persisted user ids
// exist for session, returning the witness.
func waitForPersisted(t *testing.T, srv *httptest.Server, session string, min int) holdWitness {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		w := promptHoldStateGET(t, srv, session)
		if len(w.PersistedUserIDs) >= min {
			return w
		}
		if time.Now().After(deadline) {
			t.Fatalf("persisted user ids never reached %d: %+v", min, w)
		}
		time.Sleep(15 * time.Millisecond)
	}
}

// armHold arms via the HTTP control surface (mirrors the e2e's /oc route).
func armHold(t *testing.T, srv *httptest.Server, session string, deadlineMs int) {
	t.Helper()
	body := ""
	if deadlineMs > 0 {
		body = fmt.Sprintf(`{"deadlineMs":%d}`, deadlineMs)
	}
	resp, b := postJSON(t, srv, "/fixture/prompt-hold/arm?session="+session, body)
	if resp.StatusCode != 200 {
		t.Fatalf("arm prompt hold: status %d body %s", resp.StatusCode, b)
	}
}

// TestPromptHoldHoldsPersistenceAndEventsUntilRelease — the core contract:
// while held, the 204 answered normally BUT no user message persisted and NO
// event (not even the turn-opening session.status busy) reached the /event
// feed; release delivers under the EXACT caller id.
func TestPromptHoldHoldsPersistenceAndEventsUntilRelease(t *testing.T) {
	f := New()
	srv := startFixtureHTTP(t, f)
	ch, unsub := f.subscribe()
	defer unsub()

	const sid = "qd-hold"
	const mid = "msg_qdhold001"
	armHold(t, srv, sid, 0)

	resp, b := postJSON(t, srv, "/session/"+sid+"/prompt_async",
		`{"parts":[{"type":"text","text":"hold me"}],"messageID":"`+mid+`"}`)
	if resp.StatusCode != 204 {
		t.Fatalf("prompt_async while held: want 204, got %d (body %s)", resp.StatusCode, b)
	}

	w := waitHeld(t, srv, sid)
	if len(w.Arrivals) != 1 || w.Arrivals[0] != mid {
		t.Fatalf("witness arrivals while held = %v, want exactly [%s]", w.Arrivals, mid)
	}
	if len(w.PersistedUserIDs) != 0 {
		t.Fatalf("user message persisted while held: %v", w.PersistedUserIDs)
	}
	if f.UserMessageCount(sid) != 0 {
		t.Fatal("UserMessageCount > 0 while held")
	}
	// NO events while held — drain whatever arrived and require silence.
	for len(ch) > 0 {
		raw := <-ch
		if strings.Contains(raw, `"session.status"`) || strings.Contains(raw, `"message.updated"`) {
			t.Fatalf("event emitted while held: %s", raw)
		}
	}
	silence := 250 * time.Millisecond
	deadline := time.After(silence)
loop:
	for {
		select {
		case raw := <-ch:
			if strings.Contains(raw, `"session.status"`) || strings.Contains(raw, `"message.`) {
				t.Fatalf("event emitted while held: %s", raw)
			}
		case <-deadline:
			break loop
		}
	}

	// Release: the normal flow delivers under the EXACT correlation id and
	// the live event feed carries the turn.
	relResp, rb := postJSON(t, srv, "/fixture/prompt-hold/release", "")
	if relResp.StatusCode != 200 || !strings.Contains(string(rb), `"released":true`) {
		t.Fatalf("release: status %d body %s", relResp.StatusCode, rb)
	}
	w = waitForPersisted(t, srv, sid, 1)
	if len(w.PersistedUserIDs) != 1 || w.PersistedUserIDs[0] != mid {
		t.Fatalf("post-release persisted ids = %v, want exactly [%s]", w.PersistedUserIDs, mid)
	}
	sawUserEvent := false
	deadline = time.After(3 * time.Second)
	for !sawUserEvent {
		select {
		case raw := <-ch:
			if strings.Contains(raw, `"message.updated"`) && strings.Contains(raw, `"id":"`+mid+`"`) {
				sawUserEvent = true
			}
		case <-deadline:
			t.Fatalf("user message.updated (%s) never reached the event feed after release", mid)
		}
	}

	// Hygiene: reset is idempotent after a completed cycle.
	postJSON(t, srv, "/fixture/prompt-hold/reset", "")
	w = promptHoldStateGET(t, srv, sid)
	if w.Armed || w.Held {
		t.Fatalf("reset after completed cycle left latch state: %+v", w)
	}
}

// TestPromptHoldResetCancelsWithoutLateEffects — reset cancels the parked
// turn, joins it, and NOTHING is ever persisted or emitted; a subsequent
// re-arm holds a fresh generation (no cross-talk from the cancelled arm).
func TestPromptHoldResetCancelsWithoutLateEffects(t *testing.T) {
	f := New()
	srv := startFixtureHTTP(t, f)
	ch, unsub := f.subscribe()
	defer unsub()

	const sid = "qd-reset"
	const mid1 = "msg_qdreset001"
	const mid2 = "msg_qdreset002"
	armHold(t, srv, sid, 0)
	postJSON(t, srv, "/session/"+sid+"/prompt_async",
		`{"parts":[{"type":"text","text":"cancel me"}],"messageID":"`+mid1+`"}`)
	waitHeld(t, srv, sid)

	// Reset cancels + joins. After it returns, the parked goroutine has
	// left the park; the turn was cancelled.
	start := time.Now()
	resp, b := postJSON(t, srv, "/fixture/prompt-hold/reset", "")
	if resp.StatusCode != 200 {
		t.Fatalf("reset: status %d body %s", resp.StatusCode, b)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("reset did not join the parked goroutine promptly (took %s)", elapsed)
	}
	time.Sleep(300 * time.Millisecond) // any late effect would land here
	if f.UserMessageCount(sid) != 0 {
		t.Fatal("cancelled turn persisted a user message (late effect)")
	}
	for len(ch) > 0 {
		raw := <-ch
		if strings.Contains(raw, `"session.status"`) || strings.Contains(raw, `"message.`) {
			t.Fatalf("cancelled turn emitted an event (late effect): %s", raw)
		}
	}

	// Re-arm holds a fresh generation: a second prompt parks, and its
	// release still delivers under ITS exact id.
	armHold(t, srv, sid, 0)
	postJSON(t, srv, "/session/"+sid+"/prompt_async",
		`{"parts":[{"type":"text","text":"hold again"}],"messageID":"`+mid2+`"}`)
	waitHeld(t, srv, sid)
	postJSON(t, srv, "/fixture/prompt-hold/release", "")
	w := waitForPersisted(t, srv, sid, 1)
	if len(w.PersistedUserIDs) != 1 || w.PersistedUserIDs[0] != mid2 {
		t.Fatalf("post-rearm persisted ids = %v, want exactly [%s]", w.PersistedUserIDs, mid2)
	}
}

// TestPromptHoldDeadlineCancelsNeverDelivers — the bounded deadline cancels
// the parked turn (never a silent delivery), and the cancelled arm leaves the
// latch clean for a later normal prompt to flow UNIMPEDED.
func TestPromptHoldDeadlineCancelsNeverDelivers(t *testing.T) {
	f := New()
	srv := startFixtureHTTP(t, f)

	const sid = "qd-deadline"
	const mid1 = "msg_qddl001"
	const mid2 = "msg_qddl002"
	armHold(t, srv, sid, 150)
	postJSON(t, srv, "/session/"+sid+"/prompt_async",
		`{"parts":[{"type":"text","text":"expire me"}],"messageID":"`+mid1+`"}`)
	waitHeld(t, srv, sid)

	// Past the deadline the turn is cancelled: no persistence, ever.
	time.Sleep(400 * time.Millisecond)
	if f.UserMessageCount(sid) != 0 {
		t.Fatal("deadline-expired turn persisted a user message")
	}
	w := promptHoldStateGET(t, srv, sid)
	if w.Held || w.Armed {
		t.Fatalf("deadline expiry left the latch engaged: %+v", w)
	}

	// With the arm consumed and nothing re-armed, a normal prompt flows
	// through the gate UNIMPEDED (the no-op unarmed path).
	postJSON(t, srv, "/session/"+sid+"/prompt_async",
		`{"parts":[{"type":"text","text":"free flow"}],"messageID":"`+mid2+`"}`)
	w = waitForPersisted(t, srv, sid, 1)
	if len(w.PersistedUserIDs) != 1 || w.PersistedUserIDs[0] != mid2 {
		t.Fatalf("post-deadline normal prompt persisted ids = %v, want exactly [%s]", w.PersistedUserIDs, mid2)
	}
}

// TestPromptHoldUnrelatedSessionUnaffected — the arm is session-scoped: a
// prompt for a DIFFERENT session flows through without parking (sibling
// sessions of the daemon-dispatch lane never block on the latch).
func TestPromptHoldUnrelatedSessionUnaffected(t *testing.T) {
	f := New()
	srv := startFixtureHTTP(t, f)

	const held = "qd-a"
	const other = "qd-b"
	armHold(t, srv, held, 0)
	postJSON(t, srv, "/session/"+held+"/prompt_async",
		`{"parts":[{"type":"text","text":"park"}],"messageID":"msg_qda001"}`)
	waitHeld(t, srv, held)

	// The sibling session's prompt delivers immediately (no park).
	const otherMid = "msg_qdb001"
	postJSON(t, srv, "/session/"+other+"/prompt_async",
		`{"parts":[{"type":"text","text":"flow"}],"messageID":"`+otherMid+`"}`)
	w := waitForPersisted(t, srv, other, 1)
	if len(w.PersistedUserIDs) != 1 || w.PersistedUserIDs[0] != otherMid {
		t.Fatalf("sibling session impeded by the hold: %+v", w)
	}
	// The armed session is STILL held (one-shot not consumed by a sibling).
	if w := promptHoldStateGET(t, srv, held); !w.Held {
		t.Fatal("sibling prompt consumed the armed session's hold")
	}
}
