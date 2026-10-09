package web

// The daemon-owned queue drain loop — send-net-resilience slice 2b phase 2.
//
// One loop per OPENED PROJECT (started from aggFor, mirroring the
// queue-GC/pins/labels per-dir lifecycles) when daemon dispatch is enabled
// (SetDaemonDispatchEnabled — the --daemon-dispatch opt-in; production
// default OFF). The loop is the design's "single daemon worker" (Dispatch
// Ownership): it acquires the project's queue custody (the flock fence),
// invalidates the stores' lazy-load caches at the epoch boundary (T1C-F3),
// and then repeatedly:
//
//	1. CLASSIFY-AND-ACT (certifiedRecoveryPass) over every session with
//	   custody-journaled items: the exact-ID GET + the certified ladder —
//	   heal-to-sent on exact 200; requeue never-started / connect_failed /
//	   post-restart-barrier items for SAME-msgid redelivery; resolve
//	   server_error to failed; drive the ambiguous budget for live-uncertain
//	   items (NEVER auto-POST).
//	2. RESUME requeued items (ResumeQueuedDispatchAttempt: consume the
//	   RequeuePending marker → begin → fence → POST → receipt, correlation
//	   id reused verbatim), oldest Order first.
//	3. CLAIM+DISPATCH the oldest pending item (RunQueuedDispatchAttempt),
//	   one item in flight per project at a time (the single-writer reading
//	   of the design's custody protocol), applying the AGENT EVIDENCE GATE
//	   before any POST.
//
// RECEIPT POLICY (inline, after each attempt): server_error → terminal
// failed (class 5, "no loop"); every other receipt (accepted_2xx /
// written_unknown / connect_failed) takes NO inline action — the item stays
// dispatching until the stale threshold elapses and the CLASSIFICATION pass
// (the single recovery path, paced by the per-item reconcile throttle)
// applies the certified ladder. That is deliberate: an inline connect_failed
// requeue would let one tick requeue→resume→fail→requeue in a tight spin
// (the retry storm); the cadence-bounded path redelivers at the recovery
// cadence (currentStaleThreshold: 30s production, test-overridable), which
// is exactly the design's bounded-escalation posture.
//
// The AGENT EVIDENCE GATE (matured phase-1 defer D2/tier1_a-F2) fires at
// claim time: an item whose captured SendConfig.Agent is empty is NEVER
// dispatched — the daemon refuses rather than silently falling back to
// OpenCode's config default (mirroring the FE composer's evidence gate) —
// and is resolved terminal `failed` with an explicit detail.
//
// ACQUISITION BACKOFF (matured defer tier1_d-F1): the D-F2 arbitration
// probe (custodyLockHeld) briefly takes LOCK_EX itself, so an acquire racing
// a probe can see a SPURIOUS errQueueCustodyHeld. The loop retries fast a
// bounded number of times (probe races resolve in microseconds), then falls
// back to a slow reacquire cadence — which also covers the REAL second
// owner: fail-closed while it lives (no split-brain), stale-lock reacquire
// after it dies (the kernel releases the flock).
//
// EXIT CONDITIONS: the server's bgCtx cancel (Shutdown), the loop's OWN
// per-loop cancel (stopQueueDrainLoop — the reload-project teardown path —
// and stopAllQueueDrainLoops at Shutdown), the capability being switched off
// at runtime (tests flip it off; production never does), a Reload-project
// teardown of this dir's aggregator, or a compare-and-fence rejection (a
// newer custody owner exists — this loop must never dispatch again under the
// stale epoch; the operator or a later acquisition decides what happens
// next).

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

