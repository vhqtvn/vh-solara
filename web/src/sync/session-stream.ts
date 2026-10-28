// The Stream 2 (active-session messages) lifecycle, extracted from ./stream per
// the invariant audit §6c. Owns the session EventSource, its listeners, the
// sesGen connection-generation token, sesCursor resume cursor, the per-session
// last-applied cursor memory (lastKnownSesCursor — the cursor-loss-fix
// send-side state; see its block comment below), the in-flight
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
import { createEffect, createRoot, on } from "solid-js";
import type { Snapshot } from "../types";
import { prependMessagesIfAbsent, appendPartSuffix, utf8ByteLength, type PartAppendPayload } from "../lib/reduce";
import { log } from "../lib/log";
import { setState, projectDir, selectedId } from "./store";
import { sessionWorking } from "./selectors";
// CONTENT_STALE_MS (./health): the busy-edge re-arm's content-clock threshold.
// This ADDS a session-stream → health reverse edge to the existing health →
// session-stream edge (openSessionStream etc.) — the same documented TDZ-safe
// cycle discipline health ↔ stream already follow (stream imports watchdogTick
// from health while health imports STALE_MS from stream): the imported const is
// read ONLY inside function bodies at runtime, never at module-eval time.
import { CONTENT_STALE_MS } from "./health";
import { isGateActive, currentGateEpoch, markBusyDirty } from "../busy";
import { decodeSnapshot, decodeMessagesBatch } from "./decode";
import {
  deriveMessageWindow,
  resetPageInFlight,
  markPageDirty,
  isPageDirtyingKind,
} from "./history";
import { applyMessageEvent, bumpUpdating } from "./reconcile";
import { stampCompletionIfIdle } from "./reducers";
import {
  recordLatency,
  getExpectSessionSnap,
  setExpectSessionSnap,
  maybeResolveReconcile,
} from "./stream";
import { captureDiagEntry } from "./diaglog";
import {
  noteSessionFallbackArmed,
  noteSessionLife,
  noteSessionStamp,
  noteSessionStreamOpen,
  type StreamOpenReason,
} from "./stream-open-diag";
import { countRecovery, countSnapshotBytes } from "./recovery-reasons";
import { recordStreamDrop } from "./weaklink";
import { noteLivenessFrame } from "./liveness";
import { requestRecovery, noteSessionConverged } from "./cascade";

// === Slice 3: part.append suffix streaming client opt-in ====================
//
// partDeltaEnabled is the client kill-switch for the negotiated suffix wire
// format (spec §3). When true (default), the SPA appends part_delta=1 to the
// /vh/stream query string so the server emits seq-stamped part.append suffix
// frames for streaming text/reasoning (O(L²)→O(L) wire cost — slice 2
// server-side). When false, the param is omitted and the connection keeps the
// byte-identical full part.upsert wire shape — a one-reconnect rollback with NO
// server change (the stale cached PWA protection mirrors z=1). Disable by
// flipping the initial value (a source edit + redeploy, or a future runtime
// config); _setPartDeltaEnabledForTest exists for the disabled-path test.
let partDeltaEnabled = true;
export function isPartDeltaEnabled(): boolean {
  return partDeltaEnabled;
}

// --- Slice 3: part.append frame-batch buffer --------------------------------
//
// pendingAppends accumulates part.append suffixes between flushes. A burst
// arriving in one event-loop tick coalesces into a SINGLE reactive setState
// (one store mutation signal per tick, not one-per-suffix) — BUT this
// coalescing only engages for a SAME-TASK burst (the lane-5 unit /
// MockEventSource path, which fires multiple part.append callbacks
// synchronously in one task). Under NATIVE EventSource delivery each event
// dispatches as a SEPARATE task and the post-task microtask drains the buffer
// (cardinality 1) before the next part.append callback, so the batch does NOT
// coalesce native events into one flush (measured lane-6: ledger [1,1,1,1],
// max=1, commit 693433e) — i.e. it is NOT a production reactive-churn
// reduction. The queue is retained for its NON-BATCHING responsibilities:
// gen-filtering superseded-connection frames, mismatch aggregation across the
// buffer (offset mismatch → cursorless re-snapshot), bumpUpdating, and non-
// append drain ordering (drainPendingAppends). The flush is a microtask
// (queueMicrotask) — it runs at the end of the current task, sub-ms, so the
// FIRST suffix of a same-task burst applies promptly (instant first-token
// latency preserved). appendFlushScheduled prevents multiple microtask
// schedulings.
//
// Each entry captures the connection-generation token (`gen`) at buffer time so
// flushAppends can drop frames from a superseded connection (sesGen bumped
// during the tick). Cleared on closeSessionStream (a torn-down connection's
// pending suffixes belong to the outgoing stream; the replacement starts fresh).
interface PendingAppend {
  gen: number;
  sid: string;
  // The frame's globalSeq (cursor space) — captured at receipt so the flush
  // can advance the per-session last-known cursor for frames whose suffix
  // actually APPLIED (cursor-loss fix; see lastKnownSesCursor).
  seq: number;
  payload: PartAppendPayload;
}
let pendingAppends: PendingAppend[] = [];
let appendFlushScheduled = false;

