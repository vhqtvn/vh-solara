import { describe, expect, it } from "vitest";
import { moveItem, reorderRelative } from "../../src/lib/dragReorder";

describe("moveItem", () => {
  it("moves an item forward (from < to)", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item backward (from > to)", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves to the first and last positions", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("returns an equal copy (no reorder) when from === to", () => {
    const src = ["a", "b", "c"];
    const out = moveItem(src, 1, 1);
    expect(out).toEqual(["a", "b", "c"]);
    expect(out).not.toBe(src); // new array, input untouched
  });

  it("returns a copy unchanged for out-of-range indices", () => {
    expect(moveItem(["a", "b"], -1, 0)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const src = ["a", "b", "c"];
    moveItem(src, 0, 2);
    expect(src).toEqual(["a", "b", "c"]);
  });

  it("handles a single-element array", () => {
    expect(moveItem(["solo"], 0, 0)).toEqual(["solo"]);
  });
});

describe("reorderRelative", () => {
  it("drops dragged BEFORE the target", () => {
    // c moved to before a → [c, a, b]
    expect(reorderRelative(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
  });

  it("drops dragged AFTER the target", () => {
    // c moved to after a → [a, c, b]
    expect(reorderRelative(["a", "b", "c"], "c", "a", "after")).toEqual(["a", "c", "b"]);
  });

  it("before/after at the list ends", () => {
    // a before c → [a, c] (a is already before c, but the operation is still
    // well-defined: remove a, insert before c)
    expect(reorderRelative(["a", "b", "c"], "a", "c", "before")).toEqual(["b", "a", "c"]);
    // a after c (last) → c becomes last position, a lands just past it → [...c, a]
    expect(reorderRelative(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
  });

  it("drops after the last item by landing at the append position", () => {
    // b after c, where c is last → [a, c, b]
    expect(reorderRelative(["a", "b", "c"], "b", "c", "after")).toEqual(["a", "c", "b"]);
  });

  it("is a no-op (equal copy) when dragged === target", () => {
    const src = ["a", "b", "c"];
    const out = reorderRelative(src, "a", "a", "before");
    expect(out).toEqual(["a", "b", "c"]);
    expect(out).not.toBe(src);
  });

  it("is a no-op (equal copy) when dragged or target is absent", () => {
    const src = ["a", "b", "c"];
    expect(reorderRelative(src, "x", "a", "before")).toEqual(["a", "b", "c"]);
    expect(reorderRelative(src, "a", "x", "after")).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const src = ["a", "b", "c"];
    reorderRelative(src, "a", "c", "before");
    expect(src).toEqual(["a", "b", "c"]);
  });

  it("moves an item adjacent to itself without dropping it", () => {
    // b before c where b is immediately before c — still produces a full list.
    expect(reorderRelative(["a", "b", "c"], "b", "c", "before")).toEqual(["a", "b", "c"]);
    expect(reorderRelative(["a", "b", "c"], "c", "b", "after")).toEqual(["a", "b", "c"]);
  });
});
