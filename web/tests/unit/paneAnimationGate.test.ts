// @vitest-environment jsdom
//
// (webperf paint slice 3) Host-hidden pane ANIMATION GATE.
//
// CONTRACT under test (the hidden-pane refresh-driver fix):
//   1. installPaneAnimationGate() toggles PANE_HIDDEN_CLASS on
//      document.documentElement whenever paneVisible() flips — including the
//      host-hidden transition where document.visibilityState STAYS "visible"
//      (the cross-origin iframe gap: the host hides workspaces with
//      visibility:hidden, which the iframe cannot observe by itself).
//   2. The gate is idempotent (double install does not double-subscribe) and
//      applies the CURRENT state on install, not just future transitions.
//   3. The CSS side of the contract exists and names the same class: tokens.css
//      must carry a `.pane-hidden` rule that pauses (not removes) animations
//      via animation-play-state, with !important so inline styles cannot
//      outrank it. (The TS toggle and the CSS rule are two halves of one
//      mechanism — this keeps them from silently drifting apart.)
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let paneVis: typeof import("../../src/paneVisibility") = null as unknown as typeof import("../../src/paneVisibility");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  document.documentElement.className = "";
  paneVis = await import("../../src/paneVisibility");
  paneVis.__resetPaneVisibilityForTest(true, true);
}

beforeEach(setupFresh);
afterEach(() => {
  document.documentElement.className = "";
});

describe("installPaneAnimationGate", () => {
  it("applies no class while the pane is visible", () => {
    paneVis.installPaneAnimationGate();
    expect(document.documentElement.classList.contains(paneVis.PANE_HIDDEN_CLASS)).toBe(false);
  });

  it("adds .pane-hidden when the HOST hides the pane (document stays visible)", () => {
    paneVis.installPaneAnimationGate();
    paneVis.__setHostVisibleForTest(false);
    expect(document.documentElement.classList.contains(paneVis.PANE_HIDDEN_CLASS)).toBe(true);
    paneVis.__setHostVisibleForTest(true);
    expect(document.documentElement.classList.contains(paneVis.PANE_HIDDEN_CLASS)).toBe(false);
  });

  it("adds .pane-hidden when the document itself is hidden", () => {
    paneVis.installPaneAnimationGate();
    paneVis.__resetPaneVisibilityForTest(true, false);
    // __reset clears listeners; re-install to re-apply current state (the
    // production wiring always has the gate subscribed before any change).
    paneVis.installPaneAnimationGate();
    expect(document.documentElement.classList.contains(paneVis.PANE_HIDDEN_CLASS)).toBe(true);
  });

  it("applies the CURRENT hidden state at install time (not only transitions)", () => {
    paneVis.__setHostVisibleForTest(false);
    paneVis.installPaneAnimationGate();
    expect(document.documentElement.classList.contains(paneVis.PANE_HIDDEN_CLASS)).toBe(true);
  });

  it("is idempotent — a second install does not duplicate listeners or reset the class", () => {
    paneVis.installPaneAnimationGate();
    paneVis.installPaneAnimationGate();
    paneVis.__setHostVisibleForTest(false);
    paneVis.__setHostVisibleForTest(true);
    paneVis.__setHostVisibleForTest(false);
    expect(document.documentElement.classList.contains(paneVis.PANE_HIDDEN_CLASS)).toBe(true);
    expect(document.documentElement.className.match(/pane-hidden/g)?.length).toBe(1);
  });
});

describe("pane-hidden CSS contract (tokens.css)", () => {
  const css = readFileSync(resolve(__dirname, "../../src/styles/foundation/tokens.css"), "utf8");

  it("names the exact class the TS gate toggles", () => {
    expect(css).toContain(`:root.${paneVis.PANE_HIDDEN_CLASS}`);
  });

  it("PAUSES animations (play-state), does not remove them, and uses !important", () => {
    const m = css.match(/:root\.pane-hidden[^{]*\{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("animation-play-state: paused !important");
    expect(m![0]).not.toContain("animation: none");
  });
});