// Parse a compound SSE id ("globalSeq.ordinal") or legacy numeric id.
// O3: the ordinal is a per-connection delivery counter for Inv1 gap detection;
// the global seq is for sesCursor/resume bookkeeping. Legacy (no dot) → ordinal 0.
function parseSSEID(id: string): { globalSeq: number; ordinal: number } {
  const dot = id.indexOf(".");
  if (dot < 0) return { globalSeq: Number(id), ordinal: 0 };
  return {
    globalSeq: Number(id.slice(0, dot)),
    ordinal: Number(id.slice(dot + 1)),
  };
}

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
// pings keep sessionLastSeen fresh. No reactive mirror — Stream2 health never
// surfaces in the global status dot (isStale reads the TREE clock only); it is
// healed by the Stream2 watchdog branch. The `refreshing[id]` flag the
// open/snapshot/close paths arm and clear is state-only — NO UI render reads
// it (the per-row .dot.refreshing indicator died with the old SessionTree
// rewrite; see store.ts's `refreshing` readership note).
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
// F9 round-2b caveat: a Map keeps only the LATEST registration per session —
// a second same-session batch frame OVERWRITES the entry while the first
// decode is still in flight (the wait above then serializes against the
// wrong batch). Cursor-advance correctness under that concurrency lives in
// pendingBatchSeqs/claimSessionCursorApplied below (seq-set truth, not this
// map); this map keeps its original purpose — the reveal-gate serialization.
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
// F3 (remote-latency brief 2026-10-12): consecutive CONNECTING-state onerror
// count for the CURRENT session EventSource — the Stream2 twin of tree-
// transport's connectingFails. A sustained CONNECTING loop (tunnel down: every
// attempt 502s at the controller instantly) never reaches CLOSED, so the
// native retry would run forever at the advertised `retry:` cadence. After
// SES_CONNECTING_GIVEUP consecutive failures we close the ES and fall into
// the manual CLOSED-reopen backoff (sesBackoff, ×2 → 15s cap). Reset on a
// healthy open and on every fresh ES construction.
let sesConnectingFails = 0;
const SES_CONNECTING_GIVEUP = 3;
// sesCursor: the last-received event seq on the CURRENT session stream. Passed
// as cursor= on retry so the server takes the replay branch (deltas from the
// ring) instead of the fresh-snapshot branch (full transcript re-ship). This
// is a Stream2-LOCAL cursor — it is NOT state.cursor (the SHARED cursor Stream1
// uses for its resume). trackCursor:false still holds: Stream2 never writes
// state.cursor. Reset to 0 in closeSessionStream (session switch / close) so a
// new session always starts fresh; preserved across retries (same session).
let sesCursor = 0;
// lastKnownSesCursor — per-session LAST-APPLIED cursor memory (card
// task-2026-10-28t17-34-52-pwa-session-cursor-loss-fix, capture-1 §Q3: the
// "second recovery" cursor-loss defect). closeSessionStream zeroes the LIVE
// sesCursor at the START of every fresh open; if that open's authoritative
// snapshot never APPLIES (suspend raced it mid-decode — the sesGen guard at
// the gzip64 continuation discards the in-flight decode — or delivery never
// landed), the zero persists in the suspended/parked state and EVERY later
// open of the session (B3 reveal-resume, B13 retry-ladder, B5/B7 preserving
// reopens) pays the cursorless full-snapshot price again. This map is the
// send-side repair:
//   - It advances ONLY where content was successfully APPLIED (post
//     generation-guard, post busy-gate/epoch-guard — never from receipt of a
//     deferred frame or an in-flight/discarded decode), so resuming from it is
//     loss-free: everything ≤ the stored seq is already in the store. A
//     part.append offset-mismatch latches the session against incremental
//     claims (ALL capped sites — round-4b uniform gating) until a session
//     snapshot re-applies (mismatchLatchedSids, round-4 F1 — see its block
//     comment below for the resume-subsume corner that made the flush-local
//     gate insufficient, and claimSessionCursorApplied for the uniform gate).
//   - F8 strict-reading boundary (round-5b): no INCREMENTAL claim covers
//     un-applied content; the snapshot floor-raise inherits the store merge
//     policy as the definition of applied (see applySnap's round-5b recorded
//     boundary below).
//   - It is NEVER zeroed by closeSessionStream / the B12 silence fallback /
//     the B10 offset-mismatch recovery (they zero the LIVE cursor only).
//   - openSessionES sends it in place of a live sesCursor of 0, within the
//     same page life (module state — a reload correctly starts fresh).
// Safety rests on the server fallback contract (health.ts ~221–223 /
// reopenSessionStreamPreservingCursor's no-loss note): correctness never
// depends on the cursor being recent — a stale stored cursor degrades to ring
// replay (duplicates merged away by prependMessagesIfAbsent) or the server's
// own fresh fallback (hasCursor && !replayOK). Deliberately-fresh opens
// (openSessionStream force=true recoveries, B9/B10/B11/B15; the B12
// silence-fallback confirmation) stay CURSORLESS: their repair semantically
// requires the server's fresh-snapshot branch (a replayed range would repeat
// the same mismatch / the same interest-filtered silence and defeat the
// recovery), so openSessionES takes an explicit `fresh` flag for them.
// Project-switch hygiene: switchProject wipes s.messages while session ids
// stay addressable, so a cursor memory from the outgoing project must never
// feed a replay against the wiped store. The REQUIRED invalidation is at the
// TRUE boundary — switchProject calls resetLastKnownSesCursors() on every dir
// change (both its with-project and no-project branches; see actions.ts). The
// openSessionES dir-observation clear below is retained ONLY as
// defense-in-depth: it cannot be the primary mechanism, because a ZERO-OPEN
// excursion (A→""→A with the session stream closed, A→B with no session
// selected, a session-less popstate) never runs openSessionES under the
// changed dir — the change is never observed, and the stale cursor would be
// sent on return against the wiped store, stranding the pre-cursor transcript.
const lastKnownSesCursor = new Map<string, number>();
let lastKnownCursorDir: string | null = null;
// noteSessionCursorApplied — the single advance point for the per-session
// cursor memory. Monotonic per session id; ignores non-positive seqs (legacy
// ids / parse fallbacks) and empty ids.
function noteSessionCursorApplied(id: string, seq: number): void {
  if (!id || !(seq > 0)) return;
  const prev = lastKnownSesCursor.get(id) ?? 0;
  if (seq > prev) lastKnownSesCursor.set(id, seq);
}
// resetLastKnownSesCursors — the project-boundary invalidation for the cursor
// memory (review F1/F2/F3): called by switchProject on EVERY dir change, in
// BOTH the with-project and the no-project branch. switchProject wipes
// s.messages on every dir change while session ids stay addressable, so any
// remembered cursor from the outgoing project must die AT the boundary — a
// later re-select must take the fresh-snapshot branch, never a replay against
// a wiped store. The openSessionES dir-observation clear stays as
// defense-in-depth (it would catch a dir change that somehow bypassed
// switchProject).
export function resetLastKnownSesCursors(): void {
  lastKnownSesCursor.clear();
}
// pendingBatchSeqs — F9 round-2b (data_integrity): per-session frame seqs of
// UNRESOLVED messages.batch decodes. pendingBatch keeps only the LATEST
// registration per session (a second same-session batch frame OVERWRITES the
// entry — two batches can be concurrently unresolved: the ring records
// messages.batch events, a session can be cold-published more than once, and
// EventSource fires the next frame as soon as the listener suspends at its
// decode await), so the promise map alone cannot tell a cursor claim "another
// batch below you is still unresolved". This set is the seq-side truth. An
// entry lives from the batch listener's synchronous registration to the
// listener's finally (the decode settled — applied OR discarded), and is
// removed even when the continuation drops at a guard: after the settle, the
// pre-existing safety net owns the dropped range (same-connection frames die
// at the gen guard / defer at the gate; a replacement connection's own
// bootstrap re-covers it).
const pendingBatchSeqs = new Map<string, Set<number>>();
function notePendingBatchSeq(id: string, seq: number): void {
  if (!id || !(seq > 0)) return;
  let s = pendingBatchSeqs.get(id);
  if (!s) {
    s = new Set();
    pendingBatchSeqs.set(id, s);
  }
  s.add(seq);
}
function forgetPendingBatchSeq(id: string, seq: number): void {
  const s = pendingBatchSeqs.get(id);
  if (!s) return;
  s.delete(seq);
  if (s.size === 0) pendingBatchSeqs.delete(id);
}
// claimSessionCursorApplied — the CAPPED advance point for the per-session
// cursor memory (F9 round-2b). The memory may never cover un-applied content:
// while any same-session batch decode is unresolved, the claim advances only
// to min(unresolved seqs) − 1 — never into an unresolved batch's frame seq,
// whose content a mid-decode gen/epoch drop can still discard. Under-advance
// is always safe: the server replays the range and the merge dedups it.
// ignorePendingSeq lets a batch's own apply claim its full seq (its own entry
// is still registered at that moment — the listener's finally has not run).
//
// Round-4b (E2 subsume corner): the mismatch latch is consulted HERE, inside
// the claim, so EVERY capped claim site — the batch apply site, the non-batch
// message-listener tail, and the part.append flush — is gated UNIFORMLY.
// Rounds 1–4 gated only the flush site; the E2 subsume window refuted that
// locality: a drain-time mismatch whose recovery is SUBSUMED by a pending
// resume-mode cascade step bumps no sesGen, so the post-drain gen re-check
// passes and the triggering non-append frame APPLIES and CLAIMS at the
// message-listener tail — advancing the memory past the un-applied mismatched
// seq through a site the flush-local gate never saw. Latch semantics here are
// FULL-SKIP (not cap-below-mismatch), matching the flush site's established
// behavior: the memory freezes at the pre-mismatch value until applySnap —
// the UNGATED authoritative floor-raise (noteSessionCursorApplied, called
// directly there) and the latch-clear point — repairs it. The latch gate and
// the pendingBatchSeqs cap COMPOSE: both only ever reduce or void a claim,
// so under-advance safety holds under any evaluation order.
function claimSessionCursorApplied(id: string, seq: number, ignorePendingSeq = 0): void {
  if (!id || !(seq > 0)) return;
  if (mismatchLatchedSids.has(id)) return;
  const pend = pendingBatchSeqs.get(id);
  if (pend && pend.size > 0) {
    let min = Infinity;
    for (const s of pend) if (s < min && s !== ignorePendingSeq) min = s;
    if (min !== Infinity && seq >= min) seq = min - 1;
  }
  noteSessionCursorApplied(id, seq);
}
// mismatchLatchedSids — round-4 F1 (data_integrity, enumeration E11): the
// per-session CROSS-FLUSH mismatch latch for the cursor-memory incremental
// claims. Rounds 1–3 made that claim's mismatch gate flush-local (t1b-F1: a
// flush that records a mismatch for a session never claims for it), resting on the
// premise that the mismatch's cursorless recovery always runs — bumping
// sesGen and moving every later frame onto a snapshot-first recovery
// connection. The round-4 counterexample refuted that premise: a
// sentinel-timeout cascade pass (health.ts's watchdog) holds a PENDING
// {session:'resume'} step whose reopen connection sends cursor= with NO
// tree=2 (openSessionES's URL), so the server's replay branch ships NO
// trailing session snapshot (stream_http.go gates it on treeEmitter != nil)
// — that step can never converge (only applySnap converges it) and pends up
// to the 15s cascade timeout. A part.append mismatch in that window hits the
// COALESCE branch: the pending session step SUBSUMES the direct (skipped —
// no sesGen bump, no cursorless re-snapshot) and S2 cannot supersede (its
// implied session step is pending). A LATER clean flush then passed every
// flush-local gate and claimed past the un-applied mismatched seq; the next
// close + unforced reopen sent that cursor and stranded the mismatched range
// (pre-fix that reopen sent cursor=0 → healed). This latch carries the
// mismatch across flushes:
//   - SET at flush-mismatch time (every sid in flushAppends's mismatchSessions).
//   - CLEARED only by applySnap — a session snapshot that APPLIES is the
//     authoritative repair point: a session snapshot at a higher seq contains
//     the mismatched range's content by construction (panel-verified
//     content-inclusion), so cursor-memory claims above it are legitimate.
//   - GATES EVERY capped claim (round-4b uniform gating, enforced INSIDE
//     claimSessionCursorApplied): a latched session's incremental claims —
//     the batch apply site, the non-batch message-listener tail, and the
//     part.append flush — are voided until repaired, not just the flush's.
//     (Rounds 1–4 gated the flush site only; the E2 subsume window — a
//     drain-time mismatch subsumed by a pending resume step, gen unchanged,
//     triggering non-append frame applies and CLAIMS at the listener tail —
//     refuted the flush-local gate. The snapshot-apply site is deliberately
//     UNGATED: applySnap calls the RAW noteSessionCursorApplied and then
//     clears the latch, so the repair both raises the floor and reopens the
//     capped claims.)
// Safety: if no snapshot ever applies, the latch freezes the memory at the
// pre-mismatch value — pure under-advance, always safe (a preserving replay
// re-delivers the range; prependMessagesIfAbsent dedups it). Any eventual
// repair (re-triggered mismatch / watchdog / B12 once no pass is in flight
// — the coalesced direct itself is dropped, not re-run: the COALESCE branch
// skips a subsumed direct permanently, cascade.ts:289-321,365-394, and
// nothing re-runs it after the pass completes) opens CURSORLESS → its
// snapshot applies → clears the latch and re-raises the memory
// legitimately. Cascade semantics are deliberately UNCHANGED (panel
// option 1; option 2's directness changes were rejected as
// wider-behavior risk).
const mismatchLatchedSids = new Set<string>();
// sesLastDeliveryOrdinal — O3: per-stream DELIVERY ORDINAL for Inv1 gap
// detection. The server stamps each Stream2-relevant wire event (snapshot +
// message events) with a compound SSE id ("globalSeq.ordinal"); the ordinal is
// a per-connection counter. A gap in this ordinal is DIRECTLY actionable as real
// loss → openSessionStream(id, true). This REMOVES the cross-stream covering
// check (the false-positive source when Stream1's structural events created a
// phantom gap). Reset in closeSessionStream (like sesCursor) so a fresh
// connection starts with no gap baseline. Initialized to -1 so the first event
// (ordinal 0) doesn't trigger a false gap.
let sesLastDeliveryOrdinal = -1;
// sesDropNextN — test-only hook. When > 0, the next N events on the session
// message listener are silently dropped BEFORE markSessionSeen/reconcile,
// simulating "events lost below SSE but the connection stays OPEN." This is
// the deterministic red signal for the drop-N regression test. NEVER set in
// production code — only by _setSesDropNextNForTest from vitest.
let sesDropNextN = 0;
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

