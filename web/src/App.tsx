import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import GitView from "./components/GitView";
import CodeFrame, { codeMode } from "./components/CodeFrame";
import { codeDockSide } from "./prefs";
import TabBar, { type TabItem } from "./components/TabBar";
import { codeShowing, installCodeFrameHost, openFileAt, pathSelection, postCodeTheme, setPathSelection, toggleCodeDock } from "./code/frame";
import { anyModalOpen } from "./lib/a11y";
import NotesView from "./components/NotesView";
import AgentStylesView from "./components/AgentStylesView";
import SettingsDialog from "./components/SettingsDialog";
import PathSelectionAction from "./components/PathSelectionAction";
import EmptyState from "./components/EmptyState";
import NoProjectState from "./components/NoProjectState";
import NotificationCenter from "./components/NotificationCenter";
import HeaderUsage from "./components/HeaderUsage";
import StatusPopover from "./components/StatusPopover";
import SessionInspector from "./components/SessionInspector";
import SessionContextMenu from "./components/SessionContextMenu";
import Tooltip from "./components/Tooltip";
import UpdateToast from "./components/UpdateToast";
import ConnectionToast from "./components/ConnectionToast";
import OpenCodeHealthPanel from "./components/OpenCodeHealthPanel";
import AdminMenu from "./components/AdminMenu";
import RestartOverlay from "./components/RestartOverlay";
import WorkingOverlay from "./components/WorkingOverlay";
import CommandPalette from "./components/CommandPalette";
import TerminalDock from "./components/TerminalDock";
import ViewFrame from "./components/ViewFrame";
import ManagedPanel from "./components/ManagedPanel";
import DiagLogDialog from "./components/DiagLogDialog";
import OpenCodeLogsDialog from "./components/OpenCodeLogsDialog";
import Icon from "./components/Icon";
import { menuTriggers } from "./sessionMenu";
import { isDesktop, sidebarCollapsed, sidebarWidth, toggleSidebar } from "./layout";
import { draft, selectedId, state } from "./sync";
import { startDiagCapture } from "./sync/diaglog";
import { refreshViews, views } from "./views";
import { managed, refreshManaged } from "./managed";
import { notesVisible, refreshProjectSettings, watchProjectSettings } from "./projectSettings";
import { pushNotification } from "./notify";
import { broadcastTheme, postThemeTo } from "./themeTokens";
import { customTheme, theme } from "./theme";
import { adminOpen, diagLogOpen, embeddedViewId, isEmbeddedView, ocLogsOpen, setAdminOpen, setDiagLogOpen, setOcLogsOpen, setPaletteOpen, setSettingsOpen, setTermOpen, setView, settingsOpen, termOpen, view, VIEW_PREFIX } from "./ui";
import { projectDir } from "./sync";

