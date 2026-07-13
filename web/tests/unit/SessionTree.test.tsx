// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { setState, setSelectedIdRaw } from "../../src/sync/store";
import type { Session } from "../../src/types";
import SessionTree, { __resetTreeForTest } from "../../src/components/SessionTree";
import { __resetPinnedForTest, setSearchQuery } from "../../src/sidebar";
import { setNameReplacements } from "../../src/projectSettings";

// The twisty glyph (collapse/expand marker on a parent row) must reflect whether
// the node's subtree ACTUALLY has running work. The `filtered` mode is the
// default for every untouched parent, so the pulsing funnel (.twisty-running) is
// only correct while something underneath is busy; an idle filtered node renders
// the ordinary chevron. We drive the singleton store directly (the
// selectors.test.ts convention) and assert on the rendered twisty span.

beforeEach(() => {
  // Solid's setState MERGES objects, so reconcile({}) is the true reset.
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("unread", reconcile({}));
  // selectedId is a module-level singleton signal; reset it so a prior test's
  // selection doesn't leak into the next render.
  setSelectedIdRaw(null);
  // treeMode persists to localStorage; clear it so each test starts with the
  // default "filtered" mode for every node.
  localStorage.clear();
  // The module-level treeMode/userToggled signals are initialized once at first
  // import; localStorage.clear() above wipes their persisted backing store but
  // NOT the in-memory signal, so reset them explicitly (after the clear, so
  // loadModes() reads {} → all-default). prevWorking/didInit/prevSessionKeys
  // are component-instance scoped and reset naturally per render().
  __resetTreeForTest();
  // Pinned membership/order signals also persist; reset alongside the clear.
  __resetPinnedForTest();
});

afterEach(() => cleanup());

function putSession(s: Session): void {
  setState("sessions", s.id, s);
}

// The twisty is a sibling of `.tree-node[data-session-id]` inside a `.tree-row`;
// reach it via the node button so we target the exact session under test.
function twistyFor(container: HTMLElement, id: string): Element {
  const node = container.querySelector(`.tree-node[data-session-id="${id}"]`);
  if (!node) throw new Error(`no tree-node for session ${id}`);
  const row = node.closest(".tree-row");
  const twisty = row?.querySelector(".tree-twisty");
  if (!twisty) throw new Error(`no twisty for session ${id}`);
  return twisty;
}

describe("SessionTree twisty", () => {
  it("renders the chevron (not the pulsing funnel) for an idle filtered node", () => {
    // A parent with one idle child. The parent's default tree mode is "filtered",
    // but nothing in its subtree is running, so the funnel must NOT render —
    // otherwise it would pulse forever on a finished/idle branch.
    putSession({ id: "root", title: "Root" });
    putSession({ id: "child", title: "Child", parentID: "root", time: { updated: 1 } });

    const { container } = render(() => <SessionTree />);
    const twisty = twistyFor(container as unknown as HTMLElement, "root");

    expect(twisty.querySelector(".twisty-running")).toBeNull();
    // The ordinary collapsed chevron still renders an icon glyph.
    expect(twisty.querySelector("svg.icon")).not.toBeNull();
    // The chevron span is NOT marked open (collapsed points right).
    expect(twisty.querySelector("span.open")).toBeNull();
  });

  it("renders the pulsing funnel for a filtered node whose subtree is running", () => {
    putSession({ id: "root", title: "Root" });
    putSession({ id: "child", title: "Child", parentID: "root", time: { updated: 1 } });
    setState("activity", "child", "busy"); // a live descendant → root's subtree is working

    const { container } = render(() => <SessionTree />);
    const twisty = twistyFor(container as unknown as HTMLElement, "root");

    expect(twisty.querySelector(".twisty-running")).not.toBeNull();
  });
});

// The auto-tidy effect's delta logic only collapses a `filtered` node when it
// SEES the node leave the working set. Because prevWorking starts empty on
// mount, a node whose mode is the default `filtered` and whose subtree finished
// BEFORE this load is never caught — it would sit in `filtered` showing zero
// children. A one-shot init pass on the effect's first run closes that gap.

// The twisty's aria-label carries the effective display() state
// ("Subtree: collapsed" / "filtered" / "temp"), which is how we tell
// collapsed from filtered apart — an idle filtered node and a collapsed node
// render identically (both hide kids and show the plain chevron).
function readMode(rootId: string): string {
  const raw = localStorage.getItem("vh.tree.mode.v2");
  if (!raw) return "filtered";
  return JSON.parse(raw).data?.[rootId] ?? "filtered";
}

