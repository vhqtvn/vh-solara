// Client sync: consumes the daemon's resumable /vh/stream, keeps a Solid store
// of sessions, persists to localStorage for instant hydrate-on-open, and
// proactively reconnects when the tab returns to the foreground (iOS suspends
// background sockets). State is reconciled by id, never nuked.
import { createStore, produce } from "solid-js/store";
import { createSignal, createRoot, createEffect, on } from "solid-js";
import type { ConnStatus, Permission, Question, Session, SessionMessages, Snapshot } from "./types";
import {
  anyDescendantWorking,
  buildMessages,
  deleteMessage,
  deletePart,
  sortMessages,
  upsertMessage,
  upsertPart,
} from "./lib/reduce";
import { pushNotification } from "./notify";
import { log } from "./lib/log";
import { loadVersioned, saveVersioned } from "./lib/store";

const LS_SESSIONS = "vh.sessions.v1";
const LS_CURSOR = "vh.cursor.v1";
const LS_ACTIVITY = "vh.activity.v1";
const LS_PROJECT = "vh.project.dir";

// Persistence is keyed per project directory so each project hydrates its own
// tree instantly on switch. "" is the default project (OpenCode serve cwd).
const lsSessions = (dir: string) => `${LS_SESSIONS}:${dir}`;
const lsCursor = (dir: string) => `${LS_CURSOR}:${dir}`;
const lsActivity = (dir: string) => `${LS_ACTIVITY}:${dir}`;

function loadSessions(dir: string): Record<string, Session> {
  return loadVersioned<Record<string, Session>>(lsSessions(dir), 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, Session>) : {},
  );
}
const loadCursor = (dir: string) =>
  loadVersioned<number>(lsCursor(dir), 1, 0, (o) => Number(o) || 0);
// Activity is persisted alongside sessions so a reload hydrates running state
// INSTANTLY. Without this, activity started empty on reload and — since the
// stream resumes from the saved cursor — an activity=busy that fired before that
// cursor was never replayed, so a busy session showed idle until the next event
// (the reported "~1min to recognize busy after reload"). The live stream then
// reconciles any change.
function loadActivity(dir: string): Record<string, string> {
  return loadVersioned<Record<string, string>>(lsActivity(dir), 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, string>) : {},
  );
}

// The workspace is the URL's source of truth (so each tab keeps its own across
// reload and is shareable); localStorage is only the fallback when the URL omits
// it. `?dir=` absent → default project (""); `?dir=` present (even empty) wins.
function urlDir(): string | null {
  try {
    const u = new URLSearchParams(location.search);
    return u.has("dir") ? u.get("dir") || "" : null;
  } catch {
    return null;
  }
}
const initialDir =
  urlDir() ?? loadVersioned<string>(LS_PROJECT, 1, "", (o) => (typeof o === "string" ? o : ""));

interface SyncState {
  sessions: Record<string, Session>;
  // Messages are held only for opened sessions, to bound memory.
  messages: Record<string, SessionMessages>;
  // Per-session activity (busy/idle/error) and pending permissions are kept for
  // ALL sessions so the sidebar/chat can surface status without opening them.
  activity: Record<string, string>;
  permissions: Record<string, Record<string, Permission>>;
  questions: Record<string, Record<string, Question>>;
  // Root sessions that finished and haven't been acknowledged (server-tracked,
  // cross-device) — drives the "finished/unread" indicator in the tree.
  unread: Record<string, boolean>;
  status: ConnStatus;
  cursor: number;
}

const [state, setState] = createStore<SyncState>({
  sessions: loadSessions(initialDir),
  messages: {},
  activity: loadActivity(initialDir),
  permissions: {},
  questions: {},
  unread: {},
  status: "connecting",
  cursor: loadCursor(initialDir),
});

// In-flight sends, keyed by sessionID. OpenCode's POST /session/:id/message
// blocks until the turn *settles* — which can be minutes, or forever if the
// turn pauses on a permission or was interrupted mid-generation (a dangling
// assistant turn after a restart). This MUST be per-session: the chat component
// is reused across sessions, so a single shared "sending" flag meant one hung
// send silently gated the composer of EVERY other session ("only the first
// session after a restart works"). Keyed here, a stuck send only blocks its own
// session.
const [sendingState, setSendingState] = createStore<Record<string, boolean>>({});
export function isSending(id: string): boolean {
  return !!sendingState[id];
}
export function setSending(id: string, v: boolean): void {
  setSendingState(id, v);
}

