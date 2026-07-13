// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  isPinned,
  togglePin,
  reconciledPinnedOrder,
  movePinnedTo,
  movePinnedByOffset,
  __resetPinnedForTest,
} from "../../src/sidebar";

// The pinned order model lives in sidebar.ts alongside the membership set. The
// set is the source of truth for membership; the order array only governs the
// display order within the pinned group. These tests cover the reconciliation
// invariant, the pin/unpin append/remove behavior, drag reorder persistence,
// and the lazy migration from a v1-only (no order array) store.

beforeEach(() => {
  localStorage.clear();
  __resetPinnedForTest();
});

function readOrderStore(): string[] {
  const raw = localStorage.getItem("vh.pinned-order.v1");
  if (!raw) return [];
  const env = JSON.parse(raw);
  return Array.isArray(env?.data) ? env.data : [];
}

describe("reconciledPinnedOrder", () => {
  it("returns an empty list when nothing is pinned", () => {
    expect(reconciledPinnedOrder()).toEqual([]);
  });

  it("preserves a persisted order for current members", () => {
    ["a", "b", "c"].forEach(togglePin);
    movePinnedTo("c", "a", "before"); // → [c, a, b]
    expect(reconciledPinnedOrder()).toEqual(["c", "a", "b"]);
  });

  it("drops stale ids (unpinned since last save)", () => {
    ["a", "b", "c"].forEach(togglePin); // order: [a, b, c]
    togglePin("b"); // unpin b → removed from set AND order
    expect(reconciledPinnedOrder()).toEqual(["a", "c"]);
  });

  it("appends unknown pinned members at the end (lazy migration)", () => {
    // Seed a v1-only store: membership present, NO order array.
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["a", "b", "c"] }));
    __resetPinnedForTest();
    // No order array → all members are "unknown" → appended in set-iteration
    // order, preserving the existing visual order until the user reorders.
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c"]);
    // No order array is written by a pure read.
    expect(localStorage.getItem("vh.pinned-order.v1")).toBeNull();
  });

  it("de-duplicates a corrupt order array with repeated ids", () => {
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["a", "b"] }));
    localStorage.setItem("vh.pinned-order.v1", JSON.stringify({ v: 1, data: ["a", "a", "b", "b"] }));
    __resetPinnedForTest();
    expect(reconciledPinnedOrder()).toEqual(["a", "b"]);
  });
});

describe("togglePin order behavior", () => {
  it("appends a newly pinned session to the end of the order", () => {
    togglePin("a");
    togglePin("b");
    togglePin("c");
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c"]);
    expect(isPinned("c")).toBe(true);
  });

  it("removes the session from the order on unpin", () => {
    ["a", "b", "c"].forEach(togglePin);
    togglePin("b");
    expect(reconciledPinnedOrder()).toEqual(["a", "c"]);
    expect(isPinned("b")).toBe(false);
  });

  it("re-pinning appends at the end (does not revive a stale position)", () => {
    ["a", "b", "c"].forEach(togglePin); // [a, b, c]
    togglePin("b"); // unpin → [a, c]
    togglePin("b"); // re-pin → append → [a, c, b]
    expect(reconciledPinnedOrder()).toEqual(["a", "c", "b"]);
    expect(isPinned("b")).toBe(true);
  });

  it("re-pinning a corrupt/stale entry appends fresh instead of reviving its stale position", () => {
    // Membership ["a"] (a is a real member) but a corrupt order ["b"] holds a
    // STALE entry for b (b absent from membership). Re-pinning b must drop the
    // stale b position and append b AFTER the true membership (a), not revive
    // b before a. Without the reconcile-then-append fix, raw pinnedOrder() keeps
    // b first and reconciliation appends a after it → ["b","a"].
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["a"] }));
    localStorage.setItem("vh.pinned-order.v1", JSON.stringify({ v: 1, data: ["b"] }));
    __resetPinnedForTest();
    togglePin("b");
    expect(reconciledPinnedOrder()).toEqual(["a", "b"]);
  });

  it("toggle (pin then unpin) leaves a clean empty state", () => {
    togglePin("a");
    togglePin("a");
    expect(reconciledPinnedOrder()).toEqual([]);
    expect(isPinned("a")).toBe(false);
    expect(readOrderStore()).toEqual([]);
  });
});

describe("movePinnedTo (drag reorder)", () => {
  it("moves before a target and persists to the order store", () => {
    ["a", "b", "c"].forEach(togglePin); // [a, b, c]
    movePinnedTo("c", "a", "before"); // [c, a, b]
    expect(reconciledPinnedOrder()).toEqual(["c", "a", "b"]);
    expect(readOrderStore()).toEqual(["c", "a", "b"]);
  });

  it("moves after a target", () => {
    ["a", "b", "c"].forEach(togglePin);
    movePinnedTo("a", "c", "after"); // [b, c, a]
    expect(reconciledPinnedOrder()).toEqual(["b", "c", "a"]);
  });

  it("is a no-op when dragged === target (no pointless write)", () => {
    ["a", "b", "c"].forEach(togglePin);
    movePinnedTo("b", "b", "before");
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c"]);
  });

  it("survives a reload (order rehydrates from the store)", () => {
    ["a", "b", "c"].forEach(togglePin);
    movePinnedTo("c", "a", "before"); // [c, a, b]
    // Simulate a fresh page load: re-import-time hydration is modeled by
    // __resetPinnedForTest re-reading the (still-populated) store.
    __resetPinnedForTest();
    expect(reconciledPinnedOrder()).toEqual(["c", "a", "b"]);
  });
});

// movePinnedByOffset is the keyboard/a11y reorder path (the context-menu "Move
// up / Move down" items). It clamps at the ends (no-op when already at the
// boundary being pushed past) and swaps one slot toward a neighbor otherwise.
describe("movePinnedByOffset (keyboard reorder)", () => {
  it("is a no-op when moving the first item up (clamped at the top)", () => {
    ["a", "b", "c"].forEach(togglePin); // [a, b, c]
    movePinnedByOffset("a", -1);
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c"]);
  });

  it("is a no-op when moving the last item down (clamped at the bottom)", () => {
    ["a", "b", "c"].forEach(togglePin);
    movePinnedByOffset("c", 1);
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c"]);
  });

  it("moves an item up one slot (swaps with the previous neighbor)", () => {
    ["a", "b", "c"].forEach(togglePin); // [a, b, c]
    movePinnedByOffset("b", -1); // b before a → [b, a, c]
    expect(reconciledPinnedOrder()).toEqual(["b", "a", "c"]);
  });

  it("moves an item down one slot (swaps with the next neighbor)", () => {
    ["a", "b", "c"].forEach(togglePin); // [a, b, c]
    movePinnedByOffset("b", 1); // b after c → [a, c, b]
    expect(reconciledPinnedOrder()).toEqual(["a", "c", "b"]);
  });

  it("is a no-op when the id is absent from the order", () => {
    ["a", "b"].forEach(togglePin);
    movePinnedByOffset("zzz", -1);
    expect(reconciledPinnedOrder()).toEqual(["a", "b"]);
  });
});