describe("SessionTree auto-tidy init", () => {
  it("collapses a default-filtered node with an idle subtree on fresh mount", async () => {
    putSession({ id: "root", title: "Root" });
    putSession({ id: "child", title: "Child", parentID: "root", time: { updated: 1 } });

    const { container } = render(() => <SessionTree />);

    // The init pass collapses the idle filtered root; display() → collapsed.
    await waitFor(() => {
      expect(readMode("root")).toBe("collapsed");
    });
    const twisty = twistyFor(container as unknown as HTMLElement, "root");
    expect(twisty.getAttribute("aria-label")).toBe("Subtree: collapsed (click to cycle)");
    // Children hidden; ordinary right-pointing chevron (no funnel, not open).
    expect(container.querySelector('.tree-node[data-session-id="child"]')).toBeNull();
    expect(twisty.querySelector(".twisty-running")).toBeNull();
    expect(twisty.querySelector("span.open")).toBeNull();
  });

  it("keeps a filtered node filtered on fresh mount when its subtree is running", async () => {
    putSession({ id: "root", title: "Root" });
    putSession({ id: "child", title: "Child", parentID: "root", time: { updated: 1 } });
    setState("activity", "child", "busy"); // root is an ancestor → in the working set

    const { container } = render(() => <SessionTree />);

    // Init pass must NOT collapse a node whose subtree is in the working set.
    await waitFor(() => {
      expect(readMode("root")).toBe("filtered");
    });
    const twisty = twistyFor(container as unknown as HTMLElement, "root");
    expect(twisty.getAttribute("aria-label")).toBe("Subtree: filtered (click to cycle)");
    // Running child stays visible (filtered shows working children); funnel shown.
    expect(container.querySelector('.tree-node[data-session-id="child"]')).not.toBeNull();
    expect(twisty.querySelector(".twisty-running")).not.toBeNull();
  });

  it("reveals the active session's ancestor path as temp even when collapsed on load", async () => {
    putSession({ id: "root", title: "Root" });
    putSession({ id: "child", title: "Child", parentID: "root", time: { updated: 2 } });
    putSession({ id: "grandchild", title: "Grandchild", parentID: "child", time: { updated: 3 } });
    setSelectedIdRaw("grandchild"); // active session is a leaf two levels down

    const { container } = render(() => <SessionTree />);

    // The idle ancestors get collapsed by the init pass (persisted mode), yet
    // the active session must still be reachable.
    await waitFor(() => {
      expect(readMode("root")).toBe("collapsed");
      expect(readMode("child")).toBe("collapsed");
    });
    // display() resolves collapsed ancestors to `temp` (m !== "expanded"), so the
    // path child is revealed all the way down to the active session.
    expect(container.querySelector('.tree-node[data-session-id="grandchild"]')).not.toBeNull();
    expect(container.querySelector('.tree-node[data-session-id="child"]')).not.toBeNull();
    const rootTwisty = twistyFor(container as unknown as HTMLElement, "root");
    expect(rootTwisty.getAttribute("aria-label")).toBe("Subtree: temp (click to cycle)");
    expect(rootTwisty.querySelector(".twisty-temp")).not.toBeNull();
  });
});

// A session that syncs in AFTER mount is missed by the one-shot init pass, and
// the delta loops only collapse nodes they observed LEAVE the working set — so
// an idle newcomer with the default `filtered` mode would sit open showing zero
// children. The effect tracks seen session keys (prevSessionKeys) and collapses
// newly-arrived idle filtered nodes on later runs.

