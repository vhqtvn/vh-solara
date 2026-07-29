// @vitest-environment jsdom
//
// Controller tests for web/src/components/chat/createQueueSync.ts (the C7
// extraction from ChatView). Mirrors the createComposerAutocomplete.test.ts
// (C3) / createPromptHistory.test.ts (C5) precedent: the factory's deps are
// injected as fakes, the controller is constructed under a Solid `createRoot`
// owner (so its createEffect + onMount/onCleanup register), and the queue-sync
// lifecycle is exercised WITHOUT a component/reactive-render harness — no
// ChatView, no drainer, no real network.
//
// This is the controller-level twin of the queueDrain.test.ts drainer tests:
// those pin the single-flight `draining` flag + sending-guard lifecycle owned by
// createQueueDrainer; these pin the EFFECTS that trigger drains + keep the
// cache fresh (drain-trigger, session-open, reconnect, poll, focus/visibility).
// The two are deliberately complementary.
//
// Reactive cache reads (queueFor, hasQueueState) are signal-backed fakes so the
// factory's effects re-run when the "queue" changes — mirroring how the real
// ../queue reads a Solid store (the store read inside the effect is what tracks
// it, not the function reference itself).
//
// Each setup() registers its root dispose so afterEach tears them down —
// undisposed roots leak Solid owners across tests and corrupt the scheduler
// (effects stop re-running on signal writes).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createQueueSync, type QueueSyncDeps } from "../../src/components/chat/createQueueSync";
import type { QueuedMessage } from "../../src/queue";

// Solid createEffect (deferred) + the queueMicrotask drain arm + the async
// session-open IIFE all settle on the microtask queue. Two microtasks + one
// macrotask boundary guarantees everything flushed (initial effect runs, the
// migrate→fetch chain, and any re-run after a signal write).
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
}

const disposes: Array<() => void> = [];

interface Fakes {
  migrateLegacyQueue: ReturnType<typeof vi.fn>;
  fetchQueue: ReturnType<typeof vi.fn>;
  drain: ReturnType<typeof vi.fn>;
}

interface Handles {
  sessionId: (v: string) => void;
  setDraft: (v: boolean) => void;
  setWorking: (v: boolean) => void;
  setStatus: (v: "connecting" | "live" | "reconnecting") => void;
  setQueue: (v: QueuedMessage[]) => void;
  setVisible: (v: "visible" | "hidden") => void;
  fn: Fakes;
  dispose: () => void;
}

function setup(o: Partial<{ sessionId: string; draft: boolean; working: boolean }> = {}): Handles {
  const [sessionId, setSid] = createSignal(o.sessionId ?? "s1");
  const [draft, setDraft] = createSignal(o.draft ?? false);
  const [working, setWorking] = createSignal(o.working ?? false);
  const [status, setStatus] = createSignal<"connecting" | "live" | "reconnecting">("connecting");
  const [queue, setQueue] = createSignal<QueuedMessage[]>([]);
  const fn: Fakes = {
    migrateLegacyQueue: vi.fn().mockResolvedValue(undefined),
    fetchQueue: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  };
  const deps: QueueSyncDeps = {
    sessionId,
    draft,
    working,
    streamStatus: status,
    // Signal-backed so the factory's effects re-run when the "queue" changes —
    // the real ../queue reads a Solid store the same way.
    queueFor: () => queue(),
    hasQueueState: () => queue().some((m) => m.state !== "sent"),
    migrateLegacyQueue: fn.migrateLegacyQueue,
    fetchQueue: fn.fetchQueue,
    drain: fn.drain,
  };
  const dispose = createRoot((d) => {
    createQueueSync(deps);
    return d;
  });
  disposes.push(dispose);
  return {
    sessionId: setSid,
    setDraft,
    setWorking,
    setStatus,
    setQueue,
    setVisible: (v) => Object.defineProperty(document, "visibilityState", { configurable: true, value: v }),
    fn,
    dispose,
  };
}

function item(id: string, state: QueuedMessage["state"]): QueuedMessage {
  return { id, order: 0, state, text: "", attachments: [], createdAt: 0 } as unknown as QueuedMessage;
}

afterEach(() => {
  while (disposes.length) disposes.pop()!();
  vi.restoreAllMocks();
});

describe("createQueueSync — drain trigger (busy→idle + idle-open-with-queue)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drains when the session is idle AND has a pending item", async () => {
    const { setWorking, setQueue, fn } = setup({ working: true });
    await flush();
    setQueue([item("q1", "pending")]);
    // Still working → no drain yet.
    await flush();
    expect(fn.drain).not.toHaveBeenCalled();
    // busy→idle edge re-arms the drain.
    setWorking(false);
    await flush();
    expect(fn.drain).toHaveBeenCalledTimes(1);
  });

  it("does NOT drain while the session is working (a pending item waits)", async () => {
    const { setQueue, fn } = setup({ working: true });
    await flush();
    setQueue([item("q1", "pending")]);
    await flush();
    expect(fn.drain).not.toHaveBeenCalled();
  });

  it("does NOT drain when items are only dispatching/terminal (no pending)", async () => {
    const { setQueue, fn } = setup({ working: false });
    await flush();
    setQueue([item("q1", "dispatching"), item("q2", "failed")]);
    await flush();
    expect(fn.drain).not.toHaveBeenCalled();
  });

  it("does NOT drain in draft mode even with a pending item", async () => {
    const { setQueue, fn } = setup({ draft: true, working: false });
    await flush();
    setQueue([item("q1", "pending")]);
    await flush();
    expect(fn.drain).not.toHaveBeenCalled();
  });
});