const (
	// drainLoopTick is the loop's base cadence. Cheap on idle (a registry
	// walk + in-memory eligibility scan); work items run one per tick (the
	// single-writer posture), so a backlog drains at tick cadence. The
	// per-item REDelivery cadence is governed separately by the stale
	// threshold (see the receipt-policy note above). Overridable for tests
	// (SetQueueDrainTickForTest).
	drainLoopTick = 250 * time.Millisecond

	// drainAcquireFastRetries / drainAcquireFastDelay bound the FAST retry
	// burst for spurious errQueueCustodyHeld (tier1_d-F1: a racing
	// arbitration probe holds LOCK_EX for the duration of an open+flock+
	// close — microseconds). Past the burst, the loop assumes a REAL owner.
	drainAcquireFastRetries = 5
	drainAcquireFastDelay   = 100 * time.Millisecond

	// drainAcquireSlowRetry is the slow reacquire cadence while a real
	// second owner holds the project (fail-closed coexistence), and the
	// crash-recovery path after it dies (the flock frees on process death).
	drainAcquireSlowRetry = 30 * time.Second

	// drainFsScanInterval paces the post-restart discovery scan of
	// .vh-solara/sessions/*/queue.json (a daemon restart loses the in-memory
	// registry; the durable queue files are the recovery source).
	drainFsScanInterval = 30 * time.Second
)

// drainTickOverride is the TEST-ONLY tick override (0 = use the const).
// Atomic for the same race reasons as every other tunable in this package.
var drainTickOverride atomic.Int64 // nanoseconds; 0 = const default

// queueDrainPostPublishSeam — see the invocation site in
// maybeStartQueueDrainLoop for the contract. TEST-ONLY interleave seam
// (mirrors queueDrainPrePostSeam): nil in production.
var queueDrainPostPublishSeam func()

// SetQueueDrainTickForTest overrides the drain loop's base tick for the
// duration of a test. TEST-ONLY: production code MUST NOT call this. Pass
// d <= 0 to restore. Callers SHOULD defer-restore.
func SetQueueDrainTickForTest(d time.Duration) {
	if d <= 0 {
		drainTickOverride.Store(0)
		return
	}
	drainTickOverride.Store(int64(d))
}

func currentDrainTick() time.Duration {
	if ns := drainTickOverride.Load(); ns > 0 {
		return time.Duration(ns)
	}
	return drainLoopTick
}

// queueDrainLoop is ONE project's dispatcher. Owned by the Server
// (s.drainLoops, keyed by dir); runs on a bgCtx-scoped child context so
// Shutdown reaches it, with a RETAINED per-loop cancel so teardown callers
// that do NOT own bgCtx (the reload-project path) can still stop it.
type queueDrainLoop struct {
	srv    *Server
	dir    string
	root   string
	tok    *QueueCustody
	cancel context.CancelFunc // per-loop cancellation (nil for ad-hoc test loops)
	done   chan struct{}      // closed when the loop goroutine has fully exited
}

// maybeStartQueueDrainLoop starts this dir's drain loop iff daemon dispatch
// is enabled and no loop is already registered. Called from aggFor (the
// project-open boundary) — the same hook family as the queue-GC / pins /
// labels lifecycles. Enabling the capability later than the project open
// does NOT retroactively start loops (the operator reload/restart boundary
// owns that); tests enable the flag BEFORE opening the project.
func (s *Server) maybeStartQueueDrainLoop(dir string) {
	if !DaemonDispatchEnabled() {
		return
	}
	s.drainLoopsMu.Lock()
	if _, running := s.drainLoops[dir]; running {
		s.drainLoopsMu.Unlock()
		return
	}
	root, err := projectRoot(dir)
	if err != nil {
		s.drainLoopsMu.Unlock()
		vhlog.Warn("queue drain: projectRoot failed; loop not started", "dir", dir, "err", err)
		return
	}
	// The derived context + its cancel are created — and the cancel
	// RETAINED on the loop struct — BEFORE the registry publication (the
	// slice-5 armed defer's fix, hardened from "retained" to
	// "retained-before-published"): the loop ctx derives from bgCtx, which
	// reload-project does NOT cancel, so stopQueueDrainLoop depends on the
	// per-loop cancel. Publishing the entry first would leave a window in
	// which a concurrent stop reads l.cancel == nil (a data race AND a
	// missed cancel), skips the cancel, and parks on <-l.done forever —
	// only bgCtx (never fired by reload) could ever close it. Assigning
	// under the publication mutex gives every registry reader a
	// happens-before edge onto the non-nil cancel.
	ctx, cancel := context.WithCancel(s.bgCtx)
	l := &queueDrainLoop{srv: s, dir: dir, root: root, cancel: cancel, done: make(chan struct{})}
	s.drainLoops[dir] = l
	s.drainLoopsMu.Unlock()

	// queueDrainPostPublishSeam is a TEST-ONLY interleave seam placed in
	// the publication window: after the loop entry is visible in the
	// registry (mutex released) and before the loop goroutine is launched.
	// It exists to prove the publication-window contract deterministically
	// (the slice-5 armed defer): a stopQueueDrainLoop issued at this point
	// must observe the loop's RETAINED per-loop cancel — which therefore
	// must be assigned BEFORE the registry publication, not after. nil in
	// production; tests MUST restore nil.
	if queueDrainPostPublishSeam != nil {
		queueDrainPostPublishSeam()
	}

	// Non-default dirs track on lifecycleWG so Reload/Shutdown can await a
	// full exit (stopQueueDrainLoop waits on done); the default dir's loop
	// is daemon-owned (process lifetime), mirroring the queue-GC
	// subscriber's tracking discipline.
	if dir != "" {
		s.lifecycleWG.Add(1)
	}
	go func() {
		l.run(ctx)
		cancel()
	}()
}

