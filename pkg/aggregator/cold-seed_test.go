package aggregator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// TestReseedCreatedSessionAgentEmptyTailStaysEligibleThenMemoizes is the W4
// debt-paydown proof for reseedCreatedSessionAgent's memo placement. A first
// re-seed whose tail has NO assistant turn (the genuinely-new-session shape)
// must NOT mark the cold-seed memo: the session stays retry-eligible, so a
// later trigger (a mid-stream remove/recreate's session.created, or a reconnect
// hydrate) performs a SECOND tail GET and recovers the agent. The NOW-successful
// seed memoizes, suppressing a THIRD GET. Pre-fix, the unconditional
// MarkColdSeeded pinned the memo on the empty tail, so the retry never happened
// and the session's lastAgent stayed empty forever on a connected daemon.
//
// CONTRACT (observed via the in-package HTTP-counting seam — per-sid tail GETs
// (?limit=coldTailLimit), the tail counterpart of the full-fetch counters in
// messages_resident_test.go):
//   - GET #1 (empty tail) → no lastAgent write, NO memo → ColdSeedNeeded still
//     returns the id
//   - GET #2 (agent "B")  → lastAgent["s_reseed"] == "B", memo marked
//   - third re-seed call  → ColdSeedNeeded guard exits pre-HTTP → count stays 2
func TestReseedCreatedSessionAgentEmptyTailStaysEligibleThenMemoizes(t *testing.T) {
	h := &reseedTailHandler{
		inner: fixtures.New().Handler(),
		count: map[string]int{},
		// Armed from the start with the empty tail: every s_reseed tail GET is
		// answered here (never delegated), so the count is exact.
		tails: map[string]string{"s_reseed": ""},
	}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	// The production trigger shape: a session.created for an id the hydrate
	// never saw (mid-stream remove/recreate), applied to the store — the same
	// event lifecycle.go routes to startCreatedSessionReseed.
	agg.Store().Apply(opencode.Event{Type: "session.created", Properties: json.RawMessage(`{"info":{"id":"s_reseed"}}`)})
	if got := agg.Store().ColdSeedNeeded([]string{"s_reseed"}); len(got) != 1 {
		t.Fatalf("precondition: s_reseed must be tracked and un-seeded, got %v", got)
	}

	// Seed #1: empty tail. Must fetch (GET #1) but NOT memoize.
	agg.reseedCreatedSessionAgent(context.Background(), "s_reseed")
	if got, want := h.tailGETs("s_reseed"), 1; got != want {
		t.Fatalf("first re-seed must tail-fetch exactly once: GETs=%d want %d", got, want)
	}
	if got := agg.Store().ColdSeedNeeded([]string{"s_reseed"}); len(got) != 1 {
		t.Fatalf("empty-tail re-seed must NOT memoize (session stays retry-eligible), ColdSeedNeeded=%v", got)
	}

	// The session's first assistant turn lands (agent B).
	h.armTail("s_reseed", `[{"info":{"id":"rm1","sessionID":"s_reseed","role":"assistant","agent":"B"}}]`)

	// Seed #2: valid tail → GET #2 → agent B recovered AND memoized.
	agg.reseedCreatedSessionAgent(context.Background(), "s_reseed")
	if got, want := h.tailGETs("s_reseed"), 2; got != want {
		t.Fatalf("retry after empty tail must perform a SECOND tail GET: GETs=%d want %d", got, want)
	}
	if got := agg.Store().Snapshot(nil).LastAgents["s_reseed"]; got != "B" {
		t.Fatalf("second re-seed must recover agent B, got %q", got)
	}

	// Seed #3: the successful memo must suppress a third GET entirely.
	agg.reseedCreatedSessionAgent(context.Background(), "s_reseed")
	if got, want := h.tailGETs("s_reseed"), 2; got != want {
		t.Fatalf("successful seed must memoize and prevent a THIRD tail GET: GETs=%d want %d", got, want)
	}
}

