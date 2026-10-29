// Slice A (send-net-resilience) — the CONVERGENCE CASCADE (debate-3 AMEND-A5,
// amended by the 2026-10-10 research packet + coordinator adjudication 1).
// BINDING CONTRACT: researches/decisions/2026-10-10-send-convergence-cascade-and-connstatus.md
// (§1 the pass contract + epoch discipline; the tmp design record is
// gitignored history).
//
// CHARTER: ONE coalesced, supersession-aware recovery pass per eval that the
// existing scattered recovery paths feed into, PLUS the epoch/seq snapshot-apply
// discipline that closes the D1 snapshot-clobber hazard.
//
// ── Epoch discipline (BINDING adjudication 1: identity + liveness, NOT ordering)
// ─────────────────────────────────────────────────────────────────────────────
// Daemon epochs are crypto-random per store lifetime (pkg/state/store.go
// newEpoch): never reused, never ORDERED. The FE therefore NEVER compares seqs
// across epochs. `state.epoch` (set by projectSnapshot on apply) is the epoch
// our state was built from. The discipline:
//   - snapshot tagged with the state's epoch (or either side empty — boot /
//     legacy daemon): seq-compare — snap.seq < acceptedCursor ⇒ DISCARD (D1:
//     a stale same-epoch snapshot never rewinds cursor/state); else apply with
//     a monotonic cursor ratchet.
//   - snapshot tagged with a DIFFERENT epoch: one of the two is from another
//     store lifetime. Which one is decided by PROVENANCE:
//       - "stream": delivered on the current gen-guarded SSE connection ⇒
//         fresh by construction ⇒ APPLY-REBUILD (the reducers' epoch-change
//         clearing invalidates prior-epoch detail; the cursor RE-BASELINES to
//         snap.seq — cross-epoch seq comparison is forbidden).
//       - "http": an HTTP-fetched bundle (expand-children detail) can race a
//         daemon restart in either direction ⇒ DISCARD + one conservative
//         epoch-reset recovery pass (a fresh tree snapshot re-syncs; in the
//         state-was-stale direction this costs one redundant resync — the
//         documented conservative price of never guessing liveness from a
//         random epoch).
//   - live events are untagged; they arrive gen-guarded on the current
//     connection, so their cursor advance is a monotonic ratchet (the
//     session-stream sesCursor guard, session-stream.ts `if (seq > sesCursor)`,
//     generalized to the shared store cursor).
//
// ── The pass (AMEND-A5 generation contract, debate-4 #8 canonicalization)
// ─────────────────────────────────────────────────────────────────────────────
// A pass is keyed by the generation key { epoch, acceptedCursor, canonicalized
// reason-set } — captured at pass start. EXACTLY ONE pass is in flight per
// eval. Requests carry their OWN recovery action (`direct`) so this module
// holds NO static transport imports (no cycles; an unwired cascade executes
// each request's action exactly as the pre-cascade code did).
//
// Coalescing (the dedup AMEND-A5 exists for): a request arriving mid-pass
// unions its reason into the running pass's set. Its action is SUBSUMED
// (skipped) when the pass is already awaiting that stream's baseline — the
// pending recovery covers it (N overlapping triggers in one window ⇒ exactly
// ONE cascade ⇒ ONE reconnect per stream, ONE queue reconcile). A request for
// a stream the pass is NOT awaiting still runs its action and adds the step —
// coalescing dedupes DUPLICATE work, never DROPS a distinct stream's recovery.
//
// Supersession rules (which passes/reason-sets supersede):
//   S1. EPOCH CHANGE: a request whose live state.epoch differs from the
//       running pass's genKey epoch supersedes it — the running pass's pending
//       outputs belong to a dead store lifetime. Its unconverged steps are NOT
//       inherited (moot across lifetimes).
//   S2. PROVEN LOSS AFTER CONVERGENCE: a loss-class reason (tree-seq-gap /
//       seq-gap / offset-mismatch / tail-incomplete / tree-overlap-capture /
//       epoch-reset) whose implied steps are ALL already converged — or never
//       awaited — in the running pass cannot be absorbed by it ⇒ supersedes.
//       The superseding pass INHERITS the old pass's pending steps (same
//       epoch) so the queue trigger still waits for them.
//   Everything else coalesces (soft reasons — watchdog stales, sentinel
//   timeouts, drift resyncs, ring-gap/stream-live signals).
// Generation check before EVERY commit: the queue-reconcile trigger and the
// completion bookkeeping compare pass.gen against the live cascade generation,
// so a superseded pass's late outputs (its timeout, its convergence notes
// racing the supersede) never commit.
//
// ── Unified queue-reconcile trigger (slice-A scope item 3)
// ─────────────────────────────────────────────────────────────────────────────
// When a pass converges (every awaited stream's baseline landed) the cascade
// fires the registered queue-reconcile trigger — the SAME reconcileOutbox +
// fetch surface session-open and focus use; there is NO third caller. Sources
// that route here: the stream-live reconnect path (createQueueSync →
// notifyStreamLive), the server's PRECISE ring-gap signal (detail snapshot
// partial.ringGap:true → noteServerRingGap — the Slice B switch; the coarse
// tree.snapshot cause:"reconnect" NO LONGER arms a pass and only counts
// benign server-reconnect-resume telemetry), and any converging recovery
// pass.
// A pass that times out (CASCADE_PASS_TIMEOUT_MS) completes WITHOUT the
// trigger (convergence unproven; the queue's own 5s poll / focus covers).
//
// No top-level side effects (only let/const/function). Imports are leaves
// (store, recovery-reasons, diaglog) — no transport imports, no cycles. The
// diaglog import is INSTRUMENTATION ONLY (bounded, default-off-gated
// pass-boundary stamps — see noteCascadeBoundary call sites); it never
// influences pass control flow.
import { log } from "../lib/log";
import { state } from "./store";
import { countRecovery, type RecoveryReason } from "./recovery-reasons";
import { noteCascadeBoundary } from "./diaglog";

