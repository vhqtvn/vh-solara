// @vitest-environment jsdom
//
// Send-net-resilience slice 3 — the AmbiguousChip contract (debate-4 B1).
//
// Pins:
//   - the BINDING warning text renders VERBATIM for AmbiguousDelivery items;
//   - the three actions (Wait / Copy text / Send new message) render;
//   - Wait collapses the actions but KEEPS the chip (re-expandable);
//   - Copy uses the clipboard and confirms ("Copied");
//   - the stale-context confirmation path: a "stale-confirm" first tap swaps
//     Send new message for Send anyway / Cancel — the replacement only fires
//     from the explicit second tap;
//   - the replacement-requested overlay renders the subdued
//     "replacement requested" state with no send action.
//
// A1 (closed here, two-tap amendment 2026-10-09): the last two tests wire
// the chip to the REAL createAmbiguousReplacement controller (memory-outbox
// store) — tap → stale-confirm → Send anyway → controller verify, end to
// end through the chip's own buttons.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AmbiguousChip } from "../../src/components/AmbiguousChip";
import { createAmbiguousReplacement } from "../../src/components/chat/createAmbiguousReplacement";
import { __resetOutboxForTests, replacementRequestedFor, saveGesture } from "../../src/lib/outbox";
import { createMemoryOutboxStore } from "../../src/lib/outbox/store";
import { __resetSendActionStatusForTests } from "../../src/lib/sendActionStatus";
import type { OutboxContextHead } from "../../src/lib/outbox";
import type { QueuedMessage } from "../../src/queue";

const VERBATIM_WARNING =
  "We could not confirm whether this message arrived. Send a new message may result in both messages being processed if the original arrives later. The original cannot be cancelled.";

function ambiguousItem(o: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "q-amb",
    order: 1,
    state: "unknown",
    text: "did this arrive?",
    attachments: [],
    createdAt: 1,
    ambiguousDelivery: true,
    reconcileTerminal: true,
    intentId: "i-orig",
    ...o,
  } as QueuedMessage;
}

const noop = async () => "confirmed" as const;

