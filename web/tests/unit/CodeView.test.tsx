// @vitest-environment jsdom
// Accessibility/security contract for CodeView's "download" links. Files that
// can't be previewed (binary / too-large) render an `<a target="_blank">` to the
// raw URL. `target="_blank"` without `rel="noopener"` lets the new tab reach back
// into `window.opener`; the safe form is `rel="noopener noreferrer"`.
//
// Mocks: CodeView reads projectDir() (sync), the open path/line (code/state),
// viewer prefs (prefs), and the code client (code/api). We stub all four so the
// component renders without the live-session graph or any network. The two
// non-preview Match branches (binary / toolarge) are exercised by flipping the
// shared `fileKind` between renders; both branches use the identical <a>
// template, so each is rendered and asserted independently.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

// vi.hoisted runs before the vi.mock factories below, so the code/api factory
// can close over the same `fileKind` object the tests mutate per render.
const fileKind = vi.hoisted(() => ({ kind: "binary" as "binary" | "toolarge" }));

vi.mock("../../src/sync", () => ({
  projectDir: () => "/repo",
}));

vi.mock("../../src/code/api", () => ({
  codeTree: async () => [],
  codeStatus: async () => ({}),
  codeLangs: async () => [],
  codeStyles: async () => ({ styles: [] }),
  codeSearch: async () => ({ hits: [], capped: false }),
  codeFile: async () => ({ kind: fileKind.kind, path: "x.bin", size: 2048 }),
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

afterEach(cleanup);

async function renderDownloadLink() {
  const { container } = render(() => <CodeView />);
  // The download <a> mounts once the `file` resource resolves to a non-preview
  // kind; wait for it to appear.
  await waitFor(() => {
    expect(container.querySelector('a[target="_blank"]')).not.toBeNull();
  });
  return container.querySelector<HTMLAnchorElement>('a[target="_blank"]');
}

describe("CodeView — download link rel", () => {
  it("binary file download link uses rel=noopener noreferrer", async () => {
    fileKind.kind = "binary";
    const link = await renderDownloadLink();
    expect(link).not.toBeNull();
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("too-large file download link uses rel=noopener noreferrer", async () => {
    fileKind.kind = "toolarge";
    const link = await renderDownloadLink();
    expect(link).not.toBeNull();
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
