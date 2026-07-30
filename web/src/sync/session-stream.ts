// The Stream 2 (active-session messages) lifecycle, extracted from ./stream per
// the invariant audit §6c. Owns the session EventSource, its listeners, the
// sesGen connection-generation token, sesCursor resume cursor, the in-flight
// snapshot/batch decode gates (sesSnapshotDecode / sesSnapshotDecoding /
// pendingBatch), Stream2's liveness clocks (sessionLastSeen /
// sessionContentSeen and their mark* helpers), the session-only L1 latency
// stamps (recordSessionHydrate / recordSessionFetchSplit), applySessionSnapshot,
// and the open/close lifecycle (openSessionStream / closeSessionStream).
//
// Cross-module seams (deliberate, minimal):
//   - applyMessageEvent (from ./reducers): the reducer. Called with
//     trackCursor=false — LOAD-BEARING (Stream 2 must NEVER advance Stream 1's
//     shared resume cursor; regresses the "busy session shows idle" class if
//     violated). See invariant audit §3e.
//   - recordLatency (from ./stream): shared tree+session L1 helper; the tree
//     side stays in ./stream with the Stream 1 listeners.
//   - getExpectSessionSnap / setExpectSessionSnap / maybeResolveReconcile
//     (from ./stream): the busy-gate handshake over expectSessionSnap. The flag
//     itself STAYS in ./stream (paired with expectTreeSnap by reconcileBusy);
//     session-stream peeks/pokes it through accessors so the handshake stays a
//     single-owner mutation surface.
//
// sesGen ownership decision: sesGen MOVES here. It was bumped only by
// closeSessionStream + openSessionStream's open(), both of which now live in
// this module; leaving it in ./stream would make the facade the nominal owner
// of a token it never bumps (misleading). The bump-before-close ordering (audit
// §3a: sesGen++ MUST precede es.close()) is preserved verbatim in both sites.
// ./history.ts's getSesGen() import was repointed at this module; ./stream
// re-exports getSesGen to preserve the existing `stream.getSesGen()` test API
// and the sync.ts barrel.
//
// Liveness accessors (getSesId / isSessionClosed / getSessionLastSeen /
// getSessionContentSeen) are exposed for ./health's watchdogTick — that module
// evaluates each stream's clock independently and must peek Stream 2's state
// without owning it.
//
// No top-level side effects: only `let` / `const` / function declarations. The
// stream ↔ session-stream import cycle (stream imports openSessionStream etc.;
// session-stream imports applyMessageEvent / recordLatency / accessors) is
// TDZ-safe — every cross-module read happens inside listener/reducer bodies at
// runtime, never at module-eval time.
import { produce } from "solid-js/store";
import type { Snapshot } from "../types";
import { prependMessagesIfAbsent } from "../lib/reduce";
import { log } from "../lib/log";
import { setState, projectDir } from "./store";
import { isGateActive, currentGateEpoch, markBusyDirty } from "../busy";
import { decodeSnapshot, decodeMessagesBatch } from "./decode";
import {
  deriveMessageWindow,
  resetPageInFlight,
  markPageDirty,
  isPageDirtyingKind,
} from "./history";
import { applyMessageEvent } from "./reconcile";
import {
  recordLatency,
  getExpectSessionSnap,
  setExpectSessionSnap,
  maybeResolveReconcile,
} from "./stream";

