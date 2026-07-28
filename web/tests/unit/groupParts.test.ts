// @vitest-environment jsdom
//
// groupParts — characterization tests for the C2 extraction.
//
// groupParts is the PURE grouping helper extracted from ChatView into
// chat/MessageParts.tsx. It walks a message's `partOrder` and folds consecutive
// tool/reasoning parts into one "activity" timeline item, leaving text/file
// parts (and a lone reasoning with no tools) inline. The RenderItem.key is
// derived ONLY from part-id composition — never from part content — which is
// the streaming stability invariant: a growing token stream keeps identical
// keys token-to-token so MessageParts can reuse its row components.
//
// These tests pin that contract directly at the new module seam. groupParts
// itself is pure logic (no SolidJS), but importing it from MessageParts.tsx
// pulls the module graph through Spinner -> ... -> layout.ts, which reads
// window.matchMedia at module-load time. jsdom lacks matchMedia, so install the
// stub BEFORE any import that triggers layout.ts (vi.hoisted runs before ESM
// imports) — same shape as ChatViewPartlessMessage.test.tsx.
vi.hoisted(() => {
  if (!(window as any).matchMedia) {
    (window as any).matchMedia = (query: string) => ({
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

import { describe, expect, it, vi } from "vitest";
import { groupParts } from "../../src/components/chat/MessageParts";

// Minimal part factory — groupParts only reads .id and .type.
const part = (id: string, type: string) => ({ id, type });

// Build a message envelope from an ordered list of parts.
const msg = (...parts: any[]) => ({
  partOrder: parts.map((p) => p.id),
  parts: Object.fromEntries(parts.map((p) => [p.id, p])),
});

describe("groupParts — pure grouping + key-stability contract", () => {
  it("returns [] for a message with no partOrder / empty parts", () => {
    expect(groupParts({})).toEqual([]);
    expect(groupParts({ partOrder: [], parts: {} })).toEqual([]);
    // undefined partOrder is tolerated (the `|| []` guard).
    expect(groupParts({ parts: {} })).toEqual([]);
  });

  it("renders a single text part as an inline part with a p: key", () => {
    const items = groupParts(msg(part("p1", "text")));
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: "part", part: part("p1", "text"), key: "p:p1" });
  });

  it("preserves part order across mixed inline types (text/file)", () => {
    const items = groupParts(msg(part("p1", "text"), part("p2", "file")));
    expect(items.map((i) => i.kind)).toEqual(["part", "part"]);
    expect(items.map((i) => i.key)).toEqual(["p:p1", "p:p2"]);
  });

  it("folds consecutive tool/reasoning parts into ONE activity item with an a: key", () => {
    const items = groupParts(msg(part("p1", "tool"), part("p2", "reasoning")));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("activity");
    expect(items[0].key).toBe("a:p1,p2");
    expect((items[0] as any).parts.map((p: any) => p.id)).toEqual(["p1", "p2"]);
  });

  it("renders a LONE reasoning (no tool) as an inline part, not an activity", () => {
    // The run.length===1 && !hasTool branch: a solitary reasoning with no tool
    // companion collapses to an inline part (p: key).
    const items = groupParts(msg(part("r1", "reasoning")));
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: "part", part: part("r1", "reasoning"), key: "p:r1" });
  });

  it("renders a LONE tool as an activity group (run.length===1 but hasTool)", () => {
    // A solitary tool is still an activity (collapsed timeline), not inline.
    const items = groupParts(msg(part("t1", "tool")));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("activity");
    expect(items[0].key).toBe("a:t1");
  });

  it("splits activity runs at a non-tool/non-reasoning part", () => {
    // tool, reasoning  → activity run #1
    // text             → flush, inline
    // tool             → activity run #2
    const items = groupParts(
      msg(part("t1", "tool"), part("r1", "reasoning"), part("x1", "text"), part("t2", "tool")),
    );
    expect(items.map((i) => i.kind)).toEqual(["activity", "part", "activity"]);
    expect(items.map((i) => i.key)).toEqual(["a:t1,r1", "p:x1", "a:t2"]);
  });

  it("skips partOrder ids that are missing from the parts map", () => {
    // partOrder references p2, but parts only has p1 — p2 is skipped silently.
    const items = groupParts({ partOrder: ["p1", "p2"], parts: { p1: part("p1", "text") } });
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("p:p1");
  });

  describe("streaming key stability (HARD invariant)", () => {
    // The key set MUST depend ONLY on part-id composition (presence + order),
    // never on part content. A streaming turn appends text to an existing part
    // without changing its id, so the keys must remain identical token-to-token
    // — that is what lets MessageParts reuse its row components instead of
    // recreating them every token (no flashing/jumping).
    it("produces identical keys when a part's CONTENT grows but ids are unchanged", () => {
      const growing = (text: string) => ({
        partOrder: ["t1", "r1", "p1"],
        parts: {
          t1: { id: "t1", type: "tool", text },
          r1: { id: "r1", type: "reasoning", text },
          p1: { id: "p1", type: "text", text },
        },
      });
      const a = groupParts(growing("hi"));
      const b = groupParts(growing("hello world — a much longer streaming chunk"));
      expect(b.map((i) => i.key)).toEqual(a.map((i) => i.key));
      expect(a.map((i) => i.key)).toEqual(["a:t1,r1", "p:p1"]);
    });

    it("changes keys only when a part id is ADDED or REMOVED (not on content mutation)", () => {
      // Two parts → one activity. Adding a third part (t2) reshapes the key.
      const before = groupParts(msg(part("t1", "tool"), part("r1", "reasoning")));
      expect(before[0].key).toBe("a:t1,r1");
      const after = groupParts(msg(part("t1", "tool"), part("r1", "reasoning"), part("t2", "tool")));
      expect(after[0].key).toBe("a:t1,r1,t2");
    });
  });
});
