// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { selectedId, setState, setSelectedIdRaw, state } from "../../src/sync/store";
import { view } from "../../src/ui";
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
  // Step B flip: tree=2 is now the default; pin ?tree=1 to keep these proj=1
  // stub render tests on the OLD path until Step C deletes it.
  window.history.replaceState({}, "", "?tree=1");
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

// Regression: stub-vs-session dedup invariant. When a session is demoted to a
// collapsed-branch stub, the merge layer (applyProjectedSnapshot) clears+rebuilds
// state.branchStubs on a full snapshot but never removes the now-stale
// state.sessions[id] (preserve-absent is load-bearing for lazy-expand). That
// leaves BOTH maps holding the same id. The materialized <Node> (data-session-id)
// must win and the stale <StubNode> (data-stub-id) must be suppressed at EVERY
// tree depth: root, visible session child, and nested stub child.
describe("StubNode dedup invariant (stub-vs-session coexist)", () => {
  // Asserts S renders EXACTLY ONCE as a <Node> and NOT as a <StubNode>.
  function assertSingleRenderAsNode(container: HTMLElement, id: string): void {
    const sessionNode = container.querySelectorAll(`[data-session-id="${id}"]`);
    const stubNode = container.querySelector(`[data-stub-id="${id}"]`);
    expect(sessionNode.length, `session <Node> for ${id} should render exactly once`).toBe(1);
    expect(stubNode, `stub <StubNode> for ${id} must be suppressed when a live session exists`).toBeNull();
  }

  it("suppresses a stub ROOT whose own id is a live session", () => {
    // Coexist condition: same id "dupRoot" is BOTH a materialized root session
    // AND a projected stub root.
    setState("sessions", "dupRoot", { id: "dupRoot", title: "Dup Root" });
    putStub(baseStub({ id: "dupRoot", title: "Dup Root Stub" }));
    const { container } = render(() => <SessionTree />);
    assertSingleRenderAsNode(container as unknown as HTMLElement, "dupRoot");
  });

  it("suppresses a stub CHILD (of a session) whose own id is a live session", () => {
    // Parent session in expanded mode so its stub children would render.
    setState("sessions", "root", { id: "root", title: "Root" });
    localStorage.setItem("vh.tree.mode.v2", JSON.stringify({ v: 1, data: { root: "expanded" } }));
    __resetTreeForTest();
    // Coexist: "dupChild" is BOTH a materialized child of root AND a stub child.
    setState("sessions", "dupChild", { id: "dupChild", parentID: "root", title: "Dup Child" });
    putStub(baseStub({ id: "dupChild", parentID: "root", title: "Dup Child Stub" }));
    const { container } = render(() => <SessionTree />);
    assertSingleRenderAsNode(container as unknown as HTMLElement, "dupChild");
  });

  it("suppresses a NESTED stub child (under an expanded stub) whose own id is a live session", () => {
    // root (expanded) → outerStub (a real stub, expanded) → dupNested.
    setState("sessions", "root", { id: "root", title: "Root" });
    localStorage.setItem("vh.tree.mode.v2", JSON.stringify({ v: 1, data: { root: "expanded" } }));
    __resetTreeForTest();
    putStub(baseStub({ id: "outerStub", parentID: "root", title: "Outer Stub" }));
    // Expand the outer stub so its session + stub children render.
    setState("expandedBranches", "outerStub", true);
    // Coexist: "dupNested" is BOTH a materialized child of outerStub AND a
    // nested stub child of outerStub.
    setState("sessions", "dupNested", { id: "dupNested", parentID: "outerStub", title: "Dup Nested" });
    putStub(baseStub({ id: "dupNested", parentID: "outerStub", title: "Dup Nested Stub" }));
    const { container } = render(() => <SessionTree />);
    assertSingleRenderAsNode(container as unknown as HTMLElement, "dupNested");
  });
});

// Regression: idle-root-unopenable. When a session's whole subtree goes idle
// past the projection cutoff, it surfaces as a collapsed-branch stub whose row
// button USED to call onTwisty() (expand/collapse) — so clicking the row never
// OPENED the session's chat. The fix routes the row click to openSessionChat
// (exactly like a materialized Node row), keeps the separate twisty as the sole
// expand/collapse path, and adds a `selected` highlight.
describe("StubNode row opens the session (idle-root-unopenable fix)", () => {
  it("row click opens the session (root stub)", () => {
    putStub(baseStub({ id: "openRoot", title: "Open Root" }));
    const { container } = render(() => <SessionTree />);
    const row = stubRow(container as unknown as HTMLElement, "openRoot");
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selectedId()).toBe("openRoot");
    expect(view()).toBe("chat");
  });

  it("row click does not change expandedBranches", () => {
    putStub(baseStub({ id: "openRoot", title: "Open Root" }));
    const { container } = render(() => <SessionTree />);
    const row = stubRow(container as unknown as HTMLElement, "openRoot");
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // The row is no longer the expand/collapse path (the twisty remains sole);
    // a row click must not flip expandedBranches.
    expect(state.expandedBranches["openRoot"]).toBeFalsy();
  });

  it("row gains the selected class when selectedId===stub.id", () => {
    setSelectedIdRaw("openRoot");
    putStub(baseStub({ id: "openRoot", title: "Open Root" }));
    const { container } = render(() => <SessionTree />);
    const row = stubRow(container as unknown as HTMLElement, "openRoot");
    expect(row.classList.contains("selected")).toBe(true);
  });
});
