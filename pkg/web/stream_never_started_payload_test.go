package web

// stream_never_started_payload_test.go — D1 (defer-triage slice B): the
// WIRE-PAYLOAD assertion for the never-started classification
// (pkg/state/never_started.go, landed d329561).
//
// THE GAP THIS CLOSES: never_started_test.go proves the classification
// STORE-SIDE (cached terminalError + me.info bytes under the store lock), but
// nothing asserted what a cold-connecting SSE client actually RECEIVES — the
// delivered snapshot/batch payload. The P1 review asked for a
// payload-delivery assertion that was never persisted verbatim (the review
// exchange lived only in chat); this file is the durable landing of that ask.
//
// INTERPRETATION SETTLED HERE (coordinator's stated reading, confirmed against
// the code): a cold/cursorless PWA client viewing a session opens the
// SESSION-FILTERED stream (?sessions=<sid> — Stream 2; the tree-only Stream 1
// carries no messages by design), which takes the fresh branch of handleStream
// (stream_http.go) and delivers message rows over TWO frames, each backed by
// one of the two body-adoption surfaces that carry the refinement:
//
//  1. the `snapshot` frame (store.Snapshot(filter) → snap.Messages[sid]),
//     whose rows are the store-resident bodies adopted by the LIVE surface
//     (upsertMessageLocked) — the "daemon ingested the instant abort live,
//     then the phone PWA cold-connects" posture (app restart, lost state);
//  2. the `messages.batch` gzip64 frame (publishColdBatch → KindMessagesBatch)
//     from triggerMessageLoad's async fetch reconciling via the HYDRATION
//     surface (reconcileMessagesLocked) — the daemon-restart posture (fresh
//     store, rows only in opencode's history).
//
// Both tests seed the EXACT incident shape from never_started_test.go
// (assistant + error.name=MessageAbortedError + completed−created ≤100 ms +
// zero parts + zero tokens — the 27 ms instance) alongside the 145 s REAL
// operator-abort control from the same incident session, and assert the
// DELIVERED wire rows: the never-started row carries the refined
// mergeNeverStartedInfo error block (name=VHSolaraNeverStartedError,
// data.cause=MessageAbortedError, data.message=the never-started user
// vocabulary — NOT the raw upstream {"message":"Aborted"} body), while the
// control row keeps the plain operator-abort body byte-for-byte.
//
// Flip-ability: reverting the classification at either adoption surface (or
// neutering neverStartedSignature) makes the delivered rows carry the raw
// upstream MessageAbortedError body and both tests go red — demonstrated
// red-first by neutering neverStartedMaxDurationMs (see slice closeout).
//
// Determinism (commit-review b-F1/c-F1): both tests HOLD the fake's
// /session/s1/message GET (nsWireHoldMessages) across the snapshot read, so
// the two adoption surfaces are exercised in isolation — the snapshot test's
// rows provably come from the LIVE surface (the hydration fetch cannot have
// reconciled yet), and the batch test provably delivers the hydration
// surface's wholesale batch AFTER the empty daemon-restart snapshot.

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// nsWireUserMessage mirrors pkg/state's unexported neverStartedUserMessage
// (never_started.go) — the exact user-facing string the FE renders. Duplicated
// here because it is unexported there; if the wording changes, pkg/state's own
// test forces the change and this mirror must follow (that coupling is the
// point: the WIRE carries this exact vocabulary).
const nsWireUserMessage = "Turn never ran: OpenCode aborted this turn before it started — this was not your stop. Re-sending will likely repeat this."

// The exact incident-session row set (mirrors never_started_test.go's
// incidentInfo/control145sInfo shapes, in one chronological transcript for
// session s1): a grounding user turn, the 145 s REAL operator abort, a second
// user turn, then the 27 ms instant self-abort as the NEWEST assistant — the
// validated production incident ordering.
const (
	nsWireU1Info = `{"id":"m_u1","sessionID":"s1","role":"user",` +
		`"time":{"created":1790000000000}}`
	nsWireCtrlInfo = `{"id":"m_ctrl","sessionID":"s1","role":"assistant",` +
		`"time":{"created":1790000001000,"completed":1790000146000},` +
		`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},` +
		`"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}`
	nsWireU2Info = `{"id":"m_u2","sessionID":"s1","role":"user",` +
		`"time":{"created":1790000150000}}`
	nsWireNSInfo = `{"id":"m_ns","sessionID":"s1","role":"assistant",` +
		`"time":{"created":1790000160000,"completed":1790000160027},` +
		`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},` +
		`"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}`
)

