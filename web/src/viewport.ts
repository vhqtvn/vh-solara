// Drive the app height from the VISUAL viewport so the on-screen keyboard
// resizes the layout (composer stays above the keyboard) instead of the browser
// panning a too-tall page. dvh/interactive-widget alone are unreliable on mobile
// (esp. iOS Safari); visualViewport.height is the value that actually shrinks
// when the keyboard opens. Sets --app-h, which .app consumes.
//
// EMBEDDED (host-shell iframe, the post-fold default at /): the iframe's OWN
// visualViewport/innerHeight do NOT change on keyboard, because the iframe
// element is sized by the host's LAYOUT viewport (Dockview geometry) and the
// host meta (host-web/index.html) lacks `interactive-widget=resizes-content`, so
// the browser default `resizes-visual` shrinks ONLY the host's VISUAL viewport —
// not its layout viewport, hence not the iframe element. To still resize for the
// keyboard when embedded, we ALSO track the PARENT's visualViewport (which DOES
// shrink on keyboard — the same signal the standalone path relies on) and cap
// --app-h at min(own box height, parent visible height). Same-origin only; a
// cross-origin parent's visualViewport access throws and readParentViewport()
// returns null there (graceful degradation to own-height-only). No host
// cooperation / postMessage is required for this.
export function installViewport() {
  const root = document.documentElement;
  const parentVV = readParentViewport();
  const apply = () => {
    const vv = window.visualViewport;
    let h = vv ? vv.height : window.innerHeight;
    // Embedded keyboard: cap at the parent's visible height so .app shrinks
    // above the keyboard (parent.vv shrinks below the iframe box). When the
    // parent is taller than the iframe (no keyboard, or a docked/split pane),
    // this is a no-op and --app-h keeps the iframe's own box height.
    if (parentVV && parentVV.height < h) h = parentVV.height;
    root.style.setProperty("--app-h", `${Math.round(h)}px`);
  };
  apply();
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
  }
  if (parentVV) {
    parentVV.addEventListener("resize", apply);
    parentVV.addEventListener("scroll", apply);
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

// Read the parent window's VisualViewport when this document is embedded
// same-origin in the host-shell iframe (window.parent !== window). Returns null
// when standalone, when the parent is cross-origin (visualViewport access throws
// on the cross-origin WindowProxy), or where the parent exposes no
// visualViewport (older browsers) — in all those cases installViewport degrades
// to own-height-only tracking (the original standalone behavior).
function readParentViewport(): VisualViewport | null {
  try {
    if (typeof window === "undefined" || window.parent === window) return null;
    return window.parent.visualViewport ?? null;
  } catch {
    return null;
  }
}
