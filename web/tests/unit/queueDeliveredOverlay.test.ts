// @vitest-environment jsdom
//
// Delivered-message overlay (2026-10-12 "Sending… ~30s after delivery" fix).
//
// A user message persisted under a dispatching chip's EXACT opencodeMsgID
// correlation id is delivery PROOF (the same exact-match authority the backend
// reconciler applies). The stream pipeline reports it via the
// queue-delivery-observed effect (sync/reducers.ts) → orchestration
// (sync/reconcile.ts) → queue.ts noteDeliveredUserMessage, which clears the
// chip LOCALLY at the instant the message enters the transcript — not at the
// next /queue poll. The overlay is knownOutcomes-shaped: while the backend
// item is still `dispatching` (its own event-stream watcher hasn't recorded
// the terminal state yet, or the poll hasn't observed it), the chip stays
// hidden; once the backend reaches terminal, the overlay drops.
//
// These tests pin:
//   1. the queue.ts overlay unit (hide on exact-id match; no-op otherwise),
//   2. the overlay↔fetchQueue composition (hidden while backend behind;
//      dropped once backend terminal),
//   3. the END-TO-END wiring through the REAL dispatch (applyMessageEvent →
//      reconcileEvent → projectMessageEvent → effect → interpretEffects →
//      noteDeliveredUserMessage) — the same live path Stream 2 delivers
//      through, synchronous, no poll.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import {
  __resetQueueAttemptSupportForTests,
  clearQueueCache,
  claimQueued,
  enqueue,
  fetchQueue,
  hasQueueState,
  noteDeliveredUserMessage,
  queueFor,
} from "../../src/queue";
import { applyMessageEvent } from "../../src/sync/reconcile";
import { setState } from "../../src/sync/store";

// In-memory localStorage (queue.ts reads prefs at module load; matches
// queue.test.ts).
const mem: Record<string, string> = {};
// jsdom 30 made window.localStorage a getter-only accessor — install the
// in-memory shim via defineProperty (plain assignment throws).
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => {
      mem[k] = v;
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
  },
});

// Minimal Response shape the queue module reads.
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

// Seed ONE dispatching chip carrying a correlation id — the state the daemon
// era leaves after a claim: claimQueued upserts the claimed item even into an
// empty cache (the stale-view arm in queue.ts).
const SID = "s-dlv";
const MSG_ID = "msg_abc_123";
function seedDispatchingChip(): Promise<unknown> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      res(200, {
        item: {
          id: "q-1",
          order: 1,
          state: "dispatching",
          text: "hello",
          attachments: [],
          opencodeMsgID: MSG_ID,
          createdAt: 1,
          dispatchStartedAt: 1,
        },
      }),
    ),
  );
  return claimQueued(SID);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => res(200, { items: [] })));
});

afterEach(() => {
  clearQueueCache([SID]);
  setState("messages", reconcile({}));
  setState("messageWindows", reconcile({}));
  setState("messagesDelivered", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("cursor", 0);
  vi.unstubAllGlobals();
});

describe("noteDeliveredUserMessage — exact-id overlay unit", () => {
  it("hides a dispatching chip the moment its correlation id is observed", async () => {
    await seedDispatchingChip();
    expect(queueFor(SID)).toHaveLength(1);
    expect(queueFor(SID)[0].state).toBe("dispatching");

    noteDeliveredUserMessage(SID, MSG_ID);

    expect(queueFor(SID)).toHaveLength(0);
    expect(hasQueueState(SID)).toBe(false);
  });

  it("is a no-op for a wrong id, a wrong session, or no cached queue", async () => {
    await seedDispatchingChip();
    noteDeliveredUserMessage(SID, "msg_OTHER");
    noteDeliveredUserMessage("s-absent", MSG_ID);
    noteDeliveredUserMessage("", MSG_ID);
    noteDeliveredUserMessage(SID, "");
    expect(queueFor(SID)).toHaveLength(1);
  });
});

describe("noteDeliveredUserMessage ↔ fetchQueue — knownOutcomes composition", () => {
  it("keeps the chip hidden while the backend still reports dispatching", async () => {
    await seedDispatchingChip();
    noteDeliveredUserMessage(SID, MSG_ID);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        res(200, {
          items: [
            {
              id: "q-1",
              order: 1,
              state: "dispatching",
              text: "hello",
              attachments: [],
              opencodeMsgID: MSG_ID,
              createdAt: 1,
              dispatchStartedAt: 1,
            },
          ],
        }),
      ),
    );
    const items = await fetchQueue(SID);

    // The overlay holds: the FE knows the outcome; the UI must not flip the
    // chip back to a misleading "Sending…".
    expect(items).toHaveLength(1);
    expect(items![0].state).toBe("sent");
    expect(queueFor(SID)).toHaveLength(0);
  });

  it("drops the overlay once the backend reaches terminal", async () => {
    await seedDispatchingChip();
    noteDeliveredUserMessage(SID, MSG_ID);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        res(200, {
          items: [
            {
              id: "q-1",
              order: 1,
              state: "sent",
              text: "hello",
              attachments: [],
              opencodeMsgID: MSG_ID,
              createdAt: 1,
              resolvedAt: 2,
              detail: "Delivered: OpenCode persisted the user message under the queue correlation id (observed on the live event stream); resolved to sent.",
            },
          ],
        }),
      ),
    );
    await fetchQueue(SID);

    // Backend authority: the cache holds the server's terminal item (hidden
    // by the sent filter, like every resolved send).
    expect(queueFor(SID)).toHaveLength(0);
    expect(hasQueueState(SID)).toBe(false);
  });
});

