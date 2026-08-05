package web

// Unit tests for message-id reconciliation (queue_msg_reconcile.go). These
// drive the store-level reconciler DETERMINISTICALLY with a fake resolver and
// an injected clock (no live HTTP, no wall-clock sleeps), covering every
// invariant-preserving case in the crux contract:
//
//   - exact id+session+role → sent (the crux)
//   - non-exact / wrong-session / assistant → NO resolve (fail-closed)
//   - 404 → stays non-sent
//   - 5xx → retryable
//   - 400 → immediate terminal
//   - persistent 404 → terminal, no resend loop (bounded)
//   - never a second prompt (the reconciler only GETs; a resolved item is not
//     re-looked-up)
//   - reload/re-list still finds the correlation id (persistence)
//
// The per-item throttle is driven by explicit `now` offsets against the
// default currentStaleThreshold (30s), so retry cadence is fully controlled.

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// fakeResolver is a deterministic stand-in for opencode.Client.Message. It is
// keyed by the composite (sessionID, messageID) so session isolation is
// modeled, records every call (for the "never a second prompt" invariant), and
// can return typed errors (ErrMessageNotFound / *opencode.Error) to model HTTP
// classes.
type fakeResolver struct {
	mu        sync.Mutex
	calls     []string // recorded "sid/mid" for every invocation
	bodies    map[string]string
	errFor    map[string]error
	callCount int
}

func newFakeResolver() *fakeResolver {
	return &fakeResolver{
		bodies: map[string]string{},
		errFor: map[string]error{},
	}
}

func (f *fakeResolver) setBody(sid, mid, role string) {
	f.bodies[sid+"/"+mid] = fmt.Sprintf(`{"info":{"id":%q,"role":%q}}`, mid, role)
}

func (f *fakeResolver) setErr(sid, mid string, err error) {
	f.errFor[sid+"/"+mid] = err
}

// clearErr removes an error override so a later setBody can take effect (models
// OpenCode recovering after a transient outage).
func (f *fakeResolver) clearErr(sid, mid string) {
	delete(f.errFor, sid+"/"+mid)
}

func (f *fakeResolver) lookup(_ context.Context, sid, mid string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.callCount++
	f.calls = append(f.calls, sid+"/"+mid)
	key := sid + "/" + mid
	if err, ok := f.errFor[key]; ok {
		return nil, err
	}
	if body, ok := f.bodies[key]; ok {
		return []byte(body), nil
	}
	// No configured answer → treat as a clean 404 (matches a server that never
	// persisted the message).
	return nil, opencode.ErrMessageNotFound
}

func (f *fakeResolver) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.callCount
}

// newStuckUnknownStore enqueues, claims, and recovers one item to terminal
// `unknown` (the delivered-but-stuck state reconciliation targets), returning
// the store + the stuck item (carrying its minted OpencodeMsgID). The returned
// item is the CLAIMED one, because the OpencodeMsgID is minted at Claim (not
// Enqueue); callers look the id up in the resolver, so they need the claimed
// copy, not the pending enqueue result (whose OpencodeMsgID is intentionally
// empty).
func newStuckUnknownStore(t *testing.T, sid, text string) (*sessionQueueStore, QueueItem) {
	t.Helper()
	s, _ := newTestStore(t, sid)
	mustEnqueue(t, s, text)
	claimed, _, err := s.Claim()
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if _, err := s.Resolve(claimed.ID, QueueUnknown, "stuck"); err != nil {
		t.Fatalf("Resolve(unknown): %v", err)
	}
	return s, claimed
}

func mustListItem(t *testing.T, s *sessionQueueStore, id string) QueueItem {
	t.Helper()
	items, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, it := range items {
		if it.ID == id {
			return it
		}
	}
	t.Fatalf("item %q not found in List", id)
	return QueueItem{}
}

// reconcileThreshold is the default currentStaleThreshold (30s); tests advance
// `now` by more than this between passes so the per-item throttle re-admits the
// same candidate.
const reconcileThreshold = 30 * time.Second

// TestReconcile_ExactMatchResolvesSent is THE CRUX: a delivered-but-stuck
// (unknown) item whose minted id maps to a persisted USER message under the
// exact same id resolves to `sent` automatically — without any second prompt.
func TestReconcile_ExactMatchResolvesSent(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	r.setBody("s1", it.OpencodeMsgID, "user")

	t0 := time.Unix(1000000, 0)
	s.reconcileMessageIDs("s1", r.lookup, t0)

	got := mustListItem(t, s, it.ID)
	if got.State != QueueSent {
		t.Fatalf("state: got %q want sent", got.State)
	}
	if got.Detail != reconcileSentDetail {
		t.Fatalf("detail: got %q want %q", got.Detail, reconcileSentDetail)
	}
	if got.ResolvedAt == 0 {
		t.Fatalf("ResolvedAt should be set on resolve")
	}
	if r.count() != 1 {
		t.Fatalf("resolver calls: got %d want 1 (exactly one GET)", r.count())
	}
}

