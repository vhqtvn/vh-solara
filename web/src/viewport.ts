// Drive the app height from the VISUAL viewport so the on-screen keyboard
// resizes the layout (composer stays above the keyboard) instead of the browser
// panning a too-tall page. dvh/interactive-widget alone are unreliable on mobile
// (esp. iOS Safari); visualViewport.height is the value that actually shrinks
// when the keyboard opens. Sets --app-h, which .app consumes.
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