// Cascade reasons: the EXISTING closed vocabulary (recovery-reasons.ts,
// extend-only) plus the stream-live trigger context (counted at the OUTCOME —
// "cascade-queue-reconcile" — not at the trigger, to keep the diag surface
// about recoveries that ran).
export type CascadeReason = RecoveryReason | "stream-live";

// Loss-class reasons: a PROVEN loss right now. Everything else is a retry
// hint / drift signal (coalescable — the pending recovery may still deliver).
const LOSS_REASONS: ReadonlySet<CascadeReason> = new Set([
  "tree-seq-gap",
  "seq-gap",
  "offset-mismatch",
  "tail-incomplete",
  "tree-overlap-capture",
  "epoch-reset",
]);

// Which stream baselines a pass awaits, and how:
//   "fresh"  — the pass's action requested a cursorless authoritative snapshot
//   "resume" — the pass's action reopened preserving the cursor (ring replay)
//   "await"  — no new action; wait for the pending tree baseline to land
//              (server-ring-gap / stream-live: the reconnect already happened)
export interface CascadeSteps {
  tree?: "fresh" | "resume" | "await";
  session?: "fresh" | "resume";
}

export const CASCADE_PASS_TIMEOUT_MS = 15_000;
let cascadeTimeoutMs = CASCADE_PASS_TIMEOUT_MS;

// A pass's per-stream step: pending (awaiting its baseline) or converged.
// A stream with NO step entry is not awaited by the pass.
interface CascadePass {
  gen: number;
  genKey: {
    epoch: string;
    acceptedCursor: number;
    reasons: Set<CascadeReason>;
  };
  steps: {
    tree?: { state: "pending" | "converged"; mode: "fresh" | "resume" | "await" };
    session?: { state: "pending" | "converged"; mode: "fresh" | "resume" };
  };
  timeout: number;
  /** Wall-clock pass start (ms epoch) — the diag boundary stamps' elapsed base. */
  startedAt: number;
}

