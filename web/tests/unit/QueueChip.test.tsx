// @vitest-environment jsdom
//
// QueueChip — rendering of the composer queue pill, focused on the recovery
// detail surfacing for recovered `unknown` items (FIX-QUEUE-STUCK-2) and the
// terminal-item dismissal button (FIX-QUEUE-GC-4).
//
// The backend (pkg/web/queue.go: recoverStaleDispatchingLocked) transitions
// abandoned `dispatching` items to terminal `unknown` on List() load and sets
// their `detail` to staleDispatchRecoveryDetail: a human-readable explanation
// including the duplicate-risk warning. These tests pin the SPA contract that
// the detail is surfaced VISIBLELY (not only in the data-tip tooltip) for
// `unknown` items, that its absence is graceful, that other terminal states do
// NOT show the recovery note, and that no resend/retry button is ever rendered
// for terminal items (recovery = operator composes a NEW message). The GC-4
// dismissal coverage pins that the dismiss (x) button shows for pending and
// terminal failed/unknown (never dispatching), and that clicking it calls
// onRemove with the correct item id.
//
// The data-layer contract (cache, resolve, claim) is pinned in queue.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { QueueChip } from "../../src/components/QueueChip";
import type { QueuedMessage } from "../../src/queue";

// Matches the current backend staleDispatchRecoveryDetail wording for realism;
// this test verifies the component renders q.detail verbatim — it is NOT a
// backend-drift detector (the backend constant is not invoked here).
const RECOVERY_DETAIL =
  "Recovery: dispatch was interrupted and could not be confirmed. The prompt may have reached OpenCode; sending it again may duplicate work.";

afterEach(() => {
  cleanup();
});

function item(opts: Partial<QueuedMessage>): QueuedMessage {
  return {
    id: "q-1",
    order: 0,
    state: "unknown",
    text: "do the thing",
    attachments: [],
    createdAt: 1,
    resolvedAt: 1,
    detail: "",
    ...opts,
  };
}

describe("QueueChip — recovered `unknown` detail surfacing", () => {
  it("renders the backend detail visibly for an `unknown` item with detail", () => {
    const onRemove = vi.fn();
    const { container } = render(() => (
      <QueueChip q={item({ state: "unknown", detail: RECOVERY_DETAIL })} onRemove={onRemove} />
    ));
    // The detail text is present in the rendered DOM (not only in data-tip).
    const note = container.querySelector(".queue-detail-note");
    expect(note).toBeTruthy();
    expect(note!.textContent).toBe(RECOVERY_DETAIL);
    // Visible: it is a real text node, surfaced as a sibling of the chip.
    expect(container.textContent).toContain(RECOVERY_DETAIL);
  });

  it("renders gracefully when an `unknown` item has NO detail (edge case: pre-STUCK-1 or recovery without detail)", () => {
    const { container } = render(() => (
      <QueueChip q={item({ state: "unknown", detail: "" })} onRemove={vi.fn()} />
    ));
    // No detail note rendered; no crash; the chip still shows the state label.
    expect(container.querySelector(".queue-detail-note")).toBeNull();
    const chip = container.querySelector(".queue-chip");
    expect(chip).toBeTruthy();
    expect(chip!.getAttribute("data-state")).toBe("unknown");
    // The Unknown label is still shown.
    expect(container.querySelector(".queue-state")!.textContent).toBe("Unknown");
  });

  it("does NOT show the recovery detail for a `failed` item (only `unknown` surfaces recovery)", () => {
    // A failed item may carry its own detail (the failure reason), but that is
    // NOT the recovery note and is out of scope for STUCK-2: failed detail stays
    // in the data-tip tooltip only. The visible recovery note must not appear.
    const { container } = render(() => (
      <QueueChip q={item({ state: "failed", detail: "500 upstream" })} onRemove={vi.fn()} />
    ));
    expect(container.querySelector(".queue-detail-note")).toBeNull();
    expect(container.textContent).not.toContain("Recovery:");
  });

  it("does NOT show the recovery detail for a `sent`-equivalent happy path (dispatching)", () => {
    // `sent` is filtered from the visible queue upstream (queueFor), so the
    // realistic non-terminal here is `dispatching`. No recovery note renders.
    const { container } = render(() => (
      <QueueChip q={item({ state: "dispatching" })} onRemove={vi.fn()} />
    ));
    expect(container.querySelector(".queue-detail-note")).toBeNull();
  });
});

