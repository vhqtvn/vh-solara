// @vitest-environment jsdom
//
// Phase 5: server-backed pin facade. These tests cover the SERVER-mode path of
// pins.ts (the legacy localStorage path is covered by sidebar.test.ts and is
// unchanged). The server path is activated by the first pins.snapshot frame;
// pin/unpin/reorder then go through PUT /vh/pins with one bounded 409 retry for
// membership intents and no auto-replay for reorder.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPinsSnapshot,
  applyPinsUpdated,
  clearPinsError,
  coercePinDoc,
  dropPinnedSession,
  isPinned,
  movePinnedTo,
  movePinnedByOffset,
  pinsInitialized,
  pinsLastError,
  pinsPending,
  pinsRevision,
  pinsServerMode,
  reconciledPinnedOrder,
  togglePin,
  __resetPinnedForTest,
} from "../../src/pins";

// Minimal Response-like object the fetch mock returns. The facade reads
// .status and calls .json(); installCsrf is not installed in tests so the raw
// stub is what the facade's fetch call hits.
function jsonRes(body: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as Response;
}
function pinDoc(revision: number, initialized: boolean, ids: string[]) {
  return { revision, initialized, orderedSessionIds: ids };
}
function readLegacyEnv(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
// Flush pending microtasks (the migration / PUT chains are async even when fetch
// resolves synchronously — they cross several awaits).
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  localStorage.clear();
  __resetPinnedForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("coercePinDoc", () => {
  it("parses a well-formed doc", () => {
    expect(coercePinDoc({ revision: 3, initialized: true, orderedSessionIds: ["a", "b"] })).toEqual({
      revision: 3,
      initialized: true,
      orderedSessionIds: ["a", "b"],
    });
  });
  it("defaults missing scalars and filters non-string ids", () => {
    expect(coercePinDoc({ orderedSessionIds: ["a", 7, "b", null] })).toEqual({
      revision: 0,
      initialized: false,
      orderedSessionIds: ["a", "b"],
    });
  });
  it("returns null for non-object input", () => {
    expect(coercePinDoc(null)).toBeNull();
    expect(coercePinDoc("nope")).toBeNull();
    expect(coercePinDoc(42)).toBeNull();
  });
});

describe("applyPinsSnapshot — initialized server wins unconditionally", () => {
  it("adopts the server doc and ignores legacy localStorage", () => {
    // Legacy has pins the user set locally; server authority overrides them.
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["a", "b"] }));
    localStorage.setItem("vh.pinned-order.v1", JSON.stringify({ v: 1, data: ["a", "b"] }));
    __resetPinnedForTest();

    applyPinsSnapshot(pinDoc(5, true, ["x", "y"]));

    expect(pinsServerMode()).toBe(true);
    expect(reconciledPinnedOrder()).toEqual(["x", "y"]);
    expect(isPinned("x")).toBe(true);
    expect(isPinned("a")).toBe(false); // legacy "a" does NOT survive
    expect(pinsRevision()).toBe(5);
    expect(pinsInitialized()).toBe(true);
  });

  it("shadows the authoritative order to BOTH legacy keys (rollback compat)", () => {
    applyPinsSnapshot(pinDoc(2, true, ["x", "y"]));
    expect((readLegacyEnv("vh.pinned.v1") as { data: string[] }).data).toEqual(["x", "y"]);
    expect((readLegacyEnv("vh.pinned-order.v1") as { data: string[] }).data).toEqual(["x", "y"]);
  });

  it("clears a prior advisory error on a confirmed doc (Gap 1)", async () => {
    // p5-defer-sidebar-pins-test-gaps Gap 1: the prior version never planted
    // pinsLastError before asserting null — comment admitted "instead verify
    // indirectly" — so the assertion was trivially green. Drive a REAL error
    // first so the clear-on-confirmed-doc assertion is load-bearing.
    //
    // 1. Seed an initialized server doc.
    applyPinsSnapshot(pinDoc(1, true, ["x"]));
    expect(pinsLastError()).toBeNull();
    // 2. Drive an error: a togglePin whose PUT fails on the network. The
    //    optimistic ["x","y"] rolls back to ["x"] and pinsLastError="pin-network"
    //    (the load-bearing precondition the old test never set).
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));
    await togglePin("y");
    expect(pinsLastError()).toBe("pin-network");
    expect(reconciledPinnedOrder()).toEqual(["x"]); // optimistic rolled back
    expect(pinsRevision()).toBe(1);
    // 3. A confirmed snapshot (server authority) clears the advisory error via
    //    adoptServerDoc → clearPinsErrorSig, and adopts the new order/revision.
    applyPinsSnapshot(pinDoc(2, true, ["x", "y"]));
    expect(pinsLastError()).toBeNull();
    expect(reconciledPinnedOrder()).toEqual(["x", "y"]);
    expect(pinsRevision()).toBe(2);
  });
});

