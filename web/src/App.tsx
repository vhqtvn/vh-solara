import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import GitView from "./components/GitView";
import NotesView from "./components/NotesView";
import SettingsDialog from "./components/SettingsDialog";
import FileViewer from "./components/FileViewer";
import EmptyState from "./components/EmptyState";
import NotificationCenter from "./components/NotificationCenter";
import HeaderUsage from "./components/HeaderUsage";
import StatusPopover from "./components/StatusPopover";
import SessionInspector from "./components/SessionInspector";
import SessionContextMenu from "./components/SessionContextMenu";
import Tooltip from "./components/Tooltip";
import UpdateToast from "./components/UpdateToast";
import ConnectionToast from "./components/ConnectionToast";
import AdminMenu from "./components/AdminMenu";
import RestartOverlay from "./components/RestartOverlay";
import CommandPalette from "./components/CommandPalette";
import TerminalDock from "./components/TerminalDock";
import ViewFrame from "./components/ViewFrame";
import ManagedPanel from "./components/ManagedPanel";
import Icon from "./components/Icon";
import { menuTriggers } from "./sessionMenu";
import { isDesktop, sidebarCollapsed, sidebarWidth, toggleSidebar } from "./layout";
import { draft, selectedId, state } from "./sync";
import { refreshViews, views } from "./views";
import { managed, refreshManaged } from "./managed";
import { broadcastTheme, postThemeTo } from "./themeTokens";
import { customTheme, theme } from "./theme";
import { adminOpen, embeddedViewId, isEmbeddedView, setAdminOpen, setPaletteOpen, setSettingsOpen, setTermOpen, setView, settingsOpen, termOpen, view, VIEW_PREFIX } from "./ui";
import { projectDir } from "./sync";

