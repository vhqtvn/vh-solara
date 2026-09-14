// @vitest-environment jsdom
//
// SendStatus — the send-reliability slice-3 status surface (brief §4.4 copy
// matrix is normative). These tests pin:
//   - the per-stage readable copy (never glow-only),
//   - the retry taxonomy: "Retry send" ONLY for uncertain ENQUEUE outcomes
//     (recovery retry-same, server-deduped replay); "Outcome unknown — check
//     before sending again." (NO retry button) for every other uncertainty;
//     "Retry status save" (a record, never a resend) for the unsaved stage,
//   - the payload surfacing on retry-same (what a verbatim replay will send),
//   - the server-custody line ("Queued — waiting for connection.") — rendered
//     ONLY for a live session with server queue state on a known-down stream;
//     an unconfirmed browser draft is NEVER called "queued",
//   - the polite live region, and dismissal of retained records.
//
// The queue module is mocked (hasQueueState / resolveQueued) — the data-layer
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

vi.mock("../../src/queue", () => ({
  hasQueueState: vi.fn(() => false),
  resolveQueued: vi.fn(async () => ({ kind: "recorded" })),
}));

import { hasQueueState, resolveQueued } from "../../src/queue";

const hasQueueStateMock = vi.mocked(hasQueueState);
const resolveQueuedMock = vi.mocked(resolveQueued);

function baseProps(over: Partial<Parameters<typeof SendStatus>[0]> = {}) {
  return {
    sessionId: () => "s1",
    draft: () => false,
    send: vi.fn(async () => {}),
    uploadProgress: () => null as { done: number; total: number } | null,
    streamStatus: () => "live",
    ...over,
  };
}

beforeEach(() => {
  hasQueueStateMock.mockImplementation(() => false);
  resolveQueuedMock.mockImplementation(async () => ({ kind: "recorded" } as const));
});

afterEach(() => {
  cleanup();
  __resetSendActionStatusForTests();
  vi.clearAllMocks();
});

describe("SendStatus — per-stage readable copy (brief §4.4)", () => {
  it("renders nothing when there are no records and no custody line", () => {
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
    expect(r.container.textContent).toContain("Queue state conflict — check the queue.");
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
    // The verbatim payload is SURFACED (slice-2 advisory: a retry re-includes
    // chips removed after the attempt — show what will be sent).
    expect(r.container.textContent).toContain("Will send: “retry me”");
    expect(r.container.textContent).toContain("notes.md");
    expect(r.container.textContent).toContain("shot.png");
    const btn = r.container.querySelector(".sendStatusBtn");
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain("Retry send");
    btn!.click();
    expect(send).toHaveBeenCalledTimes(1);
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

  it("unsaved resolve-status shows 'Message outcome recorded; status not saved.' + Retry STATUS SAVE (a record, never a resend)", async () => {
    markSendAttemptStatusUnsaved("att-save-1", "s1", { itemId: "q-9", state: "sent", detail: "dispatch ok" });
    const send = vi.fn(async () => {});
    const r = render(() => <SendStatus {...baseProps({ send })} />);
    expect(r.container.textContent).toContain("Message outcome recorded; status not saved.");
    const btn = r.container.querySelector(".sendStatusBtn")!;
    expect(btn.textContent).toContain("Retry status save");
    btn.click();
    await vi.waitFor(() => expect(resolveQueuedMock).toHaveBeenCalledTimes(1));
    // The retry re-records the SAME terminal outcome — it must NEVER touch the
    // send path.
    expect(resolveQueuedMock).toHaveBeenCalledWith("s1", "q-9", "sent", "dispatch ok");
    expect(send).not.toHaveBeenCalled();
    // Recorded → the retained record is finished (the row clears).
    await vi.waitFor(() => expect(r.container.textContent).not.toContain("status not saved"));
    expect(getSendAction("att-save-1")).toBeUndefined();
    r.unmount();
  });

  it("an unsaved retry that stays unrecorded keeps the row (honest persistence)", async () => {
    resolveQueuedMock.mockImplementation(async () => ({ kind: "unrecorded" } as const));
    markSendAttemptStatusUnsaved("att-save-2", "s1", { itemId: "q-8", state: "failed", detail: "boom" });
    const r = render(() => <SendStatus {...baseProps()} />);
    r.container.querySelector(".sendStatusBtn")!.click();
    await vi.waitFor(() => expect(resolveQueuedMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(r.container.textContent).toContain("status not saved"));
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
    // The user SEES the conflict — the row did not disappear.
    await vi.waitFor(() => expect(r.container.textContent).toContain("Queue state conflict — showing server state."));
    expect(r.container.querySelector(".sendStatusDismiss")).toBeTruthy();
    expect(send).not.toHaveBeenCalled(); // still never a resend
    // The record survives as the conflict state (server truth shown).
    expect(getSendAction("att-save-3")).toBeTruthy();
    expect(getSendAction("att-save-3")!.stage).toBe("conflict");
    expect(getSendAction("att-save-3")!.conflictSource).toBe("resolve");
    r.unmount();
  });
});

describe("SendStatus — server custody line (never for an unconfirmed draft)", () => {
  it("shows 'Queued — waiting for connection.' for a live session with queue state on a down stream", () => {
    hasQueueStateMock.mockImplementation(() => true);
    const r = render(() => <SendStatus {...baseProps({ streamStatus: () => "reconnecting" })} />);
    expect(r.container.textContent).toContain("Queued — waiting for connection.");
    r.unmount();
  });

  it("NEVER calls a draft 'queued' (no custody line in draft mode even with queue-shaped state)", () => {
    hasQueueStateMock.mockImplementation(() => true);
    const r = render(() => (
      <SendStatus {...baseProps({ draft: () => true, sessionId: () => "", streamStatus: () => "reconnecting" })} />
    ));
    expect(r.container.textContent).not.toContain("Queued");
    r.unmount();
  });

  it("does not show the custody line while the stream is live", () => {
    hasQueueStateMock.mockImplementation(() => true);
    const r = render(() => <SendStatus {...baseProps({ streamStatus: () => "live" })} />);
    expect(r.container.textContent).not.toContain("Queued — waiting");
    r.unmount();
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
    expect(row!.textContent).toContain("A new session may be your last send");
    const btn = row!.querySelector(".sendStatusBtn")!;
    expect(btn.textContent).toMatch(/^Open/); // "Open it (hh:mm)" — generic title stays generic
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
