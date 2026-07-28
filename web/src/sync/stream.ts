// The stream state-machine: consumes the daemon's resumable /vh/stream over two
// EventSources, reconciles the store, and keeps itself alive (heartbeat
// watchdog, backoff reconnect, foreground/online recovery). It owns transport
// and store reconciliation; notification policy lives in ./orchestration.
import { setState, selectedId } from "./store";
import { setReconcileFn } from "../busy";
// Pure async decode transforms live in ./decode (zero reactive state, zero
// generation tokens — the first stream.ts extraction boundary per the invariant
// audit §6a). Imported here for the internal callers (fetchSessionMessages /
// the Stream-1 + Stream-2 snapshot/batch listeners / expandTreeNode); the two
// public decoders are re-exported below to preserve the module's existing public
// API that unit tests import directly.
import { decodeMessagesBatch, decodeSnapshot } from "./decode";
export { decodeMessagesBatch, decodeSnapshot };
// Phase-4 historical-page (load-older) concern lives in ./history (the second
// extraction boundary per the invariant audit §6b: pageInFlight tracking, the
// GET /vh/session/{sid}/messages fetcher, the Contract-B response gate, the
// clean-response merge, resident-cache eviction, the narrow dirty-kind filter,
// and the pure deriveMessageWindow helper). Imported here for the internal
// callers (the reducers' deriveMessageWindow, the Stream-2 listener's
// isPageDirtyingKind/markPageDirty hook, closeSessionStream's + the reducers'
// resetPageInFlight); re-exported below to preserve the module's existing
// public API that unit tests + the sync.ts barrel + actions.ts import directly.
// The sesGen seam: history.ts reads the transport-owned sesGen via the
// getSesGen accessor declared near the sesGen declaration below.
import {
  deriveMessageWindow,
  resetPageInFlight,
  markPageDirty,
  isPageDirtyingKind,
  loadOlder,
  MAX_RESIDENT_MESSAGES,
  MAX_RESIDENT_BYTES,
} from "./history";
export {
  deriveMessageWindow,
  loadOlder,
  resetPageInFlight,
  markPageDirty,
  isPageDirtyingKind,
  MAX_RESIDENT_MESSAGES,
  MAX_RESIDENT_BYTES,
};
// The Stream 2 (active-session messages) lifecycle lives in ./session-stream
// (the third stream.ts extraction boundary per the invariant audit §6c): the
// session EventSource + its listeners, the sesGen connection-generation token,
// the sesCursor resume cursor, the in-flight snapshot/batch decode gates,
// Stream2's liveness clocks, applySessionSnapshot, and the open/close
// lifecycle. Imported here for the internal caller (reconcileBusy requests a
// fresh session snapshot via openSessionStream on the outermost busy release);
// re-exported below to preserve the module's existing public API that unit
// tests + the sync.ts barrel + actions.ts import directly. sesGen ownership
// MOVED to session-stream (it is bumped only by openSessionStream /
// closeSessionStream, both now resident there); getSesGen is re-exported here
// so the `stream.getSesGen()` test API + the history.ts accessor contract are
// preserved.
import {
  openSessionStream,
  closeSessionStream,
  applySessionSnapshot,
  getSesGen,
} from "./session-stream";
export {
  openSessionStream,
  closeSessionStream,
  applySessionSnapshot,
  getSesGen,
};
// Stream health decision-functions live in ./health (the fourth stream.ts
// extraction boundary per the invariant audit §6e): the coarse health tick,
// isStale (global connection-status indicator), watchdogTick (dual-clock
// dead-but-OPEN detector), maybeReconnect (foreground/online recovery entry),
// and resyncTree (on-focus + periodic drift self-heal). connect() now lives in
// ./tree-transport (it IS the Stream1 lifecycle owner, deeply coupled to the
// tree EventSource + the C4 coherent barrier — see the tree-transport re-export
// block below); health imports connect (re-exported through this facade from
// ./tree-transport) + read-only tree-clock / busy-gate accessors. Re-exported
// below to preserve the module's existing public API that unit tests + the
// sync.ts barrel import directly.
import {
  tickHealth,
  isStale,
  watchdogTick,
  maybeReconnect,
  resyncTree,
  TREE_RESYNC_MIN_GAP_MS,
  CONTENT_STALE_MS,
  _resetResyncGateForTest,
} from "./health";
export {
  tickHealth,
  isStale,
  watchdogTick,
  maybeReconnect,
  resyncTree,
  TREE_RESYNC_MIN_GAP_MS,
  CONTENT_STALE_MS,
  _resetResyncGateForTest,
};
// The Stream 1 (tree) transport + C4 coherent-capture barrier live in
// ./tree-transport (the fifth + final stream.ts extraction boundary per the
// invariant audit §6d and the stream-c4 solution-brief): the tree EventSource
// ownership, the treeGen connection-generation token + every authoritative bump
// site, the PendingCaptureOwner coherent-capture atomicity barrier (tree/detail/
// snapshot.complete staging + single-batch coherent installation), connect() (the
// Stream 1 lifecycle owner + ALL Stream 1 listener registration), the onopen +
// fatal-onerror handlers, the tree-related gzip64 decode gates, Stream 1's
// liveness clocks (treeLastSeen/treeContentSeen + their mark* helpers), Stream 1's
// CLOSED-reconnect backoff, the treeGen-aware periodic-resync attribution, and
// the C4-aware expandTreeNode (+ ownerAwareApply, the point-HTTP expansion
// deferral). The two parallel C4 deferral paths — ownerAwareApply + coveredAwait
// — are one indivisible invariant (the single-await ordering proof, audit §5d#7)
// and moved TOGETHER; neither can be split back out without re-introducing the
// B-F1/B-F2 data-loss race (a late wholesale seedTreeStore clobbering a covered
// handler's just-applied reducer). Imported here for the internal callers
// (reconcileBusy requests a fresh tree snapshot via connect(true) on the
// outermost busy release; the periodic-resync gates + attribution now live in
// ./periodic-resync, which imports these tree-transport symbols directly);
// re-exported below to preserve the module's existing public API that unit
// tests (the namespace `await import("../../src/sync/stream")` C4 suite —
// coherentBarrier / coveredAwait / stream1Backoff / expandTreeNodeC4 /
// streamIntegration / coherentBarrierReloadRace — + streamRegistration /
// resyncTree / periodicResync / streamFrameMalformed) + the sync.ts barrel +
// actions.ts + ./health import directly. treeGen ownership MOVED to
// tree-transport (it is bumped only by connect / Stream 1's onerror, both now
// resident there); getTreeGen is re-exported here for the existing `stream.*`
// test API (./periodic-resync imports getTreeGen directly from ./tree-transport
// for periodicResyncTick's attribution). The C4 barrier's busy-gate handshake
// STAYS here, paired with expectSessionSnap by reconcileBusy; tree-transport
// peeks/pokes it via getExpectTreeSnap / setExpectTreeSnap (mirrors the
// established expectSessionSnap accessor seam).
import {
  connect,
  expandTreeNode,
  getTreeLastSeen,
  getTreeContentSeen,
  isTreeClosed,
  isTreeSnapshotDecoding,
  getTreeSnapshotDecode,
  getTreeGen,
  applyTreeFrame,
  TREE_STREAM_KINDS,
  _markTreeSeenForTest,
} from "./tree-transport";
export {
  connect,
  expandTreeNode,
  getTreeLastSeen,
  getTreeContentSeen,
  isTreeClosed,
  isTreeSnapshotDecoding,
  getTreeSnapshotDecode,
  getTreeGen,
  applyTreeFrame,
  TREE_STREAM_KINDS,
  _markTreeSeenForTest,
};

