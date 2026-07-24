// @vitest-environment jsdom
// TreeRow — presentational unit tests.
// docs/design/server-owned-tree.md §3 (self-contained node), §7, §8.
//
// TreeRow derives EVERY indicator from its `node` prop (no store, no selectors),
// so these tests render the component directly with mock callbacks and assert on
// the DOM. The bug-fix assertions (collapsed node shows agent chip + is right-
// clickable) are the load-bearing ones: they are what the legacy StubNode could
// NOT do (it omitted the chip and represented a different node type).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { TreeRow } from "../../src/components/TreeRow";
import type { TreeNode } from "../../src/sync/treeMap";
import type { TreeRowMenuProps } from "../../src/components/TreeRow";
import { setNameReplacements, refreshProjectSettings } from "../../src/projectSettings";

beforeEach(() => {
  localStorage.clear();
  setNameReplacements([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function baseNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "n1",
    parentId: null,
    title: "Session One",
    activity: "idle",
    childCount: 0,
    loaded: true,
    flags: {
      pendingInput: false,
      subtreeNeedsInput: false,
      permission: false,
      archived: false,
      orphan: false,
    },
    updatedMs: 1_700_000_000_000,
    ...overrides,
  };
}

function nodeButton(container: HTMLElement, id = "n1"): HTMLElement {
  const el = container.querySelector(`.tree-node[data-node-id="${id}"]`);
  if (!el) throw new Error(`no tree-node button for ${id}`);
  return el as HTMLElement;
}

function twisty(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".tree-twisty");
  if (!el) throw new Error("no tree-twisty");
  return el as HTMLElement;
}

// Seed project agent styles so agentDisplay() resolves a chip. The setter is
// module-private; the public path is refreshProjectSettings() over a stubbed fetch.
async function seedAgentStyles(styles: Record<string, unknown>): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agentStyles: styles }),
    }),
  );
  await refreshProjectSettings();
}