let cascadeGen = 0;
let inFlight: CascadePass | null = null;

// Observability (test + diag surface): pass counters + the last pass's
// canonical generation key (a LIVE view while a pass is in flight).
const stats = {
  started: 0,
  coalesced: 0,
  superseded: 0,
  queueTriggers: 0,
};
let lastGenKey: { epoch: string; acceptedCursor: number; reasons: CascadeReason[] } | null = null;

// The registered queue-reconcile trigger (ChatView wires this to the SAME
// reconcileOutbox + fetchQueue surface session-open/focus use). Token-guarded
// so a stale cleanup can never clear a newer registration.
let queueReconcileTrigger: (() => void) | null = null;
let triggerToken = 0;

// ── Slice B: production completion observable (connstatus input) ────────────
// cascade.ts stays Solid-free (pure supervisor). connstatus.ts mirrors this
// subscription into its own signal. Listeners are notified on every pass
// lifecycle transition that can change cascadeRecoveryPending(): pass start
// (incl. supersession), completion, timeout. Coalesce/reason-unions never
// change pendingness and do not notify. Exceptions in a listener are logged
// and never propagate into the supervisor.
type CascadeStateListener = (pending: boolean) => void;
const cascadeListeners = new Set<CascadeStateListener>();

/** Subscribe to cascade pendingness transitions. Returns an unsubscribe fn. */
export function subscribeCascadeState(fn: CascadeStateListener): () => void {
  cascadeListeners.add(fn);
  return () => {
    cascadeListeners.delete(fn);
  };
}

/**
 * True while a recovery pass has an UNCONVERGED awaited baseline — the
 * "post-reconnect convergence outstanding" input the graded ConnStatus
 * reduction uses to block the live grade (debate-3 A6). A pass whose steps
 * all converged (completing on a microtask) is NOT pending. No pass at all
 * (happy-path boot, idle) is NOT pending.
 */
export function cascadeRecoveryPending(): boolean {
  const pass = inFlight;
  if (!pass) return false;
  const t = pass.steps.tree;
  const s = pass.steps.session;
  if ((t && t.state === "pending") || (s && s.state === "pending")) return true;
  return false;
}

function notifyCascadeState(): void {
  const pending = cascadeRecoveryPending();
  for (const fn of cascadeListeners) {
    try {
      fn(pending);
    } catch (err) {
      log.warn("sync", "cascade state listener threw", { err: String(err) });
    }
  }
}

export function setQueueReconcileTrigger(fn: (() => void) | null): number {
  queueReconcileTrigger = fn;
  return ++triggerToken;
}

export function clearQueueReconcileTrigger(token: number): void {
  if (token === triggerToken) queueReconcileTrigger = null;
}

// canon — canonical reason-set ordering (debate-4 #8: reason-set
// canonicalization). Sorted lexicographically, deduped.
function canon(reasons: Iterable<CascadeReason>): CascadeReason[] {
  return [...new Set(reasons)].sort();
}

function syncLastGenKey(pass: CascadePass): void {
  lastGenKey = {
    epoch: pass.genKey.epoch,
    acceptedCursor: pass.genKey.acceptedCursor,
    reasons: canon(pass.genKey.reasons),
  };
}

// stepConvergedForS2 — for the supersession check, a stream the pass never
// awaited counts as "converged" (the pass has no pending baseline that could
// absorb a new loss on that stream).
function stepConvergedForS2(pass: CascadePass, stream: "tree" | "session"): boolean {
  const s = pass.steps[stream];
  return !s || s.state === "converged";
}

