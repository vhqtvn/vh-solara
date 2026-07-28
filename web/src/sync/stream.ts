// The stream facade. The two-EventSource state-machine implementation lives in
// focused sibling modules — decode / history / session-stream / health /
// tree-transport / reducers / periodic-resync / refresh — all extracted per the
// invariant audit (§6a–§6e) and the stream-facade decomposition study. This
// module now owns only:
//   • STALE_MS — the shared stale threshold (read by ./health + ./periodic-resync)
//   • recordLatency — the Stream1/Stream2 latency recorder
//   • the global busy-scope reconciliation gate — expectTreeSnap /
//     expectSessionSnap (+ accessors) + maybeResolveReconcile + reconcileBusy,
//     the one cross-cutting invariant that cannot move to a single owner
//     (it pairs Stream1's connect(true) with Stream2's openSessionStream on the
//     outermost busy release).
//
// A thin re-export shim (below) remains for TWO reasons, both of which make a
// symbol load-bearing on this facade:
//   (a) the namespace-import integration tests that load this module via
//       `await import("../../src/sync/stream")` and reference symbols as
//       `stream.<x>` (the C4 / liveness / backoff / periodic-resync suite);
//   (b) the reverse-dependency edges from the (already-extracted) sibling
//       modules — health / tree-transport / session-stream still import a few
//       symbols THROUGH this facade (e.g. health imports connect +
//       markAuthoritativeRecovery; tree-transport imports applySessionEvent +
//       refreshOpenSessions). Those edges were NOT re-pointed to the owning
//       siblings in this slice (the extracted modules are out of scope), so the
//       facade must keep re-exporting them. Every symbol kept is annotated with
//       which reason (a)/(b) holds it; removing one requires re-pointing the
//       named consumer first.
import { setState, selectedId } from "./store";
import { setReconcileFn } from "../busy";

// === Re-export shim =========================================================
// tree-transport (Stream 1 lifecycle + the C4 coherent-capture barrier).
//   connect / isTreeSnapshotDecoding / getTreeSnapshotDecode / _markTreeSeenForTest
//   → (a) namespace tests (coherentBarrier / coveredAwait / expandTreeNodeC4 /
//        stream1Registration / stream1Backoff / treeStreamCompression / etc.)
//   connect / expandTreeNode → (a) namespace tests (expandTreeNodeC4)
//   isTreeClosed / getTreeLastSeen / getTreeContentSeen
//   → (b) ./health imports them from this facade (watchdog transport-stale branch).
import {
  connect,
  expandTreeNode,
  getTreeLastSeen,
  getTreeContentSeen,
  isTreeClosed,
  isTreeSnapshotDecoding,
  getTreeSnapshotDecode,
  _markTreeSeenForTest,
} from "./tree-transport";
// session-stream (Stream 2 lifecycle).
//   openSessionStream / getSesGen → (a) namespace tests (sessionLiveness /
//     sesSnapshotOwnership / preselectHydrate / coherentBarrierReloadRace).
//   closeSessionStream → (a) namespace tests (the `stream?.closeSessionStream()`
//     afterEach teardown across the C4 / liveness / backoff suite).
import { openSessionStream, closeSessionStream, getSesGen } from "./session-stream";
// health (watchdog + foreground/online recovery).
//   watchdogTick / maybeReconnect → (a) namespace tests (sessionLiveness /
//     treeLivenessContentStall / sessionLivenessContentStall).
import { watchdogTick, maybeReconnect } from "./health";
// reducers (store reducers).
//   applySnapshot / applySessionEvent / applyMessageEvent
//   → (b) ./tree-transport + ./session-stream import them from this facade
//        (the reverse-dependency edge: the stream listeners apply frames through
//        these reducers).
import { applySnapshot, applySessionEvent, applyMessageEvent } from "./reducers";
// periodic-resync (Q6 conditional drift self-heal).
//   TREE_RESYNC_PERIODIC_INTERVAL_MS / startPeriodicResync /
//   _setLastAuthoritativeRecoveryForTest / _getPeriodicResyncStatsForTest
//   → (a) namespace tests (coherentBarrier reset-after-recovery assertions).
//   markAuthoritativeRecovery / resolvePeriodicDiff
//   → (b) ./health + ./tree-transport import them from this facade.
import {
  TREE_RESYNC_PERIODIC_INTERVAL_MS,
  markAuthoritativeRecovery,
  startPeriodicResync,
  resolvePeriodicDiff,
  _setLastAuthoritativeRecoveryForTest,
  _getPeriodicResyncStatsForTest,
} from "./periodic-resync";
// refresh (warm-tree-reconnect message refresh).
//   refreshOpenSessions → (b) ./tree-transport imports it from this facade
//   (called after a tree reconnect: `void refreshOpenSessions()`).
import { refreshOpenSessions } from "./refresh";

export {
  // tree-transport
  connect,
  expandTreeNode,
  getTreeLastSeen,
  getTreeContentSeen,
  isTreeClosed,
  isTreeSnapshotDecoding,
  getTreeSnapshotDecode,
  _markTreeSeenForTest,
  // session-stream
  openSessionStream,
  closeSessionStream,
  getSesGen,
  // health
  watchdogTick,
  maybeReconnect,
  // reducers
  applySnapshot,
  applySessionEvent,
  applyMessageEvent,
  // periodic-resync
  TREE_RESYNC_PERIODIC_INTERVAL_MS,
  markAuthoritativeRecovery,
  startPeriodicResync,
  resolvePeriodicDiff,
  _setLastAuthoritativeRecoveryForTest,
  _getPeriodicResyncStatsForTest,
  // refresh
  refreshOpenSessions,
};