describe("applyPinsSnapshot — uninitialized triggers one-shot migration", () => {
  it("shows the legacy seed optimistically and PUTs initializeOnly on first connect", async () => {
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["a", "b"] }));
    localStorage.setItem("vh.pinned-order.v1", JSON.stringify({ v: 1, data: ["a", "b"] }));
    __resetPinnedForTest();
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(pinDoc(1, true, ["a", "b"]))));
    vi.stubGlobal("fetch", fetchMock);

    applyPinsSnapshot(pinDoc(0, false, []));

    // Synchronous (pre-PUT): optimistic seed from legacy, mode flipped.
    expect(pinsServerMode()).toBe(true);
    expect(reconciledPinnedOrder()).toEqual(["a", "b"]);

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      baseRevision: 0,
      initializeOnly: true,
      orderedSessionIds: ["a", "b"],
    });
    // After the 200: server initialized with our seed.
    expect(pinsInitialized()).toBe(true);
    expect(pinsRevision()).toBe(1);
    expect(reconciledPinnedOrder()).toEqual(["a", "b"]);
  });

  it("on 409 adopts the winner and discards the local seed (no union/merge)", async () => {
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["a", "b"] }));
    __resetPinnedForTest();
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonRes(pinDoc(1, true, ["z"]), 409)),
    );
    vi.stubGlobal("fetch", fetchMock);

    applyPinsSnapshot(pinDoc(0, false, []));
    await flush();

    // Another browser won with ["z"]; our ["a","b"] seed is discarded.
    expect(reconciledPinnedOrder()).toEqual(["z"]);
    expect(pinsInitialized()).toBe(true);
    expect(pinsLastError()).toBeNull();
  });

  it("does NOT re-submit the migration on a second snapshot in the same session", async () => {
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["a"] }));
    __resetPinnedForTest();
    // Network failure: migration attempted but the server stays uninitialized.
    const fetchMock = vi.fn(() => Promise.reject(new Error("net")));
    vi.stubGlobal("fetch", fetchMock);

    applyPinsSnapshot(pinDoc(0, false, []));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Reconnect emits another snapshot, still uninitialized.
    applyPinsSnapshot(pinDoc(0, false, []));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // migrationAttempted guard
  });

  it("skips migration when there is no legacy seed (nothing to claim)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    applyPinsSnapshot(pinDoc(0, false, []));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reconciledPinnedOrder()).toEqual([]);
  });
});

describe("applyPinsUpdated — revision-monotonicity guard (F1)", () => {
  it("drops a live update whose revision is older than the last-applied", () => {
    applyPinsSnapshot(pinDoc(5, true, ["a"]));
    applyPinsUpdated(pinDoc(4, true, ["b"])); // stale → dropped
    expect(reconciledPinnedOrder()).toEqual(["a"]);
    expect(pinsRevision()).toBe(5);
  });

  it("adopts an update whose revision is newer", () => {
    applyPinsSnapshot(pinDoc(5, true, ["a"]));
    applyPinsUpdated(pinDoc(6, true, ["b", "c"]));
    expect(reconciledPinnedOrder()).toEqual(["b", "c"]);
    expect(pinsRevision()).toBe(6);
  });

  it("allows an equal-revision update through (idempotent re-adopt)", () => {
    applyPinsSnapshot(pinDoc(5, true, ["a"]));
    applyPinsUpdated(pinDoc(5, true, ["a"])); // same rev, same doc
    expect(reconciledPinnedOrder()).toEqual(["a"]);
    expect(pinsRevision()).toBe(5);
  });
});

