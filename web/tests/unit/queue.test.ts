// @vitest-environment jsdom
//
// Backend-authoritative per-session queue — FE module tests.
//
// The backend (pkg/web/queue.go) owns queue state, ordering, and durability
// keyed by (project, sessionId). This module (web/src/queue.ts) is a thin
// reactive CACHE plus the sole dispatcher. These tests pin the cache↔backend
// contract: enqueue preserves captured sendConfig and throws on non-2xx (no
// silent loss), fetchQueue is an authoritative refresh, claim marks the winner
// dispatching, resolve records a terminal outcome — `sent` is filtered from the
// visible queue (the message is now in the transcript, so the chip clears) while
// `failed`/`unknown` stay displayed until explicit dismissal — the legacy
// vh.queue.v1 map is migrated entry-by-entry and retired only on full success,
// and archive prunes the local cache (the backend deletes the file).
//
// Behaviors that live in the Go store + HTTP layer (single-winner claim,
// resolve-never-repends, terminal-survives-restart, malformed-file-is-error,
// CSRF-enforced, FIFO ordering) are covered by pkg/web/queue_test.go. These FE
// tests cover the cache/dispatch/migration contract the SPA relies on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueueCache,
  claimQueued,
  enqueue,
  fetchQueue,
  hasQueueState,
  migrateLegacyQueue,
  queueFor,
  queueMode,
  removeQueued,
  resolveQueued,
  setQueueMode,
} from "../../src/queue";
import { saveVersioned } from "../../src/lib/store";

// In-memory localStorage for the node test env (matches store.test.ts).
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

// Tracked sessions per-test so afterEach can reset the module-level cache
// (queue.ts owns a singleton store, like sync/store). Migration guard state
// (the module-level `migrated` Set) is avoided by using unique session IDs per
// test rather than resetting module state.
let touched: string[] = [];

function resetCache() {
  clearQueueCache(touched);
  touched = [];
}

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  touched = [];
});

afterEach(() => {
  resetCache();
  vi.unstubAllGlobals();
});

// Minimal Response-like shape the module reads (res.ok, res.status, res.json()).
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

// Backend-shaped item factory.
function item(id: string, opts: Partial<{
  order: number;
  state: string;
  text: string;
  sendConfig: any;
  detail: string;
  resolvedAt: number;
}> = {}): any {
  const state = opts.state ?? "pending";
  const out: any = {
    id,
    order: opts.order ?? 0,
    state,
    text: opts.text ?? "",
    attachments: [],
    createdAt: 1,
  };
  if (opts.sendConfig) out.sendConfig = opts.sendConfig;
  if (opts.detail) out.detail = opts.detail;
  // The backend stamps resolvedAt on terminal transitions; mirror that for
  // realistic resolve-response fixtures.
  if (opts.resolvedAt !== undefined) out.resolvedAt = opts.resolvedAt;
  else if (state === "sent" || state === "failed" || state === "unknown") out.resolvedAt = 1;
  return out;
}

describe("enqueue — backend issues id/order; sendConfig preserved", () => {
  it("POSTs the input and caches the returned item with its captured sendConfig", async () => {
    const sid = "s-enq-1";
    touched.push(sid);
    const cfg = { providerID: "anthropic", modelID: "claude-x", variant: "high", agent: "build" };
    let captured: any;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (url.endsWith(`/vh/session/${sid}/queue`) && init?.method === "POST") {
          captured = JSON.parse(init.body);
          return Promise.resolve(res(200, { item: item("q-1", { order: 1, text: captured.text, sendConfig: cfg }) }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );

    const got = await enqueue(sid, { text: "hello", attachments: [], sendConfig: cfg });
    expect(captured.text).toBe("hello");
    expect(captured.sendConfig).toEqual(cfg);
    expect(got.sendConfig).toEqual(cfg);
    expect(queueFor(sid)).toHaveLength(1);
    expect(queueFor(sid)[0].sendConfig).toEqual(cfg);
    // Backend owns ordering/id — the FE never assigns them.
    expect(got.id).toBe("q-1");
    expect(got.order).toBe(1);
  });

  it("throws on non-2xx so the caller preserves the composed text (no silent loss)", async () => {
    const sid = "s-enq-2";
    touched.push(sid);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(res(500, { error: "boom" }))),
    );
    await expect(enqueue(sid, { text: "keep me", attachments: [] })).rejects.toThrow();
    // Cache must NOT reflect a failed enqueue.
    expect(queueFor(sid)).toHaveLength(0);
  });

  it("throws on a 2xx with no item (ambiguous/lost import response) — prefer visible duplicate over silent loss", async () => {
    const sid = "s-enq-3";
    touched.push(sid);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(res(200, {}))),
    );
    await expect(enqueue(sid, { text: "x", attachments: [] })).rejects.toThrow();
    expect(queueFor(sid)).toHaveLength(0);
  });
});

