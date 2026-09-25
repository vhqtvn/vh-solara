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
import { createSignal } from "solid-js";
import { cleanup, render } from "@solidjs/testing-library";
import { SendStatus } from "../../src/components/chat/SendStatus";
import {
  __resetSendActionStatusForTests,
  finishSendAttempt,
  getSendAction,
  markOwnerSessionCreateUnknown,
  markSendAttemptStatusUnsaved,
  mintSendAttempt,
  sendActionsFor,
  transferOwnerSendAttempts,
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

    // O2 slice 2: transient records MERGE into one line, so the retry copy is
    // observed with the earlier admitting record finished (a lone retry is
    // also the only production-reachable shape — single-flight).
    finishSendAttempt(a.attemptId);
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
  it("is announced by ONE dedicated polite announcer; the container itself is not a live region (O2 slice 2)", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "admitting" });
    const r = render(() => <SendStatus {...baseProps()} />);
    // Controls/details must not sit inside a live region — only the hidden
    // announcer mirror is polite.
    expect(r.container.querySelector(".sendStatus")!.getAttribute("aria-live")).toBeNull();
    const announcer = r.container.querySelector(".sendStatusAnnouncer")!;
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe("Sending…");
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

// ---------------------------------------------------------------------------
// O2 slice 2 — compact hierarchy (decision doc §1.4 Slice 2 scope): the
// merged happy-path line, the severity ladder + secondary-tier stacking cap,
// the single batched announcer, bounded full-text expansion, and create-link
// candidate grouping. The severity ladder (conflict > uncertain > unsaved >
// blocked/rejected) and cap N=2 are documented in SendStatus.tsx.
// ---------------------------------------------------------------------------
describe("SendStatus — O2 slice 2: compact merged happy-path line", () => {
  it("aggregates multiple transient records into ONE count line — no per-record rows, no false merged upload denominator", () => {
    // Single-flight keeps concurrent transient records out of ordinary
    // production reach; the public store API (mint under other owners + the
    // owner sweep) assembles the multi-active shape the copy must handle.
    mintSendAttempt("tmpA"); // preparing
    const t2 = mintSendAttempt("s1");
    updateSendAction(t2.attemptId, { stage: "admitting" });
    transferOwnerSendAttempts("tmpA", "s1");
    const r = render(() => (
      <SendStatus {...baseProps({ uploadProgress: () => ({ done: 0, total: 3 }) })} />
    ));
    const lines = r.container.querySelectorAll(".sendStatusLine");
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute("data-kind")).toBe("progress");
    // Decision-doc copy matrix: "N send actions in progress…" for multiple
    // active records (never an invented combined upload denominator).
    expect(lines[0].textContent).toBe("2 send actions in progress…");
    expect(r.container.textContent).not.toContain("Uploading");
    r.unmount();
  });

  it("a single transient record keeps its own stage copy, rendered BELOW the recovery rows", () => {
    const u = mintSendAttempt("s1");
    updateSendAction(u.attemptId, { stage: "uncertain", certainty: "unknown", recovery: "check", detail: "x" });
    const t = mintSendAttempt("s1"); // the uncertain record survives the mint
    updateSendAction(t.attemptId, { stage: "admitting" });
    const r = render(() => <SendStatus {...baseProps()} />);
    const kinds = Array.from(r.container.querySelectorAll(".sendStatusLine")).map((el) =>
      el.getAttribute("data-kind"),
    );
    expect(kinds).toEqual(["uncertain", "progress"]);
    expect(r.container.querySelector('.sendStatusLine[data-kind="progress"]')!.textContent).toBe("Sending…");
    r.unmount();
  });
});

