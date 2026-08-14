// @vitest-environment jsdom
//
// Unit coverage for the centralized back-dismissal history manager
// (src/lib/backStack.ts): token push/consume, LIFO back-dismissal,
// forward-never-reopens, orphan auto-unwind, foreign-state tolerance, and the
// bindBackDismiss lifecycle (push on open, release on close/unmount,
// reentrancy-safe manager closes).
//
// jsdom's history is replaced with a fake state stack (same approach as
// MermaidViewer.test.tsx): pushState/replaceState mutate the stack,
// history.state reads the top, history.back() pops + fires popstate
// synchronously (the manager sets pendingTraversal before calling back(), so
// sync delivery is ordering-equivalent to the browser's async delivery).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backStackDepth,
  bindBackDismiss,
  isBackEntry,
  pushBackSurface,
  releaseBackSurface,
  wasManagedPopState,
  __resetBackStackForTest,
} from "../../src/lib/backStack";
import { createRoot, createSignal } from "solid-js";

let pushStateSpy: ReturnType<typeof vi.spyOn>;
let backSpy: ReturnType<typeof vi.spyOn>;
let entries: { state: unknown }[];

const top = () => entries[entries.length - 1].state;
const firePop = () =>
  window.dispatchEvent(new PopStateEvent("popstate", { state: top() }));
// Hardware/browser Back: pop + deliver popstate WITHOUT history.back().
const hardwareBack = () => {
  if (entries.length > 1) entries.pop();
  firePop();
};
const flush = () => new Promise<void>((res) => queueMicrotask(() => res()));

