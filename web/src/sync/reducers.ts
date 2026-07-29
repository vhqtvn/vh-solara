// The store reducers, extracted from stream.ts — the reducer-layer extraction
// boundary (regions 2+3 of the stream-facade decomposition study). Owns the
// wholesale snapshot reducer (applySnapshot), the session structural-event
// reducer (applySessionEvent), the archive-side eager prune (pruneSessionDeleted),
// the message/part/activity/permission/question/unread/lastAgent/status reducer
// (applyMessageEvent), the two pure helpers those reducers share (mergeLastAgents,
// epochChanged), and the anti-spam "updating" indicator that every reducer arms at
// its entry (UPDATING_DEBOUNCE_MS / isUpdating / bumpUpdating).
//
// WHY THIS SEPARATES. The reducers are the reverse-dependency target that
// tree-transport.ts (applySnapshot / applySessionEvent / applyMessageEvent) and
// session-stream.ts (applyMessageEvent) import. Relocating them here lets the
// transport modules import the reducers directly without reaching back into the
// stream.ts facade. For backward compatibility stream.ts re-exports every symbol
// below, so tests, the sync.ts barrel, actions.ts, and the namespace `await
// import("../../src/sync/stream")` C4 suite keep working unchanged.
//
// SEAM — synchronous cross-module calls, no reactive mirror. All calls into this
// module are SYNCHRONOUS (tree-transport passes the reducer as the apply fn to
// applyTreeFrame; session-stream calls applyMessageEvent inline in its listener).
// The import cycle session-stream → reducers → history → session-stream is
// TDZ-safe: every cross-module reference is a runtime call inside a listener /
// reducer body, never a top-level read, so no binding is dereferenced at eval
// time.
//
// GPU-HEAT. The reducers are pure store reconciliation; the token-streaming hot
// path (part.upsert → upsertPart → state.messages mutation → Part re-render,
// coalesced ~5fps) is UNCHANGED by relocation. bumpUpdating is debounced 600ms —
// no per-token signal write.
import { produce } from "solid-js/store";
import { createSignal } from "solid-js";
import type { Snapshot } from "../types";
import {
  deleteMessage,
  deletePart,
  upsertMessage,
  upsertPart,
  prependMessagesIfAbsent,
} from "../lib/reduce";
import { pushNotification } from "../notify";
import { log } from "../lib/log";
import { state, setState, persist } from "./store";
import { notifyFromMessage, maybeNotifyRootDone, maybeClearWaiting } from "./orchestration";
import { patchTreeAgent } from "./treeState";
import { dropPinnedSession } from "../sidebar";
import { deriveMessageWindow, resetPageInFlight } from "./history";

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

// Exported for integration tests (tests/unit/applySnapshot.test.ts) — it mutates
// the singleton store, so the tests drive it directly and assert on `state`.
export function applySnapshot(snap: Snapshot) {
  bumpUpdating();
  const incomingEpoch = snap.epoch || "";
  const changed = epochChanged(state.epoch, incomingEpoch);
  // B2a resync window: mergeLastAgents is ONLY correct while the server is
  // re-aggregating after a restart. Outside that window a complete AUTHORITATIVE
  // snapshot must be able to CLEAR a label (e.g. a session whose latest
  // assistant no longer has an agent, or whose recomputed messages yield none).
  // We are "resyncing" when ANY of these hold:
  //   - this snapshot is itself an epoch transition (`changed`), OR
  //   - the latched epochChanged flag from a recent transition is still set
  //     (the toast hasn't consumed it yet — e.g. back-to-back snapshots in one
  //     reactive tick), OR
  //   - any session in this snapshot is still hasMessages===false (its tail
  //     hasn't been pulled yet → the lastAgents map is incomplete).
  // `state.epochChanged` is read BEFORE the latch is (re)set below, so the first
  // transition snapshot is caught via `changed` and later window snapshots via
  // the latch / hydration. Only an EXPLICIT hasMessages===false counts — an
  // omitted gate (older daemon) or omitted hasMessages must NOT pin resync mode
  // forever (that would reintroduce the overcorrection and block legitimate
  // clears).
  //
  // WIRE-FIELD ALIAS (audit L-03): the gate field is read as `hasMessages`
  // (the exact name); the daemon dual-emits the retained `hydrated` alias with
  // the same value, so a stale un-reloaded tab that still reads `hydrated`
  // keeps working. See docs/ai/wire-field-deprecation.md.
  const resyncing =
    changed ||
    state.epochChanged ||
    Object.values(snap.gate || {}).some((g) => !!g && g.hasMessages === false);
  setState(
    produce((s) => {
      // Reconcile: replace the session set with the authoritative snapshot.
      s.sessions = {};
      for (const sess of snap.sessions || []) s.sessions[sess.id] = sess;
      s.activity = { ...(snap.activity || {}) };
      // B2a: merge-protect labels only INSIDE the resync window (above) so a
      // mid-aggregation snapshot can ADD/UPDATE but never wipe. Outside the
      // window the server map is authoritative — a wholesale replace lets a
      // legitimate clear (an id the server omits) propagate. mergeLastAgents
      // semantics are unchanged for the resync branch (incoming non-empty wins;
      // FE entries the snapshot omits are kept). The wholesale branch also
      // prunes orphans: ids absent from snap.lastAgents are dropped.
      s.lastAgents = resyncing
        ? mergeLastAgents(s.lastAgents, snap.lastAgents || {})
        : { ...(snap.lastAgents || {}) };
      // Tier-A current-verb facets seed from the snapshot (active sessions only;
      // the daemon omits idle/cleared ones). Ephemeral — never persisted.
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
      // S3 epoch transition: latch so the connection-health toast can surface
      // "Server restarted — re-syncing…". The merge-protect above already
      // shielded the labels from this (potentially mid-aggregation) snapshot.
      if (changed) s.epochChanged = true;
      if (incomingEpoch) s.epoch = incomingEpoch;
      s.cursor = snap.seq;
      // Phase 3 snapshot trim: the AUTHORITY_COMPLETE path never hoists (the
      // legacy Snapshot() path keeps per-session fields), so snap.projectConstants
      // is undefined here. Clear any stale value from a prior projected snapshot
      // so a project switch on a legacy daemon doesn't leave the old project's
      // fallback in place. Harmless: session.model is always present on this path.
      s.projectConstants = snap.projectConstants;
    }),
  );
  persist();
}

