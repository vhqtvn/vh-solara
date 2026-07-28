// The stream state-machine: consumes the daemon's resumable /vh/stream over two
// EventSources, reconciles the store, and keeps itself alive (heartbeat
// watchdog, backoff reconnect, foreground/online recovery). It owns transport
// and store reconciliation; notification policy lives in ./orchestration.
import type { MessageWindowMeta, Snapshot } from "../types";
import { buildMessages } from "../lib/reduce";
import { log } from "../lib/log";
import { state, setState, projectDir, selectedId } from "./store";
import { isGateActive, setReconcileFn } from "../busy";
import { treeMap } from "./treeState";
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
// outermost busy release; periodicResyncShouldRun / periodicResyncTick peek tree
// transport state for the periodic-resync gates + attribution); re-exported
// below to preserve the module's existing public API that unit tests (the
// namespace `await import("../../src/sync/stream")` C4 suite — coherentBarrier /
// coveredAwait / stream1Backoff / expandTreeNodeC4 / streamIntegration /
// coherentBarrierReloadRace — + streamRegistration / resyncTree / periodicResync
// / streamFrameMalformed) + the sync.ts barrel + actions.ts + ./health import
// directly. treeGen ownership MOVED to tree-transport (it is bumped only by
// connect / Stream 1's onerror, both now resident there); getTreeGen is
// re-exported here so periodicResyncTick's attribution + the existing `stream.*`
// test API are preserved. The C4 barrier's busy-gate handshake (expectTreeSnap)
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

async function fetchSessionMessages(
  id: string,
): Promise<{ items: any[]; window?: MessageWindowMeta }> {
  // z=1 opts into gzip64 snapshot encoding (server maybeCompressSnapshot) so the
  // full transcript ships compressed through the controller tunnel — the same
  // win as the Stream-2 snapshot. refreshOpenSessions fans one of these out per
  // open session on a tree reconnect, so without it each pull ships a full
  // uncompressed transcript and they contend the tunnel. decodeSnapshot is a
  // pass-through when the response carries no `encoding` (old server / small
  // snapshot under the threshold), so an old server keeps working.
  //
  // Phase 3: also surface snap.messageWindows?.[id] (Phase-1 server-side
  // bounded projection meta) so refreshOpenSessions can populate the resident
  // window state alongside the messages — without it the warm-refresh path
  // would lose hasOlder/oldestResidentID and the Phase-4 "Load older" button
  // would never appear after a tree reconnect.
  const res = await fetch(
    `/vh/snapshot?sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}&z=1`,
  );
  const snap: Snapshot = await decodeSnapshot<Snapshot>(await res.json());
  return { items: (snap.messages?.[id] as any[]) || [], window: snap.messageWindows?.[id] };
}

// Bounds tunnel pressure from the warm-open refresh fan-out. Each open session
// triggers a full-transcript /vh/snapshot pull, and firing all N at once (the
// original Promise.all) contends the single yamux-over-WebSocket tunnel —
// head-of-line / bandwidth contention inflates each warm open's latency into
// seconds at large N. Server compute is sub-20ms (measured); the latency is
// transport. Capping concurrency keeps the tunnel from saturating so individual
// pulls complete faster. The knee (concurrency vs throughput) is inferred, not
// measured — the operator-side acceptance signal is before/after `snap` ms in
// ServersPanel under a large-N warm reconnect.
export const REFRESH_CONCURRENCY = 3;

// runWithConcurrency — bounded-fan-out runner with per-item fault isolation, no
// external dependency. Processes `items` with at most `limit` calls to `fn`
// in flight at once. A rejection from one item does NOT abort its siblings: the
// worker catches each item's rejection in isolation and keeps pulling the next,
// so every item is attempted and the returned promise always resolves (matches
// refreshOpenSessions' per-session try/catch tolerance). `limit` is clamped to
// [1, items.length]. Exported for unit testing.
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const i = cursor++;
      try {
        await fn(queue[i]);
      } catch {
        /* isolated — one item's failure does not abort its siblings */
      }
    }
  };
  const n = Math.max(1, Math.min(limit, queue.length));
  await Promise.all(Array.from({ length: n }, worker));
}

// On a tree-stream resync, refresh cached message state for NON-active opened
// sessions (the active one is owned by the live session stream, so skip it to
// avoid clobbering streamed deltas). Dispatched with BOUNDED concurrency: an
// operator with N open sessions has N full-transcript /vh/snapshot pulls to
// re-issue on every tree reconnect, but firing all N at once saturates the
// controller tunnel (see REFRESH_CONCURRENCY). The inner try/catch keeps the
// per-session error isolation (one failed fetch keeps stale + does NOT starve
// the batch, so the other sessions still refresh).
// Exported for unit testing (tests/unit/refreshOpenSessions.test.ts).
export async function refreshOpenSessions() {
  const active = selectedId();
  await runWithConcurrency(Object.keys(state.messages), REFRESH_CONCURRENCY, async (id) => {
    if (id === active) return;
    try {
      const { items, window } = await fetchSessionMessages(id);
      setState("messages", id, buildMessages(items));
      setState("messagesLoaded", id, true);
      // Phase 3: populate the resident-window state alongside the messages so
      // the Phase-4 "Load older" affordance works after a tree reconnect (not
      // just after the cold-load batch / a Stream-2 snapshot). Mirrors what
      // applySessionSnapshot does on the warm path.
      setState("messageWindows", id, deriveMessageWindow(items, window));
    } catch {
      /* keep stale; reopening re-snapshots */
    }
  });
}

// → Stream 1 transport state (es / treeLastSeen / treeContentSeen / reconnectTimer / backoff / everOpened) moved to ./tree-transport.
export const STALE_MS = 45_000; // ~3 missed 15s pings → assume the stream is dead
// CONTENT_STALE_MS, healthNow/setHealthNow, tickHealth, and isStale moved to
// ./health (the Stream2 content-stall threshold is consumed only by
// watchdogTick; the coarse health tick + isStale are the health module's
// public surface). STALE_MS stays here — it is shared by periodicResyncShouldRun
// (below) AND imported by ./health for the watchdog's transport-stale branch.
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
// TREE_RESYNC_MIN_GAP_MS) to preserve the module's public API. The periodic
// tunables below STAY — they are consumed by the periodic-resync machinery
// (schedulePeriodicResync / periodicResyncShouldRun) that remains in this
// module.
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
  if (expectTreeSnap || expectSessionSnap) return false;
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

// → expandTreeNode (+ ownerAwareApply, the C4 point-HTTP expansion deferral) moved to ./tree-transport (re-exported below).
