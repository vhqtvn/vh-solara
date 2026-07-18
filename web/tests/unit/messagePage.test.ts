// @vitest-environment jsdom
// Phase 4 — historical-page prepend + Contract-B response gate + eviction.
//
// These tests pin:
//   1. The pure reduce.ts helpers (prependMessagesIfAbsent,
//      deleteMessagesFromTop, approxResidentBytes) — insert-if-not-present,
//      never-overwrite-existing, re-sort, eviction-from-oldest-end.
//   2. The loadOlder state machine (single-flight, clean-response merge,
//      merge-if-absent, end-of-history, eviction-fires-when-over-cap,
//      no-op-guards, error-clears-loadingOlder).
//   3. The Contract-B response gate's discard paths (mirrors
//      TestColdBatchDiscardsStaleAfterConcurrentMutation for the HTTP-page
//      path — see pkg/state/store_test.go:1335 for the cold-batch precedent):
//      dirty-retry + bounded abandon, sesGen discard (connection replaced),
//      epoch discard (server restarted).
//   4. The sticky-hasOlder-after-eviction invariant: an end-of-history page
//      (has_older=false) that triggers eviction must keep hasOlder=true so
//      the Load-older button re-appears for the evicted range.
//
// The fetch is mocked via global.fetch so we can drive the response-gate
// branches deterministically without a server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import {
  MAX_RESIDENT_MESSAGES,
  closeSessionStream,
  loadOlder,
  markPageDirty,
  resetPageInFlight,
} from "../../src/sync/stream";
import {
  approxResidentBytes,
  buildMessages,
  deleteMessagesFromTop,
  prependMessagesIfAbsent,
} from "../../src/lib/reduce";
import { state, setState } from "../../src/sync/store";
import type { MessageInfo, SessionMessages } from "../../src/types";

// ── helpers ────────────────────────────────────────────────────────────────
function item(id: string, created = 1, text = "x") {
  return {
    info: { id, sessionID: "s1", role: "user", time: { created } } as MessageInfo,
    parts: [{ id: `p-${id}`, sessionID: "s1", messageID: id, type: "text", text }],
  };
}

function pageResponse(items: any[], opts: Partial<{ oldest_id: string | undefined; has_older: boolean }> = {}) {
  return {
    items,
    oldest_id: opts.oldest_id ?? (items[0]?.info?.id as string | undefined),
    newest_id: items[items.length - 1]?.info?.id,
    has_older: opts.has_older ?? false,
    session_id: "s1",
    project_id: "",
    daemon_epoch: "e1",
    baseline_seq: 1,
    request_before: "",
    serialized_bytes: 0,
    count_limited: false,
    bytes_limited: false,
  };
}

function makeResponse(body: any, seq = 1, epoch = "e1") {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => {
        if (name === "X-VH-Seq") return String(seq);
        if (name === "X-VH-Epoch") return epoch;
        return null;
      },
    },
    json: async () => body,
  } as any;
}

