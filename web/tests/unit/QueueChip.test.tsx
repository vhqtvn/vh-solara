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
// `unknown` items, that its absence is graceful, and that other terminal
// states do NOT show the recovery note. The GC-4 dismissal coverage pins that
// the dismiss (x) button shows for pending and terminal failed/unknown
// (never dispatching), and that clicking it calls onRemove with the correct
// item id. Slice 3 (intent recovery) ADDS the Retry affordance for OUTCOME-
// UNKNOWN items that retained their claim-minted opencodeMsgID — a
// same-messageID re-send (idempotent on opencode ≥ 1.17.18), explicit
// user-driven only. `failed` items get NO retry (the resolve matrix rejects
// failed→sent, so a successful retry could never be recorded), and items
// WITHOUT a messageID (legacy) get none either — their recovery stays
// retract-with-warning + dismiss.
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
    // The detail text is present in the rendered DOM (not only in data-tip),
    // verbatim as its lead — O2 appends the standing check-transcript
    // instruction after it (the dispatch may have been delivered).
    const note = container.querySelector(".queue-detail-note");
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain(RECOVERY_DETAIL);
    expect(note!.textContent).toContain("check the transcript before sending it again");
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
    // The honest outcome-unknown label is still shown (send-reliability slice 3
    // wording: never imply "didn't send").
    expect(container.querySelector(".queue-state")!.textContent).toBe("Outcome unknown");
  });

  it("shows the failure CAUSE visibly for a `failed` item (O2 single-owner prerequisite for suppressing the covered notification)", () => {
    // O2 slice 1: the chip is the ONE persistent owner of a dispatch outcome,
    // so its cause must be readable without hovering — the covered
    // "Queued message failed to send" notification-history entry is
    // suppressed only because this note exists.
    const { container } = render(() => (
      <QueueChip q={item({ state: "failed", detail: "pre-POST gate: agent unresolved (timeout) — nothing was sent" })} onRemove={vi.fn()} />
    ));
    const note = container.querySelector(".queue-detail-note");
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain("pre-POST gate: agent unresolved");
    // No unknown-style check-transcript suffix on a definitive failure.
    expect(note!.textContent).not.toContain("check the transcript");
  });

  it("an `unknown` item's visible note appends the standing check-transcript instruction (non-reconcile-terminal)", () => {
    const { container } = render(() => (
      <QueueChip q={item({ state: "unknown", detail: "proxy 502 (outcome unknown): upstream unreachable" })} onRemove={vi.fn()} />
    ));
    const note = container.querySelector(".queue-detail-note");
    expect(note!.textContent).toContain("proxy 502 (outcome unknown)");
    expect(note!.textContent).toContain("it may have been delivered; check the transcript before sending it again");
  });

  it("a reconcile give-up (`unknown` + reconcileTerminal) keeps its own manual-review detail WITHOUT the check-transcript suffix", () => {
    const { container } = render(() => (
      <QueueChip
        q={item({
          state: "unknown",
          reconcileTerminal: true,
          detail: "Reconcile terminal: OpenCode was unreachable …; manual review advised.",
        })}
        onRemove={vi.fn()}
      />
    ));
    const note = container.querySelector(".queue-detail-note");
    expect(note!.textContent).toContain("Reconcile terminal");
    expect(note!.textContent).not.toContain("check the transcript");
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
  // (Slice 3 ADDS retry for UNKNOWN items WITH a retained opencodeMsgID +
  // wired handler — see the retry describe block below. The count pins here
  // use fixtures WITHOUT a messageID/handler, i.e. the pre-slice action set.)
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

  it("renders NO retry (and no other revival affordance) when the item lacks a correlation id or the handler is unwired", () => {
    // Slice 3 contract update: the Retry affordance exists ONLY for terminal
    // failed/unknown items that retained their claim-minted opencodeMsgID AND
    // have a wired handler (the identical-messageID resend is what makes
    // revival safe — idempotent on opencode ≥ 1.17.18). This fixture — the
    // pre-slice shape (legacy item, no handler wired) — must keep rendering
    // no resend/retry surface: its honest recovery is retract-with-warning.
    const r = render(() => (
      <QueueChip
        q={item({ state: "unknown", detail: RECOVERY_DETAIL })}
        onRemove={vi.fn()}
        onRetract={vi.fn()}
        onMarkSent={vi.fn()}
      />
    ));
    expect(r.container.querySelector(".queue-retry")).toBeNull();
    const txt = r.container.textContent!.toLowerCase();
    expect(txt).not.toContain("resend");
    expect(txt).not.toContain("retry");
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Slice 3 (intent recovery, 2026-10-03 incident) — the Retry affordance.
// An OUTCOME-UNKNOWN item that retained its claim-minted opencodeMsgID gets
// an explicit, user-driven Retry action: the handler re-sends the IDENTICAL
// payload under the SAME messageID (caller-id-wins on opencode ≥ 1.17.18 —
// no duplicate persist if the first dispatch landed). The tooltip states the
// version boundary honestly. NEVER automatic (no timer/loop). `failed`
// items NEVER get the affordance (t1a-F2/t1b-F1: the resolve matrix rejects
// failed→sent — a successful retry could never be recorded; failed proves
// non-delivery, so retract is the honest recovery).
// ---------------------------------------------------------------------------
describe("QueueChip — retry action (slice 3: explicit same-messageID re-send)", () => {
  it("renders retry for `unknown` items WITH an opencodeMsgID + handler — NEVER for `failed` (t1a-F2: resolve matrix rejects failed→sent), pending/dispatching, legacy, or unwired", () => {
    const withId = { opencodeMsgID: "msg_retry_abc" };
    // t1a-F2 chip-seam pin: a terminal `failed` item WITH a correlation id
    // AND a wired handler still gets NO retry affordance — unknown-only is
    // the contract (a failed retry that succeeded could never be recorded;
    // `failed` proves non-delivery, so retract is the honest recovery).
    const failed = render(() => (
      <QueueChip q={item({ state: "failed", ...withId })} onRemove={vi.fn()} onRetry={vi.fn()} />
    ));
    expect(failed.container.querySelector(".queue-retry")).toBeNull();
    failed.unmount();

    const unknown = render(() => (
      <QueueChip q={item({ state: "unknown", ...withId })} onRemove={vi.fn()} onRetry={vi.fn()} />
    ));
    expect(unknown.container.querySelector(".queue-retry")).toBeTruthy();
    unknown.unmount();

    // Non-terminal states never retry.
    for (const state of ["pending", "dispatching"] as const) {
      const r = render(() => (
        <QueueChip q={item({ state, ...withId })} onRemove={vi.fn()} onRetry={vi.fn()} />
      ));
      expect(r.container.querySelector(".queue-retry")).toBeNull();
      r.unmount();
    }

    // Terminal but legacy (no messageID): no idempotent resend exists.
    const legacy = render(() => (
      <QueueChip q={item({ state: "unknown" })} onRemove={vi.fn()} onRetry={vi.fn()} />
    ));
    expect(legacy.container.querySelector(".queue-retry")).toBeNull();
    legacy.unmount();

    // Handler unwired (progressive rollout): the affordance stays hidden.
    const unwired = render(() => (
      <QueueChip q={item({ state: "unknown", ...withId })} onRemove={vi.fn()} />
    ));
    expect(unwired.container.querySelector(".queue-retry")).toBeNull();
    unwired.unmount();
  });

  it("clicking retry calls onRetry with the WHOLE item (the handler revalidates + re-sends by item.opencodeMsgID)", () => {
    const onRetry = vi.fn();
    const q = item({
      id: "q-retry-9",
      state: "unknown",
      text: "the lost prompt",
      detail: "OpenCode is down — message not sent",
      opencodeMsgID: "msg_retry_9",
    });
    const { container } = render(() => (
      <QueueChip q={q} onRemove={vi.fn()} onRetry={onRetry} />
    ));
    container.querySelector<HTMLElement>(".queue-retry")!.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(q);
  });

  it("the retry tooltip states the version safety boundary honestly (idempotent on ≥ 1.17.18; older may duplicate)", () => {
    const { container } = render(() => (
      <QueueChip q={item({ state: "unknown", opencodeMsgID: "msg_t" })} onRemove={vi.fn()} onRetry={vi.fn()} />
    ));
    const btn = container.querySelector(".queue-retry")!;
    const tip = (btn.getAttribute("data-tip")! + " " + btn.getAttribute("aria-label")!).toLowerCase();
    expect(tip).toContain("same message id");
    expect(tip).toContain("1.17.18");
    expect(tip).toContain("duplicate");
  });
});

describe("QueueChip — dismiss click handler (FIX-QUEUE-GC-4)", () => {
  it("clicking dismiss on a pending item calls onRemove with the item id", () => {
    const onRemove = vi.fn();
    const { container } = render(() => (
      <QueueChip q={item({ id: "q-42", state: "pending" })} onRemove={onRemove} />
    ));
    container.querySelector<HTMLElement>(".queue-dismiss")!.click();
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
    container.querySelector<HTMLElement>(".queue-dismiss")!.click();
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
    container.querySelector<HTMLElement>(".queue-dismiss")!.click();
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
    container.querySelector<HTMLElement>(".queue-retract")!.click();
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
    container.querySelector<HTMLElement>(".queue-mark-sent")!.click();
    expect(onMarkSent).toHaveBeenCalledTimes(1);
    expect(onMarkSent).toHaveBeenCalledWith(q);
  });
});
