// @vitest-environment jsdom
//
// ArchiveFailureBanner — Slice 1 of the archive-failure chain: the operator-
// facing visibility surface for PERMANENTLY-STUCK archive ROOTS (retry-exhausted
// / OpenCode 400-403). Distinct from OrphanBanner (descendants of a
// successfully-archived root) in data source, semantics, and labels.
//
// These tests pin the Slice-1 frontend contract:
//   RT8  Tree-independence: the banner renders from the archiveFailures() SSE
//        signal EVEN WHEN the client tree is empty/pruned (the tree eager-prunes
//        accepted ids and doesn't re-emit retained stuck roots — Q5 — so the
//        banner CANNOT anchor to a tree node).
//   RT9  Dismiss/collapse does NOT erase unresolved server state: collapsing the
//        expanded list hides the detail but leaves the archiveFailures() signal
//        intact (the summary banner stays; the server record is authoritative).
//   RT10 Reason display: the banner shows the classified reason token
//        ("permanent:403", "exhausted:5", "cancelled:shutdown") VERBATIM, never
//        raw opencode.Error.Body (the client never receives it).
//   +    Multi-failure UX: count + expandable list; retry calls archiveSession.
//   +    Never "orphan": the banner's wording is distinct from OrphanBanner.
//
// The SERVER-side snapshot/updated emission is pinned in
// pkg/web/archive_failures_test.go; these web tests assert the banner reflects
// the signal-driven DTO correctly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import ArchiveFailureBanner from "../../src/components/ArchiveFailureBanner";
import {
  archiveFailures,
  applyArchiveFailuresSnapshot,
  applyArchiveFailuresUpdated,
  resetArchiveFailuresScope,
  __resetArchiveFailuresForTest,
} from "../../src/archiveFailures";
import { resetTreeStore } from "../../src/sync/treeState";

// Mock archiveSession so the retry flow does not hit the network. The hoisted
// spy resolves to [id] (the documented success shape).
const archiveSpy = vi.hoisted(() => vi.fn(async (id: string) => [id]));
vi.mock("../../src/archive", () => ({ archiveSession: archiveSpy }));

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
  // Reset the module-scoped archiveFailures signal AND scope-gen to a clean
  // baseline (zero scope-gen) so each test starts deterministic.
  __resetArchiveFailuresForTest();
});

afterEach(() => {
  cleanup();
  resetTreeStore();
  __resetArchiveFailuresForTest();
});

describe("ArchiveFailureBanner — render gate", () => {
  it("renders NOTHING when there are no archive failures", () => {
    applyArchiveFailuresSnapshot({ failures: [] });
    const { container } = render(() => <ArchiveFailureBanner />);
    expect(container.textContent).not.toContain("archive failure");
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders NOTHING when the tree store is empty but the signal is empty (tree-independence — empty tree does not suppress)", () => {
    // Tree store is empty (no sessions at all). The signal is ALSO empty.
    // The banner renders nothing — but the point is it would render from the
    // signal, not the tree. The tree-independence positive case is the next test.
    resetTreeStore();
    const { container } = render(() => <ArchiveFailureBanner />);
    expect(container.textContent).not.toContain("archive failure");
  });
});

describe("ArchiveFailureBanner — RT8 tree-independence", () => {
  it("renders the banner from the DTO signal EVEN WHEN the client tree is empty/pruned", () => {
    // The client tree is EMPTY (the root was eager-pruned by a prior accepted
    // archive, and the tree doesn't proactively re-emit retained stuck roots).
    // The banner must STILL surface the failure — it reads the SSE-driven DTO,
    // not the tree. This is the Q5 finding: the banner CANNOT anchor to a tree
    // node, so it renders from the signal.
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [{ id: "stuck-root", reason: "permanent:403", at: 1700000000000 }],
    });

    const { container } = render(() => <ArchiveFailureBanner />);
    expect(container.textContent).toContain("1 archive failure");
    // Expand to reveal the stuck-root id (it lives in the detail list, not the
    // summary count). This proves the banner surfaces the id from the signal,
    // independent of the (empty) tree.
    buttonByText(container, "Show").click();
    expect(container.textContent).toContain("stuck-root");
  });

  it("uses the singular 'failure' for exactly one stuck root", () => {
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [{ id: "solo", reason: "exhausted:5", at: 1 }],
    });
    const { container } = render(() => <ArchiveFailureBanner />);
    expect(container.textContent).toContain("1 archive failure");
  });

  it("renders the correct count for multiple stuck roots", () => {
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [
        { id: "a", reason: "permanent:403", at: 1 },
        { id: "b", reason: "exhausted:5", at: 2 },
      ],
    });
    const { container } = render(() => <ArchiveFailureBanner />);
    expect(container.textContent).toContain("2 archive failures");
  });
});