// TestColdSeedReseedLateHeldResponseKeepsLoadedAgent is the W5
// late-overwrite falsification cell (third-pass brief
// tmp/agent-runs/defer-restudy-2026-11-16/solution-brief-final-5.md, "O1 —
// defer-reseed-adversarial-coverage: DO-NOW investigation" / "Proposed W5"):
// a slow reseed tail response whose OLD data (agent A) was captured BEFORE a
// newer authoritative history load (agent B, via SetSessionMessages — the
// message-recompute path that owns a loaded session's lastAgent) must NOT
// clobber B when it finally lands. The interleaving, exactly as the brief
// encodes it:
//
//  1. s_late tracked+unloaded+unseeded → reseed fetches the tail (GET #1);
//  2. the handler CAPTURES the request and A's armed body, then blocks
//     BEFORE writing the response (holdTail rendezvous);
//  3. SetSessionMessages installs authoritative history with agent B →
//     session becomes LOADED, snapshot lastAgent = B;
//  4. the held response A is released and the reseed completes;
//  5. THE CELL: snapshot lastAgent must STILL be B (A must not overwrite
//     it), and exactly ONE tail GET may have occurred for s_late.
//
// A != B deliberately (an identical-agent clobber would be an invisible
// no-op at setLastAgentLocked's unchanged guard). Static prediction was RED
// (reseedCreatedSessionAgent checks loaded-state only at entry, before the
// fetch; setLastAgentLocked has no loaded fence) — a genuine failure here is
// a FINDING to be repaired in a separate slice, not an in-slice fix.
func TestColdSeedReseedLateHeldResponseKeepsLoadedAgent(t *testing.T) {
	h := &reseedTailHandler{
		inner: fixtures.New().Handler(),
		count: map[string]int{},
		tails: map[string]string{},
	}
	oc := httptest.NewServer(h)

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		defer oc.Close()
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	// The production trigger shape (same as the W4 cell above): a
	// session.created for an id the hydrate never saw, applied to the store —
	// the event lifecycle.go routes to the single-id reseed.
	agg.Store().Apply(opencode.Event{Type: "session.created", Properties: json.RawMessage(`{"info":{"id":"s_late"}}`)})
	if got := agg.Store().ColdSeedNeeded([]string{"s_late"}); len(got) != 1 {
		defer oc.Close()
		t.Fatalf("precondition: s_late must be tracked and un-seeded, got %v", got)
	}

	// Arm OLD agent A and HOLD the response: the first armed GET is captured
	// (counted), announced via `entered`, and its body write blocks.
	entered, release := h.holdTail("s_late", `[{"info":{"id":"la0","sessionID":"s_late","role":"assistant","agent":"A"}}]`)

	// Cleanup order is LIFO and load-bearing: release() runs FIRST (unblocks
	// the held GET on any assertion-failure path), then the goroutine join,
	// then oc.Close — httptest.Server.Close waits for outstanding requests,
	// so releasing before Close is what keeps failure paths deadlock-free.
	done := make(chan struct{})
	defer oc.Close()
	defer func() { <-done }()
	defer release()

	go func() {
		defer close(done)
		agg.reseedCreatedSessionAgent(context.Background(), "s_late")
	}()

	// The reseed has captured response A: its GET is counted and held
	// pre-body, which also proves it is past the entry loaded/memo guards.
	<-entered

	// Authoritative history B lands in the SAME session while A is held.
	agg.Store().SetSessionMessages("s_late", []state.MessageWithParts{
		{Info: json.RawMessage(`{"id":"lb1","sessionID":"s_late","role":"user"}`)},
		{Info: json.RawMessage(`{"id":"lb2","sessionID":"s_late","role":"assistant","agent":"B"}`)},
	})
	loaded := false
	for _, id := range agg.Store().LoadedSessions() {
		if id == "s_late" {
			loaded = true
		}
	}
	if !loaded {
		t.Fatalf("precondition: s_late must be LOADED after SetSessionMessages")
	}
	if got := agg.Store().Snapshot(nil).LastAgents["s_late"]; got != "B" {
		t.Fatalf("precondition: authoritative load must set lastAgent B, got %q", got)
	}

	// Release the stale response A and join the reseed completion.
	release()
	<-done

	// THE CELL: the authoritative loaded agent B must SURVIVE the late old-A
	// response — A must not clobber it.
	if got := agg.Store().Snapshot(nil).LastAgents["s_late"]; got != "B" {
		t.Fatalf("HAZARD MANIFESTED (third-pass brief O1, loaded-B/late-A cell): late old-agent tail response (agent %q) clobbered the authoritative loaded lastAgent B", got)
	}
	// Exactly ONE tail GET for s_late (the held one): rules out an
	// accidental extra fetch masking or manufacturing the outcome.
	if got, want := h.tailGETs("s_late"), 1; got != want {
		t.Fatalf("exactly one tail GET expected for the held reseed: GETs=%d want %d", got, want)
	}
}

