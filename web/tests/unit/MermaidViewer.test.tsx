// @vitest-environment jsdom
//
// Coverage for MermaidViewer — inline presentation + full-viewport overlay with
// copy/download/expand/close/escape, focus management, scroll-lock, and the
// hardware/browser Back integration via the central back-stack manager (token
// entry pushed on open, popstate closes, explicit close consumes the entry).
// The real mermaid renderer is mocked so jsdom never loads the browser-bound
// lib. jsdom's history is replaced with a small fake (state stack) so the
// manager's current-entry checks observe real token state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

// Mock the mermaid renderer (hoisted). Returns a deterministic svg derived from
// the ORIGINAL src so tests can tell copy-source vs render-output apart.
vi.mock("../../src/lib/mermaid", () => ({
  renderMermaid: vi.fn(
    async (src: string) => `<svg data-mock>rendered:${src}</svg>`,
  ),
}));

// Per-test fresh module state (the module-level activeToken + back-stack
// singletons must reset between tests). Returns the mocked renderer + component.
async function fresh() {
  vi.resetModules();
  const { renderMermaid } = await import("../../src/lib/mermaid");
  const MermaidViewer = (await import("../../src/components/MermaidViewer"))
    .default;
  return {
    renderMermaid: renderMermaid as unknown as ReturnType<typeof vi.fn>,
    MermaidViewer,
  };
}

// jsdom Blob lacks .text(); read via FileReader.
function blobText(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result));
    fr.readAsText(b);
  });
}

const SRC = "graph TD\n    A --> B";

