// The Stream 1 (tree) transport + C4 coherent-capture barrier, extracted from
// ./stream per the invariant audit §6d and the stream-c4 solution-brief. Owns
// the tree EventSource (creation/close/replacement), the treeGen connection-
// generation token and every authoritative bump site, the PendingCaptureOwner
// coherent-capture atomicity barrier (tree/detail/snapshot.complete staging +
// single-batch coherent installation), connect() (the Stream 1 lifecycle owner
// + ALL Stream 1 listener registration), the onopen + fatal-onerror handlers,
// the tree-related gzip64 decode gates, Stream 1's liveness clocks
// (treeLastSeen/treeContentSeen + their mark* helpers), Stream 1's CLOSED-
// reconnect backoff, the treeGen-aware periodic-resync attribution, the C4-aware
// expandTreeNode (point-HTTP expansion deferral), AND the two parallel C4
// deferral paths: ownerAwareApply (expandTreeNode) + coveredAwait (covered
// Stream 1 live handlers). These two paths are one indivisible invariant — the
// single-await ordering proof — and move together.
//
// Cross-module seams (deliberate, minimal — typed SYNCHRONOUS callbacks):
//   - applySnapshot           — detail projection reducer (from ./reducers)
//   - applySessionEvent       — session structural-event reducer (from ./reducers)
//   - applyMessageEvent       — message/part/activity/perm/q reducer (from ./reducers)
//   - refreshOpenSessions     — warm-tree-reconnect message refresh (from ./refresh)
//   - recordLatency           — shared tree+session L1 stamp helper (from ./stream)
//   - getExpectTreeSnap / setExpectTreeSnap / maybeResolveReconcile
//                              — the busy-gate "expected tree snapshot" handshake
//                                (from ./stream; the flag STAYS in ./stream,
//                                paired with expectSessionSnap by reconcileBusy;
//                                this module peeks/pokes it through accessors so
//                                the handshake stays a single-owner mutation
//                                surface — mirrors the established
//                                expectSessionSnap seam)
//   - markAuthoritativeRecovery / resolvePeriodicDiff
//                              — periodic-resync attribution (from
//                                ./periodic-resync; this module reports the
//                                coherent-install + tree-apply boundary)
//
// treeGen ownership decision: treeGen MOVES here. It was bumped only by connect()
// (now here) and Stream 1's onerror (now here); leaving it in ./stream would
// make the facade the nominal owner of a token it never bumps (misleading). The
// bump-before-close ordering (audit §3a: treeGen++ MUST precede es.close()) and
// the C-F2 onerror-bumps-treeGen-BEFORE-cancelPendingOwner ordering are preserved
// verbatim in both sites. ./stream reads treeGen via getTreeGen() (periodic
// resync attribution); ./health does not read treeGen.
//
// CRITICAL — single-await ordering invariant (audit §5d#7, stream.ts:1229-1230):
// tree-transport may await its owner.promise EXACTLY ONCE. After the post-await
// treeGen recheck, every cross-file callback call (applySnapshot /
// applySessionEvent / applyMessageEvent / refreshOpenSessions) must remain
// SYNCHRONOUS — no adapter await, no promise hop, no microtask, no reactive
// mirror. This is the release-burst FIFO ordering proof. Adding a second await
// between the gen recheck and the reducer breaks it.
//
// No top-level side effects: only `let` / `const` / function declarations. The
// stream ↔ tree-transport import cycle (stream imports connect etc. from tree-
// transport; tree-transport imports recordLatency + the expectTreeSnap
// accessors from stream) is TDZ-safe — every cross-module read happens inside
// listener/C4/reducer bodies at runtime, never at module-eval time. (The
// reducers/refresh/periodic-resync symbols this module also consumes are
// imported directly from their owning siblings and are not part of that cycle.)
// The only top-level side effect in ./stream (setReconcileFn(reconcileBusy))
// passes a hoisted function reference; it does not call connect at eval time.
import { batch } from "solid-js";
import type { Snapshot } from "../types";
import { checkVersionNow } from "../pwa";
import { handleNotice } from "../alerts";
import { log } from "../lib/log";
import { state, setState, projectDir, persist } from "./store";
import { isGateActive, markBusyDirty } from "../busy";
import {
  decodeTreeSnapshot,
  decodeTreeOp,
  fetchChildren,
  type TreeFetcher,
  type ChildrenResponse,
  type TreeSnapshot,
} from "./treeOps";
import { seedTreeStore, applyTreeOpStore, expandedButUnloadedIds } from "./treeState";
import type { TreeOp, TreeNode } from "./treeMap";
import { applyPinsSnapshot, applyPinsUpdated } from "../pins";
import { applyLabelsSnapshot, applyLabelsUpdated } from "../labels";
import { decodeSnapshot } from "./decode";
import { applySnapshot, applyScopedSnapshot, applySessionEvent, applyMessageEvent } from "./reconcile";
import { refreshOpenSessions } from "./refresh";
import {
  markAuthoritativeRecovery,
  resolvePeriodicDiff,
} from "./periodic-resync";
import {
  recordLatency,
  getExpectTreeSnap,
  setExpectTreeSnap,
  maybeResolveReconcile,
} from "./stream";
import { captureDiagEntry } from "./diaglog";

// Parse a compound SSE id ("globalSeq.ordinal") or legacy numeric id.
// O3: the ordinal is a per-connection delivery counter for Inv1 gap detection;
// the global seq is for cursor/resume bookkeeping. Legacy (no dot) → ordinal 0.
function parseSSEID(id: string): { globalSeq: number; ordinal: number } {
  const dot = id.indexOf(".");
  if (dot < 0) return { globalSeq: Number(id), ordinal: 0 };
  return {
    globalSeq: Number(id.slice(0, dot)),
    ordinal: Number(id.slice(dot + 1)),
  };
}

let es: EventSource | null = null;
// Two INDEPENDENT liveness clocks — the dead-but-OPEN Stream2 bug (a frozen
// transcript with the `updating` pulse lit and no reconnect) came from a single
// shared `lastSeen` that Stream1's 15s server ping kept fresh forever, so the
// watchdog's `Date.now() - lastSeen > STALE_MS` could NEVER age out for a dead
// Stream2 while the tree was healthy. Each stream now owns its own clock and the
// watchdog evaluates each independently.
//   treeLastSeen    — Stream1 (tree: sessions/activity/permissions/...). Backs
//                     the global `isStale()` indicator (the status dot = global
//                     connection health) and the tree-stream watchdog branch.
//   sessionLastSeen — Stream2 (active-session messages). Drives the Stream2
//                     stale-but-OPEN watchdog branch → forced fresh-snapshot
//                     reconnect. 0 = "never seen / just reset" → treated as
//                     not-stale (like the old code's `lastSeen > 0` guard), so a
//                     not-yet-open or just-reconnected Stream2 gets a fresh
//                     deadline instead of inheriting a stale timestamp.
let treeLastSeen = 0;
// Content-vs-transport split for Stream1 liveness (the Stream1 mirror of Lane
// C's Stream2 fix — the deferred half called out in Lane C's DESIGN DEBATE).
// treeLastSeen above is refreshed by BOTH the 15s server ping AND content
// events, so a dead-but-OPEN Stream1 whose transport stays alive (pings flow)
// but delivers ZERO content keeps treeLastSeen fresh forever — the watchdog's
// tree branch never trips and the operator-visible symptom (a completed
// subsession sticking "running" until reload — the stuck-running-node gap) sits
// with no recovery signal. treeContentSeen closes that gap: refreshed ONLY by
// genuine Stream1 content (snapshot / tree.snapshot / tree.op / snapshot.complete
// / pins.* / session.upsert+delete / TREE_STREAM_KINDS / notice / onopen), NEVER
// by ping. The watchdog's tree branch (./health) reconnects when EITHER clock
// ages out. See CONTENT_STALE_MS (in ./health) for the threshold rationale.
//
// THRESHOLD: reuses CONTENT_STALE_MS=120s (NO tree-specific threshold). The
// tree's normal content cadence is HIGHER than Stream2's — tree.snapshot +
// tree.op + session.upsert + activity.* flow frequently, AND runStatusReconcile
// (SR60) emits a fresh tree content event every ≤60s as a server-side backstop —
// so 120s is, if anything, MORE conservative for the tree: a genuine 120s
// tree-content gap means the live stream AND the SR60 backstop BOTH failed.
// 120s also keeps every existing tree-liveness test contract green (the longest
// ping-only content-silence window in sessionLiveness.test.ts is Gate H's 92s,
// comfortably under the threshold). See the Lane C packet.
let treeContentSeen = 0;
// sessionLastSeen / sessionContentSeen + the content-vs-transport split
// rationale moved to ./session-stream (Stream2 owns its own clocks). The
// dual-clock design comment above still documents WHY the tree clock is
// independent; the session clock's lifecycle is now in its home module.
let reconnectTimer: number | undefined;
let backoff = 1000; // grows on repeated failures, reset on a healthy open
let everOpened = false; // first stream open is the initial load; later opens are reconnects

