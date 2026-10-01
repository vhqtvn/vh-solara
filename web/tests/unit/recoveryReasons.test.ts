// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import {
  classifyStall,
  countRecovery,
  countSnapshotBytes,
  readSyncDiag,
  installSyncDiagGlobal,
  _resetRecoveryCountersForTest,
  RECOVERY_REASONS,
} from "../../src/sync/recovery-reasons";

// Slice 1 (webperf build1): the reason-code classification + counter surface
// that makes every forced reconnect/snapshot countable from the browser
// console (`window.__vhSyncDiag()`). These tests pin:
//   1. classifyStall — the pure dual-clock → stable-reason mapping (must
//      agree with health.ts's log.reason derivation).
//   2. the counter surface — counts, lastTs, cumulative snapshot bytes,
//      reset-for-test, and the window.__vhSyncDiag install.

describe("classifyStall (pure dual-clock classification)", () => {
  it("returns null when neither clock tripped (no recovery to count)", () => {
    expect(classifyStall("tree", false, false)).toBeNull();
    expect(classifyStall("session", false, false)).toBeNull();
  });

  it("content-only stall maps to the idle-churn reasons (the named culprits)", () => {
    // pings flowing, zero content — the idle-pane ~130s watchdog driver.
    expect(classifyStall("session", true, false)).toBe("idle-content-stale");
    expect(classifyStall("tree", true, false)).toBe("tree-idle-stale");
  });

  it("transport stall (alone or with content) maps to the transport reasons", () => {
    expect(classifyStall("session", false, true)).toBe("session-transport-stale");
    expect(classifyStall("tree", false, true)).toBe("tree-transport-stale");
    // BOTH trip → transport dominates (a socket whose pings stopped is the
    // stronger claim; content age is then a consequence).
    expect(classifyStall("session", true, true)).toBe("session-transport-stale");
    expect(classifyStall("tree", true, true)).toBe("tree-transport-stale");
  });

  it("only ever returns closed-vocabulary codes", () => {
    const all = [
      classifyStall("tree", true, false),
      classifyStall("tree", false, true),
      classifyStall("tree", true, true),
      classifyStall("session", true, false),
      classifyStall("session", false, true),
      classifyStall("session", true, true),
    ];
    for (const r of all) expect(RECOVERY_REASONS).toContain(r);
  });
});

describe("recovery counters (window.__vhSyncDiag surface)", () => {
  beforeEach(() => _resetRecoveryCountersForTest());

  it("counts per-reason occurrences with last timestamps", () => {
    countRecovery("idle-content-stale");
    countRecovery("idle-content-stale");
    countRecovery("visibility-pause");
    const d = readSyncDiag();
    expect(d.recovery["idle-content-stale"]?.count).toBe(2);
    expect(d.recovery["visibility-pause"]?.count).toBe(1);
    expect(d.recovery["visibility-resume"]).toBeUndefined(); // never fired
    expect(d.recovery["idle-content-stale"]?.lastTs).toBeGreaterThan(0);
  });

  it("accumulates cumulative snapshot bytes per stream and ignores junk", () => {
    countSnapshotBytes("tree", 100_000);
    countSnapshotBytes("tree", 136_000);
    countSnapshotBytes("session", 236_000);
    countSnapshotBytes("session", 0); // no-op
    countSnapshotBytes("tree", -5); // defensive: negatives ignored
    const d = readSyncDiag();
    expect(d.snapshotBytes.tree).toBe(236_000);
    expect(d.snapshotBytes.session).toBe(236_000);
  });

  it("readSyncDiag returns an isolated copy (later counts do not mutate it)", () => {
    countRecovery("seq-gap");
    const before = readSyncDiag();
    countRecovery("seq-gap");
    expect(before.recovery["seq-gap"]?.count).toBe(1);
    expect(readSyncDiag().recovery["seq-gap"]?.count).toBe(2);
  });

  it("installSyncDiagGlobal exposes the getter on window, idempotently", () => {
    countRecovery("busy-reconcile");
    installSyncDiagGlobal();
    installSyncDiagGlobal(); // second call must not clobber
    const w = window as unknown as { __vhSyncDiag: () => ReturnType<typeof readSyncDiag> };
    expect(typeof w.__vhSyncDiag).toBe("function");
    expect(w.__vhSyncDiag().recovery["busy-reconcile"]?.count).toBe(1);
    delete (window as unknown as { __vhSyncDiag?: unknown }).__vhSyncDiag;
  });

  it("_resetRecoveryCountersForTest clears counts and bytes", () => {
    countRecovery("offset-mismatch");
    countSnapshotBytes("session", 42);
    _resetRecoveryCountersForTest();
    const d = readSyncDiag();
    expect(d.recovery).toEqual({});
    expect(d.snapshotBytes).toEqual({ tree: 0, session: 0 });
  });
});
