// The sync store core: the Solid store of sessions plus the per-tab selection /
// project / draft signals, their localStorage persistence, and the hydrate
// helpers. This is the leaf every other sync module reads from — it imports
// nothing from its siblings, so the rest of the decomposition hangs off it
// without a cycle. State is reconciled by id, never nuked.
import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import type { ConnStatus, Permission, Question, Session, SessionMessages, TodoItem } from "../types";
import { loadVersioned, saveVersioned } from "../lib/store";

const LS_SESSIONS = "vh.sessions.v1";
const LS_CURSOR = "vh.cursor.v1";
const LS_ACTIVITY = "vh.activity.v1";
export const LS_PROJECT = "vh.project.dir";

// Persistence is keyed per project directory so each project hydrates its own
// tree instantly on switch. "" is the default project (OpenCode serve cwd).
export const lsSessions = (dir: string) => `${LS_SESSIONS}:${dir}`;
export const lsCursor = (dir: string) => `${LS_CURSOR}:${dir}`;
export const lsActivity = (dir: string) => `${LS_ACTIVITY}:${dir}`;

export function loadSessions(dir: string): Record<string, Session> {
  return loadVersioned<Record<string, Session>>(lsSessions(dir), 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, Session>) : {},
  );
}
export const loadCursor = (dir: string) =>
  loadVersioned<number>(lsCursor(dir), 1, 0, (o) => Number(o) || 0);
// Activity is persisted alongside sessions so a reload hydrates running state
// INSTANTLY. Without this, activity started empty on reload and — since the
// stream resumes from the saved cursor — an activity=busy that fired before that
// cursor was never replayed, so a busy session showed idle until the next event
// (the reported "~1min to recognize busy after reload"). The live stream then
// reconciles any change.
export function loadActivity(dir: string): Record<string, string> {
  return loadVersioned<Record<string, string>>(lsActivity(dir), 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, string>) : {},
  );
}

// The workspace is the URL's source of truth (so each tab keeps its own across
// reload and is shareable); localStorage is only the fallback when the URL omits
// it. `?dir=` absent → default project (""); `?dir=` present (even empty) wins.
export function urlDir(): string | null {
  try {
    const u = new URLSearchParams(location.search);
    return u.has("dir") ? u.get("dir") || "" : null;
  } catch {
    return null;
  }
}
const initialDir =
  urlDir() ?? loadVersioned<string>(LS_PROJECT, 1, "", (o) => (typeof o === "string" ? o : ""));

export interface SyncState {
  sessions: Record<string, Session>;
  // Messages are held only for opened sessions, to bound memory.
  messages: Record<string, SessionMessages>;
  // Per-session activity (busy/idle/error) and pending permissions are kept for
  // ALL sessions so the sidebar/chat can surface status without opening them.
  activity: Record<string, string>;
  permissions: Record<string, Record<string, Permission>>;
  questions: Record<string, Record<string, Question>>;
  // Per-session agent todo list (OpenCode TodoWrite), kept for all sessions so
  // the "Tasks N active · M left" indicator works without opening them.
  todos: Record<string, TodoItem[]>;
  // Root sessions that finished and haven't been acknowledged (server-tracked,
  // cross-device) — drives the "finished/unread" indicator in the tree.
  unread: Record<string, boolean>;
  status: ConnStatus;
  cursor: number;
}

export const [state, setState] = createStore<SyncState>({
  sessions: loadSessions(initialDir),
  messages: {},
  activity: loadActivity(initialDir),
  permissions: {},
  questions: {},
  todos: {},
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
export const [projectDir, setProjectDirRaw] = createSignal(initialDir);

export const [selectedId, setSelectedIdRaw] = createSignal<string | null>(null);
// Draft (composing) mode: "New session" enters this WITHOUT creating a server
// session — the session is only created when the first message is sent.
export const [draft, setDraft] = createSignal(false);

let persistTimer: number | undefined;
export function persist() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const dir = projectDir();
    saveVersioned(lsSessions(dir), 1, state.sessions);
    saveVersioned(lsCursor(dir), 1, state.cursor);
    saveVersioned(lsActivity(dir), 1, state.activity);
  }, 250);
}
