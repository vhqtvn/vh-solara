// @vitest-environment jsdom
// Wiring pins for the two popovers the backnav audit found unwired (card
// review-defer-backnav-popovers, finding F-C1): ChatTasksStatus's Tasks
// popover and TabBar's "⋯" overflow menu must push a back-stack token while
// open — the same bindBackDismiss wiring CodeView's picker/context menu,
// ui.ts's settings/admin/… surfaces, and App's nav/inspector/managed binds
// use. The mechanism itself (push/consume/orphan lifecycle) is covered by
// backStack.test.ts; these pins prove the COMPONENT wiring: open →
// history.state carries a "taskspop#" / "tabmenu#" token, close → the entry
// is released (consumed with exactly one history.back()).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import ChatTasksStatus from "../../src/components/ChatTasksStatus";
import TabBar, { type TabItem } from "../../src/components/TabBar";
import { backStackDepth, __resetBackStackForTest } from "../../src/lib/backStack";

// The Tasks popover renders off the server-authoritative subtree-todo rollup;
// stub it non-empty so the pill (and thus the popover) exists.
vi.mock("../../src/subtreeTodos", () => ({
  fetchSubtreeTodos: async () => ({
    epoch: "e0",
    revision: 1,
    data: {
      sessionId: "s1",
      items: [],
      totals: { active: 2, left: 3, total: 5 },
    },
  }),
}));

// releaseBackSurface consumes its entry via history.back(); jsdom's back() is
// a not-implemented logging no-op — stub it so the run stays quiet AND the
// consumption becomes assertable.
let backSpy: ReturnType<typeof vi.spyOn>;

/** The back-stack token id in a history state ("tag#seq"), or null. */
const tokenOf = (s: unknown): string | null =>
  s && typeof s === "object" && typeof (s as Record<string, unknown>).vhBack === "string"
    ? ((s as Record<string, unknown>).vhBack as string)
    : null;

beforeEach(() => {
  localStorage.clear();
  __resetBackStackForTest();
  // Clean base entry: assert "THIS open pushed the token", not leftovers.
  window.history.pushState(null, "");
  backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  backSpy.mockRestore();
  __resetBackStackForTest();
});

describe("backnav popover wiring (bindBackDismiss at the call sites)", () => {
  it("ChatTasksStatus Tasks popover: open pushes a taskspop# token; close releases it", async () => {
    const { container } = render(() => (
      <ChatTasksStatus
        sessionId="s1"
        working={() => false}
        verb={() => null}
        verbElapsed={() => ""}
        workingAriaLabel={() => "idle"}
      />
    ));
    const pill = await waitFor(() => {
      const p = container.querySelector<HTMLElement>(".tasks-pill");
      expect(p).not.toBeNull();
      return p!;
    });
    expect(backStackDepth(), "closed popover pushes no token").toBe(0);

    pill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(container.querySelector(".tasks-popup")).not.toBeNull());
    await waitFor(() => expect(backStackDepth()).toBe(1));
    expect(tokenOf(window.history.state)).toMatch(/^taskspop#\d+$/);

    // Toggle closed via the pill (the explicit-close path): the bind's effect
    // releases the entry — consumed with exactly ONE history.back().
    pill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(container.querySelector(".tasks-popup")).toBeNull());
    await waitFor(() => expect(backStackDepth()).toBe(0));
    await waitFor(() => expect(backSpy).toHaveBeenCalledTimes(1));
  });

  it("TabBar overflow menu: open pushes a tabmenu# token; selecting an item releases it", async () => {
    // jsdom lacks ResizeObserver (TabBar's onMount measures available width
    // with one). A recording stub: observe() is a no-op; the test fires the
    // recorded callbacks AFTER stubbing geometry, exactly like a real resize.
    const roCbs: Array<() => void> = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(cb: () => void) {
        roCbs.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const base: TabItem[] = [
      { key: "chat", label: "Chat" },
      { key: "code", label: "Code" },
      { key: "term", label: "Terminal" },
    ];
    const [items, setItems] = createSignal<TabItem[]>(base);
    const { container } = render(() => (
      <TabBar items={items} active={() => "chat"} onSelect={() => {}} />
    ));

    // Stub geometry so the row overflows: the wrap gets a tiny clientWidth
    // and every measured row child a huge natural width → only the first tab
    // fits; the rest spill into the "⋯" overflow menu.
    const root = container.firstElementChild as HTMLElement;
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 120 });
    const measureRow = root.querySelector<HTMLElement>('div[aria-hidden="true"]');
    expect(measureRow, "hidden measuring row rendered").not.toBeNull();
    for (const child of Array.from(measureRow!.children)) {
      Object.defineProperty(child, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width: 500 }),
      });
    }
    // Re-run both measurement paths against the stubs: the RO callback reads
    // clientWidth; the items()-effect re-measures natural widths.
    for (const cb of roCbs) cb();
    setItems([...base]);
    await new Promise((r) => setTimeout(r, 0)); // flush queueMicrotask(measure)

    const more = await waitFor(() => {
      const b = [...container.querySelectorAll("button")].find((x) =>
        x.textContent?.includes("•••"),
      );
      expect(b, "overflow ⋯ button rendered").not.toBeNull();
      return b!;
    });
    expect(backStackDepth(), "closed menu pushes no token").toBe(0);

    more.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(backStackDepth()).toBe(1));
    expect(tokenOf(window.history.state)).toMatch(/^tabmenu#\d+$/);

    // Selecting a hidden item closes the menu (onClick sets menuOpen false):
    // the entry is released — consumed with exactly ONE history.back().
    const hidden = await waitFor(() => {
      const b = container.querySelector<HTMLElement>('button[aria-label="Code"]');
      expect(b, "hidden item rendered in the overflow menu").not.toBeNull();
      return b!;
    });
    hidden.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(backStackDepth()).toBe(0));
    await waitFor(() => expect(backSpy).toHaveBeenCalledTimes(1));
  });
});
