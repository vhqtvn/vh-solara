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
import { displayName } from "./projectSettings";
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
  loadSelected,
  persistSelection,
} from "./sync/store";
import { rootOf } from "./sync/selectors";
import { currentUrlSession, syncUrl, setApplyingUrl } from "./sync/url";
import { wasManagedPopState } from "./lib/backStack";
import { connect } from "./sync/tree-transport";
import { closeSessionStream, openSessionStream } from "./sync/session-stream";
import { watchdogTick, maybeReconnect, tickHealth, resyncTree } from "./sync/health";
import { startPeriodicResync } from "./sync/periodic-resync";
import { setSelectedId, switchProject, openSession } from "./sync/actions";

// Inject the session-store accessors alerts needs (instead of alerts importing
// from sync — that was a cycle). Bound at load, before any heartbeat/notice runs.
// displayOf is wired the same way for the same reason: alerts must NOT import
// projectSettings directly (projectSettings imports projectDir from this module,
// so alerts→projectSettings would pull sync back in and reopen the cycle). sync
// → projectSettings is the benign direction: projectSettings uses projectDir
// only lazily inside functions, so the ESM live-binding handles the depth-first
// eval order without a TDZ crash.
bindAlertsContext({
  selectedId,
  rootOf,
  sessionTitle: (id) => state.sessions[id]?.title,
  displayOf: displayName,
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
  // Issue 2 / Q6: on focus return (a backgrounded tab resumes — iOS suspends
  // background sockets → drift accumulates while the watchdog can't run),
  // request a fresh snapshot too. visibilitychange is preferred over window.focus
  // (more reliable on mobile, fires on tab switch back as well as window focus).
  // Separate from the maybeReconnect listener above: that reconnects a
  // closed/stale stream; this forces a fresh snapshot when the tree is HEALTHY
  // but drifted (the exact drift class this fix targets). Throttled inside
  // resyncTree so rapid focus changes can't reconnect repeatedly. Non-
  // destructive: connect(true) no longer pre-clears the map (atomic swap via
  // seedTreeStore), so this heals drift without an empty-frame flash and without
  // collapsing manual expansions.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resyncTree();
  });
  // Q6: a conditional, low-frequency (~10min + jitter) periodic resync as a
  // bounded catch-all for surviving client drift on a CONTINUOUSLY-foregrounded
  // tab (the on-focus trigger above can't see it — the tab never backgrounded,
  // so iOS never suspended its socket, so no visibilitychange fires). NOT the
  // old unconditional 90s cadence: it runs ONLY when every precondition in
  // periodicResyncShouldRun() holds (visible + online + healthy/open stream +
  // no snapshot/reconcile/busy in flight + no recovery in the previous
  // interval), and resets after any successful authoritative recovery. The
  // diffs-found-vs-no-op instrumentation keeps recurring emitter gaps visible.
  // Full contract + preconditions live in web/src/sync/stream.ts (Q6 block).
  startPeriodicResync();

  // Normalize the URL so the tab is self-describing (carries its resolved dir
  // even if it loaded from the localStorage fallback) — in place, never pushed.
  syncUrl(currentUrlSession());

  // Open the session named in the URL on load (deep link / refresh). When the
  // URL lacks ?session= (an OS-driven relaunch of the installed PWA drops it —
  // start_url is /), fall back to the last-selected session persisted for this
  // project, mirroring the urlDir() ?? LS_PROJECT pattern. The URL still WINS
  // when present (shareability + per-tab state); localStorage is the fallback
  // ONLY when the URL omits it. Restore is optimistic (no existence check),
  // identical to the ?session= path. Persisting `initial` here seeds LS from a
  // URL deep-link so a later OS-relaunch (which drops ?session=) restores it.
  const initial = currentUrlSession() ?? loadSelected(projectDir());
  if (initial) {
    setSelectedIdRaw(initial);
    openSessionStream(initial);
    void openSession(initial);
    persistSelection(projectDir(), initial);
  }
  // Legacy session/project entries only. Modern selection never pushes history
  // (sync/url.ts replaceState) and browser back dismisses overlays instead
  // (lib/backStack.ts); events the back-stack manager owns — token unwinds,
  // consume traversals, backs that dismissed surfaces — must never re-select a
  // session. Only a genuine legacy walk (a tab that still carries session
  // entries pushed by an older build, reached with no overlay involved) lands
  // here, and for those the old session+project walk behavior is preserved.
  window.addEventListener("popstate", (ev) => {
    if (wasManagedPopState(ev)) return;
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
        // Keep LS in sync with a back/forward selection (id is the URL's source
        // of truth here; mirror it into the per-project fallback).
        persistSelection(projectDir(), id);
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
  inlineSessionModel,
  sessionProjectID,
  lastUserMessageModel,
  sessionLastAgent,
  sessionWorking,
  currentVerb,
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
export { isStale } from "./sync/health";
export { isUpdating, UPDATING_DEBOUNCE_MS } from "./sync/reconcile";
export { STALE_MS } from "./sync/stream";
// Phase 4 — historical-page load-older action (called from ChatView's
// IntersectionObserver top sentinel + "Load older" button).
export { loadOlder } from "./sync/history";
// tree=2 — server-owned tree expand action (called from SessionTree's
// TreeStateView onToggle). Collapse is client-only (treeState.collapseTreeNode),
// so no export needed for it here.
export { expandTreeNode } from "./sync/tree-transport";
// Issue 5 — eagerly prune an archived session from the client tree even when
// the server emits no delete event (the session was already absent from the
// server-side live store). Called from archive.ts after a successful archive.
export { pruneSessionDeleted } from "./sync/reconcile";