// Two INDEPENDENT liveness clocks — the dead-but-OPEN Stream2 bug (a frozen
// transcript with the `updating` pulse lit and no reconnect) came from a single
// shared `lastSeen` that Stream1's 15s server ping kept fresh forever, so the
// watchdog's `Date.now() - lastSeen > STALE_MS` could NEVER age out for a dead
// Stream2 while the tree was healthy. Each stream now owns its own clock and the
// watchdog evaluates each independently.
//   sessionLastSeen — Stream2 (active-session messages). Drives the Stream2
//                     stale-but-OPEN watchdog branch → forced fresh-snapshot
//                     reconnect. 0 = "never seen / just reset" → treated as
//                     not-stale (like the old code's `lastSeen > 0` guard), so a
//                     not-yet-open or just-reconnected Stream2 gets a fresh
//                     deadline instead of inheriting a stale timestamp.
//                     (treeLastSeen — Stream1's clock — stays in ./stream.)
let sessionLastSeen = 0;
// Content-vs-transport split for Stream2 liveness (Lane C). sessionLastSeen
// above is refreshed by BOTH the 15s server ping AND content events, so a
// dead-but-OPEN Stream2 whose transport stays alive (pings flow) but delivers
// ZERO content keeps sessionLastSeen fresh forever — the watchdog never trips
// and the frozen transcript sits with no recovery signal (the operator's
// most-hit "reload helps" issue). sessionContentSeen closes that gap: refreshed
// ONLY by genuine Stream2 content (snapshot / message.* / onopen), NEVER by
// ping. The watchdog's Stream2 branch reconnects when EITHER clock ages out.
// See CONTENT_STALE_MS (in ./health) for the threshold rationale.
//
// DESIGN DEBATE OUTCOME (broaden-to-both — Stream1 SINCE MIRRORED):
// Stream1 (treeLastSeen) HAD the SAME ping/content conflation (its ping
// listener calls markTreeSeen), so a content-stall on the tree was also
// masked. Lane C originally deferred the Stream1 mirror: the operator's pain
// was Stream2 (frozen transcript — no tree-freeze reports), Stream1 is
// backstopped server-side by runStatusReconcile (SR60 emits a fresh content
// event every ≤60s) while Stream2 message content has NO such backstop, and
// the red-test's tree control was intentionally ping-only. That deferred half
// has SINCE LANDED (6a00d61 "detect content-stall on the tree stream via a
// content-only liveness clock"): Stream1 now has its own content-only clock
// (treeContentSeen — refreshed by snapshot / tree.snapshot / tree.op /
// snapshot.complete / pins.* / session.upsert+delete / TREE_STREAM_KINDS /
// notice / onopen, NEVER by ping), and the watchdog's tree branch reconnects
// when EITHER clock ages out. Both streams now carry a content-only clock;
// this sessionContentSeen is the Stream2 instance of the symmetric design. See
// ./stream's treeContentSeen block + the Lane C packet.
let sessionContentSeen = 0;
// markSessionSeen updates Stream2's liveness clocks: BOTH the transport clock
// (sessionLastSeen) AND the content clock (sessionContentSeen). Called from
// Stream2's CONTENT listeners (snapshot, message.*, onopen) and the open()
// construction seed. The ping listener calls markSessionTransportSeen instead
// (transport only) so a content-stall ages out sessionContentSeen even while
// pings keep sessionLastSeen fresh. No reactive mirror — Stream2 health
// surfaces through `refreshing[id]` and the watchdog, not the global status dot.
function markSessionSeen() {
  const now = Date.now();
  sessionLastSeen = now;
  sessionContentSeen = now;
}
// markSessionTransportSeen refreshes the transport clock ONLY (the 15s server
// ping). It deliberately does NOT touch sessionContentSeen, so a ping-only
// stream (transport alive, zero content) lets the content clock age out and the
// watchdog reconnects via the content-stall branch. This is the split that
// unmasks the dead-but-OPEN Stream2 the operator's single transport+content
// clock hid.
function markSessionTransportSeen() {
  sessionLastSeen = Date.now();
}

// --- Feature 3: connection-vs-first-snapshot latency diagnostic (L1, FE-only) -
// (shared L1 header lives in ./stream with recordLatency; the two helpers below
// are session-stream-only unions.)
// recordSessionHydrate writes the session-stream `hydrate` L1 stamp (kept
// separate from recordLatency because its value is a number|"warm"|undefined
// union, not a rounded ms). number = cold session, messages.loaded delta ms;
// "warm" = first snapshot already had gate.messagesLoaded===true (no fetch
// needed); undefined = cold and waiting for messages.loaded (clears any stale
// value from a prior connection so the UI shows the in-progress wait).
function recordSessionHydrate(value: number | "warm" | undefined): void {
  setState(
    "connLatency",
    "session",
    "hydrate",
    typeof value === "number" ? Math.max(0, Math.round(value)) : value,
  );
}
// recordSessionFetchSplit writes the session-stream `fetchMs`/`reconcileMs` L1
// stamps — the daemon-side split of `hydrate` (only present on a COLD session
// that fired messages.loaded): fetchMs = upstream OpenCode GET round-trip,
// reconcileMs = daemon SetSessionMessages. undefined = not reported for this
// connection yet (older daemon omits the fields on the wire; a warm session
// never fires messages.loaded; a cold fetch is still in flight). Cleared on
// each (re)open's first snapshot so a stale value from a prior connection can't
// leak. Reads defensively — the payload is JSON, fields optional on the wire.
function recordSessionFetchSplit(fetchMs: number | undefined, reconcileMs: number | undefined): void {
  setState(
    "connLatency",
    "session",
    "fetchMs",
    typeof fetchMs === "number" ? Math.max(0, Math.round(fetchMs)) : undefined,
  );
  setState(
    "connLatency",
    "session",
    "reconcileMs",
    typeof reconcileMs === "number" ? Math.max(0, Math.round(reconcileMs)) : undefined,
  );
}

let sesT0 = 0;
let sesT1 = 0;
let sesSnapDone = false;
// L1 hydrate stamps (session stream only). sesFirstSnap = first-snapshot
// arrival time (hydrate t0); sesHydrating = the first snapshot was cold
// (gate.messagesLoaded===false) so a later messages.loaded closes the window.
let sesFirstSnap = 0;
let sesHydrating = false;
// In-flight messages.batch decodes keyed by sessionID. The batch payload is
// application-compressed (gzip+base64) and its decode is ASYNC (native
// DecompressionStream); EventSource fires the next event (messages.loaded) as
// soon as the batch listener RETURNS — i.e. before the decode resolves.
// Without coordination messages.loaded would flip messagesDelivered (the reveal
// gate) before the batch content staged → flash of empty content at reveal.
// The batch listener stashes its decode promise here; the messages.loaded /
// messages.error listener awaits any pending entry for the session before
// flipping the gate. Cleared as each batch lands (try/finally in the listener).
const pendingBatch = new Map<string, Promise<void>>();
// In-flight gzip64 snapshot decode for the CURRENT session connection. A warm
// open ships the transcript compressed (server maybeCompressSnapshot); the
// decode is ASYNC (native DecompressionStream). applySessionSnapshot
// MERGES snapshot items via prependMessagesIfAbsent (live always wins —
// never overwrites a resident entry), so a mid-decode message.upsert/
// part.upsert is NOT clobbered in body. The gate stays load-bearing for
// the non-merge side-effects: messageWindows[id] is wholesale-set, the
// delivered flag flips, and messages[id] is lazily inited — those must
// still serialize behind the decode for deterministic ordering.
// Promise-gate exactly like pendingBatch: the shared
// message-kind listener awaits this before processing ANY live event for the
// session. Connect-time only (a snapshot decode is ms-scale) and bounded to one
// (the current connection's). Reset on each (re)open. sesSnapshotDecoding is
// the cheap boolean the firehose path checks to avoid a microtask when no decode
// is in flight (message.upsert/part.upsert floods must stay zero-latency).
let sesSnapshotDecode: Promise<void> = Promise.resolve();
let sesSnapshotDecoding = false;