// Read-only accessors for the tree clock + tree transport state (consumed by
// ./health's watchdogTick / maybeReconnect / resyncTree / isStale): each
// stream's clock + transport STATE stays with its lifecycle owner; health only
// peeks.
export function getTreeLastSeen(): number {
  return treeLastSeen;
}
// Content-clock accessor for ./health's watchdogTick tree branch (the Stream1
// mirror of getSessionContentSeen). Read-only peek; health never mutates the
// tree lifecycle — it only decides when to (re)connect and delegates to
// connect().
export function getTreeContentSeen(): number {
  return treeContentSeen;
}
export function isTreeClosed(): boolean {
  return !es || es.readyState === EventSource.CLOSED;
}
// lastSeenStateWritten throttles the mirror into the reactive store: the mark*
// helpers fire on every SSE byte, but writing state.lastSeen that often would
// notify the debug surfaces per-token. Bound it to ~1 write/sec. The mirror now
// tracks treeLastSeen (the value the global status dot represents); it is a
// debug-only field — isStale() reads the unthrottled module var, not state.
let lastSeenStateWritten = 0;
// markTreeSeen updates Stream1's liveness clocks: BOTH the transport clock
// (treeLastSeen) AND the content clock (treeContentSeen), plus (throttled) the
// reactive mirror consumed by debug surfaces. Called from every Stream1 CONTENT
// listener (snapshot / tree.snapshot / tree.op / snapshot.complete / pins.* /
// session.upsert+delete / TREE_STREAM_KINDS / notice), es.onopen, and the
// connect() construction seed. The ping listener calls markTreeTransportSeen
// instead (transport only) so a content-stall ages out treeContentSeen even
// while pings keep treeLastSeen fresh. This is the Stream1 mirror of Lane C's
// Stream2 markSessionSeen split.
function markTreeSeen() {
  const now = Date.now();
  treeLastSeen = now;
  treeContentSeen = now;
  maybeMirrorLastSeen(now);
}
// markTreeTransportSeen refreshes the transport clock ONLY (the 15s server
// ping) plus (throttled) the debug mirror — the global status dot represents
// GLOBAL transport health, so a ping still refreshes it. It deliberately does
// NOT touch treeContentSeen, so a ping-only stream (transport alive, zero
// content) lets the content clock age out and the watchdog reconnects via the
// tree content-stall branch. The Stream1 mirror of Lane C's
// markSessionTransportSeen.
function markTreeTransportSeen() {
  const now = Date.now();
  treeLastSeen = now;
  maybeMirrorLastSeen(now);
}
// maybeMirrorLastSeen throttles the treeLastSeen mirror into the reactive store
// to ~1 write/sec (the mark* helpers fire on every SSE byte, but writing
// state.lastSeen that often would notify debug surfaces per-token). Shared by
// both mark* helpers so transport AND content events keep the debug field fresh
// without duplicating the throttle.
function maybeMirrorLastSeen(now: number) {
  if (now - lastSeenStateWritten >= 1000) {
    lastSeenStateWritten = now;
    setState("lastSeen", now);
  }
}
// markSessionSeen / markSessionTransportSeen moved to ./session-stream (Stream2
// owns its own transport + content clocks; the watchdog in ./health peeks them
// via getSessionLastSeen / getSessionContentSeen).

// advanceCursor — cursor-only path for deferred Stream-1 frames during a global
// busy scope. applySnapshot/applySessionEvent/applyMessageEvent couple cursor
// advancement with store mutation; this extracts just the cursor+persist so the
// resume point stays current while the store is left untouched. The gate then
// latches dirty (if reconciling) so the final coalesced refresh catches up.
function advanceCursor(seq: number) {
  if (seq) {
    setState("cursor", seq);
    persist();
  }
}

// applyTreeFrame — hardens a Stream-1 (tree) event frame against a malformed
// MessageEvent.data payload. Parses raw, and on a malformed parse advances the
// resume cursor (so a permanently-bad frame the server keeps resending from the
// saved cursor can't wedge reconnect in an infinite replay loop) then returns
// WITHOUT mutating the store. On a well-formed parse it dispatches to the
// supplied apply fn, which advances the cursor itself (applySessionEvent /
// applyMessageEvent via trackCursor). The gate-active early-return
// (advanceCursor + markBusyDirty) stays in the listener — this only owns the
// parse + the malformed-cursor contract. Exported so the malformed-frame
// no-throw + cursor-advance contract is unit-testable without an EventSource,
// mirroring the applySessionSnapshot extraction precedent.
export function applyTreeFrame(
  kind: string,
  seq: number,
  raw: string,
  apply: (kind: string, seq: number, payload: any) => void,
) {
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    log.warn("sync", "malformed tree frame", { kind, seq, err });
    // Account for the RECEIVED frame so resume skips it — a malformed frame will
    // always be malformed, so replaying it on reconnect (the server resends
    // events with seq > cursor) would throw forever. Mirrors the gate-active
    // path's advanceCursor(seq) at the listener call sites.
    advanceCursor(seq);
    return;
  }
  apply(kind, seq, payload);
}


// === Stream 1: tree + notifications (persistent) ============================
// Structural (session/activity/status) + notification (permission/question)
// events for ALL sessions. The server omits message/part events here
// (sessions=""), so a busy project's background token-delta flood never delays
// these important events. Resumable via cursor; watchdog + backoff guarded.
//
// `fresh` forces a full snapshot (no cursor) instead of resuming. Used on a page
// load / project switch, where in-memory state was just hydrated from
// localStorage and is INCOMPLETE — only sessions+activity are persisted, not
// pending permissions/questions/unread. Resuming from the saved cursor would
// replay only events AFTER it, so any state established before the cursor (a
// busy activity, a pending permission/question) would be invisible. A snapshot
// reconciles all current state authoritatively. Transient in-page reconnects
// (watchdog/onerror/visibility) resume normally: in-memory state is intact, and
// the server falls back to a snapshot itself if the gap exceeds its ring buffer.
// --- Feature 3: connection-vs-first-snapshot latency diagnostic (L1, FE-only) -
// Purely additive instrumentation (zero server change). For each stream we
// capture performance.now() stamps and derive deltas:
//   open    = onopen − EventSource construction      (pure connection latency)
//   snap    = first snapshot FRAME − onopen          (end-to-end: server compute + serialize +
//                                                      tunnel transport of the payload through
//                                                      the controller; under refreshOpenSessions
//                                                      fan-out the transport dominates, NOT
//                                                      server compute). The snapshot payload is
//                                                      gzip64-compressed when large (a warm open
//                                                      of a loaded session inlines the whole
//                                                      transcript) — `snap` measures transport of
//                                                      the COMPRESSED size, which is the win this
//                                                      surfaces. Stamped on frame ARRIVAL, before
//                                                      the client-side decode, so it stays a pure
//                                                      transport signal (decode is ms-scale CPU).
//   hydrate = messages.loaded arrival − first snapshot   [SESSION STREAM ONLY]
//                                                      (upstream full-fetch wait —
//                                                      the gap `snap` misses on a
//                                                      cold session: the snapshot
//                                                      ships instantly with
//                                                      gate.messagesLoaded=false,
//                                                      then the daemon fetches the
//                                                      full history async; the
//                                                      client reveal gate holds
//                                                      until messages.loaded)
// The first snapshot per connection bounds `snap`; later snapshots are normal
// deltas and aren't timed. `hydrate` records once per connection (only on a
// cold first snapshot); a warm first snapshot (gate.messagesLoaded!==false) is
// stamped "warm" since messages.loaded never arrives for it. Surfaces in
// ServersPanel as "conn Xms · snap Yms · hydrate (Yms|warm|…)" so an operator
// can tell a slow connection from a slow first-snapshot (server compute + tunnel
// transport) from a slow upstream fetch.
// recordLatency is the shared tree+session L1 stamp helper. Exported because
// the session-stream listeners (./session-stream) call it; the tree listeners
// below call it directly. recordSessionHydrate / recordSessionFetchSplit (the
// session-only union stamps) moved to ./session-stream with their callers.

// Per-connection stamps/flags. Reset on each (re)open; snap recorded once.
let treeT0 = 0;
let treeT1 = 0;
let treeSnapDone = false;
// treeGen is the tree-stream connection generation. Bumped at every connect()
// so an async gzip64 snapshot decode captured by a PRIOR (now-closed)
// connection can detect it was superseded and refuse to mutate the store.
// Mirrors Stream 2's sesGen: a sync listener is naturally bounded by es.close()
// (pending events are dropped), but the gzip64 snapshot decode AWAITs, so the
// close can land mid-decode. The captured `gen` is checked at listener entry
// and again after the await. Without this, a stale decode from a superseded
// connection would clobber the replacement's fresh state with a stale snapshot.
let treeGen = 0;
// treeLastDeliveryOrdinal — O3: per-stream DELIVERY ORDINAL for Inv1 gap
// detection. The server stamps each tree-relevant wire event with a compound SSE
// id ("globalSeq.ordinal"); the ordinal is a per-connection counter that
// increments ONLY for tree-relevant logical source events (tree.op + session.*
// + TREE_STREAM_KINDS detail frames — NOT snapshots). A gap in this ordinal is
// DIRECTLY actionable as real loss → connect(true). This REMOVES the cross-stream
// covering check (the false-positive source when Stream2 lags). Reset in
// connect() so a fresh connection starts with no gap baseline. Initialized to -1
// so the first event (ordinal 0) doesn't trigger a false gap.
let treeLastDeliveryOrdinal = -1;
// treeDropNextN — test-only hook. When > 0, the next N events on the
// TREE_STREAM_KINDS listener loop are silently dropped BEFORE markTreeSeen/
// reconcile, simulating "events lost below SSE but the connection stays OPEN."
// Only armed by _setTreeDropNextNForTest from vitest.
let treeDropNextN = 0;
// In-flight gzip64 snapshot decode for the CURRENT tree connection. A warm
// tree snapshot ships compressed (server maybeCompressSnapshot when z=1); the
// decode is ASYNC (native DecompressionStream). applySnapshot
// WHOLESALE-REPLACES state.sessions AND unconditionally sets
// state.cursor=snap.seq, so a session.upsert/session.delete/TREE_STREAM_KINDS
// frame landing in the decode window would have its store mutation clobbered
// AND the cursor REGRESSED from the live event's higher seq back to the
// snapshot's seq when the stale-but-now-decoded snapshot lands.
//
// C4 (O1-R1): this loose gate is REPLACED for the tree.snapshot coherent path
// by the generation-owned PendingCaptureOwner (below). treeSnapshotDecoding now
// gates ONLY the independent detail-snapshot gzip64 path (rare: the server ships
// the detail snapshot RAW in tree=2 per pkg/web/tree_detail_test.go:221; this
// path is defensive for proj=1 / older servers where the detail snapshot can
// arrive gzip64 with no coherent owner). Covered live handlers await the OWNER
// first (coveredAwait); only when no coherent owner is pending do they fall
// back to this decode gate.
let treeSnapshotDecode: Promise<void> = Promise.resolve();
let treeSnapshotDecoding = false;

