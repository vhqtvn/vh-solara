// @vitest-environment jsdom
//
// Drain lifecycle state-machine tests for web/src/queueDrain.ts.
//
// This is the regression guard for the setSending-leak bug (B1): drainQueue's
// finally had to release the per-session sending guard or isSending(id) stayed
// true after the first drain and items 2..N stalled in pending until a page
// reload (FIFO-breaking). The drain logic was extracted from ChatView.tsx into
// createQueueDrainer precisely so this state machine can be exercised without a
// component/reactive harness.
//
// Assertions required by the slice:
//   (1) after draining a pending item, isSending(id) is false.
//   (2) queueing 3 items while busy results in all 3 reaching a terminal state
//       (not just the first) — i.e. multi-item FIFO advances.
//
// The fake backend mirrors pkg/web/queue.go semantics: claim atomically moves
// the oldest pending item to dispatching (one winner), resolve records a
// terminal outcome that never repends, and dispatch (the /oc/session/:id/prompt_async
// POST) is mocked to classify the outcome.
import { describe, expect, it, vi } from "vitest";
import { createQueueDrainer, type DrainDeps } from "../../src/queueDrain";
import type { QueuedMessage } from "../../src/queue";

// A minimal in-memory queue that mirrors the backend lifecycle transitions
// (pending → dispatching → {sent | failed | unknown}) so the drainer's injected
// claim/resolve callbacks behave like the real /vh/session/:id/queue endpoints.
type State = QueuedMessage["state"];
interface FakeStore {
  items: QueuedMessage[];
}

function fakeStore(seed: string[]): FakeStore {
  return {
    items: seed.map((text, i) => ({
      id: `q-${i + 1}`,
      order: i + 1,
      state: "pending" as State,
      text,
      attachments: [],
      createdAt: 1,
    })),
  };
}

// Builds DrainDeps wired to a fake store + a per-session sending map. dispatch
// is injectable so a test can simulate sent/failed/unknown per item.
function makeDeps(
  store: FakeStore,
  opts: Partial<{
    sessionId: string;
    canDrain: () => boolean;
    dispatchOutcome: (item: QueuedMessage) => { state: "sent" | "failed" | "unknown"; detail: string };
    onResolved: (id: string) => void;
  }> = {},
): { deps: DrainDeps; sending: Record<string, boolean>; claims: number; dispatches: string[]; resolves: string[] } {
  const sid = opts.sessionId ?? "s-drain";
  const sending: Record<string, boolean> = {};
  let claims = 0;
  const dispatches: string[] = [];
  const resolves: string[] = [];
  const dispatchOutcome =
    opts.dispatchOutcome ?? (() => ({ state: "sent" as const, detail: "" }));

  const deps: DrainDeps = {
    canDrain: opts.canDrain ?? (() => true),
    getId: () => sid,
    // Claim the oldest pending item; mark it dispatching (single-winner).
    claim: async (id) => {
      void id;
      const it = store.items.find((m) => m.state === "pending");
      if (!it) return null;
      it.state = "dispatching";
      claims++;
      return { ...it };
    },
    // POST prompt_async — classify the outcome without throwing.
    dispatch: async (id, item) => {
      void id;
      dispatches.push(item.id);
      return dispatchOutcome(item);
    },
    // Record the terminal outcome on the store item (never repend).
    resolve: async (id, itemId, state, detail) => {
      void id;
      const it = store.items.find((m) => m.id === itemId);
      if (it) {
        it.state = state;
        it.detail = detail;
        it.resolvedAt = 2;
      }
      resolves.push(itemId);
      opts.onResolved?.(id);
    },
    setSending: (id, v) => {
      sending[id] = v;
    },
    isSending: (id) => !!sending[id],
  };
  return { deps, sending, get claims() { return claims; }, dispatches, resolves };
}

