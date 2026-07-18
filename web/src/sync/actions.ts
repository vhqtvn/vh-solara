// Commands that mutate sessions or the workspace: selection, project switch,
// draft/create lifecycle, and the server round-trips (permission/question reply,
// abort). These call into the stream (connect) and url (syncUrl) but nothing
// calls back into them, so they sit at the top of the sync dependency graph
// (below only the barrel that wires startup).
import { produce } from "solid-js/store";
import { setView } from "../ui";
import { saveVersioned } from "../lib/store";
import { log } from "../lib/log";
import {
  state,
  setState,
  projectDir,
  setProjectDirRaw,
  setSelectedIdRaw,
  setDraft,
  loadSessions,
  loadActivity,
  loadLastAgents,
  loadCursor,
  LS_PROJECT,
} from "./store";
import { syncUrl } from "./url";
import { closeSessionStream, connect } from "./stream";
import { invalidateChildrenIndex } from "./selectors";

// Selecting any real session leaves draft mode.
export function setSelectedId(id: string | null) {
  if (id) setDraft(false);
  setSelectedIdRaw(id);
  syncUrl(id);
}

// Switch the active project directory: reset to that project's persisted tree
// and reconnect the stream scoped to it. `fromUrl` is set by popstate (don't
// re-push history). The dir is mirrored to both localStorage (fallback) and the
// URL (source of truth, per-tab). `dir === ""` lands the app on the no-project
// empty state: the daemon's cwd is not a meaningful project, so we close the
// streams and clear per-project state instead of bridging cwd.
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
      // Phase 3: clear the per-session bounded-window map alongside the other
      // per-session maps (messagesLoaded/messagesError). A previous project's
      // window state (hasOlder / oldestResidentID) must not leak across the
      // switch — the new project's snapshot repopulates it from scratch.
      s.messageWindows = {};
      s.messagesLoaded = {};
      s.messagesError = {};
      s.activity = loadActivity(dir);
      // B2b audit: lastAgents is a per-session facet that must NOT carry over
      // from the previous project (orphan-map gap). Like activity, it is
      // per-project persisted, so hydrate the new project's chips instantly and
      // let the live snapshot reconcile. Without this, a switched-away project's
      // agent labels lingered until the first snapshot landed.
      s.lastAgents = loadLastAgents(dir);
      s.permissions = {};
      s.questions = {};
      s.todos = {};
      s.unread = {};
      s.cursor = loadCursor(dir);
      s.status = "connecting";
    }),
  );
  // Wholesale session-set replacement invalidates the parent→children index.
  invalidateChildrenIndex();
  if (!dir) {
    // No-project state: tear down both streams so nothing keeps bridging the old
    // project (or cwd). connect() would no-op too, but closing the session
    // stream explicitly is required (connect only owns the tree stream). Leave
    // status as "connecting"; the no-project view hides the session tree, so the
    // status dot is not in a misleading state for the user's current focus.
    closeSessionStream();
    connect(true); // early-returns on empty dir but closes the tree stream
    return;
  }
  connect(true); // project switch: snapshot to fully reconcile the new project's state
}

// Reserve a session's message slot so the chat renders immediately; the actual
// history + live updates come from the active-session message stream (Stream 2),
// which is the sole owner of message state to avoid a one-shot fetch clobbering
// in-flight streamed deltas.
export async function openSession(id: string) {
  // Mark not-delivered only when actually reserving a fresh slot. A reopening
  // session keeps its cached messages (and its delivered=true) so it renders
  // instantly instead of flashing a loading state. See SyncState.messagesLoaded.
  if (!state.messages[id]) {
    setState("messages", id, { order: [], byId: {} });
    setState("messagesLoaded", id, false);
  }
}

// "New session" no longer hits the server — it enters draft mode so an unused,
// empty session is never created. The real session is created on first send.
export function newSession() {
  setSelectedIdRaw(null);
  setDraft(true);
  syncUrl(null);
  setView("chat"); // composing always happens in the chat view
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
export async function respondQuestion(questionID: string, answers: string[][]) {
  log.debug("question", "reply", { questionID, answers });
  const res = await fetch(`/oc/question/${encodeURIComponent(questionID)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) log.error("question", "reply failed", { status: res.status });
}

// Abort a session's turn and clear its working indicator. Exposed for the
// session menu as a recovery path: a turn killed mid-generation (e.g. a network
// drop) can leave OpenCode reporting the session "busy" forever (a zombie turn)
// while the composer's Stop button may be unavailable — this always works.
// Routes through /vh/abort so the server marks the session idle authoritatively
// too (OpenCode emits no session.idle on abort), keeping reconnects consistent.
export async function abortSession(sessionID: string) {
  if (!sessionID) return;
  markSessionIdle(sessionID);
  try {
    await fetch("/vh/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID }),
    });
  } catch (e) {
    log.warn("abort", "request failed", e);
  }
}

// Optimistically mark a session idle (used right after aborting a turn) so the
// working indicator clears immediately instead of waiting on server events —
// OpenCode doesn't always emit an idle event on abort. Later events reconcile.
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

// Clear the latched epoch-transition flag. Set by applySnapshot (stream.ts) when
// an epoch transition is detected on a LIVE connection, and consumed here by the
// connection-health toast (ConnectionToast.tsx) once it has surfaced
// "Server restarted — re-syncing…". Exposed as a NARROW action so the public
// sync barrel no longer re-exports the raw store setter (setState) just for this
// one consumer — the only prior external user of that re-export was the toast.
export function consumeEpochChanged(): void {
  setState("epochChanged", false);
}
