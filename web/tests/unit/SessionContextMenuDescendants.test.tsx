// @vitest-environment jsdom
//
// D8 — SessionContextMenu descendants fetch-effect (P4).
//
// SessionContextMenu.tsx:121-144 fetches the server-authoritative descendant
// list (GET /vh/session/:id/descendants) when the archive confirm dialog opens
// (archiveTarget set). It optimistically seeds [{id, title}] (the target is
// always in the affected set) so there is no empty-flash, then on success
// replaces the seed with the server list (or keeps it on failure / empty). A
// monotonic `relatedReqId` discards a prior in-flight response if the target
// changed.
//
// The server wire contract is pinned by Go tests under pkg/web/. The existing
// SessionContextMenu.{test,boundary}.test.tsx cover ONLY the menu display / raw
// boundary — NOT this fetch effect. These tests pin the optimistic seed,
// success-replaces, failure-keeps-seed, stale-discarded, and unmount-noop
// behaviors.
//
// fetchDescendants is mocked at the source (archive.ts) so we control
// resolution order; archiveSession stays real (it is not exercised by the fetch
// effect — only by a confirm-click we never trigger here).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { setState, setSelectedIdRaw } from "../../src/sync/store";
import SessionContextMenu from "../../src/components/SessionContextMenu";
import {
  closeArchiveConfirm,
  closeSessionMenu,
  openArchiveConfirm,
} from "../../src/sessionMenu";
import { __resetPinnedForTest } from "../../src/pins";
import type { DescendantsResp } from "../../src/archive";

// fetchDescendants: controlled mock. Hoisted so the factory can reference it.
const { fetchDescendantsMock } = vi.hoisted(() => ({
  fetchDescendantsMock: vi.fn(),
}));
// Partial mock: keep the real archive.ts (archiveSession, restoreAndOpen, etc.
// — none exercised here) and override ONLY fetchDescendants.
vi.mock("../../src/archive", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchDescendants: fetchDescendantsMock };
});

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("unread", reconcile({}));
  setSelectedIdRaw(null);
  localStorage.clear();
  __resetPinnedForTest();
  closeSessionMenu();
  closeArchiveConfirm();
  fetchDescendantsMock.mockReset();
});
afterEach(() => cleanup());

// Build a well-formed DescendantsResp. The first descendant is conventionally
// the target itself (the affected root); the rest are its subsessions.
function descResp(
  targetId: string,
  descendants: { id: string; title: string }[],
): DescendantsResp {
  return {
    epoch: "e1",
    revision: 1,
    data: { sessionId: targetId, descendants },
  };
}

// A controllable pending promise so a fetch can be held in-flight across a
// re-open / unmount and then resolved to prove stale suppression / noop.
function deferred<T = DescendantsResp>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// The confirm dialog root.
function confirmDialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.dialog.confirm[aria-label="Confirm archive"]');
}
// The rendered descendant rows (optimistic seed OR server list).
function listItems(container: HTMLElement): HTMLElement[] {
  return Array.from(
    confirmDialog(container)?.querySelectorAll(".confirm-list li") ?? [],
  ) as HTMLElement[];
}
// The displayed title of the i-th row (displayName is identity with no
// nameReplacement rules active).
function rowTitle(container: HTMLElement, i: number): string {
  const li = listItems(container)[i];
  return (li?.querySelector(".confirm-title")?.textContent ?? "").trim();
}
// The confirm-lead sentence, e.g. "This will archive 2 sessions ...".
function leadText(container: HTMLElement): string {
  return (
    confirmDialog(container)?.querySelector(".confirm-lead")?.textContent ??
    ""
  ).replace(/\s+/g, " ").trim();
}
// The confirm-action button label, e.g. "Archive 2 sessions" / "Archive session".
function goLabel(container: HTMLElement): string {
  return (
    confirmDialog(container)?.querySelector(".confirm-go")?.textContent ?? ""
  ).trim();
}

