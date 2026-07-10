import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { hoverCapable, inspectAt, placeTooltip, type Rectish } from "../tooltip";
import styles from "./Tooltip.module.css";

// DOM-based tooltip (mounted once at the app root). We avoid the native `title`
// attribute because some window managers (e.g. swaywm) spawn a new window for
// it; elements opt in with `data-tip="…"`. Delegated hover/focus, fixed-position
// bubble clamped to the viewport.
export default function Tooltip() {
  const [tip, setTip] = createSignal<{ text: string; rect: Rectish } | null>(null);
  const [pos, setPos] = createSignal<{ x: number; y: number; above: boolean } | null>(null);
  let current: HTMLElement | null = null;
  let bubble: HTMLDivElement | undefined;

  function show(target: HTMLElement) {
    const text = target.getAttribute("data-tip");
    if (!text) return;
    const r = target.getBoundingClientRect();
    setTip({ text, rect: { left: r.left, top: r.top, bottom: r.bottom, width: r.width } });
  }
  const hide = () => {
    current = null;
    setTip(null);
  };

  // Once the bubble is in the DOM we know its real (wrapped) size, so clamp the
  // placement to the viewport. Runs after render — effects flush before paint,
  // so there's no visible jump.
  createEffect(() => {
    const t = tip();
    if (!t || !bubble) {
      setPos(null);
      return;
    }
    const b = bubble.getBoundingClientRect();
    setPos(
      placeTooltip(
        t.rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width: b.width, height: b.height },
      ),
    );
  });

  const onOver = (e: Event) => {
    if (!hoverCapable) return; // touch: no auto-tooltips (use the ? inspector)
    const t = (e.target as HTMLElement)?.closest?.("[data-tip]") as HTMLElement | null;
    if (t && t !== current) {
      current = t;
      show(t);
    }
  };

  // Draggable "?" inspector: while it tracks a point, show the tip of whatever is
  // under it (skipping the inspector button itself).
  createEffect(() => {
    const pt = inspectAt();
    if (!pt) {
      if (current) hide();
      return;
    }
    const el = document.elementFromPoint(pt.x, pt.y) as HTMLElement | null;
    const t = el?.closest?.("[data-tip]:not(.help-inspect)") as HTMLElement | null;
    if (t) {
      current = t;
      show(t);
    } else if (current) {
      hide();
    }
  });
  const onOut = (e: PointerEvent | FocusEvent) => {
    if (!current) return;
    const to = (e as any).relatedTarget as HTMLElement | null;
    // Resolve where the pointer/focus is going. If it lands on a *different*
    // tipped element (e.g. a nested `data-tip` descendant), switch to it right
    // now instead of waiting for the follow-up `pointerover` — that follow-up
    // is not guaranteed to reach this delegated handler (it can be intercepted
    // by a stopPropagation on the way up, or suppressed by a browser quirk),
    // which left the outer tip stuck. If it's the same tip (moved within the
    // same tipped element / to a non-tipped descendant of it), keep it.
    const next = to?.closest?.("[data-tip]") as HTMLElement | null;
    if (next) {
      if (next !== current) {
        current = next;
        show(next);
      }
      return;
    }
    hide();
  };

  onMount(() => {
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut as EventListener);
    document.addEventListener("focusin", onOver);
    document.addEventListener("focusout", onOut as EventListener);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("pointerdown", hide);
    window.addEventListener("blur", hide);
  });
  onCleanup(() => {
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("pointerout", onOut as EventListener);
    document.removeEventListener("focusin", onOver);
    document.removeEventListener("focusout", onOut as EventListener);
    document.removeEventListener("scroll", hide, true);
    window.removeEventListener("pointerdown", hide);
    window.removeEventListener("blur", hide);
  });

  return (
    <Show when={tip()}>
      <div
        ref={bubble}
        class="tooltip"
        classList={{ [styles.above]: !!pos()?.above }}
        role="tooltip"
        style={
          pos()
            ? { left: `${pos()!.x}px`, top: `${pos()!.y}px` }
            : { left: "0", top: "0", visibility: "hidden" }
        }
      >
        {tip()!.text}
      </div>
    </Show>
  );
}
