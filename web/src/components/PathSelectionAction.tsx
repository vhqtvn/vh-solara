import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { openFileAt, setPathSelection } from "../codeFrame";
import { looksLikePath } from "../lib/pathlike";
import Icon from "./Icon";

// Coarse pointers (touch): the OS text-selection menu sits exactly where our
// floating action would, covering it — so suppress the floating button there and
// rely on the header Code button (which opens the live path selection instead).
const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

// When the user selects a path-like run of text anywhere in the app (a path in a
// chat message, a tool output, …), float an "Open file" action above it — works
// for mouse and touch. Clicking resolves the path and opens it in the code
// viewer. The check is the cheap regex (looksLikePath); resolution happens only
// on click, so this never touches the filesystem just to decide whether to show.
export default function PathSelectionAction() {
  const [box, setBox] = createSignal<{ x: number; y: number; text: string } | null>(null);
  let raf = 0;

  const update = () => {
    const sel = window.getSelection();
    const text = sel ? sel.toString() : "";
    if (!sel || sel.isCollapsed || !looksLikePath(text)) {
      setBox(null);
      setPathSelection(null);
      return;
    }
    // Publish to the header Code button (the reliable trigger on touch).
    setPathSelection(text.trim());
    // Floating button only on fine pointers — on touch the OS menu covers it.
    if (coarse()) {
      setBox(null);
      return;
    }
    try {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setBox(null);
        return;
      }
      setBox({ x: rect.left + rect.width / 2, y: rect.top, text: text.trim() });
    } catch {
      setBox(null);
    }
  };
  const onSelChange = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(update);
  };
  const dismiss = () => setBox(null);

  onMount(() => {
    document.addEventListener("selectionchange", onSelChange);
    window.addEventListener("scroll", dismiss, true);
  });
  onCleanup(() => {
    cancelAnimationFrame(raf);
    document.removeEventListener("selectionchange", onSelChange);
    window.removeEventListener("scroll", dismiss, true);
  });

  const openIt = () => {
    const b = box();
    if (!b) return;
    openFileAt(b.text);
    setBox(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <Show when={box()}>
      {(b) => (
        <button
          type="button"
          class="path-sel-action"
          style={{ left: `${b().x}px`, top: `${b().y}px` }}
          // Keep the selection alive: a plain mousedown on the button would
          // collapse it before the click fires.
          onMouseDown={(e) => e.preventDefault()}
          onClick={openIt}
        >
          <Icon name="code" size={13} /> Open file
        </button>
      )}
    </Show>
  );
}
