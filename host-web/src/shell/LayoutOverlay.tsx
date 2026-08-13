import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { hostOps, overlaySourcePaneId, panes } from "../dockview/store";
import type { OverlaySplitDir } from "../dockview/types";
import s from "./LayoutOverlay.module.css";

/**
 * Layout overlay — the host-side UI for the revised interaction model. Anchored
 * to the source pane's bounds (the pane derived from the gesture's event.source,
 * or the focused pane the host selects). Shows four cardinal arrows whose effect
 * depends on the selected MODE:
 *
 *  - Split mode (default): an arrow SPLITS the source pane — creates a NEW pane
 *    in that direction (HostOps.overlaySplit; renderer:'always' keeps the source
 *    iframe mounted). The new pane becomes active. This is the Slice-1 behavior.
 *  - Swap mode: an arrow EXCHANGES the source pane with its nearest neighbor in
 *    that direction (HostOps.overlaySwap). Survival-safe live-tree moveTo ops
 *    only — both iframes stay mounted (mountTs/nonce/connId unchanged; proven by
 *    the Slice-2 characterization). Bounded to ordinary tiled single-panel grid
 *    groups; an arrow with no swappable neighbor is DISABLED (visual +
 *    aria-disabled), never a silent no-op. Dockview re-proportions pane sizes on
 *    dock+split, so RELATIVE ORDER flips but absolute pixel geometry is not
 *    preserved — that is the intended "swap with neighbor" semantic.
 *
 * Plus a Close-pane button (HostOps.closePane → Dockview removePanel; disposes
 * the SOURCE iframe, which is the operator's explicit intent for "close" — NOT a
 * survival violation; survival matters for the SURVIVING panes).
 *
 * LAYERING (Gate #2): the pointer-capture layer covers ONLY `<main>` (the pane
 * grid area). The tabstrip + tray rail are SIBLINGS of `<main>` in the `.app`
 * flex column, so they are NEVER intercepted — P3 NEXT (now in the tabstrip,
 * moved from the deleted statusbar) and Add Server stay clickable while the
 * overlay is open. There is no full-screen capture layer.
 *
 * DISMISS: Esc, the Close-overlay button (✕, distinct from Close-pane), an
 * outside-the-card click within `<main>`, a workspace switch (App.tsx clears the
 * signal), or source-pane removal (the effect below). A split/swap is a terminal
 * overlay action (auto-closes). IDEMPOTENT: a second valid request while open
 * re-anchors to the new source (the signal swaps; no stacking). The mode resets
 * to Split whenever the overlay (re)opens, so a stale Swap selection never
 * carries across open/close cycles.
 *
 * GPU-CHEAP: plain divs + a bounded 2px-blur shadow; NO mask-image /
 * backdrop-filter / contain:paint (AGENTS.md Firefox/WebRender rules).
 *
 * @param mainEl accessor for the `<main>` element (positioning context). The
 *   overlay is rendered as a child of `<main>` so inset:0 scopes to it.
 */

const ARROWS: ReadonlyArray<{
  dir: OverlaySplitDir;
  sym: string;
  cls: string;
  word: string;
}> = [
  { dir: "above", sym: "↑", cls: s.arrowUp, word: "above" },
  { dir: "left", sym: "←", cls: s.arrowLeft, word: "left" },
  { dir: "right", sym: "→", cls: s.arrowRight, word: "right" },
  { dir: "below", sym: "↓", cls: s.arrowDown, word: "below" },
];

