package web

// Message-id reconciliation for the backend-authoritative per-session queue.
//
// PROBLEM: a queue item can be DELIVERED to OpenCode but stuck non-sent.
// prompt_async returns 204 with Effect.forkIn(scope,{startImmediately:true})
// — persistence is ASYNC to the 204. So a network drop / browser crash /
// vh-solara restart after the POST leaves the item in `dispatching` with no
// confirmed outcome. Stale-dispatch recovery (recoverStaleDispatchingLocked)
// then transitions it to terminal `unknown`. But the user message may in fact
// have been persisted under the queue's minted correlation id (caller-id-wins:
// vh-solara mints the id, OpenCode persists the user message with that EXACT
// id). The operator is left dismissing a chip for a prompt that actually went
// through — and worse, may re-send it, duplicating work.
//
// SOLUTION: an authoritative exact-match reconciler. It looks up the minted id
// via GET /session/:sid/message/:mid and, on 200 + info.role==="user" +
// info.id===minted, Resolve()s the item to `sent` automatically. This closes
// the delivered-but-stuck case without EVER re-dispatching.
//
// DESIGN DISCIPLINE (invariants — regression = hard fail):
//  1. No re-dispatch: the reconciler NEVER invokes prompt_async. It only READs
//     (GET) and Resolve()s (a terminal-state transition, never repend).
//  2. Exact-match authority ONLY: 200 + role==="user" + id===minted. NEVER
//     match on text, time, attachment, or latest-position. Any ambiguity fails
//     closed.
//  3. Persistence is async to the 204 — so reconciliation runs LATE, at the
//     stale-recovery cadence (currentStaleThreshold, ≥30s prod / test override),
//     reused from the FE's natural list/sync opportunities. There is NO
//     enqueue-adjacent lookup and NO aggressive poller.
//  4. A persistent 404 past the grace window is TERMINAL for that id: the turn
//     may have forked-but-died (never persisted) — resending risks duplicate
//     work. Record + stop. NEVER auto-send on a 404.
//  5. Bounded: per-item throttle (≤1 lookup/threshold window) + a per-item
//     attempt budget (reconcileMaxAttempts) that, once exhausted, marks the
//     item ReconcileTerminal (fail-closed, skipped forever). A 400 (caller bug)
//     marks it terminal immediately.
//
// The reconciler is idempotent (Resolve is idempotent on terminal states;
// re-snapshots re-check eligibility) and safe to run concurrently with the FE's
// own Resolve calls (exact-match authority overrides a manual non-sent mark).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

const (
	// reconcileMaxAttempts bounds how many FAILED reconciliation passes (404,
	// 5xx, transport, non-exact 200) an item tolerates before being marked
	// ReconcileTerminal (fail-closed, NEVER resend). With the per-item throttle
	// at currentStaleThreshold (~30s prod), this caps a stuck item's
	// reconciliation lifetime at ~reconcileMaxAttempts × threshold past the
	// initial grace window.
	reconcileMaxAttempts = 3

	// reconcileLookupTimeout bounds a single OpenCode message GET. Generous
	// because the lookup goes through the local opencode server, which may be
	// briefly busy; a stuck lookup must not pin a reconcile goroutine forever.
	reconcileLookupTimeout = 10 * time.Second
)

// Detail text for reconcile outcomes. The operator reads these on the chip.
const (
	reconcileSentDetail = "Reconciled: OpenCode persisted the user message under the queue correlation id; resolved to sent."

	// The %d is the final attempt count (fmt.Sprintf).
	reconcileTerminal404DetailFmt       = "Reconcile terminal: OpenCode has no record of this message after %d attempt(s) (persistent 404). The turn may have failed before persisting; manual review advised."
	reconcileTerminalTransientDetailFmt = "Reconcile terminal: OpenCode was unreachable or returned a non-matching record after %d attempt(s); cannot confirm the message was sent. Manual review advised."
	reconcileTerminalMismatchDetailFmt  = "Reconcile terminal: the correlation id did not map to this session's user message after %d attempt(s). Manual review advised."

	reconcileTerminal400Detail = "Reconcile terminal: OpenCode rejected the message id (HTTP 400) — caller bug; not retrying."
)

// opencodeMessageResolver looks up a single OpenCode message by exact id. It is
// the GET /session/:sid/message/:mid primitive, abstracted so the store can be
// unit-tested with a deterministic fake resolver (no live HTTP). The real
// resolver (Server.reconcileSessionQueue) binds it to opencode.Client.Message.
type opencodeMessageResolver func(ctx context.Context, sessionID, messageID string) ([]byte, error)

