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

  // Pinch-zoom is fully disabled: the locked viewport meta in prefs.ts
  // setViewportScale (user-scalable=no, minimum-scale = maximum-scale = the
  // UI-zoom baseline) handles Android/Chrome, but iOS Safari ignores
  // user-scalable=no — so we also block its pinch gesture events here. Together
  // the two mechanisms keep visualViewport.height stable, which is what the
  // --app-h height model above relies on. (No-op on browsers without these events.)
  const noGesture = (e: Event) => e.preventDefault();
  document.addEventListener("gesturestart", noGesture);
  document.addEventListener("gesturechange", noGesture);
  document.addEventListener("gestureend", noGesture);
}