// pendingStreams — the pass's still-unconverged steps, for the bounded diag
// boundary stamps (pass-start / pass-timeout / pass-superseded). Pure read.
function pendingStreams(pass: CascadePass): ("tree" | "session")[] {
  const out: ("tree" | "session")[] = [];
  if (pass.steps.tree?.state === "pending") out.push("tree");
  if (pass.steps.session?.state === "pending") out.push("session");
  return out;
}

// startPass — open a new in-flight pass, run its action, await convergence.
// `inherit` carries a same-epoch superseded pass's pending steps.
function startPass(
  reason: CascadeReason,
  direct: (() => void) | undefined,
  steps: CascadeSteps | undefined,
  inherit: CascadePass | null,
): void {
  const gen = ++cascadeGen;
  const pass: CascadePass = {
    gen,
    genKey: {
      epoch: state.epoch || "",
      acceptedCursor: state.cursor,
      reasons: new Set([reason]),
    },
    steps: {},
    timeout: 0,
    startedAt: Date.now(),
  };
  if (steps?.tree !== undefined) {
    // "await" is satisfied immediately when the tree baseline is already
    // authoritative; fresh/resume wait for their convergence note.
    pass.steps.tree = {
      state: steps.tree === "await" && state.authoritativeReady ? "converged" : "pending",
      mode: steps.tree,
    };
  }
  if (steps?.session !== undefined) {
    pass.steps.session = { state: "pending", mode: steps.session };
  }
  if (inherit) {
    // S2 inheritance: the superseded pass's still-pending steps stay awaited
    // (their recovery action already ran; only the baseline is pending).
    if (inherit.steps.tree?.state === "pending" && !pass.steps.tree) {
      pass.steps.tree = { ...inherit.steps.tree };
    }
    if (inherit.steps.session?.state === "pending" && !pass.steps.session) {
      pass.steps.session = { ...inherit.steps.session };
    }
  }
  inFlight = pass;
  stats.started++;
  syncLastGenKey(pass);
  // Bounded diag stamp (capture-2): the pass START boundary, stamped before
  // the direct action runs so a synchronous convergence note inside it still
  // lands after this entry in the ring. Default-off gated inside the helper.
  noteCascadeBoundary("pass-start", {
    reasons: canon(pass.genKey.reasons),
    pending: pendingStreams(pass),
  });
  // The recovery action runs IMMEDIATELY, synchronously — the cascade adds NO
  // recovery latency. (An unwired/no-op direct is fine: convergence-awaiting
  // passes like server-ring-gap pass none.)
  if (direct) {
    try {
      direct();
    } catch (err) {
      // A failed action must not wedge the supervisor — the pass still awaits
      // its convergence (or times out) and the transport's own ladders
      // (backoff/watchdog) remain the owners of retry.
      log.warn("sync", "cascade direct action threw", { reason, err: String(err) });
    }
  }
  pass.timeout = window.setTimeout(() => {
    // Generation check before commit: a superseded pass's late timeout is a
    // no-op (its successor owns the cascade now).
    if (pass.gen !== cascadeGen || inFlight !== pass) return;
    inFlight = null;
    notifyCascadeState();
    log.warn("sync", "cascade pass timed out without convergence", {
      reasons: canon(pass.genKey.reasons),
    });
    // Bounded diag stamp (capture-2): the 15s timeout boundary — the one
    // edge where pendingness clears WITHOUT convergence. Must be observable
    // in a capture (a grade stuck on convergence-pending that suddenly
    // resolves with no applied@ stamp is THIS entry).
    noteCascadeBoundary("pass-timeout", {
      reasons: canon(pass.genKey.reasons),
      pending: pendingStreams(pass),
      elapsedMs: Date.now() - pass.startedAt,
    });
  }, cascadeTimeoutMs);
  maybeComplete(pass);
  notifyCascadeState();
}