describe("enqueue — bounded enqueue timeout (hung-POST send-loss guard)", () => {
  // N2: the existing enqueue tests cover non-2xx and 2xx-without-item but not an
  // aborted/timed-out enqueue. enqueue arms a 12s AbortController; if the POST
  // hangs, it must abort, throw "enqueue timed out", and NOT cache anything (no
  // silent duplicate state). Asserted with fake timers around the 12s boundary.
  it("aborts a hung POST after 12s, throws 'enqueue timed out', and caches nothing (no silent loss)", async () => {
    const sid = "s-enq-timeout";
    touched.push(sid);
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: any) =>
        // Mirror native fetch: never resolves on its own, and rejects with an
        // AbortError when the caller's signal aborts.
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      ),
    );

    vi.useFakeTimers();
    try {
      const p = enqueue(sid, { text: "stuck on the wire", attachments: [] });
      // Attach a no-op handler up front so the rejection (which fires inside
      // advanceTimersByTimeAsync below) is never flagged as unhandled before the
      // assertion consumes it.
      p.catch(() => {});
      // Before the 12s timeout: the enqueue is still pending (no premature abort).
      await vi.advanceTimersByTimeAsync(11999);
      // At 12000ms: the AbortController fires, fetch rejects, enqueue throws.
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).rejects.toThrow("enqueue timed out");
      // Nothing was confirmed durable: the cache stays empty.
      expect(queueFor(sid)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fetchQueue — authoritative refresh (open/focus/reconnect)", () => {
  it("replaces the cache for a session with the backend list", async () => {
    const sid = "s-fetch-1";
    touched.push(sid);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        if (url.endsWith(`/vh/session/${sid}/queue`)) {
          return Promise.resolve(res(200, { items: [item("a", { order: 1 }), item("b", { order: 2 })] }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    await fetchQueue(sid);
    expect(queueFor(sid).map((m) => m.id)).toEqual(["a", "b"]);
    // A second refresh REPLACES rather than appends.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(res(200, { items: [item("c", { order: 3 })] })),
      ),
    );
    await fetchQueue(sid);
    expect(queueFor(sid).map((m) => m.id)).toEqual(["c"]);
  });

  it("leaves the existing cache untouched on a non-ok response (keep stale)", async () => {
    const sid = "s-fetch-2";
    touched.push(sid);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("a")] }))));
    await fetchQueue(sid);
    expect(queueFor(sid)).toHaveLength(1);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(500, {}))));
    await fetchQueue(sid);
    expect(queueFor(sid)).toHaveLength(1); // stale retained
  });
});

