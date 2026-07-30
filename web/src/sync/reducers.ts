// The store PROJECTION layer (L-08/M4). Each export synchronously projects a
// server fact into the SyncState DRAFT and RECORDS typed reconciliation effects
// into a caller-supplied array. This module performs NO side-effect policy:
// it does NOT dispatch notifications, mutate the pin store, reset page-flight,
// schedule persistence, touch localStorage, set timers, or reach the transport.
// The orchestration boundary (reconcile.ts) wraps these projections in a Solid
// produce(), interprets the returned effects (notify/persist/pin/page-flight),
// advances the resume cursor, and schedules persistence — in that order.
//
// The standing check TestApplyReconcileHasNoInlinePolicy (web/tests/unit/
// reducersPolicyBoundary.test.ts) pins that this file invokes none of those
// policy APIs directly.
//
// ONE NAMED TEMPORARY EXCEPTION during the phased tree-boundary migration:
// patchTreeAgent (the tree-agent patch) stays inline here because its final
// ownership is a must-wait tree-boundary item (applyTreeOpStore / tree ranking
// / tree-agent patch final ownership). It is the ONLY direct cross-store tree
// mutation allowed in this slice; a later slice extracts it behind an effect.
//
// SEAM — synchronous, draft-mutating, pure of store-coupling. Each project*
// function takes the produce() draft `s` (so it reads current pre-mutation
// state from the draft, never from the module-level store) plus the decoded
// payload and an `effects` sink. The orchestration wraps the call:
//   setState(produce((s) => projectMessageEvent(s, kind, payload, effects)))
// This makes the projection a pure function of (draft, event) → (draft mutation,
// effects), independently testable without the orchestration policy.
import type { Snapshot } from "../types";
import type { SyncState } from "./store";
import type { ReconcileEffect } from "./reducers.types";
import {
  deleteMessage,
  deletePart,
  upsertMessage,
  upsertPart,
  prependMessagesIfAbsent,
} from "../lib/reduce";
import { deriveMessageWindow } from "./history";
import { patchTreeAgent } from "./treeState"; // NAMED tree-boundary exception (see header)
import { log } from "../lib/log";

// mergeLastAgents — the agent-label fix (S3). During a server restart the
// daemon serves HTTP while still aggregating session tails, so a mid-hydrate
// tree snapshot carries an INCOMPLETE lastAgents map (sessions whose tail
// hasn't been pulled yet are simply absent). The old code wholesale-replaced
// the FE cache (`s.lastAgents = {...snap.lastAgents}`), which erased correct
// labels — the agent chips blanked until the next FULL snapshot landed. This
// merge keeps any FE entry the incoming snapshot omits/empties, so a
// mid-aggregation snapshot can only ADD or UPDATE labels, never wipe them.
// Incoming non-empty values still win (so a genuine change applies once
// aggregation completes). Pure + exported for unit testing.
export function mergeLastAgents(
  prev: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(incoming)) {
    if (name) out[id] = name; // server-provided label (authoritative when present)
  }
  for (const [id, name] of Object.entries(prev)) {
    if (name && !out[id]) out[id] = name; // keep FE cache when the snapshot omits it
  }
  return out;
}

// epochChanged — pure epoch-transition detector. True only when we already had
// a real epoch AND the incoming one differs (a restart while connected). The
// first snapshot after a page load has an empty prevEpoch → not a change.
export function epochChanged(prevEpoch: string, incomingEpoch: string): boolean {
  return !!prevEpoch && !!incomingEpoch && prevEpoch !== incomingEpoch;
}