describe("togglePin (server mode) — PUT + bounded 409 retry", () => {
  it("pins via PUT 200 and adopts the confirmed doc", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(pinDoc(2, true, ["a"]))));
    vi.stubGlobal("fetch", fetchMock);

    await togglePin("a");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ baseRevision: 1, orderedSessionIds: ["a"] });
    expect(body.initializeOnly).toBeUndefined();
    expect(reconciledPinnedOrder()).toEqual(["a"]);
    expect(isPinned("a")).toBe(true);
    expect(pinsRevision()).toBe(2);
  });

  it("unpins by removing the id from the ordered list", async () => {
    applyPinsSnapshot(pinDoc(1, true, ["a", "b"]));
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(pinDoc(2, true, ["a"]))));
    vi.stubGlobal("fetch", fetchMock);

    await togglePin("b");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.orderedSessionIds).toEqual(["a"]);
    expect(reconciledPinnedOrder()).toEqual(["a"]);
    expect(isPinned("b")).toBe(false);
  });

  it("on 409 adopts authoritative, recomputes the same intent, retries once (200)", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    const seq = [
      jsonRes(pinDoc(1, true, ["b"]), 409), // concurrent PUT added "b"
      jsonRes(pinDoc(2, true, ["b", "a"])), // our retry wins
    ];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await togglePin("a"); // pin a

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Retry body derived from the adopted ["b"]: pin a → ["b","a"].
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody.orderedSessionIds).toEqual(["b", "a"]);
    expect(reconciledPinnedOrder()).toEqual(["b", "a"]);
    expect(pinsRevision()).toBe(2);
    expect(pinsLastError()).toBeNull();
  });

  it("on a second 409 stops, surfaces, and leaves the authoritative doc in place", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    const seq = [
      jsonRes(pinDoc(1, true, ["b"]), 409),
      jsonRes(pinDoc(2, true, ["b", "c"]), 409), // another concurrent change beat the retry
    ];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await togglePin("a");

    expect(fetchMock).toHaveBeenCalledTimes(2); // first + one retry, then stop
    expect(reconciledPinnedOrder()).toEqual(["b", "c"]); // authoritative adopted
    expect(pinsLastError()).toBe("pin-conflict");
  });

  it("does not issue a retry PUT when the adopted doc already satisfies the intent", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    // We pin "a"; the 409 body shows "a" is already pinned (someone else did it).
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(pinDoc(1, true, ["a"]), 409)));
    vi.stubGlobal("fetch", fetchMock);

    await togglePin("a");

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry — already satisfied
    expect(reconciledPinnedOrder()).toEqual(["a"]);
    expect(pinsLastError()).toBeNull();
  });

  it("on network error rolls back the optimistic update", async () => {
    applyPinsSnapshot(pinDoc(1, true, ["x"]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));

    await togglePin("y"); // optimistic ["x","y"] → rolled back

    expect(reconciledPinnedOrder()).toEqual(["x"]);
    expect(pinsLastError()).toBe("pin-network");
  });
});

describe("movePinnedTo / movePinnedByOffset (server mode) — reorder, no replay", () => {
  it("reorders via PUT 200 and adopts", async () => {
    applyPinsSnapshot(pinDoc(1, true, ["a", "b", "c"]));
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(pinDoc(2, true, ["c", "a", "b"]))));
    vi.stubGlobal("fetch", fetchMock);

    await movePinnedTo("c", "a", "before");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.orderedSessionIds).toEqual(["c", "a", "b"]);
    expect(reconciledPinnedOrder()).toEqual(["c", "a", "b"]);
  });

  it("on 409 discards the optimistic ordering and does NOT auto-replay", async () => {
    applyPinsSnapshot(pinDoc(1, true, ["a", "b", "c"]));
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonRes(pinDoc(1, true, ["a", "b", "c", "d"]), 409)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await movePinnedTo("c", "a", "before");

    expect(fetchMock).toHaveBeenCalledTimes(1); // NO retry for reorder
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c", "d"]); // authoritative
    expect(pinsLastError()).toBe("pin-conflict");
  });

  it("movePinnedByOffset translates to a reorder PUT", async () => {
    applyPinsSnapshot(pinDoc(1, true, ["a", "b", "c"]));
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(pinDoc(2, true, ["b", "a", "c"]))));
    vi.stubGlobal("fetch", fetchMock);

    await movePinnedByOffset("b", -1); // b up → [b, a, c]

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.orderedSessionIds).toEqual(["b", "a", "c"]);
    expect(reconciledPinnedOrder()).toEqual(["b", "a", "c"]);
  });

  it("is a no-op (no PUT) when the offset pushes past the boundary", async () => {
    applyPinsSnapshot(pinDoc(1, true, ["a", "b"]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await movePinnedByOffset("a", -1); // already first → clamp

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reconciledPinnedOrder()).toEqual(["a", "b"]);
  });
});

