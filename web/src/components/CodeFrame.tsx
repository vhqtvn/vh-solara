import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { projectDir } from "../sync";
import { bindCodeFrame } from "../codeFrame";
import { codeDockOpen, setCodeDockOpen, codeMobileOverlay, setCodeMobileOverlay, setView, view } from "../ui";
import { isDesktop } from "../layout";
import { codeDockSide, setCodeDockSide, codeDockWidth, setCodeDockWidth } from "../prefs";
import Icon from "./Icon";

export type CodeMode = "full" | "dock" | "overlay" | "hidden";

// Hosts the code viewer in ONE same-origin iframe (DOM isolated from the main
// document). It serves three appearances from the same element so the iframe
// never reparents/reloads on a mode switch:
//   • full    — Code tab (dig); fills the main area (view === "code")
//   • dock     — resizable side panel (peek beside chat on desktop)
//   • overlay  — full-screen sheet on mobile (peek/dig)
// Lazily mounted on first use, then kept alive (display:none) to preserve the
// open file + scroll across switches.
export function codeMode(): CodeMode {
  if (!isDesktop()) return view() === "code" || codeMobileOverlay() ? "overlay" : "hidden";
  if (view() === "code") return "full";
  if (codeDockOpen()) return "dock";
  return "hidden";
}

export default function CodeFrame() {
  const mode = createMemo(codeMode);
  const [mounted, setMounted] = createSignal(false);
  createEffect(() => {
    if (mode() !== "hidden") setMounted(true);
  });
  let el: HTMLIFrameElement | undefined;
  const src = createMemo(() => `${location.pathname}?standalone=code&dir=${encodeURIComponent(projectDir())}`);

  // Close: the dock and the overlay close differently (overlay may also be the
  // full Code tab on mobile, which should return to chat).
  const close = () => {
    setCodeDockOpen(false);
    setCodeMobileOverlay(false);
    if (view() === "code") setView("chat");
  };

  // Drag-to-resize the dock from its inner edge. The iframe would otherwise
  // swallow pointermove the moment the cursor crossed into it (so the drag
  // updated only in fits when over the thin handle) — capture the pointer on the
  // handle and disable iframe hit-testing for the gesture so moves keep flowing.
  const [resizing, setResizing] = createSignal(false);
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture?.(e.pointerId);
    setResizing(true);
    const startX = e.clientX;
    const startW = codeDockWidth();
    const move = (ev: PointerEvent) => {
      // Dock on the right grows when dragging left; on the left, the opposite.
      const dx = codeDockSide() === "right" ? startX - ev.clientX : ev.clientX - startX;
      setCodeDockWidth(startW + dx);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture?.(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      setResizing(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  return (
    <Show when={mounted()}>
      <div
        class="code-dock"
        classList={{ full: mode() === "full", dock: mode() === "dock", overlay: mode() === "overlay", hidden: mode() === "hidden", resizing: resizing() }}
        style={mode() === "dock" ? { "flex-basis": `${codeDockWidth()}px` } : undefined}
      >
        <Show when={mode() === "dock"}>
          <div class="code-dock-resize" onPointerDown={startResize} title="Drag to resize" />
        </Show>
        <Show when={mode() !== "hidden"}>
          <div class="code-dock-head">
            <Show when={mode() === "overlay"}>
              <button type="button" class="icon-btn" aria-label="Back" onClick={close}><Icon name="arrowDown" size={16} /></button>
            </Show>
            <span class="code-dock-title">Code</span>
            <span class="code-dock-spacer" />
            <Show when={mode() === "dock"}>
              <button
                type="button"
                class="icon-btn"
                classList={{ "dock-flip": codeDockSide() === "right" }}
                aria-label="Dock side"
                data-tip={codeDockSide() === "right" ? "Dock left" : "Dock right"}
                onClick={() => setCodeDockSide(codeDockSide() === "right" ? "left" : "right")}
              >
                <Icon name="dock" size={15} />
              </button>
              <button type="button" class="icon-btn" aria-label="Expand to full" data-tip="Open full" onClick={() => { setCodeDockOpen(false); setView("code"); }}>
                <Icon name="maximize" size={15} />
              </button>
            </Show>
            <Show when={mode() === "full"}>
              <button type="button" class="icon-btn" aria-label="Dock to side" data-tip="Dock to side" onClick={() => { setView("chat"); setCodeDockOpen(true); }}>
                <Icon name="dock" size={15} />
              </button>
            </Show>
            <button type="button" class="icon-btn" aria-label="Close" onClick={close}><Icon name="x" size={15} /></button>
          </div>
        </Show>
        <iframe
          ref={el}
          class="code-frame"
          title="Code"
          src={src()}
          onLoad={() => bindCodeFrame(el!)}
        />
      </div>
    </Show>
  );
}
