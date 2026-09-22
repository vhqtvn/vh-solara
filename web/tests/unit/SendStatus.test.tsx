// @vitest-environment jsdom
//
// SendStatus — the send-reliability slice-3 status surface (brief §4.4 copy
// matrix is normative). These tests pin:
//   - the per-stage readable copy (never glow-only),
//   - the retry taxonomy: "Retry send" ONLY for uncertain ENQUEUE outcomes
//     (recovery retry-same, server-deduped replay); "Outcome unknown — check
//     before sending again." (NO retry button) for every other uncertainty;
//     "Retry status save" (a record, never a resend) for the unsaved stage,
//   - the payload surfacing on retry-same (what a verbatim replay will send)
//     and the RECORD-ADDRESSED retry wiring (the row button carries ITS
//     attemptId — O2 slice-1 review A-F1),
//   - that the server-custody sentence is GONE (O2 §3.6/§4, review A-F2):
//     no queue state renders "Queued — waiting for connection." — the queue
//     container/QueueChip owns custody;
//   - the polite live region, and dismissal of retained records.
//
// The queue module is mocked (queueFor / resolveQueued) — the data-layer
// contracts themselves are pinned in queue.test.ts / sendStuckRecovery.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { SendStatus } from "../../src/components/chat/SendStatus";
import {
  __resetSendActionStatusForTests,
  getSendAction,
  markOwnerSessionCreateUnknown,
  markSendAttemptStatusUnsaved,
  mintSendAttempt,
  sendActionsFor,
  updateSendAction,
} from "../../src/lib/sendActionStatus";
import type { QueuedMessage } from "../../src/queue";

vi.mock("../../src/queue", () => ({
  queueFor: vi.fn(() => []),
  resolveQueued: vi.fn(async () => ({ kind: "recorded" })),
}));

import { queueFor, resolveQueued } from "../../src/queue";

const queueForMock = vi.mocked(queueFor);
const resolveQueuedMock = vi.mocked(resolveQueued);

// Minimal-but-valid QueuedMessage builder for the custody-line-gone cells —
// only the fields the old custody predicate inspected vary per call (the
// sentence must stay gone for EVERY one of them).
function fakeQueueItem(over: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "q1",
    order: 0,
    state: "pending",
    text: "hi",
    attachments: [],
    createdAt: 0,
    ...over,
  };
}

function baseProps(over: Partial<Parameters<typeof SendStatus>[0]> = {}) {
  return {
    sessionId: () => "s1",
    draft: () => false,
    send: vi.fn(async () => {}),
    uploadProgress: () => null as { done: number; total: number } | null,
    ...over,
  };
}

beforeEach(() => {
  queueForMock.mockImplementation(() => []);
  resolveQueuedMock.mockImplementation(async () => ({ kind: "recorded" } as const));
});

afterEach(() => {
  cleanup();
  __resetSendActionStatusForTests();
  vi.clearAllMocks();
});