// === S2: 400 self-heal — the stale-pinned-id repro ============================
// A stale (archived/deleted) pinned id left in serverOrder used to brick ALL
// pin operations: the server's anti-resurrection guard 400-rejected the full
// Replace and the client surfaced a generic pin-error with no self-heal. Now
// putPins parses the structured 400's unknownIds, performMembershipMutation +
// performReorder drop those ids from the local order (base minus dropped),
// recompute the SAME intent against the cleaned base, and retry ONCE at the
// SAME base revision (a 400 did not advance the server doc). Bounded: a second
// failure surfaces pin-error (no infinite retry).
describe("400 self-heal — stale pinned id dropped + one bounded retry", () => {
  // Structured 400 body helper (mirrors the server contract).
  function unknownRes(ids: string[]): Response {
    return jsonRes(
      {
        error: "unknown_session",
        message: "unknown session id (not active on this worker): " + ids.join(", "),
        unknownIds: ids,
      },
      400,
    );
  }

  it("REPRO: pin drops the stale id, retries once at the SAME base rev, succeeds", async () => {
    // serverOrder carries a stale archived id + a live id.
    applyPinsSnapshot(pinDoc(5, true, ["stale", "live"]));
    const seq = [
      unknownRes(["stale"]), // first PUT: server says "stale" is unknown
      jsonRes(pinDoc(6, true, ["live", "new"]), 200), // retry PUT: cleaned order wins
    ];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await togglePin("new"); // pin "new"

    expect(fetchMock).toHaveBeenCalledTimes(2); // first 400 + exactly one retry
    // First PUT shipped the stale base order (full Replace).
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(firstBody).toMatchObject({ baseRevision: 5, orderedSessionIds: ["stale", "live", "new"] });
    // Retry PUT shipped the CLEANED order (stale dropped) at the SAME base rev
    // (a 400 did not advance the server doc).
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody).toMatchObject({ baseRevision: 5, orderedSessionIds: ["live", "new"] });
    // Final state: stale dropped, new pinned, sync unbricked, no error.
    expect(reconciledPinnedOrder()).toEqual(["live", "new"]);
    expect(isPinned("stale")).toBe(false);
    expect(isPinned("new")).toBe(true);
    expect(pinsLastError()).toBeNull();
    expect(pinsRevision()).toBe(6);
  });

  it("REPRO: unpin drops the stale id, retries once, succeeds", async () => {
    applyPinsSnapshot(pinDoc(5, true, ["stale", "live"]));
    const seq = [unknownRes(["stale"]), jsonRes(pinDoc(6, true, []), 200)];
    let i = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(seq[i++])));

    await togglePin("live"); // unpin live

    // First PUT: unpin live from ["stale","live"] → ["stale"] → 400 unknownIds=["stale"].
    // cleanedBase = ["live"]; retryTarget = unpin live → []. Retry PUT [] → 200.
    expect(reconciledPinnedOrder()).toEqual([]);
    expect(isPinned("stale")).toBe(false);
    expect(isPinned("live")).toBe(false);
    expect(pinsLastError()).toBeNull();
  });

  it("REPRO: reorder drops the stale id, recomputes the reorder, retries once", async () => {
    applyPinsSnapshot(pinDoc(5, true, ["stale", "a", "b"]));
    const seq = [unknownRes(["stale"]), jsonRes(pinDoc(6, true, ["b", "a"]), 200)];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await movePinnedTo("b", "a", "before"); // move b before a

    // First PUT: reorder ["stale","a","b"] → ["stale","b","a"] → 400 unknownIds=["stale"].
    // cleanedBase = ["a","b"]; retryTarget = reorder ["a","b"] b-before-a → ["b","a"].
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody).toMatchObject({ baseRevision: 5, orderedSessionIds: ["b", "a"] });
    expect(reconciledPinnedOrder()).toEqual(["b", "a"]);
    expect(isPinned("stale")).toBe(false);
    expect(pinsLastError()).toBeNull();
  });

  it("REPRO: multiple stale ids collected at once are all dropped in the single retry", async () => {
    applyPinsSnapshot(pinDoc(5, true, ["stale1", "stale2", "live"]));
    const seq = [
      unknownRes(["stale1", "stale2"]), // server collected BOTH
      jsonRes(pinDoc(6, true, ["live", "new"]), 200),
    ];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await togglePin("new");

    // Retry shipped the cleaned order with BOTH stale ids dropped.
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody.orderedSessionIds).toEqual(["live", "new"]);
    expect(isPinned("stale1")).toBe(false);
    expect(isPinned("stale2")).toBe(false);
    expect(reconciledPinnedOrder()).toEqual(["live", "new"]);
  });

  it("BOUNDED: a retry that also fails surfaces pin-error (no infinite retry)", async () => {
    applyPinsSnapshot(pinDoc(5, true, ["stale", "live"]));
    // First 400 drops "stale"; the retry ALSO 400s (e.g. "live" went stale too,
    // or a transient). Must NOT retry again.
    const seq = [unknownRes(["stale"]), unknownRes(["live"])];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await togglePin("new");

    expect(fetchMock).toHaveBeenCalledTimes(2); // first 400 + ONE retry, then stop
    // Rolled back to the cleaned base (["live"] — the second 400's "live" is
    // NOT dropped; self-heal is bounded to one retry).
    expect(reconciledPinnedOrder()).toEqual(["live"]);
    expect(pinsLastError()).toBe("pin-error");
  });

  it("BOUNDED: a retry that hits a network error surfaces pin-network", async () => {
    applyPinsSnapshot(pinDoc(5, true, ["stale", "live"]));
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((): Promise<Response> => {
        call++;
        if (call === 1) return Promise.resolve(unknownRes(["stale"]));
        return Promise.reject(new Error("net"));
      }),
    );

    await togglePin("new");

    expect(reconciledPinnedOrder()).toEqual(["live"]); // rolled back to cleaned base
    expect(pinsLastError()).toBe("pin-network");
  });

  it("a 400 WITHOUT unknownIds is a generic pin-error (no self-heal, no retry)", async () => {
    // e.g. an over-cap or duplicate-id 400 (text/plain or no unknownIds).
    applyPinsSnapshot(pinDoc(5, true, ["live"]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes({ error: "other" }, 400))));

    await togglePin("new");

    // No retry — unknownIds absent → generic failure path.
    expect(reconciledPinnedOrder()).toEqual(["live"]); // optimistic rolled back
    expect(pinsLastError()).toBe("pin-error");
  });
});

