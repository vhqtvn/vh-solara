// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { setState, setSelectedIdRaw } from "../../src/sync/store";
import type { Session } from "../../src/types";
import SessionTree from "../../src/components/SessionTree";

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
