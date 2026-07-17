import { describe, expect, it } from "vitest";
import { msgTextOnly, msgTextWithThinking } from "../../src/lib/msgText";

// Build a MessageLike from an ordered list of [type, text] tuples — matches the
// { partOrder: string[]; parts: Record<string, any> } shape the helpers read
// (and the shape ChatView's old msgText consumed).
function msg(parts: [string, string][]): { partOrder: string[]; parts: Record<string, any> } {
  const partOrder: string[] = [];
  const map: Record<string, any> = {};
  parts.forEach(([type, text], i) => {
    const id = `p${i}`;
    map[id] = { id, type, text };
    partOrder.push(id);
  });
  return { partOrder, parts: map };
}

describe("msgTextOnly (left-click copy / retry target)", () => {
  it("drops reasoning parts and keeps only text", () => {
    const m = msg([
      ["text", "Hello"],
      ["reasoning", "secret deliberation"],
      ["text", "World"],
    ]);
    expect(msgTextOnly(m)).toBe("Hello\nWorld");
  });

  it("returns empty for a message with no text parts", () => {
    expect(msgTextOnly(msg([["reasoning", "only thinking"]]))).toBe("");
    expect(msgTextOnly(msg([]))).toBe("");
  });
});

describe("msgTextWithThinking (right-click copy target)", () => {
  it("wraps a single reasoning part in one <think>…</think>", () => {
    const m = msg([
      ["text", "Hello"],
      ["reasoning", "Let me consider…"],
      ["text", "World"],
    ]);
    expect(msgTextWithThinking(m)).toBe("Hello\n<think>Let me consider…</think>\nWorld");
  });

  it("wraps a run of CONSECUTIVE reasoning parts in a single wrapper, joined by newline", () => {
    const m = msg([
      ["text", "A"],
      ["reasoning", "r1"],
      ["reasoning", "r2"],
      ["text", "B"],
    ]);
    expect(msgTextWithThinking(m)).toBe("A\n<think>r1\nr2</think>\nB");
  });

  it("gives each non-contiguous reasoning run its own wrapper, preserving order", () => {
    const m = msg([
      ["text", "one"],
      ["reasoning", "think1"],
      ["text", "two"],
      ["reasoning", "think2a"],
      ["reasoning", "think2b"],
      ["text", "three"],
    ]);
    expect(msgTextWithThinking(m)).toBe(
      "one\n<think>think1</think>\ntwo\n<think>think2a\nthink2b</think>\nthree",
    );
  });

  it("wraps reasoning at the start and end of the message (no leading/trailing text)", () => {
    const m = msg([
      ["reasoning", "preamble"],
      ["text", "body"],
      ["reasoning", "epilogue"],
    ]);
    expect(msgTextWithThinking(m)).toBe("<think>preamble</think>\nbody\n<think>epilogue</think>");
  });

  it("a lone reasoning part with no surrounding text still gets its own wrapper", () => {
    expect(msgTextWithThinking(msg([["reasoning", "only thinking"]]))).toBe("<think>only thinking</think>");
  });
});

describe("text-only parity (retry unchanged)", () => {
  it("both helpers return identical output when there is no reasoning", () => {
    const m = msg([
      ["text", "alpha"],
      ["text", "beta"],
    ]);
    expect(msgTextOnly(m)).toBe("alpha\nbeta");
    expect(msgTextWithThinking(m)).toBe("alpha\nbeta");
  });

  it("empty message (no text/reasoning parts) yields empty string from both", () => {
    expect(msgTextOnly(msg([]))).toBe("");
    expect(msgTextWithThinking(msg([]))).toBe("");
  });

  it("ignores non-text/non-reasoning parts (e.g. tool-use) in both helpers", () => {
    const m = msg([
      ["text", "before"],
      ["tool", '{"command":"ls"}'],
      ["text", "after"],
    ]);
    expect(msgTextOnly(m)).toBe("before\nafter");
    expect(msgTextWithThinking(m)).toBe("before\nafter");
  });

  it("a tool part breaks a reasoning run into separate wrappers", () => {
    const m = msg([
      ["reasoning", "r1"],
      ["tool", "x"],
      ["reasoning", "r2"],
      ["text", "done"],
    ]);
    expect(msgTextWithThinking(m)).toBe("<think>r1</think>\n<think>r2</think>\ndone");
  });
});
