// @vitest-environment jsdom
//
// Unit tests for the global busy scope (web/src/busy.ts). This module
// coordinates archive/unarchive operations with the stream reconciliation
// layer: while any operation holds the scope, the stream gate suppresses
// reactive store mutation, and on the outermost release a coalesced
// authoritative refresh runs. The overlay (globalBusy()) MUST stay true
// through reconciliation — not just while the HTTP request is pending.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  globalBusy,
  withGlobalBusy,
  isGateActive,
  currentGateEpoch,
  markBusyDirty,
  setReconcileFn,
} from "../../src/busy";

// Reset the reconcile fn before each test so a prior stream.ts registration
// (if module isolation leaks) doesn't trigger real network calls.
beforeEach(() => {
  setReconcileFn(async () => {});
});

describe("busy scope — acquisition and release", () => {
  it("first acquisition shows overlay", async () => {
    expect(globalBusy()).toBe(false);
    expect(isGateActive()).toBe(false);

    let busyDuringOp = false;
    await withGlobalBusy(async () => {
      busyDuringOp = globalBusy();
      expect(isGateActive()).toBe(true);
    });

    expect(busyDuringOp).toBe(true);
    expect(globalBusy()).toBe(false);
    expect(isGateActive()).toBe(false);
  });

  it("nested acquisitions keep overlay visible", async () => {
    await withGlobalBusy(async () => {
      expect(globalBusy()).toBe(true);
      await withGlobalBusy(async () => {
        expect(globalBusy()).toBe(true);
        expect(isGateActive()).toBe(true);
      });
      // Inner released, outer still active — overlay stays.
      expect(globalBusy()).toBe(true);
      expect(isGateActive()).toBe(true);
    });
    expect(globalBusy()).toBe(false);
  });

  it("only final release triggers reconciliation", async () => {
    let reconcileCalls = 0;
    setReconcileFn(async () => {
      reconcileCalls++;
    });

    await withGlobalBusy(async () => {
      expect(reconcileCalls).toBe(0);
      await withGlobalBusy(async () => {
        expect(reconcileCalls).toBe(0);
      });
      // Inner released — no reconcile yet (outer still active).
      expect(reconcileCalls).toBe(0);
    });
    // Outer released — exactly ONE reconcile.
    expect(reconcileCalls).toBe(1);
  });

  it("errors release via finally", async () => {
    let reconcileCalls = 0;
    setReconcileFn(async () => {
      reconcileCalls++;
    });

    await expect(
      withGlobalBusy(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The overlay must clear even after an error.
    expect(globalBusy()).toBe(false);
    expect(isGateActive()).toBe(false);
    // Reconciliation still ran (try/finally).
    expect(reconcileCalls).toBe(1);
  });

  it("overlay stays visible until reconciliation completes", async () => {
    let resolveReconcile!: () => void;
    setReconcileFn(() => new Promise<void>((r) => { resolveReconcile = r; }));

    let opDone = false;
    const op = withGlobalBusy(async () => {
      opDone = true;
    });

    // Wait for the operation to complete and reconciliation to start
    // (but not finish, since resolveReconcile hasn't been called).
    await vi.waitFor(() => expect(opDone).toBe(true));
    // Operation done but reconciliation pending → overlay still visible.
    expect(globalBusy()).toBe(true);
    expect(isGateActive()).toBe(true);

    resolveReconcile();
    await op;
    expect(globalBusy()).toBe(false);
  });

  it("new operation during reconciliation: dirty pass handles it", async () => {
    let resolveFirst!: () => void;
    let callCount = 0;
    setReconcileFn(() => {
      callCount++;
      if (callCount === 1) return new Promise<void>((r) => { resolveFirst = r; });
      return Promise.resolve(); // subsequent passes resolve immediately
    });

    const op1 = withGlobalBusy(async () => {});
    await vi.waitFor(() => expect(isGateActive()).toBe(true));

    // While reconciliation is pending, a new operation acquires + completes.
    const op2 = withGlobalBusy(async () => {
      expect(globalBusy()).toBe(true);
    });
    // op2 resolves immediately (non-reentrant guard: reconciling=true → dirty, return)
    await op2;
    // Overlay still visible (op1's reconciliation is still in progress)
    expect(globalBusy()).toBe(true);

    // Resolve the first reconcile — dirty pass runs and clears the overlay
    resolveFirst();
    await op1;
    expect(globalBusy()).toBe(false);
    expect(callCount).toBe(2); // initial pass + dirty pass
  });
});

describe("busy scope — epoch guards", () => {
  it("currentGateEpoch increments on first acquire", async () => {
    const before = currentGateEpoch();
    let epochDuringOp = 0;
    await withGlobalBusy(async () => {
      epochDuringOp = currentGateEpoch();
    });
    expect(epochDuringOp).toBeGreaterThan(before);
  });

  it("currentGateEpoch increments on reconcile pass", async () => {
    let epochAfterAcquire = 0;
    let epochDuringReconcile = 0;
    setReconcileFn(async () => {
      epochDuringReconcile = currentGateEpoch();
    });

    await withGlobalBusy(async () => {
      epochAfterAcquire = currentGateEpoch();
    });

    // Reconcile epoch should be higher than acquire epoch (incremented per pass).
    expect(epochDuringReconcile).toBeGreaterThan(epochAfterAcquire);
  });

  it("stale epoch can't hide the overlay", async () => {
    // Simulate an async decode that captured an old epoch. After the gate
    // activates (epoch bumps), the stale epoch mismatches and the decode
    // is discarded — but the overlay is still managed by the busy scope,
    // not by the stale decode.
    const staleEpoch = currentGateEpoch();
    await withGlobalBusy(async () => {
      // The gate activated — epoch is now higher than staleEpoch.
      expect(currentGateEpoch()).toBeGreaterThan(staleEpoch);
      // A stale-epoch check would fail here:
      expect(staleEpoch === currentGateEpoch()).toBe(false);
    });
    // Overlay cleared normally after reconciliation.
    expect(globalBusy()).toBe(false);
  });
});

describe("busy scope — dirty-pass coalescing", () => {
  it("markBusyDirty only latches during reconciliation", async () => {
    let reconcilePasses = 0;
    let dirtyDuringReconcile = false;
    setReconcileFn(async () => {
      reconcilePasses++;
      if (reconcilePasses === 1) {
        // Simulate a deferred frame arriving during reconciliation.
        markBusyDirty();
        dirtyDuringReconcile = true;
      }
    });

    await withGlobalBusy(async () => {
      // markBusyDirty during the PAUSE phase (not reconciling) should be a no-op.
      markBusyDirty();
    });

    // dirty was latched during reconcile pass 1 → pass 2 should have run.
    expect(reconcilePasses).toBe(2);
    expect(dirtyDuringReconcile).toBe(true);
    expect(globalBusy()).toBe(false);
  });

  it("at most one extra dirty pass (max 2 total)", async () => {
    let reconcilePasses = 0;
    setReconcileFn(async () => {
      reconcilePasses++;
      // Always mark dirty — would loop forever without the max-2 cap.
      markBusyDirty();
    });

    await withGlobalBusy(async () => {});

    // Exactly 2 passes (initial + one dirty pass), not more.
    expect(reconcilePasses).toBe(2);
    expect(globalBusy()).toBe(false);
  });

  it("no dirty → single pass", async () => {
    let reconcilePasses = 0;
    setReconcileFn(async () => {
      reconcilePasses++;
      // Don't mark dirty.
    });

    await withGlobalBusy(async () => {});

    expect(reconcilePasses).toBe(1);
  });
});

describe("busy scope — no selected session → tree refresh only", () => {
  it("reconcile fn is called once on outermost release", async () => {
    let calls = 0;
    setReconcileFn(async () => {
      calls++;
    });

    await withGlobalBusy(async () => {
      await withGlobalBusy(async () => {});
      await withGlobalBusy(async () => {});
    });

    // Three nested acquisitions, but only ONE reconcile on the final release.
    expect(calls).toBe(1);
  });
});