// reconcileCandidate is a snapshot of one item eligible for reconciliation. It
// carries only the immutable identity (item ID + the OpenCode correlation id to
// look up), so the network GET runs WITHOUT holding the store mutex.
type reconcileCandidate struct {
	ID  string
	Mid string
}

// reconcileMessageInfo is the slice of the OpenCode message body the
// reconciler matches on. Only info.id + info.role are inspected — exact-match
// authority only.
type reconcileMessageInfo struct {
	Info struct {
		ID   string `json:"id"`
		Role string `json:"role"`
	} `json:"info"`
}

// hasReconcileCandidate reports whether a freshly-Listed item slice contains
// at least one item the reconciler should look at: `unknown` (the
// post-recovery stuck state) with a correlation id (OpencodeMsgID != "") and
// not already terminal (ReconcileTerminal==false). This is the cheap gate
// handleQueueList uses to decide whether to spawn the reconcile goroutine at
// all — when no item is eligible (the common, all-clear case) there is no
// aggregator lookup, no goroutine, no side effect, so existing List traffic is
// unaffected.
//
// NOTE: List() already ran recoverStaleDispatchingLocked, so it never returns
// stale `dispatching` (those became `unknown`). A `dispatching` item returned
// by List is therefore genuinely in-flight and NOT reconcile-eligible here —
// the snapshot path re-checks stale-dispatching defensively for any item that
// aged into staleness between List and snapshot, but this gate keys only on
// `unknown`.
func hasReconcileCandidate(items []QueueItem) bool {
	for i := range items {
		if items[i].State == QueueUnknown && items[i].OpencodeMsgID != "" && !items[i].ReconcileTerminal {
			return true
		}
	}
	return false
}

// reconcileSessionQueue is the Server-level reconcile entry point, spawned (as
// a goroutine) from handleQueueList when hasReconcileCandidate(items) is true.
// It binds the store-level reconcileMessageIDs to this dir's opencode client
// and guards against overlapping passes for the same session via
// queueReconcileInFlight. It MUST NEVER invoke prompt_async (it only GETs and
// Resolve()s). All errors are logged and fail-closed; it never panics or blocks
// the caller (it runs in its own goroutine).
//
// DESIGN: uses aggForExisting(dir) — NOT aggFor(dir) — so the queue-List path
// stays side-effect-free. A queue List is a READ and must not open a project,
// launch managed processes, or trigger orphan-queue GC (the same principle
// code_security_test.go pins for header-stamp reads). In production the
// aggregator ALWAYS exists before the queue is listed: the FE opens the project
// (snapshot/stream → aggFor) before showing the queue, so aggForExisting
// returns it. If no aggregator exists yet (the queue List is somehow the first
// request for the dir), the reconcile is SKIPPED this cycle — the item stays
// `unknown` (fail-closed) and the FE's next poll, after the project is opened,
// reconciles it. This is safe: `unknown` is terminal, never resent.
func (s *Server) reconcileSessionQueue(dir, sid, root string) {
	// In-flight guard: one concurrent reconcile per (root, sid). sync.Map has
	// no "compare-and-swap on a missing key" — CompareAndSwap requires the key
	// to already be present — so the one-in-flight idiom here is LoadOrStore
	// (stores a sentinel if absent, reports whether one was already there) +
	// Delete on completion. A FE poll storm (or a test poll loop) thus cannot
	// fan out overlapping reconcile passes for the same session.
	key := storeKey(root, sid)
	if _, loaded := s.queueReconcileInFlight.LoadOrStore(key, struct{}{}); loaded {
		return
	}
	defer s.queueReconcileInFlight.Delete(key)

	// Side-effect-free lookup: use the EXISTING aggregator only. Returns nil
	// (no reconcile) if the project has not been opened for this dir yet — the
	// FE's next poll after opening reconciles. NEVER opens a project from the
	// queue-List path.
	a := s.aggForExisting(dir)
	if a == nil {
		return
	}
	client := a.Client()
	resolve := func(ctx context.Context, sessionID, messageID string) ([]byte, error) {
		return client.Message(ctx, sessionID, messageID)
	}
	s.queues.store(root, sid).reconcileMessageIDs(sid, resolve, time.Now())
}

