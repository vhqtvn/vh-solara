import { setInspectAt } from "../tooltip";
import Icon from "./Icon";

// A "?" button you drag onto any control to reveal its tooltip — the touch
// substitute for hover (auto-tooltips are off on touch). Press and drag over the
// UI; the tip for whatever is under your finger shows; release to dismiss.
export default function HelpInspector() {
  let active = false;
  const down = (e: PointerEvent) => {
    e.preventDefault();
    active = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setInspectAt({ x: e.clientX, y: e.clientY });
  };
  const move = (e: PointerEvent) => {
    if (active) setInspectAt({ x: e.clientX, y: e.clientY });
  };
  const end = (e: PointerEvent) => {
    active = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setInspectAt(null);
  };
  return (
    <button
      type="button"
      class="help-inspect"
      aria-label="What's this? Drag onto a control to see its tip"
      data-tip="Drag me onto anything to see what it does"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <Icon name="help" size={14} />
    </button>
  );
}