// Exported for integration tests (tests/unit/applySnapshot.test.ts).
export function applySessionEvent(kind: string, seq: number, payload: any) {
  bumpUpdating();
  setState(
    produce((s) => {
      if (kind === "session.upsert") s.sessions[payload.id] = payload;
      else if (kind === "session.delete") {
        delete s.sessions[payload.id];
        // B2b: prune the per-session metadata maps so a deleted session's facts
        // don't leak and can't resurrect on id-reuse. lastAgents is a
        // snapshot-seeded facet that must not outlive the session; messagesDelivered
        // is the open-session delivery flag, cleared here to stay consistent with
        // the session's removal. (s.messages is owned by the Stream-2 / openSession
        // lifecycle and reconciled separately, so it is NOT pruned here — see
        // SyncState.messagesDelivered.) Phase 3: messageWindows is pruned for the
        // same reason — a stale window state (hasOlder/oldestResidentID) must not
        // resurrect on id-reuse. Phase 4: pageInFlight (the in-flight
        // historical-page request) is also pruned — a deleted session's in-flight
        // page must not land into a resurrected id-reuse.
        delete s.lastAgents[payload.id];
        delete s.messageWindows[payload.id];
        delete s.messagesDelivered[payload.id];
        delete s.messagesError[payload.id];
        delete s.refreshing[payload.id];
        resetPageInFlight(payload.id);
      }
      if (seq) s.cursor = seq;
    }),
  );
  // Pins: proactively drop the deleted session from serverOrder OUTSIDE the
  // store produce() (it mutates the sidebar's own Solid signals, not the stream
  // store) — mirrors pruneSessionDeleted's placement. A stale pinned id left in
  // serverOrder would brick the next pin operation via the anti-resurrection
  // guard. Local correction only (no PUT); the S2 400 self-heal is the durable
  // backstop. Idempotent.
  if (kind === "session.delete") dropPinnedSession(payload.id);
  persist();
}

// pruneSessionDeleted removes a session from the client store as if a
// session.delete event had arrived for it. Called eagerly from archive.ts
// after a successful archive so the UI prunes immediately even when the
// server did NOT emit a delete event — which happens when the archived
// session was already absent from vh-solara's server-side live store (e.g.
// an orphan pruned by a prior cascade or demotion), so RemoveSessions found
// nothing to delete. Idempotent: a later session.delete for the same id is a
// harmless re-delete of an already-absent key. Mirrors the session.delete
// handler in applySessionEvent exactly (minus the cursor bump, which is an
// event-seq concern the archive path doesn't carry).
export function pruneSessionDeleted(id: string) {
  setState(
    produce((s) => {
      delete s.sessions[id];
      delete s.lastAgents[id];
      delete s.messageWindows[id];
      delete s.messagesDelivered[id];
      delete s.messagesError[id];
      delete s.refreshing[id];
    }),
  );
  resetPageInFlight(id);
  // Pins: proactively drop the archived/deleted session from serverOrder. The
  // archive path (archive.ts) reaches this fn for each affected id; a stale
  // pinned id left in serverOrder would brick the next pin operation via the
  // anti-resurrection guard. Local correction only (no PUT); the S2 400
  // self-heal is the durable backstop. Idempotent + no-op in legacy mode.
  dropPinnedSession(id);
  persist();
}