// reconcileMessageIDs runs one bounded reconciliation pass for this session:
// snapshot the currently-eligible items, then look each up. The `now` parameter
// is injected so unit tests can drive the per-item throttle clock without
// wall-clock sleeps. Safe to call when there are no eligible candidates (no-op).
func (s *sessionQueueStore) reconcileMessageIDs(sid string, resolve opencodeMessageResolver, now time.Time) {
	candidates := s.snapshotReconcileCandidates(now)
	for _, c := range candidates {
		s.reconcileOne(c, sid, resolve)
	}
}

// snapshotReconcileCandidates returns the items eligible for a reconciliation
// lookup RIGHT NOW, and paces them via the in-memory reconcileLast throttle.
// Runs under s.mu so the snapshot + throttle update are atomic with respect to
// other List/mutation paths. Each returned candidate has had its reconcileLast
// timestamp advanced to `now`, so a second pass within the same threshold
// window will NOT re-snapshot it (the per-item throttle).
//
// Eligibility = correlation-bearing (OpencodeMsgID != "") AND not already
// terminal (ReconcileTerminal==false) AND in a state worth reconciling:
// `unknown` (the post-recovery stuck state) OR stale `dispatching` (defensive:
// List() already recovers stale dispatching → unknown, so a `dispatching` item
// here is either genuinely in-flight or legacy). `sent`/`failed`/`pending` are
// never reconciled. Items that have left the eligible set also get their
// throttle entry pruned (bounds map growth to active candidates).
func (s *sessionQueueStore) snapshotReconcileCandidates(now time.Time) []reconcileCandidate {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return nil
	}
	if err := s.load(); err != nil {
		return nil
	}
	if s.reconcileLast == nil {
		s.reconcileLast = map[string]int64{}
	}
	nowMs := now.UnixMilli()
	thresholdMs := int64(currentStaleThreshold() / time.Millisecond)
	var out []reconcileCandidate
	for i := range s.items {
		it := &s.items[i]
		if it.OpencodeMsgID == "" || it.ReconcileTerminal {
			// Not correlation-bearing or already terminal — prune a stale
			// throttle entry if one lingers from before it left the set.
			delete(s.reconcileLast, it.ID)
			continue
		}
		eligibleState := it.State == QueueUnknown
		if !eligibleState && it.State == QueueDispatching {
			// Stale-dispatching (startedAt==0 legacy OR past threshold).
			if it.DispatchStartedAt == 0 || nowMs-it.DispatchStartedAt > thresholdMs {
				eligibleState = true
			}
		}
		if !eligibleState {
			delete(s.reconcileLast, it.ID)
			continue
		}
		// Per-item throttle: ≤1 lookup per threshold window.
		if last, ok := s.reconcileLast[it.ID]; ok && nowMs-last < thresholdMs {
			continue
		}
		s.reconcileLast[it.ID] = nowMs
		out = append(out, reconcileCandidate{ID: it.ID, Mid: it.OpencodeMsgID})
	}
	return out
}

// reconcileOne looks up ONE candidate and applies the fail-closed /
// exact-match outcome. The GET runs WITHOUT the store mutex; the mutation
// helpers (Resolve / bumpReconcileAttempt / markReconcileTerminal) each
// re-acquire s.mu and RE-CHECK eligibility before mutating, so a store change
// between snapshot and mutation is handled safely.
func (s *sessionQueueStore) reconcileOne(c reconcileCandidate, sid string, resolve opencodeMessageResolver) {
	ctx, cancel := context.WithTimeout(context.Background(), reconcileLookupTimeout)
	defer cancel()
	body, err := resolve(ctx, sid, c.Mid)
	if err != nil {
		switch {
		case errors.Is(err, opencode.ErrMessageNotFound):
			// 404: definitive "not persisted" for this exact id. Fail-closed:
			// count the attempt; a persistent 404 across the budget becomes
			// TERMINAL (NEVER resend).
			s.bumpReconcileAttempt(c.ID, reconcileTerminal404DetailFmt)
		case isOpencodeStatus(err, http.StatusBadRequest):
			// 400: caller bug (malformed/non-msg id). Stop immediately —
			// retrying can't help; mark terminal so the reconciler never
			// re-looks-up this id.
			vhlog.Warn("queue reconcile: OpenCode rejected message id (400) — caller bug; marking terminal", "sessionID", sid, "messageID", c.Mid, "err", err)
			s.markReconcileTerminal(c.ID, reconcileTerminal400Detail)
		default:
			// 5xx / transport / malformed 200 body: retryable within the
			// budget; exhaustion → terminal.
			s.bumpReconcileAttempt(c.ID, reconcileTerminalTransientDetailFmt)
		}
		return
	}
	// 200: exact-match authority (info.id === minted AND info.role === "user").
	var info reconcileMessageInfo
	if err := json.Unmarshal(body, &info); err != nil {
		vhlog.Warn("queue reconcile: malformed message body; treating as transient", "sessionID", sid, "messageID", c.Mid, "err", err)
		s.bumpReconcileAttempt(c.ID, reconcileTerminalTransientDetailFmt)
		return
	}
	if info.Info.Role == "user" && info.Info.ID == c.Mid {
		// Authoritative sent: the item became a real persisted user message
		// under the minted id. Resolve to `sent` (the ONLY auto-clear state).
		// Resolve persists + compacts and is idempotent on terminal states, so
		// a concurrent FE resolve composes safely (exact-match authority
		// overrides a manual non-sent mark).
		if _, rerr := s.Resolve(c.ID, QueueSent, reconcileSentDetail); rerr != nil {
			vhlog.Warn("queue reconcile: Resolve(sent) failed", "sessionID", sid, "messageID", c.Mid, "err", rerr)
		}
		return
	}
	// 200 but non-exact (wrong id / not a user message): the minted id did NOT
	// map to the expected user message — fail-closed. NEVER match on
	// text/time/latest-position.
	s.bumpReconcileAttempt(c.ID, reconcileTerminalMismatchDetailFmt)
}