describe("claimQueued — single-winner dispatch boundary", () => {
  it("marks the claimed item dispatching and returns it", async () => {
    const sid = "s-claim-1";
    touched.push(sid);
    const claimed = item("q-1", { order: 1, state: "dispatching", text: "first" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (url.endsWith(`/vh/session/${sid}/queue/claim`) && init?.method === "POST") {
          return Promise.resolve(res(200, { item: claimed }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    const got = await claimQueued(sid);
    expect(got).not.toBeNull();
    expect(got!.id).toBe("q-1");
    // Cache reflects dispatching state so a second FE effect won't re-dispatch.
    expect(queueFor(sid).find((m) => m.id === "q-1")?.state).toBe("dispatching");
  });

  it("returns null when nothing is pending (claim loser / empty queue)", async () => {
    const sid = "s-claim-2";
    touched.push(sid);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(res(200, { item: null }))),
    );
    const got = await claimQueued(sid);
    expect(got).toBeNull();
    // Nothing dispatched; the drain path must stop here.
    expect(queueFor(sid)).toHaveLength(0);
  });
});

describe("resolveQueued — terminal outcome; never repends; sent clears / failed+unknown stay", () => {
  it("records failed and keeps the item displayed with detail (no re-enqueue)", async () => {
    const sid = "s-res-1";
    touched.push(sid);
    // Seed cache with a dispatching item.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("q-1", { state: "dispatching" })] }))));
    await fetchQueue(sid);
    // Resolve failed (non-2xx dispatch).
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (url.endsWith(`/vh/session/${sid}/queue/q-1/resolve`)) {
          const body = JSON.parse(init.body);
          return Promise.resolve(
            res(200, { item: item("q-1", { state: body.state, detail: body.detail, order: 1 }) }),
          );
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    await resolveQueued(sid, "q-1", "failed", "500 upstream");
    const arr = queueFor(sid);
    expect(arr).toHaveLength(1); // NOT removed — terminal items persist
    expect(arr[0].state).toBe("failed");
    expect(arr[0].detail).toBe("500 upstream");
    expect(arr[0].resolvedAt).toBe(1);
  });

  it("records unknown for an ambiguous interruption (no repend)", async () => {
    const sid = "s-res-2";
    touched.push(sid);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("q-1", { state: "dispatching" })] }))));
    await fetchQueue(sid);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (url.endsWith(`/vh/session/${sid}/queue/q-1/resolve`)) {
          const body = JSON.parse(init.body);
          return Promise.resolve(res(200, { item: item("q-1", { state: body.state, detail: body.detail }) }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    await resolveQueued(sid, "q-1", "unknown", "network interrupted");
    const arr = queueFor(sid);
    expect(arr).toHaveLength(1);
    expect(arr[0].state).toBe("unknown");
    // Unknown is terminal: it does NOT return to pending in the cache.
    expect(arr[0].state).not.toBe("pending");
  });

  it("records sent (happy path): the chip clears — sent is filtered from the visible queue", async () => {
    const sid = "s-res-3";
    touched.push(sid);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("q-1", { state: "dispatching" })] }))));
    await fetchQueue(sid);
    let resolveHit = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith(`/vh/session/${sid}/queue/q-1/resolve`)) {
          resolveHit = true;
          return Promise.resolve(res(200, { item: item("q-1", { state: "sent" }) }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    await resolveQueued(sid, "q-1", "sent", "");
    // The resolve WRITE recorded the sent outcome...
    expect(resolveHit).toBe(true);
    // ...and the sent item is filtered from the visible queue (the message is
    // now in the transcript, so the chip clears).
    expect(queueFor(sid)).toHaveLength(0);
  });
});

// F1 regression: resolve-write failure must NOT strand the item in a misleading
// `dispatching` state. The dispatch already happened (prompt_async returned);
// only the resolve WRITE failed. The FE knows the terminal outcome, so it
// reflects it optimistically into the local cache, retries the resolve write a
// bounded number of times (safe: a record, NOT a re-dispatch), and reconciles
// on fetchQueue so a still-dispatching backend does not flip a known-terminal
// item back. Invariant: never re-dispatch (prompt_async called exactly once in
// the real flow — here resolveQueued must never touch a prompt_async URL at all).
describe("resolveQueued — resolve-write failure (F1: no misleading dispatching)", () => {
  it("on resolve-500 (all retries fail): local cache is terminal, not dispatching; resolve is retried; no prompt_async fetch", async () => {
    const sid = "s-f1-1";
    touched.push(sid);
    // Seed cache with a dispatching item (claim already happened).
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("q-1", { state: "dispatching" })] }))));
    await fetchQueue(sid);

    // resolve POST always returns 500. Record every fetched URL.
    const fetchMock = vi.fn((url: string) => {
      void url;
      return Promise.resolve(res(500, { error: "boom" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await resolveQueued(sid, "q-1", "sent", "dispatched-ok");

    // The dispatch SUCCEEDED (prompt_async returned) — only the resolve WRITE
    // failed. The sent item is filtered from the visible queue (the message is
    // in the transcript), so the chip clears; it is NOT stranded in a misleading
    // `dispatching`. The cache retains `sent` internally to drive reconcile.
    expect(queueFor(sid)).toHaveLength(0);

    // The resolve WRITE was retried (bounded): >1 attempt to bring backend to terminal.
    const resolveCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/resolve")).length;
    expect(resolveCalls).toBeGreaterThan(1);

    // No re-dispatch: resolveQueued must NEVER fetch a prompt_async URL.
    const dispatchCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/prompt_async") || String(c[0]).includes("/oc/")).length;
    expect(dispatchCalls).toBe(0);
  });

  it("reconcile-on-fetch: after resolve-500, a fetchQueue still reporting dispatching does NOT flip the item back", async () => {
    const sid = "s-f1-2";
    touched.push(sid);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("q-1", { state: "dispatching" })] }))));
    await fetchQueue(sid);

    // resolve write fails every time.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(500, {}))));
    await resolveQueued(sid, "q-1", "failed", "rejected");
    expect(queueFor(sid)[0].state).toBe("failed");

    // The next poll/open re-fetches; the backend item is STILL dispatching
    // (resolve never landed). The FE must NOT flip the known-terminal item back
    // to a misleading dispatching — it must keep showing the known outcome.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("q-1", { state: "dispatching" })] }))));
    await fetchQueue(sid);
    const after = queueFor(sid)[0];
    expect(after.state).toBe("failed"); // NOT dispatching
    expect(after.detail).toBe("rejected");

    // Once the backend catches up to terminal, the overlay is dropped (backend
    // is authoritative again) and the backend's terminal state is shown as-is.
    // (Uses `failed` — a RETAINED terminal — so "shown as-is" is observable;
    // `sent` would be filtered from the visible queue.)
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("q-1", { state: "failed", detail: "rejected" })] }))));
    await fetchQueue(sid);
    expect(queueFor(sid)[0].state).toBe("failed");
  });

  it("on resolve-500 then 200 (retry succeeds): local cache reflects the authoritative terminal echo", async () => {
    const sid = "s-f1-3";
    touched.push(sid);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("q-1", { state: "dispatching" })] }))));
    await fetchQueue(sid);

    // First resolve attempt 500, second attempt 200 with authoritative item.
    // Uses `failed` (a RETAINED terminal) so the echoed resolvedAt is observable
    // in the visible queue; a `sent` echo would be filtered from the view.
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/resolve")) {
          attempt++;
          if (attempt === 1) return Promise.resolve(res(500, {}));
          return Promise.resolve(res(200, { item: item("q-1", { state: "failed", order: 1, resolvedAt: 42 }) }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );

    await resolveQueued(sid, "q-1", "failed", "boom");
    const after = queueFor(sid)[0];
    expect(after.state).toBe("failed");
    // Authoritative resolvedAt from the server echo once the write landed.
    expect(after.resolvedAt).toBe(42);
  });
});