// maybeComplete — all awaited baselines landed ⇒ complete the pass and fire
// the queue-reconcile trigger (on a microtask — never inside a Solid batch or
// a transport listener frame). Gen-checked: a superseded pass never commits.
function maybeComplete(pass: CascadePass): void {
  if (pass.gen !== cascadeGen || inFlight !== pass) return;
  const t = pass.steps.tree;
  const s = pass.steps.session;
  if ((t && t.state === "pending") || (s && s.state === "pending")) return;
  inFlight = null;
  notifyCascadeState();
  window.clearTimeout(pass.timeout);
  syncLastGenKey(pass);
  // Bounded diag stamp (capture-2): the convergence boundary — every awaited
  // baseline landed. pending is empty by definition here (omitted).
  noteCascadeBoundary("pass-converged", {
    reasons: canon(pass.genKey.reasons),
    elapsedMs: Date.now() - pass.startedAt,
  });
  stats.queueTriggers++;
  queueMicrotask(() => {
    if (pass.gen !== cascadeGen) return; // superseded before the microtask ran
    countRecovery("cascade-queue-reconcile");
    queueReconcileTrigger?.();
  });
}

/**
 * requestRecovery — feed one recovery into the cascade. `direct` is THIS
 * request's recovery action (e.g. `() => connect(true)`); it executes
 * synchronously when the request starts a pass. Mid-pass it is SUBSUMED
 * (skipped) when the pass is already awaiting that stream's baseline, and
 * still runs when the request covers a stream the pass is not awaiting.
 * `steps` declares which stream baselines the pass awaits before firing the
 * queue-reconcile trigger.
 */
export function requestRecovery(
  reason: CascadeReason,
  direct?: () => void,
  steps?: CascadeSteps,
): void {
  const cur = inFlight;
  if (!cur) {
    startPass(reason, direct, steps, null);
    return;
  }
  // S1 — epoch change mid-pass: the running pass belongs to a dead store
  // lifetime. Supersede WITHOUT inheriting its steps.
  if (state.epoch !== cur.genKey.epoch) {
    stats.superseded++;
    inFlight = null;
    window.clearTimeout(cur.timeout);
    // Bounded diag stamp (capture-2): the dying pass's boundary (stamped
    // before the successor's pass-start so ring order reads A-start,
    // A-superseded, B-start).
    noteCascadeBoundary("pass-superseded", {
      reasons: canon(cur.genKey.reasons),
      pending: pendingStreams(cur),
      elapsedMs: Date.now() - cur.startedAt,
    });
    startPass(reason, direct, steps, null);
    return;
  }
  // S2 — proven loss whose implied steps are ALL converged-or-unawaited in
  // the running pass: it cannot absorb the loss. Supersede WITH inheritance.
  const loss = LOSS_REASONS.has(reason);
  if (
    loss &&
    (steps?.tree === undefined || stepConvergedForS2(cur, "tree")) &&
    (steps?.session === undefined || stepConvergedForS2(cur, "session"))
  ) {
    stats.superseded++;
    inFlight = null;
    window.clearTimeout(cur.timeout);
    noteCascadeBoundary("pass-superseded", {
      reasons: canon(cur.genKey.reasons),
      pending: pendingStreams(cur),
      elapsedMs: Date.now() - cur.startedAt,
    });
    startPass(reason, direct, steps, cur);
    return;
  }
  // COALESCE: union the reason. Subsume-or-extend per stream:
  //   pass awaiting that stream        ⇒ action subsumed (skip — the dedup)
  //   pass NOT awaiting that stream    ⇒ run the action, add the step
  //   step already converged           ⇒ action subsumed by that baseline
  stats.coalesced++;
  cur.genKey.reasons.add(reason);
  let ranDirect = false;
  if (steps?.tree !== undefined) {
    const t = cur.steps.tree;
    if (!t) {
      cur.steps.tree = { state: "pending", mode: steps.tree };
      ranDirect = true;
    }
    // else: pending (subsumed) or converged (baseline already covers it).
  }
  if (steps?.session !== undefined) {
    const s = cur.steps.session;
    if (!s) {
      cur.steps.session = { state: "pending", mode: steps.session };
      ranDirect = true;
    }
  }
  if (ranDirect && direct) {
    try {
      direct();
    } catch (err) {
      log.warn("sync", "cascade coalesced direct action threw", { reason, err: String(err) });
    }
  }
  syncLastGenKey(cur);
}

