import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { hoverCapable, inspectAt } from "../tooltip";

// DOM-based tooltip (mounted once at the app root). We avoid the native `title`
// attribute because some window managers (e.g. swaywm) spawn a new window for
// it; elements opt in with `data-tip="…"`. Delegated hover/focus, fixed-position
// bubble clamped to the viewport.
export default function Tooltip() {
  const [tip, setTip] = createSignal<{ text: string; x: number; y: number; above: boolean } | null>(null);
  let current: HTMLElement | null = null;

  function show(target: HTMLElement) {
    const text = target.getAttribute("data-tip");
    if (!text) return;
    const r = target.getBoundingClientRect();
    const above = r.bottom + 34 > window.innerHeight;
    const x = Math.min(Math.max(8, r.left + r.width / 2), window.innerWidth - 8);
    setTip({ text, x, y: above ? r.top - 6 : r.bottom + 6, above });
  }
  const hide = () => {
    current = null;
    setTip(null);
  };

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
    const to = (e as any).relatedTarget as Node | null;
    if (to && current.contains(to)) return; // moved within the same element
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
        class="tooltip"
        classList={{ above: tip()!.above }}
        role="tooltip"
        style={{ left: `${tip()!.x}px`, top: `${tip()!.y}px` }}
      >
        {tip()!.text}
      </div>
    </Show>
  );
}
