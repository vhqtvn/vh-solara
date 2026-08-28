// L-08/M4 orchestration boundary — the single synchronous entrypoint that turns
// server events into SyncState mutations. It PROJECTS (reducers.ts), INTERPRETS
// the returned effects (notify / pin / page-flight / persistence policy),
// ADVANCES the resume cursor, and SCHEDULES persistence — in that order.
//
// The projection module (reducers.ts) calls NONE of these policy APIs directly;
// the standing check TestApplyReconcileHasNoInlinePolicy pins that. This is the
// ONLY module that maps factual effects to side-effect policy.
//
// This path is FULLY SYNCHRONOUS after the transport layer's coherent-capture
// await — no promise/await/microtask is inserted here.
//
// ESM: this module imports the projection (reducers.ts) in one direction;
// reducers.ts does NOT import this module, so there is no cycle.
import { produce } from "solid-js/store";
import { createSignal } from "solid-js";
import type { Snapshot } from "../types";
import type { ReconcileContext, ReconcileEffect, ReconcileEvent } from "./reducers.types";
import { setState, persist, clearSessionAgentPick, clearSessionModelPick, type SyncState, selectedId, state } from "./store";
import {
  projectSnapshot,
  projectSessionEvent,
  projectMessageEvent,
  projectSessionRemoval,
  epochChanged,
  stampCompletionIfIdle,
} from "./reducers";
import { pushNotification } from "../notify";
import { dropPinnedSession } from "../pins";
import { dropLabelRoot } from "../labels";
import { resetPageInFlight, reapShadowsIfOverCap } from "./history";
import { patchTreeAgent } from "./treeState";
import { maybeNotifyRootDone, maybeClearWaiting } from "./orchestration";
import { openSessionStream } from "./session-stream";
import { captureDiagEntry } from "./diaglog";

// interpretEffects — map factual effects to side-effect policy. sync-state-dirty
// is intentionally NOT handled here: the entrypoint persists it LAST (after the
// cursor advance) so persistence captures the final cursor value.
function interpretEffects(effects: ReconcileEffect[]): void {
  for (const e of effects) {
    if (e.kind === "sync-state-dirty") continue; // handled last by the entrypoint
    switch (e.kind) {
      case "assistant-error-observed":
        pushNotification({ kind: "error", sessionID: e.sessionID, title: "errored", detail: e.detail });
        break;
      case "root-maybe-completed":
        maybeNotifyRootDone(e.sessionID);
        break;
      case "input-maybe-answered":
        maybeClearWaiting(e.sessionID);
        break;
      case "session-removed":
        // Deletion cascade: reset the in-flight page request + drop the stale
        // pinned id + drop the stale label root. All three are idempotent local
        // corrections (no PUT) so the stale id does not linger until the server's
        // own lifecycle broadcast (pins.updated / labels.updated) lands; the S2
        // 400 self-heal remains the durable backstop for both pin and label docs.
        resetPageInFlight(e.sessionID);
        dropPinnedSession(e.sessionID);
        dropLabelRoot(e.sessionID);
        // B2b id-reuse guard (mirrors the reducer's lastAgents prune): drop the
        // removed session's PERSISTED agent pick too, or a server-side id reuse
        // would resurrect the old session's explicit agent pick for the new
        // occupant — the same silent-flip class this slice closes.
        clearSessionAgentPick(e.sessionID);
        // P1: same id-reuse guard for the PERSISTED model pick. The pick is
        // sticky by contract (never consumed on send; clears ONLY on session
        // removal) — this is the one removal path, pruning BOTH memory and the
        // persisted map so a reused id never inherits the old occupant's
        // explicit model choice.
        clearSessionModelPick(e.sessionID);
        break;
      case "snapshot-prune-picks":
        // b-F1 (missed session.delete): the authoritative FULL snapshot
        // dropped these ids — deleted while this client was offline, so the
        // session-removed cascade above never ran for them. Run the SAME
        // persisted-pick prune here so a server-side id reuse cannot restore
        // the PRIOR occupant's explicit picks for the new occupant. The rest
        // of the deletion cascade (page-flight/pin/label) is deliberately NOT
        // run: this is not a removal event, and those slices keep their own
        // server-broadcast self-heal backstops.
        for (const id of e.removed) {
          clearSessionAgentPick(id);
          clearSessionModelPick(id);
        }
        break;
      case "reconcile-tree-agent":
        // Cold-seed gap fill: patch the tree node so the chip renders on
        // collapsed nodes without an expand round-trip. Synchronously within
        // the same reconciliation cycle as the producing lastAgent.set event
        // (ordering-equivalent to the former inline call inside produce()).
        patchTreeAgent(e.sessionID, e.agent);
        break;
      case "tail-incomplete-on-idle":
        // Invariant 2: activity=idle arrived but the resident tail's last
        // message is not a completed assistant message → the terminal
        // message.upsert was lost. Force-fetch a fresh snapshot to recover
        // the true tail. Only actionable for the SELECTED session
        // (openSessionStream opens a Stream2 EventSource for it); for other
        // sessions the tail isn't display-critical until selected.
        if (e.sessionID === selectedId()) {
          const sm = state.messages[e.sessionID];
          const lastMsg = sm && sm.order.length ? sm.byId[sm.order[sm.order.length - 1]] : null;
          captureDiagEntry({
            kind: "stall",
            ts: Date.now(),
            trigger: "tail-incomplete-on-idle",
            stream: "session",
            sessionId: e.sessionID,
            residentTail: {
              sessionId: e.sessionID,
              lastMsgRole: lastMsg?.info.role,
              lastMsgCompleted: !!lastMsg?.info.time?.completed,
              msgCount: sm?.order.length ?? 0,
            },
          });
          openSessionStream(e.sessionID, true);
        }
        break;
    }
  }
}