describe("SessionTree auto-tidy late arrival", () => {
  it("collapses a newly-arrived idle filtered node that syncs in after mount", async () => {
    // Mount with an unrelated session so the init pass has already run
    // (didInit = true) before the newcomer arrives.
    putSession({ id: "seed", title: "Seed" });

    const { container } = render(() => <SessionTree />);
    // readMode("seed") === "collapsed" is the signal the init pass has fired.
    await waitFor(() => expect(readMode("seed")).toBe("collapsed"));

    // Now sync in a new idle parent + child — no persisted mode, subtree idle.
    putSession({ id: "sX", title: "Late" });
    putSession({ id: "sXc", title: "Late child", parentID: "sX", time: { updated: 1 } });

    // The late-arrival pass collapses the idle filtered newcomer. Without it sX
    // would stay in default `filtered` (its persisted/displayed mode never
    // becoming "collapsed").
    await waitFor(() => {
      expect(readMode("sX")).toBe("collapsed");
    });
    const twisty = twistyFor(container as unknown as HTMLElement, "sX");
    expect(twisty.getAttribute("aria-label")).toBe("Subtree: collapsed (click to cycle)");
    // Collapsed: child hidden, no funnel (idle), plain chevron.
    expect(container.querySelector('.tree-node[data-session-id="sXc"]')).toBeNull();
    expect(twisty.querySelector(".twisty-running")).toBeNull();
    expect(twisty.querySelector("span.open")).toBeNull();
  });

  it("keeps a newly-arrived busy node filtered so its running children stay visible", async () => {
    putSession({ id: "seed", title: "Seed" });

    const { container } = render(() => <SessionTree />);
    await waitFor(() => expect(readMode("seed")).toBe("collapsed"));

    // New parent with a BUSY child → parent enters the working set on arrival.
    putSession({ id: "sX", title: "Late" });
    putSession({ id: "sXc", title: "Late child", parentID: "sX", time: { updated: 1 } });
    setState("activity", "sXc", "busy");

    // sX is in the working set, so !w.has(id) is false → NOT collapsed; it
    // stays filtered, revealing the running child.
    await waitFor(() => {
      expect(readMode("sX")).toBe("filtered");
    });
    const twisty = twistyFor(container as unknown as HTMLElement, "sX");
    expect(twisty.getAttribute("aria-label")).toBe("Subtree: filtered (click to cycle)");
    expect(container.querySelector('.tree-node[data-session-id="sXc"]')).not.toBeNull();
    expect(twisty.querySelector(".twisty-running")).not.toBeNull();
  });

  it("reveals the active session's path as temp through a late-arriving collapsed ancestor", async () => {
    putSession({ id: "seed", title: "Seed" });

    const { container } = render(() => <SessionTree />);
    await waitFor(() => expect(readMode("seed")).toBe("collapsed"));

    // Active leaf arrives pointing at a parent that hasn't synced yet.
    setSelectedIdRaw("leaf");
    putSession({ id: "leaf", title: "Leaf", parentID: "late", time: { updated: 3 } });

    // Now the idle ancestor arrives post-mount → collapsed by the late-arrival
    // pass, yet display() must resolve it to `temp` so the active leaf stays
    // reachable through it (same guarantee the init pass gives on-load cases).
    putSession({ id: "late", title: "Late ancestor" });
    await waitFor(() => expect(readMode("late")).toBe("collapsed"));

    expect(container.querySelector('.tree-node[data-session-id="late"]')).not.toBeNull();
    expect(container.querySelector('.tree-node[data-session-id="leaf"]')).not.toBeNull();
    const lateTwisty = twistyFor(container as unknown as HTMLElement, "late");
    expect(lateTwisty.getAttribute("aria-label")).toBe("Subtree: temp (click to cycle)");
    expect(lateTwisty.querySelector(".twisty-temp")).not.toBeNull();
  });
});

// Module-level treeMode/userToggled signals are shared across every render in
// the suite. __resetTreeForTest() in beforeEach is what keeps cases isolated;
// this pair regresses that: if the reset were removed, the dirtier's expanded
// state would leak and the "fresh" case would see root start expanded. (Run
// `npx vitest run --shuffle` twice to confirm no order dependence.)

describe("SessionTree module-state isolation", () => {
  it("dirties module state by expanding a node", async () => {
    putSession({ id: "root", title: "Root" });
    putSession({ id: "child", title: "Child", parentID: "root", time: { updated: 1 } });

    const { container } = render(() => <SessionTree />);
    const twisty = twistyFor(container as unknown as HTMLElement, "root");

    // Init collapses the idle root first; then cycle collapsed → filtered →
    // expanded via the twisty so treeMode holds {root: expanded} and
    // userToggled holds {root}.
    await waitFor(() => expect(readMode("root")).toBe("collapsed"));
    await fireEvent.click(twisty);
    await waitFor(() => expect(readMode("root")).toBe("filtered"));
    await fireEvent.click(twisty);
    await waitFor(() => expect(readMode("root")).toBe("expanded"));
    expect(twisty.getAttribute("aria-label")).toBe("Subtree: expanded (click to cycle)");
  });

  it("starts a fresh node in the default collapsed state after a prior test expanded it", async () => {
    putSession({ id: "root", title: "Root" });
    putSession({ id: "child", title: "Child", parentID: "root", time: { updated: 1 } });

    const { container } = render(() => <SessionTree />);
    const twisty = twistyFor(container as unknown as HTMLElement, "root");

    // __resetTreeForTest() (called in beforeEach, AFTER localStorage.clear)
    // resets the module signals to defaults, so the init pass collapses the
    // idle root as on a cold load. Without the reset, treeMode()["root"] would
    // still be "expanded" from the dirtier above: readMode would stick at
    // "filtered" (init won't re-collapse an already-non-filtered leaked node,
    // and localStorage was cleared) and root would render expanded.
    await waitFor(() => expect(readMode("root")).toBe("collapsed"));
    expect(twisty.getAttribute("aria-label")).toBe("Subtree: collapsed (click to cycle)");
    expect(container.querySelector('.tree-node[data-session-id="child"]')).toBeNull();
  });
});