describe("pinsPending — reflects in-flight PUTs", () => {
  it("is true while a PUT is in flight, false after it settles", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    let resolveFetch!: (v: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((r) => (resolveFetch = r))),
    );

    const p = togglePin("a");
    expect(pinsPending()).toBe(true);

    resolveFetch(jsonRes(pinDoc(2, true, ["a"])));
    await p;
    expect(pinsPending()).toBe(false);
  });
});

// Phase 6: concurrency convergence + the two correctness DEFER regressions
// (p5-defer-retry-rollback-race, p5-defer-put-success-adopt-race). These exercise
// the retry/rollback path's revision-monotonicity guards that were missing in
// the initial Phase 5 facade.
describe("Phase 6 — concurrency + DEFER regressions", () => {
  it("concurrent pin of different IDs converges (both present after retry)", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    // Realistic CAS sequencing. togglePin("a") and togglePin("b") are fired
    // back-to-back (both capture the same pre-mutation snapshot). "a"'s PUT wins
    // (200, rev2); "b"'s PUT is now stale (baseRev1) → 409, the facade adopts
    // ["a"], recomputes "pin b" against it → ["a","b"], retries (200, rev3).
    const seq = [
      jsonRes(pinDoc(2, true, ["a"]), 200), // togglePin("a") PUT ["a"]
      jsonRes(pinDoc(2, true, ["a"]), 409), // togglePin("b") PUT ["b"] → stale base
      jsonRes(pinDoc(3, true, ["a", "b"]), 200), // togglePin("b") retry ["a","b"]
    ];
    let i = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(seq[i++])));

    const pa = togglePin("a");
    const pb = togglePin("b");
    await pa;
    await pb;

    expect(reconciledPinnedOrder()).toEqual(["a", "b"]);
    expect(isPinned("a")).toBe(true);
    expect(isPinned("b")).toBe(true);
    expect(pinsLastError()).toBeNull();
  });

  it("same-ID pin then unpin follows accepted server write order", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    const seq = [
      jsonRes(pinDoc(2, true, ["a"]), 200), // pin a
      jsonRes(pinDoc(3, true, []), 200), // unpin a
    ];
    let i = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(seq[i++])));

    await togglePin("a");
    expect(isPinned("a")).toBe(true);
    expect(reconciledPinnedOrder()).toEqual(["a"]);

    await togglePin("a");
    expect(isPinned("a")).toBe(false);
    expect(reconciledPinnedOrder()).toEqual([]);
    expect(pinsRevision()).toBe(3);
  });

  it("stale reorder is NOT silently replayed — on 409 adopts the server doc verbatim", async () => {
    applyPinsSnapshot(pinDoc(1, true, ["a", "b", "c"]));
    // User reorders c→before a (optimistic [c,a,b]); server 409s with a doc whose
    // order DIFFERS (a concurrent change appended "d", rev2). The new
    // adoptPutResponse guard adopts it (2 >= 1) and the client must NOT re-apply
    // the stale [c,a,b] permutation. Reorder never retries.
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonRes(pinDoc(2, true, ["a", "b", "c", "d"]), 409)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await movePinnedTo("c", "a", "before");

    expect(fetchMock).toHaveBeenCalledTimes(1); // NO retry for reorder
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c", "d"]); // server doc, NOT [c,a,b]
    expect(pinsLastError()).toBe("pin-conflict");
  });

  it("clearPinsError clears a surfaced pin error", async () => {
    applyPinsSnapshot(pinDoc(1, true, ["x"]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));

    await togglePin("y"); // fails → pin-network error
    expect(pinsLastError()).toBe("pin-network");

    clearPinsError();
    expect(pinsLastError()).toBeNull();
  });

  // p5-defer-retry-rollback-race: a stale captured rollback baseline must not
  // clobber a fresher server state adopted via an interleaved pins.updated frame
  // during the retry round-trip.
  it("DEFER1: stale-snapshot rollback does NOT clobber a fresher revision", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    // togglePin("a"): first PUT 409s (adopts docA=["b"], rev1). The retry PUT is
    // issued at rev1 and held pending. A pins.updated frame (docB=["b","c"],
    // rev5) lands DURING the retry round-trip and is adopted. The retry then
    // fails non-409 (network). Before the fix, applyServerOrder(["b"]) would
    // clobber docB while leaving revision at 5. After the fix, the rollback is
    // gated on revision-equality (5 !== retry-issue 1) and docB is left intact.
    let callCount = 0;
    let rejectRetry!: (e: unknown) => void;
    const fetchMock = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(jsonRes(pinDoc(1, true, ["b"]), 409)); // docA
      }
      return new Promise<Response>((_, rej) => (rejectRetry = rej)); // retry, pending
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = togglePin("a");
    await flush(); // first PUT (409 docA) resolves + retry PUT issued (pending)
    expect(callCount).toBe(2);

    // Fresher frame lands during the retry round-trip.
    applyPinsUpdated(pinDoc(5, true, ["b", "c"])); // docB
    expect(pinsRevision()).toBe(5);
    expect(reconciledPinnedOrder()).toEqual(["b", "c"]);

    rejectRetry(new Error("net")); // retry fails non-409
    await p;

    expect(reconciledPinnedOrder()).toEqual(["b", "c"]); // NOT rolled back to ["b"]
    expect(pinsRevision()).toBe(5);
    expect(pinsLastError()).toBe("pin-network");
  });

  // p5-defer-put-success-adopt-race: the 200-PUT success-adopt path must honor
  // the same revision-monotonicity guard as applyPinsUpdated (F1).
  it("DEFER2: a 200-PUT response older than the held revision is dropped", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    // togglePin("a") issues a PUT (baseRev1). DURING the round-trip, a
    // pins.updated frame (docB=["z"], rev5) lands and is adopted. The PUT's 200
    // response then returns with an OLDER revision (docA=["a"], rev2). Before the
    // fix, adoptServerDoc would regress client order/revision to ["a"]/2. After
    // the fix, adoptPutResponse drops it (2 < 5), leaving docB intact.
    let resolvePut!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolvePut = r))));

    const p = togglePin("a");
    await flush(); // PUT issued, pending

    applyPinsUpdated(pinDoc(5, true, ["z"])); // docB fresher
    expect(reconciledPinnedOrder()).toEqual(["z"]);
    expect(pinsRevision()).toBe(5);

    resolvePut(jsonRes(pinDoc(2, true, ["a"]), 200)); // stale 200 response
    await p;

    expect(reconciledPinnedOrder()).toEqual(["z"]); // NOT regressed to ["a"]
    expect(pinsRevision()).toBe(5);
    expect(pinsLastError()).toBeNull();
  });

  // p5-defer-sidebar-pins-test-gaps Gap 2: no test exercised the SERVER-DOC
  // adoption path (applyPinsSnapshot, the bootstrap reset that is EXEMPT from
  // the revision-monotonicity guard) landing DURING an in-flight PUT. The
  // snapshot is authoritative and resets the base; a subsequent 200 must then
  // reconcile via adoptPutResponse's guard without clobbering the snapshot or
  // regressing revision. (Gap 3 — the 409-retry-rollback race — is covered by
  // the DEFER1 test above, so it is intentionally NOT duplicated here.)
  it("Gap 2: a pins.snapshot during an in-flight PUT reconciles without clobber", async () => {
    applyPinsSnapshot(pinDoc(1, true, []));
    // Start togglePin("a") with a PUT that stays pending (unresolved).
    let resolvePut!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolvePut = r))));

    const p = togglePin("a");
    await flush(); // PUT issued, pending; optimistic ["a"] applied
    expect(pinsPending()).toBe(true);
    expect(reconciledPinnedOrder()).toEqual(["a"]); // optimistic
    expect(pinsRevision()).toBe(1);

    // While the PUT is in flight, a server snapshot lands (e.g. a reconnect
    // re-bootstrap). The snapshot is authoritative and EXEMPT from the F1 guard,
    // so it adopts ["b","c"] at rev2 — overwriting the optimistic ["a"].
    applyPinsSnapshot(pinDoc(2, true, ["b", "c"]));
    expect(reconciledPinnedOrder()).toEqual(["b", "c"]); // server authority wins
    expect(pinsRevision()).toBe(2);

    // The PUT now resolves 200 with a doc that reconciles the snapshot + the
    // pin (server applied our pin on top of the snapshot it sent: rev3,
    // ["b","c","a"]). adoptPutResponse honors the F1 guard: 3 >= 2 → adopted.
    resolvePut(jsonRes(pinDoc(3, true, ["b", "c", "a"]), 200));
    await p;

    // Final state reconciles: no clobber of the snapshot, revision monotonic
    // (1 → 2 → 3), no advisory error.
    expect(reconciledPinnedOrder()).toEqual(["b", "c", "a"]);
    expect(pinsRevision()).toBe(3);
    expect(pinsLastError()).toBeNull();
    expect(pinsPending()).toBe(false);
  });
});

