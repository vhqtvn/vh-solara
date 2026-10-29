// Send-net-resilience slice 3 — the dispatch-ownership mode module
// (/vh/version feature-detect + the custody-refusal latch).
//
// Pins: refreshDispatchMode parses daemonDispatchCapable; a failed fetch
// keeps the previous value (fail-safe legacy); noteQueueCustodyRefusal
// latches projectionActive even when the advertisement says false (the 409
// is ownership information, not an error).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetQueueDispatchModeForTests,
  daemonDispatchCapable,
  dispatchMode,
  noteQueueCustodyRefusal,
  projectionActive,
  queueCustodyRefused,
  queuePolicyCapable,
  refreshDispatchMode,
} from "../../src/lib/queueDispatchMode";

function stubVersion(body: unknown, ok = true) {
  (globalThis as any).fetch = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  }));
}

beforeEach(() => {
  __resetQueueDispatchModeForTests();
});

afterEach(() => {
  __resetQueueDispatchModeForTests();
  vi.unstubAllGlobals();
  (globalThis as any).fetch = undefined;
});

describe("dispatch mode (projection feature-detect)", () => {
  it("parses daemonDispatchCapable from /vh/version", async () => {
    stubVersion({ version: "1.2.3", daemonDispatchCapable: true });
    await refreshDispatchMode();
    expect(daemonDispatchCapable()).toBe(true);
    expect(projectionActive()).toBe(true);
  });

  it("absent field keeps the legacy default (false)", async () => {
    stubVersion({ version: "0.0.1" });
    await refreshDispatchMode();
    expect(daemonDispatchCapable()).toBe(false);
    expect(projectionActive()).toBe(false);
  });

  it("a failed fetch keeps the previous value and never throws (fail-safe legacy)", async () => {
    stubVersion({ daemonDispatchCapable: true });
    await refreshDispatchMode();
    expect(daemonDispatchCapable()).toBe(true);
    stubVersion(null, false);
    await expect(refreshDispatchMode()).resolves.toBeUndefined();
    expect(daemonDispatchCapable()).toBe(true); // unchanged
  });

  it("a custody refusal (409 queue_custody_active) latches projection even when the advertisement is false", () => {
    expect(projectionActive()).toBe(false);
    noteQueueCustodyRefusal();
    expect(queueCustodyRefused()).toBe(true);
    expect(projectionActive()).toBe(true); // the refusal IS ownership information
    expect(daemonDispatchCapable()).toBe(false); // the advertisement itself stays honest
  });

  // -----------------------------------------------------------------------
  // The dispatch-ownership tri-state (b-F1, commit-review 2026-10-27):
  // `capable() === false` is NOT legacy evidence — a daemon-dispatch server
  // whose every /vh/version probe fails also reads false. dispatchMode()
  // must distinguish a SUCCESSFULLY OBSERVED legacy response
  // ("legacy-confirmed" — including the capability-ABSENT 200, a genuine
  // legacy daemon) from an unavailable/invalid observation ("unknown").
  // The retry guard consumes this: "unknown" is not permission to POST.
  // -----------------------------------------------------------------------
  describe("dispatchMode() tri-state (b-F1: unestablished ≠ legacy)", () => {
    it("reads \"unknown\" before any probe completes (boot race) — not legacy evidence", () => {
      expect(dispatchMode()).toBe("unknown");
    });

    it("a 200 WITHOUT daemonDispatchCapable is a genuine legacy observation → \"legacy-confirmed\"", async () => {
      stubVersion({ version: "0.0.1" }); // capability-absent shape
      await refreshDispatchMode();
      expect(dispatchMode()).toBe("legacy-confirmed");
      expect(daemonDispatchCapable()).toBe(false);
      expect(projectionActive()).toBe(false);
    });

    it("a 200 advertising daemonDispatchCapable:false → \"legacy-confirmed\"", async () => {
      stubVersion({ daemonDispatchCapable: false });
      await refreshDispatchMode();
      expect(dispatchMode()).toBe("legacy-confirmed");
    });

    it("a 200 advertising daemonDispatchCapable:true → \"modern\"", async () => {
      stubVersion({ daemonDispatchCapable: true });
      await refreshDispatchMode();
      expect(dispatchMode()).toBe("modern");
      expect(projectionActive()).toBe(true);
    });

    it("a non-OK /vh/version downgrades the observation → \"unknown\" (even after an earlier success)", async () => {
      stubVersion({ daemonDispatchCapable: false });
      await refreshDispatchMode();
      expect(dispatchMode()).toBe("legacy-confirmed");
      stubVersion(null, false); // 503 — the click-time probe cannot establish the mode
      await refreshDispatchMode();
      expect(dispatchMode()).toBe("unknown"); // stale legacy evidence must not survive a failed probe
    });

    it("a malformed JSON body → \"unknown\" (invalid observation)", async () => {
      (globalThis as any).fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }));
      await refreshDispatchMode();
      expect(dispatchMode()).toBe("unknown");
    });

    it("a failed probe RETAINS a previously advertised capability → stays \"modern\" (fail-safe projection)", async () => {
      stubVersion({ daemonDispatchCapable: true });
      await refreshDispatchMode();
      stubVersion(null, false);
      await refreshDispatchMode();
      expect(daemonDispatchCapable()).toBe(true); // capability keeps its value
      expect(dispatchMode()).toBe("modern"); // "modern" dominates the per-attempt flag
    });

    it("a network error (fetch rejects) → \"unknown\"", async () => {
      (globalThis as any).fetch = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      });
      await refreshDispatchMode();
      expect(dispatchMode()).toBe("unknown");
    });

    it("a latched custody refusal → \"modern\" regardless of the advertisement", async () => {
      stubVersion({ daemonDispatchCapable: false });
      await refreshDispatchMode(); // legacy-confirmed…
      noteQueueCustodyRefusal(); // …but a live custody owner was observed
      expect(dispatchMode()).toBe("modern"); // the refusal IS ownership information
    });

    it("recovery: a successful probe after a failed one re-establishes → back to \"legacy-confirmed\"", async () => {
      stubVersion(null, false);
      await refreshDispatchMode();
      expect(dispatchMode()).toBe("unknown");
      stubVersion({ daemonDispatchCapable: false });
      await refreshDispatchMode();
      expect(dispatchMode()).toBe("legacy-confirmed");
    });
  });

  // -----------------------------------------------------------------------
  // Queue-policy B2 (2026-10-29 amendment §4): queuePolicyCapable() reads
  // /vh/version's queueDispatchPolicyVersion — advertised ONLY while the
  // policy scheduler is ACTIVE (the same enablement as daemon dispatch).
  // Gates the Send-now/Queue composer button table + the pending-chip
  // escalation. Absent/malformed → NOT capable; a failed probe keeps the
  // previous value (fail-safe, mirroring daemonDispatchCapable).
  // -----------------------------------------------------------------------
  describe("queuePolicyCapable (queueDispatchPolicyVersion feature-detect)", () => {
    it("parses a numeric queueDispatchPolicyVersion >= 1 as capable", async () => {
      stubVersion({ version: "1.2.3", daemonDispatchCapable: true, queueDispatchPolicyVersion: 1 });
      await refreshDispatchMode();
      expect(queuePolicyCapable()).toBe(true);
    });

    it("absent / zero / negative / wrong-typed key reads NOT capable", async () => {
      stubVersion({ version: "1.2.3", daemonDispatchCapable: true });
      await refreshDispatchMode();
      expect(queuePolicyCapable()).toBe(false);
      stubVersion({ daemonDispatchCapable: true, queueDispatchPolicyVersion: 0 });
      await refreshDispatchMode();
      expect(queuePolicyCapable()).toBe(false);
      stubVersion({ daemonDispatchCapable: true, queueDispatchPolicyVersion: "1" });
      await refreshDispatchMode();
      expect(queuePolicyCapable()).toBe(false);
    });

    it("a failed probe keeps the previous value (fail-safe: the buttons stay as rendered)", async () => {
      stubVersion({ daemonDispatchCapable: true, queueDispatchPolicyVersion: 1 });
      await refreshDispatchMode();
      expect(queuePolicyCapable()).toBe(true);
      stubVersion(null, false);
      await refreshDispatchMode();
      expect(queuePolicyCapable()).toBe(true); // unchanged — same posture as capable
      // …and a later parseable body without the key reads NOT capable again.
      stubVersion({ daemonDispatchCapable: true });
      await refreshDispatchMode();
      expect(queuePolicyCapable()).toBe(false);
    });

    it("does NOT touch the S1 tri-state (dispatchMode stays intact)", async () => {
      stubVersion({ daemonDispatchCapable: true, queueDispatchPolicyVersion: 1 });
      await refreshDispatchMode();
      expect(queuePolicyCapable()).toBe(true);
      expect(dispatchMode()).toBe("modern"); // policy implies daemon dispatch, but the switches stay independent
      stubVersion({ daemonDispatchCapable: true });
      await refreshDispatchMode();
      expect(queuePolicyCapable()).toBe(false);
      expect(dispatchMode()).toBe("modern"); // capability alone still modern
    });
  });
});