// Pinned roots are now rendered in the persisted pinned-order (reconciled
// against membership). These cases verify the render consumes that order and
// that the reorder drag handle is scoped to the pinned section only.

function seedVersioned(key: string, data: unknown) {
  localStorage.setItem(key, JSON.stringify({ v: 1, data }));
}

function pinnedRenderedIds(container: HTMLElement): string[] {
  const pinned = container.querySelector(".tree-pinned");
  if (!pinned) return [];
  return Array.from(pinned.querySelectorAll<HTMLElement>("[data-pinned-id]")).map((el) =>
    el.getAttribute("data-pinned-id")!,
  );
}

describe("SessionTree pinned order", () => {
  it("renders pinned roots in the persisted order, not the roots' natural order", async () => {
    // Roots arrive newest-first by `buildChildrenIndex`; pin three and persist
    // a custom order so c is first. The render must follow the order array.
    putSession({ id: "a", title: "A", time: { updated: 1 } });
    putSession({ id: "b", title: "B", time: { updated: 2 } });
    putSession({ id: "c", title: "C", time: { updated: 3 } });
    seedVersioned("vh.pinned.v1", ["a", "b", "c"]);
    seedVersioned("vh.pinned-order.v1", ["c", "a", "b"]);
    __resetPinnedForTest();

    const { container } = render(() => <SessionTree />);

    await waitFor(() => {
      expect(pinnedRenderedIds(container as unknown as HTMLElement)).toEqual(["c", "a", "b"]);
    });
  });

  it("falls back to the set's natural order when no order array exists (lazy migration)", async () => {
    putSession({ id: "a", title: "A", time: { updated: 1 } });
    putSession({ id: "b", title: "B", time: { updated: 2 } });
    seedVersioned("vh.pinned.v1", ["a", "b"]); // membership only, no order array
    __resetPinnedForTest();

    const { container } = render(() => <SessionTree />);

    await waitFor(() => {
      expect(pinnedRenderedIds(container as unknown as HTMLElement)).toEqual(["a", "b"]);
    });
  });

  it("renders a drag handle only inside the pinned section, never on unpinned rows", async () => {
    putSession({ id: "p1", title: "Pinned", time: { updated: 1 } });
    putSession({ id: "u1", title: "Unpinned", time: { updated: 2 } });
    seedVersioned("vh.pinned.v1", ["p1"]);
    __resetPinnedForTest();

    const { container } = render(() => <SessionTree />);

    await waitFor(() => expect(container.querySelector(".tree-pinned")).not.toBeNull());
    // Exactly one handle, and it lives inside .tree-pinned.
    const handles = container.querySelectorAll(".tree-drag");
    expect(handles.length).toBe(1);
    expect(handles[0].closest(".tree-pinned")).not.toBeNull();
    // The unpinned row has no handle and no data-pinned-id.
    const unpinnedRow = container.querySelector('.tree-row:not([data-pinned-id])');
    expect(unpinnedRow?.querySelector(".tree-drag")).toBeNull();
  });
});

describe("displayName boundary", () => {
  afterEach(() => {
    setNameReplacements([]);
    setSearchQuery("");
  });

  it("transforms visible title + tooltip but keeps search filter raw", async () => {
    setNameReplacements([{ pattern: "\\[\\[X\\]\\]", replacement: "Y", flags: "g" }]);
    putSession({ id: "s1", title: "[[X]] test", time: { created: 1, updated: 1 } } as Session);
    const { container } = render(() => <SessionTree />);

    // DISPLAY: visible title + tooltip are transformed.
    await waitFor(() => {
      const node = container.querySelector('.tree-node[data-session-id="s1"]');
      expect(node).toBeTruthy();
    });
    const node = container.querySelector('.tree-node[data-session-id="s1"]') as HTMLElement;
    expect(node.getAttribute("data-tip")).toBe("Y test");
    expect(node.querySelector(".tree-title")?.textContent).toBe("Y test");

    // RAW: search uses the raw title. Searching for the DISPLAY form ("Y test")
    // does NOT match the session.
    setSearchQuery("Y test");
    await waitFor(() => {
      expect(container.querySelector('.tree-node[data-session-id="s1"]')).toBeNull();
    });

    // RAW: searching for the RAW title ("[[X]]") DOES find the session,
    // even though its visible label shows "Y test" (DISPLAY).
    setSearchQuery("[[X]]");
    await waitFor(() => {
      const searchNode = container.querySelector('.tree-node[data-session-id="s1"]');
      expect(searchNode).toBeTruthy();
      expect(searchNode?.querySelector(".tree-title")?.textContent).toBe("Y test");
    });
  });
});
