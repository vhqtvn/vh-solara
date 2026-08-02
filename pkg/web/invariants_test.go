package web

// Property + handler tests for the standing-proof invariant diagnostic.
//
// Two families:
//
//  1. Daemon-side STRUCTURAL property tests (INV-4, INV-8) that exercise the
//     real state.Store via its PUBLIC API only (state.New + Apply +
//     SetSessionMessages + Subscribe/Replay + EmitTransient/EmitNotice).
//     These prove the structural halves that the live endpoint can only
//     DEFER (a single snapshot cannot observe emit-ordering or no-clobber).
//     NOTE: these live in package web (NOT pkg/state/pkg/aggregator) because
//     the scope fence for this slice forbids editing pkg/state/* /
//     pkg/aggregator/*. They call only exported methods — they add nothing.
//
//  2. HTTP handler tests for GET /vh/diag/invariants: happy (resident==source
//     → INV-1/2/3 pass, INV-4/8 deferred, master holds), partial hydrate
//     (extra source part → INV-1/2 fail), 405 on POST, 404 on an unopened
//     ?dir=, X-VH-Seq/Epoch header stamping, and the no-SSE-side-effect
//     contract (a diag GET on a cold session publishes no messages.batch /
//     messages.loaded).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// ----------------------------------------------------------------------------
// INV-4: every message-class emit is seq-stamped + ringed; transient emits
// fan out to live subscribers but advance neither seq nor the replay ring.
// ----------------------------------------------------------------------------

// messageClassKinds is the closed set of kinds that MUST carry a fresh Seq and
// live in the replay ring (they flow through store.emit). Asserted against both
// the subscriber channel and Replay(0).
var messageClassKinds = []string{
	state.KindMessageUpsert, // "message.upsert"
	state.KindMessageDelete, // "message.delete"
	state.KindPartUpsert,    // "part.upsert"
	state.KindPartDelete,    // "part.delete"
}