// projectSnapshot — project a wholesale snapshot into the draft. Reads the
// resync-window signals from the draft (s.epoch / s.epochChanged — the
// pre-mutation values) and rebuilds the authoritative slices. Records
// sync-state-dirty (cursor advance + persistence are orchestration policy).
// Exported for the orchestration wrapper + integration tests.
export function projectSnapshot(s: SyncState, snap: Snapshot, effects: ReconcileEffect[]): void {
  const incomingEpoch = snap.epoch || "";
  const changed = epochChanged(s.epoch, incomingEpoch);
  // B2a resync window: mergeLastAgents is ONLY correct while the server is
  // re-aggregating after a restart. Outside that window a complete AUTHORITATIVE
  // snapshot must be able to CLEAR a label. We are "resyncing" when ANY hold:
  //   - this snapshot is itself an epoch transition (`changed`), OR
  //   - the latched epochChanged flag from a recent transition is still set
  //     (the toast hasn't consumed it yet), OR
  //   - any session in this snapshot is still hasMessages===false (its tail
  //     hasn't been pulled yet → the lastAgents map is incomplete).
  // `s.epochChanged` is read BEFORE the latch is (re)set below, so the first
  // transition snapshot is caught via `changed` and later window snapshots via
  // the latch / hydration. Only an EXPLICIT hasMessages===false counts.
  //
  // WIRE-FIELD ALIAS (audit L-03): the gate field is read as `hasMessages`
  // (the exact name); the daemon dual-emits the retained `hydrated` alias with
  // the same value. See docs/ai/wire-field-deprecation.md.
  const resyncing =
    changed ||
    s.epochChanged ||
    Object.values(snap.gate || {}).some((g) => !!g && g.hasMessages === false);
  // Reconcile: replace the session set with the authoritative snapshot.
  s.sessions = {};
  for (const sess of snap.sessions || []) s.sessions[sess.id] = sess;
  s.activity = { ...(snap.activity || {}) };
  // B2a: merge-protect labels only INSIDE the resync window (above) so a
  // mid-aggregation snapshot can ADD/UPDATE but never wipe. Outside the
  // window the server map is authoritative. mergeLastAgents semantics are
  // unchanged for the resync branch (incoming non-empty wins; FE entries the
  // snapshot omits are kept). The wholesale branch also prunes orphans.
  s.lastAgents = resyncing
    ? mergeLastAgents(s.lastAgents, snap.lastAgents || {})
    : { ...(snap.lastAgents || {}) };
  // Tier-A current-verb facets seed from the snapshot (active sessions only).
  // Ephemeral — never persisted.
  s.currentVerbs = { ...(snap.currentVerbs || {}) };
  s.permissions = {};
  for (const [sid, perms] of Object.entries(snap.permissions || {})) {
    s.permissions[sid] = {};
    for (const p of perms) s.permissions[sid][p.id] = p;
  }
  s.questions = {};
  for (const [sid, qs] of Object.entries(snap.questions || {})) {
    s.questions[sid] = {};
    for (const q of qs) s.questions[sid][q.id] = q;
  }
  s.unread = {};
  for (const id of snap.unread || []) s.unread[id] = true;
  // Per-session gate facts — seed the live mirror authoritatively from the
  // snapshot so the permission.blocked live patch (projectMessageEvent) composes
  // coherently: the live false→true flip lands on top of the seeded baseline,
  // and the next snapshot supersedes it wholesale (mirrors lastAgents). Shallow-
  // clone each GateFacts so a live mutation never aliases the snapshot object.
  s.gate = {};
  for (const [id, g] of Object.entries(snap.gate || {})) {
    if (g) s.gate[id] = { ...g };
  }
  // S3 epoch transition: latch so the connection-health toast can surface
  // "Server restarted — re-syncing…". The merge-protect above already shielded
  // the labels from this (potentially mid-aggregation) snapshot.
  if (changed) s.epochChanged = true;
  if (incomingEpoch) s.epoch = incomingEpoch;
  // Phase 3 snapshot trim: the AUTHORITY_COMPLETE path never hoists (the legacy
  // Snapshot() path keeps per-session fields), so snap.projectConstants is
  // undefined here. Clear any stale value from a prior projected snapshot.
  s.projectConstants = snap.projectConstants;
  // cursor advance (snap.seq, unconditional) is orchestration policy.
  effects.push({ kind: "sync-state-dirty" });
}