describe("SessionContextMenu descendants fetch-effect (D8)", () => {
  it("optimistically seeds [{id,title}] before the fetch resolves", async () => {
    // Keep the fetch pending so the seed is the ONLY thing rendered.
    const pending = deferred();
    fetchDescendantsMock.mockImplementation(() => pending.promise);

    const { container } = render(() => <SessionContextMenu />);
    openArchiveConfirm("sx", "Title X");

    // The dialog mounts and the optimistic seed renders immediately (the effect
    // calls setRelatedItems([{id,title}]) synchronously before awaiting).
    await waitFor(() => expect(listItems(container as unknown as HTMLElement).length).toBe(1));
    expect(rowTitle(container as unknown as HTMLElement, 0)).toBe("Title X");
    expect(leadText(container as unknown as HTMLElement)).toMatch(/\b1 session\b/);
    expect(goLabel(container as unknown as HTMLElement)).toBe("Archive session");
    // The fetch was issued but has NOT resolved.
    expect(fetchDescendantsMock).toHaveBeenCalledTimes(1);
    expect(fetchDescendantsMock).toHaveBeenCalledWith("sx");
  });

  it("replaces the seed with the server list on success", async () => {
    fetchDescendantsMock.mockResolvedValue(
      descResp("sx", [
        { id: "sx", title: "Title X" },
        { id: "child", title: "Child" },
      ]),
    );

    const { container } = render(() => <SessionContextMenu />);
    openArchiveConfirm("sx", "Title X");

    await waitFor(() =>
      expect(listItems(container as unknown as HTMLElement).length).toBe(2),
    );
    expect(rowTitle(container as unknown as HTMLElement, 0)).toBe("Title X");
    expect(rowTitle(container as unknown as HTMLElement, 1)).toBe("Child");
    expect(leadText(container as unknown as HTMLElement)).toMatch(/\b2 sessions\b/);
    expect(goLabel(container as unknown as HTMLElement)).toBe("Archive 2 sessions");
  });

  it("keeps the optimistic seed on fetch failure", async () => {
    fetchDescendantsMock.mockRejectedValue(new Error("descendants fetch failed (500)"));

    const { container } = render(() => <SessionContextMenu />);
    openArchiveConfirm("sx", "Title X");

    // The catch branch keeps the seed; wait for the rejected fetch to settle.
    await waitFor(() =>
      expect(fetchDescendantsMock).toHaveBeenCalledTimes(1),
    );
    // Drain the rejection microtask.
    await new Promise((r) => setTimeout(r, 10));

    expect(listItems(container as unknown as HTMLElement).length).toBe(1);
    expect(rowTitle(container as unknown as HTMLElement, 0)).toBe("Title X");
    expect(goLabel(container as unknown as HTMLElement)).toBe("Archive session");
  });

  it("discards a stale response when the target changes (re-open)", async () => {
    // First open ("a"): hold the fetch in-flight.
    const stalePoll = deferred();
    fetchDescendantsMock.mockImplementationOnce(() => stalePoll.promise);
    // Subsequent opens resolve immediately. "b" returns a 2-item list.
    fetchDescendantsMock.mockResolvedValue(
      descResp("b", [
        { id: "b", title: "B" },
        { id: "bc", title: "BC" },
      ]),
    );

    const { container } = render(() => <SessionContextMenu />);
    openArchiveConfirm("a", "A");
    await waitFor(() => expect(fetchDescendantsMock).toHaveBeenCalledTimes(1));

    // Close (target→null clears the list; the effect returns early without a
    // fetch) then re-open a DIFFERENT target. The new open increments
    // relatedReqId, so "a"'s still-pending response becomes stale.
    closeArchiveConfirm();
    openArchiveConfirm("b", "B");
    await waitFor(() =>
      expect(listItems(container as unknown as HTMLElement).length).toBe(2),
    );
    expect(rowTitle(container as unknown as HTMLElement, 0)).toBe("B");

    // Now resolve "a"'s stale response with a 3-item list. It must be discarded
    // — the monotonic guard (myReq !== relatedReqId) returns before
    // setRelatedItems, so "b"'s 2-item list stays.
    stalePoll.resolve(
      descResp("a", [
        { id: "a", title: "A" },
        { id: "ac", title: "AC" },
        { id: "ac2", title: "AC2" },
      ]),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(listItems(container as unknown as HTMLElement).length).toBe(2);
    expect(rowTitle(container as unknown as HTMLElement, 0)).toBe("B");
    expect(rowTitle(container as unknown as HTMLElement, 1)).toBe("BC");
  });

  it("is a no-op when the in-flight fetch resolves after unmount", async () => {
    // Unlike D6's subtree-todos effect, this effect is a one-shot fetch with NO
    // onCleanup — so `relatedReqId` is NOT bumped on unmount and the monotonic
    // guard does not fire here. The observable safety is Solid's disposed-signal
    // tolerance: the late resolve's `setRelatedItems` write (guarded by
    // `myReq === relatedReqId`, which still holds) lands on a disposed scope and
    // is a no-op. We assert no crash and no retry.
    const inFlight = deferred();
    fetchDescendantsMock.mockImplementation(() => inFlight.promise);

    const { unmount } = render(() => <SessionContextMenu />);
    openArchiveConfirm("sx", "Title X");
    await waitFor(() => expect(fetchDescendantsMock).toHaveBeenCalledTimes(1));

    unmount();

    // Resolving the in-flight fetch after unmount must not throw and must not
    // trigger any further fetch.
    expect(() => inFlight.resolve(descResp("sx", [{ id: "sx", title: "Title X" }]))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchDescendantsMock).toHaveBeenCalledTimes(1);
  });
});