// Current project directory ("" = default). Multi-project: snapshot/stream and
// /oc requests are scoped to this directory.
const [projectDir, setProjectDirRaw] = createSignal(initialDir);

const [selectedId, setSelectedIdRaw] = createSignal<string | null>(null);
// Draft (composing) mode: "New session" enters this WITHOUT creating a server
// session — the session is only created when the first message is sent.
const [draft, setDraft] = createSignal(false);

// Selecting any real session leaves draft mode.
function setSelectedId(id: string | null) {
  if (id) setDraft(false);
  setSelectedIdRaw(id);
  syncUrl(id);
}

// --- URL deep-linking ---------------------------------------------------------
// The selected session lives in the URL (?session=<id>) so it survives reloads
// and is shareable. We push history entries on selection (back/forward walk
// session history) and apply the URL on load and on popstate.
function currentUrlSession(): string | null {
  try {
    return new URLSearchParams(location.search).get("session");
  } catch {
    return null;
  }
}

let applyingUrl = false; // guard so popstate-driven selection doesn't re-push
// Write the current workspace + selected session to the URL. `replace` updates
// in place (used to normalize the URL on load); otherwise a history entry is
// pushed so back/forward walks selection + project history.
function syncUrl(id: string | null, replace = false) {
  if (applyingUrl || typeof location === "undefined") return;
  try {
    const url = new URL(location.href);
    if (id) url.searchParams.set("session", id);
    else url.searchParams.delete("session");
    const dir = projectDir();
    if (dir) url.searchParams.set("dir", dir);
    else url.searchParams.delete("dir");
    if (url.search === location.search) return;
    if (replace) history.replaceState({ session: id, dir }, "", url);
    else history.pushState({ session: id, dir }, "", url);
  } catch {
    /* history unavailable — selection still works in-memory */
  }
}

let persistTimer: number | undefined;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const dir = projectDir();
    saveVersioned(lsSessions(dir), 1, state.sessions);
    saveVersioned(lsCursor(dir), 1, state.cursor);
    saveVersioned(lsActivity(dir), 1, state.activity);
  }, 250);
}

// Switch the active project directory: reset to that project's persisted tree
// and reconnect the stream scoped to it. "" = default project. `fromUrl` is set
// by popstate (don't re-push history). The dir is mirrored to both localStorage
// (fallback) and the URL (source of truth, per-tab).
export function switchProject(dir: string, fromUrl = false) {
  if (dir === projectDir()) return;
  saveVersioned(LS_PROJECT, 1, dir);
  setProjectDirRaw(dir);
  setSelectedIdRaw(null);
  setDraft(false);
  if (!fromUrl) syncUrl(null);
  setState(
    produce((s) => {
      s.sessions = loadSessions(dir);
      s.messages = {};
      s.activity = loadActivity(dir);
      s.permissions = {};
      s.questions = {};
      s.unread = {};
      s.cursor = loadCursor(dir);
      s.status = "connecting";
    }),
  );
  connect(true); // project switch: snapshot to fully reconcile the new project's state
}

function applySnapshot(snap: Snapshot) {
  setState(
    produce((s) => {
      // Reconcile: replace the session set with the authoritative snapshot.
      s.sessions = {};
      for (const sess of snap.sessions || []) s.sessions[sess.id] = sess;
      s.activity = { ...(snap.activity || {}) };
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

function sessionTitle(id: string): string {
  return state.sessions[id]?.title || "Session";
}

// Surface an assistant error as a dismissable notification.
function notifyFromMessage(payload: any) {
  const info = payload?.info;
  const err = info?.error;
  if (info?.role === "assistant" && err) {
    pushNotification({
      kind: "error",
      sessionID: info.sessionID,
      title: sessionTitle(info.sessionID) + " error",
      detail: err.data?.message || err.name || "Assistant error",
    });
  }
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
              title: sessionTitle(payload.sessionID) + " error",
              detail: e?.data?.message || e?.message || e?.name || "Session error",
            });
          }
          break; // activity drives the indicator; this only adds the notification
      }
      if (trackCursor && seq) s.cursor = seq;
    }),
  );
  if (kind === "activity" && payload.sessionID) maybeNotifyRootDone(payload.sessionID);
  persist();
}