// ---------------------------------------------------------------------------
// W7 adversarial cells (delete-mid-fetch, cancel-mid-fetch, and the
// conditional unloaded delete/recreate). Shared helpers first: every
// rendezvous is bounded (a violated ordering is a deterministic red, never a
// 10-minute suite hang), the reseed goroutine never calls t.Fatalf (its
// Goexit would strand the test's join — failures surface via test-side
// assertions), and each cell registers its release/join/Close defers LIFO
// immediately after arming its hold.
// ---------------------------------------------------------------------------

// reseedWaitBound bounds every W7 rendezvous/join wait. It is a failure
// signal, not a synchronization knob: exceeding it means an expected
// rendezvous did not happen, which is the finding — diagnose the ordering,
// never bump the bound.
const reseedWaitBound = 5 * time.Second

// waitReseed waits for ch up to reseedWaitBound, failing the test with `what`
// on timeout instead of hanging the suite.
func waitReseed(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(reseedWaitBound):
		t.Fatalf("timed out after %v waiting for %s — deterministic red: diagnose the ordering, do not bump the bound", reseedWaitBound, what)
	}
}

// startReseed runs reseedCreatedSessionAgent on ctx in a goroutine and
// returns its completion channel. The goroutine itself never fails the test.
func startReseed(ctx context.Context, agg *Aggregator, sid string) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		agg.reseedCreatedSessionAgent(ctx, sid)
	}()
	return done
}

// newReseedAgg builds the W7 cell harness: a fixture-backed hold/count
// server plus a rehydrated aggregator whose initial batch cold-seed has
// settled, so the single-id reseed path is exercised in isolation.
func newReseedAgg(t *testing.T) (*Aggregator, *reseedTailHandler, *httptest.Server) {
	t.Helper()
	h := &reseedTailHandler{
		inner: fixtures.New().Handler(),
		count: map[string]int{},
		tails: map[string]string{},
	}
	oc := httptest.NewServer(h)
	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		oc.Close()
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()
	return agg, h, oc
}

// trackCreatedSession applies the production session.created shape — the
// same store-level event application lifecycle.go's event callback performs
// (Apply, then the session.created handling that routes to
// startCreatedSessionReseed) — and asserts the tracked+unseeded precondition
// the reseed's ColdSeedNeeded guard requires.
func trackCreatedSession(t *testing.T, agg *Aggregator, sid string) {
	t.Helper()
	agg.Store().Apply(opencode.Event{Type: "session.created", Properties: json.RawMessage(`{"info":{"id":"` + sid + `"}}`)})
	if got := agg.Store().ColdSeedNeeded([]string{sid}); len(got) != 1 {
		t.Fatalf("precondition: %s must be tracked and un-seeded, got %v", sid, got)
	}
}