// stopQueueDrainLoop signals the dir's loop to stop (if any) and waits for
// its goroutine to finish and release custody: the retained per-loop cancel
// fires FIRST (reload-project must not depend on the server-wide bgCtx),
// then the wait. MUST be called WITHOUT aggMu held (the loop's tick takes
// aggMu via aggForExisting, so waiting under aggMu would deadlock). Safe to
// call repeatedly / for unknown dirs.
func (s *Server) stopQueueDrainLoop(dir string) {
	s.drainLoopsMu.Lock()
	l, ok := s.drainLoops[dir]
	if ok {
		delete(s.drainLoops, dir)
	}
	s.drainLoopsMu.Unlock()
	if !ok {
		return
	}
	if l.cancel != nil {
		l.cancel()
	}
	<-l.done
}

// run is the loop body: ACQUIRE (fast burst → slow poll; epoch-boundary
// cache invalidation) → dispatch ticks → release, until an exit condition.
func (l *queueDrainLoop) run(ctx context.Context) {
	if l.dir != "" {
		defer l.srv.lifecycleWG.Done()
	}
	defer close(l.done)
	for {
		if ctx.Err() != nil || !queueCustodyAllowed() {
			return // Shutdown / capability switched off (tests)
		}
		if !l.acquire(ctx) {
			return
		}
		exit := l.dispatchLoop(ctx)
		l.tok.Release()
		if exit {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(drainAcquireSlowRetry):
		}
	}
}

// acquire obtains the custody token: a fast retry burst over spurious
// probe-race helds, then the slow reacquire cadence. Returns false when the
// loop should exit (ctx canceled / capability off / fail-closed refusal).
// On success it also performs the EPOCH-BOUNDARY cache invalidation
// (T1C-F3): every registered store under the root drops its lazy-load cache
// so the first custody mutation of this epoch re-reads queue.json from
// disk — a write that landed between the old cache's load and this
// acquisition (e.g. a legacy browser claim racing the arbitration probe) is
// OBSERVED instead of silently overwritten.
func (l *queueDrainLoop) acquire(ctx context.Context) bool {
	var fast int
	for {
		if ctx.Err() != nil || !queueCustodyAllowed() {
			return false
		}
		tok, err := AcquireQueueCustody(l.root)
		if err == nil {
			l.tok = tok
			l.srv.queues.invalidateStoresUnderRoot(l.root)
			vhlog.Info("queue drain: custody acquired", "dir", l.dir, "root", l.root, "generation", tok.Generation())
			return true
		}
		if !errors.Is(err, errQueueCustodyHeld) {
			// Unsupported platform / corrupt generation authority /
			// capability off: fail-closed operator territory, NOT a retry
			// loop. Log once and exit.
			vhlog.Warn("queue drain: custody acquisition refused; loop exiting", "dir", l.dir, "err", err)
			return false
		}
		// errQueueCustodyHeld: usually the microseconds-long arbitration
		// probe, possibly a real second daemon. Fast-burst first, then slow.
		var wait time.Duration
		if fast < drainAcquireFastRetries {
			wait = drainAcquireFastDelay
			fast++
		} else {
			wait = drainAcquireSlowRetry
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(wait):
		}
	}
}