// Acknowledge a session as read (called when its bottom is reached): clears the
// finished-unread flag on its root, server-side (cross-device) + optimistically.
export function ackSession(id: string) {
  if (!id) return;
  const root = rootOf(id);
  if (!state.unread[root]) return; // nothing to ack
  setState("unread", root, undefined as unknown as boolean);
  void fetch("/vh/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: id }),
  }).catch(() => {});
}

// The root of a session (top of the parentID chain that's still in the store).
function rootOf(id: string): string {
  let cur = id;
  for (let guard = 0; guard < 10000; guard++) {
    const p = state.sessions[cur]?.parentID;
    if (!p || !state.sessions[p]) return cur;
    cur = p;
  }
  return cur;
}

// Per-root "was its subtree working" memory, used to ping exactly once when a
// root task fully completes (root + all its subagents idle). Subsession-level
// completions never ping — only the root does.
const rootWorking = new Map<string, boolean>();
// Pending "finished" timers, keyed by root. A turn can dip idle for a moment
// between steps (one step finishes, the next hasn't escalated to busy yet), so
// we don't ping the instant the subtree reads idle — we wait for the idle to
// SETTLE. If the root goes busy again before the timer fires, the run wasn't
// actually done and we cancel, so a multi-step turn pings exactly once at the end.
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DONE_SETTLE_MS = 4000;
function maybeNotifyRootDone(changedSessionID: string) {
  const root = rootOf(changedSessionID);
  const nowWorking = sessionWorking(root); // folds in descendant activity
  const was = rootWorking.get(root) ?? false;
  rootWorking.set(root, nowWorking);
  if (nowWorking) {
    // Back to work (or still working): cancel any pending "finished" ping.
    const t = doneTimers.get(root);
    if (t !== undefined) {
      clearTimeout(t);
      doneTimers.delete(root);
    }
    return;
  }
  // Just settled into idle: schedule the ping, but only if it stays idle long
  // enough that this is a real turn-end and not a between-steps dip.
  if (was && !doneTimers.has(root)) {
    const t = setTimeout(() => {
      doneTimers.delete(root);
      if (!sessionWorking(root) && root !== selectedId()) {
        pushNotification({ kind: "done", sessionID: root, title: sessionTitle(root) + " finished" });
      }
    }, DONE_SETTLE_MS);
    doneTimers.set(root, t);
  }
}

async function fetchSessionMessages(id: string): Promise<any[]> {
  const res = await fetch(
    `/vh/snapshot?sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}`,
  );
  const snap: Snapshot = await res.json();
  return (snap.messages?.[id] as any[]) || [];
}