// TestReconcile_NeverSecondPrompt verifies a resolved item is NOT re-looked-up
// on a later reconcile pass (the reconciler never re-dispatches; a `sent` item
// leaves the eligible set).
func TestReconcile_NeverSecondPrompt(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	r.setBody("s1", it.OpencodeMsgID, "user")

	t0 := time.Unix(1000000, 0)
	s.reconcileMessageIDs("s1", r.lookup, t0)
	before := r.count()
	// A later pass (past the throttle window) must NOT re-query: the item is
	// now `sent` and ineligible.
	s.reconcileMessageIDs("s1", r.lookup, t0.Add(reconcileThreshold+time.Second))
	if r.count() != before {
		t.Fatalf("resolver calls after resolve: got %d want %d (no second prompt)", r.count(), before)
	}
}

// TestReconcile_ReloadFindsCorrelationId verifies a fresh store at the same
// path reloads the stuck item with its OpencodeMsgID intact, so reconciliation
// is eligible after a restart (persistence of the correlation id).
func TestReconcile_ReloadFindsCorrelationId(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	r.setBody("s1", it.OpencodeMsgID, "user")

	// Simulate a restart: a brand-new store object at the same on-disk path.
	fresh := &sessionQueueStore{path: s.path}
	t0 := time.Unix(1000000, 0)
	fresh.reconcileMessageIDs("s1", r.lookup, t0)

	got := mustListItem(t, fresh, it.ID)
	if got.State != QueueSent {
		t.Fatalf("after reload+reconcile: state got %q want sent", got.State)
	}
	if got.OpencodeMsgID != it.OpencodeMsgID {
		t.Fatalf("OpencodeMsgID not reloaded: got %q want %q", got.OpencodeMsgID, it.OpencodeMsgID)
	}
}

// TestReconcile_SameIdWrongSessionNoResolve: the resolver says 404 for THIS
// session's (sid,mid) (the message persisted under a different session) → the
// reconciler honors the composite answer, does NOT resolve, fail-closes.
func TestReconcile_SameIdWrongSessionNoResolve(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	// The message exists under s2, not s1 — reconcile of s1 must see 404.
	r.setBody("s2", it.OpencodeMsgID, "user")

	s.reconcileMessageIDs("s1", r.lookup, time.Unix(1000000, 0))

	got := mustListItem(t, s, it.ID)
	if got.State != QueueUnknown {
		t.Fatalf("wrong-session must NOT resolve: got %q want unknown", got.State)
	}
	if got.ReconcileAttempts != 1 {
		t.Fatalf("ReconcileAttempts: got %d want 1", got.ReconcileAttempts)
	}
}

// TestReconcile_AssistantMessageNoResolve: a 200 whose role is NOT user → no
// resolve (exact-match authority requires role==="user").
func TestReconcile_AssistantMessageNoResolve(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	r.setBody("s1", it.OpencodeMsgID, "assistant")

	s.reconcileMessageIDs("s1", r.lookup, time.Unix(1000000, 0))

	got := mustListItem(t, s, it.ID)
	if got.State != QueueUnknown {
		t.Fatalf("assistant message must NOT resolve: got %q want unknown", got.State)
	}
}

// TestReconcile_NonExactIdNoResolve: a 200 with role=user but a DIFFERENT id
// (id !== minted) → no resolve. NEVER match on anything but exact id+role.
func TestReconcile_NonExactIdNoResolve(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	// A user message exists but under a different id.
	r.bodies["s1/"+it.OpencodeMsgID] = `{"info":{"id":"msg_SOMEOTHER","role":"user"}}`

	s.reconcileMessageIDs("s1", r.lookup, time.Unix(1000000, 0))

	got := mustListItem(t, s, it.ID)
	if got.State != QueueUnknown {
		t.Fatalf("non-exact id must NOT resolve: got %q want unknown", got.State)
	}
}

