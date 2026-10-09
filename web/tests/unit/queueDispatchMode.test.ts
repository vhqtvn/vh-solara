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
  noteQueueCustodyRefusal,
  projectionActive,
  queueCustodyRefused,
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
});
