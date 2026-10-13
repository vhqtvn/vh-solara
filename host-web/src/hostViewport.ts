// =============================================================================
// HOST ROOT HEIGHT = THE ACTUALLY VISIBLE VIEWPORT (level-triggered)
//
// Bug ("the chat composer keeps overflowing after a while", Android tablet, all
// project tabs at once, no keyboard). The host root `.app` used to be
// `height: 100vh`. On mobile browsers 100vh is the LARGE viewport (as if the
// dynamic browser toolbar were retracted), while the area actually visible is
// the layout viewport (window.innerHeight / the ICB). Whenever the toolbar is
// showing, `.app` — and every pane iframe inside it — extended ~one toolbar
// height (≈40-80 CSS px) below the screen bottom; `body{overflow:hidden}`
// simply clipped it. The SPA's own --app-h clamp (web/src/viewport.ts,
// min(vv.height, innerHeight)) could not help: INSIDE the iframe innerHeight
// IS the too-tall iframe element, so the clamp was inert. Same failure for a
// stale vh after resume/rotation. Edge-to-edge (viewport-fit=cover) adds a
// second source: the bottom system-bar band is part of the viewport but not
// usable — handled by safe-area padding on `.app` (App.module.css).
//
// Fix: the host owns its root height. computeHostHeight() samples the visible
// band's bottom edge (visualViewport offsetTop + height, clamped to
// innerHeight) and writes it as `--host-h` on <html>; `.app` consumes
// `height: var(--host-h, 100%)` (100% = the ICB = small viewport fallback).
// LEVEL-triggered: re-sampled on every "world may have changed" signal (vv
// resize/scroll, window resize/orientationchange/pageshow/focus,
// visibilitychange, a ResizeObserver on <html>) plus a rAF-settle re-sample;
// writes only on change.
//
// keyboardFocus.ts compatibility: this module NEVER touches `.app`'s inline
// style — it only writes a custom property on <html>. keyboardFocus's
// capture/restore of `.app`'s inline height/transform therefore keeps working
// unchanged: while open its inline height wins; on restore the inline override
// is cleared and `.app` falls back to var(--host-h) (the visible height), not
// the old too-tall 100vh.
//
// WHY JS --host-h AND NOT CSS 100dvh/100svh (decision, 2026-10-13 re-audit):
// dvh tracks the dynamic toolbar natively and cannot miss events, but (a) it is
// NOT red-testable headlessly — desktop engines report 100dvh == 100vh ==
// innerHeight, so a dvh-only fix passes e2e trivially even with the old 100vh
// CSS restored (no sensitivity property; the host-viewport spec's mock getters
// would be ignored by CSS entirely); (b) dvh does NOT shrink for the Android
// soft keyboard (interactive-widget=resizes-content would be a separate
// architecture change) — keyboard geometry stays keyboardFocus.ts's
// inline-override domain either way; (c) the missed-event class dvh would
// eliminate is already covered here by the ResizeObserver on <html>
// (html{height:100%} tracks the ICB, so ANY innerHeight change resizes its box
// and re-fires the observer — a lost window resize edge cannot leave --host-h
// stale). The var() fallback (100% = the ICB = small viewport) is itself the
// correct static answer on engines without dvh — better than a 100vh fallback.
// =============================================================================

/** Visible viewport height in CSS px for the host root, or null when no
 *  usable sample exists (keep the last good value).
 *
 *  - Base: window.innerHeight (the layout viewport — excludes the dynamic
 *    browser toolbar while it is shown, unlike 100vh).
 *  - visualViewport refinement: the root sits at layout-y 0 (scrollY stays 0
 *    under overflow:hidden), so its bottom must not pass the visible band's
 *    bottom edge = vv.offsetTop + vv.height. Clamped to innerHeight so a
 *    stale-large vv sample can never grow the root past the layout viewport.
 *  - vv is ignored while pinch-zoomed (scale ≠ 1): a zoomed vv is smaller by
 *    the zoom factor, not because the screen is.
 *  - 0/negative samples (hidden/collapsed window) are ignored. */
export function computeHostHeight(win: Window = window): number | null {
  const layoutH = win.innerHeight;
  let h = layoutH > 0 ? layoutH : 0;
  const vv = win.visualViewport;
  if (vv && vv.height > 0 && Math.abs((vv.scale || 1) - 1) < 0.01) {
    const visibleBottom = (vv.offsetTop > 0 ? vv.offsetTop : 0) + vv.height;
    h = h > 0 ? Math.min(h, visibleBottom) : visibleBottom;
  }
  if (!(h > 0)) return null;
  return Math.round(h);
}

export const HOST_HEIGHT_VAR = "--host-h";

let installed = false;
let teardown: (() => void) | null = null;
let resync: (() => void) | null = null;

/** Force an immediate --host-h re-sample (no-op before install). */
export function resyncHostViewport(): void {
  resync?.();
}

/** Install the level-triggered --host-h tracker. Idempotent; no-op outside a
 *  browser. Call before first render so the root never paints at a stale
 *  height. */
export function installHostViewport(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const root = document.documentElement;
  let last = "";
  const applyNow = () => {
    const h = computeHostHeight(window);
    if (h === null) return;
    const v = `${h}px`;
    if (v === last && root.style.getPropertyValue(HOST_HEIGHT_VAR) === v) return;
    last = v;
    root.style.setProperty(HOST_HEIGHT_VAR, v);
  };
  let raf = 0;
  const apply = () => {
    applyNow();
    // vv/innerHeight can lag the final layout by a frame (toolbar animation,
    // resume, rotation): re-sample once more after the frame settles.
    if (raf || typeof requestAnimationFrame === "undefined") return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      applyNow();
    });
  };
  resync = apply;
  applyNow();

  const vv = window.visualViewport;
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  const winEvents = ["resize", "orientationchange", "pageshow", "focus"] as const;
  for (const ev of winEvents) window.addEventListener(ev, apply);
  document.addEventListener("visibilitychange", apply);
  // <html> is height:100% → its box tracks the ICB even if a resize event was
  // lost.
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(apply);
    ro.observe(root);
  }

  teardown = () => {
    vv?.removeEventListener("resize", apply);
    vv?.removeEventListener("scroll", apply);
    for (const ev of winEvents) window.removeEventListener(ev, apply);
    document.removeEventListener("visibilitychange", apply);
    ro?.disconnect();
    if (raf && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(raf);
    raf = 0;
  };
  installDevBridge();
}

/** Tear down listeners (hot-reload / tests). Leaves the last --host-h in
 *  place: it is the correct visible height at teardown time. */
export function uninstallHostViewport(): void {
  if (!installed) return;
  installed = false;
  teardown?.();
  teardown = null;
  resync = null;
  removeDevBridge();
}

// ---- DEV bridge (window.__hostVisibleViewport) ------------------------------
// Lets the e2e read the computed value and force a re-sample. (Distinct from
// viewportShape.ts's window.__hostViewport.) DEV-gated like
// window.__hostKbdFocus; absent in prod (the preview e2e asserts
// __host*=0 — this bridge follows the same rule).

const DEV_BRIDGE_KEY = "__hostVisibleViewport";

function installDevBridge(): void {
  if (!import.meta.env.DEV) return;
  (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY] = {
    compute: () => computeHostHeight(window),
    resync: () => resyncHostViewport(),
  };
}

function removeDevBridge(): void {
  if (!import.meta.env.DEV) return;
  delete (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY];
}