// The store reducers live in ./reducers (the reducer-layer extraction boundary
// per the stream-facade decomposition study: applySnapshot / applySessionEvent /
// pruneSessionDeleted / applyMessageEvent + the pure helpers mergeLastAgents /
// epochChanged + the anti-spam "updating" indicator UPDATING_DEBOUNCE_MS /
// isUpdating / bumpUpdating). tree-transport.ts and session-stream.ts import them
// from this facade today (the reverse-dependency edge); re-exported here to
// preserve the module's existing public API that unit tests + the sync.ts barrel
// + actions.ts import directly. All calls remain SYNCHRONOUS — no adapter await,
// promise hop, or reactive mirror. The session-stream → reducers → history →
// session-stream cycle is TDZ-safe (runtime calls only, no top-level reads).
import {
  mergeLastAgents,
  epochChanged,
  applySnapshot,
  applySessionEvent,
  pruneSessionDeleted,
  applyMessageEvent,
  isUpdating,
  UPDATING_DEBOUNCE_MS,
} from "./reducers";
export {
  mergeLastAgents,
  epochChanged,
  applySnapshot,
  applySessionEvent,
  pruneSessionDeleted,
  applyMessageEvent,
  isUpdating,
  UPDATING_DEBOUNCE_MS,
};

// The warm-tree-reconnect message refresh lives in ./refresh (region 4 of the
// stream-facade decomposition study, the refresh-machinery extraction boundary):
// fetchSessionMessages (the gzip64 full-transcript snapshot puller for a single
// session — internal to ./refresh, never part of the public surface),
// REFRESH_CONCURRENCY (the tunnel-pressure cap), runWithConcurrency (the
// bounded-fan-out runner with per-item fault isolation), and refreshOpenSessions
// (the entry point that fans the puller out across every open non-active
// session on a tree reconnect). The sole caller of refreshOpenSessions is
// tree-transport.ts (after a tree reconnect: `void refreshOpenSessions()`),
// which imports it from this facade today; re-exported below to preserve the
// module's existing public API that unit tests (refreshOpenSessions.test.ts +
// messageWindow.test.ts) import directly. Same re-export-shim pattern as the
// decode / history / session-stream / health / tree-transport / reducers /
// periodic-resync extractions (consumers stay on the facade; shim removal is a
// deferred follow-up per the study's Region 1).
import {
  refreshOpenSessions,
  runWithConcurrency,
  REFRESH_CONCURRENCY,
} from "./refresh";
export {
  refreshOpenSessions,
  runWithConcurrency,
  REFRESH_CONCURRENCY,
};

