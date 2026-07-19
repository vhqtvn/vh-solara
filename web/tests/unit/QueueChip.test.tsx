// @vitest-environment jsdom
//
// QueueChip — rendering of the composer queue pill, focused on the recovery
// detail surfacing for recovered `unknown` items (FIX-QUEUE-STUCK-2).
//
// The backend (pkg/web/queue.go: recoverStaleDispatchingLocked) transitions
// abandoned `dispatching` items to terminal `unknown` on List() load and sets
// their `detail` to staleDispatchRecoveryDetail: a human-readable explanation
// including the duplicate-risk warning. These tests pin the SPA contract that
// the detail is surfaced VISIBLELY (not only in the data-tip tooltip) for
// `unknown` items, that its absence is graceful, that other terminal states do
// NOT show the recovery note, and that no resend/retry button is ever rendered
// for terminal items (recovery = operator composes a NEW message).
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
      <QueueChip q={item({ state: "unknown", detail: RECOVERY_DETAIL })} sessionId="s1" onRemove={onRemove} />
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
      <QueueChip q={item({ state: "unknown", detail: "" })} sessionId="s1" onRemove={vi.fn()} />
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
      <QueueChip q={item({ state: "failed", detail: "500 upstream" })} sessionId="s1" onRemove={vi.fn()} />
    ));
    expect(container.querySelector(".queue-detail-note")).toBeNull();
    expect(container.textContent).not.toContain("Recovery:");
  });

  it("does NOT show the recovery detail for a `sent`-equivalent happy path (dispatching)", () => {
    // `sent` is filtered from the visible queue upstream (queueFor), so the
    // realistic non-terminal here is `dispatching`. No recovery note renders.
    const { container } = render(() => (
      <QueueChip q={item({ state: "dispatching" })} sessionId="s1" onRemove={vi.fn()} />
    ));
    expect(container.querySelector(".queue-detail-note")).toBeNull();
  });
});

describe("QueueChip — no resend/retry button for terminal items", () => {
  it("renders a remove (x) button ONLY for pending items — never for terminal unknown/failed", () => {
    // pending: the one removable state — has a remove button.
    const r1 = render(() => (
      <QueueChip q={item({ state: "pending" })} sessionId="s1" onRemove={vi.fn()} />
    ));
    expect(r1.container.querySelectorAll(".queue-chip button").length).toBe(1);
    expect(r1.container.querySelector(".queue-chip button")!.getAttribute("aria-label")).toBe("Remove queued message");
    r1.unmount();

    // unknown (terminal): NO remove button, NO resend button.
    const r2 = render(() => (
      <QueueChip q={item({ state: "unknown", detail: RECOVERY_DETAIL })} sessionId="s1" onRemove={vi.fn()} />
    ));
    expect(r2.container.querySelectorAll(".queue-chip button").length).toBe(0);
    // No "resend"/"retry" affordance anywhere in the rendered output.
    const txt = r2.container.textContent!.toLowerCase();
    expect(txt).not.toContain("resend");
    expect(txt).not.toContain("retry");
    r2.unmount();

    // failed (terminal): NO remove button, NO resend button.
    const r3 = render(() => (
      <QueueChip q={item({ state: "failed", detail: "x" })} sessionId="s1" onRemove={vi.fn()} />
    ));
    expect(r3.container.querySelectorAll(".queue-chip button").length).toBe(0);
    r3.unmount();
  });

  it("the remove button on a pending item calls onRemove with the item id (no re-enqueue)", () => {
    const onRemove = vi.fn();
    const { container } = render(() => (
      <QueueChip q={item({ id: "q-42", state: "pending" })} sessionId="s1" onRemove={onRemove} />
    ));
    container.querySelector(".queue-chip button")!.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("q-42");
  });
});
