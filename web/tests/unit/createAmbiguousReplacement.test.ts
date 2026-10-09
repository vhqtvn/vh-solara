// Send-net-resilience slice 3 review (c-F3) — the ambiguous replacement
// controller's double-tap guard.
//
// `replace()` mints a NEW gesture (fresh intentId) per call. A fast second
// tap of "Send new message" during the first replacement's admission window
// (outbox save → enqueue → overlay) used to mint a SECOND replacement
// gesture — two enqueues, the core duplicate-harm class. The per-item
// in-flight guard (Set keyed by queue item id, acquired before any await,
// cleared on settle) must:
//
//   - DROP a second tap for the SAME item while one is in flight (exactly
//     one enqueue; the drop resolves false and is silent);
//   - clear on settle, so a LATER explicit re-tap (the retry-same posture
//     after an uncertain admission) still mints + enqueues;
//   - be keyed PER ITEM: a different ambiguous item's replacement proceeds
//     while one is in flight.
//
// Node environment (pure controller logic; the outbox seam runs against the
// in-memory store — the REAL IndexedDB path is the e2e lane's).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAmbiguousReplacement } from "../../src/components/chat/createAmbiguousReplacement";
import { __resetOutboxForTests, saveGesture } from "../../src/lib/outbox";
import { createMemoryOutboxStore, type OutboxStore } from "../../src/lib/outbox/store";
import { __resetSendActionStatusForTests } from "../../src/lib/sendActionStatus";
import type { OutboxContextHead } from "../../src/lib/outbox";
import type { QueuedMessage } from "../../src/queue";

// localStorage stub (the outbox module's pending-records marker).
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

function head(sessionId: string, lastMessageId: string | null, count: number): OutboxContextHead {
  return { sessionId, lastMessageId, count };
}

function ambiguousItem(o: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "q-amb",
    order: 1,
    state: "unknown",
    text: "did this arrive?",
    attachments: [],
    createdAt: 1,
    ambiguousDelivery: true,
    intentId: "i-orig",
    ...o,
  } as QueuedMessage;
}

function qItem(id: string, o: Partial<QueuedMessage> = {}): QueuedMessage {
  return { id, order: 2, state: "pending", text: "did this arrive?", attachments: [], createdAt: 2, ...o } as QueuedMessage;
}

let memoryStore: OutboxStore;

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  memoryStore = createMemoryOutboxStore();
  __resetOutboxForTests(memoryStore);
  __resetSendActionStatusForTests();
});