// TestColdSeedReseedDeleteMidFetchKeepsDeletedSessionClean is W7 cell 1: the
// session is deleted while the reseed tail GET is held, and the late response
// (old agent A) must land NOTHING — no stale lastAgent on the deleted id, no
// memo residue — so a recreated same-id session can still be re-seeded fresh.
// Grounding for the expected-green outcome: MarkColdSeeded no-ops on an
// absent session (hydration.go) and setLastAgentLocked no-ops on an unknown
// session (reducers.go); deleteSessionLocked wiped both maps. The recreation
// leg then pins the documented intent (cold-seed.go: a recreated id gets its
// lastAgent re-seeded from a fresh tail fetch, memoized on success).
func TestColdSeedReseedDeleteMidFetchKeepsDeletedSessionClean(t *testing.T) {
	agg, h, oc := newReseedAgg(t)
	const sid = "s_del"
	trackCreatedSession(t, agg, sid)

	entered, release := h.holdTail(sid, `[{"info":{"id":"d0","sessionID":"s_del","role":"assistant","agent":"A"}}]`)
	done := startReseed(context.Background(), agg, sid)
	// LIFO failure-safe cleanup: release the held GET, join the reseed
	// goroutine (bounded), then Close (which waits for outstanding requests).
	defer oc.Close()
	defer func() { waitReseed(t, done, "reseed completion (cleanup)") }()
	defer release()

	waitReseed(t, entered, "held tail GET capture")

	// The delete lands while the tail GET is held (a live session.deleted
	// racing a slow tail; the same store path lifecycle.go applies).
	agg.Store().Apply(opencode.Event{Type: "session.deleted", Properties: json.RawMessage(`{"info":{"id":"s_del"}}`)})
	if got := agg.Store().ColdSeedNeeded([]string{sid}); len(got) != 0 {
		t.Fatalf("precondition: a deleted session must not be cold-seed-needed, got %v", got)
	}

	release()
	waitReseed(t, done, "reseed completion after delete")

	// THE CELL: the late agent-A response must not resurrect anything.
	if got := agg.Store().Snapshot(nil).LastAgents[sid]; got != "" {
		t.Fatalf("HAZARD MANIFESTED: late tail response wrote stale agent %q into a deleted session", got)
	}
	if got := agg.Store().ColdSeedNeeded([]string{sid}); len(got) != 0 {
		t.Fatalf("late response must not leave memo eligibility for a deleted session, got %v", got)
	}
	if got, want := h.tailGETs(sid), 1; got != want {
		t.Fatalf("exactly one tail GET for the held reseed: GETs=%d want %d", got, want)
	}

	// The RECREATED session (delete/recreate after completion) must re-seed
	// fresh: agent B lands, exactly one new GET, and the memo suppresses a
	// third fetch.
	trackCreatedSession(t, agg, sid)
	h.armTail(sid, `[{"info":{"id":"d1","sessionID":"s_del","role":"assistant","agent":"B"}}]`)
	agg.reseedCreatedSessionAgent(context.Background(), sid)
	if got := agg.Store().Snapshot(nil).LastAgents[sid]; got != "B" {
		t.Fatalf("recreated session must re-seed agent B, got %q", got)
	}
	if got, want := h.tailGETs(sid), 2; got != want {
		t.Fatalf("recreated session must be re-fetched exactly once: GETs=%d want %d", got, want)
	}
	agg.reseedCreatedSessionAgent(context.Background(), sid)
	if got, want := h.tailGETs(sid), 2; got != want {
		t.Fatalf("successful re-seed must memoize (no third GET): GETs=%d want %d", got, want)
	}
}

// TestColdSeedReseedCancelMidFetchCompletesClientSideAndRetries is W7 cell 2:
// the CLIENT context is cancelled while the server still holds the response.
// The client-side reseed helper must COMPLETE while the hold is still closed
// (Go's http.Client returns on request-ctx cancellation without waiting for
// the server — pkg/opencode/client.go binds the ctx), consume no memo, write
// nothing, and a retry under a fresh context must still fetch and memoize.
// The ordering claim is asserted structurally: waitReseed(done) runs BEFORE
// release() in program order — a client that blocked until the server
// responded would fail the bounded wait deterministically.
func TestColdSeedReseedCancelMidFetchCompletesClientSideAndRetries(t *testing.T) {
	agg, h, oc := newReseedAgg(t)
	const sid = "s_can"
	trackCreatedSession(t, agg, sid)

	entered, release := h.holdTail(sid, `[{"info":{"id":"c0","sessionID":"s_can","role":"assistant","agent":"A"}}]`)
	ctx, cancel := context.WithCancel(context.Background())
	done := startReseed(ctx, agg, sid)
	// LIFO failure-safe cleanup: cancel (a live ctx also unblocks the client),
	// release the abandoned handler, bounded-join, then Close.
	defer oc.Close()
	defer func() { waitReseed(t, done, "cancelled reseed completion (cleanup)") }()
	defer release()
	defer cancel()

	waitReseed(t, entered, "held tail GET capture")

	// Cancel while the response is still held server-side.
	cancel()
	waitReseed(t, done, "client-side completion while the hold is still closed")

	// No mutation, memo unconsumed (the error path returns before
	// MarkColdSeeded/SetLastAgents), exactly one GET so far.
	if got := agg.Store().Snapshot(nil).LastAgents[sid]; got != "" {
		t.Fatalf("cancelled fetch must not write lastAgent, got %q", got)
	}
	if got := agg.Store().ColdSeedNeeded([]string{sid}); len(got) != 1 {
		t.Fatalf("cancelled fetch must leave the session retry-eligible (memo unconsumed), ColdSeedNeeded=%v", got)
	}
	if got, want := h.tailGETs(sid), 1; got != want {
		t.Fatalf("exactly one tail GET before the retry: GETs=%d want %d", got, want)
	}

	// Free the abandoned server handler, then retry under a FRESH context.
	release()
	h.armTail(sid, `[{"info":{"id":"c1","sessionID":"s_can","role":"assistant","agent":"B"}}]`)
	agg.reseedCreatedSessionAgent(context.Background(), sid)
	if got := agg.Store().Snapshot(nil).LastAgents[sid]; got != "B" {
		t.Fatalf("retry after cancel must recover agent B, got %q", got)
	}
	if got, want := h.tailGETs(sid), 2; got != want {
		t.Fatalf("retry must perform exactly one new GET: GETs=%d want %d", got, want)
	}
	agg.reseedCreatedSessionAgent(context.Background(), sid)
	if got, want := h.tailGETs(sid), 2; got != want {
		t.Fatalf("successful retry must memoize (no third GET): GETs=%d want %d", got, want)
	}
}