// TestEveryMessageClassEmitIsSeqStampedAndRinged is the structural proof for
// INV-4. It applies a session.create followed by one event of EACH message
// class (message.updated, message.part.updated, message.part.removed,
// message.removed) and asserts:
//   - every event delivered to a live subscriber carries a Seq that is strictly
//     monotonically increasing (proves emit's seq++ runs on every emit), AND
//   - all four message-class kinds appear in Replay(0) (proves ring.push).
//
// It then fires EmitTransient + EmitNotice and asserts the inverse half:
// those reach the live subscriber (fanout) but do NOT advance Head() and are
// ABSENT from Replay(0). Together this proves message-class events and
// transient events are structurally distinct on both the seq and ring axes.
func TestEveryMessageClassEmitIsSeqStampedAndRinged(t *testing.T) {
	st := state.New(1024)
	ch, unsub := st.Subscribe(256)
	defer unsub()

	// session.create first (a message.part.* needs a session+message envelope;
	// session.create also exercises an emit, which must be seq-stamped too).
	st.Apply(opencode.Event{
		Type:       "session.created",
		Properties: json.RawMessage(`{"info":{"id":"s1","title":"S"}}`),
	})
	// message.updated → KindMessageUpsert
	st.Apply(opencode.Event{
		Type:       "message.updated",
		Properties: json.RawMessage(`{"info":{"id":"m1","sessionID":"s1","role":"user"}}`),
	})
	// message.part.updated → KindPartUpsert
	st.Apply(opencode.Event{
		Type:       "message.part.updated",
		Properties: json.RawMessage(`{"part":{"id":"p1","sessionID":"s1","messageID":"m1","type":"text","text":"hi"}}`),
	})
	// message.part.removed → KindPartDelete
	st.Apply(opencode.Event{
		Type:       "message.part.removed",
		Properties: json.RawMessage(`{"sessionID":"s1","messageID":"m1","partID":"p1"}`),
	})
	// message.removed → KindMessageDelete
	st.Apply(opencode.Event{
		Type:       "message.removed",
		Properties: json.RawMessage(`{"sessionID":"s1","messageID":"m1"}`),
	})

	// Drain the synchronous-fanout subscriber channel (emit() sends under the
	// store lock into a buffered chan, so by the time Apply returns the event
	// is already enqueued). Channel order == emit order == seq order.
	got := drainChan(ch)

	if len(got) == 0 {
		t.Fatal("no events received on subscriber after Apply chain")
	}
	// (1) Strict monotonicity: every emit advances seq. Asserted across ALL
	// delivered events (session upsert included), which is the stronger form.
	var prevSeq uint64
	for i, ev := range got {
		if ev.Seq == 0 {
			t.Fatalf("event %d (%s): Seq must be >0 (seq-stamped), got 0", i, ev.Kind)
		}
		if ev.Seq <= prevSeq {
			t.Fatalf("event %d (%s): Seq %d not strictly > prev %d (seq++ regression)", i, ev.Kind, ev.Seq, prevSeq)
		}
		prevSeq = ev.Seq
	}

	// (2) All four message-class kinds were delivered to the live subscriber.
	kindsSeen := kindSet(got)
	for _, k := range messageClassKinds {
		if !kindsSeen[k] {
			t.Fatalf("message-class kind %q not delivered to subscriber; got kinds=%v", k, sortedBoolKeys(kindsSeen))
		}
	}

	// (3) All four message-class kinds appear in the replay ring (ring.push).
	replayed, head, ok := st.Replay(0)
	if !ok {
		t.Fatal("Replay(0) returned ok=false")
	}
	if head == 0 {
		t.Fatal("Replay(0) head must be >0 after emits")
	}
	ringKinds := kindSet(replayed)
	for _, k := range messageClassKinds {
		if !ringKinds[k] {
			t.Fatalf("message-class kind %q absent from Replay(0) ring (ring.push regression); ring kinds=%v", k, sortedBoolKeys(ringKinds))
		}
	}

	// --- inverse half: transient emits fan out but do NOT seq-stamp or ring ---
	headBeforeTransient := st.Head()

	st.EmitTransient("pins.updated", json.RawMessage(`{}`))
	st.EmitNotice(json.RawMessage(`{}`))

	transient := drainChan(ch)
	transientKinds := kindSet(transient)
	// Transient events MUST reach live subscribers (fanout is their only
	// delivery channel — they are not replayable).
	if !transientKinds["pins.updated"] {
		t.Fatalf("EmitTransient(\"pins.updated\") did not reach subscriber; got kinds=%v", sortedBoolKeys(transientKinds))
	}
	if !transientKinds[state.KindNotice] {
		t.Fatalf("EmitNotice did not reach subscriber; got kinds=%v", sortedBoolKeys(transientKinds))
	}
	// Transient emits MUST NOT advance the seq/head.
	if got := st.Head(); got != headBeforeTransient {
		t.Fatalf("transient emit advanced Head: want %d, got %d (transient must be seq-neutral)", headBeforeTransient, got)
	}
	// Transient emits MUST NOT enter the replay ring.
	replayed2, _, _ := st.Replay(0)
	ringKinds2 := kindSet(replayed2)
	if ringKinds2["pins.updated"] || ringKinds2[state.KindNotice] {
		t.Fatalf("transient emit entered the replay ring (must be fanout-only); ring kinds=%v", sortedBoolKeys(ringKinds2))
	}
}

// ----------------------------------------------------------------------------
// INV-8: messages.batch / SetSessionMessages reconcile never clobbers resident
// messages — absence from a fetched list is NEVER a delete (Option A).
// ----------------------------------------------------------------------------