describe("SendStatus — per-stage readable copy (brief §4.4)", () => {
  it("renders nothing when there are no records", () => {
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.querySelector(".sendStatus")).toBeNull();
    r.unmount();
  });

  it("preparing with upload progress renders 'Uploading 1 of 2…' as readable text", () => {
    mintSendAttempt("s1");
    const r = render(() => (
      <SendStatus {...baseProps({ uploadProgress: () => ({ done: 0, total: 2 }) })} />
    ));
    expect(r.container.textContent).toContain("Uploading 1 of 2…");
    r.unmount();
  });

  it("admitting renders 'Sending…'; a RETRY of an uncertain admission renders 'Retrying queue confirmation…'", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "admitting" });
    const r1 = render(() => <SendStatus {...baseProps()} />);
    expect(r1.container.textContent).toContain("Sending…");
    r1.unmount();

    const b = mintSendAttempt("s1");
    updateSendAction(b.attemptId, { stage: "admitting", retry: true });
    const r2 = render(() => <SendStatus {...baseProps()} />);
    expect(r2.container.textContent).toContain("Retrying queue confirmation…");
    r2.unmount();
  });

  it("rejected / blocked render a persistent definitive notice (composer retains the payload)", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "rejected", certainty: "definitive", recovery: "restore", detail: "queue full" });
    const r1 = render(() => <SendStatus {...baseProps()} />);
    expect(r1.container.textContent).toContain("Not sent — kept in the composer.");
    r1.unmount();

    const b = mintSendAttempt("s1");
    updateSendAction(b.attemptId, { stage: "blocked", certainty: "definitive", recovery: "restore", detail: "upload failed" });
    const r2 = render(() => <SendStatus {...baseProps()} />);
    expect(r2.container.textContent).toContain("Not sent — kept in the composer.");
    r2.unmount();
  });

  it("conflict renders the honest stop-state copy", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "conflict", certainty: "definitive", recovery: "check", detail: "queue_resolve_conflict" });
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Queue status conflict — check the queue.");
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// O2 slice 1 — reason-specific rejected/blocked copy. The covered
// notification-history entries are suppressed ONLY because these strings
// carry the unique reason/advice each notification used to own (the
// single-owner rule: no fact left homeless).
// ---------------------------------------------------------------------------
describe("SendStatus — O2 reason-specific rejection copy", () => {
  const reasonRow = (reason: Parameters<typeof updateSendAction>[1]["reason"], stage: "rejected" | "blocked" = "rejected") => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage, certainty: "definitive", recovery: "restore", reason });
    return a;
  };

  it("queue-full renders the capacity/removal advice the suppressed notification carried", () => {
    reasonRow("queue-full");
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Not queued — queue is full. Remove a queued message before trying again.");
    r.unmount();
  });

  it("attachments-uploading (blocked) renders the wait instruction", () => {
    reasonRow("attachments-uploading", "blocked");
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Not sent — attachments are still uploading.");
    r.unmount();
  });

  it("attachments-failed (blocked) renders the review-attachments advice", () => {
    reasonRow("attachments-failed", "blocked");
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Not sent — attachment upload was not confirmed. Review the attachment controls before trying again.");
    r.unmount();
  });

  it("agent-unresolved renders the pick-an-agent instruction", () => {
    reasonRow("agent-unresolved");
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Not sent — choose an agent.");
    r.unmount();
  });

  it("session-create-failed renders the create-specific cause", () => {
    reasonRow("session-create-failed");
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Session could not be created.");
    r.unmount();
  });

  it("an untyped rejection keeps the generic fallback (legacy/test-seeded shape)", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "rejected", certainty: "definitive", recovery: "restore" });
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Not sent — kept in the composer.");
    r.unmount();
  });

  it("a create-unknown record (markOwnerSessionCreateUnknown) carries the duplicate-session warning in the row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const a = mintSendAttempt("draft");
    vi.setSystemTime(2_000);
    markOwnerSessionCreateUnknown("draft", "session create timed out", 1_000);
    vi.useRealTimers();
    const r = render(() => <SendStatus {...baseProps({ draft: () => true, sessionId: () => "" })} />);
    expect(r.container.textContent).toContain(
      "Session creation unconfirmed. Check possible sessions before sending again; another send may create another session.",
    );
    // No unqualified Retry on a create ambiguity (check-before-sending).
    expect(r.container.querySelector(".sendStatusBtn")).toBeNull();
    expect(a.stage).toBe("uncertain");
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// O2 slice 1 — status-save precision: the row NAMES the known terminal
// outcome; only the SAVE is unconfirmed (retry-save is never a resend).
// ---------------------------------------------------------------------------
describe("SendStatus — O2 status-save copy precision", () => {
  it("sent outcome → 'Message sent — status save unconfirmed.'", () => {
    markSendAttemptStatusUnsaved("att-psent", "s1", { itemId: "q-1", state: "sent", detail: "ok" });
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Message sent — status save unconfirmed.");
    r.unmount();
  });

  it("failed outcome → 'Send failed — status save unconfirmed.'", () => {
    markSendAttemptStatusUnsaved("att-pfail", "s1", { itemId: "q-2", state: "failed", detail: "boom" });
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Send failed — status save unconfirmed.");
    r.unmount();
  });

  it("unknown outcome → 'Send outcome unknown — status save unconfirmed.'", () => {
    markSendAttemptStatusUnsaved("att-punk", "s1", { itemId: "q-3", state: "unknown", detail: "502" });
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Send outcome unknown — status save unconfirmed.");
    r.unmount();
  });
});

describe("SendStatus — retry taxonomy (never an unqualified Retry)", () => {
  it("uncertain ENQUEUE outcome (retry-same) shows 'Queue confirmation unknown.' + Retry send + the payload it will send", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, {
      stage: "uncertain",
      certainty: "unknown",
      recovery: "retry-same",
      detail: "enqueue timed out",
      payload: {
        tapText: "retry me",
        text: "retry me",
        attachments: [],
        files: ["notes.md", "shot.png"],
      },
    });
    const send = vi.fn(async () => {});
    const r = render(() => <SendStatus {...baseProps({ send })} />);
    expect(r.container.textContent).toContain("Queue confirmation unknown.");
    // O2 §3.6: the guidance sentence names the two honest options…
    expect(r.container.textContent).toContain("Check the queue, or retry this same message.");
    // …and the verbatim payload is SURFACED as "Same message:" (slice-2
    // advisory: a retry re-includes chips removed after the attempt — show
    // what will be sent).
    expect(r.container.textContent).toContain("Same message: “retry me”");
    expect(r.container.textContent).toContain("notes.md");
    expect(r.container.textContent).toContain("shot.png");
    const btn = r.container.querySelector(".sendStatusBtn");
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain("Retry same message");
    btn!.click();
    expect(send).toHaveBeenCalledTimes(1);
    // RECORD-ADDRESSED (O2 review A-F1): the row button carries THIS record's
    // attemptId — the controller replays exactly the clicked record.
    expect(send).toHaveBeenCalledWith(a.attemptId);
    r.unmount();
  });

  it("an attachment-only retry-same payload shows the file list without an empty text quote", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, {
      stage: "uncertain",
      certainty: "unknown",
      recovery: "retry-same",
      payload: { tapText: "", text: "", attachments: [], files: ["chart.png"] },
    });
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).toContain("Same message:");
    expect(r.container.textContent).toContain("chart.png");
    expect(r.container.textContent).not.toContain("“”");
    r.unmount();
  });

  it("other uncertainties (check recovery) show 'Outcome unknown — check before sending again.' with NO retry button", () => {
    // e.g. a session-create outcome-unknown (markOwnerSessionCreateUnknown shape).
    const a = mintSendAttempt("draft");
    updateSendAction(a.attemptId, { stage: "uncertain", certainty: "unknown", recovery: "check", detail: "createSession timed out" });
    const r = render(() => <SendStatus {...baseProps({ draft: () => true, sessionId: () => "" })} />);
    expect(r.container.textContent).toContain("Outcome unknown — check before sending again.");
    expect(r.container.querySelector(".sendStatusBtn")).toBeNull();
    r.unmount();
  });

  it("unsaved resolve-status (sent) shows the precise save-unconfirmed copy + Retry STATUS SAVE (a record, never a resend)", async () => {
    markSendAttemptStatusUnsaved("att-save-1", "s1", { itemId: "q-9", state: "sent", detail: "dispatch ok" });
    const send = vi.fn(async () => {});
    const r = render(() => <SendStatus {...baseProps({ send })} />);
    expect(r.container.textContent).toContain("Message sent — status save unconfirmed.");
    const btn = r.container.querySelector(".sendStatusBtn")!;
    expect(btn.textContent).toContain("Retry status save");
    expect(btn.getAttribute("data-tip")).toContain("does not resend the message");
    btn.click();
    await vi.waitFor(() => expect(resolveQueuedMock).toHaveBeenCalledTimes(1));
    // The retry re-records the SAME terminal outcome — it must NEVER touch the
    // send path.
    expect(resolveQueuedMock).toHaveBeenCalledWith("s1", "q-9", "sent", "dispatch ok");
    expect(send).not.toHaveBeenCalled();
    // Recorded → the retained record is finished (the row clears).
    await vi.waitFor(() => expect(r.container.textContent).not.toContain("status save unconfirmed"));
    expect(getSendAction("att-save-1")).toBeUndefined();
    r.unmount();
  });

  it("an unsaved retry that stays unrecorded keeps the row (honest persistence)", async () => {
    resolveQueuedMock.mockImplementation(async () => ({ kind: "unrecorded" } as const));
    markSendAttemptStatusUnsaved("att-save-2", "s1", { itemId: "q-8", state: "failed", detail: "boom" });
    const r = render(() => <SendStatus {...baseProps()} />);
    r.container.querySelector(".sendStatusBtn")!.click();
    await vi.waitFor(() => expect(resolveQueuedMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(r.container.textContent).toContain("status save unconfirmed"));
    expect(getSendAction("att-save-2")).toBeTruthy();
    r.unmount();
  });

  it("F3: an unsaved retry that hits a RESOLVE CONFLICT surfaces the dismissible conflict row — never a silent vanish", async () => {
    // Slice-3 review F3: when the unsaved record is linked by a real
    // attemptId, the old retrySave finished the record on ANY non-unrecorded
    // outcome — deleting the conflict record resolveQueued had just patched,
    // so the row silently vanished. Now the conflict outcome is visible and
    // honest: the row survives as a dismissible conflict state naming what
    // the surface did (queue refreshed to server truth).
    resolveQueuedMock.mockImplementation(async () => ({ kind: "conflict", detail: "server holds sent" } as const));
    markSendAttemptStatusUnsaved("att-save-3", "s1", { itemId: "q-7", state: "failed", detail: "local fail" });
    const send = vi.fn(async () => {});
    const r = render(() => <SendStatus {...baseProps({ send })} />);
    r.container.querySelector(".sendStatusBtn")!.click();
    await vi.waitFor(() => expect(resolveQueuedMock).toHaveBeenCalledTimes(1));
    // The user SEES the conflict — the row did not disappear. O2 §3.6: both
    // conflict flavors converge on the actionable check-the-queue guidance.
    await vi.waitFor(() => expect(r.container.textContent).toContain("Queue status conflict — check the queue."));
    expect(r.container.querySelector(".sendStatusDismiss")).toBeTruthy();
    expect(send).not.toHaveBeenCalled(); // still never a resend
    // The record survives as the conflict state (server truth shown).
    expect(getSendAction("att-save-3")).toBeTruthy();
    expect(getSendAction("att-save-3")!.stage).toBe("conflict");
    expect(getSendAction("att-save-3")!.conflictSource).toBe("resolve");
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// O2 slice-1 review A-F2 — the server-custody line is GONE. The brief (§3.6
// copy matrix + §4 ownership table) removed "Queued — waiting for
// connection." from SendStatus: the queue container/QueueChip owns server
// custody, ConnectionToast owns transport, and SendStatus no longer receives
// stream state at all (the streamStatus prop chain was removed with the
// line). These cells pin that no queue shape resurrects the sentence. The
// chip-side terminal warning coverage (reconcile give-ups) lives in
// QueueChip.test.tsx and is untouched by this removal.
// ---------------------------------------------------------------------------
describe("SendStatus — server custody line is GONE (O2 §3.6/§4: QueueChip owns custody)", () => {
  it("renders NO custody line for a live session with a pending queue item (any queue state)", () => {
    queueForMock.mockImplementation(() => [fakeQueueItem({ state: "pending" })]);
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.textContent).not.toContain("Queued — waiting for connection.");
    expect(r.container.querySelector('.sendStatusLine[data-kind="custody"]')).toBeNull();
    r.unmount();
  });

  it("renders NO custody line for unknown / dispatching / terminal-reconcile-give-up items — the predicate is gone entirely", () => {
    // The old predicate excluded terminal give-ups and included non-terminal
    // unknowns and in-flight dispatching; removal kills the whole sentence,
    // so EVERY shape that used to render it now renders nothing.
    const shapes: QueuedMessage[] = [
      fakeQueueItem({ state: "unknown", reconcileTerminal: false }),
      fakeQueueItem({ state: "dispatching" }),
      fakeQueueItem({ state: "unknown", reconcileTerminal: true, reconcileAttempts: 3, detail: "Reconcile terminal: …" }),
      fakeQueueItem({ id: "q1", state: "unknown", reconcileTerminal: true }),
      fakeQueueItem({ id: "q2", state: "pending" }),
    ];
    for (const item of shapes) {
      queueForMock.mockImplementation(() => [item]);
      const r = render(() => <SendStatus {...baseProps()} />);
      expect(r.container.textContent).not.toContain("Queued — waiting for connection.");
      expect(r.container.querySelector('.sendStatusLine[data-kind="custody"]')).toBeNull();
      r.unmount();
    }
  });

  it("renders NO custody line for a draft (never called 'queued') and NOTHING at all for an empty queue", () => {
    queueForMock.mockImplementation(() => [fakeQueueItem({ state: "pending" })]);
    const r1 = render(() => <SendStatus {...baseProps({ draft: () => true, sessionId: () => "" })} />);
    expect(r1.container.textContent).not.toContain("Queued");
    r1.unmount();

    queueForMock.mockImplementation(() => []);
    const r2 = render(() => <SendStatus {...baseProps()} />);
    expect(r2.container.querySelector(".sendStatus")).toBeNull();
    r2.unmount();
  });
});

describe("SendStatus — a11y + dismissal", () => {
  it("is a polite live region", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "admitting" });
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.querySelector(".sendStatus")!.getAttribute("aria-live")).toBe("polite");
    r.unmount();
  });

  it("a retained record can be dismissed; a transient one (admitting) offers no dismiss", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "admitting" });
    const r1 = render(() => <SendStatus {...baseProps()} />);
    expect(r1.container.querySelector(".sendStatusDismiss")).toBeNull();
    r1.unmount();

    const b = mintSendAttempt("s1");
    updateSendAction(b.attemptId, { stage: "uncertain", certainty: "unknown", recovery: "retry-same" });
    const r2 = render(() => <SendStatus {...baseProps()} />);
    r2.container.querySelector(".sendStatusDismiss")!.click();
    // The uncertain ROW is gone and its record finished. (Record `a` is still
    // admitting — retained — so the container itself legitimately remains.)
    expect(r2.container.querySelector('.sendStatusLine[data-kind="uncertain"]')).toBeNull();
    expect(r2.container.textContent).not.toContain("Queue confirmation unknown.");
    expect(getSendAction(b.attemptId)).toBeUndefined();
    r2.unmount();
  });
});