// TestColdSeedReseedDeleteRecreateUnloadedBeforeOldResponse is W7 cell 3,
// landed on the AFFIRMATIVE pre-flight adjudication (F3 H1 source_records:
// the plain session.deleted -> session.created dance re-tracks the id
// UNLOADED+UNSEEDED while an old reseed GET is still pending; nothing
// auto-opens a mid-stream recreation; no incarnation fence exists on the
// write path). The recreation is staged via Store().Apply events ONLY —
// SetSessionMessages is deliberately NOT used (it would load the session and
// repeat the already-paid W6 loaded-fence cell). Agents A != B so a clobber
// cannot hide at the unchanged guard.
//
// The cell asserts the DESIRED outcome: the late old-A response must write
// nothing into the fresh unloaded incarnation and consume none of its memo;
// the incarnation's own tail (B) must then seed and memoize. Static
// prediction is RED (MarkColdSeeded marks any existing id; SetLastAgents
// fences only msgLoaded; setLastAgentLocked checks only existence+unchanged)
// — a genuine red here is a FINDING for the source card, preserved with a
// tree-bound receipt and repaired in a separate slice, never in-slice.
func TestColdSeedReseedDeleteRecreateUnloadedBeforeOldResponse(t *testing.T) {
	agg, h, oc := newReseedAgg(t)
	const sid = "s_rec"
	trackCreatedSession(t, agg, sid)

	// The old incarnation's slow tail (agent A), captured and held.
	entered, release := h.holdTail(sid, `[{"info":{"id":"r0","sessionID":"s_rec","role":"assistant","agent":"A"}}]`)
	done := startReseed(context.Background(), agg, sid)
	defer oc.Close()
	defer func() { waitReseed(t, done, "old-incarnation reseed completion (cleanup)") }()
	defer release()

	waitReseed(t, entered, "held tail GET capture")

	// The production mid-stream remove/recreate dance while the old GET is
	// pending: plain deleted -> created (NOT archive-shaped, which the
	// store's resurrection tombstone suppresses), leaving the recreation
	// UNLOADED — nobody has opened it.
	agg.Store().Apply(opencode.Event{Type: "session.deleted", Properties: json.RawMessage(`{"info":{"id":"s_rec"}}`)})
	trackCreatedSession(t, agg, sid)
	for _, loaded := range agg.Store().LoadedSessions() {
		if loaded == sid {
			t.Fatalf("precondition: the recreated session must be UNLOADED for this cell")
		}
	}

	release()
	waitReseed(t, done, "old-incarnation reseed completion")

	// THE CELL: no stale A into the fresh incarnation, no consumed memo.
	if got := agg.Store().Snapshot(nil).LastAgents[sid]; got != "" {
		t.Fatalf("HAZARD MANIFESTED: late old-incarnation tail response (agent %q) seeded the UNLOADED recreated session", got)
	}
	if got := agg.Store().ColdSeedNeeded([]string{sid}); len(got) != 1 {
		t.Fatalf("late old response must not consume the recreated session's memo, ColdSeedNeeded=%v", got)
	}

	// The fresh incarnation's own tail (B) must still seed and memoize.
	h.armTail(sid, `[{"info":{"id":"r1","sessionID":"s_rec","role":"assistant","agent":"B"}}]`)
	agg.reseedCreatedSessionAgent(context.Background(), sid)
	if got := agg.Store().Snapshot(nil).LastAgents[sid]; got != "B" {
		t.Fatalf("recreated session must seed its OWN tail agent B, got %q", got)
	}
	if got, want := h.tailGETs(sid), 2; got != want {
		t.Fatalf("fresh incarnation must be fetched exactly once: GETs=%d want %d", got, want)
	}
	agg.reseedCreatedSessionAgent(context.Background(), sid)
	if got, want := h.tailGETs(sid), 2; got != want {
		t.Fatalf("successful seed must memoize (no third GET): GETs=%d want %d", got, want)
	}
}

