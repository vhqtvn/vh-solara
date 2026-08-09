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
export function installViewport() {
  const root = document.documentElement;
  const apply = () => {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    root.style.setProperty("--app-h", `${Math.round(h)}px`);
  };
  apply();
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
  }
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);

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
