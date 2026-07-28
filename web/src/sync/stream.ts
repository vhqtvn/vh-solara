// The stream state-machine: consumes the daemon's resumable /vh/stream over two
// EventSources, reconciles the store, and keeps itself alive (heartbeat
// watchdog, backoff reconnect, foreground/online recovery). It owns transport
// and store reconciliation; notification policy lives in ./orchestration.
import { produce } from "solid-js/store";
import { createSignal } from "solid-js";
import type { MessageWindowMeta, Snapshot } from "../types";
import {
  buildMessages,
  deleteMessage,
  deletePart,
  upsertMessage,
  upsertPart,
  prependMessagesIfAbsent,
} from "../lib/reduce";
import { pushNotification } from "../notify";
import { log } from "../lib/log";
import { state, setState, projectDir, selectedId, persist } from "./store";
import { notifyFromMessage, maybeNotifyRootDone, maybeClearWaiting } from "./orchestration";
import { isGateActive, setReconcileFn } from "../busy";
import { patchTreeAgent, treeMap } from "./treeState";
import { dropPinnedSession } from "../sidebar";
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
  //   - any session in this snapshot is still hydrated===false (its tail hasn't
  //     been pulled yet → the lastAgents map is incomplete).
  // `state.epochChanged` is read BEFORE the latch is (re)set below, so the first
  // transition snapshot is caught via `changed` and later window snapshots via
  // the latch / hydration. Only an EXPLICIT hydrated===false counts — an omitted
  // gate (older daemon) or omitted hydrated must NOT pin resync mode forever
  // (that would reintroduce the overcorrection and block legitimate clears).
  const resyncing =
    changed ||
    state.epochChanged ||
    Object.values(snap.gate || {}).some((g) => !!g && g.hydrated === false);
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
        // snapshot-seeded facet that must not outlive the session; messagesLoaded
        // is the open-session delivery flag, cleared here to stay consistent with
        // the session's removal. (s.messages is owned by the Stream-2 / openSession
        // lifecycle and reconciled separately, so it is NOT pruned here — see
        // SyncState.messagesLoaded.) Phase 3: messageWindows is pruned for the
        // same reason — a stale window state (hasOlder/oldestResidentID) must not
        // resurrect on id-reuse. Phase 4: pageInFlight (the in-flight
        // historical-page request) is also pruned — a deleted session's in-flight
        // page must not land into a resurrected id-reuse.
        delete s.lastAgents[payload.id];
        delete s.messageWindows[payload.id];
        delete s.messagesLoaded[payload.id];
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
      delete s.messagesLoaded[id];
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
            s.messagesLoaded[payload.sessionID] = true;
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
          // flips messagesLoaded so the gate opens. The batch MAY arrive before
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