describe("removeQueued — pending + terminal dismissal (not dispatching)", () => {
  it("removes the item from the cache on a successful DELETE", async () => {
    const sid = "s-rm-1";
    touched.push(sid);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("a"), item("b")] }))));
    await fetchQueue(sid);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (url.endsWith(`/vh/session/${sid}/queue/a`) && init?.method === "DELETE") {
          return Promise.resolve(res(200, { ok: true }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    await removeQueued(sid, "a");
    expect(queueFor(sid).map((m) => m.id)).toEqual(["b"]);
  });

  it("404 is a no-op (already gone)", async () => {
    const sid = "s-rm-2";
    touched.push(sid);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("a")] }))));
    await fetchQueue(sid);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (url.endsWith(`/vh/session/${sid}/queue/zzz`) && init?.method === "DELETE") {
          return Promise.resolve(res(404, {}));
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    await removeQueued(sid, "zzz");
    expect(queueFor(sid).map((m) => m.id)).toEqual(["a"]); // unchanged
  });

  it("409 (dispatching, still in flight) triggers an authoritative refresh", async () => {
    const sid = "s-rm-3";
    touched.push(sid);
    // First populate with a pending item.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("a")] }))));
    await fetchQueue(sid);
    // DELETE returns 409, then the refresh returns the item as dispatching.
    let deleteHit = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (url.endsWith(`/vh/session/${sid}/queue/a`) && init?.method === "DELETE") {
          deleteHit = true;
          return Promise.resolve(res(409, { error: "not removable" }));
        }
        if (url.endsWith(`/vh/session/${sid}/queue`) && !init?.method) {
          return Promise.resolve(res(200, { items: [item("a", { state: "dispatching" })] }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    await removeQueued(sid, "a");
    expect(deleteHit).toBe(true);
    // Cache now reflects the backend truth (dispatching), not the stale pending.
    expect(queueFor(sid)[0].state).toBe("dispatching");
  });
});

describe("clearQueueCache + hasQueueState — archive follows server cleanup", () => {
  it("prunes cache entries (archive deletes the file server-side; this is local only)", async () => {
    const sid = "s-arc-1";
    touched.push(sid);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res(200, { items: [item("a"), item("b")] }))));
    await fetchQueue(sid);
    expect(hasQueueState(sid)).toBe(true);
    clearQueueCache([sid]);
    expect(hasQueueState(sid)).toBe(false);
    expect(queueFor(sid)).toHaveLength(0);
  });

  it("hasQueueState is false for a session with no cache", () => {
    expect(hasQueueState("never-seen")).toBe(false);
  });
});

