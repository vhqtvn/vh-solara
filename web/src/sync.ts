// Client sync: consumes the daemon's resumable /vh/stream, keeps a Solid store
// of sessions, persists to localStorage for instant hydrate-on-open, and
// proactively reconnects when the tab returns to the foreground (iOS suspends
// background sockets). State is reconciled by id, never nuked.
//
// This module is the public facade + startup wiring. The implementation lives in
// focused sibling modules under ./sync/:
//   store         — the Solid store, selection/project/draft signals, persistence
//   selectors     — pure derived reads (root/subtree walks, working rollup, todos)
//   url           — ?session/?dir deep-linking
//   orchestration — turning store changes into notifications/acks
//   stream        — the two-EventSource state-machine + reconnect watchdog
//   actions       — selection/project/draft/create + server round-trips
import { createRoot, createEffect, on } from "solid-js";
import { bindAlertsContext } from "./alerts";
import {
  state,
  setState,
  selectedId,
  setSelectedIdRaw,
  draft,
  setDraft,
  projectDir,
  isSending,
  setSending,
  urlDir,
} from "./sync/store";
import { rootOf } from "./sync/selectors";
import { currentUrlSession, syncUrl, setApplyingUrl } from "./sync/url";
import {
  connect,
  closeSessionStream,
  openSessionStream,
  watchdogTick,
  maybeReconnect,
  tickHealth,
} from "./sync/stream";
import { setSelectedId, switchProject, openSession } from "./sync/actions";

// Inject the session-store accessors alerts needs (instead of alerts importing
// from sync — that was a cycle). Bound at load, before any heartbeat/notice runs.
bindAlertsContext({
  selectedId,
  rootOf,
  sessionTitle: (id) => state.sessions[id]?.title,
});

export function startSync() {
  // Page load: snapshot to fully reconcile ONLY when a project is already
  // selected (deep link ?dir= or localStorage fallback). With no project the app
  // shows the no-project empty state and does NOT bridge the daemon's cwd;
  // selecting a project later calls connect(true) via switchProject.
  if (projectDir()) connect(true);
  else closeSessionStream(); // ensure no stray session stream from a prior tab state
  // The active-session message stream follows the selection.
  createRoot(() =>
    createEffect(on(selectedId, (id) => openSessionStream(id ?? ""), { defer: true })),
  );
  // Periodic health check: reconnects a closed/stale stream without a reload.
  window.setInterval(watchdogTick, 10_000);
  // Feature 1 (stale indicator): a faster, reconnect-free health tick so the
  // status dot can surface staleness (a silent-but-open socket) BEFORE the 10s
  // watchdog reconnects it. Cheap — only advances a signal the status dot reads.
  window.setInterval(tickHealth, 5_000);
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
    setApplyingUrl(true);
    try {
      if (dir !== projectDir()) switchProject(dir, true);
      setSelectedIdRaw(id);
      openSessionStream(id ?? "");
      if (id) {
        setDraft(false);
        void openSession(id);
      }
    } finally {
      setApplyingUrl(false);
    }
  });
}

export {
  // store
  state,
  selectedId,
  draft,
  setDraft,
  projectDir,
  isSending,
  setSending,
  // selectors
  rootOf,
  // actions
  setSelectedId,
  switchProject,
  openSession,
};
export {
  sessionNeedsInput,
  sessionModel,
  lastUserMessageModel,
  sessionLastAgent,
  sessionWorking,
  currentVerb,
  runningSessionCount,
  rootSessionCount,
  sessionTodos,
  sessionTodoCounts,
} from "./sync/selectors";
export type { CurrentVerb } from "./sync/selectors";
export { ackSession } from "./sync/orchestration";
export {
  newSession,
  createSession,
  respondPermission,
  respondQuestion,
  abortSession,
  markSessionIdle,
  consumeEpochChanged,
} from "./sync/actions";
export type { SyncState } from "./sync/store";
// Feature 1 (stale indicator) + Feature 2 (updating indicator): connection-
// health selectors + their thresholds, for the sidebar status dot and any
// diagnostic surface.
export { isStale, isUpdating } from "./sync/stream";
export { STALE_MS, UPDATING_DEBOUNCE_MS } from "./sync/stream";