// TestColdSeedBatchDeleteRecreateMidFanOutKeepsFreshIncarnationClean is the
// W8 batch-sibling cell (obligation adopted from the W8 F3 adversarial
// review: no existing pin covered a delete/recreate shape on the BATCH
// hydrate path, so a batch fence regression would have landed green). It
// drives seedColdLastAgents directly — the fan-out the hydrate path runs —
// with one id's tail GET held: a delete/recreate dance landing while that
// GET is pending must leave the fresh incarnation clean (no stale agent from
// the old response, memo unconsumed), and the fresh incarnation's own tail
// (B) must then seed and memoize via the single-id reseed path.
func TestColdSeedBatchDeleteRecreateMidFanOutKeepsFreshIncarnationClean(t *testing.T) {
	agg, h, oc := newReseedAgg(t)
	const sid = "s_bat"
	trackCreatedSession(t, agg, sid)

	// The batch fan-out's slow tail (agent A) for the one candidate session,
	// captured and held.
	entered, release := h.holdTail(sid, `[{"info":{"id":"b0","sessionID":"s_bat","role":"assistant","agent":"A"}}]`)
	done := make(chan struct{})
	go func() {
		defer close(done)
		agg.seedColdLastAgents(context.Background(), []json.RawMessage{json.RawMessage(`{"id":"` + sid + `"}`)})
	}()
	// LIFO failure-safe cleanup: release the held GET, bounded-join the
	// fan-out, then Close (which waits for outstanding requests).
	defer oc.Close()
	defer func() { waitReseed(t, done, "batch fan-out completion (cleanup)") }()
	defer release()

	waitReseed(t, entered, "held batch tail GET capture")

	// The mid-stream remove/recreate dance while the batch GET is pending
	// (same staging as cell 3: plain Store().Apply events, recreation left
	// UNLOADED).
	agg.Store().Apply(opencode.Event{Type: "session.deleted", Properties: json.RawMessage(`{"info":{"id":"s_bat"}}`)})
	trackCreatedSession(t, agg, sid)
	for _, loaded := range agg.Store().LoadedSessions() {
		if loaded == sid {
			t.Fatalf("precondition: the recreated session must be UNLOADED for this cell")
		}
	}

	release()
	waitReseed(t, done, "batch fan-out completion")

	// THE CELL: the held old-incarnation response must have landed nothing —
	// no stale agent A, no consumed memo (the batch fence declined both).
	if got := agg.Store().Snapshot(nil).LastAgents[sid]; got != "" {
		t.Fatalf("HAZARD MANIFESTED: late batch tail response (agent %q) seeded the UNLOADED recreated session", got)
	}
	if got := agg.Store().ColdSeedNeeded([]string{sid}); len(got) != 1 {
		t.Fatalf("late batch response must not consume the recreated session's memo, ColdSeedNeeded=%v", got)
	}

	// The fresh incarnation's own tail (B) must seed and memoize.
	h.armTail(sid, `[{"info":{"id":"b1","sessionID":"s_bat","role":"assistant","agent":"B"}}]`)
	agg.reseedCreatedSessionAgent(context.Background(), sid)
	if got := agg.Store().Snapshot(nil).LastAgents[sid]; got != "B" {
		t.Fatalf("recreated session must seed its OWN tail agent B, got %q", got)
	}
	if got, want := h.tailGETs(sid), 2; got != want {
		t.Fatalf("fresh incarnation must be fetched exactly once: GETs=%d want %d", got, want)
	}
	agg.reseedCreatedSessionAgent(context.Background(), sid)
	if got, want := h.tailGETs(sid), 2; got != want {
		t.Fatalf("successful seed must memoize (no third GET): GETs=%d want %d", got, want)
	}
}