describe("createQueueSync — session-open migrate + fetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("migrates the legacy queue THEN fetches on session open (order matters)", async () => {
    const { fn } = setup({ sessionId: "s1" });
    await flush();
    expect(fn.migrateLegacyQueue).toHaveBeenCalledWith("s1");
    expect(fn.fetchQueue).toHaveBeenCalledWith("s1");
    // migrate resolves before fetch is called.
    const migrateBeforeFetch = fn.migrateLegacyQueue.mock.invocationCallOrder[0] < fn.fetchQueue.mock.invocationCallOrder[0];
    expect(migrateBeforeFetch).toBe(true);
  });

  it("does NOT migrate or fetch in draft mode", async () => {
    const { fn } = setup({ sessionId: "", draft: true });
    await flush();
    expect(fn.migrateLegacyQueue).not.toHaveBeenCalled();
    expect(fn.fetchQueue).not.toHaveBeenCalled();
  });
});

describe("createQueueSync — stream reconnect refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes the queue when the stream goes live after a reconnect", async () => {
    const { setStatus, fn } = setup({ sessionId: "s1" });
    await flush();
    // The session-open effect already fetched once on setup; clear to isolate.
    fn.fetchQueue.mockClear();
    setStatus("reconnecting");
    await flush();
    expect(fn.fetchQueue).not.toHaveBeenCalled();
    setStatus("live");
    await flush();
    expect(fn.fetchQueue).toHaveBeenCalledWith("s1");
  });

  it("does NOT refresh on reconnect while in draft mode", async () => {
    const { setStatus, fn } = setup({ sessionId: "", draft: true });
    await flush();
    setStatus("live");
    await flush();
    expect(fn.fetchQueue).not.toHaveBeenCalled();
  });
});

describe("createQueueSync — focus / visibility refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes on window focus", async () => {
    const { fn } = setup({ sessionId: "s1" });
    await flush();
    fn.fetchQueue.mockClear();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fn.fetchQueue).toHaveBeenCalledWith("s1");
  });

  it("refreshes on visibilitychange (tab re-show)", async () => {
    const { fn } = setup({ sessionId: "s1" });
    await flush();
    fn.fetchQueue.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fn.fetchQueue).toHaveBeenCalledWith("s1");
  });

  it("does NOT refresh on focus while in draft mode", async () => {
    const { fn } = setup({ sessionId: "", draft: true });
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fn.fetchQueue).not.toHaveBeenCalled();
  });
});

describe("createQueueSync — poll + cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Under fake timers the real setTimeout is faked, so the suite-level flush()
  // (which awaits a setTimeout(0)) would deadlock. advanceTimersByTimeAsync(0)
  // drains the microtask queue that Solid's deferred createEffect + the async
  // session-open IIFE settle on, without advancing the 5s poll.
  async function tick() {
    await vi.advanceTimersByTimeAsync(0);
  }

  it("polls ~5s while the session has visible queue state and the tab is visible", async () => {
    const { setQueue, fn } = setup({ sessionId: "s1" });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await tick();
    setQueue([item("q1", "pending")]);
    await tick();
    fn.fetchQueue.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn.fetchQueue).toHaveBeenCalledWith("s1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn.fetchQueue).toHaveBeenCalledTimes(2);
  });

  it("does NOT poll while the tab is hidden", async () => {
    const { setQueue, fn } = setup({ sessionId: "s1" });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await tick();
    setQueue([item("q1", "pending")]);
    await tick();
    fn.fetchQueue.mockClear();
    await vi.advanceTimersByTimeAsync(15000);
    expect(fn.fetchQueue).not.toHaveBeenCalled();
  });

  it("stops polling once the session has no visible queue state", async () => {
    const { setQueue, fn } = setup({ sessionId: "s1" });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await tick();
    setQueue([item("q1", "pending")]);
    await tick();
    fn.fetchQueue.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn.fetchQueue).toHaveBeenCalledTimes(1);
    // Queue drains to empty (only a `sent` item remains → hasQueueState false).
    setQueue([item("q1", "sent")]);
    await tick();
    fn.fetchQueue.mockClear();
    await vi.advanceTimersByTimeAsync(15000);
    expect(fn.fetchQueue).not.toHaveBeenCalled();
  });

  it("cleanup (dispose) clears the poll timer and removes the focus/visibility listeners", async () => {
    const { setQueue, fn, dispose } = setup({ sessionId: "s1" });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await tick();
    setQueue([item("q1", "pending")]);
    await tick();
    fn.fetchQueue.mockClear();
    dispose();
    // After disposal the poll no longer fires…
    await vi.advanceTimersByTimeAsync(15000);
    expect(fn.fetchQueue).not.toHaveBeenCalled();
    // …and the focus/visibility listeners are gone too.
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(fn.fetchQueue).not.toHaveBeenCalled();
  });
});
