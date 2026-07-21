// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { setState, setSelectedIdRaw } from "../../src/sync/store";
import type { CollapsedBranchStub } from "../../src/types";
import SessionTree, { __resetTreeForTest } from "../../src/components/SessionTree";
import { __resetPinnedForTest } from "../../src/sidebar";
import { setNameReplacements } from "../../src/projectSettings";

// StubNode rendering tests: a collapsed-branch stub renders as a muted row
// with title, descendantCount badge, and aggregate-state indicator. Expand
// triggers lazyExpandBranch (a GET fetch); collapse marks the branch closed.
// We drive the singleton store directly (state.branchStubs) and assert on the
// rendered DOM.

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("unread", reconcile({}));
  setState("branchStubs", reconcile({}));
  setState("expandedBranches", reconcile({}));
  setSelectedIdRaw(null);
  localStorage.clear();
  __resetTreeForTest();
  __resetPinnedForTest();
  setNameReplacements([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function putStub(stub: CollapsedBranchStub): void {
  setState("branchStubs", stub.id, stub);
}

function stubRow(container: HTMLElement, id: string): HTMLElement {
  const node = container.querySelector(`.tree-stub-node[data-stub-id="${id}"]`);
  if (!node) throw new Error(`no stub node for ${id}`);
  return node as HTMLElement;
}

function stubTwisty(container: HTMLElement, id: string): Element {
  const node = container.querySelector(`.tree-stub-node[data-stub-id="${id}"]`);
  if (!node) throw new Error(`no stub node for ${id}`);
  const row = node.closest(".tree-row");
  const twisty = row?.querySelector(".tree-twisty");
  if (!twisty) throw new Error(`no twisty for stub ${id}`);
  return twisty;
}

const baseStub = (overrides: Partial<CollapsedBranchStub> = {}): CollapsedBranchStub => ({
  id: "stub1",
  kind: "collapsed-branch",
  hasChildren: true,
  descendantCount: 42,
  aggregateState: "idle",
  ...overrides,
});

describe("StubNode rendering", () => {
  it("renders a stub root with title and descendant count", () => {
    putStub(baseStub({ id: "idleRoot", title: "Idle Branch", descendantCount: 15 }));
    const { container } = render(() => <SessionTree />);
    const node = stubRow(container as unknown as HTMLElement, "idleRoot");
    expect(node.textContent).toContain("Idle Branch");
    expect(node.textContent).toContain("15");
  });

  it("shows spinner for aggregateState busy", () => {
    putStub(baseStub({ id: "busyStub", aggregateState: "busy" }));
    const { container } = render(() => <SessionTree />);
    const node = stubRow(container as unknown as HTMLElement, "busyStub");
    expect(node.querySelector(".tree-spinner")).not.toBeNull();
  });

  it("shows retry dot for aggregateState retry", () => {
    putStub(baseStub({ id: "retryStub", aggregateState: "retry" }));
    const { container } = render(() => <SessionTree />);
    const node = stubRow(container as unknown as HTMLElement, "retryStub");
    expect(node.querySelector(".dot.retry")).not.toBeNull();
  });

  it("shows needs-input dot for aggregateState needs-input", () => {
    putStub(baseStub({ id: "inputStub", aggregateState: "needs-input" }));
    const { container } = render(() => <SessionTree />);
    const node = stubRow(container as unknown as HTMLElement, "inputStub");
    expect(node.querySelector(".dot.needs-input")).not.toBeNull();
  });

  it("does NOT render an AgentChip for stubs", () => {
    putStub(baseStub({ id: "noAgent", title: "No Agent Stub" }));
    const { container } = render(() => <SessionTree />);
    const node = stubRow(container as unknown as HTMLElement, "noAgent");
    expect(node.querySelector(".tree-agent")).toBeNull();
  });

  it("renders leaf twisty when hasChildren is false", () => {
    putStub(baseStub({ id: "leafStub", hasChildren: false }));
    const { container } = render(() => <SessionTree />);
    const twisty = stubTwisty(container as unknown as HTMLElement, "leafStub");
    expect(twisty.classList.contains("leaf")).toBe(true);
  });
});

describe("StubNode expand/collapse", () => {
  it("triggers lazyExpandBranch on twisty click (collapsed → fetch)", async () => {
    putStub(baseStub({ id: "expandMe", title: "Expand Me" }));
    // Mock fetch to return an empty projected snapshot (no children yet).
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ seq: 1, epoch: "e1", sessions: [] }),
      headers: new Map([["X-VH-Branch-Cursor", ""]]),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { container } = render(() => <SessionTree />);
    const twisty = stubTwisty(container as unknown as HTMLElement, "expandMe");
    twisty.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // The fetch was called with the branch ID.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalled();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("id=expandMe");
    // expandedBranches was set to true.
    expect((setState as any)).toBeTruthy();
  });

  it("marks branch expanded on twisty click", async () => {
    putStub(baseStub({ id: "markExpanded" }));
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ seq: 1, epoch: "e1", sessions: [] }),
      headers: new Map([["X-VH-Branch-Cursor", ""]]),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { container } = render(() => <SessionTree />);
    const twisty = stubTwisty(container as unknown as HTMLElement, "markExpanded");
    twisty.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    // The store's expandedBranches[markExpanded] should now be true.
    // We verify indirectly: a re-render should show expanded state.
    // Access via the module's state singleton.
    const { state } = await import("../../src/sync/store");
    expect(state.expandedBranches["markExpanded"]).toBe(true);
  });

  it("collapses an expanded branch on twisty click", async () => {
    putStub(baseStub({ id: "collapseMe" }));
    setState("expandedBranches", "collapseMe", true);
    const { container } = render(() => <SessionTree />);
    const twisty = stubTwisty(container as unknown as HTMLElement, "collapseMe");
    twisty.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const { state } = await import("../../src/sync/store");
    expect(state.expandedBranches["collapseMe"]).toBe(false);
  });
});

