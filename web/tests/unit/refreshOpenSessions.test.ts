// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { refreshOpenSessions } from "../../src/sync/stream";
import { state, setState, setSelectedIdRaw } from "../../src/sync/store";

// Locks in the reconnect-time message refresh being CONCURRENT (opportunity #1
// variant a of session-load-residual-speedups): an operator with N open
// sessions must refresh all N in one parallel batch on a tree reconnect instead
// of N serial /vh/snapshot round-trips. The active session is skipped (owned by
// the live session stream) and a per-session fetch failure must NOT starve the
// others (the original serial loop's try/catch isolation is preserved).
//
// The concurrency assertion uses a latch: every mocked fetch parks on a shared
// Promise that we only release AFTER asserting how many fetches have STARTED.
// Serial `await`-in-a-loop code would start exactly ONE fetch before the first
// resolved (so `started` would hold 1); the parallel form starts all N before
// any resolves. The store singleton + jsdom env follow applySnapshot.test.ts.

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

describe("refreshOpenSessions — parallel reconnect refresh", () => {
  it("fans out all N open sessions concurrently (not N serial round-trips)", async () => {
    setState("messages", "a", { order: [], byId: {} });
    setState("messages", "b", { order: [], byId: {} });
    setState("messages", "c", { order: [], byId: {} });

    // Latch: every fetch promise parks here and resolves only when release()
    // fires. This proves all N were dispatched before ANY resolved.
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    const started: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const id = sessionOf(url);
        started.push(id);
        return block.then(() => ({ ok: true, json: () => ({ messages: { [id]: [] } }) }));
      }),
    );

    const done = refreshOpenSessions();
    // Drain the microtask queue so every mapped callback has run its synchronous
    // prefix (the fetch() call) and parked on `block`.
    await Promise.resolve();
    // CONCURRENCY: all three fetches are in-flight BEFORE any has resolved.
    // Serial await-in-a-loop would show exactly ONE id here.
    expect(started.slice().sort()).toEqual(["a", "b", "c"]);

    release();
    await done;
    // Every non-active session got refreshed (delivery flag flipped).
    expect(state.messagesLoaded.a).toBe(true);
    expect(state.messagesLoaded.b).toBe(true);
    expect(state.messagesLoaded.c).toBe(true);
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
