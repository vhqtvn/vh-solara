// @vitest-environment jsdom
//
// Stuck-send guard recovery — regression tests for the "pressing send does
// nothing; only killing the PWA / reloading recovers" bug class.
//
// ROOT CLASS: every send-path guard (the per-session `isSending` map, the
// per-key send single-flight behind the Send button's glow, and the drainer's
// `draining` flag) is released in a `finally` — but a `finally` only runs when
// the awaited promise SETTLES. Four fetches inside guard-held regions had NO
// timeout and NO AbortSignal, so a hung socket (transport drop mid-send,
// half-open TCP, backgrounded PWA) kept the await pending forever:
//
//   1. claimQueued   (queue.ts)          — hung → `draining` stuck true → the
//                                          queue never dispatches again.
//   2. resolveQueued (queue.ts)          — hung → drainer finally unreachable
//                                          → isSending(id) stuck TRUE → Send
//                                          button disabled forever, no error.
//   3. createSession (sync/actions.ts)   — hung → runSendSingleFlight("draft")
//                                          never settles → Send button pulses
//                                          (the glow) forever + disabled.
//   4. uploadFile    (createAttachments) — hung → admission never settles →
//                                          same stuck glow on attachment sends.
//
// enqueue already carried the armed-fetch fix (12s AbortController, queue.ts
// ENQUEUE_TIMEOUT_MS, tested in queue.test.ts); slice 3 closed its remaining
// body-read gap (see the D-F2 describe block below). These tests pin the
// same bounded-settles contract for every guard-held site, using the same
// fake-timer + abort-rejecting-fetch harness as the enqueue-timeout test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimQueued, resolveQueued, clearQueueCache, enqueue, queueFor } from "../../src/queue";
import { createQueueDrainer, type DrainDeps } from "../../src/queueDrain";
import type { QueuedMessage } from "../../src/queue";
import { createSession } from "../../src/sync/actions";
import { createRoot } from "solid-js";
import { createAttachments, type Attachments } from "../../src/components/chat/createAttachments";

// In-memory localStorage for the jsdom test env (matches queue.test.ts).
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const k of Object.keys(mem)) delete mem[k];
});

// A fetch that NEVER settles on its own and rejects with AbortError when the
// caller's signal aborts — the native hung-socket shape (same as queue.test.ts).
function hungFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: any) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    }),
  ) as any;
}