// === Stream 2: active-session messages ======================================
// message/part events for ONLY the open session. The FIRST open of a session
// takes the fresh-snapshot path (no cursor) so the initial state + cold fetch
// land; subsequent RETRIES (same session, same selection) pass a local cursor
// (sesCursor) so the server replays missed deltas from the ring instead of
// re-shipping the full transcript — this is what kills the reopen re-ship
// amplifier (10 reconnects/3min → +5MB in the live study). Switching sessions
// resets sesCursor (via closeSessionStream) so a NEW session always gets a
// fresh snapshot. Self-retries on error.
let ses: EventSource | null = null;
let sesId = "";
let sesRetry: number | undefined;
// sesBackoff: exponential backoff for Stream2's manual CLOSED-reopen, mirroring
// Stream1's backoff (stream.ts ~1862). The native EventSource does NOT honor
// `retry:` on a fatal CLOSED — that governs only the internal CONNECTING retry —
// so a CLOSED storm would otherwise reopen every 1500ms (Phase 3-F). Doubles per
// consecutive CLOSED failure, capped at 15s, reset to 1500ms on a healthy open.
let sesBackoff = 1500;
// sesCursor: the last-received event seq on the CURRENT session stream. Passed
// as cursor= on retry so the server takes the replay branch (deltas from the
// ring) instead of the fresh-snapshot branch (full transcript re-ship). This
// is a Stream2-LOCAL cursor — it is NOT state.cursor (the SHARED cursor Stream1
// uses for its resume). trackCursor:false still holds: Stream2 never writes
// state.cursor. Reset to 0 in closeSessionStream (session switch / close) so a
// new session always starts fresh; preserved across retries (same session).
let sesCursor = 0;
// sesGen: Stream2 connection-generation token. Incremented on EVERY open /
// reopen / close / selection-switch. Captured in every Stream2 listener so a
// callback from a SUPERSEDED connection (closed, replaced, switched-away — or a
// slow decode whose source connection was torn down) is ignored: it must NOT
// refresh the replacement's sessionLastSeen clock or run state effects. This is
// what prevents a dead-but-closing Stream2's in-flight frames from masking the
// freshly-constructed replacement's liveness. The captured value is compared
// against the live sesGen at listener ENTRY (synchronous, before markSessionSeen
// or any store write).
let sesGen = 0;
// getSesGen — narrow read-only peek over the transport-owned sesGen token, for
// the history concern (./history.ts runPageFetchLoop response gate). The
// history module rechecks sesGen after its fetch await to discard a stale page
// merged after a session switch / connection teardown (audit §3a: bump-before-
// close + post-await recheck). Exposed as an accessor rather than exporting
// sesGen directly so ownership stays here (the transport bumps/clears it;
// history only peeks). Hoisted function declaration → no TDZ for the runtime-
// only session-stream ↔ history import cycle (history calls getSesGen() only
// inside loadOlder/runPageFetchLoop, never at module-eval time).
export function getSesGen(): number {
  return sesGen;
}

// Health accessors for ./health's watchdogTick — that module evaluates each
// stream's liveness independently and must peek Stream2's transport + clock
// state without owning it. Kept narrow (read-only) so health can never mutate
// the session lifecycle.
export function getSesId(): string {
  return sesId;
}
export function isSessionClosed(): boolean {
  return !ses || ses.readyState === EventSource.CLOSED;
}
export function getSessionLastSeen(): number {
  return sessionLastSeen;
}
export function getSessionContentSeen(): number {
  return sessionContentSeen;
}

