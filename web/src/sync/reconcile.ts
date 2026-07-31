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
import { setState, persist } from "./store";
import {
  projectSnapshot,
  projectSessionEvent,
  projectMessageEvent,
  projectSessionRemoval,
} from "./reducers";
import { pushNotification } from "../notify";
import { dropPinnedSession } from "../pins";
import { resetPageInFlight } from "./history";
import { patchTreeAgent } from "./treeState";
import { maybeNotifyRootDone, maybeClearWaiting } from "./orchestration";

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
        // pinned id. Both are idempotent; the S2 400 self-heal is the durable
        // backstop for the pin.
        resetPageInFlight(e.sessionID);
        dropPinnedSession(e.sessionID);
        break;
      case "reconcile-tree-agent":
        // Cold-seed gap fill: patch the tree node so the chip renders on
        // collapsed nodes without an expand round-trip. Synchronously within
        // the same reconciliation cycle as the producing lastAgent.set event
        // (ordering-equivalent to the former inline call inside produce()).
        patchTreeAgent(e.sessionID, e.agent);
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
// preserved for tree-transport.ts.
export function applySnapshot(snap: Snapshot): void {
  bumpUpdating();
  const effects: ReconcileEffect[] = [];
  setState(produce((s) => projectSnapshot(s, snap, effects)));
  interpretEffects(effects);
  setState("cursor", snap.seq); // snapshot cursor is unconditional
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
function bumpUpdating() {
  setUpdating(true);
  clearTimeout(updatingTimer);
  updatingTimer = window.setTimeout(() => setUpdating(false), UPDATING_DEBOUNCE_MS);
}