// ============================================================================
// C4 — O1-R1: generation-owned coherent-baseline barrier (PendingCaptureOwner)
// ============================================================================
// The server emits tree.snapshot + detail `snapshot` + snapshot.complete from
// ONE coherent SnapshotWithTree capture, all stamped with the SAME store-lifetime
// {epoch, seq} (Q5: pkg/state/tree_emitter.go TreeSnapshot + pkg/web/server.go
// writeSnapshotComplete). C4 makes that truthful boundary enforceable on the FE:
// a capture becomes authoritative only when its matching detail snapshot,
// decoded tree snapshot, AND the snapshot.complete boundary are ALL present; the
// FE then installs BOTH projections atomically (one Solid batch) before
// releasing newer live events. No server changes.
//
// One stream-local owner per active tree generation (the server does not
// pipeline captures on one open response). The owner may start identity-unbound
// (it must exist before gzip64 decode yields, while {epoch,seq} is only
// available after decoding). The SAME object survives identity-bind, staging,
// install, reconcile, release. Covered live handlers capture the EXACT owner
// ref and `await` its promise; on settle they recheck the tree generation and
// run their reducer + cursor effects SYNCHRONOUSLY — no second await between
// the gen recheck and the reducer (the release-burst ordering proof depends on
// this; adding one breaks it).
interface CoherentIdentity {
  epoch: string;
  seq: number;
}
interface StagedTree {
  nodes: TreeNode[];
  identity: CoherentIdentity;
  focusedSessionId?: string;
}
interface StagedDetail {
  snap: Snapshot;
  identity: CoherentIdentity;
}
interface CompletionLatch {
  identity: CoherentIdentity;
  projections: string[];
}
interface PendingCaptureOwner {
  // The tree connection generation this owner belongs to. Covered handlers
  // capture THIS owner; after settle they recheck treeGen === generation.
  generation: number;
  // Identity-unbound until the first baseline participant yields a valid
  // coherent {epoch, seq}. Once bound, every other participant must match.
  identity: CoherentIdentity | null;
  // legacy: the tree projection decoded WITHOUT a valid epoch (pre-Q5 daemon)
  // or with an identity that mismatches an already-bound owner. A legacy owner
  // NEVER installs; all participants apply independently (existing behavior,
  // authoritativeReady stays false). Covered handlers skip awaiting a SETTLED
  // legacy owner.
  legacy: boolean;
  stagedTree: StagedTree | null;
  stagedDetail: StagedDetail | null;
  completion: CompletionLatch | null;
  // pendingTreeDecode: the in-flight tree gzip64 decode promise (null for a RAW
  // tree.snapshot, or once finishDecode has landed). The owner's promise does
  // NOT resolve until this decode's tree apply completed, so a covered handler
  // that captured owner.promise and is then released by markOwnerLegacy (a
  // mismatch while the decode is in flight) resumes AFTER seedTreeStore — its
  // reducer is not clobbered by the late wholesale treeMap replace (B-F1/B-F2
  // data-loss guard). Canceled owners (gen bump) release immediately regardless
  // — their waiters fail the gen check and never apply.
  pendingTreeDecode: Promise<void> | null;
  // The promise covered handlers await. Resolves on install OR cancel OR legacy
  // (via releaseOwner, which chains behind pendingTreeDecode for the legacy
  // path); never rejects (a canceled owner resolves so its waiters resume and
  // fail the gen check rather than hanging forever).
  promise: Promise<void>;
  settle: () => void;
  settled: boolean;
  installed: boolean;
}

// The one stream-local owner for the active tree generation. Null when no
// potentially-coherent capture is in flight.
let pendingOwner: PendingCaptureOwner | null = null;

function makeOwner(generation: number): PendingCaptureOwner {
  let resolveFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    generation,
    identity: null,
    legacy: false,
    stagedTree: null,
    stagedDetail: null,
    completion: null,
    pendingTreeDecode: null,
    promise,
    settle: () => resolveFn(),
    settled: false,
    installed: false,
  };
}

// releaseOwner — resolve the owner's promise (so covered handlers resume). When
// `waitForTree` is true (markOwnerLegacy / tryInstall paths, where same-gen
// waiters WILL apply their reducers), the resolution is CHAINED behind
// pendingTreeDecode so it cannot fire until the in-flight tree gzip64 decode's
// apply (finishDecode → applyTreeIndependent / tryInstall batch) has landed.
// This preserves the single-await ordering invariant (covered handlers await
// owner.promise ONCE) while guaranteeing their reducer applies after the
// baseline seed — closing the B-F1/B-F2 data-loss race. When `waitForTree` is
// false (cancelPendingOwner: gen bump → waiters fail the gen check and never
// apply), the release is immediate.
function releaseOwner(owner: PendingCaptureOwner, waitForTree: boolean): void {
  if (owner.settled) return;
  const finish = () => {
    if (owner.settled) return;
    if (pendingOwner === owner) pendingOwner = null;
    owner.settled = true;
    owner.settle();
  };
  if (waitForTree && owner.pendingTreeDecode) {
    void owner.pendingTreeDecode.then(finish);
  } else {
    finish();
  }
}

// bindIdentity — bind the owner to the first valid coherent {epoch, seq}, or
// verify a subsequent participant matches. Returns false on MISMATCH (the
// participant is rejected). An empty epoch is not a valid coherent identity
// (the detail Snapshot.epoch is optional for back-compat; correlation requires
// a real epoch).
function bindOwnerIdentity(owner: PendingCaptureOwner, epoch: string, seq: number): boolean {
  if (!epoch) return false;
  if (owner.identity === null) {
    owner.identity = { epoch, seq };
    return true;
  }
  return owner.identity.epoch === epoch && owner.identity.seq === seq;
}

// cancelPendingOwner — detach + release the current owner WITHOUT install. Used
// on generation change (connect bumps treeGen) and on same-generation overlap
// (a second capture while the first is still pending → resync). Releases
// IMMEDIATELY (waitForTree=false): a gen bump means resumed waiters fail their
// post-await gen check and never apply, so there is no clobber concern. A stale
// owner may settle itself but NEVER clears a newer owner, installs staged state,
// sets readiness, or runs current-gen reconcile (tryInstall + the gen guards
// enforce this).
function cancelPendingOwner(): void {
  const old = pendingOwner;
  if (!old) return;
  releaseOwner(old, false);
}

// markOwnerLegacy — declare the pending capture incoherent (a participant's
// identity mismatched the bound identity, so the coherent install will never
// fire). Marks the owner legacy and flushes already-staged participants via the
// independent paths (detail is disjoint; a tree that already decoded is flushed
// too). The owner's promise release is CHAINED behind pendingTreeDecode via
// releaseOwner(owner, true): same-gen covered waiters will apply their reducers
// on resume, so they must resume AFTER the in-flight tree gzip64 decode's
// applyTreeIndependent (seedTreeStore) lands — otherwise the late wholesale
// treeMap replace clobbers them (B-F1/B-F2). A participant still in flight (the
// tree decode) sees owner.legacy when it lands and applies independently.
// authoritativeReady stays false (no truthful install).
function markOwnerLegacy(owner: PendingCaptureOwner): void {
  if (owner.settled) return;
  owner.legacy = true;
  // Flush already-staged participants via the independent paths NOW (they are
  // disjoint from each other; the tree — if its decode is still in flight — is
  // applied by finishDecode's legacy branch, NOT here).
  if (owner.stagedDetail) {
    const snap = owner.stagedDetail.snap;
    owner.stagedDetail = null;
    applyDetailIndependent(snap);
  }
  if (owner.stagedTree) {
    const t = owner.stagedTree;
    owner.stagedTree = null;
    const snap: TreeSnapshot = { nodes: t.nodes };
    if (typeof t.focusedSessionId === "string") snap.focusedSessionId = t.focusedSessionId;
    applyTreeIndependent(snap, t.identity.seq, owner.generation);
  }
  // Release same-gen waiters only after the tree apply (if still pending) —
  // chained behind pendingTreeDecode. For a RAW tree.snapshot or an already-
  // completed decode, pendingTreeDecode is null → immediate release.
  releaseOwner(owner, true);
}

// ensureOwner — get-or-create the pending owner for `generation`. A stale owner
// from a prior generation (should already have been canceled by connect()'s gen
// bump, but defended against) is settled + dropped without install.
function ensureOwner(generation: number): PendingCaptureOwner {
  if (pendingOwner && pendingOwner.generation === generation && !pendingOwner.settled) {
    return pendingOwner;
  }
  cancelPendingOwner();
  const owner = makeOwner(generation);
  pendingOwner = owner;
  return owner;
}

// coveredAwait — the promise a covered live handler should await for
// `generation`, or null for the fast path (no coherent owner pending AND no
// independent detail decode in flight). Returns the EXACT owner's promise (not
// a boolean + a separately-replaceable global) so the handler awaits the owner
// it captured even if pendingOwner is replaced later. A SETTLED owner yields
// null (skip the await).
//
// C-F1: a legacy-but-UNSETTLED owner still returns owner.promise. The release
// from markOwnerLegacy is chained behind pendingTreeDecode (releaseOwner
// waitForTree=true), so owner.promise resolves AFTER the seed regardless — the
// B-F1/B-F2 data-loss guard is preserved. Same-gen waiters MUST all await this
// one promise so their resumption is FIFO in arrival order: routing a post-
// mismatch waiter onto treeSnapshotDecode (a different promise object) splits
// the resume lanes and reorders resumption (B before A despite arriving later),
// which regresses the resume cursor via applySessionEvent's unconditional
// `s.cursor = seq`. Only a SETTLED legacy owner (install done / already
// canceled) yields null → fast path or independent-decode-gate path.
function coveredAwait(generation: number): Promise<void> | null {
  const owner = pendingOwner;
  if (owner && !owner.settled && owner.generation === generation) {
    return owner.promise;
  }
  if (treeSnapshotDecoding) return treeSnapshotDecode;
  return null;
}

// applyDetailIndependent — the existing detail `snapshot` apply path, extracted
// so the coherent install and the legacy/independent path run identical logic.
// Gate deferral, expectTreeSnap handshake, applySnapshot (wholesale-replace +
// cursor), latency, status, refresh. Does NOT touch authoritativeReady (the
// independent path leaves it false; the coherent install sets it in its batch).
function applyDetailIndependent(snap: Snapshot): void {
  if (isGateActive() && !getExpectTreeSnap()) {
    advanceCursor(snap.seq);
    markBusyDirty();
    return;
  }
  if (getExpectTreeSnap()) {
    setExpectTreeSnap(false);
    maybeResolveReconcile();
  }
  // D3: a frontier-scoped partial detail frame (snap.partial present) installs
  // via the scoped merge/replace path, NOT wholesale projectSnapshot — so buried
  // detail outside the frontier scope is preserved. Both install paths branch
  // identically (this independent path + the coherent tryInstall path).
  if (snap.partial) applyScopedSnapshot(snap);
  else applySnapshot(snap);
  if (!treeSnapDone) {
    treeSnapDone = true;
    if (treeT1) recordLatency("tree", "snap", performance.now() - treeT1);
  }
  setState("status", "live");
  void refreshOpenSessions();
}