// Sentinel-settled probe: red is a deterministic ASSERTION failure (never a
// vitest timeout) — after advancing `ms` of fake time the promise must have
// settled. On pre-fix code the promise stays pending forever → settled=false.
async function assertSettles(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

// Generous fake-time budget: far past every plausible bound (12s claim/upload/
// create, 3×5s resolve attempts) so the assertion tests "settles at all", not
// an exact boundary (the exact 12s enqueue boundary is already pinned in
// queue.test.ts).
const FAR_PAST_EVERY_BOUND_MS = 60_000;

describe("stuck-send guard recovery — hung transport inside guard-held regions", () => {
  it("claimQueued settles (null) when the claim POST hangs, so the drainer is not wedged", async () => {
    const sid = "s-stuck-claim";
    vi.stubGlobal("fetch", hungFetch());
    vi.useFakeTimers();
    try {
      const p = claimQueued(sid);
      p.catch(() => {});
      const settled = await assertSettles(p, FAR_PAST_EVERY_BOUND_MS);
      // Pre-fix: the fetch has no signal/timeout → p never settles → RED.
      expect(settled).toBe(true);
      // And it must settle to the drain-stops contract value: null (no claim).
      await expect(p).resolves.toBeNull();
    } finally {
      clearQueueCache([sid]);
    }
  });

  it("a drain whose resolve WRITE hangs still settles and releases the sending guard (isSending not stuck true)", async () => {
    const sid = "s-stuck-resolve";
    const item: QueuedMessage = {
      id: "q-1",
      order: 1,
      state: "dispatching",
      text: "sent fine, resolve write hung",
      attachments: [],
      createdAt: 1,
    };
    // Only the resolve WRITE hangs — everything upstream succeeded, which is
    // exactly the no-error-no-feedback shape the operator reported.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: any) => {
        if (String(url).includes("/resolve")) {
          return hungFetch()(url, init);
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as any);
      }),
    );
    const sending: Record<string, boolean> = {};
    const deps: DrainDeps = {
      canDrain: () => true,
      getId: () => sid,
      claim: async () => item,
      dispatch: async () => ({ state: "sent", detail: "" }),
      resolve: (id, itemId, state, detail) => resolveQueued(id, itemId, state, detail),
      setSending: (id, v) => {
        sending[id] = v;
      },
      isSending: (id) => !!sending[id],
    };
    const drainer = createQueueDrainer(deps);

    vi.useFakeTimers();
    try {
      const p = drainer.drain();
      p.catch(() => {});
      const settled = await assertSettles(p, FAR_PAST_EVERY_BOUND_MS);
      // Pre-fix: resolveWithRetry's fetch has no signal → never settles → the
      // drainer's finally never runs → isSending stuck true → RED on both.
      expect(settled).toBe(true);
      expect(sending[sid]).toBe(false);
    } finally {
      clearQueueCache([sid]);
    }
  });

  it("createSession settles (null) when POST /oc/session hangs, so the draft send guard (the glow) releases", async () => {
    vi.stubGlobal("fetch", hungFetch());
    vi.useFakeTimers();
    const p = createSession();
    p.catch(() => {});
    // Pre-fix: no signal/timeout → runSendSingleFlight("draft") holds forever
    // → the draft Send button pulses + stays disabled until reload → RED.
    const settled = await assertSettles(p, FAR_PAST_EVERY_BOUND_MS);
    expect(settled).toBe(true);
    await expect(p).resolves.toBeNull();
  });

  it("uploadFile settles (null) when POST /vh/attach hangs, so admission (and the glow) releases", async () => {
    vi.stubGlobal("fetch", hungFetch());
    let att: Attachments | null = null;
    createRoot((dispose) => {
      att = createAttachments({
        input: () => "",
        setInput: () => {},
        textarea: () => undefined,
        sessionId: () => "s1",
        draft: () => false,
        fileInput: () => undefined,
        inlineActive: () => false,
        syncCaret: () => {},
      });
      // Keep the root alive for the test's duration; jsdom teardown cleans up.
      void dispose;
    })!;
    vi.useFakeTimers();
    const p = att!.uploadFile(new File(["z"], "x.png", { type: "image/png" }), "s1");
    p.catch(() => {});
    // Pre-fix: no signal/timeout → flushPendingAttachments/resolveInline
    // never settle → sendInFlight stuck true → RED.
    const settled = await assertSettles(p, FAR_PAST_EVERY_BOUND_MS);
    expect(settled).toBe(true);
    await expect(p).resolves.toBeNull();
  });
});