// TestMessagesBatchDoesNotClobberResident is the structural proof for INV-8. It
// hydrates a session with two messages (m1 with two parts, m2 with one), then
// re-hydrates the SAME session with a list that OMITS m1 entirely. The
// reconcile must NOT delete m1 (or any of its parts): absence is never a
// delete. This is the no-clobber guarantee a single snapshot cannot observe.
func TestMessagesBatchDoesNotClobberResident(t *testing.T) {
	st := state.New(1024)
	st.Apply(opencode.Event{
		Type:       "session.created",
		Properties: json.RawMessage(`{"info":{"id":"s1","title":"S"}}`),
	})

	// First hydrate: m1{p1,p2} + m2{p3}.
	st.SetSessionMessages("s1", []state.MessageWithParts{
		{
			Info: json.RawMessage(`{"id":"m1","sessionID":"s1","role":"user"}`),
			Parts: []json.RawMessage{
				json.RawMessage(`{"id":"p1","sessionID":"s1","messageID":"m1","type":"text","text":"a"}`),
				json.RawMessage(`{"id":"p2","sessionID":"s1","messageID":"m1","type":"text","text":"b"}`),
			},
		},
		{
			Info: json.RawMessage(`{"id":"m2","sessionID":"s1","role":"assistant"}`),
			Parts: []json.RawMessage{
				json.RawMessage(`{"id":"p3","sessionID":"s1","messageID":"m2","type":"text","text":"c"}`),
			},
		},
	})

	rp := residentPartMap(t, st.Snapshot(map[string]bool{"s1": true}).Messages["s1"])
	if len(rp) != 2 {
		t.Fatalf("after first hydrate: want 2 resident messages, got %d (%v)", len(rp), sortedResidentKeys(rp))
	}
	assertParts(t, rp, "m1", []string{"p1", "p2"})
	assertParts(t, rp, "m2", []string{"p3"})

	// Second hydrate OMITS m1 — only re-asserts m2{p3}. Option A: absence
	// never deletes. m1 MUST remain resident with both its parts intact.
	st.SetSessionMessages("s1", []state.MessageWithParts{
		{
			Info: json.RawMessage(`{"id":"m2","sessionID":"s1","role":"assistant"}`),
			Parts: []json.RawMessage{
				json.RawMessage(`{"id":"p3","sessionID":"s1","messageID":"m2","type":"text","text":"c"}`),
			},
		},
	})

	rp2 := residentPartMap(t, st.Snapshot(map[string]bool{"s1": true}).Messages["s1"])
	// m1 must STILL be resident with p1 AND p2 (no clobber).
	if _, ok := rp2["m1"]; !ok {
		t.Fatalf("INV-8 VIOLATED: m1 was clobbered by a second SetSessionMessages that omitted it (Option A broken); resident=%v", sortedResidentKeys(rp2))
	}
	assertParts(t, rp2, "m1", []string{"p1", "p2"})
	// m2 intact.
	assertParts(t, rp2, "m2", []string{"p3"})
}

// ----------------------------------------------------------------------------
// HTTP handler tests for GET /vh/diag/invariants.
// ----------------------------------------------------------------------------

// diagMsgListJSON builds a one-message assistant list: a COMPLETED assistant
// message with one text part. A completed assistant turn is what makes the
// gate's MessagesLoaded / latestAssistantResidentLocked consistent with
// msgLoaded (so the happy-path test reaches a deterministic gate-consistent
// state). NOTE: opencode's time.completed is a NUMERIC Unix-seconds timestamp
// (parsed as *float64 by messageInfoEnvelope) — a string value aborts the
// whole info unmarshal and the message is silently skipped by the reconcile.
// extraPart, when non-empty, adds a second part to the message — used by the
// partial-hydrate test to force a source/resident part mismatch.
func diagMsgListJSON(sid, extraPart string) string {
	if extraPart != "" {
		return fmt.Sprintf(
			`[{"info":{"id":"m1","sessionID":%q,"role":"assistant","time":{"completed":1700000000}},"parts":[{"id":"p1","sessionID":%q,"messageID":"m1","type":"text","text":"hi"},{"id":"p2","sessionID":%q,"messageID":"m1","type":"text","text":"extra"}]}]`,
			sid, sid, sid,
		)
	}
	return fmt.Sprintf(
		`[{"info":{"id":"m1","sessionID":%q,"role":"assistant","time":{"completed":1700000000}},"parts":[{"id":"p1","sessionID":%q,"messageID":"m1","type":"text","text":"hi"}]}]`,
		sid, sid,
	)
}

