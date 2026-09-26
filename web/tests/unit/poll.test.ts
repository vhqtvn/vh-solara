// startPoll (web/src/lib/poll.ts): single-flight, latency-adaptive,
// failure-backoff, visibility-paused polling loop. Replaces bare setInterval
// pollers that stacked overlapping requests on a slow tunnel.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startPoll } from "../../src/lib/poll";
import { asHostVisibility, HOST_VISIBILITY_TYPE } from "../../src/paneVisibility";

function visibility(initial = true) {
  let v = initial;
  const ls = new Set<(v: boolean) => void>();
  return {
    isVisible: () => v,
    onVisibilityChange: (l: (v: boolean) => void) => {
      ls.add(l);
      return () => ls.delete(l);
    },
    set(next: boolean) {
      v = next;
      for (const l of [...ls]) l(next);
    },
    listeners: () => ls.size,
  };
}

// A task whose completion the test controls.
function deferredTask() {
  const resolvers: Array<(v: unknown) => void> = [];
  const task = vi.fn(() => new Promise((r) => resolvers.push(r)));
  return { task, settle: (v: unknown = undefined) => resolvers.shift()?.(v), pending: () => resolvers.length };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("startPoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never overlaps: a slow run delays the next instead of stacking", async () => {
    const vis = visibility();
    const d = deferredTask();
    const stop = startPoll(d.task, { intervalMs: 5000, ...vis });
    expect(d.task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); // response still pending
    expect(d.task).toHaveBeenCalledTimes(1);
    expect(d.pending()).toBe(1);
    d.settle();
    await flush();
    // took 30s → next delay is at least the observed latency, not 5s
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(d.task).toHaveBeenCalledTimes(2);
    stop();
  });

  it("runs every interval after fast successes", async () => {
    const vis = visibility();
    const task = vi.fn(async () => undefined);
    const stop = startPoll(task, { intervalMs: 5000, ...vis });
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(3);
    stop();
  });

  it("backs off on failure (throw or false) and resets on success", async () => {
    const vis = visibility();
    let fail = true;
    const task = vi.fn(async () => {
      if (fail) throw new Error("x");
    });
    const stop = startPoll(task, { intervalMs: 1000, maxBackoffMs: 8000, ...vis });
    await flush(); // run 1 fails → next in 2s
    await vi.advanceTimersByTimeAsync(1999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // run 2 fails → 4s
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000); // run 3 fails → 8s (cap)
    expect(task).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000); // run 4 fails → still 8s
    expect(task).toHaveBeenCalledTimes(4);
    fail = false;
    await vi.advanceTimersByTimeAsync(8000); // run 5 succeeds → back to 1s
    expect(task).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(6);

    const falsy = vi.fn(async () => false);
    const stop2 = startPoll(falsy, { intervalMs: 1000, ...vis });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(falsy).toHaveBeenCalledTimes(1); // resolved false → backed off to 2s
    await vi.advanceTimersByTimeAsync(1000);
    expect(falsy).toHaveBeenCalledTimes(2);
    stop();
    stop2();
  });

  it("pauses while hidden and catches up once on becoming visible", async () => {
    const vis = visibility();
    const task = vi.fn(async () => undefined);
    const stop = startPoll(task, { intervalMs: 5000, ...vis });
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
    vis.set(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);
    vis.set(true); // last run is stale → immediate catch-up
    await flush();
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(3);
    stop();
  });

  it("a brief hide does not trigger an early extra run", async () => {
    const vis = visibility();
    const task = vi.fn(async () => undefined);
    const stop = startPoll(task, { intervalMs: 5000, ...vis });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    vis.set(false);
    vis.set(true); // 1s since last run → wait the remaining 4s
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it("starting hidden defers the first run until visible", async () => {
    const vis = visibility(false);
    const task = vi.fn(async () => undefined);
    const stop = startPoll(task, { intervalMs: 5000, ...vis });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(task).not.toHaveBeenCalled();
    vis.set(true);
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stop() halts scheduling, ignores an in-flight result, and unsubscribes", async () => {
    const vis = visibility();
    const d = deferredTask();
    const stop = startPoll(d.task, { intervalMs: 1000, ...vis });
    expect(vis.listeners()).toBe(1);
    stop();
    expect(vis.listeners()).toBe(0);
    d.settle();
    await vi.advanceTimersByTimeAsync(10_000);
    vis.set(false);
    vis.set(true);
    await flush();
    expect(d.task).toHaveBeenCalledTimes(1);
  });
});

describe("asHostVisibility", () => {
  it("accepts only the closed {type, visible:boolean} payload", () => {
    expect(asHostVisibility({ type: HOST_VISIBILITY_TYPE, visible: false })).toBe(false);
    expect(asHostVisibility({ type: HOST_VISIBILITY_TYPE, visible: true })).toBe(true);
    expect(asHostVisibility({ type: HOST_VISIBILITY_TYPE, visible: "no" })).toBeNull();
    expect(asHostVisibility({ type: "vh-host-tail", following: true })).toBeNull();
    expect(asHostVisibility(null)).toBeNull();
    expect(asHostVisibility("vh-host-visibility")).toBeNull();
  });
});