// Send-reliability slice 2 — the commit-review D-F2 follow-ups: the sites
// that read the response body AFTER the timer was cleared. Headers arriving
// with a stalled body used to wedge the guard past the abort (the fetch
// promise had already resolved, so the AbortController no longer covered the
// body read). All sites now read INSIDE the armed window: the aborting signal
// tears down the body reader too, the read rejects AbortError, and the site
// settles to its no-custody contract value. Slice 3 added enqueue (the third
// site — both its error-path code probe and its success payload read).
describe("stuck-send guard recovery — headers-arrived, body-stalled (D-F2)", () => {
  // A fetch whose PROMISE resolves immediately (headers arrived, res.ok) but
  // whose json() never settles on its own — it rejects AbortError only when
  // the caller's signal aborts (the native reader-teardown shape).
  function bodyHangsFetch(): ReturnType<typeof vi.fn> {
    return vi.fn((_url: string, init?: any) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_r, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
        text: () => Promise.resolve(""),
      }),
    ) as any;
  }

  it("claimQueued settles (null) when headers arrive but the body stalls — the guard still releases", async () => {
    const sid = "s-stuck-claim-body";
    vi.stubGlobal("fetch", bodyHangsFetch());
    vi.useFakeTimers();
    try {
      const p = claimQueued(sid);
      p.catch(() => {});
      // Pre-fix (D-F2): the fetch resolved, the finally cleared the timer,
      // and the body read ran UNARMED — a stalled body wedged the drainer's
      // `draining` flag forever → RED here.
      const settled = await assertSettles(p, FAR_PAST_EVERY_BOUND_MS);
      expect(settled).toBe(true);
      await expect(p).resolves.toBeNull();
    } finally {
      clearQueueCache([sid]);
    }
  });

  it("uploadFile settles (null) when headers arrive but the body stalls — admission still releases", async () => {
    vi.stubGlobal("fetch", bodyHangsFetch());
    let att: Attachments | null = null;
    createRoot((dispose) => {
      att = createAttachments({
        input: () => "",
        setInput: () => {},
        textarea: () => undefined,
        sessionId: () => "s1",
        draft: () => false,
        fileInput: () => undefined,
        inlineActive: () => false,
        syncCaret: () => {},
      });
      void dispose;
    })!;
    vi.useFakeTimers();
    const p = att!.uploadFile(new File(["z"], "x.png", { type: "image/png" }), "s1");
    p.catch(() => {});
    // Pre-fix (D-F2): res.json() ran after clearTimeout — a stalled body held
    // the admission guard open indefinitely → RED here.
    const settled = await assertSettles(p, FAR_PAST_EVERY_BOUND_MS);
    expect(settled).toBe(true);
    await expect(p).resolves.toBeNull();
  });

  // Send-reliability slice 3 — the THIRD body-hang site (T1C-F1 / T1D-F2,
  // escalates to BLOCK at closeout): enqueue() read BOTH bodies (the error-path
  // code probe AND the success payload) AFTER clearTimeout — the D-F2 hang
  // class on the most load-bearing path (admission). Both reads now run inside
  // the armed window (mirroring claimQueued/uploadFile); a stalled body
  // settles enqueue to a TYPED error so the admission guard always releases.
  it("enqueue settles to a typed outcome-unknown error when headers arrive but the body stalls — admission still releases", async () => {
    const sid = "s-stuck-enqueue-body";
    vi.stubGlobal("fetch", bodyHangsFetch());
    vi.useFakeTimers();
    try {
      const p = enqueue(sid, { text: "stuck admission", attachments: [] });
      p.catch(() => {});
      // Pre-fix: readJSON ran after clearTimeout → a stalled success body
      // wedged the admission (single-flight) forever → RED here.
      const settled = await assertSettles(p, FAR_PAST_EVERY_BOUND_MS);
      expect(settled).toBe(true);
      // The honest classification for a body-stall abort is timeout (the
      // admission outcome is UNKNOWN — the POST may have been admitted), never
      // a parse "ambiguous": the signal fired, the reader was torn down.
      await expect(p).rejects.toMatchObject({ name: "EnqueueError", code: "timeout" });
      // Nothing was confirmed durable: the cache stays empty.
      expect(queueFor(sid)).toHaveLength(0);
    } finally {
      clearQueueCache([sid]);
    }
  });

  it("enqueue settles to a typed DEFINITIVE error when an error response's headers arrive but its body stalls", async () => {
    // The status line alone proves non-admission (the local worker server
    // answered 500); the body only refines the code. A stalled error body must
    // still settle enqueue to the plain-status typed error — never wedge.
    const sid = "s-stuck-enqueue-err-body";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: any) =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () =>
            new Promise((_r, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        }),
      ) as any,
    );
    vi.useFakeTimers();
    try {
      const p = enqueue(sid, { text: "stuck error body", attachments: [] });
      p.catch(() => {});
      const settled = await assertSettles(p, FAR_PAST_EVERY_BOUND_MS);
      expect(settled).toBe(true);
      await expect(p).rejects.toMatchObject({ name: "EnqueueError", code: "unknown", status: 500 });
      expect(queueFor(sid)).toHaveLength(0);
    } finally {
      clearQueueCache([sid]);
    }
  });
});
