// @vitest-environment jsdom
//
// Keyboard a11y for the ToolPart tool-head: it is a <div role="button"
// tabindex="0" onKeyDown={onActionKey(toggle)}>, so Enter/Space must toggle the
// part open/closed (WCAG 2.1.1 — this path was previously a native <button>'s
// default behavior). Also pins that the inner action spans (open-file /
// open-subsession) call stopPropagation via onActionKey, so activating one does
// NOT also bubble-toggle the head. The pure onActionKey contract is pinned
// separately in actionKey.test.ts; this proves the ToolPart wiring end-to-end.
//
// jsdom doesn't implement matchMedia, but Part.tsx → code/frame → layout calls
// window.matchMedia at module load. Import the shared stub BEFORE the component
// import is evaluated — see _matchMedia.ts.
import "./_matchMedia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import PartView, { partOpen, setPartOpen } from "../../src/components/Part";
import { openFileAt } from "../../src/code/frame";
import * as sync from "../../src/sync";
import type { Part } from "../../src/types";

// openFileAt (tool-open span) is side-effecting; openSession (tool-jump span) is
// async + talks to the daemon. Stub both so the test asserts the span activated
// without touching real plumbing. Everything else from sync stays real (the
// importOriginal spread preserves currentVerb/sessionNeedsInput/etc.).
vi.mock("../../src/code/frame", () => ({ openFileAt: vi.fn() }));
vi.mock("../../src/sync", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/sync")>();
  return { ...mod, openSession: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.mocked(openFileAt).mockClear();
  vi.mocked(sync.openSession).mockClear();
});

// Dispatch a keydown and return the event so a test can read defaultPrevented.
// cancelable:true is required for preventDefault() to flip defaultPrevented;
// bubbles:true so Solid's document-level delegated keydown listener receives it.
function keyDown(el: Element, key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

function head(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".tool-head");
  if (!el) throw new Error(".tool-head not rendered");
  return el as HTMLElement;
}

// bash with a command → expr() non-empty → hasDetail() true → head toggle armed.
function bashPart(): Part {
  return {
    id: "p1",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    tool: "bash",
    state: { status: "completed", input: { command: "ls -la" } },
  } as Part;
}

// read with a project-relative path → openableFile() resolves + expr() non-empty,
// so the tool-open span renders AND the head toggle is armed.
function readPart(): Part {
  return {
    id: "p2",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    tool: "read",
    state: { status: "completed", input: { filePath: "src/foo.go" } },
  } as Part;
}

// task with a child session + output → tool-jump span renders; output makes
// hasDetail() true so the head toggle is armed (proves stopPropagation matters).
function taskPart(): Part {
  return {
    id: "p3",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    tool: "task",
    state: { status: "completed", output: "subagent finished", metadata: { sessionId: "child-1" } },
  } as Part;
}

describe("ToolPart tool-head keyboard activation (role=button, WCAG 2.1.1)", () => {
  it("Enter toggles the part open, then closed again", () => {
    setPartOpen("p1", false);
    const { container } = render(() => <PartView part={bashPart()} settled={false} />);
    const h = head(container as unknown as HTMLElement);
    expect(partOpen["p1"]).toBeFalsy();

    keyDown(h, "Enter");
    expect(partOpen["p1"]).toBe(true);

    keyDown(h, "Enter");
    expect(partOpen["p1"]).toBe(false);
  });

  it("Space toggles open and prevents the default (page scroll)", () => {
    setPartOpen("p1", false);
    const { container } = render(() => <PartView part={bashPart()} settled={false} />);
    const ev = keyDown(head(container as unknown as HTMLElement), " ");
    expect(partOpen["p1"]).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("non-activation key does not toggle", () => {
    setPartOpen("p1", false);
    const { container } = render(() => <PartView part={bashPart()} settled={false} />);
    keyDown(head(container as unknown as HTMLElement), "a");
    expect(partOpen["p1"]).toBeFalsy();
  });
});

describe("ToolPart inner action spans — stopPropagation (no bubble to head toggle)", () => {
  it("Enter on the open-file span fires openFileAt WITHOUT toggling the head", () => {
    setPartOpen("p2", false);
    const { container } = render(() => <PartView part={readPart()} settled={false} />);
    const span = (container as unknown as HTMLElement).querySelector('[aria-label="Open in code view"]');
    if (!span) throw new Error("open-file span not rendered");

    keyDown(span, "Enter");
    expect(openFileAt).toHaveBeenCalledTimes(1);
    expect(openFileAt).toHaveBeenCalledWith("src/foo.go");
    // CRUX: the head toggle did NOT fire (onActionKey's stopPropagation held).
    expect(partOpen["p2"]).toBeFalsy();
  });

  it("Enter on the open-subsession span fires openSession WITHOUT toggling the head", () => {
    setPartOpen("p3", false);
    const { container } = render(() => <PartView part={taskPart()} settled={false} />);
    const span = (container as unknown as HTMLElement).querySelector('[aria-label="Open subsession"]');
    if (!span) throw new Error("open-subsession span not rendered");

    keyDown(span, "Enter");
    expect(sync.openSession).toHaveBeenCalledTimes(1);
    expect(sync.openSession).toHaveBeenCalledWith("child-1");
    // CRUX: the head toggle did NOT fire (onActionKey's stopPropagation held).
    expect(partOpen["p3"]).toBeFalsy();
  });
});
