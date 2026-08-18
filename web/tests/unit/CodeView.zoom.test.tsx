// @vitest-environment jsdom
// CodeView tree context-menu anchor under UI zoom (fc2ef59d): the dir row's
// onContextMenu stores the pointer's clientX/clientY (viewport px), and the
// fixed-position `.code-ctx` menu converts them via layoutPx for its left/top
// styles (zoomed-layout px; UI zoom = CSS `zoom` on :root; see lib/zoom).
// jsdom cannot apply CSS zoom — these tests pin the arithmetic of the applied
// style, not live rendering.
//
// Mocks mirror CodeView.test.tsx: sync (projectDir), the code client
// (code/api), shared code state, and viewer prefs — so the component renders
// without the live-session graph or any network. The tree returns a single
// top-level dir so the dir-row contextmenu path is reachable.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

const tree = vi.hoisted(() => [{ type: "dir", path: "src", name: "src" }]);

vi.mock("../../src/sync", () => ({
  projectDir: () => "/repo",
}));

vi.mock("../../src/code/api", () => ({
  codeTree: async () => tree,
  codeStatus: async () => ({}),
  codeLangs: async () => [],
  codeStyles: async () => ({ styles: [] }),
  codeSearch: async () => ({ hits: [], capped: false }),
  codeFile: async () => ({ kind: "binary", path: "x.bin", size: 2048 }),
  codeRawUrl: (p: string) => `/raw/${encodeURIComponent(p)}`,
}));

vi.mock("../../src/code/state", () => ({
  codeOpenPath: () => "/repo/x.bin",
  setCodeOpenPath: () => {},
  codeOpenLine: () => undefined,
  setCodeOpenLine: () => {},
  codeTabs: () => [],
  addCodeTab: () => {},
  closeCodeTab: () => {},
  resolvePicker: () => null,
  setResolvePicker: () => {},
  openResolved: () => {},
}));

vi.mock("../../src/prefs", () => ({
  codeStyle: () => "",
  setCodeStyle: () => {},
  codeWrap: () => false,
  setCodeWrap: () => {},
  codeShowIgnored: () => false,
  setCodeShowIgnored: () => {},
  codeFlatten: () => true,
  setCodeFlatten: () => {},
  codeShowSearch: () => false,
  setCodeShowSearch: () => {},
  codeSidebarOpen: () => true,
  setCodeSidebarOpen: () => {},
}));

import CodeView from "../../src/components/CodeView";

function setUiZoom(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--ui-zoom");
});

// Right-click the dir row at (x, y) and resolve the rendered ctx menu.
async function contextMenuAt(x: number, y: number): Promise<HTMLElement> {
  expect([window.innerWidth, window.innerHeight]).toEqual([1024, 768]);
  const { container } = render(() => <CodeView />);
  const row = await waitFor(() => {
    const r = container.querySelector<HTMLElement>(".code-tree-row.dir");
    expect(r).not.toBeNull(); // sidebar open + dir row rendered
    return r!;
  });
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  return waitFor(() => {
    const m = container.querySelector<HTMLElement>(".code-ctx");
    expect(m).not.toBeNull();
    return m!;
  });
}

describe("CodeView context menu under UI zoom", () => {
  it("zoom 1 is the identity: 400px / 300px", async () => {
    const menu = await contextMenuAt(400, 300);
    expect(parseFloat(menu.style.left)).toBeCloseTo(400, 3);
    expect(parseFloat(menu.style.top)).toBeCloseTo(300, 3);
  });

  it("125%: converts to layout px (400/1.25 = 320, 300/1.25 = 240)", async () => {
    setUiZoom("1.25");
    const menu = await contextMenuAt(400, 300);
    expect(parseFloat(menu.style.left)).toBeCloseTo(320, 3);
    expect(parseFloat(menu.style.top)).toBeCloseTo(240, 3);
  });

  it("80%: scales up (400/0.8 = 500, 300/0.8 = 375)", async () => {
    setUiZoom("0.8");
    const menu = await contextMenuAt(400, 300);
    expect(parseFloat(menu.style.left)).toBeCloseTo(500, 3);
    expect(parseFloat(menu.style.top)).toBeCloseTo(375, 3);
  });
});