// applyTreeIndependent — the existing tree.snapshot apply path, extracted so the
// legacy/independent path runs identical logic to the pre-C4 behavior. Gate
// deferral, seedTreeStore, P1-A backfill, latency, cursor (F4: SSE id store
// seq), status, resolvePeriodicDiff. `gen` is the connection's captured
// treeGen, forwarded to resolvePeriodicDiff for the periodic-slot attribution.
function applyTreeIndependent(snap: TreeSnapshot, seq: number, gen: number): void {
  if (isGateActive() && !getExpectTreeSnap()) {
    advanceCursor(seq);
    markBusyDirty();
    return;
  }
  if (getExpectTreeSnap()) {
    setExpectTreeSnap(false);
    maybeResolveReconcile();
  }
  seedTreeStore(snap.nodes);
  const backfill = expandedButUnloadedIds();
  if (backfill.length > 0) {
    for (const id of backfill) void expandTreeNode(id);
  }
  if (!treeSnapDone) {
    treeSnapDone = true;
    if (treeT1) recordLatency("tree", "snap", performance.now() - treeT1);
  }
  advanceCursor(seq);
  setState("status", "live");
  resolvePeriodicDiff(gen);
}

// tryInstall — VALIDATE all three staged participants against the bound
// identity and, if every precondition holds, INSTALL BOTH projections in one
// Solid batch, then detach + settle so deferred handlers resume in arrival
// order. No-op otherwise: an arbitrary JSON object must NOT mark the baseline
// authoritative. A legacy or superseded owner never installs.
function tryInstall(owner: PendingCaptureOwner): void {
  if (owner.settled || owner.installed) return;
  if (owner.generation !== treeGen) return; // superseded by a reconnect
  if (pendingOwner !== owner) return; // not current (overlap resync replaced path)
  if (owner.legacy) return;
  const id = owner.identity;
  if (!id) return;
  const tree = owner.stagedTree;
  const detail = owner.stagedDetail;
  const completion = owner.completion;
  if (!tree || !detail || !completion) return;
  // Identity cross-projection validation (VALIDATE step).
  if (tree.identity.epoch !== id.epoch || tree.identity.seq !== id.seq) return;
  if (detail.identity.epoch !== id.epoch || detail.identity.seq !== id.seq) return;
  if (completion.identity.epoch !== id.epoch || completion.identity.seq !== id.seq) return;
  if (!completion.projections.includes("tree") || !completion.projections.includes("detail")) return;
  // ALL preconditions hold — INSTALL ATOMICALLY (one Solid batch: no observer
  // sees a mixed old/new projection pair).
  owner.installed = true;
  let backfillIds: string[] = [];
  batch(() => {
    // Detail projection. A frontier-scoped partial (snap.partial present)
    // installs via the scoped merge/replace path (D3) — same branch as the
    // independent applyDetailIndependent path — so a staged partial can never
    // fall through to wholesale replacement. applySnapshot/applyScopedSnapshot
    // wholesale-replaces (or scoped-merges) state.sessions and sets state.cursor
    // = snap.seq; inside the batch this and the tree seed are ONE reactive flush.
    if (detail.snap.partial) applyScopedSnapshot(detail.snap);
    else applySnapshot(detail.snap);
    // Tree projection (existing seedTreeStore path). Replaces treeMap in one
    // signal update; userExpanded preserved.
    seedTreeStore(tree.nodes);
    // Tree-dependent effects AFTER the seed exists (Case 9: resolvePeriodicDiff
    // observes the newly seeded coherent tree, not a mixed pair). Passing the
    // owner's generation so a superseded periodic slot is dropped cleanly.
    resolvePeriodicDiff(owner.generation);
    // P1-A backfill: capture ids here (treeMap is now the seeded coherent map)
    // and fire the network expands AFTER the batch.
    backfillIds = expandedButUnloadedIds();
    // Matching busy/recovery reconcile (Case 8): the expectTreeSnap handshake
    // clears here, where the authoritative baseline actually landed — not after
    // only one projection.
    if (getExpectTreeSnap()) {
      setExpectTreeSnap(false);
      maybeResolveReconcile();
    }
    if (!treeSnapDone) {
      treeSnapDone = true;
      if (treeT1) recordLatency("tree", "snap", performance.now() - treeT1);
    }
    // F4: advance the cursor to the coherent capture's store seq (== both
    // projections' seq). Inside the batch so observers see cursor + projections
    // land together.
    advanceCursor(id.seq);
    // Truthful readiness ONLY after both projections installed.
    setState("authoritativeReady", true);
  });
  // DETACH before SETTLE: a newly-delivered event joining the barrier finds no
  // owner and (gen still current) takes its fast path instead of awaiting a
  // just-settled owner. Then release THIS owner so its captured waiters resume,
  // recheck gen, and run their synchronous reducers FIFO (release burst).
  // releaseOwner(owner, true): by this point finishDecode has cleared
  // pendingTreeDecode (the tree apply ran inside the install batch above), so
  // the release is immediate.
  releaseOwner(owner, true);
  markAuthoritativeRecovery();
  // Fire-and-forget effects that must NOT be inside the batch (async network).
  for (const nid of backfillIds) void expandTreeNode(nid);
  setState("status", "live");
  void refreshOpenSessions();
}

// TREE_STREAM_KINDS — the named SSE events Stream 1 (the tree stream)
// subscribes to and forwards to applyMessageEvent. Exported so a unit test
// can PIN it: a snapshot-only facet pushed live (activity.verb,
// lastAgent.set) MUST appear here, or EventSource silently drops the frame
// even though applyMessageEvent has the handler case — that was the
// cold-chip gap (handler present, listener absent). Structural session
// events (session.upsert/delete) route through applySessionEvent and are
// registered in a separate loop above; message.* kinds are Stream 2
// (active-session) only.
export const TREE_STREAM_KINDS = [
  "status",
  "activity",
  "activity.verb",
  "lastAgent.set",
  "permission.blocked",
  "permission.upsert",
  "permission.delete",
  "question.upsert",
  "question.delete",
  "unread.set",
  "unread.clear",
] as const;


// isTreeSnapshotDecoding — test-only peek at whether a coherent capture or an
// independent detail decode is in flight. C4: the coherent barrier (pending
// owner) is the primary gate; treeSnapshotDecoding now only covers the rare
// independent detail-gzip64 path. Either active → true.
export function isTreeSnapshotDecoding(): boolean {
  return treeSnapshotDecoding || (pendingOwner != null && !pendingOwner.settled && !pendingOwner.legacy);
}

// getTreeSnapshotDecode — test-only accessor for the in-flight barrier/decode
// promise. C4: returns the pending owner's promise when a coherent capture is
// in flight (settles on install OR cancel); otherwise the independent detail
// decode promise. Lets tests await the barrier directly (deterministic) instead
// of pumping fake timers.
export function getTreeSnapshotDecode(): Promise<void> {
  if (pendingOwner && !pendingOwner.settled) return pendingOwner.promise;
  return treeSnapshotDecode;
}

// --- Invariant 1 (Stream1 side): delivery-ordinal gap detection → forced resync --
//
// checkTreeOrdinalGap — O3: called on EVERY seq'd Stream1 event with the DELIVERY
// ORDINAL extracted from the compound SSE id. If the ordinal exceeds
// treeLastDeliveryOrdinal + 1, a real loss occurred (the ordinal counts ONLY
// tree-relevant logical source events, so a gap means tree-relevant events were
// silently lost below SSE). This REMOVES the cross-stream covering check that
// false-positived when Stream2 lagged (the production thrash root cause).
// A gap directly → connect(true) — no heuristic, no grace window.
//
// The diag entry is written BEFORE the resync so pre-recovery state is recorded.
function checkTreeOrdinalGap(ordinal: number, kind: string): void {
  // Guard: ordinal must be a positive finite integer and we must have a prior
  // baseline (treeLastDeliveryOrdinal >= 0 means at least one prior event set it).
  if (!Number.isFinite(ordinal) || ordinal < 0 || treeLastDeliveryOrdinal < 0) return;
  const expected = treeLastDeliveryOrdinal + 1;
  if (ordinal <= expected) return; // contiguous or out-of-order
  const gap = ordinal - expected;
  // Ordinal gap = DIRECTLY actionable real loss. No covering check.
  captureDiagEntry({
    kind: "stall",
    ts: Date.now(),
    trigger: "seq-gap",
    stream: "tree",
    seqGap: { stream: "tree", expected, got: ordinal, missed: gap },
    eventSourceState: {
      tree: es?.readyState ?? -1,
      session: 0, // not tracked here; session-stream fills its own entries
    },
  });
  log.warn("sync", "tree delivery-ordinal gap → forcing fresh-snapshot reconnect", {
    kind,
    expected,
    got: ordinal,
    missed: gap,
  });
  // Force a cursorless fresh-snapshot reconnect. connect(true) bumps treeGen,
  // closes the old EventSource, and opens a fresh one with an authoritative
  // full snapshot (C4 coherent barrier reconciles).
  connect(true);
}