// projectSessionRemoval — the ONE shared removal projection (L-08/M4 item 5).
// Both the session.delete event (projectSessionEvent) and the eager archive
// prune (pruneSessionDeleted in reconcile.ts) route through this helper so the
// deleted session is removed from every shared slice identically. Records the
// session-removed effect (orchestration runs resetPageInFlight + dropPinnedSession)
// and sync-state-dirty (orchestration schedules persistence).
export function projectSessionRemoval(s: SyncState, id: string, effects: ReconcileEffect[]): void {
  // B2b: prune the per-session metadata maps so a deleted session's facts don't
  // leak and can't resurrect on id-reuse. lastAgents is a snapshot-seeded facet
  // that must not outlive the session; messagesDelivered is the open-session
  // delivery flag, cleared here to stay consistent with the session's removal.
  // (s.messages is owned by the Stream-2 / openSession lifecycle and reconciled
  // separately, so it is NOT pruned here.) Phase 3: messageWindows is pruned so
  // a stale window state (hasOlder/oldestResidentID) must not resurrect on
  // id-reuse. resetPageInFlight + dropPinnedSession are orchestration effects.
  delete s.sessions[id];
  delete s.lastAgents[id];
  delete s.gate[id];
  delete s.messageWindows[id];
  delete s.messagesDelivered[id];
  delete s.messagesError[id];
  delete s.refreshing[id];
  effects.push({ kind: "session-removed", sessionID: id });
  effects.push({ kind: "sync-state-dirty" });
}

// projectSessionEvent — project a structural session event (upsert / delete).
// Cursor advance is orchestration policy (carried via ReconcileContext).
export function projectSessionEvent(
  s: SyncState,
  kind: string,
  payload: any,
  effects: ReconcileEffect[],
): void {
  if (kind === "session.upsert") {
    s.sessions[payload.id] = payload;
    effects.push({ kind: "sync-state-dirty" });
  } else if (kind === "session.delete") {
    projectSessionRemoval(s, payload.id, effects);
  }
}