// → Stream 1 transport state (es / treeLastSeen / treeContentSeen / reconnectTimer / backoff / everOpened) moved to ./tree-transport.
export const STALE_MS = 45_000; // ~3 missed 15s pings → assume the stream is dead
// CONTENT_STALE_MS, healthNow/setHealthNow, tickHealth, and isStale moved to
// ./health (the Stream2 content-stall threshold is consumed only by
// watchdogTick; the coarse health tick + isStale are the health module's
// public surface). STALE_MS stays here — it is shared by ./periodic-resync's
// periodicResyncShouldRun AND imported by ./health for the watchdog's
// transport-stale branch.
// → Stream 1 liveness accessors + markTreeSeen / markTreeTransportSeen / maybeMirrorLastSeen moved to ./tree-transport.

// → advanceCursor + applyTreeFrame (Stream 1 cursor/frame helpers) moved to ./tree-transport.
// → Stream 1 header + L1 latency comment moved to ./tree-transport (with connect).
export function recordLatency(stream: "tree" | "session", phase: "open" | "snap", ms: number): void {
  setState("connLatency", stream, phase, Math.max(0, Math.round(ms)));
}
// → treeT0/treeT1/treeSnapDone + treeGen + treeSnapshotDecode/Decoding + the entire C4 PendingCaptureOwner barrier (pendingOwner, makeOwner, releaseOwner, bindOwnerIdentity, cancelPendingOwner, markOwnerLegacy, ensureOwner, coveredAwait, applyDetailIndependent, applyTreeIndependent, tryInstall) moved to ./tree-transport.
// Stream2 timing state (sesT0, sesT1, sesSnapDone, sesFirstSnap, sesHydrating,
// pendingBatch, sesSnapshotDecode, sesSnapshotDecoding) moved to
// ./session-stream with the Stream2 lifecycle that owns them.

// → TREE_STREAM_KINDS moved to ./tree-transport (re-exported below).
// --- Global busy-scope gate (archive/unarchive) -----------------------------
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
// flags. Added when the C4 barrier + tree transport moved to ./tree-transport
// (previously all readers/writers were in this module, so no accessor was
// needed).
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

