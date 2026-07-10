import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { hoverCapable, inspectAt, placeTooltip, type Rectish } from "../tooltip";
import styles from "./Tooltip.module.css";

// DOM-based tooltip (mounted once at the app root). We avoid the native `title`
// attribute because some window managers (e.g. swaywm) spawn a new window for
// it; elements opt in with `data-tip="…"`. Delegated hover/focus, fixed-position
// bubble clamped to the viewport.
// Hover delay: tooltips don't appear instantly — the pointer must rest on a
// tipped element for this long before the bubble shows (like a native tooltip).
const HOVER_DELAY_MS = 450;

export default function Tooltip() {
  const [tip, setTip] = createSignal<{ text: string; rect: Rectish } | null>(null);
  const [pos, setPos] = createSignal<{ x: number; y: number; above: boolean } | null>(null);
  let current: HTMLElement | null = null;
  let bubble: HTMLDivElement | undefined;
  // Pending hover-delay timer. When armed, a tipped element has been entered but
  // the bubble hasn't shown yet; on fire we re-check that the element is still
  // actually hovered/focused (pointerout can be missed) before showing.
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const clearHoverTimer = () => {
    if (hoverTimer !== undefined) {
      clearTimeout(hoverTimer);
      hoverTimer = undefined;
    }
  };

  function show(target: HTMLElement) {
    const text = target.getAttribute("data-tip");
    if (!text) return;
    const r = target.getBoundingClientRect();
    setTip({ text, rect: { left: r.left, top: r.top, bottom: r.bottom, width: r.width } });
  }
  const hide = () => {
    clearHoverTimer();
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

  // Arm the hover-delay timer for `target`, replacing any pending arm. On fire
  // we defensively re-check that the element is still genuinely interacted with
  // before showing — BOTH paths re-verify at fire time, symmetrically: the
  // pointer path trusts the browser's own `:hover` tracking (more reliable than
  // our event chain — if a `pointerout` was missed, `:hover` is already false
  // and we drop the stale target); the focus path re-checks
  // `document.activeElement` rather than trusting the closed-over `fromFocus`
  // flag (a missed focusout could leave that flag stale — activeElement is the
  // ground truth, symmetric to the pointer path's :hover). `:hover` is false
  // under keyboard focus, so the focus path cannot reuse the pointer check.
  const armShow = (target: HTMLElement, fromFocus: boolean) => {
    clearHoverTimer();
    // We are arming a show for a DIFFERENT target (both call sites guard
    // `!== current`), so drop any stale bubble now instead of leaving the
    // previous tip visible over the new target for the whole delay. On a
    // first-enter this is a no-op (nothing was shown yet).
    setTip(null);
    current = target;
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined;
      if (!current) {
        hide();
        return;
      }
      const stillInteracted = fromFocus
        ? current === document.activeElement ||
          // Element.contains(null) returns false per spec — safe cast.
          current.contains(document.activeElement as Node | null)
        : current.matches(":hover");
      if (stillInteracted) show(current);
      else hide();
    }, HOVER_DELAY_MS);
  };
  const enter = (t: HTMLElement | null, fromFocus: boolean) => {
    if (!hoverCapable) return; // touch: no auto-tooltips (use the ? inspector)
    if (t && t !== current) armShow(t, fromFocus);
  };
  const onOverPointer = (e: Event) =>
    enter((e.target as HTMLElement)?.closest?.("[data-tip]") as HTMLElement | null, false);
  const onOverFocus = (e: Event) =>
    enter((e.target as HTMLElement)?.closest?.("[data-tip]") as HTMLElement | null, true);

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
      clearHoverTimer(); // inspector path is immediate; cancel any pending hover show
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
        // Switching between tipped elements still respects the delay: re-arm a
        // fresh timer via the shared helper so the new tip doesn't flash
        // instantly. `fromFocus` is derived from the event type — DOM fires
        // focusout before focusin, so when Tabbing tip→tip the follow-up
        // focusin is a no-op (current is already `next`); without threading
        // fromFocus here, the armed timer's `:hover`-only guard would suppress
        // the keyboard-focused tip (`:hover` is false under keyboard focus).
        const fromFocus = (e as Event).type === "focusout" || (e as Event).type === "blur";
        armShow(next, fromFocus);
      }
      return;
    }
    hide();
  };

  onMount(() => {
    document.addEventListener("pointerover", onOverPointer);
    document.addEventListener("pointerout", onOut as EventListener);
    document.addEventListener("focusin", onOverFocus);
    document.addEventListener("focusout", onOut as EventListener);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("pointerdown", hide);
    window.addEventListener("blur", hide);
  });
  onCleanup(() => {
    clearHoverTimer();
    document.removeEventListener("pointerover", onOverPointer);
    document.removeEventListener("pointerout", onOut as EventListener);
    document.removeEventListener("focusin", onOverFocus);
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