// CAS regression coverage for the rollbackOrderIfUnchanged call sites NOT
// exercised by DEFER1 above. DEFER1 covered only the 409-retry rollback race
// (performMembershipMutation L460). The initial-PUT rollback (L509, first-
// attempt non-409/non-400 failure) and the reorder rollback (L582, first-attempt
// failure) were uncovered. The guard is identical at every call site:
// serverRevision() !== issueRevision → no-op (fresher frame won); === →
// applyServerOrder(baseline) (rollback succeeds). These pin both branches for
// both uncovered paths.
describe("rollbackOrderIfUnchanged — CAS regression for initial-PUT + reorder paths", () => {
  it("initial-PUT membership rollback succeeds when revision is unchanged", async () => {
    // togglePin on a baseline order; the first PUT fails non-409 (network). No
    // fresher frame landed during the round-trip, so serverRevision() === baseRev
    // and the optimistic target rolls back to the pre-mutation baseline.
    applyPinsSnapshot(pinDoc(1, true, ["a", "b"]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));

    await togglePin("c"); // optimistic ["a","b","c"] → rolled back to baseline

    expect(reconciledPinnedOrder()).toEqual(["a", "b"]); // baseline restored
    expect(pinsRevision()).toBe(1);
    expect(pinsLastError()).toBe("pin-network");
  });

  it("initial-PUT membership rollback is a no-op when a fresher frame landed", async () => {
    // togglePin issues a PUT that stays pending; a pins.updated frame (rev5)
    // lands DURING the round-trip and is adopted. The PUT then fails non-409.
    // serverRevision() (5) !== baseRev (1), so the rollback is skipped and the
    // fresher frame's order is left intact.
    applyPinsSnapshot(pinDoc(1, true, ["a", "b"]));
    let rejectPut!: (e: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_, rej) => (rejectPut = rej))));

    const p = togglePin("c");
    await flush(); // optimistic ["a","b","c"] applied; PUT pending
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c"]);

    applyPinsUpdated(pinDoc(5, true, ["a", "b", "z"])); // fresher frame adopted
    expect(pinsRevision()).toBe(5);
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "z"]);

    rejectPut(new Error("net")); // PUT fails non-409
    await p;

    expect(reconciledPinnedOrder()).toEqual(["a", "b", "z"]); // NOT rolled back
    expect(pinsRevision()).toBe(5);
    expect(pinsLastError()).toBe("pin-network");
  });

  it("reorder rollback succeeds when revision is unchanged", async () => {
    // movePinnedTo on a baseline order; the first PUT fails non-409 (network).
    // No fresher frame landed, so the optimistic reorder rolls back to baseline.
    applyPinsSnapshot(pinDoc(1, true, ["a", "b", "c"]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));

    await movePinnedTo("c", "a", "before"); // optimistic ["c","a","b"] → rolled back

    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c"]); // baseline restored
    expect(pinsRevision()).toBe(1);
    expect(pinsLastError()).toBe("pin-network");
  });

  it("reorder rollback is a no-op when a fresher frame landed", async () => {
    // movePinnedTo issues a PUT that stays pending; a pins.updated frame (rev5)
    // lands DURING the round-trip and is adopted. The PUT then fails non-409.
    // serverRevision() (5) !== baseRev (1), so the rollback is skipped.
    applyPinsSnapshot(pinDoc(1, true, ["a", "b", "c"]));
    let rejectPut!: (e: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_, rej) => (rejectPut = rej))));

    const p = movePinnedTo("c", "a", "before");
    await flush(); // optimistic ["c","a","b"] applied; PUT pending
    expect(reconciledPinnedOrder()).toEqual(["c", "a", "b"]);

    applyPinsUpdated(pinDoc(5, true, ["a", "b", "c", "d"])); // fresher frame adopted
    expect(pinsRevision()).toBe(5);
    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c", "d"]);

    rejectPut(new Error("net")); // PUT fails non-409
    await p;

    expect(reconciledPinnedOrder()).toEqual(["a", "b", "c", "d"]); // NOT rolled back
    expect(pinsRevision()).toBe(5);
    expect(pinsLastError()).toBe("pin-network");
  });
});