describe("createAmbiguousReplacement — double-tap guard (c-F3)", () => {
  it("a fast second tap during the admission window enqueues exactly ONE replacement; the drop is silent and resolves false", async () => {
    // Hold the FIRST admission open so the in-flight window is observable.
    let releaseEnqueue!: () => void;
    const gate = new Promise<void>((r) => (releaseEnqueue = r));
    const enqueue = vi.fn(async (_sid: string, input: any) => {
      if (enqueue.mock.calls.length === 1) await gate; // first call only
      return qItem("q-new", { intentId: input.intentId });
    });
    // The ORIGINAL gesture's durable record (so the TOCTOU gate has a head).
    await saveGesture({
      intentId: "i-orig",
      sessionId: "s1",
      payload: { text: "did this arrive?", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
    });
    const notify = vi.fn();
    const ctl = createAmbiguousReplacement({
      sessionId: () => "s1",
      enqueue: enqueue as any,
      captureHead: () => head("s1", "m-0", 1), // unchanged context
      notify: notify as any,
    });
    const q = ambiguousItem();

    // First tap: enters the admission window and parks on the gated enqueue.
    const first = ctl.replace(q);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

    // Double tap WHILE in flight: dropped — no second gesture, no enqueue,
    // no duplicate-harm notification (the in-flight one owns the item).
    const second = await ctl.replace(q);
    expect(second).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();

    // The in-flight replacement settles: admitted, exactly one item.
    releaseEnqueue();
    await expect(first).resolves.toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const wireIntent = (enqueue.mock.calls[0] as any[])[1].intentId as string;
    expect(wireIntent).toBeTruthy();
    expect(wireIntent).not.toBe("i-orig"); // a NEW gesture, never a replay
  });

  it("the guard clears on settle — a LATER explicit re-tap mints and enqueues again", async () => {
    const enqueue = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    const ctl = createAmbiguousReplacement({
      sessionId: () => "s1",
      enqueue: enqueue as any,
      captureHead: () => head("s1", "m-0", 1),
      notify: vi.fn() as any,
    });
    const q = ambiguousItem();
    await expect(ctl.replace(q)).resolves.toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // Settled → guard cleared → a later explicit re-tap (the retry-same
    // posture) proceeds: a fresh mint + enqueue.
    await expect(ctl.replace(q)).resolves.toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
    const [idA, idB] = [(enqueue.mock.calls[0] as any[])[1].intentId, (enqueue.mock.calls[1] as any[])[1].intentId];
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idB).not.toBe(idA); // each tap = its own new gesture
    expect(idB).not.toBe("i-orig");
  });

  it("the guard is per-item: a DIFFERENT ambiguous item's replacement proceeds while one is in flight", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const enqueue = vi.fn(async (_sid: string, input: any) => {
      if (enqueue.mock.calls.length === 1) await gate;
      return qItem("q-new", { intentId: input.intentId });
    });
    const ctl = createAmbiguousReplacement({
      sessionId: () => "s1",
      enqueue: enqueue as any,
      captureHead: () => head("s1", "m-0", 1),
      notify: vi.fn() as any,
    });

    const first = ctl.replace(ambiguousItem({ id: "q-a", intentId: "i-a" }));
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    // A different item is NOT blocked by q-a's in-flight replacement.
    await expect(ctl.replace(ambiguousItem({ id: "q-b", intentId: "i-b" }))).resolves.toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);

    releaseFirst();
    await expect(first).resolves.toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

// Two-tap compare-at-REPLACEMENT (debate-4 finding 7, amended 2026-10-09 —
// review C1/C2). The amendment's semantics: the stale-context confirmation
// fires only from the explicit second tap; the controller re-verifies at
// REPLACEMENT against the head the operator saw at the FIRST tap (the head
// that made it stale), and refuses loudly only when the head moved DURING
// the confirm window. The pre-amendment code re-verified with the SAME
// predicate as the first tap (original captured head vs live) — since
// nothing rewrites the record's capturedHead between taps, "Send anyway"
// was re-refused forever: a TOCTOU refusal loop where the amended flow
// could never proceed.
describe("createAmbiguousReplacement — two-tap stale-confirm (compare-at-REPLACEMENT)", () => {
  async function armOriginalGesture(): Promise<void> {
    await saveGesture({
      intentId: "i-orig",
      sessionId: "s1",
      payload: { text: "did this arrive?", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
    });
  }

  it("stale at first tap → head UNCHANGED during the confirm window → Send anyway PROCEEDS (one enqueue, new intentId)", async () => {
    // The case that was IMPOSSIBLE pre-amendment: the operator acknowledged
    // exactly this drift, so the re-verify must compare against the FIRST-TAP
    // head (live, stale vs the original capture), not the original capture.
    await armOriginalGesture();
    const enqueue = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    const notify = vi.fn();
    const ctl = createAmbiguousReplacement({
      sessionId: () => "s1",
      enqueue: enqueue as any,
      captureHead: () => head("s1", "m-1", 2), // stale vs the original capture
      notify: notify as any,
    });
    const q = ambiguousItem();

    await expect(ctl.tap(q)).resolves.toBe("stale-confirm"); // the chip shows "Send anyway"
    // Confirm window: the head HOLDS at the first-tap head.
    await expect(ctl.replace(q)).resolves.toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const wireIntent = (enqueue.mock.calls[0] as any[])[1].intentId as string;
    expect(wireIntent).toBeTruthy();
    expect(wireIntent).not.toBe("i-orig"); // a NEW gesture, never a replay
    expect(notify).not.toHaveBeenCalled(); // proceeded — not the refusal loop
  });

  it("stale at first tap → head moves AGAIN during the confirm window → refuse loudly, no enqueue", async () => {
    await armOriginalGesture();
    const enqueue = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    const notify = vi.fn();
    let live = head("s1", "m-1", 2); // stale vs the original capture at tap…
    const ctl = createAmbiguousReplacement({
      sessionId: () => "s1",
      enqueue: enqueue as any,
      captureHead: () => live,
      notify: notify as any,
    });
    const q = ambiguousItem();

    await expect(ctl.tap(q)).resolves.toBe("stale-confirm");
    live = head("s1", "m-2", 3); // …and drifts AGAIN before "Send anyway"
    await expect(ctl.replace(q)).resolves.toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0] as any[])[0].title).toBe("Conversation moved on");
  });

  it("fresh head → the single-tap path is unchanged: tap confirms and replace proceeds", async () => {
    await armOriginalGesture();
    const enqueue = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    const notify = vi.fn();
    const ctl = createAmbiguousReplacement({
      sessionId: () => "s1",
      enqueue: enqueue as any,
      captureHead: () => head("s1", "m-0", 1), // unchanged context
      notify: notify as any,
    });
    const q = ambiguousItem();

    await expect(ctl.tap(q)).resolves.toBe("confirmed"); // no inline confirm
    await expect(ctl.replace(q)).resolves.toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("no pending confirm (direct replace, stale head) → the ORIGINAL predicate still refuses loudly", async () => {
    // The retained TOCTOU guard for the unconfirmed path: a replace that was
    // never preceded by a stale-confirm tap verifies the original gesture's
    // captured head against the live head — nobody acknowledged the drift.
    await armOriginalGesture();
    const enqueue = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    const notify = vi.fn();
    const ctl = createAmbiguousReplacement({
      sessionId: () => "s1",
      enqueue: enqueue as any,
      captureHead: () => head("s1", "m-1", 2), // stale, never confirmed
      notify: notify as any,
    });
    const q = ambiguousItem();

    await expect(ctl.replace(q)).resolves.toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0] as any[])[0].title).toBe("Conversation moved on");
  });
});