// projectMessageEvent — project a message/part/activity/permission/question/
// unread/lastAgent/status event into the draft (applied only for opened
// sessions — those present in s.messages — to bound memory). The mutation logic
// lives in ./lib/reduce. Notification/observation facts are recorded as effects;
// the cursor advance is orchestration policy (carried via ReconcileContext).
export function projectMessageEvent(
  s: SyncState,
  kind: string,
  payload: any,
  effects: ReconcileEffect[],
): void {
  switch (kind) {
    case "message.upsert": {
      const sm = s.messages[payload.sessionID];
      if (sm) upsertMessage(sm, payload);
      // Observe an assistant-error fact. The legacy reducer called
      // notifyFromMessage(payload) here (a direct notification dispatch); the
      // notification policy is now decided by orchestration. The detail string
      // mirrors notifyFromMessage exactly.
      const info = payload?.info;
      const err = info?.error;
      if (info?.role === "assistant" && err) {
        effects.push({
          kind: "assistant-error-observed",
          sessionID: info.sessionID,
          detail: err.data?.message || err.name || "Assistant error",
        });
      }
      break;
    }
    case "message.delete": {
      const sm = s.messages[payload.sessionID];
      if (sm) deleteMessage(sm, payload.messageID);
      break;
    }
    case "part.upsert": {
      const sm = s.messages[payload.sessionID];
      if (sm) upsertPart(sm, payload);
      break;
    }
    case "part.delete": {
      const sm = s.messages[payload.sessionID];
      if (sm) deletePart(sm, payload.messageID, payload.partID);
      break;
    }
    case "messages.loaded": {
      // Slice C async-hydration completion: the daemon finished fetching this
      // session's FULL message history. Flip the per-client delivery flag so the
      // transcript moves from "loading" to "delivered-and-empty". Clear any prior
      // messagesError: a later successful load supersedes a past failure.
      if (payload.sessionID) {
        s.messagesDelivered[payload.sessionID] = true;
        delete s.messagesError[payload.sessionID];
      }
      break;
    }
    case "messages.batch": {
      // Cold-load wholesale content: the daemon collapsed the session's entire
      // cold-load message+part history into ONE event. Ingest via
      // prependMessagesIfAbsent (merge-if-absent) so the transcript populates
      // without N reactive rounds. DECOUPLED from the reveal gate: this carries
      // content only; messages.loaded (still emitted after the batch) flips
      // messagesDelivered.
      //
      // Phase 3 (transcript windowing): the OUTER payload carries a `window`
      // field with has_older/oldest_loaded_id metadata. Populate
      // messageWindows[sid] so the Phase-4 "Load older" path knows whether older
      // messages exist. deriveMessageWindow is a PURE projection helper.
      if (payload.sessionID) {
        const items = payload.messages || [];
        // MERGE, not wholesale-replace. A live message.upsert/part.upsert for
        // this session can land on Stream-2 BEFORE the batch's gzip64 decode
        // resolves. prependMessagesIfAbsent inserts batch items that are ABSENT
        // and NEVER touches an existing byId entry, so live always wins.
        if (!s.messages[payload.sessionID]) {
          s.messages[payload.sessionID] = { order: [], byId: {} };
        }
        prependMessagesIfAbsent(s.messages[payload.sessionID], items);
        s.messageWindows[payload.sessionID] = deriveMessageWindow(items, payload.window);
      }
      break;
    }
    case "messages.error": {
      // Background fetch failed; the daemon left the session UNLOADED. Record
      // the failure so the chat's visual-reveal gate can fall back to showing
      // whatever partial content was streamed (instead of wedging forever).
      // log is an observability side-effect (not a policy decision), so it stays
      // in the projection.
      if (payload?.sessionID) {
        s.messagesError[payload.sessionID] = true;
        log.warn("sync", "messages hydration failed", {
          id: payload.sessionID,
          error: payload.error,
        });
      }
      break;
    }
    case "activity":
      if (payload.sessionID) {
        s.activity[payload.sessionID] = payload.state;
        // Cross-stream completion bridge (STAYS IN PROJECTION — same-flush
        // requirement, a deterministic derivation not policy): activity=idle
        // arrives on the TREE stream (Stream 1), while the message.upsert
        // carrying time.completed arrives on the SESSION stream (Stream 2).
        // Their delivery order is NOT guaranteed — when Stream 1 wins,
        // .working-text unmounts BEFORE Stream 2's completed upsert has flipped
        // `settled`, so the streaming view briefly outlives the busy indicator.
        // Stamping time.completed on the last assistant message HERE, in the
        // SAME produce() draft that clears activity, makes `settled` flip in the
        // SAME reactive flush that unmounts .working-text. Scoped to idle:
        // busy/retry are mid-turn (the last assistant is genuinely in-flight).
        if (payload.state === "idle") {
          const sm = s.messages[payload.sessionID];
          if (sm && sm.order.length) {
            const last = sm.byId[sm.order[sm.order.length - 1]];
            if (last && last.info.role === "assistant" && !last.info.time?.completed) {
              last.info = {
                ...last.info,
                time: { ...(last.info.time || {}), completed: Date.now() },
              };
            }
          }
        }
      }
      break;
    case "permission.upsert":
      if (payload.sessionID && payload.id) {
        if (!s.permissions[payload.sessionID]) s.permissions[payload.sessionID] = {};
        s.permissions[payload.sessionID][payload.id] = payload;
      }
      break;
    case "permission.delete":
      if (payload.sessionID && s.permissions[payload.sessionID]) {
        delete s.permissions[payload.sessionID][payload.permissionID];
      }
      break;
    case "question.upsert":
      if (payload.sessionID && payload.id) {
        if (!s.questions[payload.sessionID]) s.questions[payload.sessionID] = {};
        s.questions[payload.sessionID][payload.id] = payload;
      }
      break;
    case "question.delete":
      if (payload.sessionID && s.questions[payload.sessionID]) {
        delete s.questions[payload.sessionID][payload.questionID];
      }
      break;
    case "unread.set":
      if (payload.sessionID) s.unread[payload.sessionID] = true;
      break;
    case "unread.clear":
      if (payload.sessionID) delete s.unread[payload.sessionID];
      break;
    case "activity.verb":
      // Tier-A rich-activity facet for an UNOPENED session: the RAW tool
      // primitive so the chat row can format "Reading parser.go" without loading
      // Tier-B messages. Empty tool clears it.
      if (payload.sessionID) {
        if (payload.tool) s.currentVerbs[payload.sessionID] = { tool: payload.tool, state: payload.state };
        else delete s.currentVerbs[payload.sessionID];
      }
      break;
    case "lastAgent.set":
      // Cold-seed live-patch: the daemon's background seedColdLastAgents usually
      // finishes AFTER this client's first snapshot landed, so Snapshot.LastAgents
      // didn't carry this session's agent. This event delivers the seeded agent
      // name so the per-agent chip renders in the tree BEFORE the session is
      // opened. sessionLastAgent still prefers the live message scan once
      // messages load.
      if (payload.sessionID) {
        if (payload.agent) {
          s.lastAgents[payload.sessionID] = payload.agent;
          // NAMED TREE-BOUNDARY EXCEPTION (L-08/M4): tree-agent patch final
          // ownership is a must-wait item, so patchTreeAgent stays inline here.
          // tree=2 gap fill: also patch the tree node so the chip renders on
          // collapsed nodes without an expand round-trip. No-op for nodes that
          // already have their agent.
          patchTreeAgent(payload.sessionID, payload.agent);
        } else delete s.lastAgents[payload.sessionID];
      }
      break;
    case "permission.blocked":
      // Live false→true permission-blocking transition (mirrors lastAgent.set's
      // cold-seed live patch). The server emits this Stream-1 event the moment a
      // permission blocking occurs (KindPermissionBlocked, M8/L-04) so an
      // already-connected client flips the sticky gate fact live — without it the
      // client only converges from the next snapshot/reconnect. Patch BOTH wire
      // spellings for symmetry (L-09 dual-emit alias window): permissionWasBlocked
      // (the exact-name alias the SPA migrates toward) and permission_blocked (its
      // retained peer, set via the GateFacts index signature). Payload shape:
      // {sessionID, permissionWasBlocked: true}.
      if (payload.sessionID) {
        const g = s.gate[payload.sessionID] ?? (s.gate[payload.sessionID] = {});
        g.permissionWasBlocked = true;
        g["permission_blocked"] = true;
      }
      break;
    case "status":
      // A session.error event carries an `error` payload (activity already
      // flipped to "error" via the separate activity event). Observe the error
      // fact; orchestration surfaces it as a notification.
      if (payload?.error && payload.sessionID) {
        const e = payload.error;
        effects.push({
          kind: "assistant-error-observed",
          sessionID: payload.sessionID,
          detail: e?.data?.message || e?.message || e?.name || "Session error",
        });
      }
      break; // activity drives the indicator; this only observes the error
  }
  // Notification-observation effects (policy decided by orchestration). These
  // mirror the post-produce calls in the legacy reducer (maybeNotifyRootDone /
  // maybeClearWaiting) but are recorded as factual effects so the projection
  // stays free of notify/orchestration imports.
  if (kind === "activity" && payload.sessionID) {
    effects.push({ kind: "root-maybe-completed", sessionID: payload.sessionID });
    effects.push({ kind: "input-maybe-answered", sessionID: payload.sessionID }); // resumed working → no longer awaiting you
  }
  if ((kind === "permission.delete" || kind === "question.delete") && payload.sessionID) {
    effects.push({ kind: "input-maybe-answered", sessionID: payload.sessionID }); // answered → ack the "needs input" nudge
  }
  // The projected mutation dirtied the persisted slices. Interpreted LAST by
  // orchestration (after the cursor advance).
  effects.push({ kind: "sync-state-dirty" });
}