export function connect(fresh = false) {
  clearTimeout(reconnectTimer);
  // Invalidate any in-flight async gzip64 snapshot decode captured by a PRIOR
  // connection BEFORE we close it. Bumping the generation first means a stale
  // decode's post-await gen check fails and it refuses to mutate the store,
  // even on the empty-projectDir early-return path (switchProject("") →
  // connect()). Mirrors Stream 2's closeSessionStream order (sesGen++ BEFORE
  // ses?.close()); the prior Stream-1 order (close THEN bump) left a stale-
  // decode hazard on the empty-dir path.
  treeGen++;
  // C4: cancel any pending coherent owner for the prior generation. Its waiters
  // (covered handlers that captured it) resume on settle and fail the gen check;
  // a stale owner must NEVER install staged state or clear a newer owner.
  cancelPendingOwner();
  // Reset the in-flight decode gate so a live tree event landing on the new
  // connection doesn't await a stale decode from the prior connection.
  treeSnapshotDecode = Promise.resolve();
  treeSnapshotDecoding = false;
  // Reset the seq-gap baseline so the first event on the new connection doesn't
  // trigger a false gap (there's no prior baseline to compare against).
  treeLastDeliveryOrdinal = -1;
  es?.close();
  // No project selected (daemon cwd is not a meaningful project): do NOT open
  // a tree stream. The watchdog/maybeReconnect also no-op while projectDir is
  // empty, so nothing auto-reconnects the cwd bridge. Selecting a project
  // (switchProject) calls connect(true) explicitly.
  if (!projectDir()) {
    es = null;
    return;
  }
  const cursorParam = fresh ? "" : `cursor=${state.cursor}&`;
  treeT0 = performance.now(); // L1 t0: connection attempt begins
  treeT1 = 0;
  treeSnapDone = false;
  // Q5 C2: a new connection's projections haven't landed yet — reset the
  // convergence boundary so consumers see "not yet authoritative" until the
  // server's snapshot.complete fires for the new connection's first capture.
  setState("authoritativeReady", false);
  // Capture the generation for THIS connection's listeners. The bump above
  // already invalidated any prior decode; this `gen` is checked at listener
  // entry and after every await in the snapshot listener.
  const gen = treeGen;
  // The map-clear is CALLER-OWNED, not driven by `fresh`. A same-project fresh
  // resync (resyncTree / reconcileBusy / on-focus) must swap the snapshot
  // ATOMICALLY: seedTreeStore (tree.snapshot listener, below) replaces the map
  // in one step and never touches userExpanded, so the old map stays visible
  // until the new one lands (no empty-frame flash) and manual expansions
  // survive. Only a TRUE project switch (switchProject) clears explicitly by
  // calling resetTreeStore() itself. `fresh` now ONLY controls the cursor:
  // fresh = no cursor = request an authoritative full snapshot.
  // Stream 1 (tree) opts into the server's gzip64 snapshot compression with
  // `&z=1`, mirroring Stream 2's session stream. The tree snapshot for a real
  // project is ~760 KiB–1.1 MiB of highly repetitive JSON (one project, one
  // directory, a handful of agents/models) and ships UNCOMPRESSED through the
  // controller tunnel without this flag (the tunnel does not compress at any
  // lower layer). gzip cuts it to ~150–200 KiB on the wire — ~5–7x smaller.
  // The server's maybeCompressSnapshot only wraps payloads ≥ 2 KiB AND only
  // when z=1 is set, so small/raw responses (an old server, or an edge-case
  // tiny tree) still ship raw and the listener handles both shapes.
  //
  // `&tree=2` (§10): negotiate the server-owned tree stream. The server emits
  // tree.* frames (structure → treeState flat map) AND the legacy detail
  // frames (snapshot/session.*/permission.*/etc → the detail layer). The
  // shared resume cursor (state.cursor, store-seq space, see F4 below) is
  // identical for both projections, so cursorParam above applies unchanged.
  es = new EventSource(
    `/vh/stream?${cursorParam}sessions=&dir=${encodeURIComponent(projectDir())}&z=1&tree=2`,
  );
  markTreeSeen();
  log.debug("sync", "tree stream connect", { cursor: fresh ? "fresh" : state.cursor, dir: projectDir() });
  es.addEventListener("snapshot", (e) => {
    // Generation guard: ignore frames from a superseded connection BEFORE
    // touching the clock or the store. The gzip64 path awaits, so this same
    // guard is re-checked after the await — a stale decode must NOT mutate the
    // store or clear state. Mirrors Stream 2's sesGen guard.
    if (gen !== treeGen) return;
    markTreeSeen();
    // Parse the outer envelope ONCE. The server emits either the raw snapshot
    // JSON (small/legacy) OR {encoding:"gzip64", data:base64(gzip(snapshot))}
    // when z=1 AND the payload exceeds the threshold. The decode helper is a
    // total function (pass-through when no envelope), so both shapes work.
    let raw: any;
    try {
      raw = JSON.parse((e as MessageEvent).data);
    } catch (err) {
      // A malformed snapshot carries an UNREADABLE seq (it lives in the JSON
      // body, not the SSE id field), so the resume cursor can't be advanced from
      // the body. But a snapshot is a fresh FULL-STATE reconciliation (not a
      // per-seq replay frame), so dropping it is safe: live tree events keep
      // advancing the cursor meanwhile, and the next snapshot (a watchdog
      // reconnect / server re-snapshot) reconciles everything authoritatively.
      log.warn("sync", "malformed tree snapshot frame", { err });
      return;
    }
    // C4: the detail `snapshot` is a BASELINE PARTICIPANT of the coherent
    // capture. It stages into the pending owner (if one is pending for this
    // generation and the identity matches) and is applied atomically with the
    // tree projection inside tryInstall's batch. A baseline participant NEVER
    // awaits its own owner. If no coherent owner is pending (proj=1 / legacy /
    // no tree.snapshot in flight / identity mismatch) it applies independently
    // — the existing pre-C4 path.
    const stageDetail = (snap: Snapshot): boolean => {
      const owner = pendingOwner;
      if (!owner || owner.legacy || owner.generation !== gen) return false;
      const epoch = snap.epoch || "";
      const seq = snap.seq;
      // A detail with no epoch can't participate coherently → independent apply.
      if (!epoch) return false;
      if (!bindOwnerIdentity(owner, epoch, seq)) {
        // Identity mismatch → the capture is incoherent. Release the barrier so
        // covered handlers do not hang, then the caller applies this detail
        // independently.
        markOwnerLegacy(owner);
        return false;
      }
      // Staging into an already-settled (installed) owner is harmless:
      // tryInstall no-ops, so a replayed detail from the just-installed capture
      // is dropped (already applied inside the install batch) rather than
      // re-applied independently and clobbering the live tail.
      owner.stagedDetail = { snap, identity: { epoch, seq } };
      tryInstall(owner);
      return true;
    };
    // Compressed path: async decode. treeSnapshotDecoding gates ONLY the
    // independent apply (no coherent owner covers a proj=1 / detail-only decode
    // window); when a coherent owner is pending, covered handlers await the
    // OWNER, not this flag. After decode, route to coherent-stage or
    // independent-apply.
    if (raw.encoding === "gzip64") {
      treeSnapshotDecoding = true;
      treeSnapshotDecode = (async () => {
        try {
          let snap: Snapshot;
          try {
            snap = await decodeSnapshot<Snapshot>(raw);
          } catch (err) {
            // decodeSnapshot is a total function (returns {} on malformed), so
            // this catch is defensive — but never let a decode throw propagate
            // to an unhandled promise rejection. Drop the frame; live events +
            // the next snapshot reconcile.
            log.warn("sync", "tree snapshot gzip64 decode failed", { err });
            return;
          }
          // Generation re-check (mirrors Stream 2's post-await sesGen check):
          // the connection may have been replaced while we were decoding.
          if (gen !== treeGen) return;
          if (stageDetail(snap)) return;
          applyDetailIndependent(snap);
        } finally {
          // Ownership-aware clear: only the CURRENT generation owns the flag.
          if (gen === treeGen) treeSnapshotDecoding = false;
        }
      })();
    } else {
      const snap = raw as Snapshot;
      if (!stageDetail(snap)) applyDetailIndependent(snap);
    }
  });
  // === Phase 3 Step A (COEXIST): tree=2 server-owned tree stream =============
  // These listeners are registered unconditionally but only FIRE in tree=2 mode
  // (the server emits tree.* frames only when the tree emitter is engaged). In
  // proj=1 mode the server never emits tree.* frames, so these are inert no-ops.
  //
  // Coexistence is double-apply-safe because the two projections write
  // DISJOINT state: the tree.* listeners populate treeMap/treeState (the
  // structural tree), while the legacy detail listeners populate the detail
  // maps (state.sessions / state.permissions / state.questions /
  // etc.). As of Step A.5 GAP 3 the server emits BOTH projections in tree=2
  // mode — tree.snapshot + tree.op for STRUCTURE, and a legacy detail snapshot
  // + legacy detail events (snapshot, permission.*, question.*, todo, status,
  // activity.*, lastAgent.set, unread.*) for SESSION DETAIL. Only the
  // server-internal tree.orphan kind is suppressed on the legacy wire (it is
  // translated into node facets inside the tree projection). session.upsert /
  // session.delete are emitted on BOTH wires: structurally via tree.op (so the
  // treeMap reflects creates/deletes) and as legacy events (so state.sessions
  // detail stays current); these are also disjoint (treeMap vs state.sessions).
  //
  // F4 (carry-forward, CRITICAL): the SSE `id` field / Last-Event-ID carries the
  // STORE seq for BOTH tree.snapshot (server.go writeRaw(w, treeSnap.Seq,...)) and
  // tree.op (server.go writeRaw(w, ev.Seq,...)). The envelope BODY `seq` field is
  // a per-connection emitter counter (tree_emitter.go e.seq++) that DIFFERS from
  // the store seq. Resume/reconnect MUST key on Number(ev.lastEventId) (the store
  // seq) via advanceCursor — NEVER on the body seq. Keying on the wrong one breaks
  // resume. The store-seq space is shared with proj=1 (same store ring), so
  // advanceCursor(state.cursor) is correct for both modes.
  es.addEventListener("tree.snapshot", (e) => {
    if (gen !== treeGen) return;
    markTreeSeen();
    const ev = e as MessageEvent;
    // F4: store seq from the compound SSE id's globalSeq component, not the body.
    // O3: snapshots carry ordinal 0 and are NOT gap-checked by the tree stream.
    const seq = parseSSEID(ev.lastEventId).globalSeq;
    let raw: any;
    try {
      raw = JSON.parse(ev.data);
    } catch (err) {
      log.warn("sync", "malformed tree.snapshot frame", { err });
      return;
    }
    // C4 overlapping-capture policy: a same-generation second capture while a
    // coherent owner is still pending is NOT a valid in-band state (the server
    // does not pipeline captures on one open response). In-band replacement is
    // explicitly forbidden (it would require assigning live events to the
    // correct baseline interval = journal/rebase semantics). Force a resync:
    // cancel A without install, bump the generation, and let the watchdog/new
    // connection obtain one fresh coherent baseline. A's waiters fail their
    // post-await gen check.
    if (
      pendingOwner &&
      pendingOwner.generation === gen &&
      !pendingOwner.settled &&
      !pendingOwner.legacy
    ) {
      log.warn("sync", "overlapping tree.snapshot (same-gen capture while pending) → resync");
      cancelPendingOwner();
      connect(true);
      return;
    }
    // CREATE the owner BEFORE the first async decode yield. Identity-unbound
    // until a participant yields a valid coherent {epoch, seq}.
    const owner = ensureOwner(gen);
    // finishDecode runs after the (possibly async) decode resolves. It stage the
    // tree projection, then routes to the coherent install path OR the legacy
    // independent path based on whether the decoded tree carries a valid epoch
    // (the Q5 discriminator).
    const finishDecode = (decoded: unknown) => {
      if (gen !== treeGen) return; // superseded during decode
      // The tree gzip64 decode is done — clear the gate so releaseOwner's
      // chained release (from a prior markOwnerLegacy) fires once this
      // synchronous finishDecode + the IIFE tail complete (i.e. AFTER the tree
      // apply below). For a RAW tree.snapshot there was no decode and this is
      // already null.
      owner.pendingTreeDecode = null;
      const snap = decodeTreeSnapshot(decoded);
      if (!snap) {
        log.warn("sync", "tree.snapshot decoded to null", { seq });
        // A null decode (malformed nodes) strands the owner; mark it legacy
        // (flush staged detail + release — pendingTreeDecode is null so the
        // release is immediate) so covered handlers don't hang.
        if (pendingOwner === owner && !owner.settled) markOwnerLegacy(owner);
        return;
      }
      // If a participant already declared this capture incoherent (a mismatch
      // marked the owner legacy while the tree was decoding), apply the tree
      // independently. The release from that prior markOwnerLegacy was chained
      // behind the decode promise and fires AFTER finishDecode returns (so after
      // this seed) — covered waiters resume on the seeded tree, not clobbered.
      if (owner.legacy || owner.settled) {
        applyTreeIndependent(snap, seq, gen);
        return;
      }
      // C4 legacy discrimination (Case 7): a tree projection WITHOUT a valid
      // epoch is a pre-Q5 daemon (no coherent correlation possible, and no
      // snapshot.complete will arrive). Seed the tree FIRST, then mark legacy
      // (flush staged detail + release). pendingTreeDecode is null → the release
      // is immediate and AFTER the seed. authoritativeReady stays false.
      if (!snap.epoch) {
        applyTreeIndependent(snap, seq, gen);
        markOwnerLegacy(owner);
        return;
      }
      // Coherent: stage the tree. The store seq is the SSE id (F4); snap.seq
      // (the Q5 body field) mirrors it. Prefer the body seq when present for
      // correlation parity with the detail/completion identity.
      const treeSeq = typeof snap.seq === "number" ? snap.seq : seq;
      // Identity mismatch vs an already-bound owner (detail/completion bound a
      // different {epoch, seq}): the capture is not coherent. Seed FIRST, then
      // mark legacy (flush staged detail + release after the seed).
      if (!bindOwnerIdentity(owner, snap.epoch, treeSeq)) {
        applyTreeIndependent(snap, seq, gen);
        markOwnerLegacy(owner);
        return;
      }
      const staged: StagedTree = {
        nodes: snap.nodes,
        identity: { epoch: snap.epoch, seq: treeSeq },
      };
      if (typeof snap.focusedSessionId === "string") staged.focusedSessionId = snap.focusedSessionId;
      owner.stagedTree = staged;
      tryInstall(owner);
    };
    if (raw.encoding === "gzip64") {
      // C4: the owner.promise is the PRIMARY gate for covered handlers, but the
      // tree gzip64 decode ALSO sets treeSnapshotDecoding/treeSnapshotDecode so
      // a covered tree.op stays serialized against seedTreeStore even if the
      // owner is released early (markOwnerLegacy on a mismatch, or a cancel)
      // BEFORE the decode finishes. Without this, markOwnerLegacy would clear
      // the owner while the tree decode is still in flight → coveredAwait
      // returns null → a tree.op applies ahead of the late seedTreeStore and
      // is wholesale-replaced (data loss). The decode gate is cleared in the
      // IIFE's tail AFTER finishDecode lands (ownership-aware) so the deferred
      // tree.op resumes only once the tree apply (install or legacy) completed.
      treeSnapshotDecoding = true;
      // `decodeP` is referenced inside its own body for the ownership-aware
      // clear; declare it first with a definite-assignment assertion (assigned
      // immediately after the IIFE expression evaluates).
      let decodeP!: Promise<void>;
      decodeP = (async () => {
        let decoded: unknown;
        try {
          decoded = await decodeSnapshot<unknown>(raw);
        } catch (err) {
          log.warn("sync", "tree.snapshot gzip64 decode failed", { err });
          // A failed decode strands the owner; mark it legacy (flush staged
          // detail + release — pendingTreeDecode is cleared in finishDecode's
          // null path, but a throw bypasses finishDecode, so clear it here too
          // so releaseOwner is immediate) so covered handlers don't hang.
          owner.pendingTreeDecode = null;
          if (pendingOwner === owner && !owner.settled) markOwnerLegacy(owner);
          if (treeSnapshotDecode === decodeP) treeSnapshotDecoding = false;
          return;
        }
        finishDecode(decoded);
        // Clear the decode gate AFTER the tree apply (install or legacy) so a
        // deferred tree.op resumes only once seedTreeStore landed. Ownership-
        // aware: a newer decode (new owner / reconnect) owns the flag now.
        if (treeSnapshotDecode === decodeP) treeSnapshotDecoding = false;
      })();
      treeSnapshotDecode = decodeP;
      // Register the in-flight decode on the owner so releaseOwner can chain
      // same-gen waiter release behind it (B-F1/B-F2 data-loss guard).
      owner.pendingTreeDecode = decodeP;
    } else {
      finishDecode(raw);
    }
  });
  registerTreeStreamListeners(es, gen);
  // === Q5 C2 — truthful completion boundary ===================================
  // The server (commit C1) emits `snapshot.complete` as a named SSE event AFTER
  // both projections (tree.snapshot + detail snapshot) of the SAME {epoch, seq}
  // capture are written, gated on treeOK && detailOK (no false atomicity). This
  // is the ONLY client-side signal that both projections are coherent from one
  // authoritative capture — the FE cannot correlate by arrival/decode order
  // (tree.snapshot is gzip64-decoded async; detail snapshot ships RAW sync).
  //
  // authoritativeReady marks the verifiable convergence boundary. It is RESET to
  // false on every new connection (connect(), above). Old daemons that don't
  // emit this event leave it false — treeSnapDone / status==="live" remain the
  // operational ready indicator (backward-compatible degradation).
  //
  // The event carries an SSE `id:` == the capture seq (same as both
  // projections') and a body {epoch, revision, projections:["tree","detail"]}.
  // We don't advanceCursor here (both projections already advanced it to the
  // same seq); we only mark the boundary for consumers.
  es.addEventListener("snapshot.complete", (e) => {
    if (gen !== treeGen) return;
    markTreeSeen();
    let p: { epoch?: string; revision?: number; projections?: string[] };
    try {
      p = JSON.parse((e as MessageEvent).data);
    } catch (err) {
      log.warn("sync", "malformed snapshot.complete frame", { err });
      return;
    }
    // Guard against a JSON-valid-but-non-object body (null, a primitive, or an
    // array) — the server contract guarantees an object, but a non-object would
    // throw on property access below. Drop defensively (authoritativeReady stays
    // false → the safe degradation).
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      log.warn("sync", "snapshot.complete body is not an object", { body: p });
      return;
    }
    // C4: stage the completion latch into the coherent owner. The participant
    // NEVER awaits its own owner. With no coherent owner pending (proj=1 / a
    // pre-Q5 daemon that nevertheless emits the event / overlap already cleared
    // / already-installed), there is no truthful install to mark — drop. An
    // arbitrary JSON object can NOT mark the baseline authoritative: tryInstall
    // validates identity + projections + that BOTH other participants staged.
    const owner = pendingOwner;
    if (!owner || owner.legacy || owner.settled || owner.generation !== gen) {
      log.debug("sync", "snapshot.complete with no coherent owner pending", {
        epoch: p.epoch,
        revision: p.revision,
      });
      return;
    }
    const epoch = p.epoch || "";
    const cseq = typeof p.revision === "number" ? p.revision : 0;
    // A completion with no epoch can't participate coherently → drop (the owner
    // keeps waiting for a real completion; a missing completion on a Q5 stream
    // means reconnect/resync, not a guess — no timeout).
    if (!epoch) {
      log.debug("sync", "snapshot.complete with no epoch", { revision: p.revision });
      return;
    }
    if (!bindOwnerIdentity(owner, epoch, cseq)) {
      // Identity mismatch → the capture is incoherent. Release the barrier so
      // covered handlers do not hang, flushing staged participants.
      log.warn("sync", "snapshot.complete identity mismatch", {
        owner: owner.identity,
        epoch,
        seq: cseq,
      });
      markOwnerLegacy(owner);
      return;
    }
    owner.completion = {
      identity: { epoch, seq: cseq },
      projections: Array.isArray(p.projections) ? p.projections.slice() : [],
    };
    log.debug("sync", "snapshot.complete boundary staged", {
      epoch,
      revision: cseq,
      projections: p.projections,
    });
    // tryInstall sets authoritativeReady + marks the recovery boundary inside
    // its atomic batch when ALL three participants are staged + validated.
    tryInstall(owner);
  });
  registerAuxiliaryListeners(es, gen);
  es.onopen = () => {
    markTreeSeen();
    // O3 Finding 2: re-baseline the tree delivery ordinal on every successful
    // (re)open. connect() already resets treeLastDeliveryOrdinal for the
    // manual-reconnect path (line ~828); this covers NATIVE EventSource auto-
    // reconnect (the browser reuses this EventSource but opens a NEW HTTP
    // connection, so the server restarts its ordinal while the client's
    // baseline was stale). Guarded by gen so a superseded connection's onopen
    // does not clobber the current baseline.
    if (gen === treeGen) treeLastDeliveryOrdinal = -1;
    // L1 t1: socket established → pure connection-latency delta.
    treeT1 = performance.now();
    if (treeT0) recordLatency("tree", "open", treeT1 - treeT0);
    backoff = 1000; // healthy — reset backoff
    setState("status", "live");
    // A reconnect (not the first open) means the stream dropped and came back —
    // typically a vh restart/self-update. Re-check the version so a new build
    // surfaces the reload toast immediately instead of on the next poll.
    if (everOpened) checkVersionNow();
    everOpened = true;
  };
  es.onerror = () => {
    // EventSource auto-retries while CONNECTING; we only step in once it gives
    // up (CLOSED), with backoff, so a flaky network / daemon restart self-heals.
    setState("status", "reconnecting");
    // C4: a transport error on this connection means its coherent capture (if
    // pending) will never complete — cancel the blocked owner immediately so
    // covered handlers resume, rather than waiting for the deferred connect()
    // to do it. (connect()'s treeGen++ also cancels; this is the prompt,
    // contract-named release path. Safe: a stale owner may settle itself but
    // never clears a newer owner.)
    //
    // C-F2: bump treeGen BEFORE canceling. cancelPendingOwner resolves
    // owner.promise immediately (waitForTree=false); the deferred connect()'s
    // own treeGen++ lands `backoff` ms later. Without this bump, a suspended
    // covered waiter resumes with the generation unchanged, PASSES its post-
    // await gen check, and applies its live reducer on the CLOSED transport's
    // pre-capture baseline (brief stale-baseline churn before the reconnect
    // re-baselines — no permanent loss, since the cursor advance suppresses
    // server replay). Bumping here makes the resumed waiter FAIL its gen check
    // instead; the live event is then replayed once on the fresh baseline after
    // the deferred reconnect. es is already CLOSED → no listener fires on the
    // intermediate gen, so an extra bump outside connect() is harmless (the
    // counter is purely a listener-invalidation stamp).
    if (es && es.readyState === EventSource.CLOSED) {
      treeGen++;
      cancelPendingOwner();
      log.warn("sync", "tree stream closed → reconnecting", { backoff });
      clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    }
  };
}


