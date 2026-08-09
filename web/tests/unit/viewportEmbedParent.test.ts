// @vitest-environment jsdom
//
// Regression test for the embedding viewport bug exposed by the fold
// (commit f461094 made the SPA run inside the host-shell iframe by default):
// "the app used to be aware of resize due to keyboard ... but not anymore in
// the new host system."
//
// ROOT CAUSE this pins (statically established from the repo):
//   - Standalone (web/index.html): the viewport meta has
//     `interactive-widget=resizes-content`, so the on-screen keyboard RESIZES
//     the layout viewport → this iframe's OWN visualViewport.height / innerHeight
//     shrink → installViewport's listeners fire → --app-h updates → the layout
//     resizes so the composer stays above the keyboard. WORKS.
//   - Embedded (host-web/index.html governs; the SPA's own meta is IGNORED in an
//     iframe): the host meta has NO `interactive-widget` → browser default
//     `resizes-visual` → the keyboard shrinks ONLY the host's VISUAL viewport,
//     NOT its layout viewport. The iframe element is sized by Dockview from the
//     host's LAYOUT viewport, so the iframe element does NOT resize on keyboard
//     → this iframe's OWN visualViewport/innerHeight never change →
//     installViewport's listeners never fire → --app-h stays stale → the layout
//     does NOT resize for the keyboard. BROKEN (the regression).
//
// THE FIX (SPA-side, same-origin only): when embedded (window.parent !== window)
// AND the parent's visualViewport is reachable (same-origin — the post-fold
// default; cross-origin access throws and we degrade to own-height-only), ALSO
// track parent.visualViewport (which DOES shrink on keyboard under
// resizes-visual — the same browser signal the standalone path relies on) and
// cap --app-h at the smaller of {own box height, parent visible height}. No host
// cooperation / postMessage required.
//
// jsdom has no VisualViewport, so the test installs a minimal EventTarget mock
// with a mutable height and a dispatch helper, then fires the SAME event a real
// keyboard produces (visualViewport.resize). This simulates the keyboard's
// effect at the exact signal the production code consumes — the load-bearing
// path. (A real soft keyboard cannot be opened in headless jsdom/Playwright; see
// the behavioral-closure note in the slice report.)
import { describe, it, expect, beforeEach } from "vitest";
import { installViewport } from "../../src/viewport";

// Minimal VisualViewport mock: an EventTarget-shaped object with a mutable
// `height` (the only field installViewport reads) plus dispatch helpers for the
// two events it listens to (resize, scroll).
interface VVMock {
  target: {
    height: number;
    width: number;
    offsetTop: number;
    offsetLeft: number;
    pageTop: number;
    pageLeft: number;
    scale: number;
    addEventListener: (type: string, fn: (e: Event) => void) => void;
    removeEventListener: (type: string, fn: (e: Event) => void) => void;
    dispatchEvent: (e: Event) => boolean;
  };
  setHeight: (h: number) => void;
  fire: (type: "resize" | "scroll") => void;
}

function makeVV(height: number): VVMock {
  const listeners: Record<string, Array<(e: Event) => void>> = {};
  const target = {
    height,
    width: 360,
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
    addEventListener: (type: string, fn: (e: Event) => void) => {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    dispatchEvent: () => false,
  };
  return {
    target,
    setHeight: (h: number) => {
      target.height = h;
    },
    fire: (type: "resize" | "scroll") => {
      (listeners[type] || []).forEach((fn) => fn(new Event(type)));
    },
  };
}

function appH(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--app-h").trim();
}

describe("installViewport — embedded parent visualViewport (keyboard resize)", () => {
  let ownVV: VVMock;
  let parentVV: VVMock;
  let parentWindow: unknown;

  beforeEach(() => {
    // Reset the root styles so --app-h does not leak from a prior test.
    document.documentElement.style.cssText = "";
    ownVV = makeVV(800);
    parentVV = makeVV(800);
    // Install the iframe's OWN visualViewport (jsdom lacks it).
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: ownVV.target,
    });
    // Default: standalone (window.parent === window).
    parentWindow = window;
    Object.defineProperty(window, "parent", {
      configurable: true,
      get: () => parentWindow,
    });
  });

  it("standalone: own visualViewport.resize updates --app-h (unchanged behavior)", () => {
    installViewport();
    expect(appH(), "initial --app-h tracks own visual viewport").toBe("800px");
    // Keyboard-equivalent: own visual viewport shrinks.
    ownVV.setHeight(500);
    ownVV.fire("resize");
    expect(appH(), "standalone shrinks --app-h with own visual viewport").toBe("500px");
  });

  it("EMBEDDED: parent.visualViewport.resize updates --app-h (keyboard) — the regression", () => {
    // Reproduce the regression: the iframe's OWN box stays 800px (Dockview-fixed
    // by the host's LAYOUT viewport, which does not shrink on keyboard), but the
    // PARENT's visual viewport shrinks to 500px (keyboard). Before the fix, no
    // listener watches parent.visualViewport → --app-h stays 800px (the bug).
    parentWindow = { visualViewport: parentVV.target };
    installViewport();
    expect(appH(), "embedded initial --app-h is own (iframe box) height").toBe("800px");
    // Keyboard opens: parent.vv shrinks; iframe's own vv UNCHANGED (stays 800).
    ownVV.setHeight(800);
    parentVV.setHeight(500);
    parentVV.fire("resize");
    expect(appH(), "embedded must shrink --app-h to parent visible height").toBe("500px");
  });

  it("EMBEDDED: --app-h caps at the iframe's own height when parent is taller (no overflow)", () => {
    // No keyboard: the parent's full visual viewport is TALLER than the iframe
    // box (e.g. the iframe is docked/split, not full-pane). --app-h must NOT
    // exceed the iframe's own height, or .app would overflow the iframe box.
    ownVV.setHeight(600); // iframe element is 600px (docked/split)
    parentVV.setHeight(800); // parent full viewport is 800
    parentWindow = { visualViewport: parentVV.target };
    installViewport();
    expect(appH(), "--app-h capped at own height, not parent's taller height").toBe("600px");
  });

  it("EMBEDDED: parent.visualViewport.scroll also refreshes --app-h", () => {
    // The standalone path listens to scroll (iOS Safari fires scroll, not just
    // resize, when the keyboard animates). The embedded parent path mirrors it.
    parentWindow = { visualViewport: parentVV.target };
    installViewport();
    parentVV.setHeight(450);
    parentVV.fire("scroll");
    expect(appH(), "parent scroll also drives --app-h").toBe("450px");
  });

  it("EMBEDDED cross-origin (parent.visualViewport throws): degrades to own-height-only", () => {
    // A cross-origin parent throws on visualViewport access. installViewport
    // must not crash and must keep tracking the iframe's own viewport.
    const throwingParent = {
      get visualViewport(): VisualViewport {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    parentWindow = throwingParent;
    expect(() => installViewport(), "cross-origin parent must not crash installViewport").not.toThrow();
    ownVV.setHeight(700);
    ownVV.fire("resize");
    expect(appH(), "cross-origin embed still tracks own viewport").toBe("700px");
  });
});