describe("SendStatus — O2 slice 2: severity-ordered stacking with a capped secondary tier", () => {
  function seedRejected(owner: string): void {
    const a = mintSendAttempt(owner);
    updateSendAction(a.attemptId, { stage: "rejected", certainty: "definitive", recovery: "restore" });
  }

  it("orders rows conflict > uncertain > unsaved > blocked/rejected (actions-required first)", () => {
    const unc = mintSendAttempt("s1");
    updateSendAction(unc.attemptId, { stage: "uncertain", certainty: "unknown", recovery: "check" });
    const conf = mintSendAttempt("s1");
    updateSendAction(conf.attemptId, {
      stage: "conflict",
      certainty: "definitive",
      recovery: "check",
      detail: "queue_admission_conflict",
    });
    markSendAttemptStatusUnsaved("att-order-unsaved", "s1", { itemId: "q-1", state: "sent", detail: "ok" });
    seedRejected("s1");
    const r = render(() => <SendStatus {...baseProps()} />);
    const kinds = Array.from(r.container.querySelectorAll(".sendStatusLine")).map((el) =>
      el.getAttribute("data-kind"),
    );
    expect(kinds).toEqual(["conflict", "uncertain", "unsaved", "rejected"]);
    r.unmount();
  });

  it("caps the blocked/rejected tier at 2 with an inline 'Show N more notices'; disclosure reveals — never deletes", () => {
    // mint-supersede keeps ≤1 retained blocked/rejected record PER OWNER, so
    // the overflow shape is assembled across owners + swept in (public API).
    seedRejected("tmpA");
    seedRejected("tmpB");
    seedRejected("s1");
    transferOwnerSendAttempts("tmpA", "s1");
    transferOwnerSendAttempts("tmpB", "s1");
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.querySelectorAll('.sendStatusLine[data-kind="rejected"]')).toHaveLength(2);
    const more = r.container.querySelector(".sendStatusMore")!;
    expect(more.textContent).toContain("Show 1 more notices");
    more.click();
    expect(r.container.querySelectorAll('.sendStatusLine[data-kind="rejected"]')).toHaveLength(3);
    // The rows were REVEALED, not re-created or resolved.
    expect(sendActionsFor("s1")).toHaveLength(3);
    r.unmount();
  });

  it("critical tiers are NEVER capped — four uncertain rows all render, no expander", () => {
    for (let i = 0; i < 4; i++) {
      const a = mintSendAttempt("s1");
      updateSendAction(a.attemptId, {
        stage: "uncertain",
        certainty: "unknown",
        recovery: "check",
        detail: `u${i}`,
      });
    }
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.querySelectorAll('.sendStatusLine[data-kind="uncertain"]')).toHaveLength(4);
    expect(r.container.textContent).not.toContain("more notices");
    r.unmount();
  });
});

describe("SendStatus — O2 slice 2: ONE polite announcer, batched by mirroring primary texts", () => {
  it("the announcer carries the batch's primary texts once; payload expansion never re-announces", () => {
    const long = "x".repeat(120);
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, {
      stage: "uncertain",
      certainty: "unknown",
      recovery: "retry-same",
      payload: { tapText: long, text: long, attachments: [], files: [] },
    });
    const r = render(() => <SendStatus {...baseProps()} />);
    const ann = () => r.container.querySelector(".sendStatusAnnouncer")!.textContent;
    // Primary line ONLY — no payload preview, no control text.
    expect(ann()).toBe("Queue confirmation unknown.");
    r.container.querySelector(".sendStatusMore")!.click(); // expand full text
    expect(r.container.querySelector(".sendStatusFull")!.textContent).toBe(long);
    expect(ann()).toBe("Queue confirmation unknown."); // unchanged → no announcement
    r.unmount();
  });

  it("discrete upload-ordinal transitions (per file completion) update the announcer text", () => {
    mintSendAttempt("s1");
    const [prog, setProg] = createSignal<{ done: number; total: number } | null>({ done: 0, total: 2 });
    const r = render(() => <SendStatus {...baseProps({ uploadProgress: prog })} />);
    const ann = () => r.container.querySelector(".sendStatusAnnouncer")!.textContent;
    expect(ann()).toBe("Uploading 1 of 2…");
    setProg({ done: 1, total: 2 });
    expect(ann()).toBe("Uploading 2 of 2…");
    r.unmount();
  });
});