// setupDiagTest wires fakeOpenCode + aggregator + web server for the diag
// endpoint. Seeds <sid> with a completed-assistant message list and hydrates
// it via EnsureMessages (the handler itself never hydrates). Returns the web
// base URL, the fake (so a test can re-seed the source list post-hydrate),
// and the aggregator (for direct store/SSE access in side-effect tests).
func setupDiagTest(t *testing.T, sid string) (webURL string, fake *fakeOpenCode, agg *aggregator.Aggregator) {
	t.Helper()
	fake = newFake()
	fake.sessions = []string{fmt.Sprintf(`{"id":%q,"title":"S"}`, sid)}
	fake.messages[sid] = diagMsgListJSON(sid, "")
	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)
	agg = aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go agg.Run(ctx)
	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	waitFor(t, func() bool { return len(agg.Store().SessionIDs()) >= 1 }, "session hydrated into tree")
	if err := agg.EnsureMessages(ctx, sid); err != nil {
		t.Fatalf("setup EnsureMessages: %v", err)
	}
	// Wait until the session reports as loaded so the diag default session
	// set (LoadedSessions) deterministically includes it.
	waitFor(t, func() bool {
		for _, s := range agg.Store().LoadedSessions() {
			if s == sid {
				return true
			}
		}
		return false
	}, "session reported loaded")
	return web.URL, fake, agg
}

// getDiag issues GET /vh/diag/invariants and returns the decoded envelope. Fails
// on an unexpected status (pass wantStatus to allow non-200).
func getDiag(t *testing.T, webURL, query string, wantStatus int) invariantsResp {
	t.Helper()
	u := webURL + "/vh/diag/invariants"
	if query != "" {
		u += "?" + query
	}
	resp, err := http.Get(u)
	if err != nil {
		t.Fatalf("diag GET: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != wantStatus {
		t.Fatalf("diag GET status: want %d, got %d, body=%s", wantStatus, resp.StatusCode, string(body))
	}
	var env invariantsResp
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("diag envelope unmarshal: %v\nraw=%s", err, string(body))
	}
	return env
}

// invStatus returns the status string for a named per-invariant result, or ""
// if absent.
func invStatus(s sessionInvariant, name string) string {
	for _, r := range s.PerInvariant {
		if r.Name == name {
			return r.Status
		}
	}
	return ""
}

