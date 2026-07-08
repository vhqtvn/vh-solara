// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { refreshOpenSessions, runWithConcurrency, REFRESH_CONCURRENCY } from "../../src/sync/stream";
import { state, setState, setSelectedIdRaw } from "../../src/sync/store";

// Locks in the reconnect-time message refresh being BOUNDED-concurrent: an
// operator with N open sessions must refresh their cached transcripts on a tree
// reconnect, but the refreshes fan out through a single yamux-over-WebSocket
// tunnel, so firing all N full-transcript /vh/snapshot pulls at once saturates
// the transport (the measured root cause of ~5s warm-open latency at large N —
// server compute is sub-20ms). The fan-out is capped at REFRESH_CONCURRENCY so
// not all N big payloads are in flight at once. The active session is skipped
// (owned by the live session stream) and a per-session fetch failure must NOT
// starve the others (the per-session try/catch isolation is preserved).
//
// The bounded-concurrency assertion uses per-fetch gates: every mocked fetch
// parks on its own Promise and we observe the high-water mark of concurrent
// in-flight fetches BEFORE releasing any gate. An unbounded Promise.all would
// park all N (peak=N); a serial loop would park exactly 1 (peak=1); the bounded
// runner parks at most the cap. The store singleton + jsdom env follow
// applySnapshot.test.ts.