beforeEach(() => {
  (globalThis as any).navigator = { ...(globalThis as any).navigator };
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(cleanup);

describe("AmbiguousChip", () => {
  it("renders the verbatim warning + the three actions for a marked item", () => {
    render(() => (
      <AmbiguousChip q={ambiguousItem()} onTap={noop} onReplace={() => {}} replacementRequested={() => false} onRemove={() => {}} />
    ));
    expect(screen.getByTestId("ambiguous-warning").textContent?.replace(/\s+/g, " ").trim()).toBe(VERBATIM_WARNING);
    expect(screen.getByTestId("ambiguous-wait")).toBeTruthy();
    expect(screen.getByTestId("ambiguous-copy")).toBeTruthy();
    expect(screen.getByTestId("ambiguous-replace")).toBeTruthy();
  });

  it("Wait collapses the actions but KEEPS the chip; it re-expands on demand", async () => {
    render(() => (
      <AmbiguousChip q={ambiguousItem()} onTap={noop} onReplace={() => {}} replacementRequested={() => false} onRemove={() => {}} />
    ));
    fireEvent.click(screen.getByTestId("ambiguous-wait"));
    // The chip stays (data-state=waiting) with the message text still shown;
    // the three actions are gone but a re-expand affordance exists.
    const chip = screen.getByTestId("ambiguous-chip");
    expect(chip.getAttribute("data-state")).toBe("waiting");
    expect(chip.textContent).toContain("did this arrive?");
    expect(screen.queryByTestId("ambiguous-replace")).toBeNull();
    const reopen = chip.querySelector("button");
    expect(reopen).toBeTruthy();
    fireEvent.click(reopen!);
    expect(screen.getByTestId("ambiguous-replace")).toBeTruthy();
  });

  it("Copy text uses the clipboard and shows Copied", async () => {
    render(() => (
      <AmbiguousChip q={ambiguousItem()} onTap={noop} onReplace={() => {}} replacementRequested={() => false} onRemove={() => {}} />
    ));
    fireEvent.click(screen.getByTestId("ambiguous-copy"));
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("did this arrive?"));
    await vi.waitFor(() => expect(screen.getByTestId("ambiguous-copy").textContent).toBe("Copied"));
  });

  it("a stale first tap swaps in the visible confirmation; only the explicit second tap replaces", async () => {
    const onReplace = vi.fn();
    const onTap = vi.fn(async () => "stale-confirm" as const);
    render(() => (
      <AmbiguousChip q={ambiguousItem()} onTap={onTap} onReplace={onReplace} replacementRequested={() => false} onRemove={() => {}} />
    ));
    fireEvent.click(screen.getByTestId("ambiguous-replace"));
    await vi.waitFor(() => expect(onTap).toHaveBeenCalledTimes(1));
    expect(onReplace).not.toHaveBeenCalled(); // gated by the visible confirmation
    expect(screen.getByTestId("ambiguous-stale-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ambiguous-replace-anyway"));
    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ id: "q-amb" }));
  });

  it("a confirmed first tap replaces immediately (one-tap when context is unchanged)", async () => {
    const onReplace = vi.fn();
    render(() => (
      <AmbiguousChip q={ambiguousItem()} onTap={noop} onReplace={onReplace} replacementRequested={() => false} onRemove={() => {}} />
    ));
    fireEvent.click(screen.getByTestId("ambiguous-replace"));
    await vi.waitFor(() => expect(onReplace).toHaveBeenCalledTimes(1));
  });

  it("the replacement-requested overlay renders the subdued state with no send action", () => {
    render(() => (
      <AmbiguousChip q={ambiguousItem()} onTap={noop} onReplace={() => {}} replacementRequested={() => true} onRemove={() => {}} />
    ));
    const chip = screen.getByTestId("ambiguous-chip");
    expect(chip.getAttribute("data-state")).toBe("replacement-requested");
    expect(chip.textContent).toContain("replacement requested");
    expect(screen.queryByTestId("ambiguous-replace")).toBeNull();
    expect(screen.queryByTestId("ambiguous-warning")).toBeNull(); // no second send path while replaced
  });

  // A1 (two-tap amendment, debate-4 finding 7 amended 2026-10-09): the chip
  // driven against the REAL controller + memory outbox — the visible confirm
  // only precedes the replacement; the controller re-verifies at replacement
  // against the FIRST-TAP head.
  function head(sessionId: string, lastMessageId: string | null, count: number): OutboxContextHead {
    return { sessionId, lastMessageId, count };
  }

  async function armRealController(liveHead: () => OutboxContextHead | null) {
    __resetOutboxForTests(createMemoryOutboxStore());
    __resetSendActionStatusForTests();
    // The ORIGINAL gesture's durable record (captured head m-0 — stale vs
    // the live m-1 the tests serve).
    await saveGesture({
      intentId: "i-orig",
      sessionId: "s1",
      payload: { text: "did this arrive?", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
    });
    const enqueue = vi.fn(async (_sid: string, input: any) =>
      ({ id: "q-new", order: 2, state: "pending", text: input.text, attachments: [], createdAt: 2, intentId: input.intentId }) as QueuedMessage,
    );
    const ctl = createAmbiguousReplacement({
      sessionId: () => "s1",
      enqueue: enqueue as any,
      captureHead: liveHead,
      notify: vi.fn() as any,
    });
    return { ctl, enqueue };
  }

  it("A1: tap → stale-confirm → head HOLDS → Send anyway drives the real controller to exactly one enqueue + the replacement-requested overlay", async () => {
    const { ctl, enqueue } = await armRealController(() => head("s1", "m-1", 2)); // stale vs m-0
    const q = ambiguousItem();
    render(() => (
      <AmbiguousChip
        q={q}
        onTap={(x) => ctl.tap(x)}
        onReplace={(x) => void ctl.replace(x)}
        replacementRequested={() => !!replacementRequestedFor(q.intentId)}
        onRemove={() => {}}
      />
    ));
    // First tap: the chip enters its visible confirm — nothing sent yet.
    fireEvent.click(screen.getByTestId("ambiguous-replace"));
    await vi.waitFor(() => expect(screen.getByTestId("ambiguous-stale-confirm")).toBeTruthy());
    expect(enqueue).not.toHaveBeenCalled();
    // "Send anyway": the controller re-verifies against the first-tap head
    // (unchanged) → admits the replacement (a NEW intentId, one enqueue).
    fireEvent.click(screen.getByTestId("ambiguous-replace-anyway"));
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const wireIntent = (enqueue.mock.calls[0] as any[])[1].intentId as string;
    expect(wireIntent).toBeTruthy();
    expect(wireIntent).not.toBe("i-orig");
    // The real outbox overlay (requestReplacement) flips the chip's state.
    await vi.waitFor(() =>
      expect(screen.getByTestId("ambiguous-chip").getAttribute("data-state")).toBe("replacement-requested"),
    );
  });

  it("A1: tap → stale-confirm → head moves AGAIN during the confirm → Send anyway is refused (no enqueue, chip stays actionable)", async () => {
    let live = head("s1", "m-1", 2);
    const { ctl, enqueue } = await armRealController(() => live);
    const q = ambiguousItem();
    render(() => (
      <AmbiguousChip
        q={q}
        onTap={(x) => ctl.tap(x)}
        onReplace={(x) => void ctl.replace(x)}
        replacementRequested={() => !!replacementRequestedFor(q.intentId)}
        onRemove={() => {}}
      />
    ));
    fireEvent.click(screen.getByTestId("ambiguous-replace"));
    await vi.waitFor(() => expect(screen.getByTestId("ambiguous-stale-confirm")).toBeTruthy());
    live = head("s1", "m-2", 3); // drift DURING the confirm window
    fireEvent.click(screen.getByTestId("ambiguous-replace-anyway"));
    // Refused loudly by the controller: no enqueue, no replacement overlay —
    // the chip is back to its actionable state (Send new message again).
    await vi.waitFor(() => expect(screen.getByTestId("ambiguous-replace")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 25)); // let any stray async settle
    expect(enqueue).not.toHaveBeenCalled();
    expect(screen.getByTestId("ambiguous-chip").getAttribute("data-state")).toBe("active");
  });
});
