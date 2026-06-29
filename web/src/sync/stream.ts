// The stream state-machine: consumes the daemon's resumable /vh/stream over two
// EventSources, reconciles the store, and keeps itself alive (heartbeat
// watchdog, backoff reconnect, foreground/online recovery). It owns transport
// and store reconciliation; notification policy lives in ./orchestration.
import { produce } from "solid-js/store";
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

function applySnapshot(snap: Snapshot) {
  setState(
    produce((s) => {
      // Reconcile: replace the session set with the authoritative snapshot.
      s.sessions = {};
      for (const sess of snap.sessions || []) s.sessions[sess.id] = sess;
      s.activity = { ...(snap.activity || {}) };
      s.lastAgents = { ...(snap.lastAgents || {}) };
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
      s.cursor = snap.seq;
    }),
  );
  persist();
}

function applySessionEvent(kind: string, seq: number, payload: any) {
  setState(
    produce((s) => {
      if (kind === "session.upsert") s.sessions[payload.id] = payload;
      else if (kind === "session.delete") delete s.sessions[payload.id];
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
const STALE_MS = 45_000; // ~3 missed 15s pings → assume the stream is dead

function markSeen() {
  lastSeen = Date.now();
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
export function connect(fresh = false) {
  clearTimeout(reconnectTimer);
  es?.close();
  const cursorParam = fresh ? "" : `cursor=${state.cursor}&`;
  es = new EventSource(`/vh/stream?${cursorParam}sessions=&dir=${encodeURIComponent(projectDir())}`);
  markSeen();
  log.debug("sync", "tree stream connect", { cursor: fresh ? "fresh" : state.cursor, dir: projectDir() });
  es.addEventListener("snapshot", (e) => {
    markSeen();
    applySnapshot(JSON.parse((e as MessageEvent).data));
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
  for (const kind of ["status", "activity", "permission.upsert", "permission.delete", "question.upsert", "question.delete", "unread.set", "unread.clear", "todo"]) {
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
    ses = new EventSource(`/vh/stream?sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}`);
    log.debug("sync", "session stream connect", { id });
    ses.addEventListener("snapshot", (e) => {
      markSeen();
      const snap: Snapshot = JSON.parse((e as MessageEvent).data);
      setState("messages", id, buildMessages((snap.messages?.[id] as any[]) || []));
    });
    ses.addEventListener("ping", () => markSeen());
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
