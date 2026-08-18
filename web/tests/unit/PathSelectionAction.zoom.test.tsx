// @vitest-environment jsdom
// PathSelectionAction anchor under UI zoom (follow-up to fc2ef59d): the
// floating action's x/y come from the selection rect's getBoundingClientRect()
// (viewport px under zoom) while the button is position:fixed, whose left/top
// resolve in zoomed-layout px (UI zoom = CSS `zoom` on :root; see lib/zoom).
// The style boundary converts via layoutPx. jsdom cannot apply CSS zoom and
// has no real selection geometry — both are stubbed; these tests pin the
// arithmetic of the applied style, not live rendering.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
// jsdom lacks window.matchMedia (code/frame → layout.ts reads it at
// module-load time; the component's coarse() probe reads it at call time);
// install the shared all-false stub BEFORE the component import graph loads.
import "./_matchMedia";
import PathSelectionAction from "../../src/components/PathSelectionAction";

function setUiZoom(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

// Stub window.getSelection with a non-collapsed path-like selection whose
// range rect is the given viewport-px geometry.
function stubSelection(rect: { left: number; top: number; width: number; height: number }) {
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    toString: () => "/src/main.go",
    getRangeAt: () => ({ getBoundingClientRect: () => rect }),
  } as unknown as Selection);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--ui-zoom");
});

// Fire a selectionchange and resolve the floating button once it renders.
async function selectAndGetButton(): Promise<HTMLButtonElement> {
  const { container } = render(() => <PathSelectionAction />);
  document.dispatchEvent(new Event("selectionchange"));
  let btn: HTMLButtonElement | null = null;
  await waitFor(() => {
    btn = container.querySelector("button");
    expect(btn).not.toBeNull();
  });
  return btn!;
}

describe("PathSelectionAction anchor under UI zoom", () => {
  // Rect: left=400 top=300 width=200 → anchor x = left + width/2 = 500, y = top = 300.
  const rect = { left: 400, top: 300, width: 200, height: 16 };

  it("zoom 1 is the identity: 500px / 300px", async () => {
    stubSelection(rect);
    const btn = await selectAndGetButton();
    expect(parseFloat(btn.style.left)).toBeCloseTo(500, 3);
    expect(parseFloat(btn.style.top)).toBeCloseTo(300, 3);
  });

  it("125%: converts to layout px (500/1.25 = 400, 300/1.25 = 240)", async () => {
    setUiZoom("1.25");
    stubSelection(rect);
    const btn = await selectAndGetButton();
    expect(parseFloat(btn.style.left)).toBeCloseTo(400, 3);
    expect(parseFloat(btn.style.top)).toBeCloseTo(240, 3);
  });

  it("80%: scales up (500/0.8 = 625, 300/0.8 = 375)", async () => {
    setUiZoom("0.8");
    stubSelection(rect);
    const btn = await selectAndGetButton();
    expect(parseFloat(btn.style.left)).toBeCloseTo(625, 3);
    expect(parseFloat(btn.style.top)).toBeCloseTo(375, 3);
  });
});