describe("createQueueDrainer — setSending guard lifecycle (B1 regression)", () => {
  it("releases the sending guard after a successful drain so isSending(id) is false", async () => {
    const store = fakeStore(["only"]);
    const { deps, sending } = makeDeps(store);
    const drainer = createQueueDrainer(deps);

    await drainer.drain();

    // The one pending item reached a terminal state.
    expect(store.items[0].state).toBe("sent");
    // B1 regression guard: the sending guard MUST be released in finally.
    // Without the setSending(id, false), this stays true and the next drain
    // early-returns at the isSending(id) guard → items stall in pending.
    expect(sending["s-drain"]).toBe(false);
  });

  it("releases the sending guard even when dispatch fails (definitive rejection)", async () => {
    const store = fakeStore(["boom"]);
    const { deps, sending } = makeDeps(store, {
      dispatchOutcome: () => ({ state: "failed", detail: "500 upstream" }),
    });
    const drainer = createQueueDrainer(deps);

    await drainer.drain();

    expect(store.items[0].state).toBe("failed");
    expect(store.items[0].detail).toBe("500 upstream");
    // Failed dispatch still must release the guard (finally runs unconditionally).
    expect(sending["s-drain"]).toBe(false);
  });

  it("releases the sending guard even when nothing is pending (claim returns null)", async () => {
    const store = fakeStore([]);
    const { deps, sending } = makeDeps(store);
    const drainer = createQueueDrainer(deps);

    await drainer.drain();

    // Nothing claimed → nothing dispatched. The sending guard was never set
    // true (setSending(true) is after the claim), but the finally still calls
    // setSending(false) — which is an observable no-op (isSending stays false).
    expect(sending["s-drain"]).toBeFalsy();
  });

  it("does NOT set the sending guard before a successful claim (no leak on claim-loser path)", async () => {
    const store = fakeStore([]);
    const { deps, sending } = makeDeps(store);
    const drainer = createQueueDrainer(deps);

    await drainer.drain();
    // setSending(true) must only run AFTER claim wins. On the null-claim path it
    // was never set true; the finally's setSending(false) is a harmless no-op.
    expect(sending["s-drain"]).not.toBe(true);
  });
});