// TestDiagInvariants_HappyPath pins the clean case: resident == source on a
// hydrated completed-assistant session. INV-1/INV-2/INV-3 pass, INV-4/INV-8
// are deferred (structural — proven by the property tests above), and the
// master invariant holds. The default session set (no ?sessions=) resolves to
// LoadedSessions, exercising that resolution path.
func TestDiagInvariants_HappyPath(t *testing.T) {
	webURL, _, _ := setupDiagTest(t, "s")
	env := getDiag(t, webURL, "", 200)
	if env.Epoch == "" {
		t.Fatalf("epoch: want non-empty, got empty")
	}
	if len(env.Sessions) != 1 {
		t.Fatalf("sessions: want 1 (the loaded session), got %d", len(env.Sessions))
	}
	s := env.Sessions[0]
	if s.SessionID != "s" {
		t.Fatalf("sessionID: want s, got %q", s.SessionID)
	}
	if !s.MasterInvariantHolds {
		t.Fatalf("master_invariant_holds: want true on clean resident==source, got false; diff=%+v gate=%+v source_err=%q", s.Diff, s.Gate, s.Source.Error)
	}
	if got := invStatus(s, "INV1_ingest_resident_eq_source"); got != "pass" {
		t.Fatalf("INV-1: want pass, got %q", got)
	}
	if got := invStatus(s, "INV2_hydrate_no_partial"); got != "pass" {
		t.Fatalf("INV-2: want pass, got %q", got)
	}
	if got := invStatus(s, "INV3_gate_loaded_iff_resident"); got != "pass" {
		t.Fatalf("INV-3: want pass, got %q (gate=%+v)", got, s.Gate)
	}
	// INV-4/INV-8 are structural → always deferred at runtime.
	if got := invStatus(s, "INV4_emit_seq_present"); got != "deferred" {
		t.Fatalf("INV-4: want deferred (structural), got %q", got)
	}
	if got := invStatus(s, "INV8_batch_no_clobber"); got != "deferred" {
		t.Fatalf("INV-8: want deferred (structural), got %q", got)
	}
	// Newest assistant projection is populated (the whole point of INV-7's
	// part-type surface — the daemon must expose which part kinds a completed
	// assistant turn holds).
	if s.Resident.NewestCompletedAssistant == nil {
		t.Fatalf("newest_completed_assistant: want populated, got nil")
	}
	if s.Resident.NewestCompletedAssistant.ID != "m1" {
		t.Fatalf("newest_completed_assistant.id: want m1, got %q", s.Resident.NewestCompletedAssistant.ID)
	}
}

// TestDiagInvariants_PartialHydrate pins INV-2 detection: after hydrate, the
// source list is re-seeded with an EXTRA part on the resident assistant
// message. The fresh diag fetch sees the extra source part the resident set
// lacks → INV-1 (diff non-empty) AND INV-2 (partial hydrate) both fail, and
// the master invariant releases.
func TestDiagInvariants_PartialHydrate(t *testing.T) {
	webURL, fake, _ := setupDiagTest(t, "s")
	// Re-seed the source list AFTER hydrate: add part p2 to the (already
	// resident) assistant message. The handler's fresh client.Messages fetch
	// returns the new list while the resident set still holds only p1.
	fake.setMessage("s", diagMsgListJSON("s", "extra"))
	env := getDiag(t, webURL, "sessions=s", 200)
	if len(env.Sessions) != 1 {
		t.Fatalf("sessions: want 1, got %d", len(env.Sessions))
	}
	s := env.Sessions[0]
	if s.MasterInvariantHolds {
		t.Fatalf("master_invariant_holds: want false (partial hydrate), got true; diff=%+v", s.Diff)
	}
	if got := invStatus(s, "INV1_ingest_resident_eq_source"); got != "fail" {
		t.Fatalf("INV-1: want fail (diff non-empty), got %q; diff=%+v", got, s.Diff)
	}
	if got := invStatus(s, "INV2_hydrate_no_partial"); got != "fail" {
		t.Fatalf("INV-2: want fail (resident message missing source part), got %q; diff=%+v", got, s.Diff)
	}
	// The missing part must be surfaced as a qualified "msgID/partID" entry.
	found := false
	for _, q := range s.Diff.MissingPartIDs {
		if q == "m1/p2" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing_part_ids: want \"m1/p2\", got %v", s.Diff.MissingPartIDs)
	}
}

