// @vitest-environment jsdom
// TabBar priority+ overflow under UI zoom (zoom-drift cousin of fc2ef59d):
// measure() reads each item's natural width via getBoundingClientRect
// (viewport px under CSS `zoom` on :root; see lib/zoom) while the available
// width (clientWidth) and the GAP/MORE_W constants of the fits() comparison
// are zoomed-layout px. The fix converts each measured width once via
// layoutPx at the measure boundary, so the collapse decision is identical at
// every zoom. jsdom cannot apply CSS zoom; the seam under test is the fits()
// arithmetic on stubbed geometry (prototype-level gBCR width spy + clientWidth
// getter spy), never live rendering.
//
// Hand-derived fixture: 6 items × 100 layout-px natural width, avail = 560,
// GAP = 4, MORE_W = 40. Cumulative sums C(k) = 100k + 4(k−1):
//   fits(560) = 5 ≠ 6 → fits(520): C(5) = 516 ≤ 520 < C(6) = 620 → 5 visible + ⋯
// at every zoom once widths are converted. Unfixed drift (recorded here, not
// asserted): raw 125-px widths at 125% give C'(4) = 511 ≤ 520 < C'(5) = 639 →
// only 4 visible; raw 80-px widths at 80% give C''(6) = 500 ≤ 560 → fits(560)
// = 6 → all 6 "fit" (no ⋯ button; the row really overflows the container).
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import TabBar, { type TabItem } from "../../src/components/TabBar";

const AVAIL = 560; // wrapEl.clientWidth (layout px — clientWidth is NOT zoom-scaled)
const ITEM_LAYOUT_W = 100; // each tab's natural width in layout px

const ITEMS: TabItem[] = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, label: `Tab ${i}` }));

function setUiZoom(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

// Solid flushes reactive DOM updates via microtasks; a 0ms setTimeout returns
// only after the microtask queue (and TabBar's queueMicrotask(measure)) drains.
const flushMicro = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// The rendered row is the non-hidden `.seg`; the hidden measuring row (same
// `.tabbar-tab` buttons inside) carries aria-hidden="true".
function visibleTabs(container: HTMLElement): NodeListOf<HTMLButtonElement> {
  const row = container.querySelector<HTMLDivElement>('.seg:not([aria-hidden="true"])');
  expect(row).not.toBeNull();
  return row!.querySelectorAll("button");
}

describe("TabBar overflow collapse under UI zoom", () => {
  beforeEach(() => {
    localStorage.clear();
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    // Available space: clientWidth is a layout-px property under CSS zoom —
    // stub the getter at the prototype so onMount's setAvail reads the fixture.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(AVAIL);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty("--ui-zoom");
  });

  async function renderTabBar(zoom: number): Promise<HTMLElement> {
    setUiZoom(String(zoom));
    // gBCR reports viewport px: a real browser at UI zoom reports the 100
    // layout-px natural width as 100·zoom visual px.
    const w = ITEM_LAYOUT_W * zoom;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() =>
      ({ top: 0, left: 0, right: w, bottom: 0, width: w, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    const { container } = render(() => <TabBar items={() => ITEMS} active={() => "k0"} onSelect={() => {}} />);
    await flushMicro();
    return container;
  }

  it("zoom 1 is the identity: 5 of 6 tabs visible, 1 collapsed into the ⋯ menu", async () => {
    const container = await renderTabBar(1);
    expect(visibleTabs(container).length).toBe(5);
    expect(container.querySelector('button[aria-label="More views"]')).not.toBeNull();
  });

  it("125%: measured widths convert to layout px — 5 visible (raw viewport px would collapse to 4)", async () => {
    const container = await renderTabBar(1.25);
    expect(visibleTabs(container).length).toBe(5);
    expect(container.querySelector('button[aria-label="More views"]')).not.toBeNull();
  });

  it("80%: measured widths convert to layout px — 5 visible + ⋯ (raw viewport px would keep all 6 and overflow)", async () => {
    const container = await renderTabBar(0.8);
    expect(visibleTabs(container).length).toBe(5);
    expect(container.querySelector('button[aria-label="More views"]')).not.toBeNull();
  });
});