describe("createQueueDrainer — multi-item FIFO advances (B1 FIFO-breaking regression)", () => {
  it("drains all 3 queued items to a terminal state, not just the first", async () => {
    const store = fakeStore(["first", "second", "third"]);
    const { deps, sending, dispatches } = makeDeps(store);
    const drainer = createQueueDrainer(deps);

    // Each drain() handles ONE item (claim → dispatch → resolve), mirroring the
    // real createEffect which re-fires on the reactive pending-count change. The
    // B1 bug: after the first drain left isSending(id) true, the second drain()
    // early-returned at the isSending guard and items 2..N stalled in pending.
    for (let i = 0; i < 3; i++) {
      await drainer.drain();
      // After EVERY drain the guard must be clear so the next can proceed.
      expect(sending["s-drain"]).toBe(false);
    }

    // All three reached a terminal state in FIFO order.
    expect(store.items.map((m) => m.state)).toEqual(["sent", "sent", "sent"]);
    expect(dispatches).toEqual(["q-1", "q-2", "q-3"]);
    // A fourth drain finds nothing pending (claim returns null).
    await drainer.drain();
    expect(dispatches).toHaveLength(3);
  });

  it("advances FIFO even when a mid-queue item fails (failed is terminal, never repends)", async () => {
    const store = fakeStore(["ok-1", "bad", "ok-2"]);
    const { deps, sending } = makeDeps(store, {
      dispatchOutcome: (item) =>
        item.text === "bad"
          ? { state: "failed", detail: "rejected" }
          : { state: "sent", detail: "" },
    });
    const drainer = createQueueDrainer(deps);

    for (let i = 0; i < 3; i++) {
      await drainer.drain();
      expect(sending["s-drain"]).toBe(false);
    }

    expect(store.items.map((m) => m.state)).toEqual(["sent", "failed", "sent"]);
    expect(store.items.map((m) => m.text)).toEqual(["ok-1", "bad", "ok-2"]);
  });

  it("respects the canDrain guard (busy session does not drain)", async () => {
    const store = fakeStore(["pending"]);
    const { deps } = makeDeps(store, { canDrain: () => false });
    const drainer = createQueueDrainer(deps);

    await drainer.drain();
    // Guarded out before claim: item stays pending.
    expect(store.items[0].state).toBe("pending");
  });

  it("is single-flight: a concurrent drain while one is in progress is a no-op", async () => {
    const store = fakeStore(["only"]);
    let releaseDispatch: () => void = () => {};
    const { deps, dispatches } = makeDeps(store, {
      dispatchOutcome: () =>
        new Promise((resolve) => {
          // Hold dispatch open until the test releases it.
          releaseDispatch = () => resolve({ state: "sent", detail: "" });
        }) as Promise<{ state: "sent"; detail: "" }>,
    });
    const drainer = createQueueDrainer(deps);

    expect(drainer.isDraining()).toBe(false);
    const inFlight = drainer.drain();
    expect(drainer.isDraining()).toBe(true);
    // A second concurrent drain must be a no-op (single-flight via `draining`).
    await drainer.drain();
    expect(dispatches).toHaveLength(1);
    releaseDispatch();
    await inFlight;
    expect(drainer.isDraining()).toBe(false);
    expect(dispatches).toHaveLength(1);
  });

  it("invokes onResolved after a successful drain (cache refresh hook)", async () => {
    const store = fakeStore(["only"]);
    const resolved: string[] = [];
    const { deps } = makeDeps(store, { onResolved: (id) => resolved.push(id) });
    const drainer = createQueueDrainer(deps);

    await drainer.drain();
    expect(resolved).toEqual(["s-drain"]);
    // onResolved NOT invoked on the null-claim path.
    resolved.length = 0;
    await drainer.drain();
    expect(resolved).toEqual([]);
  });
});