describe("TreeRow rendering (self-contained node, §3)", () => {
  it("renders the title via displayName", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ title: "Hello World" })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).textContent).toContain("Hello World");
  });

  it("applies displayName replacement rules to the title (display-only)", async () => {
    // Seed a replacement rule that strips a [[TAG]] prefix for display.
    setNameReplacements([{ pattern: "^\\[\\[TAG\\]\\]\\s*", replacement: "", flags: "" }]);
    const { container } = render(() => (
      <TreeRow node={baseNode({ title: "[[TAG]] Real Title" })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).textContent).toContain("Real Title");
    expect(nodeButton(container as unknown as HTMLElement).textContent).not.toContain("[[TAG]]");
  });

  it("renders NO agent chip when agent is absent", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({})} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".tree-agent")).toBeNull();
  });

  it("renders NO agent chip when agent is present but undeclared in project styles", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ agent: "unknown" })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".tree-agent")).toBeNull();
  });

  it("renders an agent chip when agent + project style are present", async () => {
    await seedAgentStyles({ claude: { label: "Cl", color: "accent", style: "soft" } });
    const { container } = render(() => (
      <TreeRow node={baseNode({ agent: "claude" })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    const chip = nodeButton(container as unknown as HTMLElement).querySelector(".tree-agent");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("Cl");
    expect(chip?.getAttribute("data-chip")).toBe("soft");
  });

  // BUG FIX #5 (core): a collapsed node STILL shows its agent chip. The legacy
  // StubNode explicitly omitted it because the server omitted per-session agent
  // data for collapsed subtrees. The server-owned tree makes every node self-
  // contained, so loaded:false no longer implies "no agent data".
  it("renders the agent chip on a COLLAPSED node (loaded:false) [bug fix #5]", async () => {
    await seedAgentStyles({ claude: { label: "Cl", color: "accent", style: "soft" } });
    const { container } = render(() => (
      <TreeRow
        node={baseNode({ agent: "claude", loaded: false, childCount: 3, descendantCount: 9 })}
        depth={0}
        selected={false}
        expanded={false}
        onSelect={() => {}}
        onToggle={() => {}}
      />
    ));
    const chip = nodeButton(container as unknown as HTMLElement).querySelector(".tree-agent");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("Cl");
  });

  it("shows a busy spinner when activity is busy", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ activity: "busy" })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".tree-spinner")).not.toBeNull();
  });

  it("shows an error dot when activity is error", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ activity: "error" })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".dot.error")).not.toBeNull();
  });

  it("shows a retry dot when activity is retry", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ activity: "retry" })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".dot.retry")).not.toBeNull();
  });

  it("shows a needs-input dot when flags.pendingInput is true", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ flags: { ...baseNode().flags, pendingInput: true } })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".dot.needs-input")).not.toBeNull();
  });

  it("shows a needs-input dot when flags.subtreeNeedsInput is true (server subtree roll-up)", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ flags: { ...baseNode().flags, subtreeNeedsInput: true } })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".dot.needs-input")).not.toBeNull();
  });

  it("does NOT show a busy spinner AND an error dot at once (busy wins)", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ activity: "busy" })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    const btn = nodeButton(container as unknown as HTMLElement);
    expect(btn.querySelector(".tree-spinner")).not.toBeNull();
    expect(btn.querySelector(".dot.error")).toBeNull();
  });

  it("marks the twisty as a leaf when childCount===0", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ childCount: 0 })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(twisty(container as unknown as HTMLElement).classList.contains("leaf")).toBe(true);
  });

  it("does NOT mark the twisty as a leaf when childCount>0 (even if loaded:false)", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ childCount: 3, loaded: false })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(twisty(container as unknown as HTMLElement).classList.contains("leaf")).toBe(false);
  });

  it("applies the selected class when selected", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({})} depth={0} selected={true} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).classList.contains("selected")).toBe(true);
  });

  it("applies the sub class when depth>0", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({})} depth={2} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).classList.contains("sub")).toBe(true);
  });

  it("applies the running class when activity is busy", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ activity: "busy" })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).classList.contains("running")).toBe(true);
  });
});

describe("TreeRow '▸ N' descendant badge (§3 descendantCount)", () => {
  it("shows the badge when collapsed (!loaded) with descendants", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ loaded: false, childCount: 3, descendantCount: 9 })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    const badge = nodeButton(container as unknown as HTMLElement).querySelector(".tree-count");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("9");
    expect(badge?.textContent).toContain("▸");
  });

  it("does NOT show the badge when loaded (children are rendered below)", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ loaded: true, childCount: 3, descendantCount: 9 })} depth={0} selected={false} expanded={true} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".tree-count")).toBeNull();
  });

  it("does NOT show the badge when descendantCount is 0", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ loaded: false, childCount: 0, descendantCount: 0 })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".tree-count")).toBeNull();
  });

  it("does NOT show the badge when descendantCount is absent", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ loaded: false, childCount: 0 })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".tree-count")).toBeNull();
  });

  // FLOOD FIX: the badge must key off the RENDER-expanded prop, NOT node.loaded.
  // Under the new render-gate model a node can be loaded:true (children resident
  // in the flat map) but render-COLLAPSED (not on the active path, not user-
  // expanded). Such a node MUST still show the "▸ N" twisty badge so the user
  // knows it has children to expand. The old `!node.loaded` rule hid the badge
  // for every loaded node — which is exactly why a loaded coordinator flooded the
  // sidebar with its children instead of showing a collapsed badge.
  it("shows the badge on a LOADED node when expanded={false} (render-collapsed) [flood fix]", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ loaded: true, childCount: 3, descendantCount: 9 })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    const badge = nodeButton(container as unknown as HTMLElement).querySelector(".tree-count");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("▸");
    expect(badge?.textContent).toContain("9");
  });

  it("does NOT show the badge on a LOADED node when expanded={true} (children rendered)", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ loaded: true, childCount: 3, descendantCount: 9 })} depth={0} selected={false} expanded={true} onSelect={() => {}} onToggle={() => {}} />
    ));
    expect(nodeButton(container as unknown as HTMLElement).querySelector(".tree-count")).toBeNull();
  });
});