// --- Invariant 1: delivery-ordinal gap detection → forced resync ---------------
//
// checkSesOrdinalGap — O3: called on EVERY seq'd Stream2 event (snapshot +
// message.*) with the DELIVERY ORDINAL extracted from the compound SSE id. If
// the ordinal exceeds sesLastDeliveryOrdinal + 1, a real loss occurred (the
// ordinal counts ONLY Stream2-relevant logical source events, so a gap means
// selected-session message events were silently lost below SSE). This REMOVES
// the cross-stream covering check that false-positived when Stream1's structural
// events created a phantom gap. A gap directly → openSessionStream(id, true).
//
// The diag entry is written BEFORE the resync so pre-recovery state is recorded.
// The resync (openSessionStream(id, true)) bumps sesGen and creates a fresh
// EventSource; the current event continues to process on the old gen (it's a
// surviving event whose application is correct — the fresh snapshot MERGEs
// via prependMessagesIfAbsent, live always wins).
function checkSesOrdinalGap(ordinal: number, kind: string): void {
  // Guard: ordinal must be a non-negative finite integer and we must have a
  // prior baseline (sesLastDeliveryOrdinal >= 0 means at least one prior event).
  if (!Number.isFinite(ordinal) || ordinal < 0 || sesLastDeliveryOrdinal < 0) return;
  const expected = sesLastDeliveryOrdinal + 1;
  if (ordinal <= expected) return; // contiguous or out-of-order (existing dedup handles)
  const gap = ordinal - expected;
  // Ordinal gap = DIRECTLY actionable real loss. No covering check.
  const sid = sesId;
  // Slice 1 (webperf): count the forced fresh-snapshot resync by stable
  // reason code (window.__vhSyncDiag).
  countRecovery("seq-gap");
  captureDiagEntry({
    kind: "stall",
    ts: Date.now(),
    trigger: "seq-gap",
    stream: "session",
    sessionId: sid || undefined,
    seqGap: { stream: "session", expected, got: ordinal, missed: gap },
    eventSourceState: {
      tree: 0, // not tracked here; health.ts fills tree state in its own entries
      session: ses?.readyState ?? -1,
    },
  });
  log.warn("sync", "session delivery-ordinal gap → forcing fresh-snapshot resync", {
    id: sid,
    kind,
    expected,
    got: ordinal,
    missed: gap,
  });
  // Force a cursorless fresh-snapshot reconnect. openSessionStream(id, true)
  // bypasses the "already open" guard, closes the old EventSource (sesGen++),
  // and opens a fresh one starting with an authoritative snapshot (MERGE via
  // prependMessagesIfAbsent — live always wins).
  // Slice A (send-net-resilience): the force feeds the convergence cascade —
  // coalesced with any overlapping recovery into ONE pass (AMEND-A5); the
  // direct action runs synchronously when no pass is in flight (unchanged
  // recovery latency).
  if (sid) requestRecovery("seq-gap", () => openSessionStream(sid, true, "recovery-fresh", "seq-gap"), { session: "fresh" });
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
// getSesCursor — read-only peek at Stream2's local resume cursor (the last
// store-seq Stream2 processed: snapshot + message events). Consumed by
// tree-transport's Stream1 seq-gap covering check: if a gap on Stream1 is
// covered by sesCursor, the gap events were message events for the selected
// session that Stream2 received → benign for Stream1.
export function getSesCursor(): number {
  return sesCursor;
}

export function closeSessionStream() {
  clearTimeout(sesRetry);
  // Slice 5b fix: a full close supersedes any armed silence-fallback timer
  // (the fire-side gen guard already stands down, but don't leave a stray
  // wake scheduled against the next connection).
  clearResumeSilenceFallback();
  // A full close supersedes any visibility suspension (Slice 2): the next
  // openSessionStream starts a fresh connection with no resume cursor, and
  // resumeSessionStreamForVisibility must not reopen over it.
  sesSuspended = false;
  // Invalidate any in-flight listeners from the outgoing connection: bump the
  // generation so a stale callback (e.g. a late frame already queued before
  // close() propagated) can't refresh sessionLastSeen or mutate the store.
  sesGen++;
  ses?.close();
  ses = null;
  // Drop the warm silent-swap flag for the session being closed: if we
  // switch away before its first snapshot lands, its `refreshing` flag would
  // otherwise never be cleared (that connection's snapshot listener is gone)
  // and would stay armed in the record forever. No UI renders it (the per-row
  // .dot.refreshing indicator died with the old SessionTree rewrite) — this
  // clear is state hygiene; see store.ts's `refreshing` readership note.
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
  // Reset the seq-gap baseline so the first event on the new connection doesn't
  // trigger a false gap (there's no prior baseline to compare against).
  sesLastDeliveryOrdinal = -1;
  // Phase 3-F: a session switch starts the next session's CLOSED-reopen backoff
  // fresh (per-session backoff does not carry across session switches).
  sesBackoff = 1500;
  // Slice 3: drop any buffered part.append suffixes for the outgoing connection.
  // The sesGen bump above already guarantees flushAppends will reject them (gen
  // mismatch), but clearing here avoids a wasted microtask + produce and keeps
  // the buffer bounded across session switches. The replacement connection
  // starts fresh (cursorless snapshot re-establishes every field's base).
  pendingAppends = [];
  appendFlushScheduled = false;
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
  // Phase-4 historical-page idiom): insert snapshot items that are ABSENT; an
  // existing byId entry is left untouched (live always wins) EXCEPT the
  // upgrade-on-completed path (reduce.ts:123-136), which replaces the resident
  // info when the incoming copy is completed (terminal/immutable — safe against
  // live). Cold/warm first hydrate is unaffected —
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
      // Hydrate the opened session's STRUCTURAL detail (parentID/title/...) from
      // the Stream-2 snapshot. Stream-2 is scope-selected to exactly this session
      // (pkg/state/snapshots.go captureSnapshotLocked: inScope(sid)=messagesFor),
      // so snap.sessions carries this session's authoritative structural row. This
      // is the hydration path for a deep-linked NON-frontier (child) session: the
      // frontier-scoped Stream-1 partial (SnapshotWithTreePartial) ships only
      // frontier detail on cold/reconnect, so a child session's parentID — which
      // isChild() reads via state.sessions[id].parentID — arrives via Stream-2.
      // Without this the composer child-note never renders on a deep link to a
      // subagent session (chat-controls-gating e2e). Find-by-id is the scope-leak
      // guard: only the opened session is ever touched.
      const sessInfo = snap.sessions?.find((x) => x?.id === id);
      if (sessInfo) s.sessions[id] = sessInfo;
      // Cross-stream completion bridge, arrival-path #3 (see the messages.batch
      // twin in reducers.ts): a session snapshot can be the moment a cold
      // session's messages become resident — the daemon already holds the full
      // transcript (e.g. it was open when opencode died mid-generation), so
      // Stream-2's snapshot — not a later messages.batch — delivers the
      // orphaned incomplete tail. Activity for an already-dead session is
      // idle in the boot snapshot and never transitions again, so the
      // discrete-activity bridge cannot fire; stamp here, in the SAME
      // produce() that installs the rows, so the tail's first paint is
      // settled. The epoch gate (server-refreshed activity, not the stale
      // localStorage seed) + the helper's idle guard keep genuinely streaming
      // sessions live.
      if (s.epoch !== "") stampCompletionIfIdle(s, id);
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

export function openSessionStream(id: string, force = false, reason: StreamOpenReason = "other", detail?: string) {
  // `force` bypasses the "already open" early-return so a caller can demand a
  // FRESH authoritative snapshot even when the selected session's Stream-2
  // EventSource is healthy. Used by reconcileBusy() on the outermost busy
  // release: without it, an archive/unarchive WITH a selected session would
  // never re-request the session snapshot (the EventSource is still OPEN), so
  // expectSessionSnap stays true and the overlay only clears via the 15s safety
  // timeout — the exact UX this feature exists to fix. force=true → skip the
  // early-return → closeSessionStream() tears down the existing connection →
  // open() recreates the EventSource fresh. `reason`/`detail` are LOGGING-ONLY
  // (the stream-open diagnostics record); they never branch control flow.
  // S0 gate-(a) session taxonomy → reason mapping:
  //   B1 boot / B4 reveal-fresh ......................... first-open / selection-change
  //   B2 selection-follow, B16 popstate ................. selection-change
  //   B3 visibility reveal .............................. reveal-resume
  //   B5 watchdog-closed, B6 stale-force, B7 sentinel ... watchdog
  //   B8 busy-edge rearm ............................... other (+detail)
  //   B9 seq-gap, B10 offset-mismatch, B11 tail-incomplete, B15 busy reconcile
  //      → recovery-fresh;  B12 silence fallback ....... recovery-fresh
  //   B13 CLOSED retry ladder ........................... retry-ladder
  //   B14 native CONNECTING retries are NOT JS constructions — they surface
  //   via the bounded es-life records only.
  if (!force && id === sesId && ses && ses.readyState !== EventSource.CLOSED) return;
  closeSessionStream();
  // No project selected → nothing to stream (and no cwd bridge). Guards both
  // the no-project state and a stray selection cleared before a project lands.
  if (!id || !projectDir()) return;
  sesId = id;
  // `force` doubles as the cursorless-send flag: a forced recovery demands the
  // server's fresh-snapshot branch (see openSessionES's cursor selection), so
  // it must NOT be answered with a restored last-known cursor. Unforced opens
  // (selection-follow / reveal-moved-selection) DO restore — a re-selected
  // previously-streamed session replays its missed deltas instead of paying
  // the full-snapshot price (same page life only).
  openSessionES(id, reason, detail, force);
}

// === open() extraction (Slice 2 webperf — visibility lifecycle) ==============
// openSessionES — the actual Stream-2 EventSource construction, extracted
// VERBATIM from openSessionStream's former nested `const open = () => {...}`
// closure so the visibility-resume path (resumeSessionStreamForVisibility)
// can re-open THROUGH it directly — exactly like the native CLOSED-retry path
// (ses.onerror → setTimeout(open, …)) — WITHOUT going through
// openSessionStream's closeSessionStream() call, which resets sesCursor=0 and
// would force a cursorless full re-snapshot on every pane reveal. The retry
// seam (open directly, cursor preserved) is the load-bearing property; `id`
// became a parameter (the closure's only non-module capture).
// `fresh` (cursor-loss fix, see lastKnownSesCursor) pins the open CURSORLESS
// for the deliberately-fresh recovery classes — it overrides a restored
// last-known cursor, never a live one (callers that reach here with
// sesCursor>0 keep today's wire shape exactly).
function openSessionES(id: string, reason: StreamOpenReason = "other", detail?: string, fresh = false): void {
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
    // O3 Finding 2: re-baseline the delivery ordinal whenever open() constructs
    // a replacement EventSource. The server restarts its per-connection ordinal
    // on each new HTTP connection (server.go: `var ordinal uint64` is handler-
    // local), so after a CLOSED-retry (this open() running directly from the
    // sesRetry timer, NOT via closeSessionStream) the client would hold a stale
    // HIGH baseline while the server restarts LOW → checkSesOrdinalGap would
    // classify early replacement events as ordinal <= expected → IGNORE real
    // losses among the replay-relevant early events. closeSessionStream already
    // resets this for the switch/force path; THIS reset covers the retry path.
    // ses.onopen below ALSO resets it to cover native EventSource auto-reconnect
    // (which does not call open() at all).
    sesLastDeliveryOrdinal = -1;
    sesT0 = performance.now(); // L1 t0: session-stream connection attempt
    sesT1 = 0;
    sesSnapDone = false;
    sesFirstSnap = 0; // L1 hydrate: reset per (re)open
    sesHydrating = false;
    sesSnapshotDecode = Promise.resolve(); // no in-flight decode at (re)open
    sesSnapshotDecoding = false;
    // Warm silent-swap: this (re)open is showing cached/stale message state
    // until this connection's first authoritative snapshot lands. Arm the
    // per-session refresh flag — state-only, NO UI render reads it (the
    // per-row .dot.refreshing indicator died with the old SessionTree
    // rewrite; see store.ts's `refreshing` readership note). The snapshot
    // listener clears it (and closeSessionStream clears it on switch-away).
    // Set per (re)open so a reconnect retry re-arms it.
    setState("refreshing", id, true);
    // Cursor-based resume: on a retry (same session, sesCursor > 0), pass the
    // last-received seq as cursor= so the server replays missed deltas from the
    // ring instead of re-shipping the full transcript. On the first open of a
    // session (sesCursor === 0, just reset by closeSessionStream), no cursor is
    // sent → the server takes the fresh-snapshot branch. This mirrors Stream1's
    // cursorParam construction. The cursor is sesCursor (Stream2-local), NOT
    // state.cursor (the shared cursor Stream1 owns).
    //
    // Cursor-loss fix (lastKnownSesCursor): a live sesCursor of 0 no longer
    // downgrades the open — when this session had APPLIED content earlier in
    // the page life, the stored last-known cursor is sent in its place (the
    // zeroed-live-cursor state is exactly the parked defect shape: a fresh
    // open whose snapshot never applied). Deliberately-fresh recoveries
    // (`fresh`, e.g. B10 offset-mismatch / B12 silence-fallback) stay
    // cursorless. Project-switch hygiene: the memory belongs to the project
    // dir it was recorded under — switchProject resets it AT THE BOUNDARY
    // (resetLastKnownSesCursors, the required mechanism; the store's messages
    // were wiped there). This dir-observation clear is DEFENSE-IN-DEPTH only:
    // a zero-open excursion never observes the change, which is exactly why
    // the boundary reset exists.
    const dirNow = projectDir();
    if (dirNow !== lastKnownCursorDir) {
      lastKnownSesCursor.clear();
      lastKnownCursorDir = dirNow;
    }
    const rememberedCursor = fresh ? 0 : lastKnownSesCursor.get(id) ?? 0;
    const sendCursor = sesCursor > 0 ? sesCursor : rememberedCursor;
    const cursorParam = sendCursor > 0 ? `cursor=${sendCursor}&` : "";
    // Slice 3: part_delta=1 opts into the KindPartAppend suffix wire format
    // (spec §3), mirroring the z=1 (gzip64) capability flag. Gated behind
    // partDeltaEnabled (isPartDeltaEnabled) so flipping the single flag reverts
    // to legacy full part.upsert for this connection (one-reconnect rollback,
    // no server change).
    const partDeltaParam = isPartDeltaEnabled() ? `&part_delta=1` : "";
    sesConnectingFails = 0; // F3: a fresh ES starts a fresh streak count
    ses = new EventSource(`/vh/stream?${cursorParam}sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}&z=1${partDeltaParam}`);
    // Diagnostics (logging-only): one stream-open record per construction —
    // reason taxonomy + the cursor this open sent. Progress stamps complete
    // later on the SAME record (listeners below). Inert unless the diaglog
    // capture flag is on. The cursor/hadCursor fields read the SENT cursor
    // (sendCursor) — a restored last-known open records the restored value
    // naturally, no special-casing.
    noteSessionStreamOpen({
      generation: gen,
      reason,
      detail,
      sessionId: id,
      cursor: sendCursor > 0 ? sendCursor : 0,
      hadCursor: sendCursor > 0,
    });
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
      // Diagnostics stamps (logging-only, first-write-wins): the session
      // `snapshot` is the first content + first snapshot frame candidate.
      noteSessionStamp(gen, "firstFrameTs");
      noteSessionStamp(gen, "firstSnapshotTs");
      // Slice 1 (webperf): cumulative snapshot bytes received (Stream 2) —
      // the idle-churn cost signal. SSE data length ≈ wire bytes (exact for
      // the gzip64/base64 payloads that dominate).
      countSnapshotBytes("session", ((e as MessageEvent).data ?? "").length);
      // O3: parse compound SSE id — globalSeq for sesCursor resume, ordinal for
      // gap detection. Using max guards against any out-of-order delivery.
      const { globalSeq: seq, ordinal } = parseSSEID((e as MessageEvent).lastEventId);
      // Invariant 1: delivery-ordinal gap detection. Checked BEFORE advancing
      // sesCursor/sesLastDeliveryOrdinal so the gap is measured from the prior baseline.
      checkSesOrdinalGap(ordinal, "snapshot");
      // checkSesOrdinalGap MAY have triggered openSessionStream(id, true) → sesGen++
      // → this connection is superseded. The fresh snapshot from the new
      // connection is authoritative (MERGE via prependMessagesIfAbsent), so
      // drop this frame cleanly.
      if (gen !== sesGen) return;
      if (seq > sesCursor) sesCursor = seq;
      if (ordinal > sesLastDeliveryOrdinal) sesLastDeliveryOrdinal = ordinal;
      let raw: any;
      try {
        raw = JSON.parse((e as MessageEvent).data);
      } catch (err) {
        // Stream-2 never advances the shared resume cursor (trackCursor:false),
        // so a malformed session snapshot is a clean log + drop. The connection
        // stays open; the per-session refresh flag and reconcile overlay
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
      // the per-session refresh flag + reconcile. The server gzip64-wraps
      // the snapshot when z=1 AND it exceeds the size threshold (a warm open of
      // a loaded session — the megabyte transcript). Small/cold/messageless
      // snapshots ship raw (no `encoding`) and skip the async decode.
      const applySnap = (snap: Snapshot) => {
        // Diagnostics stamp (logging-only): first snapshot APPLIED on this
        // connection — the fresh-path catch-up boundary.
        noteSessionStamp(gen, "snapshotAppliedTs");
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
        // Authoritative snapshot for THIS connection landed — clear the
        // per-session refresh flag before reconciling (idempotent on later
        // snapshots). NO UI render reads it (the per-row .dot.refreshing
        // indicator died with the old SessionTree rewrite); readership is
        // this set/clear, the project-switch reset, and the reset-parity
        // unit suites — see store.ts's `refreshing` note.
        setState("refreshing", id, false);
        applySessionSnapshot(id, snap);
        // Cursor memory (cursor-loss fix): the snapshot APPLIED — advance the
        // per-session last-known cursor. applySnap is reached only PAST the
        // generation guard and the busy-gate/epoch guards (raw path: entry
        // guard + not-busy-gated; gzip64 path: post-decode gen + epoch
        // re-checks), so a deferred or discarded decode never advances it.
        // Strictly AFTER applySessionSnapshot (review F8): all four advance
        // sites share strict post-apply ordering — the memory claims content
        // only once the reducer has actually run for it.
        // Round-5b RECORDED BOUNDARY (coordinator adjudication, round-5
        // F1/F2): for the SNAPSHOT path, the remembered-cursor charter's
        // "applied" means "applySnap ran the snapshot through the store's
        // established merge policy" — prependMessagesIfAbsent, live-wins for
        // keyed non-completed residents — NOT "every byte the snapshot
        // carried is now resident". The floor-raise below therefore fires at
        // receipt even when the merge SKIPS content: the known pre-existing
        // gap (a keyed incomplete resident missing a part whose snapshot
        // repair the merge skips — reduce.ts:200-228) stays un-repaired in
        // the store while the memory floor-raises past it. That gap is
        // OUT-OF-SLICE (routed to the separate store-policy card);
        // freeze-until-merged was adjudicated AGAINST (it would livelock the
        // mismatch-recovery loop into re-snapshot storms; the pre-slice
        // parity this preserves is the receipt-time LIVE-cursor advance).
        // Incremental claims (every other advance site) remain STRICTLY
        // applied-only — no incremental claim covers un-applied content.
        // Pinned by the round-5b boundary-pin test in
        // session-cursor-persistence.test.ts.
        // Round-4b ARCHITECTURAL INVARIANT: this is deliberately the RAW
        // noteSessionCursorApplied (authoritative floor-raise + repair), NOT
        // claimSessionCursorApplied — the snapshot-apply site must stay
        // UNGATED by the mismatch latch, because the very next line is the
        // latch's CLEAR point (a snapshot that APPLIED is the repair itself).
        noteSessionCursorApplied(id, seq);
        // Round-4 F1: an authoritative session snapshot APPLIED — the
        // content-inclusion repair point for the mismatch latch (a snapshot
        // at a higher seq contains the mismatched range's content by
        // construction; see mismatchLatchedSids). Clear it so the session's
        // capped claims (all sites, round-4b uniform gating) may resume from
        // this repair point.
        mismatchLatchedSids.delete(id);
        // Slice A (send-net-resilience): a session baseline landed on the
        // current session connection — satisfy the convergence cascade's
        // session step.
        noteSessionConverged();
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
            // must NOT apply its snapshot, clear the refresh flag, or run
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
    registerSessionPingListener(ses, gen);
    // Slice 5 (webperf/F7): the liveness sentinel's correlation listener. The
    // worker broadcasts vh.liveness (no id, transient — EmitTransient bypasses
    // Interest, so a message-filtered session stream receives it too); this
    // listener feeds the frame to the pending-probe matcher in ./liveness.
    // Deliberately does NOT touch the liveness clocks: a liveness echo is not
    // CONTENT (refreshing here would let a periodic probe mask a genuine
    // content stall); only the issuing boundary's onProven refreshes, once
    // per probe. Gen-guarded like every content listener.
    ses.addEventListener("vh.liveness", (e) => {
      if (gen !== sesGen) return;
      noteLivenessFrame((e as MessageEvent).data);
    });
    // L1 t1: socket established → pure connection-latency delta. Stream 2 had
    // no explicit onopen before; added for the latency diagnostic (and parity
    // with Stream 1's connect/backoff semantics).
    ses.onopen = () => {
      if (gen !== sesGen) return;
      // Diagnostics (logging-only, bounded ≥1 per generation): the native/JS
      // lifecycle discriminator — see stream-open-diag.
      noteSessionLife(gen, "onopen", EventSource.OPEN);
      noteSessionStamp(gen, "openTs");
      // O3 Finding 2: re-baseline the delivery ordinal on every successful
      // (re)open. This covers NATIVE EventSource auto-reconnect: the browser
      // reuses this EventSource object but opens a NEW HTTP connection, so the
      // server restarts its ordinal while the client's baseline was stale (high).
      // open() above already reset it for the manual-retry path; this covers
      // the native path (which does NOT call open()). The first event after
      // this re-seeds the baseline (checkSesOrdinalGap returns early when
      // sesLastDeliveryOrdinal < 0, then the listener sets it).
      sesLastDeliveryOrdinal = -1;
      markSessionSeen();
      sesT1 = performance.now();
      if (sesT0) recordLatency("session", "open", sesT1 - sesT0);
      sesBackoff = 1500; // Phase 3-F: healthy open resets the CLOSED-reopen backoff
      sesConnectingFails = 0; // F3: healthy — native retry loop works again
    };
    registerSessionMessageListeners(ses, gen, id);
    ses.onerror = () => {
      // Gen guard: a superseded connection's error must not arm a retry on
      // behalf of the new (current) connection — the current connection owns
      // its own retry scheduling via its own onerror.
      if (gen !== sesGen) return;
      // Diagnostics (logging-only, bounded): onerror readyState=CONNECTING
      // with NO new stream-open record = a NATIVE retry (B14) — the
      // discriminator the captured data needs. At entry so the CONNECTING
      // early return below still observes every attempt.
      noteSessionLife(gen, "onerror", ses ? ses.readyState : -1);
      // F3 CONNECTING-streak takeover (twin of tree-transport's): a sustained
      // CONNECTING failure loop never reaches CLOSED on its own — after
      // SES_CONNECTING_GIVEUP consecutive failures, close the ES and use the
      // bounded manual reopen below.
      if (ses && ses.readyState === EventSource.CONNECTING) {
        sesConnectingFails++;
        if (sesConnectingFails < SES_CONNECTING_GIVEUP) return;
        log.warn("sync", "session stream CONNECTING-fail streak → manual backoff takeover", {
          fails: sesConnectingFails,
          id,
        });
        ses.close(); // now CLOSED-shaped; fall through to the reopen path
      }
      // Cleared on EVERY path through here — including the native-CLOSED
      // branch below (a CLOSED error ends any partial streak too).
      sesConnectingFails = 0;
      if (ses && ses.readyState === EventSource.CLOSED && sesId === id) {
        // Phase 3-F: exponential backoff (mirrors Stream1 stream.ts ~1862) so a
        // genuine CLOSED storm cannot reopen every 1500ms. Doubles per failure,
        // capped at 15s, reset on a healthy open (ses.onopen). sesCursor resume
        // (f54ffff4) is preserved — backoff gates the REOPEN cadence, not the
        // cursor logic.
        // Weak-link baseline (slice 4c): the session transport gave up (CLOSED)
        // — one browser-vantage stream drop. Counted only; never authority.
        recordStreamDrop("session");
        clearTimeout(sesRetry);
        sesRetry = window.setTimeout(() => openSessionES(id, "retry-ladder", "closed-retry"), sesBackoff);
        sesBackoff = Math.min(sesBackoff * 2, 15_000);
      }
    };
}


// === Slice 2 (webperf build1): visibility suspend/resume =====================
//
// A pane hidden by the HOST (docked tab / inactive workspace — CSS visibility
// on a cross-origin iframe, so document.visibilityState stays "visible") must
// not keep an idle Stream-2 burning the tunnel: the content-stale watchdog
// reconnects it every ~130s and each force resets sesCursor → a cursorless
// full snapshot. suspendSessionStreamForVisibility tears the EventSource down
// WITHOUT the cursor reset (the one behavioral difference from
// closeSessionStream), so the reveal replays missed ring deltas instead of
// re-shipping the transcript.
//
// Why forced paths can't defeat the suspension while hidden: every force
// caller (seq-gap / offset-mismatch / tail-incomplete / busy-reconcile /
// watchdog) is EVENT-driven or user-driven, and a suspended pane receives no
// stream events (its ES is closed) and no user input (it is hidden). The
// watchdog/maybeReconnect/resyncTree entries are separately pane-gated in
// ./health. The resume path itself bypasses the openSessionStream guard by
// construction (it calls openSessionES directly, like the native retry).
let sesSuspended = false;

export function suspendSessionStreamForVisibility(): void {
  if (sesSuspended) return;
  sesSuspended = true;
  clearTimeout(sesRetry);
  // Slice 5b fix: a suspended pane's resume must not inherit an armed
  // silence-fallback timer from a pre-hide recovery — the reveal path owns
  // reopening (the gen guard would stand the fire down anyway).
  clearResumeSilenceFallback();
  // Invalidate in-flight listeners (mirrors closeSessionStream's audit-§3a
  // ordering: sesGen++ BEFORE es.close()).
  sesGen++;
  ses?.close();
  ses = null;
  // PRESERVE sesId + sesCursor: the reveal reopens through openSessionES (the
  // retry seam), so cursorParam > 0 → the server takes the ring-replay branch.
  // (closeSessionStream would reset sesCursor=0 here — that is exactly the
  // fresh-snapshot churn this slice removes.)
  // Liveness clocks: left to age. The watchdog is pane-gated while hidden, and
  // openSessionES re-seeds both clocks at construction on reveal
  // (markSessionSeen), so no stale classification can act on them.
  // The suspended connection's buffered part.append suffixes are dropped (gen
  // bump would reject them anyway); the replacement replays from cursor.
  pendingAppends = [];
  appendFlushScheduled = false;
  // A reveal starts the CLOSED-reopen backoff fresh (mirrors closeSessionStream).
  sesBackoff = 1500;
}

export function resumeSessionStreamForVisibility(): void {
  if (!sesSuspended) return;
  sesSuspended = false;
  if (!sesId || !projectDir()) return;
  // Reopen THROUGH the retry seam (NOT openSessionStream, whose
  // closeSessionStream() call would reset sesCursor → cursorless full
  // snapshot). openSessionES preserves the cursor → ring replay. Arms the
  // existing `refreshing[id]` flag (cleared on first snapshot) — no UI
  // render reads it; see store.ts's `refreshing` readership note.
  openSessionES(sesId, "reveal-resume", "visibility-reveal");
}

// === Slice 5 (webperf/F7): sentinel proof refresher + closed-stream reopen ===
//
// markSessionLivenessProof refreshes Stream2's liveness clocks after a
// liveness sentinel probe came back PROVEN (the nonce traversed the full
// worker pipeline to THIS pane). Called from ./health's onProven closure —
// NOT from the vh.liveness listener (a stray/late echo must never refresh a
// clock; only the pending probe's resolution does, exactly once). Equivalent
// to markSessionSeen(): the content clock is the one that matters (the
// boundary that probed was content-stale with transport fresh), and
// re-seeding both keeps the dual-clock invariant "content ≤ transport age"
// trivially intact.
export function markSessionLivenessProof(): void {
  markSessionSeen();
}

// reopenSessionStreamPreservingCursor — the sentinel-timeout + closed-stream
// recovery seam: reopen Stream2 THROUGH the retry seam (openSessionES) so
// sesCursor is PRESERVED and the server takes the ring-replay branch
// (deltas from the ring) instead of a cursorless full snapshot. This is
// ensureSessionStreamLiveForActivity's reopen half without its busy-edge
// counter, exposed for ./health's watchdog:
//   - sentinel timeout (slice 5): pipeline presumed dead → recover WITHOUT
//     paying the full-snapshot cost. No-loss argument identical to the
//     busy-edge re-arm: sesCursor only advances on APPLIED events, so the
//     replay range covers everything in-flight at teardown; the server falls
//     back to a fresh snapshot itself when the cursor is older than the
//     ring (hasCursor && !replayOK) — correctness never depends on the
//     cursor being recent.
//   - closed-stream branch (slice 5b): the watchdog's old
//     openSessionStream(sesId) call routed through closeSessionStream, which
//     RESETS sesCursor=0 — the last cursorless full-snapshot path on the
//     watchdog. Same seam, same argument.
//
// SLICE 5b FIX (stale-ring repair, multiproject-latency A2/S5): the server's
// ring-gap fallback only fires when the cursor is ALREADY evicted at REQUEST
// time. When this reopen races the eviction (the stream closed, the ring then
// rotates past the frozen cursor via interest-filtered events from OTHER
// sessions), the replay is provably continuous → ZERO frames are written
// (everything in the range is filtered) → the connection live-tails silently
// and NO snapshot ever lands: refreshing[id] stays armed (only a snapshot
// clears it) and the repair is indistinguishable from a dead stream until the
// next content event. The silence fallback below closes that window: if the
// resumed connection delivers NOTHING (no snapshot → sesSnapDone stays false;
// no message events → sesCursor frozen) within SES_RESUME_SILENT_FALLBACK_MS,
// reopen CURSORLESS (sesCursor=0 → the server's fresh-snapshot branch) so the
// repair is confirmed by an authoritative snapshot (clears refreshing, MERGE
// re-seeds state; no missed/dup/reorder — prependMessagesIfAbsent). Any
// delivered content cancels the fallback, so a resume the ring CAN serve
// keeps the cheap replay path (fence: continuity-provable resumes unchanged).
// Scoped to THIS seam only: visibility reveals and busy-edge re-arms keep
// pure cursor-preserving behavior. Worst case equals the pre-5b cost of this
// one path (which always cursorless-snapshotted), and it is one-shot — the
// fallback's own open does not re-arm, so a silent server cannot loop it.
export const SES_RESUME_SILENT_FALLBACK_MS = 8_000;

// The armed silence-fallback timer + the connection generation it belongs to.
// Cleared on close/suspend/replace; the fire-side gen guard makes a stray
// wake harmless.
let sesResumeFallback: number | undefined;

function clearResumeSilenceFallback(): void {
  if (sesResumeFallback !== undefined) {
    clearTimeout(sesResumeFallback);
    sesResumeFallback = undefined;
  }
}

function armResumeSilenceFallback(): void {
  clearResumeSilenceFallback();
  const gen = sesGen; // the connection openSessionES just constructed
  const cursorAtOpen = sesCursor; // the preserved cursor the resume asked with
  // Diagnostics (logging-only): stamp the open record — THIS open armed the
  // fallback (the fallbackArmed field of the stream-open entry).
  noteSessionFallbackArmed(gen);
  sesResumeFallback = window.setTimeout(() => {
    sesResumeFallback = undefined;
    // Superseded (switch/force/close/suspend/newer reopen) → stand down; the
    // replacement connection owns its own recovery.
    if (gen !== sesGen) return;
    // Content arrived on the resumed connection (a snapshot sets sesSnapDone;
    // snapshot + message events advance sesCursor — both pre-busy-gate, so a
    // gated frame still counts as delivered) → continuity confirmed; keep the
    // cheap cursor connection.
    if (sesSnapDone || sesCursor !== cursorAtOpen) return;
    countRecovery("resume-silent-fallback");
    captureDiagEntry({
      kind: "stall",
      ts: Date.now(),
      trigger: "resume-silent-fallback",
      stream: "session",
      sessionId: sesId || undefined,
      eventSourceState: {
        tree: 0, // not tracked here; health.ts fills tree state in its own entries
        session: ses?.readyState ?? -1,
      },
    });
    log.warn("sync", "cursor-preserving resume delivered nothing → cursorless snapshot fallback", {
      id: sesId,
      silentMs: SES_RESUME_SILENT_FALLBACK_MS,
      cursor: cursorAtOpen,
    });
    // Cursorless reopen: the server takes the fresh-snapshot branch; the
    // snapshot confirms the repair. sesCursor=0 makes openSessionES omit the
    // cursor param — and the `fresh` flag keeps the cursor-loss fix's restored
    // last-known cursor OUT of this open: the silence this fallback answers was
    // measured against (at least) that cursor, so re-sending it would take the
    // replay branch again and repeat the interest-filtered silence — the exact
    // wedge slice 5b exists to close. The fallback's snapshot re-advances the
    // cursor memory when it applies.
    sesCursor = 0;
    openSessionES(sesId, "recovery-fresh", "silence-fallback", true);
  }, SES_RESUME_SILENT_FALLBACK_MS);
}

export function reopenSessionStreamPreservingCursor(reason: StreamOpenReason = "watchdog", detail?: string): void {
  if (!sesId || !projectDir()) return;
  // Cancel any pending CLOSED-retry backoff timer: this reopen supersedes it
  // (otherwise the timer would fire openSessionES AGAIN on top of the fresh
  // connection). Mirrors ensureSessionStreamLiveForActivity.
  clearTimeout(sesRetry);
  openSessionES(sesId, reason, detail);
  // Slice 5b fix: confirm the resume actually delivered — see the block
  // comment above.
  armResumeSilenceFallback();
}

// === Slice 3 (webperf): busy-edge Stream-2 re-arm ============================
//
// The idle-gated watchdog (./health) deliberately stops forcing recovery for a
// terminally-idle session — silence is EXPECTED there. The correctness edge
// that creates: the operator prompts a session that has been idle long enough
// that its Stream-2 silently died (or went ping-masked) while nobody was
// watching. Without re-arming, the missed-tail window is the watchdog's
// CONTENT_STALE_MS (~120s) — and only AFTER the session flips busy, since the
// gate reads activity at tick time.
//
// ensureSessionStreamLiveForActivity closes that edge AT the idle→busy
// transition: if the stream is closed, or its CONTENT clock is aged past the
// same conservative CONTENT_STALE_MS threshold (the stream delivered nothing
// throughout the idle period — it either worked and has an ~empty ring replay
// ahead, or it died and MUST be replaced now), reopen it THROUGH THE RETRY
// SEAM (openSessionES) — sesCursor is preserved, so the server takes the ring
// replay branch (server.go `hasCursor && replayOK`) and the live tail attaches
// immediately. NEVER openSessionStream (its closeSessionStream resets
// sesCursor=0 → cursorless full snapshot — the exact cost this slice removes).
// Bounded: ONE action per busy edge (the caller is edge-triggered); a stream
// whose content clock is FRESH (delivered within CONTENT_STALE_MS — e.g. a
// busy→idle→busy flutter seconds apart) is presumed healthy and left alone.
//
// No-loss / no-dup argument (why tearing down even a HEALTHY open stream here
// is safe): sesCursor only advances when an event is APPLIED, so the replay
// range covers everything in-flight on the old connection at teardown; the
// replacement re-baselines the per-connection delivery ordinal
// (sesLastDeliveryOrdinal=-1 in openSessionES; the server restarts its
// handler-local ordinal per connection), message-body duplicates are merged
// away by prependMessagesIfAbsent (live always wins), and the compound SSE id
// globalSeq component keeps sesCursor monotonic across the swap.
export function ensureSessionStreamLiveForActivity(): void {
  // A host-hidden pane's streams are deliberately suspended — the reveal path
  // (resumeSessionStreamForVisibility) owns reopening them; a busy edge is
  // no reason to reopen a hidden pane's stream.
  if (sesSuspended) return;
  if (!sesId || !projectDir()) return;
  const closed = !ses || ses.readyState === EventSource.CLOSED;
  const contentAged =
    sessionContentSeen === 0 || Date.now() - sessionContentSeen > CONTENT_STALE_MS;
  if (!closed && !contentAged) return; // delivered recently → presumed healthy
  countRecovery("busy-edge-rearm");
  // Cancel any pending CLOSED-retry backoff timer: the reopen below supersedes
  // it (otherwise the timer would fire openSessionES AGAIN on top of the fresh
  // connection — a needless teardown/replace).
  clearTimeout(sesRetry);
  // "other" + detail: a cursor-PRESERVING liveness re-attach — neither a
  // fresh-snapshot recovery nor a transport retry (the closed enum has no
  // preserving-repair bucket; the detail carries the exact taxonomy path B8).
  openSessionES(sesId, "other", "busy-edge-rearm");
}

// startBusyEdgeRearm — arm the reactive idle→busy edge watcher. Wired once
// from startSync beside the selection-follow effect. The source memo reads
// sessionWorking(selectedId()) — the AUTHORITATIVE busy selector ChatView's
// Working pill uses (state.activity self busy/retry + the tree node's
// server-computed subtreeBusy rollup), so the edge fires regardless of WHERE
// the busy transition originated (this pane's own send, a queued-item drain on
// an idle session, or a tree activity event from another pane) as long as SOME
// stream delivered the transition. on(..., {defer:true}) skips the boot value;
// only a genuine not-working→working edge acts (prev is `undefined` on the
// first observed change — Solid's defer artifact — which is also a "was not
// working" baseline, so !prev covers it; a session already busy at arm time
// only acts after a real busy→idle→busy cycle). Selection switches are
// self-guarding: the selection-follow effect just opened the new session
// fresh (content clock seeded), so the edge's health check is a no-op for it.
export function startBusyEdgeRearm(): void {
  createRoot(() => {
    createEffect(
      on(
        () => sessionWorking(selectedId() ?? ""),
        (busy, prev) => {
          if (busy && !prev) ensureSessionStreamLiveForActivity();
        },
        { defer: true },
      ),
    );
  });
}

// getResumableSesId — the session id a visibility REVEAL should (re)open, or
// null when the reveal must NOT resume Stream-2: null when nothing is
// resumable (never opened / closed), and the empty-string sentinel "" never
// applies (sesId is "" exactly when nothing is open). Consumed by the sync.ts
// facade's reveal reconciliation (review a-F2/b-F1/c-F2/d-F1: a selection
// change delivered while the pane was hidden must not leave the reveal
// streaming the STALE pre-hide session).
export function getResumableSesId(): string | null {
  if (!sesSuspended) return null;
  return sesId || null;
}


// === open() session ping listener registration (decomposition Stage 1) ======
// Extracted VERBATIM from the nested open() in openSessionStream() — the
// transport-only Stream2 heartbeat listener. Only the addEventListener
// registration was relocated from its inline position in open(); no callback
// body changed. Registration order is preserved: ping is registered after the
// inline snapshot listener and before the inline onopen, exactly as before.
//
// Synchronous by contract (registration only, no async, no Promise return).
// `gen` is THIS connection's captured generation token, passed by value; the
// callback reads `gen` for the stale-entry guard and the live module-scope
// `sesGen` exactly as the inline registration did. No open()-local state other
// than `es`/`gen` is captured, so there is no ctx.
function registerSessionPingListener(es: EventSource, gen: number): void {
  es.addEventListener("ping", () => {
    if (gen !== sesGen) return;
    // Transport-only: refresh sessionLastSeen but NOT sessionContentSeen, so
    // a ping-only stream (transport alive, zero content) lets the content
    // clock age out and the watchdog's content-stall branch fires.
    markSessionTransportSeen();
  });
}

// SESSION_MESSAGE_KINDS — the message/part/messages SSE event kinds the
// Stream-2 (active-session) listener registers for. O3 SINGLE SOURCE OF TRUTH
// (FE half): this set MUST match the server's ordinal-counted kind set for
// Stream 2 — i.e. pkg/state.IsMessageClassKind (the Go-side classifier used in
// server.go's treeEmitter==nil replay + live-tail branches). The server
// advances the per-connection delivery ordinal ONLY for these kinds + the
// initial snapshot; structural frames are emitted via writeRawNoID (no ordinal
// advance). If you add/remove a kind here, update IsMessageClassKind too.
// Slice 3 added "part.append" (KindPartAppend is message-class per
// IsMessageClassKind); it is buffered for frame-batched flush in the listener
// (does not reach applyMessageEvent synchronously like the other kinds).
export const SESSION_MESSAGE_KINDS = [
  "message.upsert",
  "message.delete",
  "part.upsert",
  "part.delete",
  // Slice 3: part.append is message-class (pkg/state IsMessageClassKind lists
  // KindPartAppend alongside KindPartUpsert) and ordinal-counted by the server
  // (server.go Stream-2 stamping). Registered here so the shared listener
  // dispatches it; the listener buffers it for frame-batched flush (below).
  "part.append",
  "messages.loaded",
  "messages.error",
  "messages.batch",
] as const;

// === open() session message-listener registration (decomposition Stage 2) ====
// Extracted VERBATIM from the nested open() in openSessionStream() — the
// CONTIGUOUS message/part cohort: the SESSION_MESSAGE_KINDS loop
// routed through applyMessageEvent with trackCursor=false — the LOAD-BEARING
// Stream2 invariant (Stream 2 must NEVER advance Stream 1's shared resume
// cursor; see invariant audit §3e). Only the addEventListener registration (the
// for-loop) was relocated from its inline position in open(); no callback body
// changed (the only mechanical edit: `ses!.addEventListener` became
// `es.addEventListener` because the parameter is already non-nullable).
// Registration order is preserved: the kinds are registered after the inline
// onopen and before the inline onerror, exactly as before. Every cohort event
// name is distinct from the inline snapshot / ping listeners, so consolidating
// them at this registration site has no dispatch-order effect (EventSource
// fires per-name listeners in registration order, and each name has exactly one
// listener); the full set is pinned by stream2Registration.test.ts.
//
// Synchronous by contract (registration only, no async, no Promise return).
// `gen` is THIS connection's captured generation token, passed by value; the
// callback reads `gen` for the stale-entry / post-await recheck guards and the
// live module-scope `sesGen` exactly as the inline registration did. `id` is
// the session this connection is scoped to (added by the cursor-loss fix for
// the per-session last-known cursor advance at the two apply sites below —
// the extracted function otherwise captured no open()-local state, so there
// is no ctx).
function registerSessionMessageListeners(es: EventSource, gen: number, id: string): void {
  for (const kind of SESSION_MESSAGE_KINDS) {
    es.addEventListener(kind, async (e) => {
      // Gen guard: ignore frames from a superseded connection BEFORE touching
      // the clock or the store.
      if (gen !== sesGen) return;
      // Test-only drop hook: silently ignore the next N events BEFORE
      // markSessionSeen/reconcile, simulating "events lost below SSE but the
      // connection stays OPEN" — the exact silent-loss class. Decremented
      // BEFORE any state effect so a dropped event leaves NO trace (no clock
      // refresh, no cursor advance, no seq baseline update).
      if (sesDropNextN > 0) {
        sesDropNextN--;
        return;
      }
      markSessionSeen();
      noteSessionStamp(gen, "firstFrameTs"); // diagnostics (logging-only): replay/live frame arrival
      // Track Stream2's local cursor from the SSE id field (mirrors the
      // snapshot listener). Done BEFORE the gate check so even a deferred
      // (busy-gated) frame advances sesCursor — the event WAS received, so a
      // retry after the gate releases must not replay it.
      // O3: parse compound SSE id — globalSeq for sesCursor, ordinal for gap.
      // (Hoisted to listener scope from its former bare block: the part.append
      // branch below buffers the frame's seq with it — cursor bookkeeping for
      // the flush-time last-known advance, see PendingAppend.)
      const { globalSeq: seq, ordinal } = parseSSEID((e as MessageEvent).lastEventId);
      // Invariant 1: delivery-ordinal gap detection. Checked BEFORE advancing
      // sesCursor/sesLastDeliveryOrdinal so the gap is measured from the prior baseline.
      checkSesOrdinalGap(ordinal, kind);
      // checkSesOrdinalGap MAY have triggered openSessionStream(id, true) →
      // sesGen++ → this connection is superseded. Drop cleanly.
      if (gen !== sesGen) return;
      if (seq > sesCursor) sesCursor = seq;
      if (ordinal > sesLastDeliveryOrdinal) sesLastDeliveryOrdinal = ordinal;
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

      // Slice 3: part.append — buffer for frame-batched flush. The "coalesce a
      // same-task burst into one setState" effect ONLY engages when multiple
      // part.append callbacks run in one task (the lane-5 unit / MockEventSource
      // path); under NATIVE EventSource each event is its own task so the
      // microtask drains after each (cardinality 1 — NOT a production churn
      // reduction; see the buffer header above + commit 693433e). The queue's
      // load-bearing value is its non-batching work (gen-filter, mismatch
      // aggregation, bumpUpdating, non-append drain ordering). The first suffix
      // of a same-task burst is still applied within sub-ms (microtask at end of
      // the current task). See flushAppends / scheduleAppendFlush below.
      if (kind === "part.append") {
        if (sid) {
          pendingAppends.push({ gen, sid, seq, payload: data as PartAppendPayload });
          scheduleAppendFlush();
        }
        return;
      }

      // Non-append kind: drain any buffered part.append suffixes FIRST to
      // preserve seq ordering (buffered suffixes have lower seq than this event
      // and must land before it). Synchronous; a no-op when the buffer is empty
      // (the common case). This keeps an authoritative part.upsert /
      // message.upsert / messages.batch from racing ahead of pending suffixes.
      drainPendingAppends();
      // t1d-F1: a drain-triggered cursorless re-snapshot (offset mismatch →
      // openSessionStream(sid, true) inside flushAppends) bumps sesGen. Re-check
      // before applying the triggering non-append event so it does NOT reach
      // applyMessageEvent on a stale gen — the fresh snapshot from the new
      // connection is authoritative (MERGE via prependMessagesIfAbsent). Mirrors
      // the post-await gen re-checks below (snapshot/batch decode).
      if (gen !== sesGen) return;

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
            applyMessageEvent("messages.batch", parseSSEID(ev.lastEventId).globalSeq, decoded, false);
            // Cursor memory: the batch STAGED past the gen + epoch guards —
            // applied content, advance (same rule as the final apply below).
            // F9 round-2b: CLAIM (capped), not a raw note — a concurrent
            // same-session batch with a lower seq may still be decoding; this
            // batch's own pending entry must not cap its own claim.
            // Round-4b: the claim is latch-gated inside the helper — a
            // latched session's batch apply under-advances (safe) until
            // applySnap repairs the latch.
            claimSessionCursorApplied(sid || id, seq, seq);
          } else if (isGateActive()) {
            markBusyDirty();
          }
        })();
        if (sid) {
          pendingBatch.set(sid, p);
          notePendingBatchSeq(sid, seq);
        }
        try {
          await p;
        } finally {
          if (sid) {
            pendingBatch.delete(sid);
            forgetPendingBatchSeq(sid, seq);
          }
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
      applyMessageEvent(kind, parseSSEID(ev.lastEventId).globalSeq, data, false);
      // Cursor memory: this frame reached the reducer PAST every guard
      // (gen entry/post-await re-checks, epoch, drain-triggered-resync
      // re-check) — successfully applied content, so the per-session
      // last-known cursor may advance to its seq. part.append never reaches
      // here (it buffers and returns); its advance happens in flushAppends.
      // F9 round-2b: CLAIM (capped) — the pendingBatch wait above serializes
      // only against the LATEST same-session registration; an earlier-seq
      // batch can still be decoding (its map entry was overwritten).
      // Round-4b (E2 subsume corner): the post-drain gen re-check above
      // passes whenever a drain-time mismatch's recovery was SUBSUMED by a
      // pending resume-mode cascade step (no sesGen bump) — this tail site
      // then applies + claims past the un-applied mismatched range unless
      // the latch gate INSIDE the claim voids it. That uniform gate is the
      // round-4b fix; the E2/E3 pin's drop-at-recheck disposition covers the
      // no-pass case only.
      claimSessionCursorApplied(sid || id, seq);
    });
  }
}

// === Slice 3: part.append frame-batch flush =================================
//
// scheduleAppendFlush — arms a single microtask to drain pendingAppends. Idempotent
// within a tick (appendFlushScheduled gates re-arming); the microtask runs at the
// end of the current task. The "coalesce every suffix that arrived in this tick
// into one setState" effect ONLY engages for a SAME-TASK burst (the lane-5 unit
// mechanism); under NATIVE EventSource each event is a separate task so the
// microtask drains after each (cardinality 1 — see the buffer header above +
// commit 693433e). The first suffix of a same-task burst is therefore applied
// within sub-ms of arrival (instant first-token latency).
function scheduleAppendFlush(): void {
  if (appendFlushScheduled) return;
  appendFlushScheduled = true;
  queueMicrotask(flushAppends);
}

// flushAppends — drain the part.append buffer in a SINGLE setState(produce(...)).
// Each suffix is validated (UTF-8 byte offset) + appended in place via the pure
// appendPartSuffix projection. A mismatch (offset disagrees with the resident
// field's byte length, or the message/part isn't resident) triggers a cursorless
// re-snapshot for that session (openSessionStream(id, true)) — the server's
// snapshot-offset coherence (slice 2 B-F1) ensures the post-snapshot suffix
// resumes at the client baseline. Frames from a superseded connection (sesGen
// bumped during the tick) are dropped. bumpUpdating mirrors reconcileEvent's
// per-event bump so the "updating" data-flowing indicator pulses once per flush.
function flushAppends(): void {
  appendFlushScheduled = false;
  if (pendingAppends.length === 0) return;
  const frames = pendingAppends;
  pendingAppends = [];
  // DEFER #2 O1 (measurement): report the flush cardinality — the number of
  // part.append frames drained from the buffer in THIS flush (the snapshot
  // length) — to the observation collector if one is installed. Inert by
  // default: a nullable check + one property read, no allocation, no scheduling
  // change (queueMicrotask timing / drainPendingAppends ordering / the produce
  // body are all untouched), no DOM access. See resolveFlushCardinalityCollector.
  //
  // F1 (data_integrity): the collector sits on the production flush path
  // AFTER the buffer was drained (above) but BEFORE setState(produce(...))
  // applies the frames. An observer exception — reachable from any same-realm
  // actor with code-injection access (browser extension, devtools console,
  // third-party script — not just a test's addInitScript) — MUST NOT abort
  // the flush, or the snapshotted `frames` are silently dropped (drained but
  // never applied). The RESOLUTION + invocation are isolated TOGETHER in one
  // try/catch so that EITHER of two distinct throwing vectors is contained:
  //   - a THROWING GETTER on globalThis.__vhFlushCollector (resolveFlush-
  //     CardinalityCollector reads that slot; a getter installed by a same-realm
  //     actor throws from the resolver), OR
  //   - a throwing collector callback (the invocation itself),
  // cannot escape to abort the flush — execution unconditionally reaches
  // bumpUpdating() / setState(produce(...)) below regardless of observer
  // behavior, so the drained `frames` always reach the store.
  try {
    const c = resolveFlushCardinalityCollector();
    if (c) c(frames.length);
  } catch {
    /* observer/resolver must never abort the flush */
    try { console.debug("[vh:sync] flushCardinality collector threw; contained (frames still apply)"); } catch { /* log must never abort the flush either */ }
  }
  const mismatchSessions = new Set<string>();
  // Cursor memory (cursor-loss fix): the highest suffix seq in THIS flush that
  // actually landed ("applied" — byte offset matched, text appended; "skipped"
  // — the resident completed copy is authoritative and already covers it).
  // Mismatched frames never advance it (their content did not apply; the
  // cursorless re-snapshot they trigger re-establishes the cursor on apply).
  // Tracked inside the produce body, advanced AFTER setState — module state is
  // never mutated inside the producer.
  let flushAppliedSeq = 0;
  let flushAppliedSid = "";
  bumpUpdating();
  setState(
    produce((s) => {
      for (const f of frames) {
        // Gen guard: a superseded connection's buffered suffixes are dropped
        // (sesGen bumped between buffer and flush — a close/reopen/switch).
        if (f.gen !== sesGen) continue;
        const sm = s.messages[f.sid];
        if (!sm) {
          // Session's messages not resident (never opened / evicted) → can't
          // validate the offset → cursorless re-snapshot realigns.
          mismatchSessions.add(f.sid);
          continue;
        }
        const result = appendPartSuffix(sm, f.payload);
        if (result === "mismatch") {
          mismatchSessions.add(f.sid);
          log.warn("sync", "part.append offset mismatch → cursorless re-snapshot", {
            sid: f.sid,
            messageID: f.payload.messageID,
            partID: f.payload.partID,
            field: f.payload.field,
            start: f.payload.start,
          });
        } else if (f.seq > flushAppliedSeq) {
          flushAppliedSeq = f.seq;
          flushAppliedSid = f.sid;
        }
        // "applied" / "skipped": no action beyond the in-place mutation.
      }
    }),
  );
  // Round-4 F1 (E11): carry THIS flush's mismatches across flushes — latch
  // each mismatched sid (module state mutated OUTSIDE the producer, per the
  // discipline above). The claim gate below refuses a latched session even
  // when THIS flush is clean, because the earlier mismatch's content is still
  // un-applied and — in the resume-subsume corner — no recovery is coming to
  // repair it. Only applySnap clears the latch (snapshot-apply repair point).
  for (const sid of mismatchSessions) mismatchLatchedSids.add(sid);
  // F9 (round-2 review, data_integrity): the flush-time cursor advance must
  // NEVER pass an unresolved pendingBatch. Wire order guarantees an append
  // arriving after a messages.batch frame has a HIGHER seq, so advancing here
  // while that batch's decode is still in flight would let the remembered
  // cursor COVER the batch's content — content a mid-decode suspension (sesGen
  // bump) then discards at the batch continuation's gen guard, stranding it on
  // the next preserving replay (cursor past the batch → replay omits it).
  // Under-advance instead: while a batch decode for the session is
  // unresolved, the advance is skipped entirely (equivalent to "advance only
  // up to pendingBatch.seq − 1" — the memory cannot pass the batch's seq).
  // The suffix itself still APPLIES above (its content is live and
  // offset-validated); only the cursor claim waits. No stranding risk:
  //   - the batch APPLIES → its own advance-on-apply (the batch branch's
  //     noteSessionCursorApplied) catches the memory up to the batch seq, and
  //     any append flushed afterwards (map entry deleted in the batch
  //     listener's finally) advances normally;
  //   - the batch DISCARDS (gen/epoch) → the memory stays below the batch —
  //     the resume replays the batch (safe: under-advance always converges
  //     via ring replay + prependMessagesIfAbsent/dedup).
  // Appends buffered BEFORE a batch frame (lower seq) are unaffected: the
  // non-append path drains them synchronously BEFORE the batch branch
  // registers its pendingBatch entry, so their flush-time advance never sees
  // this gate.
  // F9 round-2b: the `has()` gate alone has an overwrite hole — pendingBatch
  // keeps only the LATEST same-session registration, so after a later-seq
  // batch's finally deletes the (shared) entry, this flush could advance past
  // a still-decoding EARLIER-seq batch. The claim below is capped by
  // pendingBatchSeqs (min unresolved batch seq − 1), which tracks every
  // concurrent registration, not just the latest. The `has()` gate is kept:
  // full-skip when the latest batch is unresolved preserves the round-2
  // semantics (and its pinned tests) exactly; the cap handles the residual
  // concurrent-registration window.
  // t1b-F1 (round-3 review, data_integrity): a mismatch recorded in THIS
  // flush for the claiming session voids the claim entirely. The per-flush
  // applied-max tracking cannot prove the applied suffix sits ABOVE every
  // mismatched seq in the same buffer — the defect shape is a mismatched
  // suffix at 200 (target part absent → content NOT applied) followed by an
  // applicable suffix at 201 in the SAME flush: the claim committed 201 to
  // the memory BEFORE the mismatch's cursorless recovery ran, so a later
  // memory-restoring open replayed from 201 and skipped the un-applied 200.
  // Conservative skip (not a below-mismatch cap): under-advance is always
  // safe, and the mismatch recovery's authoritative snapshot re-advances the
  // memory when it applies. Per-session keyed — a mismatch for session A
  // does not void session B's claim (per-session memory, per-session
  // recovery).
  // Cross-FLUSH safety is carried by mismatchLatchedSids (round-4 F1, E11).
  // The round-3 "needs no state" premise — that the mismatch's direct action
  // always runs synchronously here (bumping sesGen so every later frame lands
  // on a snapshot-first recovery connection), with the subsume-skip corner
  // excluded because a fresh recovery connection receives its snapshot before
  // any suffix could buffer — was REFUTED by the resume-mode subsume corner:
  // a sentinel-timeout pass holds a PENDING {session:'resume'} step whose
  // reopen URL carries a cursor but no tree=2, so the server's replay branch
  // ships NO trailing session snapshot (stream_http.go gates it on
  // treeEmitter != nil) — the step can never converge (only applySnap
  // converges it) and pends up to the 15s cascade timeout, while the suffixes
  // live on the RESUME connection where no snapshot ever lands. A mismatch in
  // that window takes the COALESCE branch (pending session step → direct
  // skipped; S2 cannot supersede a pending step), so NOTHING repairs it — and
  // a later clean flush would pass every flush-local gate. The latch set at
  // that mismatch therefore persists into later flushes and voids their
  // claims too, until a snapshot APPLIES (applySnap's clear — the
  // content-inclusion repair point). Safety: a latch that never clears
  // freezes the memory at the pre-mismatch value — under-advance, always
  // safe; any eventual repair (re-triggered mismatch / watchdog / B12 once
  // no pass is in flight — the coalesced direct itself is dropped, not
  // re-run) opens cursorless → its snapshot applies → clears the latch and
  // re-raises the memory legitimately. Pinned by the
  // t1b-F1 red-first test, the round-4 resume-subsume red-first test, the
  // latch-clear pin, and the E2/E3 drain-ordering pin; the round-4b uniform
  // gate additionally pins the E2 subsume corner (the tail-site claim) red-
  // first.
  // Round-4b: the !mismatchLatchedSids.has() clause below is now REDUNDANT
  // with the latch gate inside claimSessionCursorApplied (the uniform gate
  // voids the claim anyway) — kept because removing it changes nothing
  // observable and the smallest diff wins; it also preserves the pinned
  // full-skip semantics visibly at the flush call site.
  if (
    flushAppliedSid &&
    !pendingBatch.has(flushAppliedSid) &&
    !mismatchSessions.has(flushAppliedSid) &&
    !mismatchLatchedSids.has(flushAppliedSid)
  ) {
    claimSessionCursorApplied(flushAppliedSid, flushAppliedSeq);
  }
  // Trigger cursorless re-snapshot for each mismatched session (defense in depth
  // + the genuine reconnect/loss case). Only the SELECTED session has an open
  // Stream2 to repair; a non-selected session re-snapshots on next open.
  for (const sid of mismatchSessions) {
    if (sid === sesId) {
      // Slice 1 (webperf): count the offset-mismatch cursorless re-snapshot
      // by stable reason code (window.__vhSyncDiag).
      countRecovery("offset-mismatch");
      captureDiagEntry({
        kind: "stall",
        ts: Date.now(),
        trigger: "part-append-offset-mismatch",
        stream: "session",
        sessionId: sid,
      });
      // Slice A (send-net-resilience): the force feeds the convergence
      // cascade (ONE coalesced pass; the direct action runs synchronously
      // when no pass is in flight).
      requestRecovery("offset-mismatch", () => openSessionStream(sid, true, "recovery-fresh", "offset-mismatch"), { session: "fresh" });
    }
  }
}

// drainPendingAppends — synchronous flush, called by the shared message listener
// BEFORE applying a non-append kind. Preserves seq ordering: buffered suffixes
// (lower seq) land before the authoritative event (higher seq) that follows. A
// no-op when the buffer is empty (the common case — part.append is the only kind
// that buffers). If a flush microtask was already armed, it is disarmed (the
// synchronous drain supersedes it) so the buffer isn't double-flushed.
function drainPendingAppends(): void {
  if (pendingAppends.length === 0) {
    appendFlushScheduled = false; // disarm a stale scheduling (defensive)
    return;
  }
  appendFlushScheduled = false; // disarm: the synchronous drain replaces the microtask
  flushAppends();
}

// --- Test-only accessors for the seq-gap drop-N regression test -------------
// These are NOT wired into any production path. They exist so vitest can arm
// the __dropNextN hook and reset the gap baseline between tests.
export function _setSesDropNextNForTest(n: number): void {
  sesDropNextN = n;
}
export function _getSesLastSeqForTest(): number {
  return sesLastDeliveryOrdinal;
}
export function _resetSesGapStateForTest(): void {
  sesLastDeliveryOrdinal = -1;
  sesDropNextN = 0;
}

// --- Test-only accessors for slice-3 part.append ----------------------------
// _setPartDeltaEnabledForTest flips the kill-switch so the disabled-path test
// (kill-switch off → no part_delta=1, no part.append consumed) can exercise
// the legacy-revert path without a source edit. NOT wired into production.
export function _setPartDeltaEnabledForTest(v: boolean): void {
  partDeltaEnabled = v;
}
// _drainPendingAppendsForTest synchronously drains the part.append buffer so a
// test can assert post-flush store state without pumping microtasks (the
// production flush is a queueMicrotask). Returns whether a drain occurred.
export function _drainPendingAppendsForTest(): boolean {
  if (pendingAppends.length === 0) return false;
  drainPendingAppends();
  return true;
}
// _hasPendingAppendsForTest reports whether suffixes are buffered (unflushed).
export function _hasPendingAppendsForTest(): boolean {
  return pendingAppends.length > 0;
}

// === DEFER #2 O1 (measurement): flush-cardinality observer ==================
//
// An inert-by-default observation hook on the part.append frame-batch flush
// boundary (flushAppends above). When installed, flushAppends reports the number
// of part.append frames consumed in each flush — the snapshot length of the
// drained pendingAppends buffer — to the collector. This is a PURE OBSERVATION
// of the snapshot cardinality:
//   - NO scheduling change: queueMicrotask timing, scheduleAppendFlush,
//     drainPendingAppends ordering, and the produce(…) body are byte-for-byte
//     unchanged. The collector call sits between the buffer snapshot and
//     bumpUpdating()/setState.
//   - NO timers, promises, additional microtasks, requestAnimationFrame, or DOM
//     reads/writes.
//   - NO monkey-patching of queueMicrotask.
// Production posture (the default): production NEVER WRITES the slot — the
// module-level flushCardinalityCollector stays null in the production bundle,
// and no production code path assigns globalThis.__vhFlushCollector. The
// resolver does ONE typeof-guarded READ of globalThis.__vhFlushCollector per
// non-empty flush; in production the slot is undefined → the guard returns
// null → the invocation is skipped entirely (the only added work on the
// production path is the nullable check + the property read; no allocation).
// When a collector IS installed (test-only), flushAppends is otherwise
// observably identical to its pre-hook behavior: the invocation is isolated
// via try/catch (see flushAppends) so an observer exception CANNOT abort the
// flush or drop the snapshotted frames — frames always reach
// setState(produce(...)) regardless of observer behavior. The slot is
// same-realm and reachable from any actor with code-injection access (browser
// extension, devtools console, third-party script — not just a test's
// addInitScript), so the isolation is load-bearing, not theoretical.
//
// Two install paths (both test-only):
//   - vitest: _setFlushCardinalityCollectorForTest(fn) — mirrors the existing
//     _setPartDeltaEnabledForTest / _hasPendingAppendsForTest pattern (unit
//     tests import the module directly).
//   - e2e (Playwright): globalThis.__vhFlushCollector, installed by the test's
//     page.addInitScript BEFORE the SPA boots. Resolved here via globalThis so
//     the production SPA bundle carries NO window surface of its own — the
//     slot is only ever populated by a test's init script.
export type FlushCardinalityCollector = (cardinality: number) => void;
let flushCardinalityCollector: FlushCardinalityCollector | null = null;

// resolveFlushCardinalityCollector — returns the installed collector (module-
// level slot first, then the globalThis e2e slot) or null. Cheap: a nullable
// check + one property read; no allocation. Hoisted function declaration so it
// is callable from flushAppends (defined above) at runtime after module eval.
function resolveFlushCardinalityCollector(): FlushCardinalityCollector | null {
  if (flushCardinalityCollector) return flushCardinalityCollector;
  const w = (globalThis as any).__vhFlushCollector;
  return typeof w === "function" ? (w as FlushCardinalityCollector) : null;
}

// _setFlushCardinalityCollectorForTest installs/uninstalls the module-level
// collector and returns the previous one so a test can restore it in teardown.
// NOT wired into any production path; the production default is null.
export function _setFlushCardinalityCollectorForTest(
  c: FlushCardinalityCollector | null,
): FlushCardinalityCollector | null {
  const prev = flushCardinalityCollector;
  flushCardinalityCollector = c;
  return prev;
}
