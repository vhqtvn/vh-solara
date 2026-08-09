// The Q6 conditional periodic-resync machinery — extracted from ./stream per
// the stream-facade decomposition study (Region 6). This module owns the
// periodic tunables, the lastAuthoritativeRecovery / periodicTimer state,
// markAuthoritativeRecovery, schedulePeriodicResync, periodicResyncShouldRun,
// treeFingerprint, periodicResyncTick, startPeriodicResync, resolvePeriodicDiff,
// the periodic diff instrumentation, and the test accessors.
//
// Coupling (reverse-edge — the key reason it peels cleanly):
// - ./health imports markAuthoritativeRecovery (called from resyncTree after a
//   proceeding focus/periodic resync stamps the recovery boundary).
// - ./tree-transport imports markAuthoritativeRecovery + resolvePeriodicDiff
//   (the C4 coherent-install path calls resolvePeriodicDiff after seedTreeStore
//   installs this gen's authoritative tree map; snapshot.complete calls
//   markAuthoritativeRecovery). These reverse-import edges land on
//   ./periodic-resync directly (or via the ./stream re-export shim, per the
//   reducers-extraction pattern).
//
// This module reads the busy-gate flags (expectTreeSnap / expectSessionSnap,
// which stay in ./stream as the irreducible facade residue — Region 5) via the
// getExpectTreeSnap / getExpectSessionSnap accessors, and reads STALE_MS (which
// also stays in ./stream — shared with ./health) via the same-module binding.
// The stream ↔ periodic-resync import cycle is TDZ-safe: all cross-module reads
// happen inside function bodies called at runtime, not at module top-level
// (mirrors the established stream ↔ tree-transport / stream ↔ session-stream
// cycle discipline — runtime calls only, no top-level reads).
import { log } from "../lib/log";
import { projectDir } from "./store";
import { isGateActive } from "../busy";
import { treeMap } from "./treeState";
import {
  getTreeLastSeen,
  isTreeClosed,
  isTreeSnapshotDecoding,
  getTreeGen,
} from "./tree-transport";
import { resyncTree, TREE_RESYNC_MIN_GAP_MS } from "./health";
import { STALE_MS, getExpectTreeSnap, getExpectSessionSnap } from "./stream";

export const TREE_RESYNC_PERIODIC_INTERVAL_MS = 10 * 60 * 1000; // 10 min
export const TREE_RESYNC_PERIODIC_JITTER_MS = 2 * 60 * 1000; // ±2 min

// === Q6 — conditional periodic resync ========================================
//
// A bounded catch-all for surviving client drift on a CONTINUOUSLY-
// foregrounded tab. The on-focus trigger above can't see this drift class —
// the tab never backgrounded, so iOS never suspended its socket, so no
// visibilitychange fires. The live tree stream should keep state correct on its
// own, but a missed tree.op frame (an emitter gap) would otherwise accumulate
// unbounded until a restart. This periodic trigger bounds that exposure at a
// low frequency, gated so it ONLY runs when it is safe and likely to be the
// highest-value action available.
//
// NOTE: this periodic tick is now a BACKSTOP. The primary fast-loss detection
// is the per-stream seq-gap check (Invariant 1, tree-transport.ts +
// session-stream.ts) which self-heals in seconds on the next surviving event.
// This 10-min tick catches the residual class (drift with NO surviving event to
// expose the gap, or gaps masked by the covering check in multi-session mode).
//
// Preconditions (ALL must hold — see periodicResyncShouldRun):
//   - document visible             (only a foregrounded tab accumulates this)
//   - navigator.onLine             (don't resync over a dead network)
//   - projectDir() set             (no cwd bridge)
//   - tree stream OPEN + healthy   (not CLOSED, not stale — stale is the
//                                   watchdog's job; resyncing a stale stream
//                                   would only race the watchdog's reconnect)
//   - no snapshot decode in flight  (don't stack a second wholesale replace)
//   - no reconcileBusy in flight    (expectTreeSnap/expectSessionSnap clear)
//   - no global busy scope active   (no archive/baseline install in flight)
//   - no recovery in the previous   (a focus resync / watchdog reconnect /
//     interval                       periodic resync / project switch just
//                                   completed — see lastAuthoritativeRecovery)
//
// On any no-op (a gate fails OR the fresh snapshot matched the prior state),
// the timer is rescheduled for the next interval; the cadence never rises
// above ~1 resync / 10min regardless of how often the tick callback runs.
//
// Reset-after-recovery: markAuthoritativeRecovery() is called on every
// successful authoritative boundary (snapshot.complete) AND every proceeding
// resyncTree(), and reschedules the periodic timer so the next tick is a full
// interval away. This keeps the periodic clearly secondary: any other recovery
// path pushes it out.

// Timestamp of the last successful authoritative recovery (ms). Stamped on
// snapshot.complete (the Q5 convergence boundary) and on resyncTree() when it
// proceeds. Drives both the "no recovery in the previous interval" precondition
// and the reset-after-recovery rescheduling.
let lastAuthoritativeRecovery = 0;

