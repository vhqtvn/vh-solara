import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { paletteOpen, setPaletteOpen, setSettingsOpen, setAdminOpen, setView, focusComposer } from "../ui";
import { newSession, openSession, setSelectedId, state } from "../sync";
import { toggleSidebar } from "../layout";
import { setSearchQuery } from "../sidebar";
import { exportSessionMarkdown } from "../export";
import { selectedId } from "../sync";
import { modal } from "../lib/a11y";
import Icon from "./Icon";
import "./CommandPalette.css";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// Cmd/Ctrl+K command palette: global actions + jump-to-session, filtered by a
// fuzzy substring match, keyboard-navigable.
export default function CommandPalette() {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;

  const close = () => {
    setPaletteOpen(false);
    setQuery("");
    setActive(0);
  };

  const baseCommands = (): Cmd[] => [
    { id: "new", label: "New session", hint: "compose", run: () => void newSession() },
    { id: "chat", label: "Go to Chat", run: () => setView("chat") },
    { id: "changes", label: "Go to Changes", run: () => setView("changes") },
    { id: "notes", label: "Go to Notes", run: () => setView("notes") },
    { id: "agents", label: "Go to Agent styles", run: () => setView("agents") },
    { id: "focus", label: "Focus composer", run: () => focusComposer() },
    { id: "settings", label: "Open Settings", run: () => setSettingsOpen(true) },
    { id: "admin", label: "Server admin", run: () => setAdminOpen(true) },
    { id: "sidebar", label: "Toggle sidebar", run: () => toggleSidebar() },
    ...(selectedId()
      ? [{ id: "export", label: "Export current session as Markdown", run: () => void exportSessionMarkdown(selectedId()!, state.sessions[selectedId()!]?.title || selectedId()!) }]
      : []),
  ];

  // Sessions to jump to (only when there's a query, to avoid a huge list).
  const sessionCmds = (q: string): Cmd[] => {
    if (!q) return [];
    return Object.values(state.sessions)
      .filter((s) => (s.title || s.id).toLowerCase().includes(q))
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      .slice(0, 8)
      .map((s) => ({
        id: "go:" + s.id,
        label: s.title || s.id,
        hint: "session",
        run: () => { setSelectedId(s.id); void openSession(s.id); },
      }));
  };

  const items = createMemo<Cmd[]>(() => {
    const q = query().trim().toLowerCase();
    const cmds = baseCommands().filter((c) => !q || c.label.toLowerCase().includes(q));
    return [...cmds, ...sessionCmds(q)];
  });

  // Keep the active index in range as the list changes.
  createEffect(() => {
    const n = items().length;
    if (active() >= n) setActive(n > 0 ? n - 1 : 0);
  });

  const run = (c?: Cmd) => {
    if (!c) return;
    close();
    c.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (!paletteOpen()) return; // listener is always attached; only act when open
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, items().length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(items()[active()]); }
  };

  onMount(() => {
    queueMicrotask(() => inputEl?.focus());
    document.addEventListener("keydown", onKey, true);
  });
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  return (
    <Show when={paletteOpen()}>
      <div class="palette-overlay" onClick={close}>
        <div class="palette" role="dialog" aria-label="Command palette" use:modal data-autofocus-keyboard onClick={(e) => e.stopPropagation()}>
          <div class="palette-input-row">
            <Icon name="filter" size={14} />
            <input
              ref={inputEl}
              class="palette-input"
              placeholder="Type a command or session…"
              value={query()}
              onInput={(e) => (setQuery(e.currentTarget.value), setActive(0))}
            />
          </div>
          <div class="palette-list">
            <Show when={items().length > 0} fallback={<div class="palette-empty">No matches</div>}>
              <For each={items()}>
                {(c, i) => (
                  <button
                    type="button"
                    class="palette-item"
                    classList={{ active: i() === active() }}
                    onMouseEnter={() => setActive(i())}
                    onClick={() => run(c)}
                  >
                    <span class="palette-label">{c.label}</span>
                    <Show when={c.hint}><span class="palette-hint">{c.hint}</span></Show>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
