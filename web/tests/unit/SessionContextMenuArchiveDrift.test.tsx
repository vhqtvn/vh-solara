// @vitest-environment jsdom
//
// C5 — SessionContextMenu.doArchive drift re-preview path (FE component).
//
// When archiveSession throws ArchiveDriftError (the server returned 409 because
// the affected set's membership changed between preview and commit), doArchive:
//   1. does NOT close the confirmation dialog (it stays open for re-consent);
//   2. re-fetches descendants and updates the displayed list + fingerprint;
//   3. does NOT auto-retry the archive (exactly one archiveSession call) — the
//      operator must click Confirm again against the new set.
//
// This is the FE half of the C5 crux. The Go half (the server actually 409s and
// archives nothing) is pkg/web/archive_drift_test.go.
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
import { __resetPinnedForTest } from "../../src/sidebar";
import { ArchiveDriftError } from "../../src/archive";
import type { DescendantsResp } from "../../src/archive";

// fetchDescendants + archiveSession are both mocked at the source (archive.ts)
// so we control resolution order and the drift throw.
const { fetchDescendantsMock, archiveSessionMock } = vi.hoisted(() => ({
  fetchDescendantsMock: vi.fn(),
  archiveSessionMock: vi.fn(),
}));
vi.mock("../../src/archive", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchDescendants: fetchDescendantsMock,
    archiveSession: archiveSessionMock,
  };
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
  archiveSessionMock.mockReset();
});
afterEach(() => cleanup());

function descResp(
  targetId: string,
  descendants: { id: string; title: string }[],
  fingerprint: string,
): DescendantsResp {
  return {
    epoch: "e1",
    revision: 1,
    data: { sessionId: targetId, descendants, fingerprint },
  };
}

function confirmDialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.dialog.confirm[aria-label="Confirm archive"]');
}
function listItems(container: HTMLElement): HTMLElement[] {
  return Array.from(
    confirmDialog(container)?.querySelectorAll(".confirm-list li") ?? [],
  ) as HTMLElement[];
}
function goLabel(container: HTMLElement): string {
  return (
    confirmDialog(container)?.querySelector(".confirm-go")?.textContent ?? ""
  ).trim();
}

describe("SessionContextMenu.doArchive — C5 drift re-preview (no auto-retry)", () => {
  it("on ArchiveDriftError: re-fetches, re-shows the new set, and does NOT retry", async () => {
    // First preview: 2 sessions, fingerprint fp-v1.
    fetchDescendantsMock.mockResolvedValueOnce(
      descResp("sx", [
        { id: "sx", title: "Title X" },
        { id: "c1", title: "Child 1" },
      ], "fp-v1"),
    );
    // The drift: archiveSession throws ArchiveDriftError (server saw a spawn).
    archiveSessionMock.mockRejectedValueOnce(
      new ArchiveDriftError(["sx", "c1", "c2"], "fp-v2"),
    );
    // The re-preview (fired by doArchive's catch): 3 sessions now, fingerprint fp-v2.
    fetchDescendantsMock.mockResolvedValueOnce(
      descResp("sx", [
        { id: "sx", title: "Title X" },
        { id: "c1", title: "Child 1" },
        { id: "c2", title: "Child 2 (spawned)" },
      ], "fp-v2"),
    );

    const { container } = render(() => <SessionContextMenu />);
    openArchiveConfirm("sx", "Title X");

    // Wait for the initial preview (fp-v1) to land.
    await waitFor(() =>
      expect(listItems(container as unknown as HTMLElement).length).toBe(2),
    );
    // archiveSession was NOT called yet.
    expect(archiveSessionMock).not.toHaveBeenCalled();

    // Click "Archive 2 sessions" → doArchive runs → archiveSession(sx, fp-v1)
    // → throws ArchiveDriftError.
    const go = confirmDialog(container as unknown as HTMLElement)?.querySelector(
      ".confirm-go",
    ) as HTMLButtonElement | null;
    expect(go).toBeTruthy();
    go!.click();

    // archiveSession called exactly once with the preview fingerprint.
    await waitFor(() => expect(archiveSessionMock).toHaveBeenCalledTimes(1));
    expect(archiveSessionMock).toHaveBeenCalledWith("sx", "fp-v1");

    // The catch re-fetches descendants (re-preview). Wait for it.
    await waitFor(() => expect(fetchDescendantsMock).toHaveBeenCalledTimes(2));

    // The dialog STAYS OPEN (re-show) and now lists the 3-session set.
    await waitFor(() =>
      expect(listItems(container as unknown as HTMLElement).length).toBe(3),
    );
    expect(goLabel(container as unknown as HTMLElement)).toBe(
      "Archive 3 sessions",
    );

    // NO auto-retry: archiveSession is still called exactly once (the operator
    // must click Confirm again). This is the crux of the fence.
    expect(archiveSessionMock).toHaveBeenCalledTimes(1);
    // Only the two fetchDescendants calls (initial preview + drift re-preview).
    expect(fetchDescendantsMock).toHaveBeenCalledTimes(2);
  });

  // NOTE: non-drift error propagation (a generic Error is NOT swallowed and does
  // NOT trigger a re-preview) is pinned at the unit level in archiveDrift.test.ts
  // ("does NOT throw ArchiveDriftError on a non-409 failure") + the instanceof
  // check in doArchive's catch. The doArchive onClick is fire-and-forget, so a
  // re-thrown non-drift error surfaces as an unhandled rejection — the same
  // shape the pre-C5 doArchive had — which makes a component-level test noisy
  // without adding coverage the unit test doesn't already provide.
});