// === S3: proactive drop on archive/delete + audits ============================
// dropPinnedSession is the LOCAL correction called from the session.delete /
// prune path when a session is archived or deleted, so a stale pinned id is
// evicted from serverOrder immediately rather than waiting for (or missing)
// the server's pins.updated removal. It is a no-op in legacy mode. The S2
// self-heal remains the durable backstop.
describe("dropPinnedSession — proactive local drop on archive/delete", () => {
  it("drops a pinned id from serverOrder in server mode (local correction, no PUT)", () => {
    applyPinsSnapshot(pinDoc(5, true, ["a", "stale", "b"]));
    dropPinnedSession("stale");
    expect(reconciledPinnedOrder()).toEqual(["a", "b"]);
    expect(isPinned("stale")).toBe(false);
    expect(pinsRevision()).toBe(5); // revision unchanged — no PUT issued
  });

  it("is a no-op for an id not in the order", () => {
    applyPinsSnapshot(pinDoc(5, true, ["a"]));
    dropPinnedSession("ghost");
    expect(reconciledPinnedOrder()).toEqual(["a"]);
    expect(pinsRevision()).toBe(5);
  });

  it("shadows the corrected order to the legacy keys (rollback compat)", () => {
    applyPinsSnapshot(pinDoc(5, true, ["a", "stale"]));
    dropPinnedSession("stale");
    expect((readLegacyEnv("vh.pinned.v1") as { data: string[] }).data).toEqual(["a"]);
    expect((readLegacyEnv("vh.pinned-order.v1") as { data: string[] }).data).toEqual(["a"]);
  });

  it("is a no-op in legacy mode (the legacy path owns its own removal)", () => {
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["a"] }));
    localStorage.setItem("vh.pinned-order.v1", JSON.stringify({ v: 1, data: ["a"] }));
    __resetPinnedForTest();
    expect(pinsServerMode()).toBe(false);
    dropPinnedSession("a");
    expect(isPinned("a")).toBe(true); // legacy mode does not drop
  });
});