// TestDiagInvariants_LoadedNoAssistantTurn pins U1: a LOADED session with NO
// completed assistant turn must report INV-3 Consistent=true, not the false-
// negative the pre-fix code produced (newestAssistant==nil → newestResident=
// false → spurious Consistent=false). The gate's latestAssistantResidentLocked
// returns true vacuously for "no assistant", so the resident-parts leg is N/A;
// Consistent hinges on msgLoaded==messagesLoaded only. The NewestAssistantResident
// FIELD stays false (factually: no resident assistant turn exists) — the fix is
// in the Consistent computation, not the field.
func TestDiagInvariants_LoadedNoAssistantTurn(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"s","title":"S"}`}
	// USER-only message list: no assistant turn → the diag handler's
	// newestAssistant is nil (no completed role:"assistant" message).
	fake.messages["s"] = `[{"info":{"id":"u1","sessionID":"s","role":"user"},"parts":[{"id":"p1","sessionID":"s","messageID":"u1","type":"text","text":"hi"}]}]`
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
	waitFor(t, func() bool { return len(agg.Store().SessionIDs()) >= 1 }, "session hydrated into tree")
	if err := agg.EnsureMessages(ctx, "s"); err != nil {
		t.Fatalf("EnsureMessages: %v", err)
	}
	waitFor(t, func() bool {
		for _, x := range agg.Store().LoadedSessions() {
			if x == "s" {
				return true
			}
		}
		return false
	}, "session reported loaded")

	env := getDiag(t, web.URL, "sessions=s", 200)
	if len(env.Sessions) != 1 {
		t.Fatalf("sessions: want 1, got %d", len(env.Sessions))
	}
	s := env.Sessions[0]
	// U1 crux: Consistent=true despite no assistant turn. The resident-parts
	// leg is N/A; only msgLoaded==messagesLoaded must agree (both true here).
	if !s.Gate.Consistent {
		t.Fatalf("U1: loaded session with no assistant turn should be Consistent=true (resident-parts leg N/A); got false; gate=%+v", s.Gate)
	}
	if got := invStatus(s, "INV3_gate_loaded_iff_resident"); got != "pass" {
		t.Fatalf("U1: INV-3 want pass (no-assistant turn is vacuously consistent), got %q; gate=%+v", got, s.Gate)
	}
	// The field stays false (factually accurate: no resident assistant turn).
	if s.Gate.NewestAssistantResident {
		t.Fatalf("U1: NewestAssistantResident field should be false (no assistant turn exists); got true")
	}
}

// TestDiagInvariants_MethodNotAllowed pins the GET-only contract: a POST is
// rejected. A POST without the X-VH-CSRF header is rejected 403 by the CSRF
// middleware BEFORE reaching this handler; to pin the handler's OWN method
// gate (405 + Allow), the POST carries the CSRF header so it reaches the
// handler and hits its GET/HEAD-only check.
func TestDiagInvariants_MethodNotAllowed(t *testing.T) {
	webURL, _, _ := setupDiagTest(t, "s")
	req, err := http.NewRequest(http.MethodPost, webURL+"/vh/diag/invariants", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-VH-CSRF", "1") // pass CSRF middleware so the handler's method gate is what fires
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST status: want 405, got %d", resp.StatusCode)
	}
	if resp.Header.Get("Allow") == "" {
		t.Fatalf("Allow header: want non-empty on 405, got empty")
	}
}

// TestDiagInvariants_UnopenedDir404 pins the side-effect-free contract: a
// diagnostic against an UNOPENED ?dir= must NOT open the project (aggFor would
// fire managed-project hooks). It returns 404 instead (aggForExisting returns
// nil for a dir with no running aggregator).
func TestDiagInvariants_UnopenedDir404(t *testing.T) {
	webURL, _, _ := setupDiagTest(t, "s")
	resp, err := http.Get(webURL + "/vh/diag/invariants?dir=" + "never-opened")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unopened dir status: want 404 (side-effect-free), got %d", resp.StatusCode)
	}
}

// TestDiagInvariants_HeadersStamped pins that the stampMeta middleware stamps
// X-VH-Seq + X-VH-Epoch on the diag response (every /vh/* response carries
// them).
func TestDiagInvariants_HeadersStamped(t *testing.T) {
	webURL, _, _ := setupDiagTest(t, "s")
	resp, err := http.Get(webURL + "/vh/diag/invariants?sessions=s")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("X-VH-Seq") == "" {
		t.Errorf("X-VH-Seq: want non-empty, got empty")
	}
	if resp.Header.Get("X-VH-Epoch") == "" {
		t.Errorf("X-VH-Epoch: want non-empty, got empty")
	}
}

// TestDiagInvariants_NoSSESideEffect pins that a diag GET on a COLD (not-yet-
// hydrated) session publishes NO messages.batch / messages.loaded. The handler
// is a pure read: it must not call EnsureMessages (which would emit cold-load
// SSE events). Mirrors TestMessagesEndpoint_NoSSESideEffect.
func TestDiagInvariants_NoSSESideEffect(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"cold","title":"C"}`}
	fake.messages["cold"] = diagMsgListJSON("cold", "")
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
	// Wait for the session tree but leave the session COLD (no EnsureMessages).
	waitFor(t, func() bool { return len(agg.Store().SessionIDs()) >= 1 }, "session in tree")
	store := agg.Store()
	ch, unsub := store.Subscribe(64)
	defer unsub()
	// GET diag for the cold session, naming it explicitly so the handler
	// checks it without it being in LoadedSessions.
	resp, err := http.Get(web.URL + "/vh/diag/invariants?sessions=cold")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: want 200, got %d, body=%s", resp.StatusCode, string(body))
	}
	// Drain any events published during/after the request. emit() is
	// synchronous under the store lock, so any publication triggered by the
	// handler completes before the HTTP response returns. A messages.batch /
	// messages.loaded for "cold" would prove the handler triggered hydration.