function buildItems(prefix: string, nums: number[]): any[] {
  return nums.map((n) => item(`${prefix}${n}`, n));
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

function seedSession(sm: SessionMessages, oldestID: string, hasOlder = true) {
  setState("messages", "s1", sm);
  setState("messageWindows", "s1", { hasOlder, oldestResidentID: oldestID });
}

// Reset every slice these tests touch. Solid's setState MERGES objects, so a
// plain setState("x", {}) would leave stale nested keys; reconcile({}) diffs
// each slice down to empty — a true reset (applySnapshot.test.ts pattern).
beforeEach(() => {
  setState("messages", reconcile({}));
  setState("messageWindows", reconcile({}));
  setState("messagesLoaded", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("cursor", 0);
  setState("epoch", "e1");
  resetPageInFlight();
  // Reset sesGen to a known baseline so the sesGen-discard test can bump it
  // deterministically. closeSessionStream() increments sesGen; calling it
  // once at setup gives us a stable nonzero baseline.
  closeSessionStream();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPageInFlight();
});

// ── pure helper tests ──────────────────────────────────────────────────────

describe("prependMessagesIfAbsent (pure)", () => {
  it("inserts items not already present and re-sorts by created time", () => {
    const sm = buildMessages([item("a", 10), item("c", 30)]);
    expect(sm.order).toEqual(["a", "c"]);
    const added = prependMessagesIfAbsent(sm, [item("b", 20)]);
    expect(added).toBe(1);
    expect(sm.order).toEqual(["a", "b", "c"]);
  });

  it("NEVER overwrites existing byId entries (live always wins)", () => {
    const sm = buildMessages([item("a", 10, "live-text")]);
    const before = JSON.stringify(sm.byId["a"].info);
    const added = prependMessagesIfAbsent(sm, [item("a", 10, "stale-page-text")]);
    expect(added).toBe(0);
    expect(sm.order).toEqual(["a"]);
    // Live info preserved — the page snapshot did NOT clobber it.
    expect(JSON.stringify(sm.byId["a"].info)).toBe(before);
    // Part text preserved too — the live part always wins.
    expect(sm.byId["a"].parts["p-a"].text).toBe("live-text");
  });

  it("empty input is a no-op (returns 0, no sort)", () => {
    const sm = buildMessages([item("a")]);
    const added = prependMessagesIfAbsent(sm, []);
    expect(added).toBe(0);
    expect(sm.order).toEqual(["a"]);
  });

  it("mixed batch: skips existing, inserts new, single re-sort", () => {
    const sm = buildMessages([item("a", 10), item("c", 30)]);
    const added = prependMessagesIfAbsent(sm, [
      item("a", 10, "stale"), // existing → skip
      item("b", 20), // new → insert
      item("d", 40), // new → insert
    ]);
    expect(added).toBe(2);
    expect(sm.order).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores malformed items (missing info)", () => {
    const sm = buildMessages([item("a")]);
    // @ts-expect-error — deliberately malformed (no info)
    const added = prependMessagesIfAbsent(sm, [{ parts: [] }]);
    expect(added).toBe(0);
    expect(sm.order).toEqual(["a"]);
  });
});

describe("deleteMessagesFromTop (pure)", () => {
  it("evicts from the oldest end (top of order)", () => {
    const sm = buildMessages([item("a", 10), item("b", 20), item("c", 30), item("d", 40)]);
    const removed = deleteMessagesFromTop(sm, 2);
    expect(removed).toBe(2);
    expect(sm.order).toEqual(["c", "d"]);
    expect(sm.byId["a"]).toBeUndefined();
    expect(sm.byId["b"]).toBeUndefined();
  });

  it("protectTail keeps the last N entries intact", () => {
    const sm = buildMessages([item("a", 10), item("b", 20), item("c", 30)]);
    // Try to evict all 3; protectTail=1 → at most 2 removable.
    const removed = deleteMessagesFromTop(sm, 3, 1);
    expect(removed).toBe(2);
    expect(sm.order).toEqual(["c"]);
  });

  it("count <= 0 is a no-op", () => {
    const sm = buildMessages([item("a"), item("b")]);
    expect(deleteMessagesFromTop(sm, 0)).toBe(0);
    expect(deleteMessagesFromTop(sm, -5)).toBe(0);
    expect(sm.order).toEqual(["a", "b"]);
  });

  it("protectTail larger than order is a no-op", () => {
    const sm = buildMessages([item("a"), item("b")]);
    expect(deleteMessagesFromTop(sm, 1, 5)).toBe(0);
    expect(sm.order).toEqual(["a", "b"]);
  });
});

describe("approxResidentBytes (pure)", () => {
  it("sums info + parts JSON sizes and is deterministic", () => {
    const sm1 = buildMessages([item("a", 1, "hello"), item("b", 2, "world!")]);
    const sm2 = buildMessages([item("a", 1, "hello"), item("b", 2, "world!")]);
    const b1 = approxResidentBytes(sm1);
    const b2 = approxResidentBytes(sm2);
    expect(b1).toBeGreaterThan(0);
    expect(b1).toBe(b2);
  });

  it("grows when more messages are added", () => {
    const sm = buildMessages([item("a")]);
    const before = approxResidentBytes(sm);
    prependMessagesIfAbsent(sm, [item("b"), item("c")]);
    const after = approxResidentBytes(sm);
    expect(after).toBeGreaterThan(before);
  });

  it("shrinks after eviction", () => {
    const sm = buildMessages([item("a", 1, "aaaa"), item("b", 2, "bbbb"), item("c", 3, "cccc")]);
    const before = approxResidentBytes(sm);
    deleteMessagesFromTop(sm, 2);
    const after = approxResidentBytes(sm);
    expect(after).toBeLessThan(before);
  });
});

// ── loadOlder state-machine tests ──────────────────────────────────────────
//
// These drive the full state machine via the exported `loadOlder(sid)` action.
// The store is seeded with a resident initial window (messages[sid] +
// messageWindows[sid] = { hasOlder: true, oldestResidentID: <id> }). The fetch
// is mocked. We assert on the resulting store state.

describe("loadOlder state machine", () => {
  it("single-flight: concurrent calls issue only one fetch", async () => {
    const sm = buildMessages([item("m5", 50)]);
    seedSession(sm, "m5");
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount++;
      // Delay so the second loadOlder lands while the first is in flight.
      await new Promise((r) => setTimeout(r, 20));
      return makeResponse(pageResponse([], { has_older: false }));
    });
    await Promise.all([loadOlder("s1"), loadOlder("s1")]);
    expect(fetchCount).toBe(1);
    expect(state.messageWindows.s1?.loadingOlder).toBeFalsy();
  });

  it("clean response: prepends page items and clears loadingOlder", async () => {
    const sm = buildMessages([item("m5", 50)]);
    seedSession(sm, "m5");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse(pageResponse([item("m3", 30), item("m4", 40)], { oldest_id: "m3", has_older: true })),
    );
    await loadOlder("s1");
    expect(state.messages.s1?.order).toEqual(["m3", "m4", "m5"]);
    expect(state.messageWindows.s1?.oldestResidentID).toBe("m3");
    expect(state.messageWindows.s1?.hasOlder).toBe(true);
    expect(state.messageWindows.s1?.loadingOlder).toBeFalsy();
  });

  it("merge-if-absent: live message preserved through prepend (overlap item)", async () => {
    const sm = buildMessages([item("m5", 50, "live-text")]);
    seedSession(sm, "m5");
    // Server returns m4 + m5 (overlap). m5 is already resident → live wins.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse(pageResponse([item("m4", 40), item("m5", 50, "stale-text")])),
    );
    await loadOlder("s1");
    expect(state.messages.s1?.order).toEqual(["m4", "m5"]);
    expect(state.messages.s1?.byId["m5"].parts["p-m5"].text).toBe("live-text");
  });

  it("end-of-history: server reports has_older=false → button hides", async () => {
    const sm = buildMessages([item("m5", 50)]);
    seedSession(sm, "m5", true);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse(pageResponse([item("m1", 10)], { oldest_id: "m1", has_older: false })),
    );
    await loadOlder("s1");
    expect(state.messageWindows.s1?.hasOlder).toBe(false);
    expect(state.messages.s1?.order).toEqual(["m1", "m5"]);
  });

  it("pure-overlap page (all items already resident): updates hasOlder, no prepend", async () => {
    const sm = buildMessages([item("m4", 40), item("m5", 50)]);
    seedSession(sm, "m4", true);
    // Server returns m4 (overlap only) — already resident.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse(pageResponse([item("m4", 40)], { oldest_id: "m4", has_older: false })),
    );
    await loadOlder("s1");
    expect(state.messages.s1?.order).toEqual(["m4", "m5"]);
    expect(state.messageWindows.s1?.hasOlder).toBe(false);
  });

  it("eviction fires when MAX_RESIDENT_MESSAGES is exceeded", async () => {
    // Seed near the cap; load a page that pushes over. The const cap is 500;
    // seed 499, load a page of 10 → 509 → evict from the top until <= 500.
    const near = buildMessages(buildItems("m", range(1, 500))); // m1..m499 (499)
    seedSession(near, "m1", true);
    const page = buildItems("o", range(-10, 0)); // o-10..o-1 (10 older msgs)
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse(pageResponse(page, { oldest_id: "o-10", has_older: true })),
    );
    await loadOlder("s1");
    // Resident count is bounded by MAX_RESIDENT_MESSAGES.
    expect(state.messages.s1?.order.length).toBeLessThanOrEqual(MAX_RESIDENT_MESSAGES);
    // Oldest resident is no longer the original m1 (eviction yanked some).
    expect(state.messageWindows.s1?.oldestResidentID).not.toBe("m1");
    // hasOlder forced true after eviction (button re-appears).
    expect(state.messageWindows.s1?.hasOlder).toBe(true);
  });

  it("no-op when oldestResidentID is missing (initial window not landed)", async () => {
    setState("messages", "s1", buildMessages([]));
    setState("messageWindows", "s1", { hasOlder: true }); // no oldestResidentID
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({} as any);
    await loadOlder("s1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-op when hasOlder is false (server already reported end-of-history)", async () => {
    seedSession(buildMessages([item("m1")]), "m1", false);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({} as any);
    await loadOlder("s1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clears loadingOlder on fetch error (no stuck spinner)", async () => {
    seedSession(buildMessages([item("m1")]), "m1", true);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await loadOlder("s1");
    expect(state.messageWindows.s1?.loadingOlder).toBeFalsy();
    // pageInFlight cleared so a later retry can fire.
  });

  // ── Contract-B dirty-retry + abandon (mirrors TestColdBatchDiscardsStaleAfterConcurrentMutation
  //     for the HTTP-page path — see pkg/state/store_test.go:1335 for the cold-batch
  //     precedent). A mutation during the flight sets `dirty` via the Stream2
  //     listener hook (markPageDirty); the response gate discards + re-issues up
  //     to MAX_PAGE_RETRIES, then abandons (per-request fallback — no unbounded
  //     memory, no resurrection). Live state always wins.

  it("dirty-retry: mutation during flight discards response and re-fetches", async () => {
    const sm = buildMessages([item("m5", 50)]);
    seedSession(sm, "m5");
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        // Simulate a Stream2 message mutation landing during the first fetch.
        // markPageDirty is what the listener hook calls — the response gate
        // should discard this response and re-issue.
        markPageDirty("s1");
      }
      return makeResponse(pageResponse([item("m4", 40)], { oldest_id: "m4", has_older: true }));
    });
    await loadOlder("s1");
    expect(fetchCount).toBe(2); // first discarded (dirty), second merged
    expect(state.messages.s1?.order).toEqual(["m4", "m5"]);
    expect(state.messageWindows.s1?.oldestResidentID).toBe("m4");
  });

  it("abandon after MAX_PAGE_RETRIES: every response dirty → no merge, no stuck spinner", async () => {
    const sm = buildMessages([item("m5", 50)]);
    seedSession(sm, "m5");
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount++;
      markPageDirty("s1"); // every response is dirty — never converges
      return makeResponse(pageResponse([item("m4", 40)], { oldest_id: "m4", has_older: true }));
    });
    await loadOlder("s1");
    // MAX_PAGE_RETRIES = 3 → first attempt + 3 retries = 4 fetches, then abandon.
    expect(fetchCount).toBe(4);
    // No merge happened (every response was discarded).
    expect(state.messages.s1?.order).toEqual(["m5"]);
    // loadingOlder cleared (no stuck spinner).
    expect(state.messageWindows.s1?.loadingOlder).toBeFalsy();
    // pageInFlight cleared so the user can click Load older again.
    resetPageInFlight();
  });

  // ── Connection / server-restart discard (step 1 + step 2 of the response gate).
  // These pin the Stream2 connection-gen + epoch anti-clobber invariants.

  it("sesGen discard: connection replaced mid-flight → page dropped, no merge", async () => {
    const sm = buildMessages([item("m5", 50)]);
    seedSession(sm, "m5");
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount++;
      // Simulate the Stream2 connection being torn down + reopened while the
      // page fetch is in flight. closeSessionStream bumps sesGen, so the
      // response gate's step-1 check (flight.gen !== sesGen) fires → drop.
      closeSessionStream();
      return makeResponse(pageResponse([item("m4", 40)], { oldest_id: "m4", has_older: true }));
    });
    await loadOlder("s1");
    expect(fetchCount).toBe(1); // no retry — straight discard on gen mismatch
    expect(state.messages.s1?.order).toEqual(["m5"]); // no merge
    expect(state.messageWindows.s1?.loadingOlder).toBeFalsy();
  });

  it("epoch discard: server restart mid-flight (issue-time epoch) → page dropped", async () => {
    const sm = buildMessages([item("m5", 50)]);
    seedSession(sm, "m5");
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount++;
      // Simulate a server restart advancing state.epoch AFTER issue but BEFORE
      // response. The gate's step-2 check (flight.epoch !== state.epoch) fires.
      setState("epoch", "e2-restarted");
      return makeResponse(pageResponse([item("m4", 40)], { oldest_id: "m4", has_older: true }), 1, "e2-restarted");
    });
    await loadOlder("s1");
    expect(fetchCount).toBe(1);
    expect(state.messages.s1?.order).toEqual(["m5"]);
    expect(state.messageWindows.s1?.loadingOlder).toBeFalsy();
  });

  it("epoch discard: response X-VH-Epoch ≠ current epoch → page dropped", async () => {
    const sm = buildMessages([item("m5", 50)]);
    seedSession(sm, "m5");
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount++;
      // Server stamps an OLD epoch on the response (stale response from a
      // pre-restart aggregator instance). state.epoch has already advanced.
      return makeResponse(pageResponse([item("m4", 40)], { oldest_id: "m4", has_older: true }), 1, "e-stale");
    });
    // Advance the store epoch to simulate the restart landing BEFORE response.
    setState("epoch", "e1-current");
    await loadOlder("s1");
    expect(fetchCount).toBe(1);
    expect(state.messages.s1?.order).toEqual(["m5"]);
    expect(state.messageWindows.s1?.loadingOlder).toBeFalsy();
  });

  // ── Sticky hasOlder after eviction (T1-HASOLDER regression guard).
  // evictIfOverCap sets hasOlder=true so the Load-older button stays visible
  // for the evicted range; applyPageMerge must NOT overwrite that signal with
  // the server's has_older=false (which is the meta for the JUST-FETCHED page,
  // not for the evicted range).

  it("sticky-hasOlder: end-of-history page (has_older=false) + eviction → hasOlder stays true", async () => {
    // Seed near the count cap (499 resident) so a page merge triggers eviction.
    const near = buildMessages(buildItems("m", range(1, 500))); // m1..m499
    seedSession(near, "m1", true);
    const page = buildItems("o", range(-10, 0)); // o-10..o-1 (10 older msgs)
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      // Server reports has_older=false (the just-fetched page IS the oldest
      // range — there is nothing OLDER than it on the server). Eviction still
      // fires (resident count > cap), so hasOlder must stay true so the user
      // can re-fetch the evicted range.
      makeResponse(pageResponse(page, { oldest_id: "o-10", has_older: false })),
    );
    await loadOlder("s1");
    expect(state.messages.s1?.order.length).toBeLessThanOrEqual(MAX_RESIDENT_MESSAGES);
    // hasOlder MUST stay true despite the server's has_older=false — the
    // evicted messages are still on the server and re-fetchable.
    expect(state.messageWindows.s1?.hasOlder).toBe(true);
  });

  it("sticky-hasOlder: prior eviction signal preserved across a clean no-eviction merge", async () => {
    // Seed with evictedHistory=true from a PRIOR eviction (simulating a
    // previous load-older cycle that evicted). Then a no-eviction clean merge
    // with has_older=false arrives. The prior eviction signal must persist —
    // those evicted messages remain on the server and re-fetchable.
    const sm = buildMessages([item("m5", 50)]);
    setState("messages", "s1", sm);
    setState("messageWindows", "s1", { hasOlder: true, oldestResidentID: "m5", evictedHistory: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse(pageResponse([item("m4", 40)], { oldest_id: "m4", has_older: false })),
    );
    await loadOlder("s1");
    expect(state.messages.s1?.order).toEqual(["m4", "m5"]);
    // Prior eviction signal preserved.
    expect(state.messageWindows.s1?.hasOlder).toBe(true);
    expect(state.messageWindows.s1?.evictedHistory).toBe(true);
  });
});