// === connect() auxiliary listener registration (decomposition Stage 1) ======
// Extracted VERBATIM from connect() — the CONTIGUOUS auxiliary cohort: the
// pins.* fast-path reducers, the watchdog transport heartbeat (ping), the
// session.* detail reducers (coveredAwait against a pending C4 owner), and the
// daemon-detected notice alerts (transient; no cursor advance, in-app + OS
// delivery). Only the addEventListener registrations were relocated; no
// callback body changed.
//
// Synchronous by contract (registration only, no async, no Promise return).
// `gen` is THIS connection's captured generation token, passed by value; the
// callbacks read `gen` for the stale-entry / post-await recheck guards and the
// live module-scope `treeGen` exactly as the inline registrations did. No
// connect()-local state other than `es`/`gen` is captured, so there is no ctx.
function registerAuxiliaryListeners(es: EventSource, gen: number): void {
  // Both frames are emitted on this Stream-1 (tree) connection. They carry NO
  // SSE `id:` line (both transient — reconnect catches up via pins.snapshot),
  // so there is no cursor to advance and no shared-resume interaction. They are
  // disjoint from tree/detail state (the pins facade owns the pin signals),
  // so they are NOT subject to treeSnapshotDecoding serialization or the busy
  // gate: a pins frame during an archive or a tree decode still applies (pins
  // are worker-wide, independent of any one project's archive scope). Only the
  // connection-generation guard (ignore frames from a superseded connection) and
  // the liveness clock apply — mirroring the discipline of the other listeners.
  // Validation + the revision-monotonicity guard live inside the facade.
  es.addEventListener("pins.snapshot", (e) => {
    if (gen !== treeGen) return;
    markTreeSeen();
    let raw: unknown;
    try {
      raw = JSON.parse((e as MessageEvent).data);
    } catch (err) {
      log.warn("sync", "malformed pins.snapshot frame", { err });
      return;
    }
    applyPinsSnapshot(raw);
  });
  es.addEventListener("pins.updated", (e) => {
    if (gen !== treeGen) return;
    markTreeSeen();
    let raw: unknown;
    try {
      raw = JSON.parse((e as MessageEvent).data);
    } catch (err) {
      log.warn("sync", "malformed pins.updated frame", { err });
      return;
    }
    applyPinsUpdated(raw);
  });
  // labels.* — the worker-wide grouping+tagging authority. Same transient
  // contract as pins.* (no `id:` line, not in the replay ring; reconnect catches
  // up via labels.snapshot). Disjoint from tree/detail state (the labels facade
  // owns its signals), so they are NOT subject to treeSnapshotDecoding
  // serialization or the busy gate — only the connection-generation guard and
  // the liveness clock apply, mirroring the pins.* listeners above. Validation +
  // the revision-monotonicity guard live inside the facade.
  es.addEventListener("labels.snapshot", (e) => {
    if (gen !== treeGen) return;
    markTreeSeen();
    let raw: unknown;
    try {
      raw = JSON.parse((e as MessageEvent).data);
    } catch (err) {
      log.warn("sync", "malformed labels.snapshot frame", { err });
      return;
    }
    applyLabelsSnapshot(raw);
  });
  es.addEventListener("labels.updated", (e) => {
    if (gen !== treeGen) return;
    markTreeSeen();
    let raw: unknown;
    try {
      raw = JSON.parse((e as MessageEvent).data);
    } catch (err) {
      log.warn("sync", "malformed labels.updated frame", { err });
      return;
    }
    applyLabelsUpdated(raw);
  });
  // Transport-only: refresh treeLastSeen (and the debug mirror) but NOT
  // treeContentSeen, so a ping-only stream (transport alive, zero content) lets
  // the content clock age out and the watchdog's tree content-stall branch
  // fires. The Stream1 mirror of Lane C's session ping listener. (No gen guard
  // here, matching the prior behavior: a ping is a pure transport heartbeat, so
  // letting a superseded connection's ping refresh the transport clock is
  // harmless — the replacement seeds a fresh clock at construction, and only
  // treeContentSeen — refreshed solely by content listeners, which DO gen-guard
  // — drives the content-stall decision.)
  es.addEventListener("ping", () => markTreeTransportSeen()); // heartbeat for the watchdog
  for (const kind of ["session.upsert", "session.delete"]) {
    es.addEventListener(kind, async (e) => {
      // Gen guard at entry (mirrors the TREE_STREAM_KINDS listener) — a stale
      // frame must not trigger markTreeSeen or checkTreeOrdinalGap before any
      // downstream gen re-check.
      if (gen !== treeGen) return;
      markTreeSeen();
      const ev = e as MessageEvent;
      // O3: parse compound SSE id — globalSeq for cursor, ordinal for gap.
      const { globalSeq: seq, ordinal } = parseSSEID(ev.lastEventId);
      // Invariant 1 (Stream1): delivery-ordinal gap detection. Checked BEFORE
      // advancing treeLastDeliveryOrdinal so the gap is measured from the prior
      // baseline.
      checkTreeOrdinalGap(ordinal, kind);
      // checkTreeOrdinalGap MAY have triggered connect(true) → treeGen++ → this
      // connection is superseded. Drop cleanly.
      if (gen !== treeGen) return;
      if (ordinal > treeLastDeliveryOrdinal) treeLastDeliveryOrdinal = ordinal;
      if (isGateActive()) {
        // Deferred — Stream 1 advances the resume cursor but does not mutate.
        advanceCursor(seq);
        markBusyDirty();
        return;
      }
      // C4: serialize against a pending coherent owner (capture the EXACT owner
      // ref via coveredAwait; await it; recheck gen; run reducer + cursor
      // SYNCHRONOUSLY to completion — no second await). applySnapshot (run
      // inside the coherent install batch) WHOLESALE-REPLACES state.sessions
      // and sets cursor=seq; a live session event applied during staging would
      // be clobbered and the cursor regressed when the baseline installs.
      // coveredAwait returns null on the fast path (no owner + no decode) so
      // event floods keep zero microtask latency.
      const wait = coveredAwait(gen);
      if (wait) await wait;
      // Generation re-check: the connection may have been replaced during the
      // wait. The entry guard ran before the await, so drop the stale
      // continuation here before any state effect.
      if (gen !== treeGen) return;
      // The busy gate may have activated during the wait — defer the same way
      // the synchronous entry path does (advance cursor, latch dirty).
      if (isGateActive()) {
        advanceCursor(seq);
        markBusyDirty();
        return;
      }
      applyTreeFrame(kind, seq, ev.data, applySessionEvent);
    });
  }
  // Daemon-detected alerts (transient; no cursor advance). In-app + OS delivery.
  es.addEventListener("notice", (e) => {
    markTreeSeen();
    try {
      handleNotice(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore malformed notice */
    }
  });
}


// === connect() tree-stream listener registration (decomposition Stage 2) =====
// Extracted VERBATIM from connect() — the tree-stream event cohort: the
// standalone tree.op delta listener and the TREE_STREAM_KINDS message-event
// loop (status / activity.*/ lastAgent.set / permission.*/ question.* /
// unread.*) forwarded to applyMessageEvent. Only the addEventListener
// registrations were relocated from their inline positions in connect(); no
// callback body changed. tree.op was registered before snapshot.complete and
// the TREE_STREAM_KINDS loop was registered after registerAuxiliaryListeners;
// both now register together here at tree.op's former source position (the
// loop was removed from between registerAuxiliaryListeners and notice, leaving
// notice contiguous with the auxiliary call). Every cohort event name is
// distinct from all other listeners (the C4 baseline trio snapshot /
// tree.snapshot / snapshot.complete, the auxiliary cohort, and notice), so
// consolidating them at one registration site has no dispatch-order effect
// (EventSource fires per-name listeners in registration order, and each name
// has exactly one listener); the full set is pinned by stream1Registration.
//
// Synchronous by contract (registration only, no async, no Promise return).
// `gen` is THIS connection's captured generation token, passed by value; the
// callbacks read `gen` for the stale-entry / post-await recheck guards and the
// live module-scope `treeGen` exactly as the inline registrations did. No
// connect()-local state other than `es`/`gen` is captured, so there is no ctx.
function registerTreeStreamListeners(es: EventSource, gen: number): void {
  es.addEventListener("tree.op", async (e) => {
    markTreeSeen();
    const ev = e as MessageEvent;
    // F4 + O3: parse compound SSE id — globalSeq for cursor, ordinal for gap.
    const { globalSeq: seq, ordinal } = parseSSEID(ev.lastEventId);
    // Invariant 1 (Stream1): delivery-ordinal gap detection.
    checkTreeOrdinalGap(ordinal, "tree.op");
    if (gen !== treeGen) return; // gap-check resync superseded this connection
    if (ordinal > treeLastDeliveryOrdinal) treeLastDeliveryOrdinal = ordinal;
    if (isGateActive()) {
      advanceCursor(seq);
      markBusyDirty();
      return;
    }
    // C4: serialize against a pending coherent owner (capture the EXACT owner
    // ref via coveredAwait; await it; recheck gen; run the reducer + cursor
    // SYNCHRONOUSLY). A delta op applied during staging would be wiped by the
    // coherent seed (seedTreeStore wholesale-replaces treeMap) inside the
    // install batch; awaiting the owner guarantees the op applies AFTER the
    // baseline, as the live tail.
    const wait = coveredAwait(gen);
    if (wait) await wait;
    if (gen !== treeGen) return;
    if (isGateActive()) {
      advanceCursor(seq);
      markBusyDirty();
      return;
    }
    try {
      const op = decodeTreeOp(JSON.parse(ev.data));
      if (op) {
        applyTreeOpStore(op);
        advanceCursor(seq);
      }
    } catch (err) {
      log.warn("sync", "malformed tree.op frame", { err, seq });
    }
  });
  for (const kind of TREE_STREAM_KINDS) {
    es.addEventListener(kind, async (e) => {
      // Test-only drop hook: silently ignore the next N events BEFORE
      // markTreeSeen/reconcile, simulating "events lost below SSE but the
      // connection stays OPEN" — the exact silent-loss class. Decremented
      // BEFORE any state effect so a dropped event leaves NO trace.
      if (treeDropNextN > 0) {
        treeDropNextN--;
        return;
      }
      markTreeSeen();
      const ev = e as MessageEvent;
      // O3: parse compound SSE id — globalSeq for cursor, ordinal for gap.
      const { globalSeq: seq, ordinal } = parseSSEID(ev.lastEventId);
      // Invariant 1 (Stream1): delivery-ordinal gap detection. Checked BEFORE
      // advancing treeLastDeliveryOrdinal so the gap is measured from the prior
      // baseline.
      checkTreeOrdinalGap(ordinal, kind);
      if (gen !== treeGen) return; // gap-check resync superseded this connection
      if (ordinal > treeLastDeliveryOrdinal) treeLastDeliveryOrdinal = ordinal;
      if (isGateActive()) {
        // Deferred — Stream 1 advances the resume cursor but does not mutate.
        advanceCursor(seq);
        markBusyDirty();
        return;
      }
      // C4: serialize against a pending coherent owner (coveredAwait — same
      // contract as the session.upsert listener above: capture the exact owner,
      // await, recheck gen, run reducer + cursor synchronously).
      const wait = coveredAwait(gen);
      if (wait) await wait;
      if (gen !== treeGen) return;
      if (isGateActive()) {
        advanceCursor(seq);
        markBusyDirty();
        return;
      }
      applyTreeFrame(kind, seq, ev.data, applyMessageEvent);
    });
  }
}


// === tree=2 expand (§8) =====================================================
// Expand a node in the server-owned flat map: fetch all pages of its direct
// children from GET /vh/tree/children, emitting a `node.children` op per page
// (the terminal page flips the parent's `loaded` flag, §7.2). The stale-cursor
// restart (§8.3) and the F1 fix (drop obsolete residents before restart) live
// in treeOps.fetchChildren; this is just the real-network wiring of the injected
// TreeFetcher. Single-flight per node id.
//
// Reached from the TreeStateView onToggle. Collapse is client-only
// (treeState.collapseTreeNode drops loaded descendants, keeps the placeholder,
// flips loaded:false per §8.4) — no network.
const treeExpandInFlight = new Set<string>();
export async function expandTreeNode(id: string): Promise<void> {
  if (!id) return;
  if (treeExpandInFlight.has(id)) return; // single-flight
  treeExpandInFlight.add(id);
  try {
    const dir = projectDir();
    // Real TreeFetcher: GET /vh/tree/children?dir=&id=&cursor=, gzip64-decode
    // (server maybeCompressSnapshot wraps payloads ≥ 2 KiB when z=1), map to the
    // treeOps ChildrenResponse shape.
    const fetcher: TreeFetcher = async (_dir, nodeId, cursor) => {
      const params = new URLSearchParams({
        dir,
        id: nodeId,
        z: "1",
      });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/vh/tree/children?${params}`);
      if (!res.ok) {
        log.warn("sync", "tree=2 children fetch failed", {
          id: nodeId,
          status: res.status,
        });
        // Treat a transport failure as an empty terminal page so fetchChildren
        // stops cleanly; the parent's loaded flag is NOT flipped (hasMore stays
        // false but no nodes). A subsequent toggle retries.
        return { parentId: nodeId, nodes: [], hasMore: false };
      }
      const raw = await res.json();
      const decoded = await decodeSnapshot<{
        parentId?: string;
        nodes?: unknown[];
        hasMore?: boolean;
        cursor?: string | null;
        staleCursor?: boolean;
        detail?: Snapshot;
      }>(raw);
      // B (completion): the server ships a page-scoped detail bundle
      // (ExpandChildrenWithDetail) alongside the structural page. Install it via
      // the scoped installer so the expanded children get session/GateFacts/
      // activity/lastAgents/currentVerbs + global Q/P/unread. MERGE (page IDs as
      // frontier scope) — preserves buried detail; no deletion from omission.
      //
      // F4 (C4 barrier): this detail install must honor the coherent-capture
      // barrier just like ownerAwareApply below — otherwise an expand HTTP
      // resolving while a coherent capture is pending runs applyScopedSnapshot
      // unguarded, regressing the cursor (applyScopedSnapshot's unconditional
      // cursor set at reconcile.ts:239 vs tryInstall's non-ratcheting
      // advanceCursor at tree-transport.ts:211) and clobbering scope-overlap ids with older
      // coherent data. Defer the apply onto the pending owner's promise and
      // recheck treeGen (drop if superseded by a reconnect). Mirrors :1489.
      const detail = decoded.detail;
      if (detail) {
        const ownerNow = pendingOwner;
        if (
          ownerNow &&
          !ownerNow.legacy &&
          !ownerNow.settled &&
          ownerNow.generation === treeGen
        ) {
          void ownerNow.promise.then(() => {
            if (ownerNow.generation !== treeGen) return; // superseded by reconnect
            applyScopedSnapshot(detail);
          });
        } else {
          applyScopedSnapshot(detail);
        }
      }
      return {
        parentId: decoded.parentId ?? nodeId,
        nodes: (decoded.nodes ?? []) as any[],
        hasMore: !!decoded.hasMore,
        cursor: decoded.cursor ?? null,
        staleCursor: !!decoded.staleCursor,
      } satisfies ChildrenResponse;
    };
    // C4 named async exception — point-HTTP expansion deferral. The HTTP
    // request proceeds normally; immediately before APPLYING each returned tree
    // mutation, capture the current coherent owner. If one is pending, defer
    // the APPLICATION (not the request) until that owner settles, then
    // revalidate the generation before applying. This prevents a coherent
    // seedTreeStore (wholesale treeMap replace inside the install batch) from
    // wiping just-applied expand children; the children land on the seeded
    // coherent map as the live tail. Deferred applies chain on the SAME owner
    // promise, so they fire in registration (attach) order — fetchChildren's F1
    // stale-cursor restart (node.remove for appliedIds, then fresh page-0
    // children) is preserved. If a coherent seed wipes the parent, the
    // P1-A backfill (expandedButUnloadedIds) re-expands it; the gen recheck
    // drops a superseded expand's apply entirely.
    const ownerAwareApply = (op: TreeOp): void => {
      const ownerNow = pendingOwner;
      if (
        ownerNow &&
        !ownerNow.legacy &&
        !ownerNow.settled &&
        ownerNow.generation === treeGen
      ) {
        // Defer the application until the owner settles.
        void ownerNow.promise.then(() => {
          if (ownerNow.generation !== treeGen) return; // superseded by reconnect
          applyTreeOpStore(op);
        });
        return;
      }
      applyTreeOpStore(op);
    };
    await fetchChildren(ownerAwareApply, fetcher, dir, id);
  } catch (err) {
    log.warn("sync", "tree=2 expand error", { id, err: String(err) });
  } finally {
    treeExpandInFlight.delete(id);
  }
}


export function _markTreeSeenForTest(ms?: number): void {
  // Seed BOTH clocks so a test marking the tree "healthy" gets a realistic
  // dual-clock state (a content-stall check sees a fresh treeContentSeen, not a
  // stale/0 placeholder that would either false-positive or false-negative the
  // watchdog). Mirrors the dual-clock markTreeSeen.
  const t = ms ?? Date.now();
  treeLastSeen = t;
  treeContentSeen = t;
}

// getTreeGen — read-only peek at the current tree-stream connection generation.
// Consumed by ./stream's periodicResyncTick (periodic-resync attribution: it
// captures genBefore = getTreeGen() before resyncTree, then compares after to
// detect whether resyncTree bumped the generation — i.e. actually opened a new
// connection). The periodic machinery STAYS in ./stream; this module owns treeGen
// (connect/onerror are the only bumpers). Read-only — no caller mutates treeGen
// through this accessor.
export function getTreeGen(): number {
  return treeGen;
}

// --- Test-only accessors for the seq-gap drop-N regression test -------------
// NOT wired into any production path. Used by vitest to arm the __dropNextN
// hook and reset the gap baseline between tests.
export function _setTreeDropNextNForTest(n: number): void {
  treeDropNextN = n;
}
export function _getTreeLastSeqForTest(): number {
  return treeLastDeliveryOrdinal;
}
export function _resetTreeGapStateForTest(): void {
  treeLastDeliveryOrdinal = -1;
  treeDropNextN = 0;
}