describe("backStack", () => {
  beforeEach(() => {
    entries = [{ state: null }];
    Object.defineProperty(window.history, "state", {
      configurable: true,
      get: () => top(),
    });
    pushStateSpy = vi
      .spyOn(history, "pushState")
      .mockImplementation((state) => void entries.push({ state }));
    vi.spyOn(history, "replaceState").mockImplementation(
      (state) => void (entries[entries.length - 1] = { state }),
    );
    backSpy = vi.spyOn(history, "back").mockImplementation(() => {
      if (entries.length > 1) entries.pop();
      firePop();
    });
  });

  afterEach(() => {
    pushStateSpy.mockRestore();
    vi.spyOn(history, "replaceState").mockRestore();
    backSpy.mockRestore();
    delete (window.history as { state?: unknown }).state;
    __resetBackStackForTest();
  });

  it("pushBackSurface pushes a URL-transparent token entry (no url arg)", () => {
    const close = vi.fn();
    const s = pushBackSurface(close, "dlg")!;
    expect(s).toBeTruthy();
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
    const call = pushStateSpy.mock.calls.at(-1)!;
    expect((call[0] as Record<string, unknown>).vhBack).toMatch(/^dlg#\d+$/);
    expect(call[2]).toBeUndefined(); // URL-transparent
    expect(backStackDepth()).toBe(1);
    expect(isBackEntry(history.state)).toBe(true);
  });

  it("explicit release consumes the entry (deferred history.back), close NOT invoked", async () => {
    const close = vi.fn();
    const s = pushBackSurface(close, "dlg")!;
    releaseBackSurface(s);
    await flush(); // release schedules the consume on a microtask
    expect(backSpy).toHaveBeenCalledTimes(1);
    // the consume traversal popped back to the base entry
    expect(top()).toBeNull();
    // explicit dismissal never invokes the manager close callback
    expect(close).not.toHaveBeenCalled();
    expect(backStackDepth()).toBe(0);
  });

  it("hardware Back dismisses the TOPMOST surface only, LIFO; never switches below", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    pushBackSurface(closeA, "a");
    pushBackSurface(closeB, "b");
    expect(backStackDepth()).toBe(2);
    // Back from B's entry lands on A's entry: close everything above A.
    hardwareBack();
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
    expect(backStackDepth()).toBe(1);
    // Back from A's entry lands on base: close what's live (A).
    hardwareBack();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(backStackDepth()).toBe(0);
    // All dismissals were browser-driven: the manager never called back().
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("FORWARD onto a dead token is a strict no-op (tokens only close, never open)", () => {
    const close = vi.fn();
    const s = pushBackSurface(close, "dlg")!;
    const tokenState = top();
    hardwareBack(); // dismissed
    expect(close).toHaveBeenCalledTimes(1);
    releaseBackSurface(s); // (already retired by the arbiter — must no-op)
    // Forward re-lands on the dead token entry.
    entries.push({ state: tokenState });
    firePop();
    expect(close).toHaveBeenCalledTimes(1); // not invoked again
    expect(pushStateSpy).toHaveBeenCalledTimes(1); // nothing re-pushed
    expect(backStackDepth()).toBe(0);
  });

  it("a release buried mid-stack becomes an orphan that auto-unwinds on Back", async () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const a = pushBackSurface(closeA, "a")!;
    pushBackSurface(closeB, "b");
    // A closed programmatically while buried under B: no consume possible, it
    // becomes an orphan entry stranded between base and B.
    releaseBackSurface(a);
    await flush();
    expect(backSpy).not.toHaveBeenCalled(); // buried: nothing to consume
    expect(backStackDepth()).toBe(1);
    // Hardware Back from B's entry lands on A's ORPHAN token: the manager
    // must keep unwinding (one extra history.back) so the user lands on base
    // instead of stalling on a ghost.
    hardwareBack();
    expect(top()).toBeNull(); // unwound past the orphan to the base entry
    expect(closeB).toHaveBeenCalledTimes(1); // B (the live surface) closed
    expect(closeA).not.toHaveBeenCalled(); // A was closed programmatically
    expect(backSpy).toHaveBeenCalledTimes(1); // the unwind traversal
    expect(backStackDepth()).toBe(0);
  });

  it("foreign / legacy session states are tolerated: base landing closes all live surfaces", () => {
    // Real-world shape: a long-lived tab sits on a legacy {session,dir} entry;
    // the token is pushed on top of it. Back lands on the legacy entry.
    entries[0] = { state: { session: "demo", dir: null } };
    const close = vi.fn();
    pushBackSurface(close, "dlg");
    hardwareBack();
    expect(close).toHaveBeenCalledTimes(1);
    expect(backStackDepth()).toBe(0);
    // isBackEntry classifies non-token states as false
    expect(isBackEntry({ session: "demo" })).toBe(false);
    expect(isBackEntry(null)).toBe(false);
    expect(isBackEntry("string")).toBe(false);
  });

  it("popstate events the manager handled are marked; empty-stack backs are not", () => {
    const seen: PopStateEvent[] = [];
    const capture = (ev: Event) => seen.push(ev as PopStateEvent);
    window.addEventListener("popstate", capture);
    try {
      const close = vi.fn();
      pushBackSurface(close, "dlg");
      hardwareBack(); // dismissed a surface → manager-owned
      expect(seen.at(-1)).toBeTruthy();
      expect(wasManagedPopState(seen.at(-1)!)).toBe(true);
      // A back with NOTHING open falls through to native/session handling —
      // the manager must NOT claim it (sync.ts keeps legacy behavior there).
      hardwareBack();
      expect(wasManagedPopState(seen.at(-1)!)).toBe(false);
    } finally {
      window.removeEventListener("popstate", capture);
    }
  });

  it("pushBackSurface returns null (and release tolerates null) when history is unavailable", () => {
    pushStateSpy.mockImplementation(() => {
      throw new Error("no history");
    });
    const s = pushBackSurface(vi.fn(), "dlg");
    expect(s).toBeNull();
    expect(backStackDepth()).toBe(0);
    expect(() => releaseBackSurface(s)).not.toThrow();
  });

  describe("bindBackDismiss", () => {
    it("pushes when open turns true, releases when false (entry consumed)", async () => {
      const [open, setOpen] = createSignal(false);
      const dispose = createRoot((d) => {
        bindBackDismiss(open, () => setOpen(false), "flag");
        return d;
      });
      pushStateSpy.mockClear();
      setOpen(true);
      await flush(); // createEffect is microtask-deferred
      expect(pushStateSpy).toHaveBeenCalledTimes(1);
      expect(backStackDepth()).toBe(1);
      setOpen(false); // explicit close (✕/Escape/...) flips the signal
      await flush();
      expect(backSpy).toHaveBeenCalledTimes(1); // entry consumed
      expect(backStackDepth()).toBe(0);
      dispose();
    });

    it("manager Back close that flips the signal does NOT double-consume", async () => {
      const [open, setOpen] = createSignal(false);
      const dispose = createRoot((d) => {
        // The close callback flips the open signal (typical wiring: close sets
        // the signal false → the effect releases → release must no-op because
        // the arbiter already retired the surface).
        bindBackDismiss(open, () => setOpen(false), "flag");
        return d;
      });
      setOpen(true);
      await flush();
      expect(backStackDepth()).toBe(1);
      backSpy.mockClear();
      hardwareBack(); // manager invokes close → setOpen(false)
      await flush(); // effect runs releaseBackSurface — must be a no-op
      expect(backSpy).not.toHaveBeenCalled(); // no ghost consume traversal
      expect(backStackDepth()).toBe(0);
      expect(open()).toBe(false);
      dispose();
    });

    it("unmount while open releases the entry (no stranded ghosts)", async () => {
      const [open, setOpen] = createSignal(false);
      const dispose = createRoot((d) => {
        bindBackDismiss(open, () => setOpen(false), "flag");
        return d;
      });
      setOpen(true);
      await flush();
      backSpy.mockClear();
      dispose(); // unmount with the surface still open
      await flush();
      expect(backSpy).toHaveBeenCalledTimes(1); // consumed, not stranded
      expect(backStackDepth()).toBe(0);
      expect(open()).toBe(true); // the signal itself is untouched
    });
  });
});