// reconcileEvent — the single synchronous orchestration entrypoint for non-tree
// reducer calls (L-08/M4 item 2). Order: project → interpret effects (except
// sync-state-dirty) → advance cursor (Stream 1 only) → persist (sync-state-dirty,
// interpreted last). The trackCursor policy is carried explicitly (item 3):
// Stream 1 (tree transport) = true; Stream 2 (active-session messages) = false.
export function reconcileEvent(event: ReconcileEvent, context: ReconcileContext): void {
  bumpUpdating();
  const effects: ReconcileEffect[] = [];
  setState(
    produce((s) => {
      if (event.kind === "session.upsert" || event.kind === "session.delete") {
        projectSessionEvent(s, event.kind, event.payload, effects);
      } else {
        projectMessageEvent(s, event.kind, event.payload, effects);
      }
    }),
  );
  // C-F4 — live-path stage-1 shadow reap, gated to MESSAGE-CLASS events ONLY
  // (message.upsert / messages.batch). part.upsert is deliberately excluded:
  // it fires once per streamed token, and the cap check walks every resident
  // entry — running that per token is the hot-path cost this gate avoids.
  // Stage-2 (ordered/visible) eviction stays page-merge-only; see
  // reapShadowsIfOverCap in history.ts for the full contract.
  if (event.kind === "message.upsert" || event.kind === "messages.batch") {
    reapShadowsIfOverCap(event.payload?.sessionID);
  }
  interpretEffects(effects);
  // Advance the resume cursor AFTER projection (Stream 1 only) so persistence
  // below captures the final value. Nothing reactive reads cursor synchronously,
  // so moving it out of the produce draft is safe.
  if (context.trackCursor && event.seq) setState("cursor", event.seq);
  // Persist LAST (sync-state-dirty), after the cursor advance.
  if (effects.some((e) => e.kind === "sync-state-dirty")) persist();
}

// applySessionEvent — Stream 1 structural-event reducer (session.upsert /
// session.delete). Always tracks the cursor (Stream 1 owns the shared resume
// position). Signature preserved for tree-transport.ts.
export function applySessionEvent(kind: string, seq: number, payload: any): void {
  reconcileEvent({ kind, seq, payload }, { trackCursor: true });
}

// applyMessageEvent — message/part/activity/permission/question/unread/
// lastAgent/status reducer. trackCursor defaults true (Stream 1); session-stream
// passes false explicitly (Stream 2 re-snapshots on connect). Signature + default
// preserved for tree-transport.ts + session-stream.ts.
export function applyMessageEvent(kind: string, seq: number, payload: any, trackCursor = true): void {
  reconcileEvent({ kind, seq, payload }, { trackCursor });
}

// applySnapshot — wholesale snapshot reducer. Cursor is set unconditionally to
// snap.seq (the snapshot is authoritative regardless of stream). Signature
// preserved for tree-transport.ts + session-stream.ts.
export function applySnapshot(snap: Snapshot): void {
  bumpUpdating();
  const effects: ReconcileEffect[] = [];
  setState(produce((s) => projectSnapshot(s, snap, effects)));
  interpretEffects(effects);
  setState("cursor", snap.seq); // snapshot cursor is unconditional
  if (effects.some((e) => e.kind === "sync-state-dirty")) persist();
}

