// @vitest-environment jsdom
// CodeView contracts for download + copy-content:
//
// - Every open file gets a toolbar Download anchor (`<a download>`) whose href
//   carries download=1 — the server's attachment-disposition + 1 GiB-cap path.
// - Binary / too-large files additionally render a pane Download anchor as the
//   primary action (these replaced the old `<a target="_blank">` links; the
//   same-origin download anchors never open a tab, so the old
//   rel="noopener noreferrer" contract is moot).
// - Copy content fetches the RAW source (never the chroma-highlighted DOM,
//   whose line spans lose structure) and writes it to the clipboard — also in
//   Rendered-markdown mode (kind "markdown").
//
// Mocks: CodeView reads projectDir() (sync), the open path/line (code/state),
// viewer prefs (prefs), and the code client (code/api). We stub all four so the
// component renders without the live-session graph or any network. fetch and
// navigator.clipboard are stubbed per-test for the copy-content path; the two
// non-preview Match branches (binary / toolarge) are exercised by flipping the
// shared `fileKind` between renders.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";

// vi.hoisted runs before the vi.mock factories below, so the code/api factory
// can close over the same `fileKind` object the tests mutate per render.
const fileKind = vi.hoisted(() => ({ kind: "binary" as "binary" | "toolarge" | "text" | "markdown" }));

vi.mock("../../src/sync", () => ({
  projectDir: () => "/repo",
}));

vi.mock("../../src/code/api", () => ({
  codeTree: async () => [],
  codeStatus: async () => ({}),
  codeLangs: async () => [],
  codeStyles: async () => ({ styles: [] }),
  codeSearch: async () => ({ hits: [], capped: false }),
  codeFile: async () => {
    if (fileKind.kind === "binary" || fileKind.kind === "toolarge") {
      return { kind: fileKind.kind, path: "x.bin", size: 2048 };
    }
    // text + markdown: the same source file; "markdown" is its Rendered view.
    return {
      kind: fileKind.kind, path: "x.txt", html: "<pre>highlighted html</pre>",
      lang: "text", lines: 2, highlighted: true, isMarkdown: fileKind.kind === "markdown",
    };
  },
  codeRawUrl: (p: string) => `/raw/${encodeURIComponent(p)}`,
  codeDownloadUrl: (p: string) => `/raw/${encodeURIComponent(p)}?download=1`,
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

// Clipboard + fetch stubs for the copy-content path (jsdom has neither).
const writeText = vi.fn(async () => {});
const fetchMock = vi.fn();

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  fetchMock.mockResolvedValue({ ok: true, text: async () => "line1\nline2\n" });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  writeText.mockClear();
});

async function renderView() {
  const { container } = render(() => <CodeView />);
  // The toolbar mounts once the `file` resource resolves (the Download anchor
  // is kind-independent, so waiting on it covers every fileKind).
  await waitFor(() => {
    expect(container.querySelector(".code-actions a[download]")).not.toBeNull();
  });
  return container;
}

describe("CodeView — download", () => {
  it("toolbar download anchor carries the download=1 URL", async () => {
    fileKind.kind = "text";
    const container = await renderView();
    const a = container.querySelector<HTMLAnchorElement>(".code-actions a[download]");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("/raw/%2Frepo%2Fx.bin?download=1");
    expect(a!.getAttribute("aria-label")).toBe("Download");
  });

  it("binary pane renders a Download anchor with download=1", async () => {
    fileKind.kind = "binary";
    const container = await renderView();
    const pane = container.querySelector<HTMLAnchorElement>(".code-pane a[download]");
    expect(pane).not.toBeNull();
    expect(pane!.getAttribute("href")).toContain("download=1");
  });

  it("too-large pane renders a Download anchor with download=1", async () => {
    fileKind.kind = "toolarge";
    const container = await renderView();
    const pane = container.querySelector<HTMLAnchorElement>(".code-pane a[download]");
    expect(pane).not.toBeNull();
    expect(pane!.getAttribute("href")).toContain("download=1");
  });
});

describe("CodeView — copy content", () => {
  it("fetches the raw URL and writes the exact source text to the clipboard", async () => {
    fileKind.kind = "text";
    await renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Copy content" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("line1\nline2\n"));
    expect(fetchMock).toHaveBeenCalledWith("/raw/%2Frepo%2Fx.bin");
  });

  it("copies the exact source in Rendered-markdown mode too", async () => {
    fileKind.kind = "markdown";
    await renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Copy content" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("line1\nline2\n"));
    expect(fetchMock).toHaveBeenCalledWith("/raw/%2Frepo%2Fx.bin");
  });

  it("writes nothing when the raw fetch fails", async () => {
    fileKind.kind = "text";
    await renderView();
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => "" });
    fireEvent.click(await screen.findByRole("button", { name: "Copy content" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Give the async !res.ok path a beat, then assert nothing was written.
    await new Promise((r) => setTimeout(r, 20));
    expect(writeText).not.toHaveBeenCalled();
  });
});
