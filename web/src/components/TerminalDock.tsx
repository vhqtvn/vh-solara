import { createSignal, For, Show } from "solid-js";
import { setTermFull, setTermKeys, setTermOpen, termFull, termKeys, termOpen } from "../ui";
import { isDesktop } from "../layout";
import { projectDir, selectedId, state } from "../sync";
import { loadVersioned, saveVersioned } from "../lib/store";
import { layoutPx } from "../lib/zoom";
import {
  activeTermId,
  bindSessionTab,
  newAdHocTab,
  removeTermTab,
  setActiveTermId,
  termTabs,
} from "../termTabs";
import { killTerm } from "../termApi";
import { disposeTermCompose } from "../lib/termCompose";
import { displayName } from "../projectSettings";
import TerminalPane from "./TerminalPane";
import Icon from "./Icon";
import "./TerminalDock.css";

// Hosts the terminal: a resizable bottom dock on desktop, full-screen on mobile
// (or when expanded). Mounted only while open, so closing ends the shell.
//
// Tabs: a dir can have several terminals — the shared project shell, shells
// bound to OpenCode sessions, and ad-hoc ones. The strip switches between them;
// only the active pane is mounted (others' shells live on server-side). The ×
// on a tab KILLS that shell (the dock's top-right ✕ only hides the dock).
export default function TerminalDock() {
  const [height, setHeight] = createSignal(loadVersioned<number>("vh.term.height.v1", 1, 300));
  const full = () => termFull() || !isDesktop();

  const dir = () => projectDir();
  const tabs = () => termTabs(dir());
  const active = () => activeTermId(dir());
  const sessionTitle = (id: string) => state.sessions[id]?.title || "Session";
  // Offer "bind current session" only when a real session is selected and it
  // isn't already open as a tab.
  const bindableSession = () => {
    const sid = selectedId();
    if (!sid) return null;
    return tabs().some((t) => t.id === "session:" + sid) ? null : sid;
  };

  function killTab(id: string) {
    void killTerm(dir(), id); // end the server shell
    removeTermTab(dir(), id); // and drop the tab (re-seeds a shared tab if it was the last)
    // The killed shell's held input dies with it (D-4b-3): text can never
    // reach a dead shell, and a same-id shell spawned later must start clean.
    // Disposal holds even if the kill POST fails (offline) — the gesture
    // decided the text is dead. Also covers BACKGROUND tabs (no pane mounted
    // to observe the server's clean close).
    disposeTermCompose(dir(), id);
  }

  function startResize(e: PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      // Pointer coords and innerHeight are viewport px; the dock's inline
      // height style resolves in layout px under UI zoom — convert once here
      // (clamp constants are layout px too). Matches fc2ef59d.
      const ih = layoutPx(window.innerHeight);
      const h = Math.min(Math.max(ih - layoutPx(ev.clientY), 120), ih - 120);
      setHeight(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveVersioned("vh.term.height.v1", 1, height());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <Show when={termOpen()}>
      <div class="term-dock" classList={{ full: full() }} style={full() ? {} : { height: `${height()}px` }}>
        <Show when={!full()}>
          <div class="term-dock-resize" onPointerDown={startResize} />
        </Show>
        <div class="term-dock-head">
          <Icon name="terminal" size={14} />
          <div class="term-tabs" role="tablist" aria-label="Terminals">
            <For each={tabs()}>
              {(t) => (
                <span class="term-tab" classList={{ on: active() === t.id }}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active() === t.id}
                    class="term-tab-label"
                    title={displayName(t.title)}
                    onClick={() => setActiveTermId(dir(), t.id)}
                  >
                    {displayName(t.title)}
                  </button>
                  <button
                    type="button"
                    class="term-tab-kill"
                    aria-label={`Kill ${displayName(t.title)}`}
                    data-tip="Kill this shell"
                    onClick={() => killTab(t.id)}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              )}
            </For>
            <button type="button" class="term-tab-add" data-tip="New shell" aria-label="New terminal" onClick={() => newAdHocTab(dir())}>
              <Icon name="plus" size={13} />
            </button>
            <Show when={bindableSession()}>
              {(sid) => (
                <button
                  type="button"
                  class="term-tab-add term-tab-bind"
                  data-tip="Terminal for the current session"
                  aria-label="Terminal for current session"
                  onClick={() => bindSessionTab(dir(), sid(), sessionTitle(sid()))}
                >
                  <Icon name="terminal" size={12} /> session
                </button>
              )}
            </Show>
          </div>
          <span class="bar-spacer" />
          <button type="button" class="icon-btn" classList={{ on: termKeys() }} data-tip="Toggle key bar" aria-label="Toggle key bar" onClick={() => setTermKeys(!termKeys())}>
            <Icon name="wrap" size={15} />
          </button>
          <Show when={isDesktop()}>
            <button type="button" class="icon-btn" data-tip={termFull() ? "Dock" : "Full screen"} aria-label="Toggle full screen" onClick={() => setTermFull((v) => !v)}>
              <Icon name={termFull() ? "chevronDown" : "maximize"} size={15} />
            </button>
          </Show>
          <button type="button" class="icon-btn" aria-label="Close terminal" onClick={() => setTermOpen(false)}>
            <Icon name="x" size={15} />
          </button>
        </div>
        {/* Keyed on dir + active id so switching tab (or project) remounts a
            fresh pane attached to the right shell. */}
        <Show when={dir() + "\u0000" + active()} keyed>
          {(_k) => {
            const id = active();
            const t = tabs().find((x) => x.id === id);
            return <TerminalPane termId={id} session={t?.session} title={t?.title} />;
          }}
        </Show>
      </div>
    </Show>
  );
}
