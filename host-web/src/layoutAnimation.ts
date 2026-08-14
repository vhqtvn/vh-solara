import type { DockviewApi } from "dockview-core";

/**
 * FLIP animation for Dockview pane layout transitions.
 *
 * REPLACES the laggy `transition: left/top/width/height` approach that used to
 * live in dockviewOverrides.css. That approach animated LAYOUT properties, which
 * triggers a browser layout pass on EVERY animation frame. The operator's
 * measured diagnosis: a discrete layout op (split/swap/orientation-flip) read as
 * a multi-phase janky effect — the root resized first, then panes translated
 * (lagging), then panes scaled — because each animated property reflows
 * independently and the browser interleaves the reflow bursts Dockview emits.
 *
 * FLIP (First-Last-Invert-Play) animates the transition with a SINGLE
 * GPU-composited `transform` per pane. `transform` (like `opacity`) is composited
 * on the GPU and does NOT trigger layout, so the whole move+resize runs as one
 * smooth combined motion with zero per-frame layout cost.
 *
 * Technique (per pane element, the `.dv-render-overlay` Dockview positions):
 *   1. FIRST  — the pane's pre-change rect is stored in `lastRects`.
 *   2. LAST   — `onDidLayoutChange` fires after Dockview wrote the new inline
 *               left/top/width/height; read the new rect.
 *   3. INVERT — apply `translate(dx,dy) scale(sx,sy)` (transform-origin: 0 0,
 *               set in dockviewOverrides.css) so the pane APPEARS to still be at
 *               its old rect, then force ONE reflow to commit that state.
 *   4. PLAY   — set `transition: transform <dur> ease-out` + `transform: ""`
 *               (identity); the pane animates from the inverted (old) state to
 *               its natural (new) state via a single composited transform.
 *
 * TARGET ELEMENT: `.dv-render-overlay` (OverlayRenderContainer's positioned child
 * for renderer:'always' panels) — the SAME element the old CSS transition
 * targeted, and the ANCESTOR of each pane's `<iframe>` (never the iframe itself;
 * see AGENTS.md GPU rules). Each overlay holds one `.pane[data-pane-id]`.
 *
 * GPU SAFETY (AGENTS.md Firefox/WebRender rules): `transform` + `opacity` are
 * the only composited properties and are ALLOWED. This module uses `transform`
 * only. It does NOT touch mask-image / backdrop-filter / contain:paint (BANNED).
 *
 * SKIP CASES (no animation, just record the baseline):
 *   - CONTINUOUS geometry drags (sash resize / floating drag): the drag itself is
 *     the motion; FLIP-ing its bursts would be wrong. Detected via the
 *     `.dv-geometry-dragging` class DockviewHost toggles on the container. The
 *     baseline is refreshed once on drag-end (pointerup) so the next DISCRETE op
 *     animates from the post-drag position (see `onDragEnd`).
 *   - prefers-reduced-motion: an abrupt jump is the reduced-motion-correct
 *     behavior; no animation is synthesized.
 *   - New panels (first appearance): no stored FIRST rect → no animation.
 *   - Trivial moves (< 1px) / zero-size (trayed/off-screen) overlays.
 *
 * MULTI-STEP OPS: Dockview emits several `onDidLayoutChange` bursts during one
 * user op (a swap writes an intermediate state then the final redistribution; an
 * orientation flip writes a retarget burst then the transposed layout ~200ms
 * later). Each burst is handled as its own FLIP from the previous baseline, so a
 * multi-step op reads as one continuous motion (the in-flight transform is
 * cancelled + restarted from the last SETTLED rect on each burst — never from a
 * mid-animation position, because the rect read clears any in-flight transform
 * first).
 *
 * TUNABLE: FLIP_DURATION_MS is the on-device dial-in default. Larger (~0.2s)
 * reads smoother; smaller (~0.1s) is snappier. ease-out keeps the start fast so
 * the pane feels responsive.
 */