// nsWireFakeBody is the fake opencode /session/s1/message response: the same
// transcript as the live-Apply set, with text parts on the user rows (the
// fetched-history shape; the assistant abort rows genuinely have no parts).
const nsWireFakeBody = `[
{"info":` + nsWireU1Info + `,"parts":[{"id":"p_u1","sessionID":"s1","messageID":"m_u1","type":"text","text":"first ask"}]},
{"info":` + nsWireCtrlInfo + `,"parts":[]},
{"info":` + nsWireU2Info + `,"parts":[{"id":"p_u2","sessionID":"s1","messageID":"m_u2","type":"text","text":"second ask"}]},
{"info":` + nsWireNSInfo + `,"parts":[]}
]`

// nsWireApplyLive seeds the store's message rows via the LIVE surface
// (message.updated → upsertMessageLocked — the same entry path
// never_started_test.go's applyInfo drives), in chronological order.
func nsWireApplyLive(t *testing.T, apply func(typ, props string)) {
	t.Helper()
	for _, info := range []string{nsWireU1Info, nsWireCtrlInfo, nsWireU2Info, nsWireNSInfo} {
		apply("message.updated", `{"info":`+info+`}`)
	}
}

// nsWireHoldMessages holds the fake's /session/s1/message GET (race-safe
// post-start registration under holdMu — the handler reads the map under the
// same mutex) and returns an idempotent release func. Holding the GET makes
// the cold-delivery posture deterministic: no async fetch can reconcile the
// store's message rows while the hold is up, so whichever adoption surface the
// test drives is exercised in isolation.
func nsWireHoldMessages(t *testing.T, fake *fakeOpenCode) (release func()) {
	t.Helper()
	hold := make(chan struct{})
	fake.holdMu.Lock()
	fake.msgHold["s1"] = hold
	fake.holdMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() { close(hold) })
	}
}

// nsWireErrBlock is the parsed info.error block of a delivered row.
type nsWireErrBlock struct {
	Name string `json:"name"`
	Data struct {
		Message string `json:"message"`
		Cause   string `json:"cause"`
	} `json:"data"`
}