// The periodic timer is a self-scheduling setTimeout (NOT setInterval) so each
// tick recomputes the next delay with fresh jitter and so reset-after-recovery
// can clear + reschedule cleanly. periodicStarted gates the whole feature: it
// stays false until startPeriodicResync() arms it (called once from startSync),
// so resyncTree()/snapshot.complete calls in unit tests that never start the
// periodic feature have NO timer side effects.
let periodicTimer: number | undefined;
let periodicStarted = false;

// markAuthoritativeRecovery — stamp the recovery boundary and (if the periodic
// feature is armed) reschedule its timer. Called from snapshot.complete (every
// successful authoritative capture) and from resyncTree() (every proceeding
// focus/periodic resync). Exported because resyncTree moved to ./health and
// imports this to stamp the recovery boundary after a focus/periodic resync.
export function markAuthoritativeRecovery(): void {
  lastAuthoritativeRecovery = Date.now();
  schedulePeriodicResync();
}

// schedulePeriodicResync — (re)arm the periodic timer with a fresh jittered
// delay. No-op until startPeriodicResync() has armed the feature. Idempotent:
// clears any pending timer first. Called on start, on every recovery boundary,
// and after every periodic tick (fire or no-op).
function schedulePeriodicResync(): void {
  if (!periodicStarted) return;
  if (periodicTimer !== undefined) window.clearTimeout(periodicTimer);
  const jitter = (Math.random() * 2 - 1) * TREE_RESYNC_PERIODIC_JITTER_MS;
  const delay = Math.max(
    TREE_RESYNC_MIN_GAP_MS,
    TREE_RESYNC_PERIODIC_INTERVAL_MS + jitter,
  );
  periodicTimer = window.setTimeout(periodicResyncTick, delay);
}

// periodicResyncShouldRun — the precondition predicate. Returns true ONLY when
// a periodic resync is safe and likely useful. Pure read of module state +
// DOM/network conditions; exported for unit testing each gate independently.
export function periodicResyncShouldRun(): boolean {
  // Only a foregrounded tab accumulates the "continuously open but drifted"
  // state this catches; a backgrounded tab is healed on focus return.
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
  // Don't resync over a dead network (the connect would just fail and the
  // watchdog / online listener would take over).
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  // No project selected → no tree stream to resync.
  if (!projectDir()) return false;
  // Tree stream must be OPEN (not CLOSED — the watchdog owns reconnecting a
  // closed stream; a resync here would only race it). isTreeClosed() is the
  // tree-transport accessor (the `es` EventSource MOVED to ./tree-transport with
  // connect(); this module no longer holds the socket ref directly).
  if (isTreeClosed()) return false;
  // And HEALTHY (not stale — a stale-but-open stream is the watchdog's signal
  // to force a reconnect, not the periodic's). getTreeLastSeen() is the
  // tree-transport accessor (treeLastSeen MOVED to ./tree-transport).
  const tls = getTreeLastSeen();
  if (!tls || Date.now() - tls > STALE_MS) return false;
  // No wholesale snapshot decode or coherent capture in flight — stacking a
  // second connect(true) would bump treeGen and invalidate the in-flight
  // decode/owner's apply. C4: isTreeSnapshotDecoding() covers BOTH the
  // independent detail decode AND a pending coherent owner.
  if (isTreeSnapshotDecoding()) return false;
  // No reconcileBusy scope in flight — it already requested fresh snapshots.
  // The busy-gate flags (expectTreeSnap / expectSessionSnap) STAY in ./stream
  // (Region 5, the irreducible facade residue); read via the accessor seam so
  // the mutation surface stays single-owner. Mirrors the established
  // expectSessionSnap accessor pattern (audit §6c).
  if (getExpectTreeSnap() || getExpectSessionSnap()) return false;
  // No global busy scope (archive/unarchive/baseline install) in flight — the
  // gate suppresses store mutation and its release triggers its own reconcile.
  if (isGateActive()) return false;
  // No recovery in the previous interval — a focus resync / watchdog reconnect
  // / periodic resync / project switch just completed. Bounds the cadence and
  // keeps the periodic clearly secondary to every other recovery path.
  if (Date.now() - lastAuthoritativeRecovery < TREE_RESYNC_PERIODIC_INTERVAL_MS) return false;
  return true;
}

// Diffs-found vs no-op instrumentation. The periodic trigger's whole purpose is
// to catch emitter gaps the live stream missed; if it NEVER finds a diff, the
// live stream is healthy and the periodic is dead weight (signal to reconsider
// the cadence). If it OFTEN finds diffs, the emitter has a gap worth chasing.
// At minimum we distinguish the two outcomes in a log + counter so recurring
// emitter gaps stay visible (Q6 "MEASURE before enabling by default").
let periodicDiffPending: { beforeFp: string; gen: number } | null = null;
let periodicResyncNoOps = 0;
let periodicResyncDiffsFound = 0;