describe("queueMode toggle (unchanged local preference)", () => {
  it("defaults on and round-trips through setQueueMode", () => {
    // queueMode is a module singleton loaded once at import; just assert it's a
    // boolean signal and setQueueMode flips it (the value persists via
    // saveVersioned under vh.prefs.queueMode.v1).
    expect(typeof queueMode()).toBe("boolean");
    const before = queueMode();
    setQueueMode(!before);
    expect(queueMode()).toBe(!before);
    // Restore to keep other tests deterministic.
    setQueueMode(before);
    // The preference is stored in the versioned envelope.
    expect(mem["vh.prefs.queueMode.v1"]).toBeDefined();
  });

  it("persisted preference is honored on reload shape (versioned envelope)", () => {
    // saveVersioned writes {v, data}; the module reads it back via loadVersioned.
    saveVersioned("vh.prefs.queueMode.v1", 1, false);
    expect(JSON.parse(mem["vh.prefs.queueMode.v1"])).toEqual({ v: 1, data: false });
  });
});

describe("migrateLegacyQueue — vh.queue.v1 → backend", () => {
  // Helper: seed the legacy map for one session.
  function seedLegacy(sid: string, entries: any[]) {
    saveVersioned("vh.queue.v1", 1, { [sid]: entries });
  }
  function legacyMap(): any {
    const raw = mem["vh.queue.v1"];
    if (!raw) return {};
    try {
      const p = JSON.parse(raw);
      return p && typeof p === "object" && p.data ? p.data : {};
    } catch {
      return {};
    }
  }

  it("imports entries sequentially and removes only confirmed ones; retires the key on full success", async () => {
    const sid = "s-mig-1";
    touched.push(sid);
    seedLegacy(sid, [
      { id: "old-1", text: "first", attachments: [] },
      { id: "old-2", text: "second", attachments: [] },
    ]);
    const enqueued: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (url.endsWith(`/vh/session/${sid}/queue`) && init?.method === "POST") {
          const body = JSON.parse(init.body);
          enqueued.push(body.text);
          return Promise.resolve(res(200, { item: item(`new-${enqueued.length}`, { order: enqueued.length, text: body.text }) }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    const ok = await migrateLegacyQueue(sid);
    expect(ok).toBe(true);
    expect(enqueued).toEqual(["first", "second"]);
    // Both legacy entries removed; vh.queue.v1 retired entirely.
    expect(legacyMap()[sid]).toBeUndefined();
    expect(mem["vh.queue.v1"]).toBeUndefined();
  });

  it("stops and retains the un-migrated entry on a mid-migration failure (visible dup > silent loss)", async () => {
    const sid = "s-mig-2";
    touched.push(sid);
    seedLegacy(sid, [
      { id: "old-1", text: "ok", attachments: [] },
      { id: "old-2", text: "boom", attachments: [] },
      { id: "old-3", text: "never", attachments: [] },
    ]);
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (url.endsWith(`/vh/session/${sid}/queue`) && init?.method === "POST") {
          n++;
          if (n === 2) return Promise.resolve(res(500, {})); // second import fails
          const body = JSON.parse(init.body);
          return Promise.resolve(res(200, { item: item(`new-${n}`, { text: body.text }) }));
        }
        return Promise.resolve(res(404, {}));
      }),
    );
    const ok = await migrateLegacyQueue(sid);
    expect(ok).toBe(false);
    const remaining = legacyMap()[sid] || [];
    // The first confirmed entry is gone; the failed one and the unseen one remain.
    expect(remaining.map((m: any) => m.id)).toEqual(["old-2", "old-3"]);
    // vh.queue.v1 still present (not retired).
    expect(mem["vh.queue.v1"]).toBeDefined();
  });

  it("is a no-op returning true when there is nothing to migrate", async () => {
    const sid = "s-mig-3";
    touched.push(sid);
    const f = vi.fn(() => Promise.resolve(res(200, {})));
    vi.stubGlobal("fetch", f);
    const ok = await migrateLegacyQueue(sid);
    expect(ok).toBe(true);
    // No enqueue attempt made.
    expect(f).not.toHaveBeenCalled();
  });

  it("treats an ambiguous response (2xx, no item) as a failure and retains the entry", async () => {
    const sid = "s-mig-4";
    touched.push(sid);
    seedLegacy(sid, [{ id: "old-1", text: "ambig", attachments: [] }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(res(200, {}))),
    );
    const ok = await migrateLegacyQueue(sid);
    expect(ok).toBe(false);
    expect(legacyMap()[sid].map((m: any) => m.id)).toEqual(["old-1"]);
    expect(mem["vh.queue.v1"]).toBeDefined();
  });
});