// → isTreeSnapshotDecoding / getTreeSnapshotDecode moved to ./tree-transport (re-exported below).
// → connect() + all Stream 1 listeners (snapshot / tree.snapshot / tree.op / snapshot.complete / pins.* / ping / session.upsert+delete / TREE_STREAM_KINDS / notice / onopen / onerror) moved to ./tree-transport (re-exported below).
// === Stream 2: active-session messages ====================================
// The Stream 2 lifecycle (ses, sesId, sesRetry, sesBackoff, sesCursor, sesGen,
// getSesGen, closeSessionStream, applySessionSnapshot, openSessionStream + all
// Stream2 EventSource listeners) moved to ./session-stream per the invariant
// audit §6c. Re-exported above (openSessionStream / closeSessionStream /
// applySessionSnapshot / getSesGen) to preserve the module's public API.

// watchdogTick / maybeReconnect moved to ./health per the invariant audit
// §6e. Re-exported above (watchdogTick / maybeReconnect) to preserve the
// module's public API.

// resyncTree + TREE_RESYNC_MIN_GAP_MS + lastTreeResync moved to ./health per
// the invariant audit §6e. Re-exported above (resyncTree /
// TREE_RESYNC_MIN_GAP_MS) to preserve the module's public API.
//
// The Q6 conditional periodic-resync machinery lives in ./periodic-resync
// (the periodic-resync extraction boundary per the stream-facade decomposition
// study, Region 6): the periodic tunables (TREE_RESYNC_PERIODIC_INTERVAL_MS /
// TREE_RESYNC_PERIODIC_JITTER_MS), lastAuthoritativeRecovery + periodicTimer /
// periodicStarted state, markAuthoritativeRecovery, schedulePeriodicResync,
// periodicResyncShouldRun, treeFingerprint, periodicResyncTick,
// startPeriodicResync, resolvePeriodicDiff, the periodic diff instrumentation,
// and the test accessors. health.ts imports markAuthoritativeRecovery;
// tree-transport.ts imports markAuthoritativeRecovery + resolvePeriodicDiff
// (the C4 install path calls resolvePeriodicDiff after seedTreeStore, and
// snapshot.complete calls markAuthoritativeRecovery); startPeriodicResync is
// called once from startSync. Re-exported here to preserve the module's
// existing public API that unit tests (periodicResync.test.ts) + the sync.ts
// barrel import directly — same re-export-shim pattern as the reducers
// extraction (consumers stay on the facade; shim removal is a deferred follow-
// up per the study's Region 1). The periodic machinery reads the busy-gate
// flags (expectTreeSnap / expectSessionSnap, which STAY here in Region 5) via
// the getExpectTreeSnap / getExpectSessionSnap accessors (declared above), and
// reads STALE_MS (which also stays here — shared with ./health) via the
// same-module binding. The stream ↔ periodic-resync import cycle is TDZ-safe
// (runtime calls only, no top-level reads — mirrors the established stream ↔
// tree-transport / stream ↔ session-stream cycle discipline).
import {
  TREE_RESYNC_PERIODIC_INTERVAL_MS,
  TREE_RESYNC_PERIODIC_JITTER_MS,
  markAuthoritativeRecovery,
  periodicResyncShouldRun,
  startPeriodicResync,
  resolvePeriodicDiff,
  _resetPeriodicStateForTest,
  _setLastAuthoritativeRecoveryForTest,
  _getPeriodicResyncStatsForTest,
} from "./periodic-resync";
export {
  TREE_RESYNC_PERIODIC_INTERVAL_MS,
  TREE_RESYNC_PERIODIC_JITTER_MS,
  markAuthoritativeRecovery,
  periodicResyncShouldRun,
  startPeriodicResync,
  resolvePeriodicDiff,
  _resetPeriodicStateForTest,
  _setLastAuthoritativeRecoveryForTest,
  _getPeriodicResyncStatsForTest,
};

// → expandTreeNode (+ ownerAwareApply, the C4 point-HTTP expansion deferral) moved to ./tree-transport (re-exported below).