export function installFlipAnimation(
  api: DockviewApi,
  container: HTMLElement,
): () => void {
  // TUNABLE on-device: the FLIP play duration.
  const FLIP_DURATION_MS = 150;
  const FLIP_TIMING = "ease-out";
  // Skip moves smaller than this (sub-pixel jitter / no-op layout changes).
  const MIN_DELTA_PX = 1;
  // Slack over FLIP_DURATION_MS for the transitionend-missed fallback clear.
  const FALLBACK_SLACK_MS = 60;
  // Relative scale change below which we treat the size as unchanged.
  const MIN_SCALE_DELTA = 0.01;

  interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
  }

  // LAST/FIRST baseline: each panel id → its last SETTLED (natural) rect.
  const lastRects = new Map<string, Rect>();
  // Overlays with an in-flight FLIP transition (cleared on transitionend /
  // fallback / next cycle). Used so uninstall + the fallback can clean up.
  const inFlight = new Set<HTMLElement>();
  // True while a continuous geometry drag is in progress (class present). The
  // baseline is refreshed once when it ends.
  let draggingActive = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  const prefersReducedMotion = (): boolean =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Enumerate the current panels' positioned overlay elements.
   *  One `.dv-render-overlay` per renderer:'always' panel; the panel id is read
   *  from its `.pane[data-pane-id]` child (set by IframeRenderer). Only overlays
   *  whose pane id is still a live panel are returned (stale/trayed overlays
   *  whose panel was disposed are dropped). */
  function currentOverlays(): Map<string, HTMLElement> {
    const out = new Map<string, HTMLElement>();
    const live = new Set<string>();
    for (const p of api.panels) live.add(p.id);
    const overlays =
      container.querySelectorAll<HTMLElement>(".dv-render-overlay");
    for (const el of overlays) {
      const pane = el.querySelector<HTMLElement>(".pane[data-pane-id]");
      const id = pane?.dataset.paneId;
      if (id && live.has(id)) out.set(id, el);
    }
    return out;
  }

  /** Read the natural (untransformed) rects of all current overlays after
   *  cancelling any in-flight FLIP. Temporarily sets `transition: none` +
   *  `transform: ""` on every overlay, forces ONE reflow (so a partial transform
   *  never pollutes the read), reads all rects, then RESTORES transition to ""
   *  (transform is already "" and committed, so there is nothing left to animate
   *  and no residual `transition: none` lingers on non-animating panes). Returns
   *  panel id → natural rect. */
  function readNaturalRects(overlays: Map<string, HTMLElement>): Map<string, Rect> {
    inFlight.clear();
    for (const [, el] of overlays) {
      el.style.transition = "none";
      el.style.transform = "";
    }
    // Single reflow commits the cleared transforms so getBoundingClientRect is
    // not affected by a still-active inverted transform from a prior FLIP.
    void container.offsetWidth;
    const rects = new Map<string, Rect>();
    for (const [id, el] of overlays) {
      const r = el.getBoundingClientRect();
      rects.set(id, { left: r.left, top: r.top, width: r.width, height: r.height });
    }
    // Restore transition: transform is "" and committed above, so clearing the
    // transient `transition: none` cannot trigger an animation (no pending
    // property change). This keeps non-animating overlays' inline styles clean.
    for (const [, el] of overlays) {
      el.style.transition = "";
    }
    return rects;
  }

  function clearStyles(el: HTMLElement): void {
    el.style.transition = "";
    el.style.transform = "";
  }

  /** Refresh the baseline (FIRST rects) without animating. Used at install time,
   *  under prefers-reduced-motion, and once on drag-end so the next discrete op
   *  animates from the post-drag position. */
  function refreshBaseline(): void {
    const overlays = currentOverlays();
    const rects = readNaturalRects(overlays);
    inFlight.clear();
    lastRects.clear();
    for (const [id, r] of rects) lastRects.set(id, r);
  }

  /** Fallback clear: a transitionend can be missed (element hidden mid-anim,
   *  tab backgrounded). Guarantee no residual transform lingers past the play
   *  duration + slack. Each animating cycle reschedules this. */
  function scheduleFallback(): void {
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      fallbackTimer = undefined;
      for (const el of inFlight) clearStyles(el);
      inFlight.clear();
    }, FLIP_DURATION_MS + FALLBACK_SLACK_MS);
  }

  function onLayoutChange(): void {
    // CONTINUOUS drag: skip entirely (no reflow per pointermove frame). Flag so
    // the drag-end pointerup refreshes the baseline once.
    if (container.classList.contains("dv-geometry-dragging")) {
      draggingActive = true;
      return;
    }
    // Reduced motion: jump is correct; just keep the baseline current.
    if (prefersReducedMotion()) {
      refreshBaseline();
      return;
    }

    const overlays = currentOverlays();
    if (overlays.size === 0) return;

    // FIRST read: natural rects (in-flight FLIPs cancelled + cleared above).
    const newRects = readNaturalRects(overlays);
    const seen = new Set<string>(newRects.keys());

    // INVERT: for each pane that moved/resized vs its LAST settled rect, apply
    // the inverse transform so it appears at its old rect.
    const toPlay: HTMLElement[] = [];
    for (const [id, el] of overlays) {
      const oldRect = lastRects.get(id);
      const newRect = newRects.get(id);
      if (!oldRect || !newRect) continue;
      // Skip zero-size (trayed / off-screen / not-yet-laid-out) overlays.
      if (
        oldRect.width <= 0 ||
        oldRect.height <= 0 ||
        newRect.width <= 0 ||
        newRect.height <= 0
      ) {
        continue;
      }
      const dx = oldRect.left - newRect.left;
      const dy = oldRect.top - newRect.top;
      const sx = oldRect.width / newRect.width;
      const sy = oldRect.height / newRect.height;
      const moved = Math.abs(dx) >= MIN_DELTA_PX || Math.abs(dy) >= MIN_DELTA_PX;
      const scaled =
        Math.abs(sx - 1) >= MIN_SCALE_DELTA || Math.abs(sy - 1) >= MIN_SCALE_DELTA;
      if (moved || scaled) {
        // transform-origin: 0 0 (set in dockviewOverrides.css) makes this exact:
        // top-left → (oldLeft, oldTop), size → (oldW, oldH).
        el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
        toPlay.push(el);
      }
    }

    if (toPlay.length > 0) {
      // ONE reflow commits all inverted transforms as the current value, so the
      // transition in PLAY runs FROM the inverted state.
      void container.offsetWidth;
      // PLAY: animate each to identity (natural new rect) via one composited
      // transform. The transition + transform="" are set in the same frame.
      for (const el of toPlay) {
        el.style.transition = `transform ${FLIP_DURATION_MS}ms ${FLIP_TIMING}`;
        el.style.transform = "";
        inFlight.add(el);
      }
      scheduleFallback();
    }

    // Record the new natural rects as the next FIRST baseline.
    for (const [id, r] of newRects) lastRects.set(id, r);
    for (const id of [...lastRects.keys()]) if (!seen.has(id)) lastRects.delete(id);
  }

  // transitionend (bubbles from .dv-render-overlay to container): clear the
  // inline transition + transform the moment the FLIP completes so no residual
  // transform remains on the pane. Only the FLIP's own transform transition is
  // cleared (propertyName filter + inFlight membership guard).
  function onTransitionEnd(ev: TransitionEvent): void {
    if (ev.propertyName !== "transform") return;
    const el = ev.target;
    if (!(el instanceof HTMLElement)) return;
    if (!inFlight.has(el)) return;
    clearStyles(el);
    inFlight.delete(el);
  }

  // Drag-end: a continuous geometry drag just released. Refresh the baseline so
  // the next DISCRETE op animates from the post-drag position (without this, the
  // baseline would still hold the pre-drag rects and the next op's FLIP would
  // fly the panes in from their old pre-drag spots). Window-capture so it fires
  // before Dockview's own drag-release flush.
  function onDragEnd(): void {
    if (!draggingActive) return;
    draggingActive = false;
    refreshBaseline();
  }

  container.addEventListener("transitionend", onTransitionEnd);
  window.addEventListener("pointerup", onDragEnd, true);
  window.addEventListener("pointercancel", onDragEnd, true);

  const layoutDisp = api.onDidLayoutChange(onLayoutChange);

  // Seed the baseline so the FIRST user-driven layout change has a valid FIRST.
  refreshBaseline();

  return () => {
    layoutDisp.dispose();
    container.removeEventListener("transitionend", onTransitionEnd);
    window.removeEventListener("pointerup", onDragEnd, true);
    window.removeEventListener("pointercancel", onDragEnd, true);
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    for (const el of inFlight) clearStyles(el);
    inFlight.clear();
    lastRects.clear();
  };
}