describe("QueueChip — dismiss button visibility + click handler (FIX-QUEUE-GC-4)", () => {
  // FIX-QUEUE-GC-4: operators may explicitly dismiss terminal items
  // (failed/unknown) that would otherwise accumulate forever. The dismiss
  // (remove x) button shows for `pending` (cancel) and terminal
  // `failed`/`unknown` (dismiss); it is NEVER shown for `dispatching` (the
  // dispatch may be in flight — the state machine must own the terminal
  // transition first). `sent` is filtered from the visible queue upstream
  // (queueFor), so no dismiss surface is needed for it.
  it("renders a dismiss (x) button for pending, failed, unknown — NOT for dispatching", () => {
    // pending: dismissable (cancel before dispatch).
    const r1 = render(() => (
      <QueueChip q={item({ state: "pending" })} onRemove={vi.fn()} />
    ));
    expect(r1.container.querySelectorAll(".queue-chip button").length).toBe(1);
    expect(r1.container.querySelector(".queue-chip button")!.getAttribute("aria-label")).toBe("Remove queued message");
    r1.unmount();

    // failed (terminal): dismissable — clears the failed chip from view.
    const r2 = render(() => (
      <QueueChip q={item({ state: "failed", detail: "500 upstream" })} onRemove={vi.fn()} />
    ));
    expect(r2.container.querySelectorAll(".queue-chip button").length).toBe(1);
    r2.unmount();

    // unknown (terminal): dismissable — clears the recovered chip from view.
    const r3 = render(() => (
      <QueueChip q={item({ state: "unknown", detail: RECOVERY_DETAIL })} onRemove={vi.fn()} />
    ));
    expect(r3.container.querySelectorAll(".queue-chip button").length).toBe(1);
    // No "resend"/"retry" affordance anywhere in the rendered output — the
    // only button is the dismiss (x), never a resend.
    const txt = r3.container.textContent!.toLowerCase();
    expect(txt).not.toContain("resend");
    expect(txt).not.toContain("retry");
    r3.unmount();

    // dispatching: NOT dismissable — the dispatch may be in flight; the state
    // machine must own the transition to terminal first.
    const r4 = render(() => (
      <QueueChip q={item({ state: "dispatching" })} onRemove={vi.fn()} />
    ));
    expect(r4.container.querySelectorAll(".queue-chip button").length).toBe(0);
    r4.unmount();
  });

  it("clicking dismiss on a pending item calls onRemove with the item id", () => {
    const onRemove = vi.fn();
    const { container } = render(() => (
      <QueueChip q={item({ id: "q-42", state: "pending" })} onRemove={onRemove} />
    ));
    container.querySelector(".queue-chip button")!.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("q-42");
  });

  it("clicking dismiss on a failed item calls onRemove with the item id (terminal dismissal)", () => {
    const onRemove = vi.fn();
    const { container } = render(() => (
      <QueueChip q={item({ id: "q-failed-1", state: "failed", detail: "500 upstream" })} onRemove={onRemove} />
    ));
    container.querySelector(".queue-chip button")!.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("q-failed-1");
  });

  it("clicking dismiss on an unknown item calls onRemove with the item id (recovered-item dismissal)", () => {
    const onRemove = vi.fn();
    const { container } = render(() => (
      <QueueChip q={item({ id: "q-unknown-1", state: "unknown", detail: RECOVERY_DETAIL })} onRemove={onRemove} />
    ));
    container.querySelector(".queue-chip button")!.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("q-unknown-1");
  });
});
