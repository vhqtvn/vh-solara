// @vitest-environment jsdom
// TerminalDock height-drag seam under UI zoom (follow-up to fc2ef59d): the
// drag reads viewport-px inputs (pointermove clientY, window.innerHeight) but
// writes the dock's inline `height` style, which resolves in zoomed-layout px
// (UI zoom = CSS `zoom` on :root; see lib/zoom). The move handler must convert
// once via layoutPx so the dock edge tracks the cursor at any zoom. jsdom
// cannot apply CSS zoom — these tests pin the arithmetic of the applied style,
// not live rendering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { setTermOpen } from "../../src/ui";
import { loadVersioned } from "../../src/lib/store";

// The docked (resizable) desktop mode needs isDesktop()=true; layout.ts reads
// window.matchMedia at MODULE-LOAD time, so a desktop-true stub is installed
// via vi.hoisted BEFORE the component import graph is evaluated (mirrors
// ChatViewNavigator.test.tsx; the shared _matchMedia.ts is all-false and would
// force the full-screen mobile mode instead).
vi.hoisted(() => {
  const w = globalThis as unknown as { matchMedia?: unknown };
  w.matchMedia = (query: string) => ({
    matches: /721/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
});

// The pane statically imports @xterm/xterm (heavy, canvas-bound); it is
// irrelevant to the drag seam — stub it with an inert div.
vi.mock("../../src/components/TerminalPane", () => ({
  default: () => <div class="term-pane-stub" />,
}));

import TerminalDock from "../../src/components/TerminalDock";

function setUiZoom(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

beforeEach(() => {
  localStorage.clear();
  setTermOpen(true);
});

afterEach(() => {
  cleanup();
  setTermOpen(false);
  document.documentElement.style.removeProperty("--ui-zoom");
});

// Open the dock, drag the top resize handle to clientY, and return the
// dock's applied inline height (empty until Solid flushes the style).
async function dragToHeight(clientY: number): Promise<number> {
  expect([window.innerWidth, window.innerHeight]).toEqual([1024, 768]);
  const { container } = render(() => <TerminalDock />);
  const dock = container.querySelector<HTMLElement>(".term-dock");
  const handle = container.querySelector<HTMLElement>(".term-dock-resize");
  expect(dock).not.toBeNull();
  expect(handle).not.toBeNull(); // docked (not full-screen) desktop mode
  handle!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY }));
  window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  await waitFor(() => {
    expect(dock!.style.height).not.toBe("");
  });
  return parseFloat(dock!.style.height);
}

describe("TerminalDock height drag under UI zoom", () => {
  it("zoom 1 is the identity: 768 - 268 = 500px", async () => {
    const h = await dragToHeight(268);
    expect(h).toBeCloseTo(500, 3);
  });

  it("125%: converts clientY AND innerHeight to layout px (768/1.25 - 336/1.25 = 345.6)", async () => {
    setUiZoom("1.25");
    const h = await dragToHeight(336);
    expect(h).toBeCloseTo(345.6, 3);
    // The persisted value is the same converted layout px.
    expect(loadVersioned<number>("vh.term.height.v1", 1, 300)).toBeCloseTo(345.6, 3);
  });

  it("80%: scales up (960 - 420 = 540)", async () => {
    setUiZoom("0.8");
    const h = await dragToHeight(336);
    expect(h).toBeCloseTo(540, 3);
  });
});
