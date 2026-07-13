// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { setState, setSelectedIdRaw } from "../../src/sync/store";
import type { Session } from "../../src/types";
import SessionTree, { __resetTreeForTest } from "../../src/components/SessionTree";
import { __resetPinnedForTest } from "../../src/sidebar";

// Coverage for the pointer-event WIRING of the pinned-reorder drag (threshold
// gate, nearest-center hit-test, pointercancel path, body-style reset). The
// reorder math + persistence are already covered in sidebar.test.ts; this file
// drives the REAL pointer lifecycle through startPinnedDrag (SessionTree.tsx),
// which addEventListener's pointermove/up/cancel on the .tree-drag handle span.
//
// jsdom has NO layout engine — getBoundingClientRect returns all-zeros (see
// a11y.test.ts) — so a gesture test MUST stage rects for the [data-pinned-id]
// rows before dispatching moves, otherwise computeDrop can never resolve a
// target. This file establishes that harness (stageRects + firePointer).

// Stage vertical rects for the pinned rows keyed by their data-pinned-id. Every
// other element gets a zero rect (the jsdom default), so this only affects the
// reorder hit-test. Returns the spy so callers may restore early if needed;
// afterEach also runs vi.restoreAllMocks().
function stageRects(map: Record<string, { top: number; height: number }>) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const id = this.getAttribute("data-pinned-id");
    if (id && map[id]) {
      const { top, height } = map[id];
      return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect;
    }
    return { top: 0, height: 0, bottom: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
}