// ---------------------------------------------------------------------------
// A1 create-linkage affordance (send-defers study) — the draft view's
// operator-CONFIRMED "a new session may be your last send" linkage. Never a
// silent auto-re-key: the sweep runs only from the affordance's click.
// ---------------------------------------------------------------------------
describe("SendStatus — A1 create-linkage affordance (operator-confirmed, never silent)", () => {
  type SessionLike = { id: string; title?: string; time?: { created?: number } };
  const sessionsOf = (list: SessionLike[]) => () => Object.fromEntries(list.map((s) => [s.id, s]));

  // Seeds one draft-owned create-outcome-unknown record with window
  // [start, end] (fake time owns the mark-time end), then restores real time.
  function seedCreateUnknown(start: number, end: number): string {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const a = mintSendAttempt("draft");
    vi.setSystemTime(end);
    markOwnerSessionCreateUnknown("draft", "session create timed out", start);
    vi.useRealTimers();
    return a.attemptId;
  }

  it("renders the affordance when a session's created time falls inside the create-unknown window; confirm re-keys + navigates", () => {
    const attemptId = seedCreateUnknown(1_000, 2_000);
    const openSession = vi.fn();
    const r = render(() => (
      <SendStatus
        {...baseProps({
          draft: () => true,
          sessionId: () => "",
          sessions: sessionsOf([{ id: "s9", title: "New session", time: { created: 1_500 } }]),
          openSession,
        })}
      />
    ));
    const row = r.container.querySelector('.sendStatusLine[data-kind="create-link"]');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain("Possible sessions — timing is the only match.");
    const btn = row!.querySelector(".sendStatusBtn")!;
    expect(btn.textContent).toMatch(/^Link and open/); // "Link and open it (hh:mm)" — generic title stays generic
    btn.click();
    // Confirm re-keyed the draft-owned record to the candidate session…
    expect(getSendAction(attemptId)?.ownerKey).toBe("s9");
    expect(sendActionsFor("draft")).toHaveLength(0);
    // …and navigated (openSessionChat semantics via the injected callback).
    expect(openSession).toHaveBeenCalledWith("s9");
    r.unmount();
  });

  it("a NON-generic candidate title is surfaced in the button copy", () => {
    seedCreateUnknown(1_000, 2_000);
    const r = render(() => (
      <SendStatus
        {...baseProps({
          draft: () => true,
          sessionId: () => "",
          sessions: sessionsOf([{ id: "s9", title: "Fix login flow", time: { created: 1_500 } }]),
          openSession: () => {},
        })}
      />
    ));
    const btn = r.container.querySelector('.sendStatusLine[data-kind="create-link"] .sendStatusBtn')!;
    expect(btn.textContent).toContain("Fix login flow");
    r.unmount();
  });

  it("NO auto-re-key without the click: an in-window session alone moves nothing", () => {
    const attemptId = seedCreateUnknown(1_000, 2_000);
    const openSession = vi.fn();
    const r = render(() => (
      <SendStatus
        {...baseProps({
          draft: () => true,
          sessionId: () => "",
          sessions: sessionsOf([{ id: "s9", title: "New session", time: { created: 1_500 } }]),
          openSession,
        })}
      />
    ));
    // The affordance is VISIBLE (session landed in-window via SSE)…
    expect(r.container.querySelector('.sendStatusLine[data-kind="create-link"]')).toBeTruthy();
    // …but the record is still draft-owned and nothing navigated.
    expect(getSendAction(attemptId)?.ownerKey).toBe("draft");
    expect(openSession).not.toHaveBeenCalled();
    r.unmount();
  });

  it("an out-of-window session renders NO affordance", () => {
    seedCreateUnknown(1_000, 2_000);
    const r = render(() => (
      <SendStatus
        {...baseProps({
          draft: () => true,
          sessionId: () => "",
          sessions: sessionsOf([{ id: "old", title: "Ancient", time: { created: 1_000 - 5 * 60_000 - 5_000 } }]),
          openSession: () => {},
        })}
      />
    ));
    expect(r.container.querySelector('.sendStatusLine[data-kind="create-link"]')).toBeNull();
    r.unmount();
  });

  it("dismissing the create-unknown record removes the affordance with it", () => {
    const attemptId = seedCreateUnknown(1_000, 2_000);
    const r = render(() => (
      <SendStatus
        {...baseProps({
          draft: () => true,
          sessionId: () => "",
          sessions: sessionsOf([{ id: "s9", title: "New session", time: { created: 1_500 } }]),
          openSession: () => {},
        })}
      />
    ));
    expect(r.container.querySelector('.sendStatusLine[data-kind="create-link"]')).toBeTruthy();
    // The EXISTING per-record dismiss (×) on the uncertain row is the out.
    r.container.querySelector('.sendStatusLine[data-kind="uncertain"] .sendStatusDismiss')!.click();
    expect(getSendAction(attemptId)).toBeUndefined();
    expect(r.container.querySelector('.sendStatusLine[data-kind="create-link"]')).toBeNull();
    r.unmount();
  });

  it("a LIVE session view never renders the affordance (draft-owned records are not its ownerKey)", () => {
    seedCreateUnknown(1_000, 2_000);
    const r = render(() => (
      <SendStatus
        {...baseProps({
          draft: () => false,
          sessionId: () => "s-live",
          sessions: sessionsOf([{ id: "s9", title: "New session", time: { created: 1_500 } }]),
          openSession: () => {},
        })}
      />
    ));
    expect(r.container.querySelector('.sendStatusLine[data-kind="create-link"]')).toBeNull();
    r.unmount();
  });
});
