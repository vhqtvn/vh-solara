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

describe("QueueChip — action visibility per state (dismiss / retract / mark-sent)", () => {
  // Bug 1 / Bug 2: terminal chips offer distinct recovery actions instead of
  // only a dismiss "x". Each action has an explicit accessible label so the
  // operator can RECOVER a misclassified send rather than cancel + re-type.
  //
  //   pending     → dismiss only (cancel before dispatch)
  //   dispatching → NO action (non-removable; the state machine owns the
  //                 transition to terminal)
  //   failed      → retract + dismiss (2 actions)
  //   unknown     → mark-sent + retract + dismiss (3 actions)
  //   sent        → filtered upstream (queueFor), no chip
  it("renders ONE action (dismiss) for pending; NONE for dispatching", () => {
    const r1 = render(() => (
      <QueueChip q={item({ state: "pending" })} onRemove={vi.fn()} />
    ));
    expect(r1.container.querySelectorAll(".queue-chip button").length).toBe(1);
    expect(r1.container.querySelector(".queue-chip button")!.getAttribute("aria-label")).toBe("Remove queued message");
    r1.unmount();

    const r2 = render(() => (
      <QueueChip q={item({ state: "dispatching" })} onRemove={vi.fn()} />
    ));
    expect(r2.container.querySelectorAll(".queue-chip button").length).toBe(0);
    r2.unmount();
  });

  it("renders retract + dismiss (2 actions) for a `failed` chip", () => {
    const r = render(() => (
      <QueueChip
        q={item({ state: "failed", detail: "500 upstream" })}
        onRemove={vi.fn()}
        onRetract={vi.fn()}
      />
    ));
    const btns = r.container.querySelectorAll(".queue-chip button");
    expect(btns.length).toBe(2);
    // No mark-sent for failed (mark-sent is unknown-only).
    expect(r.container.querySelector(".queue-mark-sent")).toBeNull();
    r.unmount();
  });

  it("renders mark-sent + retract + dismiss (3 actions) for an `unknown` chip", () => {
    const r = render(() => (
      <QueueChip
        q={item({ state: "unknown", detail: RECOVERY_DETAIL })}
        onRemove={vi.fn()}
        onRetract={vi.fn()}
        onMarkSent={vi.fn()}
      />
    ));
    const btns = r.container.querySelectorAll(".queue-chip button");
    expect(btns.length).toBe(3);
    // All three distinct classes present.
    expect(r.container.querySelector(".queue-mark-sent")).toBeTruthy();
    expect(r.container.querySelector(".queue-retract")).toBeTruthy();
    expect(r.container.querySelector(".queue-dismiss")).toBeTruthy();
    r.unmount();
  });

  it("retract/mark-sent are NO-OPs (not rendered) when their callbacks are omitted", () => {
    // Only onRemove supplied → even a terminal chip shows just dismiss. This
    // keeps the component safe to mount from call sites that haven't wired the
    // recovery handlers yet (progressive rollout).
    const r = render(() => (
      <QueueChip q={item({ state: "unknown", detail: RECOVERY_DETAIL })} onRemove={vi.fn()} />
    ));
    expect(r.container.querySelectorAll(".queue-chip button").length).toBe(1);
    expect(r.container.querySelector(".queue-retract")).toBeNull();
    expect(r.container.querySelector(".queue-mark-sent")).toBeNull();
    r.unmount();
  });

  it("NEVER renders a resend/retry affordance for any state", () => {
    // Recovery means compose a NEW message (retract) or acknowledge an
    // already-sent one (mark-sent) — never reviving this item. No button or
    // label may read "resend"/"retry".
    const r = render(() => (
      <QueueChip
        q={item({ state: "unknown", detail: RECOVERY_DETAIL })}
        onRemove={vi.fn()}
        onRetract={vi.fn()}
        onMarkSent={vi.fn()}
      />
    ));
    const txt = r.container.textContent!.toLowerCase();
    expect(txt).not.toContain("resend");
    expect(txt).not.toContain("retry");
    r.unmount();
  });
});

describe("QueueChip — dismiss click handler (FIX-QUEUE-GC-4)", () => {
  it("clicking dismiss on a pending item calls onRemove with the item id", () => {
    const onRemove = vi.fn();
    const { container } = render(() => (
      <QueueChip q={item({ id: "q-42", state: "pending" })} onRemove={onRemove} />
    ));
    container.querySelector(".queue-dismiss")!.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("q-42");
  });

  it("clicking dismiss on a failed item calls onRemove with the item id (terminal dismissal)", () => {
    const onRemove = vi.fn();
    const { container } = render(() => (
      <QueueChip
        q={item({ id: "q-failed-1", state: "failed", detail: "500 upstream" })}
        onRemove={onRemove}
        onRetract={vi.fn()}
      />
    ));
    container.querySelector(".queue-dismiss")!.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("q-failed-1");
  });

  it("clicking dismiss on an unknown item calls onRemove with the item id (recovered-item dismissal)", () => {
    const onRemove = vi.fn();
    const { container } = render(() => (
      <QueueChip
        q={item({ id: "q-unknown-1", state: "unknown", detail: RECOVERY_DETAIL })}
        onRemove={onRemove}
        onRetract={vi.fn()}
        onMarkSent={vi.fn()}
      />
    ));
    container.querySelector(".queue-dismiss")!.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("q-unknown-1");
  });
});

