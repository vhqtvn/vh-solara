// Drive the app height from the iframe's OWN visual viewport so the on-screen
// keyboard resizes the layout (composer stays above the keyboard) instead of
// the browser panning a too-tall page. dvh/interactive-widget alone are
// unreliable on mobile (esp. iOS Safari); visualViewport.height is the value
// that actually shrinks when the keyboard opens. Sets --app-h, which .app
// consumes.
//
// OWN-VV-ONLY (the cross-boundary fix is now host-owned). The host shell owns
// keyboard behavior: when the soft keyboard opens it (a) shrinks the host root
// to the visible height AND (b) maximizes the focused pane's group, so the
// focused iframe element itself resizes to the visible area (see
// host-web/src/keyboardFocus.ts). Because the iframe element now shrinks on
// keyboard, the iframe's OWN visualViewport.height shrinks with it → this
// own-vv-only tracking sets --app-h to exactly the iframe element's height →
// the composer sits at the bottom of the (shrunk) iframe, visible above the
// keyboard, with NO gap. This is the same path that makes the standalone SPA
// at /app work.
//
// HISTORY: an earlier SPA-side fix (commit bb21408) additionally tracked the
// PARENT window's visualViewport and capped --app-h at min(own, parent). That
// was the WRONG layer: the iframe element stayed full-size while --app-h
// shrank → .app was shorter than the iframe box → an empty iframe-background
// band (~20-25% of screen) filled the gap below the composer, full-width. It
// is now retired because the host owns the resize and this own-vv-only path
// tracks the (correctly shrunk) iframe element directly.
//
// DRIFT FIX ("the input field keeps overflowing after a while"). --app-h used
// to be purely EDGE-triggered from resize events and taken verbatim from
// visualViewport.height. Any missed/stale sample latched a too-tall --app-h
// with nothing to correct it until the next resize: .app (overflow:hidden
// inside an overflow:hidden html) then extends past the iframe's bottom and
// the composer is clipped below the screen. The windows where that happens in
// the host shell: inactive workspaces / hidden dockview tabs are
// visibility:hidden (render-throttled iframes whose resize events are deferred
// or coalesced while the host root is shrunk/restored for the keyboard), app
// backgrounding/resume, and vv values that lag one frame behind the final
// layout on keyboard close. The model is now LEVEL-triggered + clamped:
//   - computeAppHeight() clamps to window.innerHeight (the frame's own LAYOUT
//     viewport = the iframe element's height when embedded). .app can never be
//     taller than the box it lives in; a stale-large vv sample cannot overflow.
//     (vv.height is still the value used whenever it is smaller — that is the
//     keyboard shrink on standalone iOS, where innerHeight does not shrink.)
//   - A 0/negative sample (collapsed/hidden frame) is ignored, keeping the last
//     good value instead of collapsing .app.
//   - Re-sync on every "the world may have changed" signal, not just resize:
//     a ResizeObserver on <html> (height:100% → tracks the frame's viewport
//     box even if a window resize event was lost), visibilitychange, pageshow
//     (bfcache), window focus, and the host's pane-visibility signal; each
//     event also re-samples on the next animation frame to catch lagging vv.
//   - Writes only when the value changes (no redundant style invalidation).
//
// SIBLING MODULE: host-web/src/hostViewport.ts tracks the HOST root's height
// (--host-h) with the same sampler skeleton. Shared invariants — keep both in
// lockstep: the event family (vv resize/scroll, window resize/
// orientationchange/pageshow/focus, visibilitychange), write-only-on-change
// with the style-value dedupe, the rAF-settle re-sample, and a ResizeObserver
// on <html> as the lost-event backstop. Deliberate divergences: HERE the
// sample is vv-primary (vv.height wins when smaller — the standalone iOS
// keyboard shrinks vv, not innerHeight), pinch zoom is suppressed (the SPA
// must never zoom), and there is no teardown (single mount for the app's
// lifetime); the host sample is innerHeight-primary with a visible-band-bottom
// clamp (vv.offsetTop + vv.height, pinch-zoomed samples ignored), installs a
// teardown (hot-reload/tests), and carries a DEV bridge. Mirror rule: change
// the sampler skeleton in one → mirror the change in the other.
/** App-root height in CSS px (written as --app-h; consumed by .app in
 * styles/legacy/00-app-globals.css), or null when no usable sample exists
 * (keep the last good value).
 *
 *  - vv-primary with an innerHeight clamp: vv.height wins when smaller (the
 *    standalone iOS keyboard shrinks vv, not innerHeight); a stale-large vv
 *    sample is clamped to the frame's layout viewport (the iframe element's
 *    height when embedded).
 *  - 0/negative samples (collapsed/hidden frame) are ignored.
 *  - FLOORED, never rounded up: the tracker may only ever make the app root
 *    SHORTER than the frame's viewport (the vv/innerHeight clamps), never
 *    taller. On fractional-CSS-px viewports (Android DPRs like 2.625 →
 *    innerHeight N.6) Math.round produced N+1 → `.app` 1px taller than the
 *    viewport → scrollingElement.scrollHeight > clientHeight → the same
 *    1px scroll-range/touch-pan class the host shell hit in the Chrome PWA
 *    standalone report (mirrored from host-web/src/hostViewport.ts, 82360d1).
 *    The sub-pixel loss is invisible; the scroll range it prevents is not.
 *    (Belt-and-braces: 00-app-globals.css caps `.app` with max-height:100%
 *    for any non-rounding over-viewport source.) */