export default function App() {
  const [navOpen, setNavOpen] = createSignal(false);
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const [managedOpen, setManagedOpen] = createSignal(false);
  // Path selection captured when the Code button is pressed (see its handlers).
  let codeBtnTarget: string | null = null;

  // View tabs for the header switcher (built-ins + any embedded views). Icons
  // are best-effort (the icon style shows them with a tooltip).
  const tabItems = createMemo<TabItem[]>(() => {
    const items: TabItem[] = [
      { key: "chat", label: "Chat", icon: "send" },
      { key: "changes", label: "Changes", icon: "fork" },
    ];
    if (notesVisible()) items.push({ key: "notes", label: "Notes", icon: "clipboard" });
    for (const v of views()) items.push({ key: VIEW_PREFIX + v.view_id, label: v.title, icon: "layers" });
    return items;
  });

  // Global hotkeys: Cmd/Ctrl+K → command palette; Ctrl+` → terminal; Cmd/Ctrl+B
  // → code dock. Cmd/Ctrl+K always works (it also closes the palette); the others
  // stand down while a modal dialog owns the keyboard, so they don't act behind it.
  const onGlobalKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      setPaletteOpen((v) => !v);
      return;
    }
    if (anyModalOpen()) return;
    if (e.ctrlKey && e.key === "`") {
      e.preventDefault();
      setTermOpen((v) => !v);
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      toggleCodeDock();
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
  // Reflect a held Ctrl/Cmd on the root so path-like inline code shows its
  // ctrl-click go-to affordance (see .mod-down in styles.css).
  const syncMod = (e: KeyboardEvent) => document.documentElement.classList.toggle("mod-down", e.ctrlKey || e.metaKey);
  const clearMod = () => document.documentElement.classList.remove("mod-down");
  onMount(() => {
    document.addEventListener("keydown", onGlobalKey);
    document.addEventListener("keydown", syncMod);
    document.addEventListener("keyup", syncMod);
    window.addEventListener("blur", clearMod);
    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("message", onThemeRequest);
    installCodeFrameHost();
    void refreshViews();
    viewsPoll = window.setInterval(() => void refreshViews(), 60000);
    // Repo-declared managed projects: refresh on mount + poll alongside views.
    void refreshManaged();
    // Wire the hidden diagnostic-log capture (default-off ring buffer). No-op
    // capture until the operator enables it from the server-admin menu.
    startDiagCapture();
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onGlobalKey);
    document.removeEventListener("keydown", syncMod);
    document.removeEventListener("keyup", syncMod);
    window.removeEventListener("blur", clearMod);
    document.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("message", onThemeRequest);
    clearInterval(viewsPoll);
    clearInterval(managedPoll);
  });
  // Re-scope the managed view when the active project changes, and surface the
  // trust gate proactively when a project wants to run repo-declared commands.
  createEffect(() => {
    projectDir();
    // Re-scope both the embedded views and the managed-project panel to the
    // newly active project.
    void refreshViews();
    void refreshManaged();
    void refreshProjectSettings();
    watchProjectSettings(); // re-point the live config watch at the active project
    clearInterval(managedPoll);
    managedPoll = window.setInterval(() => void refreshManaged(), 5000);
  });
  // If Notes gets hidden (global pref off + no per-project opt-in) while the
  // Notes tab is active, fall back to Chat so the user isn't stuck on a blank tab.
  createEffect(() => {
    if (view() === "notes" && !notesVisible()) setView("chat");
  });
  // Activating a session must be VISIBLE. If we're on a non-Chat tab
  // (Changes/Notes/an embedded view), selecting a session would otherwise look
  // like nothing happened — so snap to Chat. Centralized here so every entry
  // point (tree, notifications, jump-to-subsession, future ones) gets it for
  // free. `defer` avoids firing on the initial mount / deep-linked view.
  createEffect(
    on(selectedId, (id, prev) => {
      if (id && id !== prev && view() !== "chat") setView("chat");
    }, { defer: true }),
  );
  // A project awaiting trust must NOT auto-open the panel (that blocked the view,
  // especially on mobile where it's a modal). Instead fire a red notification
  // once per (dir, config) — the header Project-processes button keeps its warn
  // highlight, and tapping it opens the review dialog to Trust or dismiss.
  const notifiedTrust = new Set<string>();
  createEffect(() => {
    const m = managed();
    if (!m || (m.state !== "awaiting-trust" && m.state !== "changed")) return;
    const key = m.dir + ":" + (m.config_hash || "");
    if (notifiedTrust.has(key)) return;
    notifiedTrust.add(key);
    pushNotification({
      kind: "error",
      title:
        m.state === "changed"
          ? "A project's config changed — review it in Project processes before it runs."
          : "A project wants to run repo-declared commands — review it in Project processes.",
    });
  });
  // Push the live theme to every embedded view whenever it changes (built-in or
  // custom, light/dark) — operator toggles restyle the views without a reload.
  // Deferred to a microtask: the effect fires synchronously on the signal write,
  // which is BEFORE setThemeId/setCustomTheme call applyTheme(); reading computed
  // styles now would see the previous theme. The microtask runs after applyTheme.
  createEffect(() => {
    theme();
    customTheme();
    queueMicrotask(() => {
      broadcastTheme();
      postCodeTheme(); // keep the framed code viewer in sync too
    });
  });
  // The embedded view currently selected (if any), resolved from the live list.
  const activeEmbedded = () =>
    isEmbeddedView(view()) ? views().find((v) => v.view_id === embeddedViewId(view())) : undefined;
  // Identity the embedded iframe actually depends on: id + proxied prefix +
  // sandbox. The 60s views poll replaces the view objects with fresh-but-equal
  // ones, so keying the iframe on the object reference remounted (reloaded) it
  // every minute. Keying on this stable string remounts only on a real
  // switch/change, never on poll churn.
  const activeViewKey = () => {
    const v = activeEmbedded();
    return v ? `${v.view_id} ${v.path_prefix} ${v.sandbox || ""}` : undefined;
  };

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
                    : view() === "agents"
                      ? "Agent styles"
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
          <TabBar items={tabItems} active={view} onSelect={setView} />
          <Show when={selectedId()}>
            <HeaderUsage sessionId={selectedId()!} onInspect={() => setInspectorOpen(true)} />
          </Show>
          <button
            type="button"
            class="icon-btn"
            classList={{ on: codeShowing(), "has-target": !!pathSelection() }}
            aria-label={pathSelection() ? "Open selected path" : "Code"}
            data-tip={pathSelection() ? `Open ${pathSelection()}` : "Code (Ctrl+B)"}
            // Capture the selection on pointerdown — the tap that follows
            // collapses it before click would read it (notably on touch).
            onPointerDown={() => (codeBtnTarget = pathSelection())}
            onClick={() => {
              const target = codeBtnTarget;
              codeBtnTarget = null;
              if (target) {
                openFileAt(target);
                setPathSelection(null);
                window.getSelection()?.removeAllRanges();
                return;
              }
              toggleCodeDock();
            }}
          >
            <Icon name="code" />
          </button>
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
                <Icon name="cpu" />
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
        <div
          class="main-body"
          classList={{ "code-full": codeMode() === "full", "code-dock-open": codeMode() === "dock", "dock-left": codeDockSide() === "left" }}
        >
          <div class="view-primary">
            {/* No project selected (daemon cwd is not a meaningful project):
                show the no-project empty state instead of the session view.
                The session view + its no-SESSION EmptyState live below, gated
                on a real projectDir(). */}
            <Show when={projectDir()} fallback={<NoProjectState />}>
            <Show when={view() === "notes"}>
              <NotesView />
            </Show>
            <Show when={view() === "changes"}>
              <GitView />
            </Show>
            <Show when={view() === "agents"}>
              <AgentStylesView />
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
            {/* Consumer-registered embedded views — keyed on the view's stable
                identity (id+prefix+sandbox), not the object, so switching remounts
                a fresh iframe on the right prefix but the 60s poll doesn't. */}
            <Show when={activeViewKey()} keyed>
              {(_key) => <ViewFrame view={activeEmbedded()!} />}
            </Show>
            </Show>
          </div>
          {/* Code viewer: full (Code tab), a resizable peek dock, or a mobile
              overlay — one isolated iframe, see CodeFrame. */}
          <CodeFrame />
        </div>
        <TerminalDock />
      </main>
      <Show when={settingsOpen()}>
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      </Show>
      <Show when={inspectorOpen() && selectedId()}>
        <SessionInspector sessionId={selectedId()!} onClose={() => setInspectorOpen(false)} />
      </Show>
      <Show when={diagLogOpen()}>
        <DiagLogDialog onClose={() => setDiagLogOpen(false)} />
      </Show>
      <Show when={ocLogsOpen()}>
        <OpenCodeLogsDialog onClose={() => setOcLogsOpen(false)} />
      </Show>
      <PathSelectionAction />
      <SessionContextMenu />
      <Tooltip />
      <UpdateToast />
      <ConnectionToast />
      <OpenCodeHealthPanel />
      <RestartOverlay />
      <WorkingOverlay />
      <CommandPalette />
    </div>
  );
}
