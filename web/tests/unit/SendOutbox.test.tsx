// @vitest-environment jsdom
//
// AREA 7 — the send outbox gate (send-net-resilience slice 3, BLK-A3 +
// debate-4 finding 7, amended 2026-10-09 — compare at resume/replacement),
// driven through ChatView's public surface via the shared _chatSendHarness
// (the outbox seam is mocked there with per-test control — these tests ARE
// the gate's contract):
//
//   (1) a send saves the gesture to the outbox BEFORE the enqueue POST, and
//       the wire carries intentId === attemptId (the canonical admission
//       identity; the daemon dedupes by value across aliases);
//   (2) a CONFIRMED enqueue links the gesture to its item (markAdmitted);
//   (3) an outbox save failure blocks the send BEFORE admission: no enqueue,
//       the composer text is retained, and the blocked row carries reason
//       "storage-unavailable" (the blocking banner is armed by the real
//       outbox module — pinned in outbox.test.ts);
//   (4) the TAP-time context-head is captured and persisted with the gesture
//       (the RESUME/replacement stale gates' basis); a save-window transcript
//       change does NOT block the live gesture (innocent hydration catch-up —
//       the compare runs at reconcile/replacement, never mid-gesture);
//   (5) a retry of the SAME gesture (uncertain admission → Retry same
//       message) reuses the SAME intentId.
import "./_chatSendHarness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { isSendInFlight } from "../../src/lib/sendSingleFlight";
import { sendActionsFor, getSendAction } from "../../src/lib/sendActionStatus";
import { setState } from "../../src/sync/store";
import {
  mocks,
  resetAll,
  setupBrowserGlobals,
  teardownBrowserGlobals,
  liveView,
  typeInto,
  composerValue,
  clickSend,
} from "./_chatSendHarness";

const SID = "s-outbox";

