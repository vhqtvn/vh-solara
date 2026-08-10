// @vitest-environment jsdom
//
// OrphanBanner — the operator-facing recovery UX for archive-defect-chain
// Slice 2. The banner reads the SERVER-computed Node.flags.orphan from the tree
// store (treeMap) and surfaces a bulk "Archive orphans" action for exactly the
// flagged subset. There is NO client-side orphan classification: every flagged
// node is server-confirmed eligible for archive (its parent-chain terminates at a
// confirmed-archived parent — see pkg/state/tree_emitter.go isOrphanLocked).
//
// These tests pin the banner's contract:
//   - it renders NOTHING when no nodes carry flags.orphan (no false alarm);
//   - the count + confirm list reflect ONLY the flagged subset (e88f19e bulk-
//     action safety: only flagged nodes are bulk-archivable);
//   - the confirm flow targets ONLY flagged ids via archiveSession.
//
// The SERVER side (isOrphanLocked → buildNodeLocked → Node.flags.orphan) is
// pinned in pkg/state/tree_orphan_test.go (RT2/RT3 emit). These web tests assume
// the flag is already correct on the node and assert the banner honors it.
//
// NOTE on selectors: the banner row + its trigger button use CSS-Module classes
// (hashed in the test env), so they are located by text content; the confirm
// dialog uses GLOBAL classes (.confirm-id / .confirm-go / [role=dialog]) which
// are stable and queried directly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import OrphanBanner from "../../src/components/OrphanBanner";
import { seedTreeStore, resetTreeStore } from "../../src/sync/treeState";
import type { TreeNode } from "../../src/sync/treeMap";

// Mock archiveSession so the confirm flow does not hit the network. The hoisted
// spy resolves to [id] (the documented success shape: the affected ids), so the
// banner's confirm loop completes.
const archiveSpy = vi.hoisted(() => vi.fn(async (id: string) => [id]));
vi.mock("../../src/archive", () => ({ archiveSession: archiveSpy }));

// A minimal tree node. Only id + flags.orphan matter to the banner; the rest are
// defaulted to a valid resident TreeNode shape.
function node(id: string, orphan: boolean, title = id): TreeNode {
  return {
    id,
    parentId: null,
    title,
    activity: "idle",
    childCount: 0,
    loaded: true,
    descendantCount: 0,
    updatedMs: 1_700_000_000_000,
    flags: {
      pendingInput: false,
      subtreeNeedsInput: false,
      permission: false,
      archived: false,
      orphan,
    },
  };
}

// Find a <button> by exact trimmed text content (robust to CSS-Module hashing).
function buttonByText(container: HTMLElement, text: string): HTMLElement {
  const btns = Array.from(container.querySelectorAll("button"));
  const hit = btns.find((b) => (b.textContent ?? "").trim() === text);
  if (!hit) throw new Error(`no button with text "${text}" (found: ${btns.map((b) => b.textContent)})`);
  return hit;
}

beforeEach(() => {
  resetTreeStore();
  archiveSpy.mockClear();
});

afterEach(() => {
  cleanup();
  resetTreeStore();
});

describe("OrphanBanner — render gate", () => {
  it("renders NOTHING when no nodes carry flags.orphan", () => {
    seedTreeStore([node("live-1", false), node("live-2", false)]);
    const { container } = render(() => <OrphanBanner />);
    // No banner text rendered.
    expect(container.textContent).not.toContain("orphaned");
    // No "Archive orphans" trigger button.
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders NOTHING when the tree store is empty", () => {
    seedTreeStore([]);
    const { container } = render(() => <OrphanBanner />);
    expect(container.textContent).not.toContain("orphaned");
  });
});

describe("OrphanBanner — flagged-node surfacing", () => {
  it("renders the banner with the correct count for the flagged subset only", () => {
    seedTreeStore([
      node("orphan-a", true),
      node("live-1", false),
      node("orphan-b", true),
      node("live-2", false),
    ]);
    const { container } = render(() => <OrphanBanner />);

    // Count text reflects ONLY the 2 flagged nodes.
    expect(container.textContent).toContain("2 orphaned sessions");
    // The bulk-action trigger button is present and labeled.
    expect(() => buttonByText(container, "Archive orphans")).not.toThrow();
    // Live node ids must NOT appear in the banner summary.
    expect(container.textContent).not.toContain("live-1");
    expect(container.textContent).not.toContain("live-2");
  });

  it("uses the singular 'session' for exactly one orphan", () => {
    seedTreeStore([node("solo", true), node("live", false)]);
    const { container } = render(() => <OrphanBanner />);
    expect(container.textContent).toContain("1 orphaned session");
  });
});

describe("OrphanBanner — confirm dialog lists only flagged nodes", () => {
  it("the confirm dialog lists ONLY the flagged ids (not the live nodes)", () => {
    seedTreeStore([
      node("orphan-a", true, "Alpha"),
      node("live-1", false, "LiveOne"),
      node("orphan-b", true, "Beta"),
      node("live-2", false, "LiveTwo"),
    ]);
    const { container } = render(() => <OrphanBanner />);

    // Open the confirm dialog via the trigger button (located by text).
    buttonByText(container, "Archive orphans").click();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    // The confirm list (global .confirm-list) has exactly the 2 flagged nodes.
    const ids = Array.from(dialog!.querySelectorAll(".confirm-id")).map(
      (el) => el.textContent,
    );
    expect(ids.sort()).toEqual(["orphan-a", "orphan-b"]);
    // Lead text reports the flagged count.
    expect(dialog!.querySelector(".confirm-lead")!.textContent).toContain("2");
    // Live node ids must NOT appear anywhere in the dialog.
    expect(dialog!.textContent).not.toContain("live-1");
    expect(dialog!.textContent).not.toContain("live-2");
  });
});

describe("OrphanBanner — confirm flow targets only flagged ids", () => {
  it("clicking Archive calls archiveSession for ONLY the flagged ids", async () => {
    seedTreeStore([
      node("orphan-a", true),
      node("live-1", false),
      node("orphan-b", true),
      node("live-2", false),
    ]);
    const { container } = render(() => <OrphanBanner />);

    // Open + confirm (both buttons located by text; .confirm-go is a global class).
    buttonByText(container, "Archive orphans").click();
    container.querySelector(".confirm-go")!.click();

    // The confirm loop awaits each archiveSession; flush the microtask chain.
    await vi.waitFor(() => expect(archiveSpy).toHaveBeenCalledTimes(2));

    // Only the flagged ids were archived (live ids never passed to the API).
    const archived = archiveSpy.mock.calls.map((c) => c[0]).sort();
    expect(archived).toEqual(["orphan-a", "orphan-b"]);
  });

  it("a single orphan archives exactly one id", async () => {
    seedTreeStore([node("only", true), node("live", false)]);
    const { container } = render(() => <OrphanBanner />);

    buttonByText(container, "Archive orphans").click();
    container.querySelector(".confirm-go")!.click();

    await vi.waitFor(() => expect(archiveSpy).toHaveBeenCalledTimes(1));
    expect(archiveSpy).toHaveBeenCalledWith("only");
  });
});