// TestColdSeedBatchMarkedThenRecreatedBeforeFinalWriteDeclinesStaleWrite is
// the W8 write-side-fence cell (commit-review F1 obligation): unlike the
// other W8 cells — where the delete/recreate lands while the GET is still
// HELD, so the incarnation-fenced MARK declines first and the final write is
// never reached — this cell drives the schedule where the mark SUCCEEDS at
// the captured incarnation and the remove/recreate dance lands BETWEEN that
// mark and the fan-out's post-wg.Wait final write. The blocked-on-B fan-out
// provides the window deterministically: session s_wsa's tail GET completes
// and marks while s_wsb's held GET keeps wg.Wait pending; the dance then
// bumps s_wsa's incarnation; on release, the accumulated {agent A,
// incarnation 0} write must be DECLINED by SetLastAgentAtIncarnation — no
// stale agent, memo unconsumed, fresh incarnation re-seeds from its own tail.
func TestColdSeedBatchMarkedThenRecreatedBeforeFinalWriteDeclinesStaleWrite(t *testing.T) {
	agg, h, oc := newReseedAgg(t)
	const (
		sa = "s_wsa" // the session whose final write must be fenced out
		sb = "s_wsb" // the fan-out blocker keeping wg.Wait pending
	)
	trackCreatedSession(t, agg, sa)
	trackCreatedSession(t, agg, sb)

	// sa's tail (agent A) answers immediately — its fetch completes and its
	// incarnation-fenced MARK succeeds while the fan-out below is still
	// blocked on sb's held GET.
	h.armTail(sa, `[{"info":{"id":"wa0","sessionID":"s_wsa","role":"assistant","agent":"A"}}]`)
	entered, release := h.holdTail(sb, `[{"info":{"id":"wb0","sessionID":"s_wsb","role":"assistant","agent":"X"}}]`)
	done := make(chan struct{})
	go func() {
		defer close(done)
		agg.seedColdLastAgents(context.Background(), []json.RawMessage{
			json.RawMessage(`{"id":"` + sa + `"}`),
			json.RawMessage(`{"id":"` + sb + `"}`),
		})
	}()
	defer oc.Close()
	defer func() { waitReseed(t, done, "fan-out completion (cleanup)") }()
	defer release()

	// The blocker's GET is captured and held — the fan-out is running and
	// wg.Wait cannot complete until release() below.
	waitReseed(t, entered, "held blocker GET capture")

	// Bounded poll for sa's memo being consumed (the successful mark at
	// incarnation 0) — a monotone observable condition, so the bounded wait
	// stays deterministic in outcome.
	deadline := time.After(reseedWaitBound)
	for {
		if got := agg.Store().ColdSeedNeeded([]string{sa}); len(got) == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for %s's batch mark — deterministic red: diagnose the ordering, do not bump the bound", sa)
		case <-time.After(5 * time.Millisecond):
		}
	}

	// The dance lands BETWEEN sa's mark and the fan-out's final write (which
	// cannot run: wg.Wait is still blocked on sb's held GET). sa's
	// incarnation advances; the recreation is UNLOADED.
	agg.Store().Apply(opencode.Event{Type: "session.deleted", Properties: json.RawMessage(`{"info":{"id":"` + sa + `"}}`)})
	trackCreatedSession(t, agg, sa)
	for _, loaded := range agg.Store().LoadedSessions() {
		if loaded == sa {
			t.Fatalf("precondition: the recreated session must be UNLOADED for this cell")
		}
	}

	release()
	waitReseed(t, done, "fan-out completion")

	// THE CELL (write-side fence): the already-MARKED stale seed must be
	// DECLINED at the final write — no stale A, and the delete's memo clear
	// leaves the fresh incarnation retry-eligible.
	if got := agg.Store().Snapshot(nil).LastAgents[sa]; got != "" {
		t.Fatalf("HAZARD MANIFESTED: batch final write landed stale agent %q after the session was recreated mid-fan-out", got)
	}
	if got := agg.Store().ColdSeedNeeded([]string{sa}); len(got) != 1 {
		t.Fatalf("recreated session must be retry-eligible after the dance, ColdSeedNeeded=%v", got)
	}
	// The blocker session seeded normally through the same fan-out.
	if got := agg.Store().Snapshot(nil).LastAgents[sb]; got != "X" {
		t.Fatalf("blocker session must seed its own agent X, got %q", got)
	}

	// The fresh incarnation's own tail (B) must seed and memoize.
	h.armTail(sa, `[{"info":{"id":"wa1","sessionID":"s_wsa","role":"assistant","agent":"B"}}]`)
	agg.reseedCreatedSessionAgent(context.Background(), sa)
	if got := agg.Store().Snapshot(nil).LastAgents[sa]; got != "B" {
		t.Fatalf("recreated session must seed its OWN tail agent B, got %q", got)
	}
	if got, want := h.tailGETs(sa), 2; got != want {
		t.Fatalf("fresh incarnation must be fetched exactly once: GETs=%d want %d", got, want)
	}
}

