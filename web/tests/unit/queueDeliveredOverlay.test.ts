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
  clearQueueCache,
  claimQueued,
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
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

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