// nsWireErrOf extracts and parses one delivered row's info.error block.
func nsWireErrOf(t *testing.T, row state.MessageWithParts) nsWireErrBlock {
	t.Helper()
	var info struct {
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(row.Info, &info); err != nil {
		t.Fatalf("delivered row info unparseable: %v (%s)", err, row.Info)
	}
	var eb nsWireErrBlock
	if err := json.Unmarshal(info.Error, &eb); err != nil {
		t.Fatalf("delivered row error block unparseable: %v (%s)", err, info.Error)
	}
	return eb
}

// nsWireFindRow locates a delivered row by info.id; ok=false when absent.
func nsWireFindRow(rows []state.MessageWithParts, id string) (state.MessageWithParts, bool) {
	for _, r := range rows {
		var env struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(r.Info, &env) == nil && env.ID == id {
			return r, true
		}
	}
	return state.MessageWithParts{}, false
}

// nsWireMustRow is nsWireFindRow with a fatal absence (for rows a test REQUIRES).
func nsWireMustRow(t *testing.T, rows []state.MessageWithParts, id string) state.MessageWithParts {
	t.Helper()
	if r, ok := nsWireFindRow(rows, id); ok {
		return r
	}
	t.Fatalf("delivered rows carry no message %q (have %d rows)", id, len(rows))
	return state.MessageWithParts{}
}

// nsWireAssertRefined pins the never-started row's DELIVERED error block: the
// refined marker (name + cause + user vocabulary), and NOT the raw upstream
// MessageAbortedError body ({"message":"Aborted"}).
func nsWireAssertRefined(t *testing.T, where string, row state.MessageWithParts) {
	t.Helper()
	eb := nsWireErrOf(t, row)
	if eb.Name != state.NeverStartedErrorName {
		t.Errorf("%s: delivered never-started row error.name=%q, want %q (the refinement must reach the WIRE, not just the store)",
			where, eb.Name, state.NeverStartedErrorName)
	}
	if eb.Data.Cause != "MessageAbortedError" {
		t.Errorf("%s: delivered never-started row error.data.cause=%q, want the upstream name preserved", where, eb.Data.Cause)
	}
	if eb.Data.Message != nsWireUserMessage {
		t.Errorf("%s: delivered never-started row error.data.message=%q, want the never-started user vocabulary (not the raw upstream \"Aborted\" body)", where, eb.Data.Message)
	}
}

// nsWireAssertControl pins the 145 s REAL operator-abort row's DELIVERED body:
// the plain upstream MessageAbortedError block, with no refinement anywhere
// (no never-started name, no refinement cause provenance).
func nsWireAssertControl(t *testing.T, where string, row state.MessageWithParts) {
	t.Helper()
	eb := nsWireErrOf(t, row)
	if eb.Name != "MessageAbortedError" {
		t.Errorf("%s: delivered 145s control row error.name=%q, want plain MessageAbortedError (real operator abort keeps today's meaning)",
			where, eb.Name)
	}
	if eb.Data.Message != "Aborted" {
		t.Errorf("%s: delivered 145s control row error.data.message=%q, want the upstream \"Aborted\" body untouched", where, eb.Data.Message)
	}
	if eb.Data.Cause != "" {
		t.Errorf("%s: delivered 145s control row error.data.cause=%q, want empty (no refinement provenance on a real abort)", where, eb.Data.Cause)
	}
	if bytes.Contains(row.Info, []byte(`"`+state.NeverStartedErrorName+`"`)) {
		t.Errorf("%s: delivered 145s control row carries the never-started marker (classification leaked past the signature)", where)
	}
}

// nsWireReadUntil scans the SSE body for the first frame named want and
// returns its data. Fails the test if the body closes first (the request ctx
// deadline bounds the scan).
func nsWireReadUntil(t *testing.T, r *bufio.Reader, want string) string {
	t.Helper()
	for {
		ev, data := readSSEFrameSilent(r)
		if ev == "" {
			t.Fatalf("stream closed before a %q frame arrived", want)
		}
		if ev == want {
			return data
		}
	}
}

// TestStreamNeverStarted_ColdSnapshotCarriesRefinedError — the SNAPSHOT leg of
// the cold-client delivery: rows adopted by the LIVE surface (message.updated →
// upsertMessageLocked refines me.info), then a cursorless session-filtered
// connect. The `snapshot` frame's messages[s1] must carry the refined error
// block for the incident row and the plain operator-abort body for the 145 s
// control — exactly the bytes the FE renders from. The fake's message GET is
// HELD across the snapshot read, so the delivered rows provably come from the
// LIVE adoption surface (the hydration fetch cannot have reconciled —
// commit-review c-F1 determinism).
func TestStreamNeverStarted_ColdSnapshotCarriesRefinedError(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	seedSession(t, srv, fake, "s1")
	nsWireApplyLive(t, func(typ, props string) { srv.agg.Store().Apply(ev(typ, props)) })
	// Serve the same transcript from the fake so the (held, then released)
	// trailing async cold-load re-serves identical shapes instead of an empty
	// list — keeps the post-snapshot tail quiescent.
	fake.setMessage("s1", nsWireFakeBody)
	release := nsWireHoldMessages(t, fake)
	t.Cleanup(release)

	reader, _ := openSessionStreamReq(t, web.URL, "s1", 0, false, 3*time.Second)
	data := nsWireReadUntil(t, reader, "snapshot")

	var snap struct {
		Messages map[string][]state.MessageWithParts `json:"messages"`
	}
	if err := json.Unmarshal([]byte(data), &snap); err != nil {
		t.Fatalf("snapshot frame unmarshal: %v", err)
	}
	rows := snap.Messages["s1"]
	if len(rows) != 4 {
		t.Fatalf("snapshot messages[s1]: got %d rows, want the 4 seeded rows (snapshot=%s)", len(rows), data)
	}
	nsWireAssertRefined(t, "cold snapshot", nsWireMustRow(t, rows, "m_ns"))
	nsWireAssertControl(t, "cold snapshot", nsWireMustRow(t, rows, "m_ctrl"))

	release() // let the held cold fetch complete for a clean teardown
}

// TestStreamNeverStarted_ColdBatchCarriesRefinedError — the COLD-BATCH leg of
// the cold-client delivery (the daemon-restart posture): the store holds NO
// message rows (fresh daemon lifetime; the transcript lives only in opencode's
// history — the fake). A cursorless session-filtered connect takes the fresh
// branch: snapshot first (no rows — the message GET is HELD, so the posture is
// deterministic and the batch cannot be pre-covered by the snapshot's seq;
// commit-review b-F1), then triggerMessageLoad's async fetch reconciles via
// the HYDRATION surface (reconcileMessagesLocked refines before adoption) and
// delivers the wholesale messages.batch (gzip64) on the SAME connection. The
// decoded batch rows must carry the refined error block for the incident row
// and the plain operator-abort body for the 145 s control.
func TestStreamNeverStarted_ColdBatchCarriesRefinedError(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	seedSession(t, srv, fake, "s1")
	fake.setMessage("s1", nsWireFakeBody) // no live store seeding — cold fetch only
	release := nsWireHoldMessages(t, fake)
	t.Cleanup(release)

	reader, _ := openSessionStreamReq(t, web.URL, "s1", 0, false, 3*time.Second)

	// Frame 1: the daemon-restart snapshot — while the GET is held, no rows
	// can be resident, so m_ns must NOT already be present (posture guard).
	snapData := nsWireReadUntil(t, reader, "snapshot")
	var snap struct {
		Messages map[string][]state.MessageWithParts `json:"messages"`
	}
	if err := json.Unmarshal([]byte(snapData), &snap); err != nil {
		t.Fatalf("snapshot frame unmarshal: %v", err)
	}
	if _, ok := nsWireFindRow(snap.Messages["s1"], "m_ns"); ok {
		t.Fatalf("daemon-restart posture broken: snapshot already carries m_ns while the fetch is held (snapshot=%s)", snapData)
	}

	release() // let the held cold fetch reconcile — the batch flows on this connection
	data := nsWireReadUntil(t, reader, "messages.batch")

	// Decode the gzip64 envelope: {"sessionID","encoding":"gzip64","data":...}
	// where data = base64(gzip({"messages":[...]})) — packageMessagesBatch's
	// wire shape (pkg/state/message_window.go).
	var env struct {
		SessionID string `json:"sessionID"`
		Encoding  string `json:"encoding"`
		Data      string `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &env); err != nil {
		t.Fatalf("messages.batch envelope unmarshal: %v", err)
	}
	if env.SessionID != "s1" || env.Encoding != "gzip64" {
		t.Fatalf("messages.batch envelope: sessionID=%q encoding=%q, want s1/gzip64", env.SessionID, env.Encoding)
	}
	raw, err := base64.StdEncoding.DecodeString(env.Data)
	if err != nil {
		t.Fatalf("messages.batch data base64 decode: %v", err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("messages.batch gzip reader: %v", err)
	}
	dec, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("messages.batch gzip inflate: %v", err)
	}
	var inner struct {
		Messages []state.MessageWithParts `json:"messages"`
	}
	if err := json.Unmarshal(dec, &inner); err != nil {
		t.Fatalf("messages.batch inner unmarshal: %v", err)
	}
	if len(inner.Messages) != 4 {
		t.Fatalf("messages.batch: got %d rows, want the 4-row transcript (inner=%s)", len(inner.Messages), dec)
	}
	nsWireAssertRefined(t, "cold batch", nsWireMustRow(t, inner.Messages, "m_ns"))
	nsWireAssertControl(t, "cold batch", nsWireMustRow(t, inner.Messages, "m_ctrl"))
}
