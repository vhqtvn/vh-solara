// The stream state-machine: consumes the daemon's resumable /vh/stream over two
// EventSources, reconciles the store, and keeps itself alive (heartbeat
// watchdog, backoff reconnect, foreground/online recovery). It owns transport
// and store reconciliation; notification policy lives in ./orchestration.
import { produce } from "solid-js/store";
import { createSignal } from "solid-js";
import type { Snapshot } from "../types";
import {
  buildMessages,
  deleteMessage,
  deletePart,
  upsertMessage,
  upsertPart,
} from "../lib/reduce";
import { pushNotification } from "../notify";
import { handleNotice } from "../alerts";
import { checkVersionNow } from "../pwa";
import { log } from "../lib/log";
import { state, setState, projectDir, selectedId, persist } from "./store";
import { normalizeTodos } from "./selectors";
import { notifyFromMessage, maybeNotifyRootDone, maybeClearWaiting } from "./orchestration";

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
      s.todos = {};
      for (const [sid, v] of Object.entries(snap.todos || {})) s.todos[sid] = normalizeTodos(v);
      s.unread = {};
      for (const id of snap.unread || []) s.unread[id] = true;
      // S3 epoch transition: latch so the connection-health toast can surface
      // "Server restarted — re-syncing…". The merge-protect above already
      // shielded the labels from this (potentially mid-aggregation) snapshot.
      if (changed) s.epochChanged = true;
      if (incomingEpoch) s.epoch = incomingEpoch;
      s.cursor = snap.seq;
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
        // SyncState.messagesLoaded.)
        delete s.lastAgents[payload.id];
        delete s.messagesLoaded[payload.id];
        delete s.messagesError[payload.id];
      }
      if (seq) s.cursor = seq;
    }),
  );
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
          // event. Ingest it in a single buildMessages mutation — the same path
          // applySessionSnapshot uses for a warm-session snapshot — so the
          // transcript populates without N reactive rounds (over the controller
          // tunnel each event is a yamux frame + WebSocket message, the root
          // cause of the cold-load stall). DECOUPLED from the reveal gate: this
          // carries content only; messages.loaded (still emitted after the batch)
          // flips messagesLoaded so the gate opens. The batch MAY arrive before
          // messages.loaded — that is the whole point (content staged, then the
          // gate flips). Live message.upsert/part.upsert are unchanged.
          if (payload.sessionID) {
            s.messages[payload.sessionID] = buildMessages(payload.messages || []);
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
          if (payload.sessionID) s.activity[payload.sessionID] = payload.state;
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
        case "todo":
          // OpenCode TodoWrite snapshot for a session (full list each time). The
          // event payload is the `{ sessionID, todos }` envelope.
          if (payload.sessionID) s.todos[payload.sessionID] = normalizeTodos(payload);
          break;
        case "activity.verb":
          // Tier-A rich-activity facet for an UNOPENED session: the RAW tool
          // primitive (tool + trimmed state) so the chat row can format
          // "Reading parser.go" via toolVerb/toolSubject without loading Tier-B
          // messages. Empty tool clears it (idle/error/turn-complete). Mirrors
          // the activity/todo live-patch patterns; Stream-1 always-streams it
          // (sendable passes any kind not prefixed message./part.).
          if (payload.sessionID) {
            if (payload.tool) s.currentVerbs[payload.sessionID] = { tool: payload.tool, state: payload.state };
            else delete s.currentVerbs[payload.sessionID];
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

async function fetchSessionMessages(id: string): Promise<any[]> {
  const res = await fetch(
    `/vh/snapshot?sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}`,
  );
  const snap: Snapshot = await res.json();
  return (snap.messages?.[id] as any[]) || [];
}

// On a tree-stream resync, refresh cached message state for NON-active opened
// sessions (the active one is owned by the live session stream, so skip it to
// avoid clobbering streamed deltas). Dispatched CONCURRENTLY: an operator with
// N open sessions used to wait N serial /vh/snapshot round-trips on every tree
// reconnect (each blocking on upstream client.Messages on a cold daemon).
// Promise.all fans them out in one tick; the inner try/catch keeps the prior
// per-session error isolation (one failed fetch keeps stale + does NOT reject
// the batch, so the other sessions still refresh).
// Exported for unit testing (tests/unit/refreshOpenSessions.test.ts).
export async function refreshOpenSessions() {
  const active = selectedId();
  await Promise.all(
    Object.keys(state.messages).map(async (id) => {
      if (id === active) return;
      try {
        const items = await fetchSessionMessages(id);
        setState("messages", id, buildMessages(items));
        setState("messagesLoaded", id, true);
      } catch {
        /* keep stale; reopening re-snapshots */
      }
    }),
  );
}

let es: EventSource | null = null;
let lastSeen = 0; // ms of the last byte/event from the server (incl. pings)
let reconnectTimer: number | undefined;
let backoff = 1000; // grows on repeated failures, reset on a healthy open
let everOpened = false; // first stream open is the initial load; later opens are reconnects
export const STALE_MS = 45_000; // ~3 missed 15s pings → assume the stream is dead

// --- Feature 1: staleness (S1) ---------------------------------------------
// healthNow is a coarse tick (bumped by the watchdog) so staleness re-evaluates
// over wall-clock time even with no store writes. isStale reads the
// NON-reactive module `lastSeen` (plain var → no per-event subscription), so
// consumers of isStale only re-run on healthNow / state.status changes, not on
// every SSE byte. This keeps the stale indicator off the per-token hot path.
const [healthNow, setHealthNow] = createSignal(0);
// tickHealth advances the coarse health tick WITHOUT touching the watchdog's
// reconnect logic. Called on a faster cadence than the 10s watchdog (see
// startSync) so a stale-but-open socket surfaces the stale indicator BEFORE
// the watchdog reconnects it — otherwise isStale() could never render (the
// watchdog flips status to "reconnecting" in the same tick it detects staleness).
export function tickHealth() {
  setHealthNow((n) => n + 1);
}
export function isStale(): boolean {
  healthNow(); // subscribe to the coarse tick
  return state.status === "live" && lastSeen > 0 && Date.now() - lastSeen > STALE_MS;
}
// lastSeenStateWritten throttles the mirror into the reactive store: markSeen
// fires on every SSE byte, but writing state.lastSeen that often would notify
// the debug surfaces per-token. Bound it to ~1 write/sec.
let lastSeenStateWritten = 0;
function markSeen() {
  lastSeen = Date.now();
  const now = lastSeen;
  if (now - lastSeenStateWritten >= 1000) {
    lastSeenStateWritten = now;
    setState("lastSeen", now);
  }
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
// --- Feature 3: connection-vs-server latency diagnostic (L1, FE-only) -----
// Purely additive instrumentation (zero server change). For each stream we
// capture performance.now() stamps and derive deltas:
//   open    = onopen − EventSource construction      (pure connection latency)
//   snap    = first snapshot − onopen                (server: ensureMessages + compute
//                                                      + serialize)
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
// ServersPanel as "conn Xms · server Yms · hydrate (Yms|warm|…)" so an operator
// can tell a slow connection from a slow server from a slow upstream fetch.
function recordLatency(stream: "tree" | "session", phase: "open" | "snap", ms: number): void {
  setState("connLatency", stream, phase, Math.max(0, Math.round(ms)));
}
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
// Per-connection stamps/flags. Reset on each (re)open; snap recorded once.
let treeT0 = 0;
let treeT1 = 0;
let treeSnapDone = false;
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
// Without coordination messages.loaded would flip messagesLoaded (the reveal
// gate) before the batch content staged → flash of empty content at reveal.
// The batch listener stashes its decode promise here; the messages.loaded /
// messages.error listener awaits any pending entry for the session before
// flipping the gate. Cleared as each batch lands (try/finally in the listener).
const pendingBatch = new Map<string, Promise<void>>();

export function connect(fresh = false) {
  clearTimeout(reconnectTimer);
  es?.close();
  const cursorParam = fresh ? "" : `cursor=${state.cursor}&`;
  treeT0 = performance.now(); // L1 t0: connection attempt begins
  treeT1 = 0;
  treeSnapDone = false;
  es = new EventSource(`/vh/stream?${cursorParam}sessions=&dir=${encodeURIComponent(projectDir())}`);
  markSeen();
  log.debug("sync", "tree stream connect", { cursor: fresh ? "fresh" : state.cursor, dir: projectDir() });
  es.addEventListener("snapshot", (e) => {
    markSeen();
    applySnapshot(JSON.parse((e as MessageEvent).data));
    // L1 t2: first snapshot of this connection → server-processing delta.
    if (!treeSnapDone) {
      treeSnapDone = true;
      if (treeT1) recordLatency("tree", "snap", performance.now() - treeT1);
    }
    setState("status", "live");
    void refreshOpenSessions();
  });
  es.addEventListener("ping", () => markSeen()); // heartbeat for the watchdog
  for (const kind of ["session.upsert", "session.delete"]) {
    es.addEventListener(kind, (e) => {
      markSeen();
      const ev = e as MessageEvent;
      applySessionEvent(kind, Number(ev.lastEventId), JSON.parse(ev.data));
    });
  }
  for (const kind of ["status", "activity", "activity.verb", "permission.upsert", "permission.delete", "question.upsert", "question.delete", "unread.set", "unread.clear", "todo"]) {
    es.addEventListener(kind, (e) => {
      markSeen();
      const ev = e as MessageEvent;
      applyMessageEvent(kind, Number(ev.lastEventId), JSON.parse(ev.data));
    });
  }
  // Daemon-detected alerts (transient; no cursor advance). In-app + OS delivery.
  es.addEventListener("notice", (e) => {
    markSeen();
    try {
      handleNotice(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore malformed notice */
    }
  });
  es.onopen = () => {
    markSeen();
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
    if (es && es.readyState === EventSource.CLOSED) {
      log.warn("sync", "tree stream closed → reconnecting", { backoff });
      clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    }
  };
}

// === Stream 2: active-session messages ======================================
// message/part events for ONLY the open session. Always snapshots fresh (no
// cursor) so switching sessions can't miss/skip deltas; reopened on switch,
// closed when nothing is open. Self-retries on error.
let ses: EventSource | null = null;
let sesId = "";
let sesRetry: number | undefined;

export function closeSessionStream() {
  clearTimeout(sesRetry);
  ses?.close();
  ses = null;
  sesId = "";
}

// applySessionSnapshot applies a Stream-2 (active-session) snapshot to the store.
// Extracted from the EventSource `snapshot` closure so the Slice C partial-
// snapshot contract — a hydrating snapshot (gate.messagesLoaded===false) must NOT
// mark the session delivered — is unit-testable. The connection-side bookkeeping
// (markSeen, latency) stays in the listener; this is the pure reconciliation.
export function applySessionSnapshot(id: string, snap: Snapshot) {
  setState("messages", id, buildMessages((snap.messages?.[id] as any[]) || []));
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
    setState("messagesLoaded", id, false);
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
    setState("messagesLoaded", id, true); // true OR undefined (older daemon) → delivered
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

// decodeMessagesBatch reverses the server's application-level compression of
// the cold-load messages.batch payload. The server emits {sessionID, encoding,
// data} where data = base64( gzip( {"messages":[...]} ) ). sessionID stays
// PLAIN TEXT so the store/web interest filters (payloadSessionID / sendable)
// keep extracting it — replacing the whole payload with a base64 blob would
// silently drop the batch for Stream-2 (open-session) subscribers; only the
// heavy messages array is compressed. This helper returns {sessionID,
// messages} in the exact shape applyMessageEvent's "messages.batch" case
// already consumes, so that case is UNCHANGED by compression. Uses native
// DecompressionStream + atob (no pako dep; Chrome 80+/FF 113+/Safari 16.4+ —
// fine for this PWA's modern-browser target). Exported for unit testing.
export async function decodeMessagesBatch(payload: {
  sessionID?: string;
  encoding?: string;
  data?: string;
  messages?: any[];
}): Promise<{ sessionID: string; messages: any[] }> {
  const sessionID = payload.sessionID || "";
  // Pass-through for a non-compressed payload (a non-conforming server, or a
  // future threshold policy that emits raw JSON below a size cutoff). Keeps the
  // helper a total function.
  if (payload.encoding !== "gzip64" || !payload.data) {
    return { sessionID, messages: payload.messages || [] };
  }
  // Feature-detect: an older browser without DecompressionStream cannot decode.
  // Fall back to whatever inline messages arrived (likely empty) and log — the
  // server always compresses today, so this only matters for an old client.
  if (typeof DecompressionStream === "undefined") {
    log.warn("sync", "DecompressionStream unavailable; messages.batch undecodable", { id: sessionID });
    return { sessionID, messages: payload.messages || [] };
  }
  // atob → binary string → Uint8Array.
  const bin = atob(payload.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Pipe through native gzip decompression, drain to one buffer.
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  const inner = JSON.parse(new TextDecoder().decode(merged));
  return { sessionID, messages: inner.messages || [] };
}

export function openSessionStream(id: string) {
  if (id === sesId && ses && ses.readyState !== EventSource.CLOSED) return;
  closeSessionStream();
  if (!id) return;
  sesId = id;
  const open = () => {
    if (sesId !== id) return;
    ses?.close();
    sesT0 = performance.now(); // L1 t0: session-stream connection attempt
    sesT1 = 0;
    sesSnapDone = false;
    sesFirstSnap = 0; // L1 hydrate: reset per (re)open
    sesHydrating = false;
    ses = new EventSource(`/vh/stream?sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}`);
    log.debug("sync", "session stream connect", { id });
    ses.addEventListener("snapshot", (e) => {
      markSeen();
      const snap: Snapshot = JSON.parse((e as MessageEvent).data);
      // L1 t2: first snapshot of this connection → server-processing delta
      // (snapshot compute + serialize). Since Slice C the upstream full-fetch
      // is async/best-effort, so this window no longer covers ensureMessages.
      if (!sesSnapDone) {
        sesSnapDone = true;
        const now = performance.now();
        if (sesT1) recordLatency("session", "snap", now - sesT1);
        // L1 hydrate t0: first-snapshot arrival. The same `now` bounds both
        // the snap delta and the hydrate delta (messages.loaded − first
        // snapshot). Warm-vs-cold is read from the snapshot's gate: a warm
        // session (gate.messagesLoaded!==false) already has the full history,
        // so messages.loaded never arrives → stamp "warm"; a cold session
        // (gate.messagesLoaded===false) clears any stale value so the UI
        // shows the in-progress upstream-fetch wait until messages.loaded.
        sesFirstSnap = now;
        const cold = snap.gate?.[id]?.messagesLoaded === false;
        sesHydrating = cold;
        recordSessionHydrate(cold ? undefined : "warm");
        // Clear any stale fetch/rec split from a prior connection. They only
        // land when THIS connection's messages.loaded arrives (cold session);
        // a warm snapshot never fires it, so they must read "—" until then.
        recordSessionFetchSplit(undefined, undefined);
      }
      applySessionSnapshot(id, snap);
    });
    ses.addEventListener("ping", () => markSeen());
    // L1 t1: socket established → pure connection-latency delta. Stream 2 had
    // no explicit onopen before; added for the latency diagnostic (and parity
    // with Stream 1's connect/backoff semantics).
    ses.onopen = () => {
      markSeen();
      sesT1 = performance.now();
      if (sesT0) recordLatency("session", "open", sesT1 - sesT0);
    };
    for (const kind of ["message.upsert", "message.delete", "part.upsert", "part.delete", "messages.loaded", "messages.error", "messages.batch"]) {
      ses!.addEventListener(kind, async (e) => {
        markSeen();
        const ev = e as MessageEvent;
        // Parse the payload once (was inline at applyMessageEvent); reused for
        // the split-timing read below. trackCursor:false — Stream 2 must not
        // advance Stream 1's resume cursor.
        const data = JSON.parse(ev.data);
        const sid: string | undefined = data?.sessionID;

        // messages.batch is application-compressed (gzip+base64) to cut cold-
        // load hydrate latency over the controller tunnel. The decode is ASYNC
        // (native DecompressionStream), but EventSource fires the next event
        // (messages.loaded) as soon as this listener RETURNS — i.e. before the
        // decode resolves. Without coordination messages.loaded would flip
        // messagesLoaded (the reveal gate, P1-WEB-020) before the batch content
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
            applyMessageEvent("messages.batch", Number(ev.lastEventId), decoded, false);
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
      if (ses && ses.readyState === EventSource.CLOSED && sesId === id) {
        clearTimeout(sesRetry);
        sesRetry = window.setTimeout(open, 1500);
      }
    };
  };
  open();
}

// Force a reconnect when the tree stream has gone silent past the heartbeat
// window (a dead-but-open socket EventSource won't surface as an error) or was
// closed. Runs while the tab is visible.
export function watchdogTick() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  // Feature 1: re-evaluate staleness over wall-clock time (no store write on
  // a silent-but-open socket). Coarse tick only — safe on the per-frame budget.
  setHealthNow((n) => n + 1);
  if (!es || es.readyState === EventSource.CLOSED) {
    connect();
  } else if (lastSeen && Date.now() - lastSeen > STALE_MS) {
    log.warn("sync", "stream stale → forcing reconnect", { silentMs: Date.now() - lastSeen });
    setState("status", "reconnecting");
    connect();
  }
  // The session stream self-retries on error; reopen if it died silently.
  if (sesId && (!ses || ses.readyState === EventSource.CLOSED)) openSessionStream(sesId);
}

export function maybeReconnect() {
  if (!es || es.readyState === EventSource.CLOSED) connect();
  else watchdogTick();
}