// === Shared stale threshold ================================================
// STALE_MS stays here (not in ./health): it is the transport-stale branch
// threshold imported by ./health's watchdogTick AND the periodic-resync gate
// threshold read by ./periodic-resync's periodicResyncShouldRun. Owning it here
// keeps both reverse-dependency edges single-direction (health +
// periodic-resync import from ./stream; stream imports from neither).
export const STALE_MS = 45_000; // ~3 missed 15s pings → assume the stream is dead

export function recordLatency(stream: "tree" | "session", phase: "open" | "snap", ms: number): void {
  setState("connLatency", stream, phase, Math.max(0, Math.round(ms)));
}

// === Global busy-scope reconciliation gate (archive/unarchive) ==============
// While a global busy scope is active (see ../busy.ts), stream frames are
// deferred: markTreeSeen/markSessionSeen run (watchdog health), but store
// mutation is suppressed.
// On the outermost release, reconcileBusy() requests fresh authoritative
// snapshots. expectTreeSnap / expectSessionSnap identify the ONE expected fresh
// snapshot per stream (from connect(true) / openSessionStream); all other frames
// during reconciliation are deferred + latch dirty. The precheck found that
// applySnapshot sets s.cursor = snap.seq UNCONDITIONALLY (no seq>cursor guard),
// so a fresh snapshot CAN clobber newer accepted state — therefore the gate is
// retained through both resume snapshots and the dirty-pass rule applies (at most
// one extra coalesced pass).
let expectTreeSnap = false;
let expectSessionSnap = false;
// expectTreeSnap accessors — the flag STAYS here (paired with expectSessionSnap
// by reconcileBusy / maybeResolveReconcile / the safety timer), but the C4
// coherent-install path (./tree-transport: applyDetailIndependent /
// applyTreeIndependent / tryInstall) reads it for the busy-gate handshake and
// clears it when the expected fresh TREE snapshot lands inside the coherent
// install batch. Exposed as accessors so the mutation surface stays single-owner
// (only reconcileBusy + its safety timer + this module's clear-on-handshake
// write; tree-transport reads via getExpectTreeSnap, clears via
// setExpectTreeSnap(false)). Mirrors the expectSessionSnap accessor seam below;
// audit §6c explicitly allows this accessor pattern for cross-module handshake
// flags.
export function getExpectTreeSnap(): boolean {
  return expectTreeSnap;
}
export function setExpectTreeSnap(v: boolean): void {
  expectTreeSnap = v;
}
// expectSessionSnap accessors — the flag STAYS here (paired with expectTreeSnap
// by reconcileBusy / maybeResolveReconcile), but the Stream2 snapshot listener
// (./session-stream) reads it for the busy-gate handshake and clears it when
// the expected fresh snapshot lands. Exposed as accessors so the mutation
// surface stays single-owner (only reconcileBusy's safety timer + this module
// write; session-stream reads via getExpectSessionSnap, clears via
// setExpectSessionSnap(false)). Audit §6c explicitly allows this accessor seam.
export function getExpectSessionSnap(): boolean {
  return expectSessionSnap;
}
export function setExpectSessionSnap(v: boolean): void {
  expectSessionSnap = v;
}
let reconcileResolve: (() => void) | null = null;
let reconcileTimer: number | undefined;

// maybeResolveReconcile — resolves the pending reconciliation promise once ALL
// expected snapshots have been applied (or were superseded by a stale-epoch
// discard). Called from the snapshot listeners after each expected frame lands.
// Exported because the Stream2 snapshot listener (./session-stream) calls it
// after applying the expected fresh session snapshot.
export function maybeResolveReconcile() {
  if (!expectTreeSnap && !expectSessionSnap && reconcileResolve) {
    const r = reconcileResolve;
    reconcileResolve = null;
    clearTimeout(reconcileTimer);
    r();
  }
}

// reconcileBusy — registered with busy.ts via setReconcileFn. Called on the
// outermost busy release. Requests ONE fresh tree snapshot (connect(true) drops
// the tree EventSource and reconnects with no cursor) and ONE fresh session
// snapshot for the selected session (openSessionStream drops + reconnects).
// Resolves once both expected snapshots have been applied, or a 15s safety
// timeout. If no session is selected, only the tree refresh is requested.
function reconcileBusy(): Promise<void> {
  return new Promise<void>((resolve) => {
    const sel = selectedId();
    reconcileResolve = resolve;
    expectTreeSnap = true;
    expectSessionSnap = !!sel;
    connect(true);
    // force=true so the selected session's Stream-2 EventSource is recreated
    // even when it's already healthy/open — the fresh snapshot this produces is
    // what clears expectSessionSnap and resolves reconciliation promptly.
    if (sel) openSessionStream(sel, true);
    // Safety: if the fresh snapshots don't arrive in 15s (e.g. the server is
    // unresponsive), clear the flags and resolve so the overlay doesn't wedge.
    clearTimeout(reconcileTimer);
    reconcileTimer = window.setTimeout(() => {
      expectTreeSnap = false;
      expectSessionSnap = false;
      maybeResolveReconcile();
    }, 15_000);
    // If there's nothing to wait for (shouldn't happen — expectTreeSnap is
    // always set — but defensive), resolve immediately.
    maybeResolveReconcile();
  });
}

// Register the reconciliation callback once at module load. reconcileBusy is a
// hoisted function declaration; connect (imported from ./tree-transport) +
// openSessionStream (imported from ./session-stream) are ESM live-bindings
// resolved by the time reconcileBusy actually runs (on the outermost busy
// release), so the reference captured here is valid. The stream ↔ tree-transport
// import cycle is TDZ-safe: setReconcileFn passes the function reference, it
// does not CALL connect at module-eval time.
setReconcileFn(reconcileBusy);
