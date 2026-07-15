// @vitest-environment jsdom
// P2-WEB-002: CodeView's go-to-line affordance must use the in-app
// TextPromptDialog, never window.prompt. Asserts:
//   • window.prompt is NOT invoked when opening the dialog
//   • the TextPromptDialog mounts on trigger (input + role=dialog present)
//   • submitting a valid line number drives setCodeOpenLine (the scroll-target
//     setter) — including the force-retrigger undefined-then-n pair
//   • Cancel closes the dialog without driving the setter
//
// Mocks mirror CodeView.test.tsx (sync / code/api / code/state / prefs) but
// codeFile returns a TEXT file so the "Go to line" action button renders (it is
// gated on file()?.kind === "text"), and setCodeOpenLine is a vi.fn so calls
// can be asserted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

vi.mock("../../src/sync", () => ({ projectDir: () => "/repo" }));

vi.mock("../../src/code/api", () => ({
  codeTree: async () => [],
  codeStatus: async () => ({}),
  codeLangs: async () => [],
  codeStyles: async () => ({ styles: [] }),
  codeSearch: async () => ({ hits: [], capped: false }),
  // A real text file so the "Go to line" action button renders (gated on
  // file()?.kind === "text") and the code-content pane mounts.
  codeFile: async () => ({ kind: "text", path: "x.go", html: "<pre>line</pre>", highlighted: true, lang: "go" }),
  codeRawUrl: (p: string) => `/raw/${encodeURIComponent(p)}`,
}));

vi.mock("../../src/code/state", () => ({
  codeOpenPath: () => "/repo/x.go",
  setCodeOpenPath: () => {},
  codeOpenLine: () => undefined,
  setCodeOpenLine: vi.fn(() => {}),
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

import * as codeState from "../../src/code/state";
import CodeView from "../../src/components/CodeView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("CodeView — go-to-line uses in-app dialog, not window.prompt", () => {
  it("does not call window.prompt and mounts the TextPromptDialog on trigger", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const { container } = render(() => <CodeView />);

    // The Go-to-line button mounts once the text-file resource resolves
    // (button is gated on file()?.kind === "text").
    const btn = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('button[aria-label="Go to line"]');
      if (!b) throw new Error("go-to-line button not mounted");
      return b;
    });
    await fireEvent.click(btn);

    // TextPromptDialog renders in place: role=dialog + the prompt class + input.
    await waitFor(() => {
      expect(container.querySelector('.vh-prompt[role="dialog"]')).not.toBeNull();
      expect(container.querySelector(".vh-prompt-input")).not.toBeNull();
    });

    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("submitting a valid line number drives the scroll-target setter", async () => {
    const { container } = render(() => <CodeView />);

    const btn = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('button[aria-label="Go to line"]');
      if (!b) throw new Error("go-to-line button not mounted");
      return b;
    });
    await fireEvent.click(btn);

    const input = await waitFor(() => {
      const i = container.querySelector<HTMLInputElement>(".vh-prompt-input");
      if (!i) throw new Error("prompt input not mounted");
      return i;
    });
    await fireEvent.input(input, { target: { value: "42" } });
    const go = container.querySelector<HTMLButtonElement>(".confirm-go")!;
    await fireEvent.click(go);

    // The setter is called twice: first undefined (force-retrigger of the
    // scroll/highlight effect for repeated same-line requests), then the line.
    expect(codeState.setCodeOpenLine).toHaveBeenCalledWith(undefined);
    expect(codeState.setCodeOpenLine).toHaveBeenCalledWith(42);

    // Dialog closes after confirm.
    await waitFor(() => {
      expect(container.querySelector(".vh-prompt-input")).toBeNull();
    });
  });

  it("Cancel closes the dialog without driving the scroll-target setter", async () => {
    const { container } = render(() => <CodeView />);

    const btn = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('button[aria-label="Go to line"]');
      if (!b) throw new Error("go-to-line button not mounted");
      return b;
    });
    await fireEvent.click(btn);

    const input = await waitFor(() => {
      const i = container.querySelector<HTMLInputElement>(".vh-prompt-input");
      if (!i) throw new Error("prompt input not mounted");
      return i;
    });
    await fireEvent.input(input, { target: { value: "42" } });
    const cancel = container.querySelector<HTMLButtonElement>(".confirm-cancel")!;
    await fireEvent.click(cancel);

    // Cancel must not have driven a line target at all.
    expect(codeState.setCodeOpenLine).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(container.querySelector(".vh-prompt-input")).toBeNull();
    });
  });
});