// projectScopedPartial — Slice-A (D3/D4): the FRONTIER-SCOPED partial detail
// installer, the structural twin of projectSnapshot for the tree-Stream-1
// cold/reconnect detail frame (snap.partial present). Applies each map by its
// `partial.authority` tag instead of wholesale-replacing every map:
//   - "frontier" (sessions/activity/gate/lastAgents/currentVerbs): MERGE —
//     upsert ONLY ids in `partial.scope`, PRESERVE buried detail outside scope.
//     No deletion from omission; deletions arrive as continuous-replay
//     session.delete (transition 7).
//   - "global" (questions/permissions/unread): AUTHORITATIVE-REPLACE (same
//     array→keyed translation as projectSnapshot). Q/P/unread are always
//     frontier subsets in practice — a session with pending input is promoted
//     to the active frontier (isActiveLocked) — so global-replace never drops a
//     buried pending input; the tag makes the clear-replied-questions semantics
//     explicit.
//   - "omitted" (todos/statuses/messages): IGNORE (the frame carries none).
// On an epoch-change (server restart) prior-epoch frontier-mergeable detail is
// STALE → clear it before merging the fresh frontier (transition 9). Q/P/unread
// are wholesale-replaced regardless of epoch. cursor advance + persistence are
// orchestration policy (handled by applyScopedSnapshot, mirroring applySnapshot).
export function projectScopedPartial(s: SyncState, snap: Snapshot, effects: ReconcileEffect[]): void {
  const p = snap.partial;
  if (!p) return; // defensive: caller gates on snap.partial
  const incomingEpoch = snap.epoch || "";
  const changed = epochChanged(s.epoch, incomingEpoch);
  const scopeSet = new Set(p.scope || []);
  const auth = p.authority || {};
  // Epoch-change: clear prior-epoch frontier-mergeable detail (stale from the
  // restarted server). The global maps are wholesale-replaced below regardless.
  if (changed) {
    s.sessions = {};
    s.gate = {};
    s.activity = {};
    s.lastAgents = {};
    s.currentVerbs = {};
  }
  // D1 ring-gap invalidate-affected: when the cursor was evicted (ring-gap, same
  // epoch), the deltas that would have updated buried detail were lost. The
  // fresh partial re-seeds the frontier (scope below), but retained detail for
  // ids NOT in scope MAY be stale. MECHANICALLY invalidate: delete frontier-
  // mergeable detail for ids outside scope — the set is "everything retained
  // minus what this frame covers", NOT inferred from omission (too-narrow =
  // stale detail persists; the broad clear is the safe choice because the ring
  // consumed the per-id change evidence). Epoch-change already cleared all
  // above, so this runs only on a same-epoch ring-gap.
  if (p.ringGap && !changed) {
    for (const id of Object.keys(s.sessions)) if (!scopeSet.has(id)) delete s.sessions[id];
    for (const id of Object.keys(s.gate)) if (!scopeSet.has(id)) delete s.gate[id];
    for (const id of Object.keys(s.activity)) if (!scopeSet.has(id)) delete s.activity[id];
    for (const id of Object.keys(s.lastAgents)) if (!scopeSet.has(id)) delete s.lastAgents[id];
    for (const id of Object.keys(s.currentVerbs)) if (!scopeSet.has(id)) delete s.currentVerbs[id];
  }
  // FRONTIER-scoped MERGE (upsert scope ids only; preserve buried).
  if (auth.sessions !== "omitted") {
    for (const sess of snap.sessions || []) {
      if (scopeSet.has(sess.id)) s.sessions[sess.id] = sess;
    }
  }
  if (auth.activity !== "omitted") {
    for (const [sid, val] of Object.entries(snap.activity || {})) {
      if (scopeSet.has(sid)) s.activity[sid] = val;
    }
    // Cross-stream completion bridge (fix B, delivery-path-independent): stamp
    // time.completed for any in-scope session now idle via this scoped partial
    // snapshot path, so `settled` flips regardless of which stream/path
    // delivered the idle. This is the regression-site for the cross-stream
    // completion race (a false-positive Inv1 tree-gap reconnect bumps treeGen,
    // the gen guard drops the discrete activity{idle}, and the idle lands HERE
    // via the seq-scoped partial instead). Idempotent (helper no-ops non-idle /
    // already-stamped). Inv2 tail-incomplete-on-idle stays discrete-path-only.
    for (const sid of Object.keys(snap.activity || {})) {
      if (scopeSet.has(sid)) stampCompletionIfIdle(s, sid);
    }
  }
  if (auth.gate !== "omitted") {
    for (const [id, g] of Object.entries(snap.gate || {})) {
      if (g && scopeSet.has(id)) s.gate[id] = { ...g }; // shallow-clone (mirrors projectSnapshot)
    }
  }
  if (auth.lastAgents !== "omitted") {
    for (const [id, val] of Object.entries(snap.lastAgents || {})) {
      if (scopeSet.has(id)) s.lastAgents[id] = val;
    }
  }
  if (auth.currentVerbs !== "omitted") {
    for (const [id, val] of Object.entries(snap.currentVerbs || {})) {
      if (scopeSet.has(id)) s.currentVerbs[id] = val;
    }
  }
  // GLOBAL AUTHORITATIVE-REPLACE (wholesale; same array→keyed translation).
  if (auth.questions !== "omitted") {
    s.questions = {};
    for (const [sid, qs] of Object.entries(snap.questions || {})) {
      s.questions[sid] = {};
      for (const q of qs) s.questions[sid][q.id] = q;
    }
  }
  if (auth.permissions !== "omitted") {
    s.permissions = {};
    for (const [sid, perms] of Object.entries(snap.permissions || {})) {
      s.permissions[sid] = {};
      for (const perm of perms) s.permissions[sid][perm.id] = perm;
    }
  }
  if (auth.unread !== "omitted") {
    s.unread = {};
    for (const id of snap.unread || []) s.unread[id] = true;
  }
  // todos/statuses/messages: OMITTED — never touched.
  if (changed) s.epochChanged = true;
  if (incomingEpoch) s.epoch = incomingEpoch;
  effects.push({ kind: "sync-state-dirty" });
}