describe("stream wiring — message.upsert → queue-delivery-observed → overlay", () => {
  it("a user message.upsert with the chip's correlation id clears the chip SYNCHRONOUSLY on the live path", async () => {
    await seedDispatchingChip();
    expect(queueFor(SID)).toHaveLength(1);

    // The exact live Stream-2 shape: flat MessageInfo payload, trackCursor
    // false. No poll, no await — reconcileEvent is synchronous end-to-end.
    applyMessageEvent(
      "message.upsert",
      7,
      { id: MSG_ID, sessionID: SID, role: "user", time: { created: 100 } },
      false,
    );

    expect(queueFor(SID)).toHaveLength(0);
    expect(hasQueueState(SID)).toBe(false);
  });

  it("an assistant message.upsert with the same id does NOT clear the chip", async () => {
    await seedDispatchingChip();

    applyMessageEvent(
      "message.upsert",
      8,
      { id: MSG_ID, sessionID: SID, role: "assistant", time: { created: 101 } },
      false,
    );

    expect(queueFor(SID)).toHaveLength(1);
    expect(queueFor(SID)[0].state).toBe("dispatching");
  });

  it("a user message.upsert with an unrelated id does NOT clear the chip", async () => {
    await seedDispatchingChip();

    applyMessageEvent(
      "message.upsert",
      9,
      { id: "msg_someone_else", sessionID: SID, role: "user", time: { created: 102 } },
      false,
    );

    expect(queueFor(SID)).toHaveLength(1);
  });
});