// Message/part events are applied only for opened sessions (those present in
// state.messages) to bound memory. The mutation logic lives in ./lib/reduce.
// trackCursor: whether this event should advance the persisted resume cursor.
// Stream 2 (active-session messages) passes false — it always re-snapshots on
// connect (never resumes), so letting its high-seq message events advance the
// shared cursor would push Stream 1's resume point PAST structural events it
// hasn't applied yet (e.g. an activity=busy), which then get skipped on
// reconnect — leaving the sidebar stuck on a stale state (the "busy session
// shows idle, no Stop button" bug). Only Stream 1's events move the cursor.
export function applyMessageEvent(kind: string, seq: number, payload: any, trackCursor = true) {
  bumpUpdating();
  setState(
    produce((s) => {
      switch (kind) {
        case "message.upsert": {
          const sm = s.messages[payload.sessionID];
          if (sm) upsertMessage(sm, payload);
          notifyFromMessage(payload);
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
          // session's FULL message history (emitted even when the fetch returned
          // zero or unchanged messages, since those produce no message.* delta).
          // Flip the per-client delivery flag so the transcript moves from
          // "loading" to "delivered-and-empty" (or renders the just-hydrated msg
          // deltas that Stream 2 forwarded alongside this on the same connection).
          // Clear any prior messagesError: a later successful load supersedes a
          // past failure (e.g. retry after a transient background-hydration error).
          if (payload.sessionID) {
            s.messagesDelivered[payload.sessionID] = true;
            delete s.messagesError[payload.sessionID];
          }
          break;
        }
        case "messages.batch": {
          // Cold-load wholesale content: the daemon collapsed the session's
          // entire cold-load message+part history (what would otherwise be N
          // per-message message.upsert + per-part part.upsert events) into ONE
          // event. Ingest it via prependMessagesIfAbsent (merge-if-absent — the
          // same primitive applySessionSnapshot uses for a warm-session snapshot) — so the
          // transcript populates without N reactive rounds (over the controller
          // tunnel each event is a yamux frame + WebSocket message, the root
          // cause of the cold-load stall). DECOUPLED from the reveal gate: this
          // carries content only; messages.loaded (still emitted after the batch)
          // flips messagesDelivered so the gate opens. The batch MAY arrive before
          // messages.loaded — that is the whole point (content staged, then the
          // gate flips). Live message.upsert/part.upsert are unchanged.
          //
          // Phase 3 (transcript windowing): after Phase 1's server-side bounded
          // projection, the batch carries the recent TAIL only (default 100 msgs
          // / 1 MiB), and the OUTER payload carries a `window` field (sibling to
          // encoding/data) with has_older/oldest_loaded_id metadata. Populate
          // messageWindows[sid] so the Phase-4 "Load older" path knows whether
          // older messages exist and where the resident tail starts. Back-compat:
          // a pre-Phase-1 server omits `window` → deriveMessageWindow yields
          // {hasOlder:false} (unbounded server, nothing older to fetch).
          if (payload.sessionID) {
            const items = payload.messages || [];
            // MERGE, not wholesale-replace. A live message.upsert/part.upsert for
            // this session can land on Stream-2 BEFORE the batch's gzip64 decode
            // resolves — the snapshot→upsert→batch reload interleaving. The
            // pendingBatch gate (stream.ts ~2455/2468) only serializes events that
            // arrive DURING the decode; it CANNOT help when the live upsert
            // applied BEFORE the batch was even fired (the resident live message
            // predates the batch decode). A wholesale-replace here would clobber
            // that resident message. prependMessagesIfAbsent — the same primitive
            // applySessionSnapshot uses on the warm-snapshot path — inserts batch
            // items that are ABSENT and NEVER touches an existing byId entry, so
            // live always wins. Cold-load establishment is preserved: on first
            // hydrate s.messages[sid] is empty/absent, every item is absent, and
            // merge ≡ wholesale-replace. Structurally consistent with
            // applySessionSnapshot (which already merges via the same primitive).
            if (!s.messages[payload.sessionID]) {
              s.messages[payload.sessionID] = { order: [], byId: {} };
            }
            prependMessagesIfAbsent(s.messages[payload.sessionID], items);
            s.messageWindows[payload.sessionID] = deriveMessageWindow(items, payload.window);
          }
          break;
        }
        case "messages.error": {
          // Background fetch failed; the daemon left the session UNLOADED (it
          // retries on the next selection/reconnect). Record the failure so the
          // chat's visual-reveal gate can fall back to showing whatever partial
          // content was streamed (instead of wedging forever on a blank loading
          // state — messages.loaded never arrives on failure). Log as well.
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
            // Cross-stream completion bridge: activity=idle arrives on the TREE
            // stream (Stream 1), while the message.upsert carrying
            // time.completed arrives on the SESSION stream (Stream 2). They are
            // independent connections whose delivery order is NOT guaranteed —
            // when Stream 1 wins, .working-text unmounts (working() reads
            // activity[id]) BEFORE Stream 2's completed upsert has flipped
            // `settled`, so the streaming view (.md-stream) briefly outlives the
            // busy indicator (the session-completion flake). Stamping
            // time.completed on the last assistant message HERE, in the SAME
            // produce() draft that clears activity, makes `settled` flip in the
            // SAME reactive flush that unmounts .working-text — so whichever
            // stream wins, the streaming view never outlives the busy indicator.
            // The real message.upsert(completed) (whenever it lands) is then a
            // no-op: reduce.ts upsertMessage does existing.info = info, but
            // settled() only reads time.completed, which is already set. Mirrors
            // markSessionIdle (the optimistic idle path used on abort,
            // actions.ts). Scoped to idle: busy/retry are mid-turn (the last
            // assistant is genuinely in-flight) and must NOT be stamped.
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
          // The completion ping is decided AFTER the store updates (below), at
          // the root level — not per-session — so a finished root pings once and
          // noisy subsession completions don't.
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
          // primitive (tool + trimmed state) so the chat row can format
          // "Reading parser.go" via toolVerb/toolSubject without loading Tier-B
          // messages. Empty tool clears it (idle/error/turn-complete). Mirrors
          // the activity live-patch pattern; Stream-1 always-streams it
          // (sendable passes any kind not prefixed message./part.).
          if (payload.sessionID) {
            if (payload.tool) s.currentVerbs[payload.sessionID] = { tool: payload.tool, state: payload.state };
            else delete s.currentVerbs[payload.sessionID];
          }
          break;
        case "lastAgent.set":
          // Cold-seed live-patch: the daemon's background seedColdLastAgents
          // (a non-blocking goroutine) usually finishes AFTER this client's
          // first snapshot landed, so Snapshot.LastAgents didn't carry this
          // session's agent. This event delivers the seeded agent name to an
          // already-connected client so the per-agent chip renders in the tree
          // BEFORE the session is opened. sessionLastAgent still prefers the
          // live message scan once messages load (live-scan-takes-precedence),
          // so this only fills the cold gap. Mirrors activity.verb's pattern
          // (a snapshot-only facet pushed live).
          if (payload.sessionID) {
            if (payload.agent) {
              s.lastAgents[payload.sessionID] = payload.agent;
              // tree=2 gap fill: also patch the tree node so the chip renders on
              // collapsed nodes without an expand round-trip. No-op for nodes
              // that already have their agent.
              patchTreeAgent(payload.sessionID, payload.agent);
            } else delete s.lastAgents[payload.sessionID];
          }
          break;
        case "status":
          // A session.error event carries an `error` payload (activity already
          // flipped to "error" via the separate activity event). Surface it so a
          // failed turn/resume is VISIBLE — e.g. prompt_async reports a turn that
          // couldn't start as a session.error rather than silently doing nothing.
          if (payload?.error && payload.sessionID) {
            const e = payload.error;
            pushNotification({
              kind: "error",
              sessionID: payload.sessionID,
              title: "errored",
              detail: e?.data?.message || e?.message || e?.name || "Session error",
            });
          }
          break; // activity drives the indicator; this only adds the notification
      }
      if (trackCursor && seq) s.cursor = seq;
    }),
  );
  if (kind === "activity" && payload.sessionID) {
    maybeNotifyRootDone(payload.sessionID);
    maybeClearWaiting(payload.sessionID); // resumed working → no longer awaiting you
  }
  if ((kind === "permission.delete" || kind === "question.delete") && payload.sessionID) {
    maybeClearWaiting(payload.sessionID); // answered → ack the "needs input" nudge
  }
  persist();
}

// --- Feature 2: anti-spam "updating" indicator (U3 debounce) ---------------
// Leading edge lights the indicator on the first data event; trailing edge
// holds it for UPDATING_DEBOUNCE_MS after the LAST event, then clears. A token
// stream (events <600ms apart) keeps it continuously lit without per-token
// flicker; a pause longer than the window turns it off. bumpUpdating is called
// at the top of applySnapshot/applySessionEvent/applyMessageEvent — the data
// reconciliation entry points for both streams.
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
