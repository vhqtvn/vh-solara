// @vitest-environment jsdom
//
// Single-flight guard tests for web/src/lib/sendSingleFlight.ts.
//
// This is the regression guard for the duplicate-send-on-slow-network bug: on
// a weak/hung network the enqueue POST can take up to 12s (ENQUEUE_TIMEOUT_MS,
// queue.ts). During that window the composer text is deliberately NOT cleared
// (no-loss invariant) and no queue chip appears yet, so the operator sees no
// feedback and re-taps Send — each re-tap spawning a PARALLEL enqueue that
// lands as a duplicate once the network settles. The guard drops re-taps while
// one enqueue is in-flight for a session and releases on BOTH success and
// failure (try/finally) so a genuine retry still works after a timeout.
//
// The guard was extracted from ChatView.tsx into lib/sendSingleFlight.ts
// precisely so this behavior can be exercised without mounting the ~15-module
// component (same precedent as QueueChip.tsx / queueDrain.ts).
//
// Assertions required by the slice:
//   (1) a re-tap (concurrent call) while one send is in-flight does NOT invoke
//       the send callback a second time — it returns IGNORED.
//   (2) the guard releases on success (a later send for the same key runs).
//   (3) the guard releases on failure (a retry works after a rejection).
//   (4) the guard is per-key (a different session's send is NOT blocked).
//   (5) isSendInFlight reflects the in-flight state (true during, false after).
import { beforeEach, describe, expect, it } from "vitest";
import {
  IGNORED,
  __resetSendSingleFlightForTests,
  isSendInFlight,
  runSendSingleFlight,
} from "../../src/lib/sendSingleFlight";

beforeEach(() => {
  __resetSendSingleFlightForTests();
});

describe("runSendSingleFlight — re-tap during in-flight is dropped (no 2nd enqueue)", () => {
  it("does not invoke the callback a second time while one is in-flight; returns IGNORED", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const slow = (): Promise<string> =>
      new Promise((resolve) => {
        calls++;
        release = () => resolve("ok");
      });

    // First tap engages the guard and holds it open (mirrors the 12s enqueue).
    const first = runSendSingleFlight("s1", slow);
    expect(calls).toBe(1);
    expect(isSendInFlight("s1")).toBe(true);

    // Re-tap while in-flight: the callback MUST NOT run again (no 2nd enqueue).
    const second = runSendSingleFlight("s1", slow);
    expect(calls).toBe(1);
    expect(await second).toBe(IGNORED);
    expect(isSendInFlight("s1")).toBe(true); // still in-flight until first resolves

    release();
    expect(await first).toBe("ok");
    expect(isSendInFlight("s1")).toBe(false);
  });

  it("marks the key in-flight BEFORE awaiting the callback (immediate UI feedback)", async () => {
    // The engagement must be synchronous so a Send button bound to
    // isSendInFlight disables on the same tap, before backend custody confirms.
    let observedDuringCall = false;
    const res = runSendSingleFlight("s-immediate", async () => {
      observedDuringCall = isSendInFlight("s-immediate");
      return "done";
    });
    // Already engaged by the time the callback body runs (synchronous set).
    await res;
    expect(observedDuringCall).toBe(true);
  });
});

describe("runSendSingleFlight — guard releases on success AND failure", () => {
  it("releases on success so a later send for the same key runs", async () => {
    let calls = 0;
    await runSendSingleFlight("s2", async () => {
      calls++;
      return "done";
    });
    expect(calls).toBe(1);
    expect(isSendInFlight("s2")).toBe(false);
    // Second send after the first completed — runs normally (retry works).
    await runSendSingleFlight("s2", async () => {
      calls++;
      return "done";
    });
    expect(calls).toBe(2);
  });

  it("releases on failure (rejection) so a genuine retry works after a 12s-style timeout", async () => {
    let calls = 0;
    await expect(
      runSendSingleFlight("s3", async () => {
        calls++;
        throw new Error("enqueue timed out");
      }),
    ).rejects.toThrow("enqueue timed out");
    expect(calls).toBe(1);
    // Guard released despite the throw (finally ran) → a retry runs.
    expect(isSendInFlight("s3")).toBe(false);
    await runSendSingleFlight("s3", async () => {
      calls++;
      return "recovered";
    });
    expect(calls).toBe(2);
  });
});

describe("runSendSingleFlight — per-key (per-session) guard", () => {
  it("does NOT block a different session's send while one is in-flight", async () => {
    let releaseA: () => void = () => {};
    const slowA = (): Promise<void> =>
      new Promise((resolve) => {
        releaseA = () => resolve();
      });
    const first = runSendSingleFlight("session-A", slowA);
    expect(isSendInFlight("session-A")).toBe(true);
    expect(isSendInFlight("session-B")).toBe(false);

    // A send for a DIFFERENT session runs immediately (per-session guard, not
    // global — a send that hangs on one session must never block another).
    let bRan = false;
    const bRes = await runSendSingleFlight("session-B", async () => {
      bRan = true;
    });
    expect(bRes).not.toBe(IGNORED);
    expect(bRan).toBe(true);

    releaseA();
    await first;
    expect(isSendInFlight("session-A")).toBe(false);
  });
});