export function closeSessionStream() {
  clearTimeout(sesRetry);
  // Invalidate any in-flight listeners from the outgoing connection: bump the
  // generation so a stale callback (e.g. a late frame already queued before
  // close() propagated) can't refresh sessionLastSeen or mutate the store.
  sesGen++;
  ses?.close();
  ses = null;
  // Drop the warm silent-swap indicator for the session being closed: if we
  // switch away before its first snapshot lands, its `refreshing` flag would
  // otherwise never be cleared (that connection's snapshot listener is gone),
  // leaking a permanent dot on the row.
  if (sesId) setState("refreshing", sesId, false);
  sesId = "";
  // Reset Stream2's local resume cursor: a session switch (or close) must start
  // fresh (no cursor → server takes the snapshot branch). Preserved across
  // retries of the SAME session (the retry path calls open() directly, not
  // closeSessionStream, so sesCursor survives and enables replay-based resume).
  sesCursor = 0;
  // Phase 4: clear ALL in-flight historical-page requests on connection
  // teardown. A page in flight belongs to the outgoing connection (its
  // flight.gen was captured against THIS sesGen); after the bump above those
  // pages would be discarded by the response gate anyway, but dropping them
  // explicitly here also clears the loadingOlder UI flag via loadOlder's
  // finally block as the in-flight promises settle. resetPageInFlight() with
  // no arg clears the whole map (no session owns a page after teardown).
  resetPageInFlight();
  // Reset Stream2's liveness clock: a not-yet-open / about-to-be-replaced
  // Stream2 must NOT inherit a stale timestamp and be classified stale before
  // it has had a chance to fire. 0 = "never seen" → watchdog treats it as
  // not-stale (gives the next open() a fresh deadline). Both clocks (transport
  // AND content) reset together so a replacement connection's content-stall
  // deadline is seeded fresh by open().
  sessionLastSeen = 0;
  sessionContentSeen = 0;
  // Phase 3-F: a session switch starts the next session's CLOSED-reopen backoff
  // fresh (per-session backoff does not carry across session switches).
  sesBackoff = 1500;
}

// applySessionSnapshot applies a Stream-2 (active-session) snapshot to the store.
// Extracted from the EventSource `snapshot` closure so the Slice C partial-
// snapshot contract — a hydrating snapshot (gate.messagesLoaded===false) must NOT
// mark the session delivered — is unit-testable. The connection-side bookkeeping
// (markSessionSeen + gen guard, latency) stays in the listener; this is the pure
// reconciliation.
export function applySessionSnapshot(id: string, snap: Snapshot) {
  const items = (snap.messages?.[id] as any[]) || [];
  // MERGE-IF-ABSENT (live always wins): a Stream-2 snapshot is a point-in-time
  // read; a live tail that landed via message.upsert/part.upsert (or a fresher
  // prior snapshot) must NOT be clobbered when a STALE reconnect/reconcile
  // snapshot arrives afterward. The decode-window serialization at the listener
  // (sesSnapshotDecoding, stream.ts:~2186) protects live events landing DURING
  // the gzip64 decode; THIS guard closes the residual gap — live data ALREADY in
  // the store when a stale snapshot lands. Reuses prependMessagesIfAbsent (the
  // Phase-4 historical-page idiom): insert snapshot items that are ABSENT, NEVER
  // touch an existing byId entry. Cold/warm first hydrate is unaffected —
  // messages[id] is empty so every item is absent (equivalent to the old
  // buildMessages wholesale-replace). A seq/revision guard was considered but
  // rejected: the store tracks no per-session last-applied seq (only the shared
  // global cursor), and Snapshot.seq is a per-connection emitter counter for the
  // tree stream (not a session-stream freshness comparable against live
  // message-event seqs), so insert-if-absent is the minimal surgical fix.
  setState(
    produce((s) => {
      if (!s.messages[id]) s.messages[id] = { order: [], byId: {} };
      prependMessagesIfAbsent(s.messages[id], items);
    }),
  );
  // Phase 3 (transcript windowing): populate the resident-window state from the
  // server's bounded-projection meta. This is the Stream-2 (active-session)
  // snapshot path, so it must populate messageWindows[id] just like the
  // messages.batch case and refreshOpenSessions do — without it the Phase-4
  // "Load older" button would never appear for the active session after a warm
  // snapshot. Back-compat: a pre-Phase-1 server omits snap.messageWindows AND
  // ships the whole transcript → deriveMessageWindow yields {hasOlder:false}
  // (correct: unbounded server, nothing older to fetch).
  setState("messageWindows", id, deriveMessageWindow(items, snap.messageWindows?.[id]));
  // Mark delivered ONLY when the snapshot's gate says the daemon has the FULL
  // history (messagesLoaded !== false). Slice C async hydration sends a PARTIAL
  // snapshot immediately (before the upstream fetch completes) with
  // messagesLoaded=false — keep the loading UI up; the messages.loaded event (or
  // a later re-snapshot) flips this. `undefined` (older daemon without the gate
  // field) stays delivered to preserve back-compat. An explicit false must
  // ACTIVELY clear a stale delivered=true (e.g. after a daemon restart / epoch
  // change while the session was open) — otherwise the empty-order snapshot
  // renders "delivered-and-empty" instead of "loading".
  const loaded = snap.gate?.[id]?.messagesLoaded;
  if (loaded === false) {
    setState("messagesDelivered", id, false);
    // Slice C "hydration attempt started": a partial snapshot (messagesLoaded
    // ===false) is the client-side signal that fires for BOTH openSession-driven
    // hydration AND a Stream-2 reconnect retry (which does NOT call openSession).
    // Clear any stale messagesError here so the chat's reveal gate does not show
    // the "select again to retry" hint while a retry is ALREADY in flight —
    // revealed() = ready() && (delivered() || messageFailed()) would otherwise
    // release on the stale failure. If this retry ALSO fails, messages.error
    // re-sets the flag (the messages.error case above). This is the single
    // correct reset point: openSession has no reset (it would miss the reconnect
    // path), and the daemon has no messages.started event (only messages.loaded
    // / messages.error — pkg/state/store.go), so a proactive clear here is the
    // only mechanism. Mirrors the else-branch clear below.
    setState(
      produce((s) => {
        delete s.messagesError[id];
      }),
    );
  } else {
    setState("messagesDelivered", id, true); // true OR undefined (older daemon) → delivered
    // A delivered snapshot supersedes a prior background-hydration failure
    // (e.g. retry after error, or a Stream-2 reconnect): clear the error so the
    // chat's reveal gate stops treating this session as "failed/partial".
    setState(
      produce((s) => {
        delete s.messagesError[id];
      }),
    );
  }
}

