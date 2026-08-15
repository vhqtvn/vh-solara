import type { DockviewApi } from "dockview-core";

/**
 * FLIP layout animation for Dockview pane transitions — DEFERRED-REFLOW
 * (pinned-content) variant.
 *
 * WHY DEFERRED REFLOW: the previous FLIP (dcd6547) animated the
 * `.dv-render-overlay` with `transform: translate() scale()`. The transform
 * was GPU-composited and smooth — but Dockview commits the overlay's new
 * `width/height` IMMEDIATELY, which resizes the cross-origin IFRAME at the
 * jump → the SPA's chat view re-wraps + re-anchors scroll on its main thread
 * MID-ANIMATION → visible "tail lag in chat view". A host-side transform can
 * visually scale the pane, but it cannot hide in-iframe main-thread jank.
 *
 * THE FIX: during the animation keep the pane CONTENT element at its OLD
 * pixel size (PINNED) and let a transform on that child visually scale it
 * into the new rect. The iframe does not resize until the animation ends —
 * the GPU scales the already-rendered OLD bitmap (zero iframe main-thread
 * work); the actual reflow happens ONCE, AFTER the motion settles.
 *
 * WHY THE TRANSFORM MOVED FROM THE OVERLAY TO THE CHILD (the math): with
 * transform-on-OVERLAY, the child's visual size = childLayout × overlayScale.
 * For the child's visual size to equal its OLD size at animation start
 * (overlayScale = oldW/newW), childLayout must equal the NEW size — i.e. the
 * child must have ALREADY reflowed. Contradiction. Deferred reflow therefore
 * requires the transform on the CHILD (the pinned `.pane` element), while the
 * overlay jumps to its new geometry immediately.
 *
 * Sequence per panel (W1,H1 = old size; W2,H2 = new size):
 *   1. PIN    — `.pane` (the panel content root inside the overlay; carries
 *               data-pane-id, contains .pane-body → iframe) gets inline
 *               `width: W1px; height: H1px`. The overlay jumps to W2×H2
 *               (Dockview), the child stays W1×H1 → the iframe box is
 *               UNCHANGED → no reflow, no scroll re-anchor. The pin equals
 *               the size the iframe already has, so writing it is a no-op
 *               for layout — done BEFORE any layout read, the iframe never
 *               lays out at an intermediate size. The pin lands IN THE
 *               onDidLayoutChange MICROTASK ITSELF (before any rAF — see
 *               TIMING GUARANTEE), so no rAF-scheduling/ordering slip can
 *               ever paint the committed overlay geometry with an UN-PINNED
 *               child (the residual single-flash hardening).
 *   2. INVERT — `transform: translate(V.left−new.left, V.top−new.top)
 *               scale(V.w/W1, V.h/H1)` on the pinned child
 *               (transform-origin: 0 0), where V is the child's CURRENT
 *               VISUAL rect (its settled old rect on a fresh op; its
 *               mid-flight interpolated rect on a retarget). The pane
 *               appears exactly where it just was — no visual jump.
 *   3. COMMIT — one forced reflow (offsetWidth) so the inverted state is the
 *               transition's start value.
 *   4. PLAY   — `transition: transform <dur> ease-out` +
 *               `transform: translate(0,0) scale(W2/W1, H2/H1)`. The old-size
 *               content visually moves AND scales into the new rect in one
 *               GPU-composited transform; the iframe bitmap is untouched.
 *   5. SETTLE — on transitionend: remove the pin (width/height) AND the
 *               transform + transition — all four in ONE synchronous block,
 *               so the un-pin and the transform-clear commit in the same
 *               style recalc (never a half-settled paint). The child refills
 *               the overlay at W2×H2 → the iframe resizes NOW → ONE reflow +
 *               scroll-anchor AFTER the motion. There is a one-frame content
 *               settle (old-wrapping-scaled → new-wrapping; engines may
 *               paint a BLANK frame inside the resizing iframe before the
 *               embedded document repaints — pane.css paints the whole pane
 *               chain dark so any blank frame is dark-on-dark) — accepted
 *               tradeoff.
 *
 * TIMING GUARANTEE (what makes the pin work): Dockview writes each overlay's
 * inline left/top/width/height from `requestAnimationFrame` callbacks
 * (OverlayRenderContainer.attach → resize()), and buffers
 * `onDidLayoutChange` through an AsapEvent (a queueMicrotask callback). A
 * microtask handler would read PRE-commit geometry. This module therefore
 * does TWO things in that microtask:
 *   1. EARLY PIN — synchronously pin every known pane at its CURRENT size
 *      (the last recorded rect, = the size the iframe already renders at).
 *      At microtask time no new geometry has been committed, so the pin is a
 *      VISUAL NO-OP (the child already fills that size) — yet it guarantees
 *      the iframe can never lay out at the NEW size before the handler's
 *      pin, regardless of rAF scheduling/registration order across engines
 *      (if our handler rAF ever ran BEFORE dockview's geometry rAFs, or a
 *      frame painted between them, the child is already pinned — the one
 *      un-pinned-flash window is closed).
 *   2. defer the real handling to a rAF queued AFTER the event: dockview's
 *      geometry rAFs for the op were queued first (synchronously inside the
 *      op) and run earlier in the same frame, so the handler reads COMMITTED
 *      geometry while still writing styles before the frame's style/layout/
 *      paint. The same choreography re-seeds the install-time baseline one
 *      frame after mount (a synchronous read would capture the un-positioned
 *      overlays, which fill the whole container).
 *
 * STABILITY CHOREOGRAPHY (hold-until-stable): a single user op can commit
 * SEVERAL geometry states across several frames — a swap docks a panel into
 * a neighbor's group (a TRANSIENT rect that can be far off-window — observed
 * x≈1920px on a 1280px viewport) before the final redistribution lands, and
 * dockview rAF-chains mean the final rect can commit 2-3 frames after the
 * last layout event. Animating toward a transient would dart the pane out
 * and back. So the handler runs on EVERY frame while a morph is pending
 * (the "chase") and per pane:
 *   - target unchanged & mid-flight  → leave the running transition alone;
 *   - rect CHANGED vs the previous frame → CANCEL + re-INVERT from the
 *     current visual rect and HOLD (transition: none — frozen at the old
 *     visual, zero perceptible motion);
 *   - rect STABLE two consecutive frames AND displaced from the visual rect
 *     → COMMIT the invert + PLAY to the stable rect;
 *   - already in place → clear any stray pin.
 * The visible effect: the pane rests at its OLD visual position for ~1-2
 * frames (imperceptible), then performs ONE smooth morph to the final rect —
 * transients are never chased. Mid-flight retargets restart from the CURRENT
 * visual rect (continuous position, no snap-back).
 *
 * TARGET ELEMENT: the `.pane[data-pane-id]` CHILD of each `.dv-render-overlay`
 * (never the `<iframe>` itself — see AGENTS.md GPU rules; an ancestor
 * wrapper transform is also fine, but a DESCENDANT wrapper is what defers
 * the reflow). The overlay itself is never touched by the FLIP.
 *
 * CSS DEPENDENCIES (dockviewOverrides.css):
 *   - `.dv-render-overlay { contain: layout; }` — upstream dockview-core pins
 *     `contain: layout paint`; `paint` CLIPS descendants to the overlay
 *     bounds, which would cut off the pinned old-size child during a shrink
 *     morph (it deliberately extends outside the overlay until settle). The
 *     override drops `paint`, keeps `layout` isolation. (AGENTS.md WebRender
 *     guidance: contain:paint on large surfaces HURT GPU perf anyway.)
 *   - `.dv-render-overlay > .pane { transform-origin: 0 0; }` — required so
 *     the INVERT/PLAY math lands exactly on the old/new rects (the overlay's
 *     own `transform-origin: 0 0` rule does NOT apply to the child).
 *
 * GPU SAFETY (AGENTS.md Firefox/WebRender rules): `transform` + `opacity`
 * are the only composited properties used (transform only). No mask-image /
 * backdrop-filter / contain:paint (BANNED). Width/height are written BEFORE
 * the play and cleared AFTER the transition — never animated.
 *
 * SKIP CASES (no animation, just record the baseline):
 *   - CONTINUOUS geometry drags (sash resize / floating drag): detected via
 *     the `.dv-geometry-dragging` class DockviewHost toggles on the container.
 *     Baseline refreshed once on drag-end (pointerup) so the next DISCRETE op
 *     animates from the post-drag position.
 *   - prefers-reduced-motion: abrupt jump; no animation, no pin.
 *   - New panels (first appearance): no recorded rect → no animation.
 *   - Trivial moves (< 1px) / zero-size (trayed/off-screen) overlays.
 *
 * BASELINE-FRESHNESS (viewport resizes — the "random weird animation" fix):
 *   Dockview commits container-driven overlay resizes (window resize, mobile
 *   URL-bar collapse/expand, keyboard root-shrink) WITHOUT firing
 *   onDidLayoutChange — the gridview MODEL does not change, only pixel
 *   geometry. `lastRects` (updated only inside the handler) would go STALE;
 *   the next layout EVENT would then early-pin panes at the pre-resize size
 *   (pane child AND iframe visibly resize UP — a real iframe reflow — then
 *   morph back down). Note that layout events fire for far more than
 *   geometry: upstream BaseGrid wires Event.any(onDidAdd, onDidRemove,
 *   onDidActiveChange) into the buffered onDidLayoutChange, so a mere
 *   CROSS-GROUP panel activation (any tap that focuses a pane, a route
 *   change) is enough to detonate a stale baseline. A ResizeObserver on the
 *   container therefore marks the baseline suspect (`resizeDirty`) and
 *   re-seeds it after dockview's overlay-rewrite rAFs have committed
 *   (2 chained rAFs — dockview's RO fires first, its geometry rAFs land on
 *   the next frame). While dirty: the microtask takes NO early pin, and the
 *   handler re-seeds + returns — never animate off a suspect baseline.
 *   Hard-cancelling a mid-flight op on resize is accepted: a system-driven
 *   viewport change is abrupt by nature (jump, no morph).
 *
 * REMOVED-PANEL GHOSTS: a panel closed mid-flight is absent from
 *   currentPanes() (overlay already detached/disposed), so no per-pane path
 *   settles it — it would ride inFlight/held until the ~210ms fallback and
 *   keep the chase loop reading rects for a dead pane every frame. The
 *   handler settles any pinned/inverted/playing pane whose panel is gone the
 *   moment it first misses the enumeration.
 *
 * TUNABLE: FLIP_DURATION_MS is the on-device dial-in default. Larger (~0.2s)
 * reads smoother; smaller (~0.1s) is snappier. ease-out keeps the start fast
 * so the pane feels responsive.
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
  // Hard cap on the hold-until-stable chase (frames). A pathological
  // geometry thrash degenerates into "no animation" rather than an endless
  // chase; the fallback timer clears held styles well before this anyway.
  const MAX_CHASE_FRAMES = 24;

  interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
  }
  /** One panel's positioned pair: the overlay Dockview sizes + our content
   *  root inside it (carries data-pane-id; contains .pane-body → iframe). */
  interface PanePair {
    overlay: HTMLElement;
    pane: HTMLElement;
  }

  // Natural (overlay) rect each panel showed on the PREVIOUS handled frame.
  // Doubles as the "panel is known" marker (new panels animate nothing on
  // their first recorded frame) and drives removed-panel cleanup.
  const lastRects = new Map<string, Rect>();
  // In-flight content pins: pane element → the pixel size its content bitmap
  // currently renders at. Active from PIN until SETTLE (survives the whole
  // hold-until-stable chase — the iframe never reflows mid-sequence).
  const pins = new Map<HTMLElement, { w: number; h: number }>();
  // Pane elements with an in-flight FLIP transition (cleared on
  // transitionend / fallback).
  const inFlight = new Set<HTMLElement>();
  // Pane elements INVERTED but not yet playing (waiting for geometry to
  // stabilize). Cleared when they play, or by the fallback.
  const held = new Set<HTMLElement>();
  // The natural-coords rect each in-flight pane is animating TOWARD. A new
  // frame whose rect ≈ target means "already flying there — leave alone".
  const targets = new Map<HTMLElement, Rect>();
  // True while a continuous geometry drag is in progress (class present). The
  // baseline is refreshed once when it ends.
  let draggingActive = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  // The pending rAF (event handling, install re-seed, or chase frame).
  let rafHandle: number | undefined;
  // Chase budget: frames remaining of the current hold-until-stable run.
  let chaseFramesLeft = 0;
  // BASELINE-FRESHNESS: the container resized since the last handled frame
  // (dockview commits viewport-driven overlay geometry WITHOUT firing
  // onDidLayoutChange) — lastRects is suspect until re-seeded.
  let resizeDirty = false;
  // Pending rAF handles of the resize re-seed chain (2 chained frames).
  const resizeRafs: number[] = [];

  const prefersReducedMotion = (): boolean =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Enumerate the current panels' positioned elements. One
   *  `.dv-render-overlay` per renderer:'always' panel, whose `.pane[data-
   *  pane-id]` child (set by IframeRenderer) identifies the panel. Only pairs
   *  whose pane id is still a live panel are returned (stale/trayed overlays
   *  whose panel was disposed are dropped). */
  function currentPanes(): Map<string, PanePair> {
    const out = new Map<string, PanePair>();
    const live = new Set<string>();
    for (const p of api.panels) live.add(p.id);
    const overlays =
      container.querySelectorAll<HTMLElement>(".dv-render-overlay");
    for (const overlay of overlays) {
      const pane = overlay.querySelector<HTMLElement>(".pane[data-pane-id]");
      const id = pane?.dataset.paneId;
      if (id && pane && live.has(id)) out.set(id, { overlay, pane });
    }
    return out;
  }

  function readRect(el: HTMLElement): Rect {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  /** Within-threshold equality of two rects (trivial move / stable frame). */
  function rectEq(a: Rect, b: Rect): boolean {
    return (
      Math.abs(a.left - b.left) < MIN_DELTA_PX &&
      Math.abs(a.top - b.top) < MIN_DELTA_PX &&
      Math.abs(a.width - b.width) < MIN_DELTA_PX &&
      Math.abs(a.height - b.height) < MIN_DELTA_PX
    );
  }

  /** SETTLE-clear: remove every inline style the FLIP put on a pane child —
   *  pin (width/height), transform, transition. This is the moment the
   *  deferred reflow fires: the child refills its overlay and the iframe
   *  takes the new size, once, after the motion. All four properties are
   *  cleared in one synchronous task with `transition` also removed, so the
   *  clear itself never animates. */
  function clearPaneStyles(pane: HTMLElement): void {
    pane.style.width = "";
    pane.style.height = "";
    pane.style.transform = "";
    pane.style.transition = "";
  }

  /** Full settle of one pane (transitionend / fallback / in-place path). */
  function settlePane(pane: HTMLElement): void {
    clearPaneStyles(pane);
    inFlight.delete(pane);
    held.delete(pane);
    pins.delete(pane);
    targets.delete(pane);
  }

  /** HARD-cancel any in-flight FLIP state on a pane so a subsequent write
   *  never animates: disable the transition, drop pin + transform. Caller
   *  must force one reflow before re-enabling transitions. */
  function hardCancelPane(pane: HTMLElement): void {
    pane.style.transition = "none";
    pane.style.width = "";
    pane.style.height = "";
    pane.style.transform = "";
    inFlight.delete(pane);
    held.delete(pane);
    pins.delete(pane);
    targets.delete(pane);
  }

  /** REMOVED-PANEL cleanup: settle every tracked pane whose element is NOT in
   *  the live enumeration — its panel was closed/disposed mid-flight, so no
   *  per-pane path will ever settle it (it would ride until the ~210ms
   *  fallback and keep the chase reading rects for a dead pane). */
  function settleGhosts(live: Set<HTMLElement>): void {
    const tracked = [...inFlight, ...held, ...pins.keys()];
    for (const pane of tracked) if (!live.has(pane)) settlePane(pane);
  }

  /** Refresh the baseline (FIRST rects) without animating. Used at install
   *  time, under prefers-reduced-motion, once on drag-end (so the next
   *  discrete op animates from the post-drag position), and after a
   *  container resize (BASELINE-FRESHNESS — dockview commits viewport-driven
   *  overlay geometry without firing onDidLayoutChange). Also hard-cancels
   *  any in-flight pin (a system-driven resize jumps; no morph) and settles
   *  removed-panel ghosts. */
  function refreshBaseline(): void {
    resizeDirty = false;
    chaseFramesLeft = 0;
    const panes = currentPanes();
    const live = new Set<HTMLElement>();
    for (const [, { pane }] of panes) live.add(pane);
    settleGhosts(live);
    for (const [, { pane }] of panes) hardCancelPane(pane);
    // One reflow commits the cancel; then restore transition to "" (there is
    // no pending property change, so nothing animates and no residual
    // `transition: none` lingers).
    void container.offsetWidth;
    for (const [, { pane }] of panes) pane.style.transition = "";
    lastRects.clear();
    for (const [id, { overlay }] of panes) lastRects.set(id, readRect(overlay));
  }

  /** Fallback clear: a transitionend can be missed (element hidden mid-anim,
   *  tab backgrounded) and a held pane's geometry may never stabilize.
   *  Guarantee no residual pin/transform/transition lingers past the play
   *  duration + slack. Each animating/held cycle reschedules this. */
  function scheduleFallback(): void {
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      fallbackTimer = undefined;
      for (const pane of inFlight) settlePane(pane);
      for (const pane of held) settlePane(pane);
      inFlight.clear();
      held.clear();
      targets.clear();
      pins.clear();
      chaseFramesLeft = 0;
    }, FLIP_DURATION_MS + FALLBACK_SLACK_MS);
  }

  /** Queue the next chase frame (the hold-until-stable loop) while any pane
   *  is still in flight or held, within the frame budget. */
  function scheduleChase(): void {
    if (chaseFramesLeft <= 0) return;
    if (inFlight.size === 0 && held.size === 0) return;
    if (rafHandle !== undefined) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = undefined;
      handleLayoutChange();
    });
  }

  /** PIN phase: for every KNOWN pane, ensure a pin exists at the size its
   *  iframe already renders at: an active pin (mid-chase), or the natural
   *  size recorded on the previous handled frame (= the pane's last COMPUTED
   *  layout — reading it from the map, NOT from offsetWidth, so this phase
   *  forces no layout and pending overlay geometry cannot reach the iframe
   *  before the pin lands). The pin write is a layout no-op (same size);
   *  every subsequent layout this frame computes the iframe at that size.
   *  Called from BOTH the onDidLayoutChange microtask (the EARLY pin —
   *  before any rAF, closing the un-pinned-paint window) and the top of
   *  handleLayoutChange (covers panes that gained a lastRect since, e.g. a
   *  drag ended between the microtask and the rAF). */
  function ensurePins(panes: Map<string, PanePair>): void {
    for (const [id, { pane }] of panes) {
      if (pins.has(pane)) continue;
      const prev = lastRects.get(id);
      // New panel (first recorded appearance) or zero-size (trayed /
      // off-screen): no old bitmap worth keeping — animate nothing.
      if (!prev || prev.width <= 0 || prev.height <= 0) continue;
      pins.set(pane, { w: prev.width, h: prev.height });
      pane.style.width = `${prev.width}px`;
      pane.style.height = `${prev.height}px`;
    }
  }

  function handleLayoutChange(): void {
    // BASELINE-FRESHNESS: the container resized since the last handled frame
    // (dockview commits viewport-driven overlay resizes — window/URL-bar/
    // keyboard — without firing onDidLayoutChange). Never pin / invert off a
    // suspect baseline: re-seed it (which also hard-cancels any in-flight op
    // — a system-driven viewport change jumps, no morph) and return. The next
    // event animates from the FRESH baseline.
    if (resizeDirty) {
      refreshBaseline();
      return;
    }
    // CONTINUOUS drag: skip entirely (no reflow per pointermove frame). Flag so
    // the drag-end pointerup refreshes the baseline once.
    if (container.classList.contains("dv-geometry-dragging")) {
      draggingActive = true;
      // EARLY-PIN cleanup: a pin may have landed in the microtask window
      // before the drag class appeared. Panes merely PINNED (not yet
      // inverted/playing) must not ride the drag at their old size — release
      // them here. In-flight/held panes keep their state (a drag starting
      // mid-morph was always left to transitionend/fallback; the drag-end
      // refreshBaseline then hard-cancels any remainder, as before).
      for (const [pane] of pins) {
        if (!inFlight.has(pane) && !held.has(pane)) {
          pane.style.width = "";
          pane.style.height = "";
          pins.delete(pane);
        }
      }
      return;
    }
    // Reduced motion: jump is correct; no animation, NO PIN (the content
    // jumps directly to the new size). Just keep the baseline current.
    if (prefersReducedMotion()) {
      refreshBaseline();
      return;
    }

    const panes = currentPanes();

    // REMOVED-PANEL GHOSTS: settle tracked panes whose panel is gone (their
    // per-pane paths below never run for them — the chase would burn frames
    // on dead rects until the ~210ms fallback).
    const live = new Set<HTMLElement>();
    for (const [, { pane }] of panes) live.add(pane);
    settleGhosts(live);

    if (panes.size === 0) return;

    // ---- PIN (before any layout read of the new geometry) ----------------
    // Usually a no-op: the EARLY pin (microtask) already pinned every known
    // pane. Still needed for panes whose pin was skipped in the microtask
    // (drag ended / rect first recorded between microtask and rAF).
    ensurePins(panes);

    // ---- LAST read (committed overlay geometry this frame) ---------------
    // Overlays carry no FLIP styles (only their .pane children ever do), so
    // their rects are always natural — no cancelling needed to read them.
    const newRects = new Map<string, Rect>();
    for (const [id, { overlay }] of panes) newRects.set(id, readRect(overlay));
    const seen = new Set(newRects.keys());

    let playedOrHeld = false;

    for (const [id, { pane }] of panes) {
      const pin = pins.get(pane);
      const newRect = newRects.get(id)!;
      if (!pin) continue; // new panel this frame — record only (below)

      const target = targets.get(pane);
      if (target && rectEq(target, newRect)) {
        // Already flying toward exactly this rect — leave the transition
        // alone (re-handling would restart it every frame and freeze).
        continue;
      }

      // Zero-size destination (trayed / collapsed): settle now — the pane
      // follows its overlay down; nothing to morph.
      if (newRect.width <= 0 || newRect.height <= 0) {
        settlePane(pane);
        continue;
      }

      const prevRect = lastRects.get(id);
      const stable = prevRect !== undefined && rectEq(prevRect, newRect);

      // Current VISUAL rect — the FLIP always starts exactly from what the
      // user currently sees (settled old rect, or the mid-flight
      // interpolated rect on a retarget: continuous position, no snap-back).
      const visual = readRect(pane);

      if (stable && rectEq(visual, newRect)) {
        // In place, geometry stable: any pin we hold is superfluous.
        if (!inFlight.has(pane)) settlePane(pane);
        continue;
      }

      // INVERT (style-only) — the pane visually stays exactly where it is:
      // translate the pin box (at the new overlay top-left) so its top-left
      // lands on the visual rect's top-left, and scale it to the visual
      // rect's size (identity for a settled pane: visual == pin box).
      const dx = visual.left - newRect.left;
      const dy = visual.top - newRect.top;
      const sx0 = visual.width / pin.w;
      const sy0 = visual.height / pin.h;
      pane.style.transition = "none";
      pane.style.transform = `translate(${dx}px, ${dy}px) scale(${sx0}, ${sy0})`;
      void pane.offsetWidth; // commit cancel + invert before any play

      if (stable) {
        // The invert is already committed by the reflow above — PLAY to the
        // stable natural rect: identity translate + end-scale.
        const sx = newRect.width / pin.w;
        const sy = newRect.height / pin.h;
        pane.style.transition = `transform ${FLIP_DURATION_MS}ms ${FLIP_TIMING}`;
        pane.style.transform = `translate(0px, 0px) scale(${sx}, ${sy})`;
        held.delete(pane);
        inFlight.add(pane);
        targets.set(pane, newRect);
      } else {
        // Geometry still moving frame-to-frame (transient states of a
        // multi-step op — e.g. a swap's off-window intermediate): HOLD at
        // the current visual (transition: none). Play only once stable.
        inFlight.delete(pane);
        held.add(pane);
        targets.delete(pane);
      }
      playedOrHeld = true;
    }

    // ---- bookkeeping -------------------------------------------------------
    // lastRects := this frame's natural rects (the stability reference for
    // the next frame); forget panes whose panels are gone.
    for (const [id, r] of newRects) lastRects.set(id, r);
    for (const id of [...lastRects.keys()]) if (!seen.has(id)) lastRects.delete(id);

    if (playedOrHeld) scheduleFallback();
    if (chaseFramesLeft > 0) chaseFramesLeft--;
    scheduleChase();
  }

  // transitionend (bubbles from the .pane child through its overlay to the
  // container): SETTLE — clear the pin + transform + transition the moment
  // the FLIP completes, so the deferred reflow fires exactly once, after the
  // motion. Only the FLIP's own transform transition is cleared
  // (propertyName filter + inFlight membership guard).
  function onTransitionEnd(ev: TransitionEvent): void {
    if (ev.propertyName !== "transform") return;
    const el = ev.target;
    if (!(el instanceof HTMLElement)) return;
    if (!inFlight.has(el)) return;
    settlePane(el);
  }

  // Drag-end: a continuous geometry drag just released. Refresh the baseline so
  // the next DISCRETE op animates from the post-drag position (without this,
  // the baseline would still hold the pre-drag rects and the next op's FLIP
  // would fly the panes in from their old pre-drag spots). Window-capture so
  // it fires before Dockview's own drag-release flush.
  function onDragEnd(): void {
    if (!draggingActive) return;
    draggingActive = false;
    refreshBaseline();
  }

  container.addEventListener("transitionend", onTransitionEnd);
  window.addEventListener("pointerup", onDragEnd, true);
  window.addEventListener("pointercancel", onDragEnd, true);

  // Deferred, per-frame handling (see TIMING GUARANTEE above): dockview
  // commits overlay geometry in rAFs queued synchronously inside the layout
  // op; this handler's rAF is queued later (from the AsapEvent microtask),
  // so it runs AFTER them in the same frame and reads the COMMITTED new
  // geometry — while still writing the pin before the frame's layout/paint
  // (the iframe never lays out at the un-pinned new size). Sets up the
  // hold-until-stable chase budget for multi-frame geometry commits.
  function onLayoutChange(): void {
    // EARLY PIN — synchronously in THIS microtask, BEFORE any rAF (see
    // TIMING GUARANTEE step 1). At microtask time the overlay still has OLD
    // geometry, so pinning the child at its current (old) size is a visual
    // no-op — it already fills — yet it guarantees the iframe never lays out
    // at the new size before the handler's pin, regardless of rAF
    // scheduling/order. Skip cases must NOT pin (they jump instead): a
    // continuous drag resizes per pointermove, reduced-motion jumps
    // directly, and a pending baseline re-seed (BASELINE-FRESHNESS — the
    // container resized) must not pin at the STALE pre-resize size. (If the
    // skip state appears only LATER — a drag starts before the rAF runs —
    // handleLayoutChange's drag branch releases the early pin, and
    // refreshBaseline hard-cancels any pin it finds.)
    if (
      !resizeDirty &&
      !container.classList.contains("dv-geometry-dragging") &&
      !prefersReducedMotion()
    ) {
      ensurePins(currentPanes());
    }
    if (rafHandle === undefined) {
      rafHandle = requestAnimationFrame(() => {
        rafHandle = undefined;
        handleLayoutChange();
      });
    }
    chaseFramesLeft = MAX_CHASE_FRAMES;
  }

  const layoutDisp = api.onDidLayoutChange(onLayoutChange);

  // BASELINE-FRESHNESS: dockview commits container-driven overlay resizes
  // (window/URL-bar/keyboard) WITHOUT firing onDidLayoutChange — lastRects
  // would go stale and the next layout EVENT (a mere panel activation or
  // route change fires it) would pin panes at the pre-resize size and morph
  // them: the reported "random weird animation". Watch the container; on
  // resize, mark the baseline suspect and re-seed it after dockview's
  // overlay-rewrite rAFs have committed. Dockview's own RO on the same
  // element was registered first (mount-time), so its callback runs first;
  // its geometry writes are rAF-chained — 2 chained rAFs from OUR callback
  // land safely past them. While dirty, no early pin is taken and the
  // handler re-seeds + returns (never animate off a suspect baseline).
  const resizeObserver = new ResizeObserver(() => {
    resizeDirty = true;
    if (resizeRafs.length > 0) return; // a re-seed chain is already pending
    resizeRafs.push(
      requestAnimationFrame(() => {
        resizeRafs.push(
          requestAnimationFrame(() => {
            resizeRafs.length = 0; // chain complete — a new one may start
            refreshBaseline();
          }),
        );
      }),
    );
  });
  resizeObserver.observe(container);

  // Seed the baseline so the FIRST user-driven layout change has a valid
  // FIRST. The synchronous read runs before dockview's rAF-positioned
  // geometry commit (overlays still fill the whole container), so re-seed
  // one frame later when the real per-overlay geometry has committed.
  refreshBaseline();
  rafHandle = requestAnimationFrame(() => {
    rafHandle = undefined;
    refreshBaseline();
  });

  return () => {
    layoutDisp.dispose();
    resizeObserver.disconnect();
    for (const h of resizeRafs) cancelAnimationFrame(h);
    resizeRafs.length = 0;
    if (rafHandle !== undefined) cancelAnimationFrame(rafHandle);
    container.removeEventListener("transitionend", onTransitionEnd);
    window.removeEventListener("pointerup", onDragEnd, true);
    window.removeEventListener("pointercancel", onDragEnd, true);
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    // Hard-cancel (never animate) any still-in-flight/held pane + drop
    // stale pins, then restore transition (hardCancelPane leaves
    // `transition: none`).
    const active = new Set<HTMLElement>([...inFlight, ...held]);
    for (const pane of active) {
      hardCancelPane(pane);
      pane.style.transition = "";
    }
    inFlight.clear();
    held.clear();
    targets.clear();
    pins.clear();
    lastRects.clear();
    chaseFramesLeft = 0;
  };
}