// applyScopedSnapshot — Slice-A (D3): the transport-selected scoped installer
// for frontier-scoped partial detail frames (snap.partial present). Mirrors
// applySnapshot (wholesale) but projects via projectScopedPartial (scoped
// merge/replace). Selected in BOTH tree-transport install paths
// (applyDetailIndependent + tryInstall) so an independent OR a staged partial
// never falls through to wholesale replacement. Cursor set unconditionally to
// snap.seq (mirrors applySnapshot; the coherent-install path also calls
// advanceCursor(id.seq) with the same shared value — idempotent).
export function applyScopedSnapshot(snap: Snapshot): void {
  bumpUpdating();
  const effects: ReconcileEffect[] = [];
  setState(produce((s) => projectScopedPartial(s, snap, effects)));
  interpretEffects(effects);
  setState("cursor", snap.seq);
  if (effects.some((e) => e.kind === "sync-state-dirty")) persist();
}

// pruneSessionDeleted — eager archive prune. Removes a session as if a
// session.delete event had arrived (both route through projectSessionRemoval),
// MINUS the cursor bump (the archive path carries no seq) and MINUS the updating
// indicator (it is not an incoming data event). Called from archive.ts after a
// successful /vh/archive so an orphan whose server-side delete never arrives is
// still pruned immediately. Idempotent. Signature preserved for sync.ts barrel.
export function pruneSessionDeleted(id: string): void {
  const effects: ReconcileEffect[] = [];
  setState(produce((s) => projectSessionRemoval(s, id, effects)));
  interpretEffects(effects);
  if (effects.some((e) => e.kind === "sync-state-dirty")) persist();
}

// --- Feature 2: anti-spam "updating" indicator (U3 debounce) ---------------
// Leading edge lights the indicator on the first data event; trailing edge
// holds it for UPDATING_DEBOUNCE_MS after the LAST event, then clears. A token
// stream (events <600ms apart) keeps it continuously lit without per-token
// flicker; a pause longer than the window turns it off. bumpUpdating is called
// at the top of reconcileEvent / applySnapshot — the data reconciliation entry
// points for both streams.
export const UPDATING_DEBOUNCE_MS = 600;
const [updating, setUpdating] = createSignal(false);
let updatingTimer: number | undefined;
export function isUpdating(): boolean {
  return updating();
}
// bumpUpdating — exported for slice-3 part.append frame-batching (session-
// stream.ts flushAppends), which bypasses reconcileEvent NOT as a native-
// delivery churn reduction (native EventSource delivers one part.append per
// flush — cardinality 1, measured lane-6, ledger [1,1,1,1], commit 693433e) but
// to run its own batched validation/aggregation — gen-filter + mismatch
// collection — in a single produce loop (same-task bursts still coalesce into
// one flush — see the session-stream.ts buffer header). It still needs the "updating" data-
// flowing indicator to pulse, so calling this once per flush mirrors
// reconcileEvent's per-event bump.
export function bumpUpdating() {
  setUpdating(true);
  clearTimeout(updatingTimer);
  updatingTimer = window.setTimeout(() => setUpdating(false), UPDATING_DEBOUNCE_MS);
}
