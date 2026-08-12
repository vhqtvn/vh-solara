import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { hostOps, overlaySourcePaneId, panes } from "../dockview/store";
import type { OverlaySplitDir } from "../dockview/types";
import s from "./LayoutOverlay.module.css";

/**
 * Layout overlay — the host-side UI for the revised interaction model. Anchored
 * to the source pane's bounds (the pane derived from the gesture's event.source,
 * or the focused pane the host selects). Shows four cardinal split arrows + the
 * source identity + Close.
 *
 * LAYERING (Gate #2): the pointer-capture layer covers ONLY `<main>` (the pane
 * grid area). The tabstrip + tray rail are SIBLINGS of `<main>` in the `.app`
 * flex column, so they are NEVER intercepted — P3 NEXT (now in the tabstrip,
 * moved from the deleted statusbar) and Add Server stay clickable while the
 * overlay is open. There is no full-screen capture layer. (The statusbar that
 * used to also be a clickable sibling was removed in its entirety; the Layout
 * button that opened this overlay from the statusbar is gone — the overlay is
 * gesture-triggered + DEV-bridge-triggered now.)
 *
 * DISMISS: Esc, the Close button, an outside-the-card click within `<main>`, a
 * workspace switch (App.tsx clears the signal), or source-pane removal (the
 * effect below). A split action auto-closes (HostOps.overlaySplit closes after
 * the split). IDEMPOTENT: a second valid request while open re-anchors to the
 * new source (the signal swaps; no stacking).
 *
 * GPU-CHEAP: plain divs + a bounded 2px-blur shadow; NO mask-image /
 * backdrop-filter / contain:paint (AGENTS.md Firefox/WebRender rules).
 *
 * @param mainEl accessor for the `<main>` element (positioning context). The
 *   overlay is rendered as a child of `<main>` so inset:0 scopes to it.
 */
export function LayoutOverlay(props: { mainEl: () => HTMLElement | null }) {
  const source = () => overlaySourcePaneId();
  const sourceVm = () => {
    const id = source();
    return id ? panes().find((p) => p.id === id) : undefined;
  };

  // Toggle the `.is-overlay-source` focus badge on the source pane element
  // imperatively (the renderer is vanilla DOM, not SolidJS, so it cannot react
  // to the signal itself). Swaps the class when the source changes; clears it
  // on close. The badge ("ACTIVE · <label>") is hidden by default (pane.css).
  let prevBadgeId: string | null = null;
  const paneElFor = (id: string): Element | null =>
    document.querySelector(`[data-pane-id="${id}"]`);
  createEffect(() => {
    const id = source();
    if (prevBadgeId !== null && prevBadgeId !== id) {
      paneElFor(prevBadgeId)?.classList.remove("is-overlay-source");
    }
    if (id !== null) {
      paneElFor(id)?.classList.add("is-overlay-source");
    }
    prevBadgeId = id;
  });
  // Clear the badge class on unmount so a hot-reload never leaves it stuck.
  onCleanup(() => {
    if (prevBadgeId !== null) {
      paneElFor(prevBadgeId)?.classList.remove("is-overlay-source");
      prevBadgeId = null;
    }
  });

  // Dismiss when the source pane is removed (closePane / closeWorkspace). Tracks
  // panes() so a remove fires this while the overlay is open.
  createEffect(() => {
    const id = source();
    if (id === null) return;
    const stillPresent = panes().some((p) => p.id === id);
    if (!stillPresent) hostOps()?.closeLayoutOverlay?.();
  });

  // Esc → close (only while open).
  onMount(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape" && source() !== null) {
        hostOps()?.closeLayoutOverlay?.();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Position the card over the source pane's box, recomputed on open + on
  // resize. The card is centered over the source pane + clamped within <main>.
  let cardEl: HTMLDivElement | undefined;
  const [resizeTick, setResizeTick] = createSignal(0);
  onMount(() => {
    const onResize = (): void => {
      setResizeTick((t) => t + 1);
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });
  createEffect(() => {
    const id = source();
    void resizeTick(); // recompute on resize while open
    if (id === null || !cardEl) return;
    const main = props.mainEl();
    const paneEl = id ? paneElFor(id) : null;
    if (!main || !paneEl) return;
    const mainRect = main.getBoundingClientRect();
    const paneRect = paneEl.getBoundingClientRect();
    const cardW = cardEl.offsetWidth;
    const cardH = cardEl.offsetHeight;
    let left = paneRect.left - mainRect.left + (paneRect.width - cardW) / 2;
    let top = paneRect.top - mainRect.top + (paneRect.height - cardH) / 2;
    // Clamp within <main> (keep the whole card visible).
    left = Math.max(8, Math.min(left, mainRect.width - cardW - 8));
    top = Math.max(8, Math.min(top, mainRect.height - cardH - 8));
    cardEl.style.left = `${Math.round(left)}px`;
    cardEl.style.top = `${Math.round(top)}px`;
  });

  const close = (): void => {
    hostOps()?.closeLayoutOverlay?.();
  };
  const split = (dir: OverlaySplitDir): void => {
    const id = source();
    if (id) hostOps()?.overlaySplit?.(id, dir);
  };

  return (
    <Show when={source() !== null} keyed>
      <div class={s.overlay}>
        {/* Scoped capture layer: inset:0 within <main> only. A click here (an
            outside-the-card click in the pane grid) dismisses the overlay. */}
        <div
          class={s.capture}
          data-testid="layout-overlay-capture"
          onClick={() => close()}
        />
        <div
          class={s.card}
          ref={cardEl}
          data-testid="layout-overlay-card"
          // Stop propagation so a click on the card does not bubble to capture.
          onClick={(e) => e.stopPropagation()}
        >
          <div class={s.identity}>
            <span class={s.identityLabel}>Layout:</span>
            <span class={s.identityTarget}>{sourceVm()?.label ?? "pane"}</span>
            <button
              type="button"
              class={s.closeBtn}
              data-testid="layout-overlay-close"
              title="Close overlay (Esc)"
              onClick={() => close()}
            >
              ✕
            </button>
          </div>
          <div class={s.arrows}>
            <button
              type="button"
              class={`${s.arrow} ${s.arrowUp}`}
              data-testid="layout-overlay-above"
              aria-label="Split above"
              title="Split above"
              onClick={() => split("above")}
            >
              ↑
            </button>
            <button
              type="button"
              class={`${s.arrow} ${s.arrowLeft}`}
              data-testid="layout-overlay-left"
              aria-label="Split left"
              title="Split left"
              onClick={() => split("left")}
            >
              ←
            </button>
            <button
              type="button"
              class={`${s.arrow} ${s.arrowRight}`}
              data-testid="layout-overlay-right"
              aria-label="Split right"
              title="Split right"
              onClick={() => split("right")}
            >
              →
            </button>
            <button
              type="button"
              class={`${s.arrow} ${s.arrowDown}`}
              data-testid="layout-overlay-below"
              aria-label="Split below"
              title="Split below"
              onClick={() => split("below")}
            >
              ↓
            </button>
          </div>
          <div class={s.hint}>tap an arrow to split · Esc / outside-click to close</div>
        </div>
      </div>
    </Show>
  );
}