describe("TreeRow interactions (callbacks, no store)", () => {
  it("fires onSelect with the node id on row click", () => {
    const onSelect = vi.fn();
    const { container } = render(() => (
      <TreeRow node={baseNode({ id: "pick" })} depth={0} selected={false} expanded={false} onSelect={onSelect} onToggle={() => {}} />
    ));
    nodeButton(container as unknown as HTMLElement, "pick").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalledWith("pick");
  });

  it("fires onToggle with the node id on twisty click", () => {
    const onToggle = vi.fn();
    const { container } = render(() => (
      <TreeRow node={baseNode({ id: "tog", childCount: 2 })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={onToggle} />
    ));
    twisty(container as unknown as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onToggle).toHaveBeenCalledWith("tog");
  });

  it("does NOT fire onSelect when the twisty is clicked (stopPropagation)", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { container } = render(() => (
      <TreeRow node={baseNode({ childCount: 2 })} depth={0} selected={false} expanded={false} onSelect={onSelect} onToggle={onToggle} />
    ));
    twisty(container as unknown as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalled();
  });

  it("does NOT fire onToggle when the row body is clicked (stopPropagation)", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { container } = render(() => (
      <TreeRow node={baseNode({ childCount: 2 })} depth={0} selected={false} expanded={false} onSelect={onSelect} onToggle={onToggle} />
    ));
    nodeButton(container as unknown as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("does NOT fire onToggle for a structural leaf (childCount===0)", () => {
    const onToggle = vi.fn();
    const { container } = render(() => (
      <TreeRow node={baseNode({ childCount: 0 })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={onToggle} />
    ));
    twisty(container as unknown as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("TreeRow context-menu wiring (bug fix #5: collapsed node right-clickable)", () => {
  // A collapsed node is a normal TreeRow (not a different type), so it carries
  // the menu triggers on its row button just like an expanded node. The legacy
  // StubNode row was not a first-class right-click target in the same way.
  it("spreads menuProps onto the row button and fires onContextMenu", () => {
    const menuProps: TreeRowMenuProps = {
      onContextMenu: vi.fn(),
      onTouchStart: vi.fn(),
      onTouchMove: vi.fn(),
      onTouchEnd: vi.fn(),
    };
    const { container } = render(() => (
      <TreeRow
        node={baseNode({ id: "rc", loaded: false, childCount: 3, descendantCount: 9 })}
        depth={0}
        selected={false}
        expanded={false}
        onSelect={() => {}}
        onToggle={() => {}}
        menuProps={menuProps}
      />
    ));
    const btn = nodeButton(container as unknown as HTMLElement, "rc");
    btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }));
    expect(menuProps.onContextMenu).toHaveBeenCalledWith(expect.anything());
  });

  it("a collapsed node carries data-node-id (right-clickable target exists)", () => {
    const { container } = render(() => (
      <TreeRow node={baseNode({ id: "collapsed-target", loaded: false, childCount: 3, descendantCount: 9 })} depth={0} selected={false} expanded={false} onSelect={() => {}} onToggle={() => {}} />
    ));
    const btn = container.querySelector('[data-node-id="collapsed-target"]');
    expect(btn).not.toBeNull();
  });

  it("still opens the chat on row click when collapsed (not a different node type)", () => {
    const onSelect = vi.fn();
    const { container } = render(() => (
      <TreeRow node={baseNode({ id: "open-collapsed", loaded: false, childCount: 3, descendantCount: 9 })} depth={0} selected={false} expanded={false} onSelect={onSelect} onToggle={() => {}} />
    ));
    nodeButton(container as unknown as HTMLElement, "open-collapsed").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalledWith("open-collapsed");
  });
});