drainLoop:
	for i := 0; i < 64; i++ {
		select {
		case ev, ok := <-ch:
			if !ok {
				break drainLoop
			}
			if ev.Kind == "messages.batch" || ev.Kind == "messages.loaded" {
				if strings.Contains(string(ev.Payload), `"cold"`) {
					t.Fatalf("diag handler published %s for cold session (side-effect regression): payload=%s", ev.Kind, string(ev.Payload))
				}
			}
		default:
			break drainLoop
		}
	}
}

// ----------------------------------------------------------------------------
// test helpers
// ----------------------------------------------------------------------------

// drainChan non-blockingly drains a ClientEvent channel into a slice.
func drainChan(ch <-chan state.ClientEvent) []state.ClientEvent {
	out := make([]state.ClientEvent, 0, 16)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, ev)
		default:
			return out
		}
	}
}

// kindSet builds a set of the Kind values from a slice of ClientEvents.
func kindSet(evs []state.ClientEvent) map[string]bool {
	m := make(map[string]bool, len(evs))
	for _, e := range evs {
		m[e.Kind] = true
	}
	return m
}

// sortedBoolKeys returns the sorted keys of a string->bool map (stable
// assertion output). Named distinctly from managed.go's sortedKeys
// (map[string]string) to avoid a same-package collision.
func sortedBoolKeys(m map[string]bool) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// sortedResidentKeys returns the sorted message ids of a resident projection
// (msgID -> part set).
func sortedResidentKeys(m map[string]map[string]bool) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// residentPartMap projects a resident message list into msgID -> set(partID).
func residentPartMap(t *testing.T, msgs []state.MessageWithParts) map[string]map[string]bool {
	t.Helper()
	out := map[string]map[string]bool{}
	for _, mw := range msgs {
		var info struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(mw.Info, &info) != nil || info.ID == "" {
			continue
		}
		ps := map[string]bool{}
		for _, pb := range mw.Parts {
			var p struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(pb, &p) == nil && p.ID != "" {
				ps[p.ID] = true
			}
		}
		out[info.ID] = ps
	}
	return out
}

// assertParts fails if message <mid> is absent from rp or is missing any of
// want.
func assertParts(t *testing.T, rp map[string]map[string]bool, mid string, want []string) {
	t.Helper()
	got, ok := rp[mid]
	if !ok {
		t.Fatalf("message %q not resident (want parts %v)", mid, want)
	}
	for _, p := range want {
		if !got[p] {
			t.Fatalf("message %q missing resident part %q; have %v", mid, p, sortedBoolKeys(got))
		}
	}
}
