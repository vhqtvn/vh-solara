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

  // iOS Safari ignores user-scalable=no; block its pinch-zoom gesture events so
  // scaling is disabled there too. (No-op on browsers without these events.)
  const noGesture = (e: Event) => e.preventDefault();
  document.addEventListener("gesturestart", noGesture);
  document.addEventListener("gesturechange", noGesture);
  document.addEventListener("gestureend", noGesture);
}