// reseedTailHandler wraps the fixture backend and answers cold-seed TAIL GETs
// (GET /session/:id/message?limit=coldTailLimit) for sids armed in tails with a
// mutable per-sid body (armed-"" → `[]`, the no-assistant-turn tail). Full
// fetches and every other path delegate to the fixture. The tail GET is exactly
// the request reseedCreatedSessionAgent/seedColdLastAgents issue — distinct
// from the full-fetch shape the messages_resident_test.go counters key on.
//
// W5 hold extension: a sid armed via holdTail additionally blocks its first
// captured GET pre-body until released (see holdTail). Sids with no hold gate
// — including every W4-only usage, where holds/entered stay nil — behave
// exactly as before.
type reseedTailHandler struct {
	inner   http.Handler
	mu      sync.Mutex
	count   map[string]int           // sid -> tail-GET count
	tails   map[string]string        // sid -> armed tail body ("" → empty tail)
	holds   map[string]chan struct{} // sid -> hold gate; captured GETs block until closed
	entered map[string]chan struct{} // sid -> closed once on the first HELD capture
}

func (h *reseedTailHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/") && strings.HasSuffix(r.URL.Path, "/message") &&
		r.URL.Query().Get("limit") == strconv.Itoa(coldTailLimit) {
		sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/session/"), "/message")
		h.mu.Lock()
		body, armed := h.tails[sid]
		var hold, entered chan struct{}
		if armed {
			h.count[sid]++
			if gate, held := h.holds[sid]; held {
				hold = gate
				// Announce exactly once: delete-then-close under the lock.
				if ent, ok := h.entered[sid]; ok {
					delete(h.entered, sid)
					entered = ent
				}
			}
		}
		h.mu.Unlock()
		if armed {
			if entered != nil {
				close(entered)
			}
			if hold != nil {
				<-hold // deterministic rendezvous: body write deferred to the test
			}
			w.Header().Set("Content-Type", "application/json")
			if body == "" {
				body = "[]"
			}
			_, _ = w.Write([]byte(body))
			return
		}
	}
	h.inner.ServeHTTP(w, r)
}

func (h *reseedTailHandler) tailGETs(sid string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.count[sid]
}

func (h *reseedTailHandler) armTail(sid, body string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tails[sid] = body
}

// holdTail arms sid's tail body and installs a hold gate for the W5
// late-overwrite falsification cell: the first armed tail GET for sid is
// captured (counted under the mutex) and announced by closing the returned
// entered channel, and its response-body write then BLOCKS until the returned
// release func is called — modeling a slow upstream whose old data was
// captured before newer authoritative state landed. release is idempotent
// (safe to call from both the test body and the cleanup defer). After
// release, the closed gate lets any later GET for sid answer immediately.
func (h *reseedTailHandler) holdTail(sid, body string) (entered <-chan struct{}, release func()) {
	ent := make(chan struct{})
	gate := make(chan struct{})
	var once sync.Once
	h.mu.Lock()
	h.tails[sid] = body
	if h.holds == nil {
		h.holds = map[string]chan struct{}{}
	}
	if h.entered == nil {
		h.entered = map[string]chan struct{}{}
	}
	h.holds[sid] = gate
	h.entered[sid] = ent
	h.mu.Unlock()
	return ent, func() { once.Do(func() { close(gate) }) }
}