describe("MermaidViewer", () => {
  let pushStateSpy: ReturnType<typeof vi.spyOn>;
  let backSpy: ReturnType<typeof vi.spyOn>;
  let clipWrite: ReturnType<typeof vi.fn>;
  let createURLMock: ReturnType<typeof vi.fn>;
  // Fake history: a stack of {state} entries; history.state reads the top.
  let entries: { state: unknown }[];
  const firePop = () =>
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: entries[entries.length - 1].state }),
    );
  // Simulate a HARDWARE/browser Back (not manager-initiated): pop an entry and
  // deliver popstate — WITHOUT calling history.back().
  const hardwareBack = () => {
    if (entries.length > 1) entries.pop();
    firePop();
  };

  beforeEach(() => {
    entries = [{ state: null }];
    Object.defineProperty(window.history, "state", {
      configurable: true,
      get: () => entries[entries.length - 1].state,
    });
    pushStateSpy = vi
      .spyOn(history, "pushState")
      .mockImplementation((state) => void entries.push({ state }));
    vi.spyOn(history, "replaceState").mockImplementation(
      (state) => void (entries[entries.length - 1] = { state }),
    );
    backSpy = vi.spyOn(history, "back").mockImplementation(() => {
      if (entries.length > 1) entries.pop();
      // Manager-initiated traversals get their popstate synchronously (the real
      // browser delivers it async, but always AFTER back() returned — the
      // pendingTraversal flag is set before the call either way).
      firePop();
    });
    // navigator.clipboard + URL.createObjectURL are not implemented in jsdom;
    // install writable stubs.
    clipWrite = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipWrite },
      writable: true,
      configurable: true,
    });
    createURLMock = vi.fn(() => "blob:mock");
    Object.defineProperty(URL, "createObjectURL", {
      value: createURLMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    pushStateSpy.mockRestore();
    vi.spyOn(history, "replaceState").mockRestore();
    backSpy.mockRestore();
    delete (window.history as { state?: unknown }).state; // reveal jsdom getter
    cleanup();
  });

  // Helper: render + wait for the inline diagram svg to settle.
  async function renderReady(src = SRC) {
    const { MermaidViewer } = await fresh();
    const r = render(() => <MermaidViewer src={src} />);
    await waitFor(() => {
      expect(r.container.querySelector("[data-mermaid-diagram] svg")).toBeTruthy();
    });
    return r;
  }

  function inlineSvg(host: ParentNode): string {
    return host.querySelector("[data-mermaid-diagram] svg")?.outerHTML || "";
  }

  // Diagram svg inside the overlay only (avoids matching the inline diagrams,
  // which also carry data-mermaid-diagram and live in document.body).
  function overlayDiagram(): string {
    return (
      document.body
        .querySelector("[data-mermaid='overlay']")
        ?.querySelector("[data-mermaid-diagram] svg")?.outerHTML || ""
    );
  }

  it("renders the inline diagram and exposes copy/download/expand actions", async () => {
    const r = await renderReady();
    const inline = r.container.querySelector("[data-mermaid='inline']");
    expect(inline).toBeTruthy();
    expect(inlineSvg(r.container)).toContain("rendered:");
    const labels = Array.from(r.container.querySelectorAll("button")).map((b) =>
      (b.textContent || "").trim(),
    );
    expect(labels.some((l) => /copy/i.test(l))).toBe(true);
    expect(labels.some((l) => /download/i.test(l))).toBe(true);
    expect(labels.some((l) => /expand/i.test(l))).toBe(true);
  });

  it("expand opens exactly ONE overlay (Portal to <body>)", async () => {
    const r = await renderReady();
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /expand/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    expect(document.querySelectorAll("[data-mermaid='overlay']").length).toBe(1);
  });

  it("Close button closes the overlay", async () => {
    const r = await renderReady();
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /expand/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    const close = document.body.querySelector<HTMLButtonElement>(
      "button[aria-label='Close']",
    )!;
    fireEvent.click(close);
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull(),
    );
  });

  it("Escape closes the overlay", async () => {
    const r = await renderReady();
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /expand/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull(),
    );
  });

  it("focus moves into the viewer on open and returns to the Expand button on close", async () => {
    const r = await renderReady();
    const expand = Array.from(r.container.querySelectorAll("button")).find((b) =>
      /expand/i.test(b.textContent || ""),
    )!;
    expand.focus();
    expect(document.activeElement).toBe(expand);
    fireEvent.click(expand);
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    await waitFor(() => {
      const close = document.body.querySelector<HTMLButtonElement>(
        "button[aria-label='Close']",
      );
      expect(document.activeElement).toBe(close);
    });
    const close = document.body.querySelector<HTMLButtonElement>(
      "button[aria-label='Close']",
    )!;
    fireEvent.click(close);
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(expand));
  });

  it("copy ALWAYS uses the ORIGINAL mermaid source", async () => {
    const r = await renderReady();
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /copy/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() => expect(clipWrite).toHaveBeenCalled());
    expect(clipWrite).toHaveBeenCalledWith(SRC);
  });

  it("download uses the CURRENT rendered SVG", async () => {
    const r = await renderReady();
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /download/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() => expect(createURLMock).toHaveBeenCalled());
    const blob = createURLMock.mock.calls.at(-1)![0] as Blob;
    expect(await blobText(blob)).toBe(`<svg data-mock>rendered:${SRC}</svg>`);
  });

  it("only one viewer is open at a time (opening a second replaces the first)", async () => {
    const { MermaidViewer } = await fresh();
    const r = render(() => (
      <>
        <MermaidViewer src={"graph TD\n    A to B"} />
        <MermaidViewer src={"graph TD\n    C to D"} />
      </>
    ));
    await waitFor(() =>
      expect(r.container.querySelectorAll("[data-mermaid='inline']").length).toBe(2),
    );
    const expands = Array.from(r.container.querySelectorAll("button")).filter(
      (b) => /expand/i.test(b.textContent || ""),
    );
    expect(expands.length).toBe(2);
    fireEvent.click(expands[0]);
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    fireEvent.click(expands[1]);
    await waitFor(() => {
      expect(document.querySelectorAll("[data-mermaid='overlay']").length).toBe(1);
    });
    // the single overlay shows the SECOND diagram (the replacer)
    expect(overlayDiagram()).toContain("C to D");
    // the replacer REUSES the layer's token entry — exactly one push total
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
    // D1: the replacement opener keeps the body scroll-locked. The replaced
    // viewer's reactive teardown must NOT clear overflow while another overlay
    // is active (the gate is activeToken() === null AFTER setActiveToken).
    expect(document.body.style.overflow).toBe("hidden");
    // Close the remaining (replacer's) overlay and confirm the scroll-lock is
    // released only once no overlay is active.
    fireEvent.click(
      document.body.querySelector<HTMLButtonElement>("button[aria-label='Close']")!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull(),
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("open pushes ONE URL-transparent token entry (back-stack manager); location.search is unchanged", async () => {
    const r = await renderReady();
    const before = window.location.search;
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /expand/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() => expect(pushStateSpy).toHaveBeenCalled());
    const call = pushStateSpy.mock.calls.at(-1)!;
    // back-stack token state present (mermaid layer); url arg omitted
    // (URL-transparent)
    expect(call[0]).toMatchObject({ vhBack: expect.stringMatching(/^mermaid#/) });
    expect(call[2]).toBeUndefined();
    expect(window.location.search).toBe(before);
  });

  it("hardware/browser Back (popstate) closes the overlay without a further history.back", async () => {
    const r = await renderReady();
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /expand/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    backSpy.mockClear();
    // Hardware Back pops our entry and fires popstate (NOT via history.back).
    hardwareBack();
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull(),
    );
    // popstate path does NOT call history.back (entry already consumed by browser)
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("explicit Close/Escape consumes the token entry via history.back()", async () => {
    const r = await renderReady();
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /expand/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    fireEvent.click(
      document.body.querySelector<HTMLButtonElement>(
        "button[aria-label='Close']",
      )!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull(),
    );
    // the release schedules a microtask consume → history.back()
    await waitFor(() => expect(backSpy).toHaveBeenCalled());
    // and the consume landed back on the base entry
    await waitFor(() => expect(history.state).toBeNull());
  });

  it("forward onto the consumed (dead) token does NOT reopen the overlay", async () => {
    const r = await renderReady();
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /expand/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    // Back dismisses it…
    hardwareBack();
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull(),
    );
    // …then FORWARD re-lands on the dead token entry.
    entries.push({ state: { vhBack: "mermaid#dead" } });
    firePop();
    await new Promise((res) => setTimeout(res, 0));
    expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull();
  });

  it("popstate listener is removed on close (no leaks across repeated open/close)", async () => {
    const r = await renderReady();
    const expand = Array.from(r.container.querySelectorAll("button")).find((b) =>
      /expand/i.test(b.textContent || ""),
    )!;
    for (let i = 0; i < 2; i++) {
      fireEvent.click(expand);
      await waitFor(() =>
        expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
      );
      fireEvent.click(
        document.body.querySelector<HTMLButtonElement>(
          "button[aria-label='Close']",
        )!,
      );
      await waitFor(() =>
        expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull(),
      );
    }
    // After close, no popstate listener should fire: dispatching it must NOT
    // re-open the overlay and must not throw.
    expect(() =>
      window.dispatchEvent(new PopStateEvent("popstate")),
    ).not.toThrow();
    expect(document.body.querySelector("[data-mermaid='overlay']")).toBeNull();
  });

  it("overlay snapshot is stable: a resource refetch after open does not mutate the expanded view", async () => {
    const { MermaidViewer } = await fresh();
    // Reactive src so we can force a GENUINE createResource refetch. The old
    // test only swapped the renderMermaid mock, which never re-triggered the
    // resource — so it proved nothing more than "a string didn't change."
    const [src, setSrc] = createSignal(SRC);
    const r = render(() => <MermaidViewer src={src()} />);
    await waitFor(() =>
      expect(r.container.querySelector("[data-mermaid-diagram] svg")).toBeTruthy(),
    );
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /expand/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    const before = overlayDiagram();
    expect(before).toContain("rendered:");
    // Force a real refetch: a new src makes createResource re-resolve, so the
    // INLINE diagram genuinely updates to a different render…
    setSrc("graph TD\n    X to Y");
    await waitFor(() => expect(inlineSvg(r.container)).toContain("X to Y"));
    // …but the OVERLAY keeps its open-time snapshot (unchanged).
    expect(overlayDiagram()).toBe(before);
  });

  it("Tab is trapped inside the overlay (close → copy on Tab; copy → close on Shift+Tab)", async () => {
    const r = await renderReady();
    fireEvent.click(
      Array.from(r.container.querySelectorAll("button")).find((b) =>
        /expand/i.test(b.textContent || ""),
      )!,
    );
    await waitFor(() =>
      expect(document.body.querySelector("[data-mermaid='overlay']")).toBeTruthy(),
    );
    const overlay = document.body.querySelector<HTMLDivElement>(
      "[data-mermaid='overlay']",
    )!;
    // The overlay's focusable children in DOM order: copy, download, close.
    const copy = Array.from(overlay.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => /copy/i.test(b.textContent || ""),
    )!;
    const close = overlay.querySelector<HTMLButtonElement>("button[aria-label='Close']")!;
    // Focus the LAST focusable (close) and Tab → wraps to the FIRST (copy).
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: false });
    expect(document.activeElement).toBe(copy);
    // Shift+Tab from the FIRST (copy) → wraps to the LAST (close).
    fireEvent.keyDown(copy, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });
});