/**
 * noteExternalRecovery — observe a recovery that executed OUTSIDE the cascade
 * (kept-direct paths: overlap-capture's owner-hygiene reconnect, the
 * silent-fallback one-shot, native backoff reopens). Unions the reason into a
 * running pass's set so its generation key stays truthful; a pure no-op when
 * no pass is in flight.
 */
export function noteExternalRecovery(reason: CascadeReason): void {
  if (inFlight) {
    inFlight.genKey.reasons.add(reason);
    syncLastGenKey(inFlight);
  }
}

/**
 * noteTreeConverged — an authoritative tree baseline (the tree-only
 * independent path — no guard-discard verdict by design) or an APPLIED
 * tree+detail coherent capture landed on the current tree connection
 * (tryInstall / the detail-independent installer's applied verdict).
 * Satisfies the in-flight pass's tree step.
 */
export function noteTreeConverged(): void {
  if (!inFlight) return;
  const t = inFlight.steps.tree;
  if (!t || t.state === "converged") return;
  t.state = "converged";
  // Bounded diag stamp (capture-2): this step's baseline landed (≤1 per
  // stream per pass). Stamped before maybeComplete so step precedes
  // pass-converged in the ring.
  noteCascadeBoundary("step-converged", { stream: "tree" });
  maybeComplete(inFlight);
}

/**
 * noteSessionConverged — a session-stream snapshot applied on the current
 * session connection. Satisfies the in-flight pass's session step.
 */
export function noteSessionConverged(): void {
  if (!inFlight) return;
  const s = inFlight.steps.session;
  if (!s || s.state === "converged") return;
  s.state = "converged";
  noteCascadeBoundary("step-converged", { stream: "session" });
  maybeComplete(inFlight);
}

/**
 * noteServerRingGap — consume the server's PRECISE missed-events signal:
 * partial.ringGap=true on the detail `snapshot` frame (Slice B switch). The
 * daemon stamps that flag ONLY in handleStream's fresh-snapshot fallback —
 * `detailSnap.Partial.RingGap`, gated hasCursor && !replayOK (the sole
 * stamping site; field semantics: PartialMeta.RingGap in pkg/state/store.go):
 * the client HAD a cursor and the shared replay ring could not serve it —
 * events were missed while disconnected. The pass: step-less,
 * awaits the pending tree baseline (F3-gated: only an APPLIED
 * baseline converges it), fires the queue-reconcile trigger (the queue is
 * the missed-output consumer).
 *
 * The COARSE tree.snapshot cause:"reconnect" is NOT this signal — the server
 * stamps it on EVERY cursor-resume reconnect (hardcoded on the replay-success
 * re-seed snapshots in handleStream's replay branch; derived from the
 * hasCursor && !replayOK gate on the fresh-snapshot branch). A
 * cause:"reconnect" WITHOUT partial.ringGap is a benign replay resume,
 * counted as telemetry ("server-reconnect-resume" in recovery-reasons.ts)
 * with NO cascade arming.
 */
export function noteServerRingGap(): void {
  countRecovery("server-ring-gap");
  requestRecovery("server-ring-gap", undefined, { tree: "await" });
}

/**
 * notifyStreamLive — the stream-live reconnect entry (createQueueSync's
 * live-after-reconnecting transition). The cascade owns the trigger: the
 * queue reconcile + fetch fire when the post-reconnect tree baseline
 * converges — the same surface session-open/focus use. No third caller.
 */
export function notifyStreamLive(): void {
  requestRecovery("stream-live", undefined, { tree: "await" });
}

