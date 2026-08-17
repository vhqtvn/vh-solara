// UI-zoom coordinate conversion for pointer-driven drag/position math.
//
// prefs.ts applies the user's UI zoom as CSS `zoom` on :root (the desktop and
// embedded-mobile path) and mirrors it as an inline `--ui-zoom` custom
// property. Under CSS zoom, PointerEvent clientX/clientY (and
// window.innerWidth/innerHeight) are in OUTER/viewport pixels, while px values
// we assign to element styles (width, flex-basis, left/top of a fixed popup)
// are interpreted in the element's own ZOOMED-LAYOUT pixels. Drag or placement
// math that feeds raw clientX into a style-px length is therefore off by
// exactly the zoom factor: it lags the cursor above 100% and overshoots below.
//
// `layoutPx()` divides a viewport-px coordinate/length by the effective zoom so
// drags track the cursor 1:1 at any zoom. On the mobile-standalone meta-scale
// path prefs.ts pins --ui-zoom to 1, so this is the identity there.

function parseZoom(v: string | null | undefined): number {
  const n = v ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The app document's effective UI zoom (1 when zoom isn't applied/unparseable). */
export function uiZoom(): number {
  if (typeof document === "undefined" || !document.documentElement) return 1;
  const root = document.documentElement;
  // prefs.ts sets BOTH the inline `zoom` and the inline `--ui-zoom` on :root;
  // the inline custom property is the cheapest truthful read. Fall back to the
  // computed style (covers zoom set on :root by any other means), then to 1.
  const inline = root.style.getPropertyValue("--ui-zoom");
  if (inline) return parseZoom(inline);
  let computed = "";
  try {
    const cs = getComputedStyle(root);
    computed = (cs as CSSStyleDeclaration & { zoom?: string }).zoom || cs.getPropertyValue("--ui-zoom");
  } catch {
    /* computed style unavailable — fall through to the 1 fallback */
  }
  return parseZoom(computed);
}

/** Convert a viewport-px pointer coordinate (or length) to zoomed-layout px. */
export function layoutPx(viewportPx: number): number {
  return viewportPx / uiZoom();
}