// --- daemon-dispatch mode: the pending-chip convergence contract -------------
//
// In daemon-dispatch mode the browser never claims: the FE's ONLY copy of a
// queued item is the enqueue (admission) response — a `pending` snapshot that
// NEVER carries opencodeMsgID (the backend mints it at claim time, inside the
// daemon). The exact-match overlay above therefore matches NOTHING, and the
// chip's clearance used to depend entirely on the next successful LIST (~5s
// poll). Worse, over the tunnel the delivery event can arrive BEFORE the
// enqueue response (which then upserts `pending` AFTER delivery), and the
// admission receipt is replayed VERBATIM forever (outbox re-admission from
// another pane, ≥60s later) — both re-introduce a stale `pending` chip over
// known-sent truth.
//
// The contract under test: the chip clears promptly in EVERY ordering, and the
// FE converges to backend truth when the exact-match fast path misses.
describe("daemon-dispatch mode — pending chip convergence (both orderings)", () => {
  // The daemon-era enqueue response: admission-time snapshot, `pending`, no
  // opencodeMsgID (minted server-side at claim), attemptId echoed.
  const PENDING_ITEM = {
    id: "q-9",
    order: 1,
    state: "pending",
    text: "daemon hello",
    attachments: [],
    attemptId: "att-1",
    createdAt: 1,
  };
  // Backend truth once the daemon delivered: sent + the claim-minted
  // correlation id.
  const SENT_ITEM = {
    ...PENDING_ITEM,
    state: "sent",
    opencodeMsgID: MSG_ID,
    resolvedAt: 2,
    detail: "Delivered: OpenCode persisted the user message under the queue correlation id.",
  };

  function stubEnqueueResponse(replayed: boolean): void {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { item: PENDING_ITEM, replayed })));
  }
  function stubQueueList(listFetch: ReturnType<typeof vi.fn>, items: unknown[]): void {
    listFetch.mockImplementation(async () => res(200, { items }));
    vi.stubGlobal("fetch", listFetch);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    __resetQueueAttemptSupportForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(i) delivery AFTER the pending enqueue response: the unmatched delivery schedules a converging fetch", async () => {
    stubEnqueueResponse(false);
    await enqueue(SID, { text: "daemon hello", attachments: [], attemptId: "att-1" });
    expect(queueFor(SID)).toHaveLength(1); // chip visible, no state label (the report)

    const listFetch = vi.fn();
    stubQueueList(listFetch, [SENT_ITEM]); // backend truth: sent

    noteDeliveredUserMessage(SID, MSG_ID); // exact match misses (pending, no msg id)
    expect(queueFor(SID)).toHaveLength(1); // chip still visible pre-convergence

    await vi.advanceTimersByTimeAsync(500); // debounce fires → fetchQueue
    expect(listFetch).toHaveBeenCalledTimes(1);
    expect(queueFor(SID)).toHaveLength(0); // converged to backend truth
    expect(hasQueueState(SID)).toBe(false);
  });

  it("(ii) delivery BEFORE the enqueue response: the stale pending upsert still converges", async () => {
    // Hold the enqueue response open so the delivery event can land first —
    // the real tunnel ordering (SSE delivery races the admission response).
    let resolveEnqueue!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolveEnqueue = r))));
    const pending = enqueue(SID, { text: "daemon hello", attachments: [], attemptId: "att-1" });

    noteDeliveredUserMessage(SID, MSG_ID); // delivery observed while cache is EMPTY

    resolveEnqueue(res(200, { item: PENDING_ITEM, replayed: false }));
    await pending; // the stale admission snapshot upserts pending AFTER delivery
    expect(queueFor(SID)).toHaveLength(1); // stale chip visible — must not persist

    const listFetch = vi.fn();
    stubQueueList(listFetch, [SENT_ITEM]);
    await vi.advanceTimersByTimeAsync(500); // upsert+recent-delivery arm fires
    expect(listFetch).toHaveBeenCalledTimes(1);
    expect(queueFor(SID)).toHaveLength(0);
  });

  it("(iii) a replayed admission receipt never resurrects a chip over known-sent truth", async () => {
    stubEnqueueResponse(false);
    await enqueue(SID, { text: "daemon hello", attachments: [], attemptId: "att-1" });
    expect(queueFor(SID)).toHaveLength(1);

    // Next poll brings backend truth: sent (chip clears via the sent filter).
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { items: [SENT_ITEM] })));
    await fetchQueue(SID);
    expect(queueFor(SID)).toHaveLength(0);

    // ≥60s later another host-shell pane replays the SAME admission (outbox
    // re-admission); the server answers the ORIGINAL receipt verbatim — the
    // admission-time `pending` snapshot. The cache must NOT regress.
    stubEnqueueResponse(true);
    await enqueue(SID, { text: "daemon hello", attachments: [], attemptId: "att-1" });
    expect(queueFor(SID)).toHaveLength(0); // no phantom pending chip
  });

  it("(iii-b) a burst of unmatched deliveries coalesces into ONE convergence fetch (storm guard)", async () => {
    stubEnqueueResponse(false);
    await enqueue(SID, { text: "daemon hello", attachments: [], attemptId: "att-1" });
    expect(queueFor(SID)).toHaveLength(1);

    const listFetch = vi.fn();
    stubQueueList(listFetch, [SENT_ITEM]);

    // An SSE transcript replay can fire several persisted user-message
    // deliveries inside one debounce window. The in-flight guard must
    // coalesce them: one GET, not one per event.
    noteDeliveredUserMessage(SID, MSG_ID);
    noteDeliveredUserMessage(SID, MSG_ID);
    noteDeliveredUserMessage(SID, "msg-other");
    await vi.advanceTimersByTimeAsync(100); // inside the 400ms window
    noteDeliveredUserMessage(SID, MSG_ID); // a fourth, still inside

    await vi.advanceTimersByTimeAsync(1000);
    expect(listFetch).toHaveBeenCalledTimes(1);
    expect(queueFor(SID)).toHaveLength(0);
  });

  it("(iv) clearQueueCache cancels a pending convergence fetch (archive path never fetches a dead session)", async () => {
    stubEnqueueResponse(false);
    await enqueue(SID, { text: "daemon hello", attachments: [], attemptId: "att-1" });

    const listFetch = vi.fn();
    stubQueueList(listFetch, [SENT_ITEM]);

    noteDeliveredUserMessage(SID, MSG_ID); // schedules the debounced fetch…
    clearQueueCache([SID]); // …but the session is archived before it fires

    await vi.advanceTimersByTimeAsync(1000);
    expect(listFetch).not.toHaveBeenCalled();
    expect(queueFor(SID)).toHaveLength(0);
  });
});
