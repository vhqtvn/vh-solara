// @vitest-environment jsdom
//
// Pins the shared embed-gate seam (web/src/embedded.ts): isEmbedded() is the
// single source of truth for "this SPA document runs inside a parent frame
// (the host shell's iframe)". Direction only — false standalone (top window),
// true embedded (window.parent !== window) — using the same jsdom
// fake-parentage pattern as viewportEmbedParent.test.ts (a configurable getter
// on window.parent). The per-call/lazy aspect is exercised by reading the
// function's result AFTER swapping the parent, in the same test.
import { describe, it, expect, afterEach } from "vitest";
import { isEmbedded } from "../../src/embedded";

describe("isEmbedded — shared embed gate", () => {
  // Mutable fake parentage: the getter always reads the current value, so each
  // test (and re-reads within a test) sees its own arrangement.
  let parentWindow: unknown = window;
  const installParentGetter = () => {
    Object.defineProperty(window, "parent", {
      configurable: true,
      get: () => parentWindow,
    });
  };

  afterEach(() => {
    // Restore jsdom's original top-window parent (parent === window).
    parentWindow = window;
    installParentGetter();
  });

  it("standalone (top window): false", () => {
    parentWindow = window;
    installParentGetter();
    expect(isEmbedded()).toBe(false);
  });

  it("embedded (fake parent window): true", () => {
    const fakeParent = { postMessage: () => {} } as unknown as Window;
    parentWindow = fakeParent;
    installParentGetter();
    expect(isEmbedded()).toBe(true);
  });

  it("per-call evaluation: reflects the CURRENT parentage, not a cached value", () => {
    parentWindow = window;
    installParentGetter();
    expect(isEmbedded()).toBe(false);
    parentWindow = { postMessage: () => {} } as unknown as Window;
    expect(isEmbedded()).toBe(true);
  });
});
