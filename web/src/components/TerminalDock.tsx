import { createSignal, Show } from "solid-js";
import { setTermFull, setTermKeys, setTermOpen, termFull, termKeys, termOpen } from "../ui";
import { isDesktop } from "../layout";
import { loadVersioned, saveVersioned } from "../lib/store";
import TerminalPane from "./TerminalPane";
import Icon from "./Icon";

// Hosts the terminal: a resizable bottom dock on desktop, full-screen on mobile
// (or when expanded). Mounted only while open, so closing ends the shell.
export default function TerminalDock() {
  const [height, setHeight] = createSignal(loadVersioned<number>("vh.term.height.v1", 1, 300));
  const full = () => termFull() || !isDesktop();

  function startResize(e: PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const h = Math.min(Math.max(window.innerHeight - ev.clientY, 120), window.innerHeight - 120);
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
          <span class="term-dock-title">Terminal</span>
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
        <TerminalPane />
      </div>
    </Show>
  );
}