describe("ArchiveFailureBanner — RT10 classified reason display", () => {
  it("shows the classified reason token verbatim in the expanded list", () => {
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [{ id: "r403", reason: "permanent:403", at: 1 }],
    });
    const { container } = render(() => <ArchiveFailureBanner />);
    buttonByText(container, "Show").click();
    expect(container.textContent).toContain("permanent:403");
  });

  it("NEVER displays raw opencode.Error.Body prose (regression guard)", () => {
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [{ id: "r", reason: "exhausted:5", at: 1 }],
    });
    const { container } = render(() => <ArchiveFailureBanner />);
    buttonByText(container, "Show").click();
    // The DTO carries only the classified token; the banner must not render any
    // upstream "Body" field. This is the structural guarantee that the client
    // never leaks raw opencode error prose.
    expect(container.textContent).not.toContain("Body");
    expect(container.textContent).not.toContain("body");
    // The data-reason attribute anchors the token for DOM-level assertions.
    const reasonEl = container.querySelector("[data-reason]");
    expect(reasonEl).toBeTruthy();
    expect(reasonEl!.getAttribute("data-reason")).toBe("exhausted:5");
  });

  it("shows the cancelled:shutdown token for a shutdown-cancelled archive", () => {
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [{ id: "c", reason: "cancelled:shutdown", at: 1 }],
    });
    const { container } = render(() => <ArchiveFailureBanner />);
    buttonByText(container, "Show").click();
    expect(container.textContent).toContain("cancelled:shutdown");
  });
});

describe("ArchiveFailureBanner — RT9 collapse does not erase server state", () => {
  it("collapsing the expanded list leaves the archiveFailures signal intact", () => {
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [{ id: "r", reason: "permanent:403", at: 1 }],
    });
    const { container } = render(() => <ArchiveFailureBanner />);

    // Expand, then collapse.
    buttonByText(container, "Show").click();
    expect(container.textContent).toContain("permanent:403");
    buttonByText(container, "Hide").click();
    // The detail list is gone (collapsed), but the summary banner stays.
    expect(container.textContent).toContain("1 archive failure");

    // The SIGNAL is untouched — collapse is CLIENT-ONLY UI state. The server
    // record is authoritative; the warning clears only when the server emits an
    // updated frame with the id removed (clear-on-success).
    expect(archiveFailures().length).toBe(1);
    expect(archiveFailures()[0].id).toBe("r");
  });
});

describe("ArchiveFailureBanner — retry flow", () => {
  it("clicking Retry calls archiveSession with the stuck id", async () => {
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [{ id: "stuck-1", reason: "permanent:403", at: 1 }],
    });
    const { container } = render(() => <ArchiveFailureBanner />);
    buttonByText(container, "Show").click();
    buttonByText(container, "Retry").click();

    await vi.waitFor(() => expect(archiveSpy).toHaveBeenCalledTimes(1));
    expect(archiveSpy).toHaveBeenCalledWith("stuck-1");
  });

  it("Retry all archives every stuck id (multiple failures)", async () => {
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [
        { id: "a", reason: "permanent:403", at: 1 },
        { id: "b", reason: "exhausted:5", at: 2 },
      ],
    });
    const { container } = render(() => <ArchiveFailureBanner />);
    buttonByText(container, "Show").click();
    buttonByText(container, "Retry all").click();

    await vi.waitFor(() => expect(archiveSpy).toHaveBeenCalledTimes(2));
    const archived = archiveSpy.mock.calls.map((c) => c[0]).sort();
    expect(archived).toEqual(["a", "b"]);
  });
});

describe("ArchiveFailureBanner — never conflates with orphan", () => {
  it("uses 'archive failure' wording, NEVER 'orphan'", () => {
    resetTreeStore();
    applyArchiveFailuresSnapshot({
      failures: [{ id: "r", reason: "permanent:403", at: 1 }],
    });
    const { container } = render(() => <ArchiveFailureBanner />);
    expect(container.textContent).toContain("archive failure");
    // The orphan banner's wording must NEVER appear here (distinct surfaces).
    expect(container.textContent).not.toContain("orphan");
    expect(container.textContent).not.toContain("Archive orphans");
  });
});

