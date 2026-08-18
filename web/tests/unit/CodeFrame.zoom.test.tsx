// @vitest-environment jsdom
// CodeFrame dock-resize seam under UI zoom (fc2ef59d): the drag computes the
// width delta from pointer clientX values (viewport px) and writes the dock's
// `flex-basis` style (zoomed-layout px; UI zoom = CSS `zoom` on :root; see
// lib/zoom) via setCodeDockWidth — both ends convert via layoutPx so the dock
// edge tracks the cursor at any zoom. jsdom cannot apply CSS zoom; the iframe
// never loads (jsdom does not fetch iframes), which is fine — the seam under
// test is the drag arithmetic on the applied style, not live rendering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { setCodeDockOpen } from "../../src/ui";
import { setCodeDockWidth } from "../../src/prefs";

// The dock (resizable side panel) is desktop-only: isDesktop() must be true.
// layout.ts reads window.matchMedia at MODULE-LOAD time, so a desktop-true
// stub is installed via vi.hoisted BEFORE the component import graph is
// evaluated (mirrors ChatViewNavigator.test.tsx; the shared _matchMedia.ts is
// all-false and would yield the hidden mobile mode instead).
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

import CodeFrame from "../../src/components/CodeFrame";

function setUiZoom(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

beforeEach(() => {
  localStorage.clear();
  setCodeDockOpen(true);
  setCodeDockWidth(400); // known start width (clamped 280..900)
});

afterEach(() => {
  cleanup();
  setCodeDockOpen(false);
  document.documentElement.style.removeProperty("--ui-zoom");
});

// Dock-on-right drag: dragging LEFT (clientX shrinking) widens the dock.
// pointerdown + the move/up listeners all live on the handle element.
async function dragHandle(downX: number, moveX: number): Promise<number> {
  expect([window.innerWidth, window.innerHeight]).toEqual([1024, 768]);
  const { container } = render(() => <CodeFrame />);
  const handle = await waitFor(() => {
    const h = container.querySelector<HTMLElement>(".code-dock-resize");
    expect(h).not.toBeNull(); // dock mode rendered (desktop + open + non-code view)
    return h!;
  });
  handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: downX }));
  handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: moveX }));
  handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  const dock = container.querySelector<HTMLElement>(".code-dock")!;
  await waitFor(() => {
    expect(dock.style.flexBasis).not.toBe("");
  });
  return parseFloat(dock.style.flexBasis);
}

describe("CodeFrame dock resize under UI zoom (side: right)", () => {
  it("zoom 1 is the identity: 600→500 widens 400 by 100 = 500px", async () => {
    const w = await dragHandle(600, 500);
    expect(w).toBeCloseTo(500, 3);
  });

  it("125%: dx is measured in layout px (480−400 = 80 → 480px)", async () => {
    setUiZoom("1.25");
    const w = await dragHandle(600, 500);
    expect(w).toBeCloseTo(480, 3);
  });

  it("80%: dx is measured in layout px (750−625 = 125 → 525px)", async () => {
    setUiZoom("0.8");
    const w = await dragHandle(600, 500);
    expect(w).toBeCloseTo(525, 3);
  });
});