// TestReconcile_404StaysNonSent: a 404 leaves the item non-sent and counts one
// attempt (fail-closed).
func TestReconcile_404StaysNonSent(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	r.setErr("s1", it.OpencodeMsgID, opencode.ErrMessageNotFound)

	s.reconcileMessageIDs("s1", r.lookup, time.Unix(1000000, 0))

	got := mustListItem(t, s, it.ID)
	if got.State != QueueUnknown {
		t.Fatalf("404 must stay non-sent: got %q want unknown", got.State)
	}
	if got.ReconcileAttempts != 1 {
		t.Fatalf("ReconcileAttempts: got %d want 1", got.ReconcileAttempts)
	}
	if got.ReconcileTerminal {
		t.Fatalf("single 404 must NOT yet be terminal")
	}
}

// TestReconcile_5xxRetryable: a 5xx is retryable — counts one attempt, stays
// non-sent, NOT terminal.
func TestReconcile_5xxRetryable(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	r.setErr("s1", it.OpencodeMsgID, &opencode.Error{Status: 503, Op: "GET", Body: "unavailable"})

	s.reconcileMessageIDs("s1", r.lookup, time.Unix(1000000, 0))

	got := mustListItem(t, s, it.ID)
	if got.State != QueueUnknown {
		t.Fatalf("5xx must stay non-sent: got %q want unknown", got.State)
	}
	if got.ReconcileAttempts != 1 {
		t.Fatalf("ReconcileAttempts: got %d want 1", got.ReconcileAttempts)
	}
	if got.ReconcileTerminal {
		t.Fatalf("single 5xx must NOT yet be terminal (retryable)")
	}
}

// TestReconcile_Persistent404Terminal: a 404 that persists across the bounded
// budget becomes TERMINAL, and the reconciler STOPS (no resend loop) — exactly
// 3 lookups, no 4th.
func TestReconcile_Persistent404Terminal(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	r.setErr("s1", it.OpencodeMsgID, opencode.ErrMessageNotFound)

	t0 := time.Unix(1000000, 0)
	// Three passes, each past the per-item throttle window.
	for i := 0; i < 3; i++ {
		s.reconcileMessageIDs("s1", r.lookup, t0.Add(time.Duration(i)*(reconcileThreshold+time.Second)))
	}
	got := mustListItem(t, s, it.ID)
	if !got.ReconcileTerminal {
		t.Fatalf("persistent 404 across budget must be terminal")
	}
	if got.State != QueueUnknown {
		t.Fatalf("terminal 404 must stay non-sent (no resend): got %q want unknown", got.State)
	}
	if got.ReconcileAttempts != reconcileMaxAttempts {
		t.Fatalf("ReconcileAttempts: got %d want %d", got.ReconcileAttempts, reconcileMaxAttempts)
	}
	// A 4th pass (past the window) must NOT re-query: the item is terminal.
	s.reconcileMessageIDs("s1", r.lookup, t0.Add(4*(reconcileThreshold+time.Second)))
	if r.count() != 3 {
		t.Fatalf("resolver calls after terminal: got %d want 3 (no resend loop)", r.count())
	}
}

// TestReconcile_400ImmediateTerminal: a 400 (caller bug) marks the item terminal
// on the FIRST pass (retrying cannot help), without exhausting the budget.
func TestReconcile_400ImmediateTerminal(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	r.setErr("s1", it.OpencodeMsgID, &opencode.Error{Status: 400, Op: "GET", Body: "bad id"})

	s.reconcileMessageIDs("s1", r.lookup, time.Unix(1000000, 0))

	got := mustListItem(t, s, it.ID)
	if !got.ReconcileTerminal {
		t.Fatalf("400 must mark terminal immediately")
	}
	if got.State != QueueUnknown {
		t.Fatalf("400 terminal must stay non-sent: got %q want unknown", got.State)
	}
	// markReconcileTerminal does NOT bump the attempt counter.
	if got.ReconcileAttempts != 0 {
		t.Fatalf("ReconcileAttempts: got %d want 0 (immediate terminal, no budget use)", got.ReconcileAttempts)
	}
	// A second pass must NOT re-query.
	s.reconcileMessageIDs("s1", r.lookup, time.Unix(1000000, 0).Add(reconcileThreshold+time.Second))
	if r.count() != 1 {
		t.Fatalf("resolver calls after 400-terminal: got %d want 1", r.count())
	}
}