// ===========================================================================
// Project-switch isolation (F1 fix — mirrors resetLabelsScope / labelsScopeGen).
// The archiveFailures() signal is per-project on the server (snapshot filtered
// to reqDir(r); fan-out per-project). The CLIENT signal must be cleared on every
// switchProject so the outgoing project's failures don't leak. These tests drive
// the facade directly (resetArchiveFailuresScope + apply*) to pin the contract
// the transport-level treeGen guard + the reset clear enforce together.
// ===========================================================================
describe("ArchiveFailureBanner — project-switch isolation (F1 fix)", () => {
  it("no-project switch: after resetArchiveFailuresScope, the banner is empty even if A had failures", () => {
    // Seed project A's failures.
    applyArchiveFailuresSnapshot({
      failures: [
        { id: "A-root", reason: "permanent:403", at: 1 },
        { id: "A-other", reason: "exhausted:5", at: 2 },
      ],
    });
    let { container } = render(() => <ArchiveFailureBanner />);
    expect(container.textContent).toContain("2 archive failures");

    // switchProject('') calls resetArchiveFailuresScope → signal clears. On the
    // no-project path connect() opens NO stream → no snapshot arrives → without
    // the reset, A's banner would render INDEFINITELY. The reset is the fix.
    resetArchiveFailuresScope();
    cleanup();
    container = render(() => <ArchiveFailureBanner />).container;
    expect(container.textContent).not.toContain("archive failure");
    expect(container.textContent).not.toContain("A-root");
    expect(archiveFailures()).toEqual([]);
  });

  it("A→B switch: A's failures do NOT render in B's banner before B's snapshot lands", () => {
    // Seed project A's failures.
    applyArchiveFailuresSnapshot({
      failures: [{ id: "A-root", reason: "permanent:403", at: 1 }],
    });
    let { container } = render(() => <ArchiveFailureBanner />);
    expect(container.textContent).toContain("1 archive failure");

    // switchProject('/B') calls resetArchiveFailuresScope → A's signal clears
    // IMMEDIATELY, before B's stream connects + delivers B's snapshot. In the
    // transient window before B's snapshot, the banner must be EMPTY (no leak).
    resetArchiveFailuresScope();
    cleanup();
    container = render(() => <ArchiveFailureBanner />).container;
    expect(container.textContent).not.toContain("A-root");
    expect(container.textContent).not.toContain("archive failure");

    // Now B's snapshot arrives → B's failures (not A's) populate the banner.
    applyArchiveFailuresSnapshot({
      failures: [{ id: "B-root", reason: "exhausted:5", at: 3 }],
    });
    expect(container.textContent).toContain("1 archive failure");
    // B-root is in the expanded list; expand to confirm it, and confirm A-root
    // is NOT present (no leak).
    buttonByText(container, "Show").click();
    expect(container.textContent).toContain("B-root");
    expect(container.textContent).not.toContain("A-root");
  });

  it("resetArchiveFailuresScope clears the signal (the load-bearing fix for the no-project indefinite leak)", () => {
    // Seed A's failures.
    applyArchiveFailuresSnapshot({
      failures: [{ id: "A-root", reason: "permanent:403", at: 1 }],
    });
    expect(archiveFailures()).toHaveLength(1);

    // switchProject('') calls resetArchiveFailuresScope. On the no-project path
    // connect() opens NO stream → no snapshot arrives → the signal MUST be
    // cleared by the reset (not by a later frame). This is the load-bearing fix.
    resetArchiveFailuresScope();
    expect(archiveFailures()).toEqual([]);

    // The signal stays empty — no ghost banner in the no-project state.
    const { container } = render(() => <ArchiveFailureBanner />);
    expect(container.textContent).not.toContain("archive failure");
  });

  it("late-frame from A: dropped by treeGen at the transport listener (documented, not re-tested here)", () => {
    // The primary guard against a late archive-failures frame from A's closed
    // stream reaching the facade is the TRANSPORT-level connection-generation
    // check (sync/tree-transport.ts: `if (gen !== treeGen) return;`), which is
    // already pinned by stream1Registration.test.ts (the gen-guard is the FIRST
    // line of every auxiliary listener, including archive-failures.*). A frame
    // from A's closed EventSource never reaches applyArchiveFailuresUpdated.
    //
    // The facade-level archiveFailuresScopeGen check inside the apply functions
    // is DEFENSE-IN-DEPTH (the apply path is synchronous today, so the check is
    // structurally a no-op — same layering as labels, where scopeGen guards the
    // PUT mutation path, NOT the SSE apply path). This test documents the
    // layering rather than duplicating the transport gen-guard test: the
    // facade's contract is "reset clears the signal"; the transport's contract
    // is "treeGen drops stale frames." Together they close the leak.
    applyArchiveFailuresSnapshot({
      failures: [{ id: "A-root", reason: "permanent:403", at: 1 }],
    });
    expect(archiveFailures()).toHaveLength(1);
    resetArchiveFailuresScope();
    // The facade held up its end: the signal is cleared.
    expect(archiveFailures()).toEqual([]);
    // A fresh frame (the new project's) adopts cleanly — the scope is valid.
    applyArchiveFailuresSnapshot({
      failures: [{ id: "B-root", reason: "exhausted:5", at: 2 }],
    });
    expect(archiveFailures()[0]?.id).toBe("B-root");
  });
});