// ── Snapshot-apply guard (the D1 closure + epoch-identity discipline) ────────

// Provenance of a Snapshot reaching applySnapshot/applyScopedSnapshot:
//   "stream" — delivered on the current gen-guarded SSE connection (fresh by
//              construction; the default preserves the legacy call signature).
//   "http"   — an HTTP-fetched bundle (expand-children detail) that can race a
//              daemon restart in either direction.
export type SnapshotProvenance = "stream" | "http";

export interface SnapshotVerdict {
  /** false ⇒ the caller must NOT project the snapshot (discard). */
  apply: boolean;
  /** true ⇒ the caller SETS cursor = snap.seq (re-baseline); false ⇒ monotonic. */
  rebaseline: boolean;
  /** present when apply === false. */
  discard?: "stale-seq" | "stale-epoch";
}

/**
 * guardSnapshotApply — the adjudication-1 epoch/seq discipline, evaluated
 * BEFORE any projection so a discarded snapshot can never rewind state OR
 * cursor. Pure read of the store; no side effects (the CALLER reacts to a
 * "stale-epoch" discard with the conservative epoch-reset recovery).
 */
export function guardSnapshotApply(
  snap: { seq: number; epoch?: string },
  provenance: SnapshotProvenance,
): SnapshotVerdict {
  const stateEpoch = state.epoch || "";
  const snapEpoch = snap.epoch || "";
  // Boot / legacy daemon: no identity on one side ⇒ the incoming snapshot is
  // the new truth — apply, cursor set unconditionally (today's semantics).
  if (!snapEpoch || !stateEpoch) return { apply: true, rebaseline: true };
  if (snapEpoch === stateEpoch) {
    // Same store lifetime: seq-compare. D1 — a snapshot below the accepted
    // cursor is stale (late decode / racing capture); never rewind.
    if (snap.seq < state.cursor) {
      return { apply: false, rebaseline: false, discard: "stale-seq" };
    }
    return { apply: true, rebaseline: false };
  }
  // Cross-epoch (both non-empty): identity cannot order them — provenance
  // decides. Stream ⇒ fresh by construction ⇒ rebuild. HTTP ⇒ untrusted ⇒
  // discard + conservative re-sync (the caller requests epoch-reset).
  if (provenance === "stream") return { apply: true, rebaseline: true };
  return { apply: false, rebaseline: false, discard: "stale-epoch" };
}

// ── Test-only surface ────────────────────────────────────────────────────────

export function _resetCascadeForTest(): void {
  if (inFlight) window.clearTimeout(inFlight.timeout);
  inFlight = null;
  // Bump so any straggler microtask/timeout from a prior test fails its gen
  // check instead of firing into the next test's trigger.
  cascadeGen++;
  stats.started = 0;
  stats.coalesced = 0;
  stats.superseded = 0;
  stats.queueTriggers = 0;
  lastGenKey = null;
  queueReconcileTrigger = null;
  triggerToken++;
  // Slice B: drop state-subscription wiring with the rest of the singleton
  // (tests re-subscribe after reset; production never resets).
  cascadeListeners.clear();
  cascadeTimeoutMs = CASCADE_PASS_TIMEOUT_MS;
}

export function _setCascadeTimeoutForTest(ms: number): void {
  cascadeTimeoutMs = ms;
}

export function _getCascadeStateForTest(): {
  started: number;
  coalesced: number;
  superseded: number;
  queueTriggers: number;
  inFlight: boolean;
  lastGenKey: { epoch: string; acceptedCursor: number; reasons: CascadeReason[] } | null;
  lastReasons: CascadeReason[];
} {
  return {
    started: stats.started,
    coalesced: stats.coalesced,
    superseded: stats.superseded,
    queueTriggers: stats.queueTriggers,
    inFlight: inFlight !== null,
    lastGenKey,
    lastReasons: lastGenKey ? lastGenKey.reasons : [],
  };
}