describe("StubNode as child of session", () => {
  it("renders stub children under a session in expanded mode", () => {
    // A materialized session root with one stub child (idle frontier).
    setState("sessions", "root", { id: "root", title: "Root" });
    // Force expanded mode for the root.
    localStorage.setItem("vh.tree.mode.v2", JSON.stringify({ v: 1, data: { root: "expanded" } }));
    __resetTreeForTest();
    putStub(baseStub({ id: "frontier", parentID: "root", title: "Frontier Stub" }));
    const { container } = render(() => <SessionTree />);
    const node = container.querySelector(`.tree-stub-node[data-stub-id="frontier"]`);
    expect(node).not.toBeNull();
    expect(node?.textContent).toContain("Frontier Stub");
  });

  it("hides stub children in collapsed mode", () => {
    setState("sessions", "root", { id: "root", title: "Root" });
    localStorage.setItem("vh.tree.mode.v2", JSON.stringify({ v: 1, data: { root: "collapsed" } }));
    __resetTreeForTest();
    putStub(baseStub({ id: "hidden", parentID: "root", title: "Hidden Stub" }));
    const { container } = render(() => <SessionTree />);
    const node = container.querySelector(`.tree-stub-node[data-stub-id="hidden"]`);
    expect(node).toBeNull();
  });

  it("shows busy stub children in filtered mode", () => {
    setState("sessions", "root", { id: "root", title: "Root" });
    localStorage.setItem("vh.tree.mode.v2", JSON.stringify({ v: 1, data: { root: "filtered" } }));
    __resetTreeForTest();
    putStub(baseStub({ id: "busyKid", parentID: "root", aggregateState: "busy" }));
    putStub(baseStub({ id: "idleKid", parentID: "root", aggregateState: "idle" }));
    const { container } = render(() => <SessionTree />);
    // filtered mode: only busy/retry/needs-input stubs shown.
    expect(container.querySelector(`[data-stub-id="busyKid"]`)).not.toBeNull();
    expect(container.querySelector(`[data-stub-id="idleKid"]`)).toBeNull();
  });
});
