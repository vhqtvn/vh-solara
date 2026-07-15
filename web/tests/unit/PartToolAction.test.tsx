// @vitest-environment jsdom
// Integration test for the tool-row "Open in code view" action span: it poses as
// a button via `role="button" tabindex="0"`. Before the fix it had only onClick
// (keyboard-inoperable → WCAG 2.1.1); now onKeyDown fires the same action on
// Enter/Space. We render a real tool Part and drive the span's keydown to prove
// the wiring (the pure onActionKey contract is pinned separately in
// actionKey.test.ts).
//
// jsdom doesn't implement matchMedia, but Part.tsx → code/frame → layout calls
// window.matchMedia at module load. Install a minimal stub BEFORE the component
// import is evaluated (vi.hoisted runs ahead of static imports).
vi.hoisted(() => {
  const w = globalThis as unknown as { matchMedia?: unknown };
  if (!w.matchMedia) {
    w.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import PartView from "../../src/components/Part";
import { openFileAt } from "../../src/code/frame";
import type { Part } from "../../src/types";

// Keep the open-file side effect hermetic and observable. Part.tsx imports
// openFileAt from ../code/frame; we replace it with a spy so the test asserts
// the action fired with the right path without touching the real frame plumbing.
vi.mock("../../src/code/frame", () => ({ openFileAt: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(openFileAt).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// A completed read tool that touched a project-relative file → openableFile()
// resolves to "src/foo.go" (projectDir() is "" in the unconnected test store, so
// a relative path passes through), so the "Open in code view" span renders.
function toolPart(): Part {
  return {
    id: "p1",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    tool: "read",
    state: { status: "completed", input: { filePath: "src/foo.go" } },
  } as Part;
}

function openSpan(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[aria-label="Open in code view"]');
  if (!el) throw new Error('"Open in code view" action span not rendered');
  return el as HTMLElement;
}

// Dispatch a keydown and return the event so a test can read defaultPrevented.
// cancelable:true is required for preventDefault() to actually flip
// defaultPrevented (the action span's handler calls it to stop Space scrolling
// the page). bubbles:true so Solid's document-level delegated keydown listener
// receives it (Solid delegates events to the document root).
function keyDown(el: HTMLElement, key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

describe("ToolPart open-file action span — keyboard activation", () => {
  it("opens the file on Enter", () => {
    const { container } = render(() => <PartView part={toolPart()} settled={false} />);
    keyDown(openSpan(container as unknown as HTMLElement), "Enter");
    expect(openFileAt).toHaveBeenCalledTimes(1);
    expect(openFileAt).toHaveBeenCalledWith("src/foo.go");
  });

  it("opens the file on Space and prevents the default (page scroll)", () => {
    const { container } = render(() => <PartView part={toolPart()} settled={false} />);
    // preventDefault must have been called so Space doesn't scroll the page.
    const ev = keyDown(openSpan(container as unknown as HTMLElement), " ");
    expect(openFileAt).toHaveBeenCalledTimes(1);
    expect(openFileAt).toHaveBeenCalledWith("src/foo.go");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does not fire on a non-activation key", () => {
    const { container } = render(() => <PartView part={toolPart()} settled={false} />);
    keyDown(openSpan(container as unknown as HTMLElement), "a");
    expect(openFileAt).not.toHaveBeenCalled();
  });
});