beforeEach(() => {
  // Reset the slices these tests touch (Solid's setState MERGES objects, so a
  // plain setState("x", {}) would leave stale nested keys; reconcile({}) diffs
  // each slice down to empty — selectors.test.ts / applySnapshot.test.ts pattern).
  setState("messages", reconcile({}));
  setState("messagesLoaded", reconcile({}));
  setSelectedIdRaw(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Parse the mocked fetch's URL and pull the `sessions` query param (the per-id
// refresh request shape: /vh/snapshot?sessions=<id>&dir=<dir>).
function sessionOf(url: string): string {
  return new URL(url, "http://x").searchParams.get("sessions") || "";
}

describe("refreshOpenSessions — bounded-concurrent reconnect refresh", () => {
  it("caps concurrent refresh fetches at REFRESH_CONCURRENCY (bounded fan-out)", async () => {
    // More open sessions than the cap so the bound is exercised. None is
    // active (selectedId is null per beforeEach) so every id pulls.
    const ids = ["a", "b", "c", "d", "e", "f"]; // N=6, cap=REFRESH_CONCURRENCY=3
    for (const id of ids) setState("messages", id, { order: [], byId: {} });

    // SHARED latch: every fetch parks on `block`; inFlight counts started-but-
    // unresolved fetches and peak tracks the high-water mark. Resolving `block`
    // once drains ALL fetches — including items the bounded runner schedules
    // AFTER release (they await the already-resolved promise) — so the queued
    // half can't deadlock the test. (A per-fetch gate array would: the release
    // loop runs synchronously over the first `cap` gates and never sees the
    // gates the queued items push on their way through.)
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const id = sessionOf(url);
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        return block.then(() => {
          inFlight--;
          return { ok: true, json: () => ({ messages: { [id]: [] } }) };
        });
      }),
    );

    const done = refreshOpenSessions();
    // Drain one microtask so the cap-many workers have dispatched and parked on
    // their fetches (the workers run synchronously up to `await fetch(...)`).
    await Promise.resolve();

    // BOUNDED: exactly the cap are in flight; the rest are still queued. An
    // unbounded Promise.all would park all N=6 here (peak=6); a serial loop
    // would park exactly 1 (peak=1).
    expect(peak).toBe(REFRESH_CONCURRENCY);
    expect(inFlight).toBe(REFRESH_CONCURRENCY);

    // Release the latch; the queued fetches run (still bounded — peak can't
    // rise above the cap since only `cap` workers exist) and every session
    // refreshes.
    release();
    await done;
    for (const id of ids) expect(state.messagesLoaded[id]).toBe(true);
  });

  it("skips the active session (owned by the live session stream)", async () => {
    setState("messages", "keep", { order: [], byId: {} });
    setState("messages", "skip", { order: [], byId: {} });
    setSelectedIdRaw("skip"); // the live session stream owns this one

    const started: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const id = sessionOf(url);
        started.push(id);
        return Promise.resolve({ ok: true, json: () => ({ messages: { [id]: [] } }) });
      }),
    );

    await refreshOpenSessions();
    expect(started).toEqual(["keep"]); // active session never round-tripped
    expect(state.messagesLoaded.keep).toBe(true);
    // The active session's delivery flag is left untouched by this path.
    expect(state.messagesLoaded.skip).toBeUndefined();
  });

  it("isolates per-session failures (one rejecting fetch does NOT starve the others)", async () => {
    setState("messages", "ok1", { order: [], byId: {} });
    setState("messages", "boom", { order: [], byId: {} });
    setState("messages", "ok2", { order: [], byId: {} });

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const id = sessionOf(url);
        // One session's fetch rejects; the other two resolve normally.
        if (id === "boom") return Promise.reject(new Error("upstream client.Messages died"));
        return Promise.resolve({
          ok: true,
          json: () => ({ messages: { [id]: [{ info: { id: "m1", sessionID: id, role: "user" }, parts: [] }] } }),
        });
      }),
    );

    // Must NOT throw — the inner try/catch swallows the boom failure.
    await expect(refreshOpenSessions()).resolves.toBeUndefined();
    // The two healthy sessions refreshed; the failed one kept stale (still
    // whatever it was before — undefined here — rather than starving ok1/ok2).
    expect(state.messagesLoaded.ok1).toBe(true);
    expect(state.messagesLoaded.ok2).toBe(true);
    expect(state.messagesLoaded.boom).toBeUndefined();
    expect(state.messages.ok1.order).toContain("m1");
    expect(state.messages.ok2.order).toContain("m1");
  });

  it("is a no-op when no sessions are open (messages map empty)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(refreshOpenSessions()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Focused unit tests for the bounded-concurrency runner itself (no store /
// fetch). These pin the scheduler contract that refreshOpenSessions relies on:
// limit bounds in-flight, items run to completion, and a rejection never
// aborts siblings.
describe("runWithConcurrency", () => {
  it("limit=1 processes items serially (next starts only after previous settles)", async () => {
    const log: string[] = [];
    // fn records its start synchronously, then resolves on the next microtask
    // recording its end. A serial scheduler yields start/end/start/end...; a
    // parallel one would interleave starts before any end.
    const fn = (id: string) => {
      log.push(`start:${id}`);
      return Promise.resolve().then(() => log.push(`end:${id}`));
    };
    await runWithConcurrency(["a", "b", "c"], 1, fn);
    expect(log).toEqual([
      "start:a", "end:a",
      "start:b", "end:b",
      "start:c", "end:c",
    ]);
  });

  it("limit >= N runs all items concurrently (fully parallel)", async () => {
    const log: string[] = [];
    const fn = (id: string) => {
      log.push(`start:${id}`);
      return Promise.resolve().then(() => log.push(`end:${id}`));
    };
    await runWithConcurrency(["a", "b", "c"], 10, fn); // limit=10 >= N=3
    // All three start before any ends: concurrent dispatch across N workers.
    expect(log).toEqual([
      "start:a", "start:b", "start:c",
      "end:a", "end:b", "end:c",
    ]);
  });

  it("a per-item rejection does NOT abort siblings and every item is attempted", async () => {
    const attempted: string[] = [];
    // Two items reject mid-stream; the runner must keep going and attempt all.
    const fn = (id: string) => {
      attempted.push(id);
      if (id === "boom" || id === "boom2") return Promise.reject(new Error("nope"));
      return Promise.resolve();
    };
    // The overall promise resolves (the runner swallows per-item rejections —
    // matches refreshOpenSessions' "keep stale" tolerance, never throws).
    await expect(runWithConcurrency(["a", "boom", "b", "boom2", "c"], 2, fn))
      .resolves.toBeUndefined();
    expect(attempted.slice().sort()).toEqual(["a", "b", "boom", "boom2", "c"]);
  });
});