export default function App() {
  const [navOpen, setNavOpen] = createSignal(false);
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const [managedOpen, setManagedOpen] = createSignal(false);

  // Global hotkeys: Cmd/Ctrl+K → command palette; Ctrl+` → terminal.
  const onGlobalKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      setPaletteOpen((v) => !v);
    } else if (e.ctrlKey && e.key === "`") {
      e.preventDefault();
      setTermOpen((v) => !v);
    }
  };
  // Suppress the browser's long-press / right-click page menu (download/share/
  // print) on the app chrome, so a hold doesn't pop it. Native context stays on
  // editable/selectable regions (copy/paste in inputs, chat text, the terminal).
  const onContextMenu = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.("input, textarea, [contenteditable='true'], .term, .md, .md-raw, .vh-diff, .msg-parts, .tool-output, .msg-inspect, .term-sess-preview")) return;
    e.preventDefault();
  };
  // Consumer-registered embedded views: load on mount and refresh periodically
  // (registration can happen after the page loads), so they appear in the
  // view-switcher without a reload.
  let viewsPoll: number | undefined;
  let managedPoll: number | undefined;
  // An embedded view may ask for the theme on its own load timing.
  const onThemeRequest = (e: MessageEvent) => {
    const d = e.data as { source?: string; type?: string } | null;
    if (d?.source === "vh-solara" && d.type === "theme-request") postThemeTo(e.source as Window);
  };
  onMount(() => {
    document.addEventListener("keydown", onGlobalKey);
    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("message", onThemeRequest);
    void refreshViews();
    viewsPoll = window.setInterval(() => void refreshViews(), 60000);
    // Repo-declared managed projects: refresh on mount + poll alongside views.
    void refreshManaged();
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onGlobalKey);
    document.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("message", onThemeRequest);
    clearInterval(viewsPoll);
    clearInterval(managedPoll);
  });
  // Re-scope the managed view when the active project changes, and surface the
  // trust gate proactively when a project wants to run repo-declared commands.
  createEffect(() => {
    projectDir();
    void refreshManaged();
    clearInterval(managedPoll);
    managedPoll = window.setInterval(() => void refreshManaged(), 5000);
  });
  createEffect(() => {
    const m = managed();
    if (m && (m.state === "awaiting-trust" || m.state === "changed")) setManagedOpen(true);
  });
  // Push the live theme to every embedded view whenever it changes (built-in or
  // custom, light/dark) — operator toggles restyle the views without a reload.
  // Deferred to a microtask: the effect fires synchronously on the signal write,
  // which is BEFORE setThemeId/setCustomTheme call applyTheme(); reading computed
  // styles now would see the previous theme. The microtask runs after applyTheme.
  createEffect(() => {
    theme();
    customTheme();
    queueMicrotask(broadcastTheme);
  });
  // The embedded view currently selected (if any), resolved from the live list.
  const activeEmbedded = () =>
    isEmbeddedView(view()) ? views().find((v) => v.view_id === embeddedViewId(view())) : undefined;

  // Long-press on the Settings button opens the server-admin popup (right-click
  // does on desktop). Plain click opens Settings. `lpFired` swallows the click
  // the browser synthesizes after the finger lifts, so a long-press doesn't also
  // open Settings.
  let lpTimer: number | undefined;
  let lpFired = false;
  const startLongPress = () => {
    lpFired = false;
    lpTimer = window.setTimeout(() => {
      lpFired = true;
      setAdminOpen(true);
    }, 500);
  };
  const cancelLongPress = () => clearTimeout(lpTimer);
  const selected = () => (selectedId() ? state.sessions[selectedId()!] : null);

  // Drive the persisted, resizable sidebar width via a CSS var.
  createEffect(() => document.documentElement.style.setProperty("--sidebar-w", `${sidebarWidth()}px`));

  // Menu button: collapse/expand on desktop, slide-over toggle on mobile.
  const toggleNav = () => (isDesktop() ? toggleSidebar() : setNavOpen((v) => !v));

  return (
    <div class="app" classList={{ "sidebar-collapsed": sidebarCollapsed() }}>
      <Sidebar open={navOpen()} onClose={() => setNavOpen(false)} />
      <main class="main">
        <header class="main-head">
          <button type="button" class="nav-toggle" onClick={toggleNav} aria-label="Toggle sidebar">
            <Icon name="menu" />
          </button>
          <Show
            when={view() === "chat" && selected()}
            fallback={
              <span class="main-title">
                {view() === "changes"
                  ? "Changes"
                  : view() === "notes"
                    ? "Notes"
                    : isEmbeddedView(view())
                      ? activeEmbedded()?.title || "View"
                      : selected()?.title || "Select a session"}
              </span>
            }
          >
            <span
              class="main-title has-menu"
              data-tip="Right-click or long-press for actions"
              {...menuTriggers(() => selectedId()!, () => selected()!.title || selectedId()!)}
            >
              {selected()!.title || selectedId()}
            </span>
          </Show>
          <div class="seg">
            <button type="button" classList={{ on: view() === "chat" }} onClick={() => setView("chat")}>
              Chat
            </button>
            <button type="button" classList={{ on: view() === "changes" }} onClick={() => setView("changes")}>
              Changes
            </button>
            <button type="button" classList={{ on: view() === "notes" }} onClick={() => setView("notes")}>
              Notes
            </button>
            <For each={views()}>
              {(v) => (
                <button
                  type="button"
                  classList={{ on: view() === VIEW_PREFIX + v.view_id }}
                  onClick={() => setView(VIEW_PREFIX + v.view_id)}
                  title={v.title}
                >
                  {v.title}
                </button>
              )}
            </For>
          </div>
          <Show when={selectedId()}>
            <HeaderUsage sessionId={selectedId()!} onInspect={() => setInspectorOpen(true)} />
          </Show>
          <button
            type="button"
            class="icon-btn"
            classList={{ on: termOpen() }}
            aria-label="Terminal"
            data-tip="Terminal (Ctrl+`)"
            onClick={() => setTermOpen((v) => !v)}
          >
            <Icon name="terminal" />
          </button>
          <Show when={managed()}>
            <div class="settings-wrap">
              <button
                type="button"
                class="icon-btn"
                classList={{
                  on: managedOpen(),
                  warn: managed()!.state === "awaiting-trust" || managed()!.state === "changed",
                }}
                aria-label="Project processes"
                data-tip="Project processes (repo-declared)"
                onClick={() => setManagedOpen((v) => !v)}
              >
                <Icon name="layers" />
              </button>
              <Show when={managedOpen()}>
                <ManagedPanel onClose={() => setManagedOpen(false)} />
              </Show>
            </div>
          </Show>
          <StatusPopover />
          <NotificationCenter />
          <div class="settings-wrap">
            <button
              type="button"
              class="icon-btn settings-btn"
              aria-label="Settings"
              data-tip="Settings (right-click / hold: server admin)"
              onClick={() => {
                if (lpFired) { lpFired = false; return; } // long-press already opened admin
                setSettingsOpen(true);
              }}
              onContextMenu={(e) => (e.preventDefault(), setAdminOpen(true))}
              onTouchStart={startLongPress}
              onTouchEnd={cancelLongPress}
              onTouchMove={cancelLongPress}
            >
              <Icon name="settings" />
            </button>
            <Show when={adminOpen()}>
              <AdminMenu onClose={() => setAdminOpen(false)} />
            </Show>
          </div>
        </header>
        <div class="main-body">
          <Show when={view() === "notes"}>
            <NotesView />
          </Show>
          <Show when={view() === "changes"}>
            <GitView />
          </Show>
          <Show when={view() === "chat"}>
            <Show when={selectedId()} fallback={
              <Show when={draft()} fallback={<EmptyState />}>
                <ChatView sessionId="" draft />
              </Show>
            }>
              <ChatView sessionId={selectedId()!} />
            </Show>
          </Show>
          {/* Consumer-registered embedded views — keyed so switching remounts a
              fresh iframe attached to the right prefix. */}
          <Show when={activeEmbedded()} keyed>
            {(v) => <ViewFrame view={v} />}
          </Show>
        </div>
        <TerminalDock />
      </main>
      <Show when={settingsOpen()}>
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      </Show>
      <Show when={inspectorOpen() && selectedId()}>
        <SessionInspector sessionId={selectedId()!} onClose={() => setInspectorOpen(false)} />
      </Show>
      <FileViewer />
      <SessionContextMenu />
      <Tooltip />
      <UpdateToast />
      <ConnectionToast />
      <RestartOverlay />
      <CommandPalette />
    </div>
  );
}