// Reserve a session's message slot so the chat renders immediately; the actual
// history + live updates come from the active-session message stream (Stream 2),
// which is the sole owner of message state to avoid a one-shot fetch clobbering
// in-flight streamed deltas.
export async function openSession(id: string) {
  if (!state.messages[id]) setState("messages", id, { order: [], byId: {} });
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
function connect(fresh = false) {
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
  for (const kind of ["status", "activity", "permission.upsert", "permission.delete", "question.upsert", "question.delete", "unread.set", "unread.clear"]) {
    es.addEventListener(kind, (e) => {
      markSeen();
      const ev = e as MessageEvent;
      applyMessageEvent(kind, Number(ev.lastEventId), JSON.parse(ev.data));
    });
  }
  es.onopen = () => {
    markSeen();
    backoff = 1000; // healthy — reset backoff
    setState("status", "live");
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

function closeSessionStream() {
  clearTimeout(sesRetry);
  ses?.close();
  ses = null;
  sesId = "";
}

function openSessionStream(id: string) {
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
function watchdogTick() {
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

function maybeReconnect() {
  if (!es || es.readyState === EventSource.CLOSED) connect();
  else watchdogTick();
}

export function startSync() {
  connect(true); // page load: snapshot to fully reconcile (state hydrated from localStorage is partial)
  // The active-session message stream follows the selection.
  createRoot(() =>
    createEffect(on(selectedId, (id) => openSessionStream(id ?? ""), { defer: true })),
  );
  // Periodic health check: reconnects a closed/stale stream without a reload.
  window.setInterval(watchdogTick, 10_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") maybeReconnect();
  });
  window.addEventListener("online", maybeReconnect);
  window.addEventListener("offline", () => setState("status", "reconnecting"));

  // Normalize the URL so the tab is self-describing (carries its resolved dir
  // even if it loaded from the localStorage fallback) — replace, don't push.
  syncUrl(currentUrlSession(), true);

  // Open the session named in the URL on load (deep link / refresh).
  const initial = currentUrlSession();
  if (initial) {
    setSelectedIdRaw(initial);
    openSessionStream(initial);
    void openSession(initial);
  }
  // Back/forward navigates between previously-selected sessions AND projects.
  window.addEventListener("popstate", () => {
    const id = currentUrlSession();
    const dir = urlDir() ?? "";
    applyingUrl = true;
    try {
      if (dir !== projectDir()) switchProject(dir, true);
      setSelectedIdRaw(id);
      openSessionStream(id ?? "");
      if (id) {
        setDraft(false);
        void openSession(id);
      }
    } finally {
      applyingUrl = false;
    }
  });
}

// "New session" no longer hits the server — it enters draft mode so an unused,
// empty session is never created. The real session is created on first send.
export function newSession() {
  setSelectedIdRaw(null);
  setDraft(true);
  syncUrl(null);
}

// Create a session on the server (called when the draft's first message is
// sent). Returns the new id, or null on failure.
export async function createSession(): Promise<string | null> {
  try {
    const res = await fetch("/oc/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const sess = await res.json();
    if (sess?.id) {
      setSelectedId(sess.id);
      void openSession(sess.id);
      return sess.id;
    }
  } catch {
    /* caller surfaces the failure */
  }
  return null;
}

// Reply to a pending permission request: "once" | "always" | "reject".
// Uses OpenCode's canonical permission-reply route (POST /permission/:id/reply
// with {reply}); falls back to the legacy session-scoped route ({response}) for
// older servers. Clears the card optimistically so the UI responds immediately.
export async function respondPermission(sessionID: string, permissionID: string, response: string) {
  setState(
    produce((s) => {
      if (s.permissions[sessionID]) delete s.permissions[sessionID][permissionID];
    }),
  );
  log.debug("permission", "reply", { sessionID, permissionID, response });
  try {
    const res = await fetch(`/oc/permission/${encodeURIComponent(permissionID)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: response }),
    });
    if (res.ok) return;
    log.warn("permission", "canonical reply not ok → legacy route", { status: res.status });
  } catch (e) {
    log.warn("permission", "canonical reply threw → legacy route", e);
    /* fall through to the legacy route */
  }
  const legacy = await fetch(
    `/oc/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
    },
  );
  if (!legacy.ok) log.error("permission", "reply failed on both routes", { status: legacy.status });
}

// Reply to a pending question. `answers` is one array of chosen labels (or
// custom strings) per question in the request.
// Generate an LLM title suggestion for a session on demand (used by "Regenerate
// name"). Reuses OpenCode's purpose-built namer — POST /experimental/project/
// :projectID/copy/generate-name {context} — which runs the small model and
// returns a short slug, with NO session pollution (unlike sending a real
// prompt). We de-slugify it into a readable title; the caller confirms/edits it
// before applying. Returns null on failure (caller surfaces it). Unlike
// OpenCode's built-in auto-title, this works on any session — multi-turn or not.
function deslugify(s: string): string {
  const t = s.replace(/[-_]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

export async function suggestTitle(sessionID: string): Promise<string | null> {
  const sess = state.sessions[sessionID];
  const projectID = sess?.projectID;
  if (!projectID) {
    log.warn("title", "no projectID for session; cannot generate name", { sessionID });
    return null;
  }
  // Build context from the conversation (the first user message is the task,
  // but include more so multi-turn sessions name from the whole thread).
  let context = "";
  try {
    const r = await fetch(`/oc/session/${encodeURIComponent(sessionID)}/message`);
    if (r.ok) {
      const msgs = (await r.json()) as Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>;
      const lines: string[] = [];
      for (const m of msgs) {
        for (const p of m.parts || []) {
          if (p.type === "text" && p.text) lines.push(`${m.info?.role || "?"}: ${p.text}`);
        }
      }
      context = lines.join("\n").slice(0, 2000);
    }
  } catch (e) {
    log.warn("title", "context fetch failed", e);
  }
  log.debug("title", "generate-name", { sessionID, projectID, contextLen: context.length });
  const res = await fetch(
    `/oc/experimental/project/${encodeURIComponent(projectID)}/copy/generate-name`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context }),
    },
  );
  if (!res.ok) {
    log.error("title", "generate-name failed", { status: res.status });
    return null;
  }
  const data = (await res.json().catch(() => null)) as { name?: string } | null;
  const name = data?.name?.trim();
  return name ? deslugify(name) : null;
}

export async function respondQuestion(questionID: string, answers: string[][]) {
  log.debug("question", "reply", { questionID, answers });
  const res = await fetch(`/oc/question/${encodeURIComponent(questionID)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) log.error("question", "reply failed", { status: res.status });
}

// Whether a session is actively working. Purely the authoritative activity
// signal (matches opencode web: status.type !== "idle"), recovered on hydrate
// from /session/status. No message-based heuristic — a turn terminated
// mid-generation leaves an incomplete last message but is NOT busy, and must not
// spin forever.
export function sessionWorking(sessionID: string): boolean {
  if (isActivityWorking(state.activity[sessionID])) return true;
  // A running subagent (child) session keeps its parent chain "working" too.
  // OpenCode's /session/status marks only the child (delegate) session busy, so
  // the root/parent would otherwise render idle while its subagent is still
  // generating. Propagate busy/retry up by checking descendants.
  return descendantWorking(sessionID);
}

function isActivityWorking(act?: string): boolean {
  return act === "busy" || act === "retry";
}

// runningSessionCount counts root sessions whose subtree is currently working —
// the sessions a restart would interrupt. Subagents fold into their root via
// sessionWorking(), so each running task counts once.
export function runningSessionCount(): number {
  let n = 0;
  for (const id of Object.keys(state.sessions)) {
    const s = state.sessions[id];
    if (s?.parentID && state.sessions[s.parentID]) continue; // count roots only
    if (sessionWorking(id)) n++;
  }
  return n;
}

function descendantWorking(sessionID: string): boolean {
  return anyDescendantWorking(state.sessions, state.activity, sessionID, isActivityWorking);
}

// Optimistically mark a session idle (used right after aborting a turn) so the
// working indicator clears immediately instead of waiting on server events —
// OpenCode doesn't always emit an idle event on abort. Later events reconcile.
// Abort a session's turn and clear its working indicator. Exposed for the
// session menu as a recovery path: a turn killed mid-generation (e.g. a network
// drop) can leave OpenCode reporting the session "busy" forever (a zombie turn)
// while the composer's Stop button may be unavailable — this always works.
export async function abortSession(sessionID: string) {
  if (!sessionID) return;
  markSessionIdle(sessionID);
  try {
    await fetch(`/oc/session/${encodeURIComponent(sessionID)}/abort`, { method: "POST" });
  } catch (e) {
    log.warn("abort", "request failed", e);
  }
}

export function markSessionIdle(sessionID: string) {
  setState(
    produce((s) => {
      s.activity[sessionID] = "idle";
      const sm = s.messages[sessionID];
      if (sm && sm.order.length) {
        const last = sm.byId[sm.order[sm.order.length - 1]];
        if (last && last.info.role === "assistant" && !last.info.time?.completed) {
          last.info = { ...last.info, time: { ...(last.info.time || {}), completed: Date.now() } };
        }
      }
    }),
  );
}

export { state, selectedId, setSelectedId, draft, setDraft, projectDir };