// TestReconcile_NoCandidateNoop verifies a store with NO eligible items makes
// zero resolver calls (the snapshot is the gate; no eligible item → no GET).
// This guards the production hot path: an all-clear queue List must not trigger
// any reconciliation work.
func TestReconcile_NoCandidateNoop(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	// Manually mark terminal so it is no longer a candidate.
	if err := markTerminalForTest(t, s, it.ID); err != nil {
		t.Fatalf("markTerminal: %v", err)
	}
	r := newFakeResolver()
	r.setBody("s1", it.OpencodeMsgID, "user")

	s.reconcileMessageIDs("s1", r.lookup, time.Unix(1000000, 0))
	if r.count() != 0 {
		t.Fatalf("no-candidate store must make zero resolver calls: got %d", r.count())
	}
}

// TestReconcile_NoCorrelationIdSkipped: an item with an empty OpencodeMsgID
// (legacy / pre-Slice-5) is never reconciled (fail-closed: no id → no exact
// lookup → no resolve).
func TestReconcile_NoCorrelationIdSkipped(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	// Strip the correlation id to model a legacy item.
	if err := stripCorrelationIDForTest(t, s, it.ID); err != nil {
		t.Fatalf("strip: %v", err)
	}
	r := newFakeResolver()
	r.setBody("s1", "whatever", "user")

	s.reconcileMessageIDs("s1", r.lookup, time.Unix(1000000, 0))
	if r.count() != 0 {
		t.Fatalf("legacy item (no correlation id) must be skipped: got %d calls", r.count())
	}
}

// TestReconcile_RetryThenSuccess verifies the retry path: a transient failure
// (5xx) is retried on a later pass, and a subsequent exact match resolves to
// sent (the bounded budget is not wasted on the first failure).
func TestReconcile_RetryThenSuccess(t *testing.T) {
	s, it := newStuckUnknownStore(t, "s1", "hello")
	r := newFakeResolver()
	// First lookup fails (5xx), then OpenCode recovers and has the message.
	r.setErr("s1", it.OpencodeMsgID, &opencode.Error{Status: 503, Op: "GET", Body: "down"})

	t0 := time.Unix(1000000, 0)
	s.reconcileMessageIDs("s1", r.lookup, t0)
	got := mustListItem(t, s, it.ID)
	if got.State != QueueUnknown || got.ReconcileTerminal {
		t.Fatalf("after 5xx: got state=%q terminal=%v want unknown/false", got.State, got.ReconcileTerminal)
	}

	// Now OpenCode recovers and has the message (clear the transient error so
	// the configured body takes effect).
	r.clearErr("s1", it.OpencodeMsgID)
	r.setBody("s1", it.OpencodeMsgID, "user")
	s.reconcileMessageIDs("s1", r.lookup, t0.Add(reconcileThreshold+time.Second))
	got = mustListItem(t, s, it.ID)
	if got.State != QueueSent {
		t.Fatalf("after retry+match: got %q want sent", got.State)
	}
}

// TestHasReconcileCandidate covers the cheap gate used by handleQueueList.
func TestHasReconcileCandidate(t *testing.T) {
	if hasReconcileCandidate(nil) {
		t.Fatal("nil items: want false")
	}
	if hasReconcileCandidate([]QueueItem{{State: QueueSent, OpencodeMsgID: "msg_x"}}) {
		t.Fatal("sent item: want false")
	}
	if hasReconcileCandidate([]QueueItem{{State: QueueUnknown, OpencodeMsgID: ""}}) {
		t.Fatal("unknown without correlation id: want false")
	}
	if hasReconcileCandidate([]QueueItem{{State: QueueUnknown, OpencodeMsgID: "msg_x", ReconcileTerminal: true}}) {
		t.Fatal("terminal unknown: want false")
	}
	if !hasReconcileCandidate([]QueueItem{{State: QueueUnknown, OpencodeMsgID: "msg_x"}}) {
		t.Fatal("unknown with correlation id, not terminal: want true")
	}
	// In-flight dispatching (the only dispatching List returns) is NOT a gate
	// trigger (it is genuinely in-flight).
	if hasReconcileCandidate([]QueueItem{{State: QueueDispatching, OpencodeMsgID: "msg_x"}}) {
		t.Fatal("in-flight dispatching: want false")
	}
}

// --- small test-only mutators (mirror Resolve's locking; test seam only) ---

func markTerminalForTest(t *testing.T, s *sessionQueueStore, id string) error {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return err
	}
	for i := range s.items {
		if s.items[i].ID == id {
			s.items[i].ReconcileTerminal = true
			return s.save()
		}
	}
	return errors.New("not found")
}

func stripCorrelationIDForTest(t *testing.T, s *sessionQueueStore, id string) error {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return err
	}
	for i := range s.items {
		if s.items[i].ID == id {
			s.items[i].OpencodeMsgID = ""
			return s.save()
		}
	}
	return errors.New("not found")
}