// F1 no-re-dispatch invariant: the dispatch already happened (prompt_async was
// called). If the resolve WRITE then fails, the drainer MUST NOT compensate by
// re-dispatching — that would double-send to OpenCode. The real resolveQueued
// (queue.ts) swallows the write failure and still applies the outcome; here we
// prove the DRAINER itself never re-dispatches regardless of how resolve
// behaves (fails silently, or even throws). Dispatch is single-flight + claims
// only pending, so a claimed (dispatching) item is never re-claimed.
describe("createQueueDrainer — no re-dispatch when resolve write fails (F1 invariant)", () => {
  it("dispatches exactly once when resolve fails silently (old pre-fix shape); guard released; no re-dispatch", async () => {
    const store = fakeStore(["only"]);
    const dispatches: string[] = [];
    const sending: Record<string, boolean> = {};
    let resolveCalls = 0;
    const deps: DrainDeps = {
      canDrain: () => true,
      getId: () => "s-f1-silent",
      claim: async (id) => {
        void id;
        const it = store.items.find((m) => m.state === "pending");
        if (!it) return null;
        it.state = "dispatching";
        return { ...it };
      },
      dispatch: async (id, item) => {
        void id;
        dispatches.push(item.id);
        return { state: "sent", detail: "" };
      },
      // Simulate the resolve WRITE failing: the OLD resolveQueued did
      // `if (!res.ok) return` — it returned WITHOUT recording the outcome, so
      // the store item stayed dispatching. The drainer must not re-dispatch.
      resolve: async (id, itemId) => {
        void id;
        void itemId;
        resolveCalls++;
      },
      setSending: (id, v) => {
        sending[id] = v;
      },
      isSending: (id) => !!sending[id],
    };
    const drainer = createQueueDrainer(deps);

    await drainer.drain();
    // The dispatch happened exactly once (one prompt_async for the one item).
    expect(dispatches).toEqual(["q-1"]);
    expect(resolveCalls).toBe(1);
    // Guard released even though the resolve "failed" to record the outcome.
    expect(sending["s-f1-silent"]).toBe(false);

    // Subsequent drains find the item dispatching (claimed), not pending — so
    // claim returns null and there is NO second dispatch (no double-send).
    await drainer.drain();
    await drainer.drain();
    expect(dispatches).toEqual(["q-1"]); // still exactly one
  });

  it("dispatches exactly once even if resolve THROWS; finally still releases the guard", async () => {
    const store = fakeStore(["only"]);
    const dispatches: string[] = [];
    const sending: Record<string, boolean> = {};
    const deps: DrainDeps = {
      canDrain: () => true,
      getId: () => "s-f1-throw",
      claim: async (id) => {
        void id;
        const it = store.items.find((m) => m.state === "pending");
        if (!it) return null;
        it.state = "dispatching";
        return { ...it };
      },
      dispatch: async (id, item) => {
        void id;
        dispatches.push(item.id);
        return { state: "sent", detail: "" };
      },
      // Worst case: resolve throws. The drainer's finally must still release the
      // sending guard, and the rejection must not trigger a re-dispatch.
      resolve: async () => {
        throw new Error("resolve 500");
      },
      setSending: (id, v) => {
        sending[id] = v;
      },
      isSending: (id) => !!sending[id],
    };
    const drainer = createQueueDrainer(deps);

    await expect(drainer.drain()).rejects.toThrow("resolve 500");
    expect(dispatches).toEqual(["q-1"]); // dispatched exactly once
    // finally released the guard despite the throw.
    expect(sending["s-f1-throw"]).toBe(false);

    // A later drain (item is dispatching) does NOT re-dispatch.
    await drainer.drain();
    expect(dispatches).toEqual(["q-1"]);
  });
});