// dispatchLoop runs ticks under a HELD token until an exit condition:
// ctx cancel, capability off, or a FENCE rejection (a newer owner exists —
// this loop must never dispatch again under the stale epoch). Returns true
// for "exit the whole loop", false for "release and re-acquire" (the
// defensive fall-through; every named condition returns true).
func (l *queueDrainLoop) dispatchLoop(ctx context.Context) (exit bool) {
	var lastFsScan time.Time
	for {
		if ctx.Err() != nil || !queueCustodyAllowed() {
			return true
		}
		if err := l.tick(ctx, &lastFsScan); err != nil {
			if errors.Is(err, errQueueFenced) {
				vhlog.Warn("queue drain: fenced — a newer custody owner exists; loop exiting", "dir", l.dir, "err", err)
				return true
			}
			// Non-fence tick errors are per-item noise (logged where they
			// happen); pace and retry.
		}
		select {
		case <-ctx.Done():
			return true
		case <-time.After(currentDrainTick()):
		}
	}
}

// tick is ONE dispatch pass: discover sessions → classify → one work item
// (resume a requeue, else claim+dispatch a pending item) per session, one
// in flight per project (the single-writer posture; a backlog drains at
// tick cadence, which also bounds retry pressure).
func (l *queueDrainLoop) tick(ctx context.Context, lastFsScan *time.Time) error {
	s := l.srv
	a := s.aggForExisting(l.dir)
	if a == nil {
		return nil // project torn down mid-loop; the reload/stop wiring exits us
	}
	ocGen := s.ocGeneration()
	poster := func(ctx context.Context, sessionID string, body json.RawMessage) error {
		// opencode.Client.Prompt returns the (unused) response body; the
		// executor's promptPoster contract is error-only (prompt_async's
		// 204 has no body worth reading — a 2xx is never durability).
		_, err := a.Client().Prompt(ctx, sessionID, body)
		return err
	}
	for _, sid := range l.discoverSessions(lastFsScan) {
		if ctx.Err() != nil {
			return nil
		}
		// 1. Certified recovery classification (a fence error propagates to
		// dispatchLoop's exit condition).
		resolve := func(ctx context.Context, sessionID, messageID string) ([]byte, error) {
			return a.Client().Message(ctx, sessionID, messageID)
		}
		if err := s.certifiedRecoveryPass(l.root, sid, l.tok, resolve); err != nil {
			return err
		}
		// 2+3. One work item this tick: a pending requeue first, else a
		// pending claim. (FIFO across both sets is preserved by Order via
		// oldestDispatchable.)
		st := s.queues.store(l.root, sid)
		itemID, mode, ok := l.oldestDispatchable(st)
		if !ok {
			continue
		}
		if mode == dispatchModeResume {
			outcome, err := ResumeQueuedDispatchAttempt(ctx, st, sid, l.tok, itemID, ocGen, poster)
			if err != nil && errors.Is(err, errQueueFenced) {
				return err
			}
			l.resolveServerErrorInline(st, sid, outcome)
			continue
		}
		// dispatchModePending: claim + agent evidence gate + dispatch.
		claimed, won, cerr := st.ClaimForCustody(l.tok)
		if cerr != nil {
			if errors.Is(cerr, errQueueFenced) {
				return cerr
			}
			continue // transient; next tick retries
		}
		if !won {
			continue
		}
		if claimed.SendConfig.Agent == "" {
			// D2/tier1_a-F2: refuse to dispatch a capture with no agent —
			// never silently fall back to OpenCode's config default.
			_, _ = st.Resolve(claimed.ID, QueueFailed, agentGateRefusalDetail)
			vhlog.Warn("queue drain: refused dispatch — no agent captured (evidence gate)", "sessionID", sid, "item", claimed.ID)
			continue
		}
		outcome, err := resumeDispatchAttempt(ctx, st, sid, l.tok, claimed, ocGen, poster)
		if err != nil && errors.Is(err, errQueueFenced) {
			return err
		}
		l.resolveServerErrorInline(st, sid, outcome)
	}
	return nil
}