describe("AREA 7 — the outbox gate (BLK-A3 durability + capture semantics)", () => {
  beforeEach(() => {
    setupBrowserGlobals();
    resetAll();
  });
  afterEach(() => {
    cleanup();
    teardownBrowserGlobals();
  });

  it("(1) saves the gesture BEFORE the enqueue POST and carries intentId === attemptId on the wire", async () => {
    const order: string[] = [];
    mocks.outboxSave.mockImplementation(async () => {
      order.push("save");
      return { ok: true } as const;
    });
    mocks.enqueue.mockImplementation(async () => {
      order.push("enqueue");
      return { id: "q-1", order: 1, state: "pending", text: "", attachments: [], createdAt: 0 } as any;
    });
    const { container } = render(() => liveView(SID));
    typeInto(container, "durable gesture");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    // The IDB commit strictly precedes the admission POST (BLK-A3: "locally
    // saved" is only claimed after the transaction commits — and the send
    // only proceeds past a committed save).
    expect(order).toEqual(["save", "enqueue"]);
    const [, payload] = mocks.enqueue.mock.calls[0] as [
      string,
      { attemptId?: string; intentId?: string },
    ];
    expect(payload.intentId).toBeTruthy();
    expect(payload.intentId).toBe(payload.attemptId); // same gesture identity, canonical wire name
    const saved = mocks.outboxSave.mock.calls[0][0];
    expect(saved.payload.text).toBe("durable gesture");
    expect(saved.sessionId).toBe(SID);
  });

  it("(2) a confirmed enqueue links the gesture to its queue item (markAdmitted)", async () => {
    const { container } = render(() => liveView(SID));
    typeInto(container, "link me");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.outboxMarkAdmitted).toHaveBeenCalledTimes(1));
    const [intentId, itemId] = mocks.outboxMarkAdmitted.mock.calls[0] as [string, string];
    expect(itemId).toBe("q-enq");
    expect(intentId).toBeTruthy();
  });

  it("(3) an outbox save failure blocks BEFORE admission: no enqueue, text retained, blocked row reason storage-unavailable", async () => {
    mocks.outboxSave.mockImplementation(async () => ({
      ok: false,
      code: "storage-unavailable" as const,
      reason: "QuotaExceededError",
    }));
    const { container } = render(() => liveView(SID));
    typeInto(container, "must not vanish");
    await clickSend(container);
    await waitFor(() => expect(mocks.outboxSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(isSendInFlight(SID)).toBe(false));
    // NEVER enqueued: the gesture did not proceed past the uncommitted save.
    expect(mocks.enqueue).not.toHaveBeenCalled();
    // The compose text is retained in memory (BLK-A3: copy-your-text posture).
    expect(composerValue(container)).toBe("must not vanish");
    // The blocked row owns the fact with the typed reason.
    const rows = sendActionsFor(SID).filter((r) => r.stage === "blocked");
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("storage-unavailable");
  });

  it("(4) the TAP-time context-head is captured and persisted with the gesture (the resume/replacement stale gates' basis); a save-window transcript change does NOT block the live gesture", async () => {
    // Baseline transcript at tap time: one message (m-0). The outbox save
    // mock lands a NEW message (m-1) DURING the save's async window — inside
    // one continuous gesture that is innocent hydration catch-up, not "the
    // conversation moved on since the operator composed": the send proceeds
    // (the stale gate lives at RESUME — reconcile — and replacement, where
    // the message actually sat unsent).
    setState("messages", SID, {
      order: ["m-0"],
      byId: { "m-0": { id: "m-0", info: { id: "m-0" }, partOrder: [], parts: {} } },
    });
    mocks.outboxSave.mockImplementation(async (input: any) => {
      setState("messages", SID, {
        order: ["m-0", "m-1"],
        byId: {
          "m-0": { id: "m-0", info: { id: "m-0" }, partOrder: [], parts: {} },
          "m-1": { id: "m-1", info: { id: "m-1" }, partOrder: [], parts: {} },
        },
      });
      return { ok: true, input } as any;
    });
    const { container } = render(() => liveView(SID));
    typeInto(container, "live gesture");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    // The persisted capture is the TAP-time head (m-0), not the post-window
    // head (m-1) — the basis the resume gate compares against.
    const savedInput = (mocks.outboxSave.mock.calls[0] as any[])[0];
    expect(savedInput.capturedHead).toEqual({ sessionId: SID, lastMessageId: "m-0", count: 1 });
    expect(composerValue(container)).toBe(""); // admitted — composer cleared
  });

  it("(4b) a not-yet-hydrated session persists its empty-tap head (count 0, no tail) — never a fabricated staleness downstream", async () => {
    const { container } = render(() => liveView(SID));
    typeInto(container, "hydration catch-up");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    const savedInput = (mocks.outboxSave.mock.calls[0] as any[])[0];
    // The opened-but-not-yet-hydrated session: an EMPTY transcript head is
    // knowable (not null) and self-consistent — the resume gate comparing it
    // against a later-hydrated head would correctly surface staleness only
    // via headIsStale's id/count compare (a null-vs-object pair never does).
    expect(savedInput.capturedHead).toEqual({ sessionId: SID, lastMessageId: null, count: 0 });
  });

  it("(5) a retry of the SAME gesture reuses the SAME intentId (uncertain admission → Retry same message)", async () => {
    // First send: enqueue response lost (network) → uncertain row, retained
    // gesture record.
    mocks.enqueue.mockRejectedValueOnce(Object.assign(new Error("enqueue timed out"), { code: "timeout" }));
    const { container } = render(() => liveView(SID));
    typeInto(container, "same gesture");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(isSendInFlight(SID)).toBe(false));
    const firstIntent = mocks.outboxSave.mock.calls[0][0].intentId as string;
    // The uncertain row's Retry replays the SAME attempt record.
    const row = sendActionsFor(SID).find((r) => r.stage === "uncertain");
    expect(row).toBeTruthy();
    expect(getSendAction(row!.attemptId)).toBeTruthy();
    expect(row!.attemptId).toBe(firstIntent); // gesture identity is one
    // A NEW send of DIFFERENT text mints a NEW gesture id (new intent).
    mocks.enqueue.mockClear();
    mocks.outboxSave.mockClear();
    typeInto(container, "a different message");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    const secondIntent = mocks.outboxSave.mock.calls[0][0].intentId as string;
    expect(secondIntent).not.toBe(firstIntent);
  });
});
