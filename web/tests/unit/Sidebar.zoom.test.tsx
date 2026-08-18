// @vitest-environment jsdom
// Sidebar resize seam under UI zoom (fc2ef59d): the handle drag feeds
// setSidebarWidth(layoutPx(ev.clientX)) — pointer clientX is viewport px while
// the sidebar width is clamped + persisted in layout px (UI zoom = CSS `zoom`
// on :root; see lib/zoom). The width reaches the document via App's
// `--sidebar-w` effect (App.tsx — untouched by the campaign), so this test
// asserts the layout-store seam (sidebarWidth()) rather than that CSS var.
// jsdom cannot apply CSS zoom — arithmetic pin only, not live rendering.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
// jsdom lacks window.matchMedia (read at module-load time by layout.ts);
// install the shared all-false stub BEFORE the component import graph loads.
import "./_matchMedia";
import { setSidebarWidth, sidebarWidth } from "../../src/layout";
import Sidebar from "../../src/components/Sidebar";

function setUiZoom(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

beforeEach(() => {
  localStorage.clear();
  setSidebarWidth(320); // known start width (persisted; localStorage wiped)
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--ui-zoom");
});

// Grab the handle, drag its right edge to clientX, release. Listeners for
// move/up live on the handle itself (pointer capture), so both events are
// dispatched there.
function dragHandleTo(clientX: number) {
  expect([window.innerWidth, window.innerHeight]).toEqual([1024, 768]);
  const { container } = render(() => <Sidebar open={false} onClose={() => {}} />);
  const handle = container.querySelector<HTMLElement>(".sidebar-resize");
  expect(handle).not.toBeNull();
  handle!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  handle!.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX }));
  handle!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  expect(document.body.style.userSelect).toBe(""); // drag teardown ran
}

describe("Sidebar resize under UI zoom", () => {
  // All three zooms land on the same layout-px width: the viewport-px clientX
  // values are chosen as 360 × zoom, so the converted result is exactly 360
  // (inside the 200..480 clamp, so no clamping interferes).
  it("zoom 1 is the identity: clientX 360 → width 360", () => {
    dragHandleTo(360);
    expect(sidebarWidth()).toBe(360);
  });

  it("125%: clientX 450 → layout 360 (450/1.25)", () => {
    setUiZoom("1.25");
    dragHandleTo(450);
    expect(sidebarWidth()).toBe(360);
  });

  it("80%: clientX 288 → layout 360 (288/0.8, rounded by the clamp)", () => {
    setUiZoom("0.8");
    dragHandleTo(288);
    expect(sidebarWidth()).toBe(360);
  });
});