describe("QueueChip — retract action (Bug 1: retract-to-compose)", () => {
  it("renders a retract button for failed AND unknown — NOT for pending/dispatching", () => {
    const failed = render(() => (
      <QueueChip q={item({ state: "failed" })} onRemove={vi.fn()} onRetract={vi.fn()} />
    ));
    expect(failed.container.querySelector(".queue-retract")).toBeTruthy();
    failed.unmount();

    const unknown = render(() => (
      <QueueChip q={item({ state: "unknown" })} onRemove={vi.fn()} onRetract={vi.fn()} />
    ));
    expect(unknown.container.querySelector(".queue-retract")).toBeTruthy();
    unknown.unmount();

    const pending = render(() => (
      <QueueChip q={item({ state: "pending" })} onRemove={vi.fn()} onRetract={vi.fn()} />
    ));
    expect(pending.container.querySelector(".queue-retract")).toBeNull();
    pending.unmount();

    const dispatching = render(() => (
      <QueueChip q={item({ state: "dispatching" })} onRemove={vi.fn()} onRetract={vi.fn()} />
    ));
    expect(dispatching.container.querySelector(".queue-retract")).toBeNull();
    dispatching.unmount();
  });

  it("clicking retract calls onRetract with the WHOLE item (not just the id)", () => {
    const onRetract = vi.fn();
    const q = item({ id: "q-ret-1", state: "failed", text: "the message", detail: "500" });
    const { container } = render(() => (
      <QueueChip q={q} onRemove={vi.fn()} onRetract={onRetract} />
    ));
    container.querySelector(".queue-retract")!.click();
    expect(onRetract).toHaveBeenCalledTimes(1);
    expect(onRetract).toHaveBeenCalledWith(q);
  });

  it("unknown retract carries a DUPLICATE-RISK warning in its label/tip; failed retract does not", () => {
    // `unknown` may have already landed → re-sending can duplicate. The retract
    // affordance must surface that risk before the operator re-sends.
    const unknown = render(() => (
      <QueueChip q={item({ state: "unknown" })} onRemove={vi.fn()} onRetract={vi.fn()} />
    ));
    const unknownTip = unknown.container.querySelector(".queue-retract")!.getAttribute("data-tip")!;
    expect(unknownTip.toLowerCase()).toContain("duplicate");
    unknown.unmount();

    const failed = render(() => (
      <QueueChip q={item({ state: "failed" })} onRemove={vi.fn()} onRetract={vi.fn()} />
    ));
    const failedTip = failed.container.querySelector(".queue-retract")!.getAttribute("data-tip")!;
    expect(failedTip.toLowerCase()).not.toContain("duplicate");
    failed.unmount();
  });
});

describe("QueueChip — mark-sent action (Bug 2: manual mark-sent for unknown)", () => {
  it("renders a mark-sent button for unknown ONLY", () => {
    const unknown = render(() => (
      <QueueChip q={item({ state: "unknown" })} onRemove={vi.fn()} onMarkSent={vi.fn()} />
    ));
    expect(unknown.container.querySelector(".queue-mark-sent")).toBeTruthy();
    unknown.unmount();

    for (const state of ["pending", "dispatching", "failed"] as const) {
      const r = render(() => (
        <QueueChip q={item({ state })} onRemove={vi.fn()} onMarkSent={vi.fn()} />
      ));
      expect(r.container.querySelector(".queue-mark-sent")).toBeNull();
      r.unmount();
    }
  });

  it("the mark-sent guidance copy tells the operator to only use it when the message is in the transcript", () => {
    const { container } = render(() => (
      <QueueChip q={item({ state: "unknown" })} onRemove={vi.fn()} onMarkSent={vi.fn()} />
    ));
    const btn = container.querySelector(".queue-mark-sent")!;
    const tip = (btn.getAttribute("data-tip")! + " " + btn.getAttribute("aria-label")!).toLowerCase();
    expect(tip).toContain("transcript");
  });

  it("clicking mark-sent calls onMarkSent with the WHOLE item (not just the id)", () => {
    const onMarkSent = vi.fn();
    const q = item({ id: "q-ms-1", state: "unknown", text: "maybe it sent" });
    const { container } = render(() => (
      <QueueChip q={q} onRemove={vi.fn()} onMarkSent={onMarkSent} />
    ));
    container.querySelector(".queue-mark-sent")!.click();
    expect(onMarkSent).toHaveBeenCalledTimes(1);
    expect(onMarkSent).toHaveBeenCalledWith(q);
  });
});
