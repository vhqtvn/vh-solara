// @vitest-environment jsdom
// uiScale applyScale — embed-context branch.
//
// applyScale has three regimes:
//   - standalone desktop (pointer fine)        → CSS zoom + --ui-zoom
//   - standalone mobile (pointer coarse)       → viewport meta only; zoom reset
//   - embedded in host-shell iframe (any ptr)  → CSS zoom (the iframe's own
//     viewport meta is IGNORED by browsers, so the meta path is a visual no-op
//     there — the post-fold mobile-embed regression this test guards)
//
// The embed branch is the fix for "ui scaling no longer works" once the host
// shell became the default view (the SPA at /app is embedded same-origin by the
// host at /). window.parent !== window is the embed gate (same pattern as
// heartbeat.ts). This test pins all three branches so the embed fallback cannot
// silently regress to the meta-only path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./_matchMedia";
import { applyScale, setUiScale } from "../../src/prefs";

// Control knobs the test flips per-case.
let coarse = false;
let embedded = false;

function installMatchMedia(): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: q.includes("coarse") && coarse,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

function installParent(): void {
  // window.parent defaults to window in jsdom. Override via a configurable
  // getter so the embed gate (window.parent !== window) reads our flag.
  Object.defineProperty(window, "parent", {
    configurable: true,
    get: () => (embedded ? ({} as Window) : window),
  });
}

function rootZoom(): string {
  return (document.documentElement.style as unknown as { zoom: string }).zoom;
}
function uiZoomVar(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--ui-zoom").trim();
}

describe("applyScale embed-context branches", () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="viewport" content="" />';
    coarse = false;
    embedded = false;
    installMatchMedia();
    installParent();
    vi.resetModules();
  });

  it("standalone desktop (pointer fine) → CSS zoom + --ui-zoom", () => {
    coarse = false;
    embedded = false;
    setUiScale(1.5);
    applyScale();
    expect(rootZoom(), "desktop zoom reflects scale").toBe("1.5");
    expect(uiZoomVar(), "desktop --ui-zoom reflects scale").toBe("1.5");
  });

  it("standalone mobile (pointer coarse) → viewport meta only; zoom reset", () => {
    coarse = true;
    embedded = false;
    setUiScale(1.5);
    applyScale();
    expect(rootZoom(), "standalone mobile resets CSS zoom").toBe("");
    expect(uiZoomVar(), "standalone mobile keeps --ui-zoom at 1").toBe("1");
  });

  it("EMBEDDED mobile (host iframe) → CSS zoom (meta ignored in iframe)", () => {
    // The post-fold default: SPA embedded by the host shell. The iframe's
    // viewport meta is ignored, so the ONLY way to actually scale the content
    // is CSS zoom. Before the fix this fell into the mobile meta-only branch
    // and ui-scale was a visual no-op when embedded on a touch device.
    coarse = true;
    embedded = true;
    setUiScale(1.5);
    applyScale();
    expect(rootZoom(), "embedded mobile must use CSS zoom (not reset)").toBe("1.5");
    expect(uiZoomVar(), "embedded mobile --ui-zoom reflects scale").toBe("1.5");
  });

  it("embedded desktop → CSS zoom (unchanged by the embed fix)", () => {
    coarse = false;
    embedded = true;
    setUiScale(1.25);
    applyScale();
    expect(rootZoom(), "embedded desktop uses CSS zoom").toBe("1.25");
    expect(uiZoomVar(), "embedded desktop --ui-zoom reflects scale").toBe("1.25");
  });
});
