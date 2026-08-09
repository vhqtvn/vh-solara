// @vitest-environment jsdom
//
// Regression test for the viewport height model after the cross-boundary fix
// moved keyboard behavior to the HOST shell (host-web/src/keyboardFocus.ts).
//
// MODEL (own-vv-only): installViewport sets --app-h to the iframe's OWN
// visualViewport.height, nothing else. The host owns keyboard behavior — it
// shrinks the host root + maximizes the focused pane on keyboard-open, so the
// iframe ELEMENT resizes to the visible area, and the iframe's own
// visualViewport.height shrinks with it. This own-vv-only tracking therefore
// puts --app-h at exactly the (correctly shrunk) iframe element height, the
// composer sits at the bottom of the shrunk iframe above the keyboard, and
// there is NO gap (the original bb21408 parent-cap fix produced a gap because
// the iframe element stayed full-size while --app-h shrank).
//
// This test pins both halves of that contract:
//   1. OWN visualViewport.resize/scroll updates --app-h (standalone + embedded).
//   2. The PARENT window's visualViewport is NOT consulted — a parent shrink
//      does NOT change --app-h (the retired parent-cap is gone). This is the
//      load-bearing assertion: if the parent-cap ever returns, this goes red.
//
// jsdom has no VisualViewport, so the test installs a minimal EventTarget mock
// with a mutable height and a dispatch helper, then fires the SAME event a real
// keyboard produces (visualViewport.resize). (A real soft keyboard cannot be
// opened in headless jsdom/Playwright; the host-side keyboard outcome is proven
// in host-web/tests/e2e/keyboard-focus.spec.ts and the real-device retest is the
// operator's final gate — see the behavioral-closure token in the slice report.)
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

describe("installViewport — own-vv-only (host owns keyboard behavior)", () => {
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

  it("own visualViewport.resize updates --app-h", () => {
    installViewport();
    expect(appH(), "initial --app-h tracks own visual viewport").toBe("800px");
    // Keyboard-equivalent: own visual viewport shrinks (the host has shrunk the
    // iframe element; the iframe's own vv follows it).
    ownVV.setHeight(500);
    ownVV.fire("resize");
    expect(appH(), "own resize shrinks --app-h").toBe("500px");
  });

  it("own visualViewport.scroll also refreshes --app-h (iOS fires scroll)", () => {
    installViewport();
    ownVV.setHeight(450);
    ownVV.fire("scroll");
    expect(appH(), "own scroll drives --app-h").toBe("450px");
  });

  // LOAD-BEARING: the retired parent-cap must stay gone. Before the
  // cross-boundary fix, installViewport tracked parent.visualViewport and capped
  // --app-h at min(own, parent). That was the wrong layer (gap below composer).
  // Now the host owns the resize, so the parent's vv MUST NOT influence --app-h.
  it("EMBEDDED: parent.visualViewport is NOT consulted (parent-cap retired)", () => {
    // Embed same-origin with a reachable parent.visualViewport (the exact
    // precondition the retired cap relied on). Shrink the parent's vv as if the
    // keyboard opened at the host level; the iframe's OWN vv stays 800 (the
    // iframe element has not resized in this synthetic jsdom scenario).
    parentWindow = { visualViewport: parentVV.target };
    installViewport();
    expect(appH(), "embedded initial --app-h is own height").toBe("800px");
    // Parent shrinks (host keyboard-open signal) — but installViewport no longer
    // watches it, so --app-h must NOT change.
    parentVV.setHeight(500);
    parentVV.fire("resize");
    parentVV.fire("scroll");
    expect(appH(), "parent shrink does NOT change --app-h (cap retired)").toBe("800px");
  });

  it("EMBEDDED cross-origin parent (no reachable vv): own-vv-only still works", () => {
    // A cross-origin parent throws on visualViewport access. installViewport
    // must not crash (it never touches the parent now) and keep tracking own.
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