// Dispatch a pointer-type event on an element. This jsdom build exposes no
// global PointerEvent constructor, but startPinnedDrag only reads clientY +
// pointerId (pointerId feeds setPointerCapture/releasePointerCapture, both jsdom
// no-ops), and event listeners key on the TYPE string — so a MouseEvent carrying
// a pointerId field, dispatched with the pointer* type, drives the raw
// addEventListener listeners (pointermove/up/cancel on the handle span) and
// Solid's delegated pointerdown identically to a real PointerEvent. bubbles:true
// so Solid's document-root delegation catches pointerdown; currentTarget
// resolves to the .tree-drag span the gesture listens on.
function firePointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientY: number,
  pointerId = 1,
) {
  const ev = new MouseEvent(type, { clientY, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "pointerId", { value: pointerId, configurable: true });
  el.dispatchEvent(ev);
}

beforeEach(() => {
  // Mirror the SessionTree.test.tsx harness so the store/tree/pinned module
  // signals are clean per case.
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("unread", reconcile({}));
  setSelectedIdRaw(null);
  localStorage.clear();
  __resetTreeForTest();
  __resetPinnedForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function putSession(s: Session): void {
  setState("sessions", s.id, s);
}

function seedVersioned(key: string, data: unknown) {
  localStorage.setItem(key, JSON.stringify({ v: 1, data }));
}

function readOrderStore(): string[] {
  const raw = localStorage.getItem("vh.pinned-order.v1");
  if (!raw) return [];
  const env = JSON.parse(raw);
  return Array.isArray(env?.data) ? env.data : [];
}

// The drag handle lives inside the row container: .tree-row[data-pinned-id] > .tree-drag.
function handleFor(container: HTMLElement, id: string): HTMLElement {
  const h = container.querySelector(`.tree-row[data-pinned-id="${id}"] .tree-drag`);
  if (!h) throw new Error(`no drag handle for pinned root ${id}`);
  return h as HTMLElement;
}

describe("startPinnedDrag gesture (pointer lifecycle)", () => {
  // (1) Full drag commits a reorder via movePinnedTo. The staged rects drive the
  // nearest-center hit-test: source = row a, dragged down past b's center and
  // into c's top half, resolves to drop {id:c, pos:before}, which reorders
  // [a,b,c] → [b,a,c] (a real swap — not a vacuous same-order write).
  it("commits the reorder on a full drag (threshold → hit-test → drop)", async () => {
    putSession({ id: "a", title: "A", time: { updated: 1 } });
    putSession({ id: "b", title: "B", time: { updated: 2 } });
    putSession({ id: "c", title: "C", time: { updated: 3 } });
    seedVersioned("vh.pinned.v1", ["a", "b", "c"]);
    seedVersioned("vh.pinned-order.v1", ["a", "b", "c"]);
    __resetPinnedForTest();

    const { container } = render(() => <SessionTree />);
    // Wait until the pinned section renders all three drag handles.
    await waitFor(() => {
      expect(container.querySelectorAll(".tree-drag").length).toBe(3);
    });

    // Each row 40px tall, stacked: a=[0,40), b=[40,80), c=[80,120). a is the
    // source (excluded by computeDrop); b.center=60, c.center=100.
    stageRects({ a: { top: 0, height: 40 }, b: { top: 40, height: 40 }, c: { top: 80, height: 40 } });

    const handle = handleFor(container as unknown as HTMLElement, "a");
    firePointer(handle, "pointerdown", 20); // startY = 20
    // One move past the 4px threshold AND into c's top half: clientY=90 →
    // dist to c.center(100)=10 < dist to b.center(60)=30 → {c, before}.
    firePointer(handle, "pointermove", 90);

    // Drag engaged: source row flagged dragging, target row flagged drop-before,
    // body cursor switched to grabbing. waitFor because Solid effects are async.
    await waitFor(() => {
      expect(container.querySelector('.tree-row[data-pinned-id="a"]')?.classList.contains("dragging")).toBe(true);
    });
    expect(container.querySelector('.tree-row[data-pinned-id="c"]')?.classList.contains("drop-before")).toBe(true);
    expect(document.body.style.cursor).toBe("grabbing");

    // pointerup → finish() → movePinnedTo(a, c, before): [a,b,c] → [b,a,c].
    firePointer(handle, "pointerup", 90);
    expect(readOrderStore()).toEqual(["b", "a", "c"]);
  });

  // (2) Sub-threshold movement never engages the drag, so pointerup commits
  // nothing and body styles are left untouched.
  it("does not drag or write on a sub-threshold move then pointerup", async () => {
    putSession({ id: "a", title: "A", time: { updated: 1 } });
    putSession({ id: "b", title: "B", time: { updated: 2 } });
    seedVersioned("vh.pinned.v1", ["a", "b"]);
    seedVersioned("vh.pinned-order.v1", ["a", "b"]);
    __resetPinnedForTest();

    const { container } = render(() => <SessionTree />);
    await waitFor(() => {
      expect(container.querySelectorAll(".tree-drag").length).toBe(2);
    });
    stageRects({ a: { top: 0, height: 40 }, b: { top: 40, height: 40 } });

    const handle = handleFor(container as unknown as HTMLElement, "a");
    firePointer(handle, "pointerdown", 20);
    firePointer(handle, "pointermove", 22); // 2px — below the 4px threshold

    expect(container.querySelector('.tree-row[data-pinned-id="a"]')?.classList.contains("dragging")).toBe(false);
    expect(document.body.style.cursor).toBe("");

    firePointer(handle, "pointerup", 22);
    expect(readOrderStore()).toEqual(["a", "b"]);
    expect(container.querySelector('.tree-row[data-pinned-id="a"]')?.classList.contains("dragging")).toBe(false);
  });

  // (3) pointercancel on an ENGAGED drag (dragId WAS set, body cursor WAS
  // grabbing) resets the gesture and commits nothing. The cancel path is now
  // distinct (cancel() → cleanup() with no movePinnedTo); this case stages a
  // single pinned root so it additionally exercises cancel hygiene when no drop
  // target exists (computeDrop → null). The multi-root case — cancel over a
  // hovered target — is covered by case (5) below.
  it("pointercancel resets an engaged drag with no commit", async () => {
    putSession({ id: "solo", title: "Solo", time: { updated: 1 } });
    seedVersioned("vh.pinned.v1", ["solo"]);
    seedVersioned("vh.pinned-order.v1", ["solo"]);
    __resetPinnedForTest();

    const { container } = render(() => <SessionTree />);
    await waitFor(() => {
      expect(container.querySelectorAll(".tree-drag").length).toBe(1);
    });
    stageRects({ solo: { top: 0, height: 40 } });

    const handle = handleFor(container as unknown as HTMLElement, "solo");
    firePointer(handle, "pointerdown", 20);
    firePointer(handle, "pointermove", 90); // past threshold → engaged; no target row → dropTarget null

    expect(container.querySelector('.tree-row[data-pinned-id="solo"]')?.classList.contains("dragging")).toBe(true);
    expect(document.body.style.cursor).toBe("grabbing");

    firePointer(handle, "pointercancel", 90); // shared finish(): drop null → no commit
    expect(readOrderStore()).toEqual(["solo"]);
    expect(container.querySelector('.tree-row[data-pinned-id="solo"]')?.classList.contains("dragging")).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });

  // (4) Body userSelect + cursor are restored after finish(). The engaged move
  // sets them to "none"/"grabbing"; the shared finish path resets both back to
  // the pre-drag values.
  it("restores body userSelect and cursor after finish()", async () => {
    putSession({ id: "a", title: "A", time: { updated: 1 } });
    putSession({ id: "b", title: "B", time: { updated: 2 } });
    seedVersioned("vh.pinned.v1", ["a", "b"]);
    seedVersioned("vh.pinned-order.v1", ["a", "b"]);
    __resetPinnedForTest();

    const { container } = render(() => <SessionTree />);
    await waitFor(() => {
      expect(container.querySelectorAll(".tree-drag").length).toBe(2);
    });
    stageRects({ a: { top: 0, height: 40 }, b: { top: 40, height: 40 } });

    const handle = handleFor(container as unknown as HTMLElement, "a");
    const beforeUser = document.body.style.userSelect; // jsdom default: ""
    const beforeCursor = document.body.style.cursor;

    firePointer(handle, "pointerdown", 20);
    firePointer(handle, "pointermove", 50); // past threshold + over b → engaged
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("grabbing");

    firePointer(handle, "pointerup", 50);
    expect(document.body.style.userSelect).toBe(beforeUser);
    expect(document.body.style.cursor).toBe(beforeCursor);
  });

  // (5) pointercancel mid-drag over a HOVERED target must NOT commit. case (3)
  // sidestepped this by using a single root so computeDrop returned null. Here
  // we stage three roots so computeDrop resolves a real {id,pos}, engage the
  // drag, then dispatch pointercancel (NOT pointerup). The reorder must be
  // dropped on the floor while all exit-path hygiene (dragId/body) still runs.
  // This is the discriminator: with the old shared finish(), cancel would commit
  // movePinnedTo("a","c","before") → ["b","a","c"]; the dedicated cancel path
  // leaves the order untouched at ["a","b","c"].
  it("pointercancel over a hovered target does not commit (multi-root)", async () => {
    putSession({ id: "a", title: "A", time: { updated: 1 } });
    putSession({ id: "b", title: "B", time: { updated: 2 } });
    putSession({ id: "c", title: "C", time: { updated: 3 } });
    seedVersioned("vh.pinned.v1", ["a", "b", "c"]);
    seedVersioned("vh.pinned-order.v1", ["a", "b", "c"]);
    __resetPinnedForTest();

    const { container } = render(() => <SessionTree />);
    await waitFor(() => {
      expect(container.querySelectorAll(".tree-drag").length).toBe(3);
    });
    stageRects({
      a: { top: 0, height: 40 },
      b: { top: 40, height: 40 },
      c: { top: 80, height: 40 },
    });

    const handle = handleFor(container as unknown as HTMLElement, "a");
    firePointer(handle, "pointerdown", 20); // grab row a (mid-height)
    firePointer(handle, "pointermove", 90); // past threshold, over c's top half
    // Sanity: the gesture genuinely engaged and resolved a real drop target.
    await waitFor(() => {
      expect(container.querySelector('.tree-row[data-pinned-id="a"]')?.classList.contains("dragging")).toBe(true);
      expect(container.querySelector('.tree-row[data-pinned-id="c"]')?.classList.contains("drop-before")).toBe(true);
    });
    expect(document.body.style.cursor).toBe("grabbing");

    // pointercancel (e.g. OS interrupted the gesture) — must NOT commit.
    firePointer(handle, "pointercancel", 90);

    expect(readOrderStore()).toEqual(["a", "b", "c"]); // unchanged — no commit
    await waitFor(() => {
      expect(container.querySelector('.tree-row[data-pinned-id="a"]')?.classList.contains("dragging")).toBe(false);
    });
    expect(document.body.style.cursor).toBe("");
  });
});