// resolveServerErrorInline applies class 5 the moment the receipt lands:
// an explicit non-2xx verdict resolves the item to terminal failed (no
// loop) while it is still `dispatching` — the resolve matrix's clean
// window. Every other receipt takes NO inline action (see the file doc:
// the cadence-bounded classification pass owns redelivery and ambiguity).
func (l *queueDrainLoop) resolveServerErrorInline(st *sessionQueueStore, sid string, outcome DispatchOutcome) {
	if outcome.Class != QueueAttemptServerError {
		return
	}
	detail := "Dispatch failed: OpenCode rejected the prompt. [design.md class 5]"
	if it, ok := st.certifyItemSnapshot(outcome.ItemID); ok {
		if n := len(it.Attempts); n > 0 && it.Attempts[n-1].Detail != "" {
			detail = "Dispatch failed: OpenCode rejected the prompt (" + it.Attempts[n-1].Detail + "). [design.md class 5]"
		}
	}
	if _, err := st.Resolve(outcome.ItemID, QueueFailed, detail); err != nil {
		vhlog.Warn("queue drain: server_error resolve failed", "sessionID", sid, "item", outcome.ItemID, "err", err)
	}
}

// agentGateRefusalDetail is the terminal detail for the agent-evidence-gate
// refusal (D2/tier1_a-F2): the FE's evidence gate guarantees a non-empty
// agent at enqueue; an empty capture here is a legacy/bugged admission that
// must NOT silently dispatch under OpenCode's config default.
const agentGateRefusalDetail = "Dispatch refused: the captured send config carries no agent. The queue's evidence gate requires an explicit agent per message (the FE composer guarantees one at send); dispatching without it would silently fall back to OpenCode's config default. Re-send the message with an agent selected."

// dispatchMode selects which executor entry the loop uses for an item.
type dispatchMode int

const (
	// dispatchModePending: item is pending — claim (mint) + dispatch.
	dispatchModePending dispatchMode = iota
	// dispatchModeResume: item is dispatching with a live RequeuePending
	// marker — resume (same correlation id, no claim).
	dispatchModeResume
)

// oldestDispatchable returns the oldest work item for the session and which
// executor entry applies. A requeue-awaiting-resume (dispatching AND
// RequeuePending — a shape ONLY RequeueForCertifiedRedelivery produces and
// ONLY itemForResume consumes) takes precedence over pending items; pending
// items follow FIFO by slice order (claimOldestPendingLocked's own scan).
// `ok=false` when nothing is dispatchable. In-flight attempts (dispatching
// WITHOUT the marker) are never returned.
func (l *queueDrainLoop) oldestDispatchable(st *sessionQueueStore) (itemID string, mode dispatchMode, ok bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.archived {
		return "", 0, false
	}
	if err := st.load(); err != nil {
		return "", 0, false
	}
	for i := range st.items {
		if st.items[i].State == QueueDispatching && st.items[i].RequeuePending {
			return st.items[i].ID, dispatchModeResume, true
		}
	}
	for i := range st.items {
		if st.items[i].State == QueuePending {
			return st.items[i].ID, dispatchModePending, true
		}
	}
	return "", 0, false
}

// discoverSessions returns the session ids that may hold dispatchable work:
// every REGISTERED store under the root (cheap registry walk), UNION the
// paced filesystem scan of .vh-solara/sessions/*/queue.json (post-restart
// discovery: a daemon restart loses the in-memory registry; the durable
// queue files are the recovery source). Filesystem sessions are materialized
// into the registry so the rest of the loop sees one shape.
func (l *queueDrainLoop) discoverSessions(lastFsScan *time.Time) []string {
	seen := map[string]bool{}
	var out []string
	qr := l.srv.queues
	qr.mu.Lock()
	prefix := l.root + "\x00"
	for k := range qr.stores {
		if strings.HasPrefix(k, prefix) {
			sid := strings.TrimPrefix(k, prefix)
			seen[sid] = true
			out = append(out, sid)
		}
	}
	qr.mu.Unlock()
	if time.Since(*lastFsScan) < drainFsScanInterval {
		return out
	}
	*lastFsScan = time.Now()
	entries, err := os.ReadDir(filepath.Join(l.root, ".vh-solara", "sessions"))
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(queuePath(l.root, e.Name())); err != nil {
			continue
		}
		_ = qr.store(l.root, e.Name()) // materialize (idempotent)
		if !seen[e.Name()] {
			seen[e.Name()] = true
			out = append(out, e.Name())
		}
	}
	return out
}