export function openSessionStream(id: string, force = false) {
  // `force` bypasses the "already open" early-return so a caller can demand a
  // FRESH authoritative snapshot even when the selected session's Stream-2
  // EventSource is healthy. Used by reconcileBusy() on the outermost busy
  // release: without it, an archive/unarchive WITH a selected session would
  // never re-request the session snapshot (the EventSource is still OPEN), so
  // expectSessionSnap stays true and the overlay only clears via the 15s safety
  // timeout — the exact UX this feature exists to fix. force=true → skip the
  // early-return → closeSessionStream() tears down the existing connection →
  // open() recreates the EventSource fresh.
  if (!force && id === sesId && ses && ses.readyState !== EventSource.CLOSED) return;
  closeSessionStream();
  // No project selected → nothing to stream (and no cwd bridge). Guards both
  // the no-project state and a stray selection cleared before a project lands.
  if (!id || !projectDir()) return;
  sesId = id;
  const open = () => {
    if (sesId !== id) return;
    // Bump the connection generation so listeners captured by any prior open()
    // of THIS selection (a retry) or a superseded selection are ignored. The
    // captured `gen` is checked at every listener ENTRY — a stale callback from
    // a closed/replaced Stream2 must NOT refresh sessionLastSeen or run state
    // effects (the dead-but-OPEN masking bug). closeSessionStream() already
    // bumped for the switch/force path; this bump covers the retry path (where
    // open() runs directly from the sesRetry timer, not via openSessionStream).
    const gen = ++sesGen;
    ses?.close();
    sesT0 = performance.now(); // L1 t0: session-stream connection attempt
    sesT1 = 0;
    sesSnapDone = false;
    sesFirstSnap = 0; // L1 hydrate: reset per (re)open
    sesHydrating = false;
    sesSnapshotDecode = Promise.resolve(); // no in-flight decode at (re)open
    sesSnapshotDecoding = false;
    // Warm silent-swap: this (re)open is showing cached/stale message state
    // until this connection's first authoritative snapshot lands. Arm the
    // per-session refresh indicator; the snapshot listener clears it (and
    // closeSessionStream clears it on switch-away). Set per (re)open so a
    // reconnect retry re-arms it.
    setState("refreshing", id, true);
    // Cursor-based resume: on a retry (same session, sesCursor > 0), pass the
    // last-received seq as cursor= so the server replays missed deltas from the
    // ring instead of re-shipping the full transcript. On the first open of a
    // session (sesCursor === 0, just reset by closeSessionStream), no cursor is
    // sent → the server takes the fresh-snapshot branch. This mirrors Stream1's
    // cursorParam construction. The cursor is sesCursor (Stream2-local), NOT
    // state.cursor (the shared cursor Stream1 owns).
    const cursorParam = sesCursor > 0 ? `cursor=${sesCursor}&` : "";
    ses = new EventSource(`/vh/stream?${cursorParam}sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}&z=1`);
    // Seed Stream2's liveness deadline from construction (mirrors Stream1's
    // markTreeSeen() right after `new EventSource`): a connection that NEVER
    // fires any event (silent from the start) must still be aged out after
    // STALE_MS rather than hang forever. A connection that does fire refreshes
    // this via markSessionSeen() in its listeners. closeSessionStream() reset
    // this to 0; open() gives it a fresh "now" baseline so it is NOT stale.
    markSessionSeen();
    log.debug("sync", "session stream connect", { id });
    ses.addEventListener("snapshot", (e) => {
      // Gen guard: ignore frames from a superseded connection BEFORE touching
      // the clock or the store.
      if (gen !== sesGen) return;
      markSessionSeen();
      // Track Stream2's local cursor from the SSE id field so the next retry
      // can pass cursor= for replay-based resume. The snapshot's seq is stamped
      // by writeRaw as the SSE id. Using max guards against any out-of-order
      // delivery (shouldn't happen, but defensive).
      const seq = Number((e as MessageEvent).lastEventId);
      if (seq > sesCursor) sesCursor = seq;
      let raw: any;
      try {
        raw = JSON.parse((e as MessageEvent).data);
      } catch (err) {
        // Stream-2 never advances the shared resume cursor (trackCursor:false),
        // so a malformed session snapshot is a clean log + drop. The connection
        // stays open; the per-session refresh indicator and reconcile overlay
        // (expectSessionSnap) self-heal via the next well-formed snapshot or the
        // 15s reconcile safety timeout — resolving them here would be dispatch/
        // state-machine surgery, out of scope for parse hardening.
        log.warn("sync", "malformed session snapshot frame", { err });
        return;
      }
      // L1 t2: stamp `snap` on FRAME ARRIVAL, before any decode. The window
      // measures pure transport (server compute + serialize + tunnel) — the
      // bottleneck this feature targets. Including the client-side gzip64 decode
      // (ms-scale local CPU) would muddy the transport signal the L1
      // instrumentation exists to surface. Same `now` bounds both the snap
      // delta and the hydrate t0.
      const first = !sesSnapDone;
      const now = performance.now();
      if (first) {
        sesSnapDone = true;
        if (sesT1) recordLatency("session", "snap", now - sesT1);
        sesFirstSnap = now;
      }
      // Global busy gate: while a busy scope is active, suppress store mutation.
      // The ONE expected fresh snapshot (from openSessionStream during
      // reconciliation) is allowed through; all other frames are deferred.
      if (isGateActive() && !getExpectSessionSnap()) {
        // Deferred Stream-2 frame — neither mutate the store nor advance the
        // shared cursor (Stream 2 never advances it). Latch dirty so the
        // coalesced refresh catches up.
        markBusyDirty();
        return;
      }
      const wasExpected = getExpectSessionSnap();
      if (wasExpected) setExpectSessionSnap(false);
      // Apply the decoded snapshot: hydrate stamping (needs snap.gate) + clear
      // the per-session refresh indicator + reconcile. The server gzip64-wraps
      // the snapshot when z=1 AND it exceeds the size threshold (a warm open of
      // a loaded session — the megabyte transcript). Small/cold/messageless
      // snapshots ship raw (no `encoding`) and skip the async decode.
      const applySnap = (snap: Snapshot) => {
        if (first) {
          // L1 hydrate: warm-vs-cold read from the snapshot's gate. A warm
          // session (gate.messagesLoaded!==false) already has the full history,
          // so messages.loaded never arrives → stamp "warm"; a cold session
          // (gate.messagesLoaded===false) clears any stale value so the UI
          // shows the in-progress upstream-fetch wait until messages.loaded.
          const cold = snap.gate?.[id]?.messagesLoaded === false;
          sesHydrating = cold;
          recordSessionHydrate(cold ? undefined : "warm");
          // Clear any stale fetch/rec split from a prior connection. They only
          // land when THIS connection's messages.loaded arrives (cold session);
          // a warm snapshot never fires it, so they must read "—" until then.
          recordSessionFetchSplit(undefined, undefined);
        }
        // Authoritative snapshot for THIS connection landed — the cached/stale
        // render is now superseded; clear the per-session refresh indicator
        // BEFORE reconciling so the row's .dot.refreshing drops in the same
        // reactive tick the fresh data paints. Idempotent on later snapshots.
        setState("refreshing", id, false);
        applySessionSnapshot(id, snap);
      };
      // Compressed path: async decode, gated behind sesSnapshotDecode so live
      // message/part events in the decode window serialize behind it (the
      // shared listener awaits it) — applySessionSnapshot MERGES message bodies
      // via prependMessagesIfAbsent (a mid-decode live event is NOT clobbered in
      // body) but wholesale-sets messageWindows[id] + the delivered flag and
      // lazily inits messages[id], so those side-effects must serialize behind
      // the decode. Until applySnap runs the
      // PRIOR messages stay in the store → no flash-of-empty through the decode
      // window (the reveal gate stays faithful). Raw path: synchronous apply,
      // exactly the legacy behavior (cold small snapshots, zero decode latency).
      //
      // Epoch guard: capture the gate epoch at decode start. If the gate
      // activated (or a new reconcile pass started) during the decode, the
      // epoch mismatches and the stale decode is discarded — it must NOT
      // mutate the store or clear the overlay. If this was the expected
      // snapshot, still resolve so reconcile doesn't wedge (dirty was latched).
      if (raw.encoding === "gzip64") {
        const ep = currentGateEpoch();
        sesSnapshotDecoding = true;
        sesSnapshotDecode = (async () => {
          try {
            const snap = await decodeSnapshot<Snapshot>(raw);
            // Generation re-check (finding #3): the snapshot decode AWAITED, so
            // the connection may have been replaced (sesGen bumped in
            // closeSessionStream/open) while we were decoding. The entry guard
            // cannot catch this — it ran before the await. A superseded decode
            // must NOT apply its snapshot, clear the refresh indicator, or run
            // latency effects: the replacement connection owns the session
            // state now. Supplements (does not replace) the epoch guard below,
            // which separately handles a busy-gate activation mid-await.
            if (gen !== sesGen) return;
            if (ep === currentGateEpoch()) {
              applySnap(snap);
            } else if (isGateActive()) {
              markBusyDirty();
            }
          } finally {
            // Ownership-aware clear: only the CURRENT generation owns the flag.
            // A superseded connection's decode must NOT clear sesSnapshotDecoding
            // while the replacement's decode is still in flight — same cross-
            // reconnect flag-reset race as the tree stream's treeSnapshotDecoding
            // gate. The post-await gen check above prevents a stale APPLY; this
            // guard prevents a stale CLEAR.
            if (gen === sesGen) sesSnapshotDecoding = false;
          }
        })();
        // Resolve after the decode lands (or is queued via microtask for the
        // stale case) — the expected snapshot has been "received".
        if (wasExpected) {
          sesSnapshotDecode.then(() => maybeResolveReconcile());
        }
      } else {
        applySnap(raw);
        if (wasExpected) maybeResolveReconcile();
      }
    });
    ses.addEventListener("ping", () => {
      if (gen !== sesGen) return;
      // Transport-only: refresh sessionLastSeen but NOT sessionContentSeen, so
      // a ping-only stream (transport alive, zero content) lets the content
      // clock age out and the watchdog's content-stall branch fires.
      markSessionTransportSeen();
    });
    // L1 t1: socket established → pure connection-latency delta. Stream 2 had
    // no explicit onopen before; added for the latency diagnostic (and parity
    // with Stream 1's connect/backoff semantics).
    ses.onopen = () => {
      if (gen !== sesGen) return;
      markSessionSeen();
      sesT1 = performance.now();
      if (sesT0) recordLatency("session", "open", sesT1 - sesT0);
      sesBackoff = 1500; // Phase 3-F: healthy open resets the CLOSED-reopen backoff
    };
    for (const kind of ["message.upsert", "message.delete", "part.upsert", "part.delete", "messages.loaded", "messages.error", "messages.batch"]) {
      ses!.addEventListener(kind, async (e) => {
        // Gen guard: ignore frames from a superseded connection BEFORE touching
        // the clock or the store.
        if (gen !== sesGen) return;
        markSessionSeen();
        // Track Stream2's local cursor from the SSE id field (mirrors the
        // snapshot listener). Done BEFORE the gate check so even a deferred
        // (busy-gated) frame advances sesCursor — the event WAS received, so a
        // retry after the gate releases must not replay it.
        {
          const seq = Number((e as MessageEvent).lastEventId);
          if (seq > sesCursor) sesCursor = seq;
        }
        if (isGateActive()) {
          // Deferred Stream-2 frame — neither mutate the store nor advance the
          // shared cursor. Latch dirty so the coalesced refresh catches up.
          markBusyDirty();
          return;
        }
        const ev = e as MessageEvent;
        // Parse the payload once (was inline at applyMessageEvent); reused for
        // the split-timing read below. trackCursor:false — Stream 2 must not
        // advance Stream 1's resume cursor.
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch (err) {
          // Stream-2 never advances the shared cursor; a malformed message/part
          // frame is a clean log + drop. No pendingBatch entry was registered
          // for this frame (it's set up downstream, only for messages.batch
          // AFTER a successful parse), so a later messages.loaded for this
          // session finds no pending decode and opens the reveal gate without
          // wedging.
          log.warn("sync", "malformed session frame", { kind, err });
          return;
        }
        const sid: string | undefined = data?.sessionID;
        // Capture the gate epoch at entry so post-await application points can
        // detect that the gate activated during an await (snapshot decode or
        // batch decode) and refuse to mutate the store.
        const ep = currentGateEpoch();

        // Serialize against an in-flight gzip64 snapshot decode for this
        // connection. applySessionSnapshot MERGES message bodies via
        // prependMessagesIfAbsent (a mid-decode live event is NOT clobbered in
        // body), but wholesale-sets messageWindows[id] + the delivered flag and
        // lazily inits messages[id] — those side-effects must serialize behind
        // the decode. Wait ONLY
        // when a decode is actually in flight — the boolean check is a no-op on
        // the fast path so message.upsert/part.upsert floods keep zero microtask
        // latency. Connect-time only (a snapshot decode is ms-scale).
        if (sesSnapshotDecoding) await sesSnapshotDecode;
        // Generation re-check (finding #3): we just awaited the in-flight
        // snapshot decode — the connection may have been replaced (sesGen
        // bumped) during that wait. The entry guard ran before the await, so
        // drop the stale continuation here before any state effect. Supplements
        // the epoch guard below (which handles a busy-gate activation, not a
        // connection replacement — a sesGen bump does not change the epoch).
        if (gen !== sesGen) return;
        // Epoch guard: the gate may have activated during the snapshot-decode wait.
        if (ep !== currentGateEpoch()) {
          if (isGateActive()) markBusyDirty();
          return;
        }

        // Phase 4 — historical-page dirty-mirror hook. Mark the in-flight
        // historical page dirty ONLY for resurrection-class mutations
        // (message.delete / part.delete / messages.batch — see
        // isPageDirtyingKind) so the response gate (runPageFetchLoop) discards
        // + retries. This is the client mirror of the server's
        // me.liveTouchedBody/me.liveTouchedParts (pkg/state/store.go) — live
        // state always wins, so a page snapshot that raced a resurrection-class
        // mutation is stale.
        //
        // NARROW FILTER: the filter deliberately EXCLUDES message.upsert and
        // part.upsert. The merge is insert-if-not-present (live always wins),
        // so a live upsert CANNOT make a stale page resurrect anything:
        //   - upsert for a NEW tail message: newer than the `before` cursor →
        //     NOT in the page range.
        //   - upsert for an EXISTING message / part: prependMessagesIfAbsent
        //     and upsertPart both leave the live entry untouched.
        // Excluding upserts is what keeps Load-older usable on actively-
        // streaming sessions (a part.upsert flood per streamed token would
        // otherwise exhaust MAX_PAGE_RETRIES and abandon with no merge).
        // messages.loaded/messages.error are also excluded (reveal-gate flips,
        // not content mutations).
        //
        // Placed AFTER the gen+epoch re-checks so a superseded connection or a
        // gate activation during the snapshot-decode await does NOT mark a page
        // dirty for a connection/gate the page no longer belongs to.
        if (sid && isPageDirtyingKind(kind)) {
          markPageDirty(sid);
        }

        // messages.batch is application-compressed (gzip+base64) to cut cold-
        // load hydrate latency over the controller tunnel. The decode is ASYNC
        // (native DecompressionStream), but EventSource fires the next event
        // (messages.loaded) as soon as this listener RETURNS — i.e. before the
        // decode resolves. Without coordination messages.loaded would flip
        // messagesDelivered (the reveal gate, P1-WEB-020) before the batch content
        // staged → flash of empty content at reveal. Promise-gate: stash the
        // decode promise keyed by sessionID; the messages.loaded/messages.error
        // path below awaits any pending entry before flipping the gate. The
        // batch case of applyMessageEvent is UNCHANGED — it receives an
        // already-decoded {sessionID, messages} (same shape as before
        // compression). NOTE: an async listener with NO await on the warm path
        // runs synchronously to completion (async functions only suspend at an
        // awaited expression), so message.upsert/part.upsert floods pay zero
        // microtask latency — only batch (decode) and loaded/error (gate wait)
        // ever await.
        if (kind === "messages.batch") {
          const p = (async () => {
            const decoded = await decodeMessagesBatch(data);
            // Generation re-check (finding #3): the batch decode AWAITED — the
            // connection may have been replaced (sesGen bumped) while decoding.
            // The entry guard ran before the await. A superseded decode must not
            // stage its batch into the store; supplements the epoch guard below.
            if (gen !== sesGen) return;
            // Epoch guard: the gate may have activated during the batch decode.
            if (ep === currentGateEpoch()) {
              applyMessageEvent("messages.batch", Number(ev.lastEventId), decoded, false);
            } else if (isGateActive()) {
              markBusyDirty();
            }
          })();
          if (sid) pendingBatch.set(sid, p);
          try {
            await p;
          } finally {
            if (sid) pendingBatch.delete(sid);
          }
          return;
        }

        // messages.loaded / messages.error: await any in-flight batch decode
        // for this session so the gate opens AFTER content is staged. (Also
        // makes the L1 hydrate timing stamp below include the decode cost —
        // more correct.) If no batch is pending this is a no-op.
        if (sid && pendingBatch.has(sid)) {
          await pendingBatch.get(sid);
        }
        // Generation re-check (finding #3): we just awaited a pending batch
        // decode — the connection may have been replaced (sesGen bumped) during
        // that wait. The entry guard ran before the await. Drop the stale
        // continuation before the latency/reveal stamps and the messages.loaded
        // application below; supplements the epoch guard.
        if (gen !== sesGen) return;
        // Epoch guard: the gate may have activated during the batch-decode wait.
        if (ep !== currentGateEpoch()) {
          if (isGateActive()) markBusyDirty();
          return;
        }

        // L1 hydrate: messages.loaded arrival closes the cold-session
        // upstream-fetch window that `snap` misses. Recorded once per
        // connection — sesHydrating flips off so a duplicate messages.loaded
        // (or one arriving after a warm snapshot, which never set the flag)
        // does not overwrite the stamp. Belongs to THIS connection: the flag
        // and sesFirstSnap are reset in open() and only this connection's
        // (still-open) EventSource fires its listeners, so a torn-down prior
        // connection cannot stamp a stale delta here.
        if (kind === "messages.loaded" && sesHydrating && sesFirstSnap) {
          sesHydrating = false;
          recordSessionHydrate(performance.now() - sesFirstSnap);
          // Split-timing: the daemon reports how much of `hydrate` was the
          // upstream fetch vs the daemon-side reconcile. Read defensively — an
          // older daemon omits fetchMs/reconcileMs (render "—"). Parsed on the
          // same cold-session path as the hydrate stamp (a warm session never
          // reaches here).
          recordSessionFetchSplit(
            typeof data.fetchMs === "number" ? data.fetchMs : undefined,
            typeof data.reconcileMs === "number" ? data.reconcileMs : undefined,
          );
        }
        applyMessageEvent(kind, Number(ev.lastEventId), data, false);
      });
    }
    ses.onerror = () => {
      // Gen guard: a superseded connection's error must not arm a retry on
      // behalf of the new (current) connection — the current connection owns
      // its own retry scheduling via its own onerror.
      if (gen !== sesGen) return;
      if (ses && ses.readyState === EventSource.CLOSED && sesId === id) {
        // Phase 3-F: exponential backoff (mirrors Stream1 stream.ts ~1862) so a
        // genuine CLOSED storm cannot reopen every 1500ms. Doubles per failure,
        // capped at 15s, reset on a healthy open (ses.onopen). sesCursor resume
        // (f54ffff4) is preserved — backoff gates the REOPEN cadence, not the
        // cursor logic.
        clearTimeout(sesRetry);
        sesRetry = window.setTimeout(open, sesBackoff);
        sesBackoff = Math.min(sesBackoff * 2, 15_000);
      }
    };
  };
  open();
}
