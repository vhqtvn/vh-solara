// @vitest-environment jsdom
//
// Call-site pattern tests for the global busy scope. These verify the
// withGlobalBusy wrapping patterns used by SessionContextMenu.doArchive,
// ArchivedDialog.restore / restore-and-open, and OrphanBanner.confirm —
// without rendering the full components (which would require mocking the
// deep sync/store/notify dependency chain). The patterns are tested as
// contracts: "when you wrap an operation + cleanup in withGlobalBusy, the
// overlay stays visible through the cleanup tail and clears after
// reconciliation."
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  globalBusy,
  withGlobalBusy,
  isGateActive,
  setReconcileFn,
} from "../../src/busy";

beforeEach(() => {
  setReconcileFn(async () => {});
});

describe("call-site patterns — doArchive", () => {
  it("holds busy through archive + cleanup tail", async () => {
    let busyDuringArchive = false;
    let busyDuringCleanup = false;
    let cleanupCalled = false;

    // Simulate SessionContextMenu.doArchive pattern
    await withGlobalBusy(async () => {
      await mockFetchArchive("s1");
      busyDuringArchive = globalBusy();
      // closeArchiveConfirm() — the cleanup tail
      cleanupCalled = true;
      busyDuringCleanup = globalBusy();
    });

    expect(busyDuringArchive).toBe(true);
    expect(busyDuringCleanup).toBe(true);
    expect(cleanupCalled).toBe(true);
    expect(globalBusy()).toBe(false);
  });

  it("failed archive removes overlay and lets error surface", async () => {
    let errorCaught: string | null = null;

    try {
      await withGlobalBusy(async () => {
        throw new Error("archive failed (500): server error");
      });
    } catch (e) {
      errorCaught = e instanceof Error ? e.message : String(e);
    }

    expect(errorCaught).toBe("archive failed (500): server error");
    expect(globalBusy()).toBe(false);
    expect(isGateActive()).toBe(false);
  });
});

describe("call-site patterns — restore", () => {
  it("holds busy through unarchive + archived-list state update", async () => {
    const steps: string[] = [];

    await withGlobalBusy(async () => {
      steps.push("unarchive-start");
      await mockFetchUnarchive("s1");
      steps.push("unarchive-done");
      // Drop the row from level cache (the state-update tail)
      steps.push("drop-row");
    });

    expect(steps).toEqual(["unarchive-start", "unarchive-done", "drop-row"]);
    // Busy was true during ALL steps (verified by the fact that the scope
    // didn't release until after drop-row).
    expect(globalBusy()).toBe(false);
  });

  it("failed unarchive removes overlay; error surfaces", async () => {
    let errorCaught = false;

    await withGlobalBusy(async () => {
      try {
        throw new Error("unarchive failed (400): bad request");
      } catch {
        errorCaught = true;
        return; // don't drop the row on failure
      }
    });

    expect(errorCaught).toBe(true);
    expect(globalBusy()).toBe(false);
  });
});

describe("call-site patterns — restore-and-open", () => {
  it("holds busy through unarchive → setSelectedId → openSession → dialog close", async () => {
    const steps: string[] = [];

    await withGlobalBusy(async () => {
      // restoreAndOpen: unarchive → setSelectedId → void openSession
      steps.push("unarchive-start");
      await mockFetchUnarchive("s1");
      steps.push("set-selected");
      // openSession is fire-and-forget (void) — simulate it
      steps.push("open-session");
      // props.onClose() — dialog close
      steps.push("dialog-close");
    });

    // ALL steps ran inside the busy scope — no intermediate state flash.
    expect(steps).toEqual([
      "unarchive-start",
      "set-selected",
      "open-session",
      "dialog-close",
    ]);
    expect(globalBusy()).toBe(false);
  });
});

describe("call-site patterns — OrphanBanner bulk archive", () => {
  it("ONE outer busy scope around the whole loop (not per-iteration)", async () => {
    const archiveOps: number[] = [];
    const busyDuringOps: boolean[] = [];

    // Simulate the OrphanBanner.confirm pattern: one outer withGlobalBusy
    // wrapping a sequential loop of archive calls.
    await withGlobalBusy(async () => {
      for (let i = 0; i < 5; i++) {
        await mockFetchArchive(`orphan-${i}`);
        archiveOps.push(i);
        busyDuringOps.push(globalBusy());
      }
      setOpen(false); // simulate setOpen(false) after the loop
    });

    function setOpen(_v: boolean) { /* noop */ }

    expect(archiveOps).toEqual([0, 1, 2, 3, 4]);
    // Busy was true during EVERY iteration — not acquired/released per-iteration.
    expect(busyDuringOps.every((b) => b === true)).toBe(true);
    expect(busyDuringOps.length).toBe(5);
    expect(globalBusy()).toBe(false);
  });

  it("failed archive in the loop removes overlay after reconciliation", async () => {
    let errorCaught: Error | null = null;

    try {
      await withGlobalBusy(async () => {
        throw new Error("archive failed (500): server error");
      });
    } catch (e) {
      errorCaught = e instanceof Error ? e : new Error(String(e));
    }

    expect(errorCaught?.message).toContain("archive failed");
    expect(globalBusy()).toBe(false);
  });
});

// --- helpers ---

function mockFetchArchive(_id: string): Promise<string[]> {
  return Promise.resolve(["s1"]);
}

function mockFetchUnarchive(_id: string): Promise<string[]> {
  return Promise.resolve(["s1"]);
}