export function LayoutOverlay(props: { mainEl: () => HTMLElement | null }) {
  const source = () => overlaySourcePaneId();
  const sourceVm = () => {
    const id = source();
    return id ? panes().find((p) => p.id === id) : undefined;
  };
  // Split (default) vs Swap mode for the cardinal arrows. Reset to Split on
  // every (re)open so a stale Swap selection never survives a close/reopen.
  const [mode, setMode] = createSignal<"split" | "swap">("split");
  createEffect(() => {
    const id = source();
    if (id === null) setMode("split");
  });

  // Swap-mode arrow targets: a 4-entry dir→neighbor-id map, or null per dir when
  // there is no swappable neighbor in that direction. Computed live so a layout
  // change re-evaluates enabled arrows; tracks panes() for reactivity. Only
  // queried in Swap mode (Split mode always enables all four arrows).
  const swapTargets = createMemo((): Record<OverlaySplitDir, string | null> => {
    const id = source();
    void panes(); // track layout changes while the overlay is open
    if (mode() !== "swap" || id === null) {
      return { above: null, right: null, below: null, left: null };
    }
    return (
      hostOps()?.overlaySwapTargets?.(id) ?? {
        above: null,
        right: null,
        below: null,
        left: null,
      }
    );
  });

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
  const swap = (dir: OverlaySplitDir): void => {
    const id = source();
    if (id) hostOps()?.overlaySwap?.(id, dir);
  };
  // Close-pane: disposes the SOURCE iframe (the operator's explicit intent for
  // "close"). The source-removed effect above dismisses the overlay; close()
  // here dismisses immediately so the operator sees no stale anchor flash.
  const closePane = (): void => {
    const id = source();
    if (id) hostOps()?.closePane?.(id);
    close();
  };

  const onArrow = (dir: OverlaySplitDir): void => {
    if (mode() === "swap") swap(dir);
    else split(dir);
  };
  const arrowDisabled = (dir: OverlaySplitDir): boolean =>
    mode() === "swap" && swapTargets()[dir] === null;
  const arrowVerb = (): string => (mode() === "swap" ? "Swap" : "Split");

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
            <For each={ARROWS}>
              {(a) => {
                // Read the signals INSIDE the JSX attributes (not in a local
                // const) so SolidJS tracks them and the label/disabled state
                // updates when mode() / swapTargets() change.
                const disabled = (): boolean => arrowDisabled(a.dir);
                return (
                  <button
                    type="button"
                    class={`${s.arrow} ${a.cls}`}
                    data-testid={`layout-overlay-${a.dir}`}
                    data-mode={mode()}
                    aria-disabled={disabled() ? "true" : undefined}
                    disabled={disabled()}
                    aria-label={`${arrowVerb()} ${a.word}`}
                    title={
                      disabled()
                        ? `No swappable pane ${a.word}`
                        : `${arrowVerb()} ${a.word}`
                    }
                    onClick={() => onArrow(a.dir)}
                  >
                    {a.sym}
                  </button>
                );
              }}
            </For>
          </div>
          {/* Split / Swap mode toggle. In Swap mode the arrows exchange the
              source with its neighbor instead of creating a new pane. */}
          <div class={s.modeRow} role="group" aria-label="Arrow mode">
            <button
              type="button"
              class={`${s.modeBtn} ${mode() === "split" ? s.modeBtnActive : ""}`}
              data-testid="layout-overlay-mode-split"
              aria-pressed={mode() === "split"}
              onClick={() => setMode("split")}
            >
              Split
            </button>
            <button
              type="button"
              class={`${s.modeBtn} ${mode() === "swap" ? s.modeBtnActive : ""}`}
              data-testid="layout-overlay-mode-swap"
              aria-pressed={mode() === "swap"}
              onClick={() => setMode("swap")}
            >
              Swap
            </button>
          </div>
          <div class={s.actionRow}>
            <button
              type="button"
              class={s.closePaneBtn}
              data-testid="layout-overlay-close-pane"
              aria-label="Close this pane"
              title="Close this pane"
              onClick={() => closePane()}
            >
              Close pane
            </button>
          </div>
          <div class={s.hint}>
            {mode() === "swap"
              ? "tap an arrow to swap with the neighbor · Esc / outside-click to close"
              : "tap an arrow to split · Esc / outside-click to close"}
          </div>
        </div>
      </div>
    </Show>
  );
}