describe("SendStatus — O2 slice 2: bounded full-text payload expansion", () => {
  const LONG =
    "Full-text expansion probe — this stored message body is deliberately far longer than the eighty-character compact preview bound, so the collapsed Same-message quote is clipped at exactly that bound and the remainder is reachable only through the inline expansion affordance.";

  function seedRetrySame(text: string, files: string[] = []): string {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, {
      stage: "uncertain",
      certainty: "unknown",
      recovery: "retry-same",
      detail: "enqueue timed out",
      payload: { tapText: text, text, attachments: [], files },
    });
    return a.attemptId;
  }

  it("collapsed form is the compact clip; 'Show full message' expands verbatim text + filenames inline and toggles back", () => {
    seedRetrySame(LONG, ["notes.md"]);
    const r = render(() => <SendStatus {...baseProps()} />);
    const row = r.container.querySelector('.sendStatusLine[data-kind="uncertain"]')!;
    expect(row.textContent).toContain("Same message:");
    expect(row.textContent).not.toContain("inline expansion affordance"); // clipped tail absent
    const btn = row.querySelector(".sendStatusMore")!;
    expect(btn.textContent).toBe("Show full message");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    btn.click();
    expect(row.querySelector(".sendStatusFull")!.textContent).toContain(LONG);
    expect(row.textContent).toContain("notes.md");
    const btnAfter = row.querySelector(".sendStatusMore")!;
    expect(btnAfter.textContent).toBe("Hide full message");
    expect(btnAfter.getAttribute("aria-expanded")).toBe("true");
    btnAfter.click();
    expect(row.querySelector(".sendStatusFull")).toBeNull();
    r.unmount();
  });

  it("no expander when the stored text fits the compact preview (bounded — nothing is hidden)", () => {
    seedRetrySame("short message", ["chart.png"]);
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(r.container.querySelector(".sendStatusMore")).toBeNull();
    expect(r.container.textContent).toContain("Same message: “short message”");
    expect(r.container.textContent).toContain("chart.png");
    r.unmount();
  });
});

describe("SendStatus — O2 slice 2: create-link candidate grouping (2 visible, +k more)", () => {
  type SessionLike = { id: string; title?: string; time?: { created?: number } };
  const sessionsOf = (list: SessionLike[]) => () => Object.fromEntries(list.map((s) => [s.id, s]));

  it("shows the two NEWEST candidates first; 'Show all N possible sessions' reveals the rest inline", () => {
    seedCreateUnknown(1_000, 2_000);
    const sessions: SessionLike[] = [
      { id: "s-old1", title: "New session", time: { created: 1_100 } },
      { id: "s-old2", title: "New session", time: { created: 1_200 } },
      { id: "s-mid", title: "New session", time: { created: 1_300 } },
      { id: "s-new1", title: "New session", time: { created: 1_400 } },
      { id: "s-new2", title: "New session", time: { created: 1_500 } },
    ];
    const r = render(() => (
      <SendStatus
        {...baseProps({
          draft: () => true,
          sessionId: () => "",
          sessions: sessionsOf(sessions),
          openSession: () => {},
        })}
      />
    ));
    const row = r.container.querySelector('.sendStatusLine[data-kind="create-link"]')!;
    let btns = Array.from(row.querySelectorAll(".sendStatusBtn[data-session-id]"));
    expect(btns).toHaveLength(2);
    // Newest-created first (createLinkCandidates order is preserved).
    expect(btns.map((b) => b.getAttribute("data-session-id"))).toEqual(["s-new2", "s-new1"]);
    // The adjacent explanation discloses the all-remaining-records sweep.
    expect(row.textContent).toContain("Confirming moves this draft");
    const more = row.querySelector(".sendStatusMore")!;
    expect(more.textContent).toContain("Show all 5 possible sessions");
    more.click();
    btns = Array.from(row.querySelectorAll(".sendStatusBtn[data-session-id]"));
    expect(btns).toHaveLength(5);
    r.unmount();
  });

  it("a single candidate renders alone — no grouping chrome when nothing is hidden", () => {
    seedCreateUnknown(1_000, 2_000);
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
    const row = r.container.querySelector('.sendStatusLine[data-kind="create-link"]')!;
    expect(row.querySelectorAll(".sendStatusBtn[data-session-id]")).toHaveLength(1);
    expect(row.querySelector(".sendStatusMore")).toBeNull();
    r.unmount();
  });
});