// treeFingerprint — a stable, order-independent digest of the resident tree
// map's drift-relevant state (id set + activity + facets). Used to compare the
// pre-resync state against the post-resync authoritative snapshot so a no-op
// resync (live stream was already correct) is distinguishable from one that
// found an emitter gap. Deliberately excludes display-only fields (title,
// updatedMs, loaded, agent, verb) that a fresh snapshot re-stamps without
// indicating a missed EVENT.
function treeFingerprint(): string {
  const m = treeMap();
  if (m.size === 0) return "";
  const parts: string[] = [];
  for (const [, n] of m) {
    const f = n.flags;
    parts.push(
      n.id +
        "|" +
        n.activity +
        "|" +
        (f.subtreeBusy ? "B" : "b") +
        (f.subtreeNeedsInput ? "I" : "i") +
        (f.pendingInput ? "P" : "p") +
        (f.permission ? "A" : "a") +
        (f.archived ? "R" : "r"),
    );
  }
  parts.sort();
  return parts.join("\n");
}

// periodicResyncTick — the timer callback. Evaluates the preconditions and, if
// they all hold, requests ONE fresh snapshot (via resyncTree → connect(true))
// after capturing a before-fingerprint for the diffs-found instrumentation.
// Always reschedules first so the cadence is bounded regardless of outcome.
function periodicResyncTick(): void {
  // Reschedule first so a throw or a failed gate can't drop the timer.
  schedulePeriodicResync();
  if (!periodicResyncShouldRun()) return;
  // Capture the pre-resync fingerprint (old state still in place), then call
  // resyncTree. connect(true) inside resyncTree bumps treeGen (now owned by
  // ./tree-transport); read it AFTER via getTreeGen() so periodicDiffPending.gen
  // is the NEW connection's generation (the one whose tree.snapshot apply path —
  // after seedTreeStore — will resolve the diff check via resolvePeriodicDiff;
  // see its docstring).
  const beforeFp = treeFingerprint();
  const genBefore = getTreeGen();
  resyncTree();
  // Only attribute a diff check if resyncTree actually opened a new connection
  // (bumped treeGen). If it bailed (e.g. throttle — shouldn't happen post-gate,
  // but defensive), no snapshot is coming from this tick.
  const genAfter = getTreeGen();
  if (genAfter !== genBefore) {
    periodicDiffPending = { beforeFp, gen: genAfter };
  }
}

// startPeriodicResync — arm the periodic timer. Called once from startSync().
// Idempotent: a second call while already armed is a no-op.
export function startPeriodicResync(): void {
  if (periodicStarted) return;
  periodicStarted = true;
  schedulePeriodicResync();
}

// resolvePeriodicDiff — called from the tree.snapshot apply path (after
// seedTreeStore installs this gen's authoritative tree map; see the inline
// comment at the call site for why resolution happens here and not at the
// snapshot.complete boundary). If a periodic resync is awaiting its result,
// compare the post-snapshot fingerprint against the captured before-fingerprint
// and record the outcome. Clears the pending slot regardless (a slot whose
// requested connection was superseded by a different-gen recovery is dropped
// without counting).
// Exported because the tree-transport C4 barrier (./tree-transport:
// applyTreeIndependent / tryInstall) calls this after seedTreeStore installs the
// coherent/legacy tree map, so the periodic-resync attribution observes the
// freshly-seeded map (not a mixed pair — Case 9 of the coherent barrier suite).
export function resolvePeriodicDiff(connGen: number): void {
  if (!periodicDiffPending) return;
  // Only attribute the diff to a periodic resync whose requested connection is
  // the one whose snapshot just completed. A focus resync that superseded the
  // periodic's connection (different gen) drops the slot without counting.
  if (periodicDiffPending.gen !== connGen) {
    periodicDiffPending = null;
    return;
  }
  const afterFp = treeFingerprint();
  if (afterFp === periodicDiffPending.beforeFp) {
    periodicResyncNoOps++;
    log.debug("sync", "periodic resync no-op (no drift found)");
  } else {
    periodicResyncDiffsFound++;
    log.info("sync", "periodic resync found drift (emitter gap caught)");
  }
  periodicDiffPending = null;
}

// Test-only accessors (mirror the _resetResyncGateForTest pattern). Prefixed
// _ and suffixed ForTest so a grep keeps them visually distinct from runtime API.
// _resetResyncGateForTest moved to ./health (it resets lastTreeResync,
// which moved with resyncTree). Re-exported above.
export function _resetPeriodicStateForTest(): void {
  if (periodicTimer !== undefined) window.clearTimeout(periodicTimer);
  periodicTimer = undefined;
  periodicStarted = false;
  lastAuthoritativeRecovery = 0;
  periodicDiffPending = null;
  periodicResyncNoOps = 0;
  periodicResyncDiffsFound = 0;
}
// → _markTreeSeenForTest moved to ./tree-transport (re-exported below).
export function _setLastAuthoritativeRecoveryForTest(ms: number): void {
  lastAuthoritativeRecovery = ms;
}
export function _getPeriodicResyncStatsForTest(): {
  diffsFound: number;
  noOps: number;
} {
  return { diffsFound: periodicResyncDiffsFound, noOps: periodicResyncNoOps };
}