// Bounded dispatch timeout: a hung socket (prompt_async never responds) MUST NOT
// hold a dispatching item forever. The drainer arms an AbortController that
// fires after dispatchTimeoutMs; the dispatch implementation MUST classify the
// resulting abort as "unknown" (the POST may have reached OpenCode — never
// repend, never auto-retry). The item then resolves to a PERSISTENT visible
// `unknown` state with the text + attachment metadata retained, and the sending
// guard releases so the next pending item can advance (FIFO).
describe("createQueueDrainer — bounded dispatch timeout (hung-socket send-loss guard)", () => {
  it("aborts a hung dispatch after dispatchTimeoutMs and classifies unknown; guard released; signal observed aborted", async () => {
    const store = fakeStore(["stuck-on-the-wire"]);
    const dispatches: string[] = [];
    const sending: Record<string, boolean> = {};
    let observedSignal: AbortSignal | null = null;

    const deps: DrainDeps = {
      canDrain: () => true,
      getId: () => "s-hung",
      claim: async (id) => {
        void id;
        const it = store.items.find((m) => m.state === "pending");
        if (!it) return null;
        it.state = "dispatching";
        return { ...it };
      },
      // Simulate the real dispatchQueuedItem: the POST hangs until the signal
      // aborts, then the catch classifies "unknown" (mirrors ChatView's
      // `aborted = signal.aborted || AbortError` branch).
      dispatch: async (id, item, signal) => {
        void id;
        observedSignal = signal;
        dispatches.push(item.id);
        return new Promise<{ state: "sent" | "failed" | "unknown"; detail: string }>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ state: "unknown", detail: "dispatch timed out" });
          });
          // Safety: never hang the test if the abort never fires.
          setTimeout(() => resolve({ state: "sent", detail: "" }), 2000);
        });
      },
      resolve: async (id, itemId, state, detail) => {
        void id;
        const it = store.items.find((m) => m.id === itemId);
        if (it) {
          it.state = state;
          it.detail = detail;
          it.resolvedAt = 2;
        }
      },
      setSending: (id, v) => {
        sending[id] = v;
      },
      isSending: (id) => !!sending[id],
    };
    const drainer = createQueueDrainer(deps, 50); // 50ms dispatch timeout

    await drainer.drain();

    // Exactly one dispatch (no auto-retry on abort — the POST may have reached
    // OpenCode, so a re-dispatch risks a duplicate).
    expect(dispatches).toEqual(["q-1"]);
    // The dispatch received a signal that actually aborted (the drainer armed it).
    expect(observedSignal).not.toBeNull();
    expect(observedSignal!.aborted).toBe(true);
    // The hung item resolved to a PERSISTENT visible `unknown`, NOT `sent`.
    expect(store.items[0].state).toBe("unknown");
    expect(store.items[0].detail).toBe("dispatch timed out");
    // The text is retained on the item (recovery path: operator dismisses).
    expect(store.items[0].text).toBe("stuck-on-the-wire");
    // Guard released so the next pending item can advance (FIFO preserved).
    expect(sending["s-hung"]).toBe(false);
  });

  it("uses a 12s default dispatch timeout when none is passed (regression: bounded by default)", async () => {
    // Pin the DEFAULT dispatch timeout to 12s by observing the abort signal
    // handed to dispatch: it must NOT abort before 12000ms and MUST abort at the
    // 12000ms boundary. The prior weak form only asserted `drain` was a function
    // and left the actual default bound to the e2e suite; this makes the bound a
    // fast unit assertion. (N1: fake-timer boundary around 11_999/12_000 ms.)
    const store = fakeStore(["only"]);
    const sending: Record<string, boolean> = {};
    let observedSignal: AbortSignal | null = null;
    const deps: DrainDeps = {
      canDrain: () => true,
      getId: () => "s-default-to",
      claim: async () => {
        const it = store.items.find((m) => m.state === "pending");
        if (!it) return null;
        it.state = "dispatching";
        return { ...it };
      },
      // Hang until the signal aborts (mirrors the hung-dispatch test): resolves
      // `unknown` on abort so we can observe the drainer's timeout arming.
      dispatch: async (_id, item, signal) => {
        observedSignal = signal;
        return new Promise<{ state: "sent" | "failed" | "unknown"; detail: string }>((resolve) => {
          signal.addEventListener("abort", () => resolve({ state: "unknown", detail: "dispatch timed out" }));
        });
      },
      resolve: async (_id, itemId, state, detail) => {
        const it = store.items.find((m) => m.id === itemId);
        if (it) {
          it.state = state;
          it.detail = detail;
          it.resolvedAt = 2;
        }
      },
      setSending: (id, v) => {
        sending[id] = v;
      },
      isSending: (id) => !!sending[id],
    };
    const drainer = createQueueDrainer(deps); // NO timeout arg → default 12s
    expect(typeof drainer.drain).toBe("function");
    expect(drainer.isDraining()).toBe(false);

    vi.useFakeTimers();
    try {
      const drainP = drainer.drain();
      // Let the async claim→dispatch microtasks run so dispatch receives its
      // signal and the 12s abort timer is armed before we assert timing.
      await vi.advanceTimersByTimeAsync(0);
      expect(observedSignal).not.toBeNull();
      expect(observedSignal!.aborted).toBe(false);
      // Just under the 12s bound: the dispatch is still pending.
      await vi.advanceTimersByTimeAsync(11999);
      expect(observedSignal!.aborted).toBe(false);
      // At the 12000ms boundary: the default dispatch timeout fires the abort.
      await vi.advanceTimersByTimeAsync(1);
      expect(observedSignal!.aborted).toBe(true);
      await drainP;
      // The hung dispatch classified `unknown` (visible + retained; never auto-sent).
      expect(store.items[0].state).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });
});
