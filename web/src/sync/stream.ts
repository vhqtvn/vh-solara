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
      // S4 per-session hydration gate (snap.gate[id].hydrated). Rebuilt each
      // snapshot; rows with hydrated===false are still being aggregated after a
      // restart and can show a loading hint instead of looking stale.
      s.hydrated = {};
      for (const [id, g] of Object.entries(snap.gate || {})) s.hydrated[id] = !!g?.hydrated;
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
        // don't leak and can't resurrect on id-reuse. lastAgents/hydrated are
        // snapshot-seeded facets that must not outlive the session; messagesLoaded
        // is the open-session delivery flag, cleared here to stay consistent with
        // the session's removal. (s.messages is owned by the Stream-2 / openSession
        // lifecycle and reconciled separately, so it is NOT pruned here — see
        // SyncState.messagesLoaded.)
        delete s.lastAgents[payload.id];
        delete s.hydrated[payload.id];
        delete s.messagesLoaded[payload.id];
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
function applyMessageEvent(kind: string, seq: number, payload: any, trackCursor = true) {
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
// avoid clobbering streamed deltas).
async function refreshOpenSessions() {
  const active = selectedId();
  for (const id of Object.keys(state.messages)) {
    if (id === active) continue;
    try {
      const items = await fetchSessionMessages(id);
      setState("messages", id, buildMessages(items));
      setState("messagesLoaded", id, true);
    } catch {
      /* keep stale; reopening re-snapshots */
    }
  }
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
// capture three performance.now() stamps and derive two deltas:
//   open = onopen − EventSource construction  (pure connection latency)
//   snap = first snapshot − onopen            (server: ensureMessages + compute
//                                              + serialize)
// The first snapshot per connection bounds `snap`; later snapshots are normal
// deltas and aren't timed. Surfaces in ServersPanel as "conn: Xms · server: Yms"
// per stream so an operator can tell a slow connection from a slow server.
function recordLatency(stream: "tree" | "session", phase: "open" | "snap", ms: number): void {
  setState("connLatency", stream, phase, Math.max(0, Math.round(ms)));
}
// Per-connection stamps/flags. Reset on each (re)open; snap recorded once.
let treeT0 = 0;
let treeT1 = 0;
let treeSnapDone = false;
let sesT0 = 0;
let sesT1 = 0;
let sesSnapDone = false;

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
    ses = new EventSource(`/vh/stream?sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}`);
    log.debug("sync", "session stream connect", { id });
    ses.addEventListener("snapshot", (e) => {
      markSeen();
      const snap: Snapshot = JSON.parse((e as MessageEvent).data);
      // L1 t2: first snapshot of this connection → server-processing delta
      // (ensureMessages for this session + snapshot compute + serialize).
      if (!sesSnapDone) {
        sesSnapDone = true;
        if (sesT1) recordLatency("session", "snap", performance.now() - sesT1);
      }
      setState("messages", id, buildMessages((snap.messages?.[id] as any[]) || []));
      // The real snapshot has landed → mark this session delivered so the
      // transcript distinguishes "loading" from "delivered-and-empty".
      setState("messagesLoaded", id, true);
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
    for (const kind of ["message.upsert", "message.delete", "part.upsert", "part.delete"]) {
      ses!.addEventListener(kind, (e) => {
        markSeen();
        const ev = e as MessageEvent;
        // trackCursor:false — Stream 2 must not advance Stream 1's resume cursor.
        applyMessageEvent(kind, Number(ev.lastEventId), JSON.parse(ev.data), false);
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