// isOpencodeStatus reports whether err is an *opencode.Error with the given HTTP
// status (e.g. 400 / 5xx). Used to distinguish caller-bug (400) from
// retryable (5xx) without importing opencode's Error type at every call site.
func isOpencodeStatus(err error, status int) bool {
	var opErr *opencode.Error
	return errors.As(err, &opErr) && opErr.Status == status
}

// reconcileEligible reports whether an item is currently reconcilable. Re-checked
// under s.mu inside the mutation helpers so a store change between the snapshot
// and the mutation is honored. The `now` parameter drives the stale-dispatching
// re-check (the `unknown` path is time-independent).
func reconcileEligible(it QueueItem, now time.Time) bool {
	if it.OpencodeMsgID == "" || it.ReconcileTerminal {
		return false
	}
	if it.State == QueueUnknown {
		return true
	}
	if it.State == QueueDispatching {
		nowMs := now.UnixMilli()
		thresholdMs := int64(currentStaleThreshold() / time.Millisecond)
		return it.DispatchStartedAt == 0 || nowMs-it.DispatchStartedAt > thresholdMs
	}
	return false
}

// bumpReconcileAttempt records one failed reconciliation pass on an item and,
// if the budget (reconcileMaxAttempts) is exhausted, marks it ReconcileTerminal
// with detailFmt (a fmt.Sprintf format taking the final attempt count).
// detailFmt is only applied at terminalization; non-terminal bumps persist just
// the incremented counter. Re-checks eligibility under s.mu and no-ops if the
// item is no longer eligible (resolved/removed/terminal/changed-state). Rolls
// back the in-memory mutation on a save failure.
func (s *sessionQueueStore) bumpReconcileAttempt(id string, detailFmt string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return
	}
	if err := s.load(); err != nil {
		return
	}
	for i := range s.items {
		if s.items[i].ID != id {
			continue
		}
		if !reconcileEligible(s.items[i], time.Now()) {
			return
		}
		pre := s.items[i] // rollback snapshot (scalar fields only)
		s.items[i].ReconcileAttempts++
		terminal := s.items[i].ReconcileAttempts >= reconcileMaxAttempts
		if terminal {
			s.items[i].ReconcileTerminal = true
			s.items[i].Detail = fmt.Sprintf(detailFmt, s.items[i].ReconcileAttempts)
		}
		if err := s.save(); err != nil {
			s.items[i] = pre
		}
		return
	}
}

// markReconcileTerminal immediately marks an item ReconcileTerminal with the
// given (literal) detail, bypassing the attempt budget. Used for the definitive
// caller-bug case (HTTP 400) where retrying cannot help. Re-checks eligibility
// under s.mu and no-ops if the item is no longer eligible. Rolls back on save
// failure.
func (s *sessionQueueStore) markReconcileTerminal(id, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return
	}
	if err := s.load(); err != nil {
		return
	}
	for i := range s.items {
		if s.items[i].ID != id {
			continue
		}
		if !reconcileEligible(s.items[i], time.Now()) {
			return
		}
		pre := s.items[i]
		s.items[i].ReconcileTerminal = true
		s.items[i].Detail = detail
		if err := s.save(); err != nil {
			s.items[i] = pre
		}
		return
	}
}
