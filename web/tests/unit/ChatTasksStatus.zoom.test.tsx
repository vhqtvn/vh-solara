// @vitest-environment jsdom
// ChatTasksStatus popover-resize seam under UI zoom (fc2ef59d): the grip drag
// reads pointer clientX/clientY (viewport px) plus the popup's offsetWidth/
// offsetHeight (layout px) and window.innerHeight (viewport px), and writes
// the popup's width/height/maxHeight styles (zoomed-layout px; UI zoom = CSS
// `zoom` on :root; see lib/zoom) — the ingestion-side layoutPx conversions
// make the grip track the cursor at any zoom. jsdom reports 0 for offset*
// geometry, so those are stubbed per-element; it cannot apply CSS zoom —
// these tests pin the arithmetic of the applied styles, not live rendering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import ChatTasksStatus from "../../src/components/ChatTasksStatus";

// The component polls the server-authoritative subtree-todo rollup; stub it
// with a non-empty rollup so the Tasks pill (and thus the popover) renders.
vi.mock("../../src/subtreeTodos", () => ({
  fetchSubtreeTodos: async () => ({
    epoch: "e0",
    revision: 1,
    data: {
      sessionId: "s1",
      items: [],
      totals: { active: 2, left: 3, total: 5 },
    },
  }),
}));

function setUiZoom(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--ui-zoom");
});

const noopProps = {
  sessionId: "s1",
  working: () => false,
  verb: () => null,
  verbElapsed: () => "",
  workingAriaLabel: () => "idle",
};

// Open the popover and return its element with stubbed layout geometry
// (jsdom reports 0 for offsetWidth/offsetHeight; the drag reads them as the
// start size in layout px).
async function openPopup(w: number, h: number): Promise<{ popup: HTMLElement; grip: HTMLElement }> {
  expect([window.innerWidth, window.innerHeight]).toEqual([1024, 768]);
  const { container } = render(() => <ChatTasksStatus {...noopProps} />);
  const pill = await waitFor(() => {
    const p = container.querySelector<HTMLElement>(".tasks-pill");
    expect(p).not.toBeNull();
    return p!;
  });
  pill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const popup = await waitFor(() => {
    const p = container.querySelector<HTMLElement>(".tasks-popup");
    expect(p).not.toBeNull();
    return p!;
  });
  const grip = popup.querySelector<HTMLElement>(".tasks-resize")!;
  expect(grip).not.toBeNull();
  Object.defineProperty(popup, "offsetWidth", { configurable: true, value: w });
  Object.defineProperty(popup, "offsetHeight", { configurable: true, value: h });
  return { popup, grip };
}

// Grip drag: pointerdown at (downX, downY), one pointermove to (x, y), release.
// The move/up listeners live on window.
function dragGrip(grip: HTMLElement, downX: number, downY: number, x: number, y: number) {
  grip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: downX, clientY: downY }));
  window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
  window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
}

describe("ChatTasksStatus popover resize under UI zoom", () => {
  it("zoom 1 is the identity: 300+(500−280)=520 wide, 200+(450−250)=400 tall", async () => {
    const { popup, grip } = await openPopup(300, 200);
    dragGrip(grip, 500, 450, 280, 250);
    expect(parseFloat(popup.style.width)).toBeCloseTo(520, 3);
    expect(parseFloat(popup.style.height)).toBeCloseTo(400, 3);
    expect(parseFloat(popup.style.maxHeight)).toBeCloseTo(400, 3); // under the 0.72·innerHeight cap
  });

  it("125%: the delta is measured in layout px (w 476, h 360)", async () => {
    setUiZoom("1.25");
    const { popup, grip } = await openPopup(300, 200);
    dragGrip(grip, 500, 450, 280, 250); // 400,360 → 224,200 in layout px
    expect(parseFloat(popup.style.width)).toBeCloseTo(476, 3);
    expect(parseFloat(popup.style.height)).toBeCloseTo(360, 3);
    expect(parseFloat(popup.style.maxHeight)).toBeCloseTo(360, 3); // cap 442.368
  });

  it("80%: the delta is measured in layout px (w 475, h 350)", async () => {
    setUiZoom("0.8");
    const { popup, grip } = await openPopup(300, 200);
    dragGrip(grip, 500, 450, 360, 330); // 625,562.5 → 450,412.5 in layout px
    expect(parseFloat(popup.style.width)).toBeCloseTo(475, 3);
    expect(parseFloat(popup.style.height)).toBeCloseTo(350, 3);
    expect(parseFloat(popup.style.maxHeight)).toBeCloseTo(350, 3); // cap 691.2
  });
});