// Audit: applyPinsUpdated's revision-monotonicity guard (pins.ts F1) must
// NOT drop a removal-only update at rev+1. The guard only drops STRICTLY-older
// revisions; equal/never are allowed. A server-side pin removal (archive) fans
// out as pins.updated at rev+1 with the id absent — the client must adopt it
// and drop the id from serverOrder.
describe("applyPinsUpdated — removal-only update is NOT dropped by the guard", () => {
  it("server removes a pinned id at rev+1 → client serverOrder drops it", () => {
    applyPinsSnapshot(pinDoc(5, true, ["a", "stale", "b"]));
    applyPinsUpdated(pinDoc(6, true, ["a", "b"])); // rev+1, "stale" removed
    expect(reconciledPinnedOrder()).toEqual(["a", "b"]);
    expect(isPinned("stale")).toBe(false);
    expect(pinsRevision()).toBe(6);
  });
});

// Audit: readLegacyReconciledSeed / writeLegacyShadow — a reconnect MUST NOT
// resurrect an inactive id via the legacy seed. When the server snapshot is
// initialized:true, serverOrder is set from the server doc unconditionally and
// the legacy seed is NOT consulted (server authority wins). The seed is only
// used when initialized:false (the one-shot migration window).
describe("legacy seed — initialized server wins, stale id NOT resurrected", () => {
  it("legacy LS has a stale id but server is initialized without it → serverOrder excludes it", () => {
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["stale", "live"] }));
    localStorage.setItem("vh.pinned-order.v1", JSON.stringify({ v: 1, data: ["stale", "live"] }));
    __resetPinnedForTest();

    // Server is initialized with only "live" — "stale" must NOT resurrect.
    applyPinsSnapshot(pinDoc(3, true, ["live"]));

    expect(reconciledPinnedOrder()).toEqual(["live"]);
    expect(isPinned("stale")).toBe(false);
    expect(pinsRevision()).toBe(3);
  });

  it("a reconnect re-snapshot (initialized) keeps the server order, not the legacy seed", () => {
    // First connect: server initialized with ["live"].
    applyPinsSnapshot(pinDoc(3, true, ["live"]));
    // Legacy keys now shadow ["live"] (writeLegacyShadow in adoptServerDoc).
    // Plant a stale id back into the legacy keys (simulating a tampered/old
    // shadow from a rolled-back binary).
    localStorage.setItem("vh.pinned.v1", JSON.stringify({ v: 1, data: ["stale", "live"] }));
    localStorage.setItem("vh.pinned-order.v1", JSON.stringify({ v: 1, data: ["stale", "live"] }));
    // Reconnect: server re-snapshots initialized with ["live"] at the same rev.
    applyPinsSnapshot(pinDoc(3, true, ["live"]));
    expect(reconciledPinnedOrder()).toEqual(["live"]);
    expect(isPinned("stale")).toBe(false);
  });
});