export function computeAppHeight(win: Window = window): number | null {
  const layoutH = win.innerHeight;
  const vvH = win.visualViewport?.height;
  let h = vvH && vvH > 0 ? vvH : layoutH;
  if (layoutH > 0 && h > layoutH) h = layoutH;
  if (!(h > 0)) return null;
  return Math.floor(h);
}

let resync: (() => void) | null = null;

/** Force an immediate --app-h re-sample (no-op before installViewport). Wired
 *  to host pane-visibility transitions in index.tsx. */
export function resyncViewport(): void {
  resync?.();
}

export function installViewport() {
  const root = document.documentElement;
  let last = "";
  const applyNow = () => {
    const h = computeAppHeight(window);
    if (h === null) return;
    const v = `${h}px`;
    if (v === last && root.style.getPropertyValue("--app-h") === v) return;
    last = v;
    root.style.setProperty("--app-h", v);
  };
  let raf = 0;
  const apply = () => {
    applyNow();
    // Re-sample once more after the frame settles: vv/innerHeight can lag the
    // final layout by a frame (keyboard close, resume, iframe resize).
    if (raf || typeof requestAnimationFrame === "undefined") return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      applyNow();
    });
  };
  resync = apply;
  applyNow();
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
  }
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  window.addEventListener("pageshow", apply);
  window.addEventListener("focus", apply);
  document.addEventListener("visibilitychange", apply);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(apply).observe(root);
  }

  // Pinch-zoom is fully disabled. The locked viewport meta in prefs.ts
  // setViewportScale (user-scalable=no, minimum-scale = maximum-scale = the
  // UI-zoom baseline) handles Android Chrome, but Android Edge and iOS Safari
  // IGNORE user-scalable=no (their own zoom policy overrides it) — so the meta
  // alone is not enough there. These meta-independent layers close that gap:
  //   1. CSS `touch-action: pan-x pan-y` on the document root (foundation/reset.css)
  //      — the primary pinch-disable that does NOT depend on the meta.
  //   2. iOS gesture* events (below) — the legacy iOS Safari pinch path.
  //   3. 2+-finger touchmove (below) — the gesture path Edge/iOS actually use
  //      for pinch detection, not the deprecated gesture* events.
  // Together the mechanisms keep visualViewport.height stable, which is what the
  // --app-h height model above relies on (a pinch would shrink it and push the
  // composer off the bottom — see the rationale in prefs.ts setViewportScale).
  // (The handlers below are no-ops on browsers without those events.)
  const noGesture = (e: Event) => e.preventDefault();
  document.addEventListener("gesturestart", noGesture);
  document.addEventListener("gesturechange", noGesture);
  document.addEventListener("gestureend", noGesture);
  // Belt-and-suspenders: block the pinch gesture at the touch level for browsers
  // where touch-action alone is insufficient. Only block when touches.length >= 2
  // — a 1-finger touchmove is normal scrolling and must never be blocked.
  // { passive: false } is REQUIRED so preventDefault actually takes effect.
  const noPinchMove = (e: TouchEvent) => {
    if (e.touches.length >= 2) e.preventDefault();
  };
  document.addEventListener("touchmove", noPinchMove, { passive: false });
}
