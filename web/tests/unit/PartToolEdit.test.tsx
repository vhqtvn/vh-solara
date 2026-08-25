// @vitest-environment jsdom
// jsdom doesn't implement matchMedia, but Part.tsx → code/frame → layout calls
// window.matchMedia at module load. Import the shared stub BEFORE the component
// import is evaluated — see _matchMedia.ts.
import "./_matchMedia";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import PartView from "../../src/components/Part";
import { EDIT_DIFF_MAX_LINES } from "../../src/components/ToolPart";
import type { Part } from "../../src/types";

// Edit/write tool contents (oldString/newString, or write content) render as a
// red/green preview INSIDE the tool row's disclosure body (ToolPart). The pure
// line-building is pinned by toolRender.test.ts (editDiffLines); this file pins
// the wiring: contents appear when the row is expanded, nothing renders while
// collapsed (the disclosure gate also bounds DOM for collapsed rows), and the
// truncation note surfaces for oversized blocks.
//
// Note: unit tests do NOT process CSS modules, so the scoped .tool-edit*
// classes can't be selected — assertions are text-level (the preview strings
// exist nowhere else in the row).

afterEach(cleanup);

function toolPart(id: string, tool: string, input: Record<string, unknown>, output: string): Part {
  return {
    id,
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    tool,
    state: { status: "completed", input, output },
  } as Part;
}

describe("ToolPart edit contents preview", () => {
  it("shows oldString/newString lines in the expanded disclosure body", () => {
    const part = toolPart(
      "edit-preview-1",
      "edit",
      { filePath: "src/parser.go", oldString: "func parse() {}", newString: "func parse(s string) {}" },
      "The file src/parser.go has been edited.",
    );
    // tail → the disclosure defaults open (hasDetail: expr=filePath + output).
    const { container } = render(() => <PartView part={part} tail />);
    const text = (container as unknown as HTMLElement).textContent!;
    const oldIdx = text.indexOf("func parse() {}");
    const newIdx = text.indexOf("func parse(s string) {}");
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeGreaterThan(oldIdx); // del block before add block
    expect(text).toContain("The file src/parser.go has been edited.");
  });

  it("shows a write's content lines when expanded", () => {
    const part = toolPart(
      "edit-preview-2",
      "write",
      { filePath: "src/new.go", content: "package main\n\nfunc f() {}" },
      "The file src/new.go has been created.",
    );
    const { container } = render(() => <PartView part={part} tail />);
    const text = (container as unknown as HTMLElement).textContent!;
    expect(text).toContain("package main");
    expect(text).toContain("func f() {}");
  });

  it("renders NO edit contents while the row is collapsed (disclosure gate)", () => {
    const part = toolPart(
      "edit-preview-3",
      "edit",
      { filePath: "src/parser.go", oldString: "func parse() {}", newString: "func parse(s string) {}" },
      "The file src/parser.go has been edited.",
    );
    // No tail → disclosure closed on mount; the preview must not be in the DOM.
    const { container } = render(() => <PartView part={part} />);
    const text = (container as unknown as HTMLElement).textContent!;
    expect(text).not.toContain("func parse() {}");
    expect(text).not.toContain("func parse(s string) {}");
    // The header subject (filePath) and nothing-else posture stay as before.
    expect(text).toContain("src/parser.go");
  });

  it("surfaces the '… N more lines' note for an oversized block at the default cap", () => {
    const bigOld = Array.from({ length: EDIT_DIFF_MAX_LINES + 10 }, (_, i) => `old line ${i}`).join("\n");
    const part = toolPart(
      "edit-preview-4",
      "edit",
      { filePath: "src/big.go", oldString: bigOld, newString: "replacement" },
      "The file src/big.go has been edited.",
    );
    const { container } = render(() => <PartView part={part} tail />);
    const text = (container as unknown as HTMLElement).textContent!;
    expect(text).toContain(`… 10 more lines`);
    // The kept head of the block renders; the omitted tail does not.
    expect(text).toContain("old line 0");
    expect(text).not.toContain(`old line ${EDIT_DIFF_MAX_LINES}`);
    // The small add block survives the del block's truncation (per-block cap).
    expect(text).toContain("replacement");
  });

  it("keeps a replaceAll edit's header note visible with the preview", () => {
    const part = toolPart(
      "edit-preview-5",
      "edit",
      { filePath: "src/a.go", oldString: "foo", newString: "bar", replaceAll: true },
      "The file src/a.go has been edited.",
    );
    const { container } = render(() => <PartView part={part} tail />);
    expect((container as unknown as HTMLElement).textContent).toContain("replaces every match");
  });

  // DEFER 2 (interaction path): a real click on the head of a NON-tail row
  // (disclosure starts closed) expands it and reveals the preview. The
  // browser-side expand is pinned end-to-end by tests/e2e/
  // tooledit-preview.spec.ts (incl. the scoped CSS classes, which Vitest
  // cannot see); this pins the component-level wiring (Solid event
  // delegation → toggle → setPartOpen → disclosure gate) in jsdom.
  it("reveals the preview when a collapsed non-tail row's head is clicked", () => {
    const part = toolPart(
      "edit-preview-6",
      "edit",
      { filePath: "src/parser.go", oldString: "func parse() {}", newString: "func parse(s string) {}" },
      "The file src/parser.go has been edited.",
    );
    const { container } = render(() => <PartView part={part} />);
    const el = container as unknown as HTMLElement;
    // No tail → disclosure closed on mount: no preview in the DOM.
    expect(el.textContent).not.toContain("func parse() {}");
    expect(el.textContent).not.toContain("func parse(s string) {}");
    const head = el.querySelector(".tool-head");
    expect(head).toBeTruthy();
    fireEvent.click(head!);
    // The same row now renders the del and add blocks (Solid's delegated
    // click flushes synchronously).
    expect(el.textContent).toContain("func parse() {}");
    expect(el.textContent).toContain("func parse(s string) {}");
    const text = el.textContent!;
    expect(text.indexOf("func parse() {}")).toBeLessThan(text.indexOf("func parse(s string) {}"));
  });
});
