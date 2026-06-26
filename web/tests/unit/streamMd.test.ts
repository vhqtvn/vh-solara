// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { StreamMd } from "../../src/lib/streamMd";

function host(): HTMLDivElement {
  return document.createElement("div");
}

describe("StreamMd (incremental streaming markdown)", () => {
  it("renders a growing paragraph in place", () => {
    const h = host();
    const md = new StreamMd(h);
    md.push("Hello");
    expect(h.querySelector("p")?.textContent).toBe("Hello");
    md.push("Hello world");
    expect(h.querySelectorAll("p")).toHaveLength(1);
    expect(h.querySelector("p")?.textContent).toBe("Hello world");
  });

  it("keeps the SAME DOM node for a completed block (append, not rebuild)", () => {
    const h = host();
    const md = new StreamMd(h);
    // First block completes once the blank line + next block arrive.
    md.push("First paragraph.\n\nSecond");
    const first = h.querySelector("p");
    expect(first?.textContent).toBe("First paragraph.");
    // Keep streaming the second block; the first block's node must be untouched.
    md.push("First paragraph.\n\nSecond paragraph grows");
    const ps = h.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    expect(ps[0]).toBe(first); // identity preserved — completed block was not re-rendered
    expect(ps[1].textContent).toBe("Second paragraph grows");
  });

  it("promotes the active block to committed when a new block follows", () => {
    const h = host();
    const md = new StreamMd(h);
    md.push("- a\n- b"); // a single in-progress list
    expect(h.querySelectorAll("li")).toHaveLength(2);
    md.push("- a\n- b\n\nAfter the list"); // list finalizes, paragraph becomes active
    expect(h.querySelector("ul")).toBeTruthy();
    expect(h.querySelector("p")?.textContent).toBe("After the list");
  });

  it("streams a fenced code block as it grows", () => {
    const h = host();
    const md = new StreamMd(h);
    md.push("```js\nconst x");
    expect(h.querySelector("pre code")?.textContent).toContain("const x");
    md.push("```js\nconst x = 1;");
    expect(h.querySelector("pre code")?.textContent).toContain("const x = 1;");
  });

  it("strips dangerous link protocols", () => {
    const h = host();
    const md = new StreamMd(h);
    md.push("[click](javascript:alert(1))");
    const a = h.querySelector("a");
    expect(a?.getAttribute("href")).toBe("#");
  });

  it("resets cleanly if the prefix shrinks", () => {
    const h = host();
    const md = new StreamMd(h);
    md.push("First paragraph.\n\nSecond paragraph here");
    md.push("Totally"); // shorter than committedLen → start over
    expect(h.querySelectorAll("p")).toHaveLength(1);
    expect(h.querySelector("p")?.textContent).toBe("Totally");
  });
});
