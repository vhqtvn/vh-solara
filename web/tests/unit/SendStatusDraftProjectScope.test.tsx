// @vitest-environment jsdom
//
// Slice 3 — draft send-error rows are PROJECT-SCOPED.
//
// Defect: SendStatus used the bare ownerKey "draft" for ANY draft view, so a
// draft send-error row from project A stayed visible in project B's draft
// view after an in-app project switch (the records are module-singleton
// in-memory state, and one SPA serves every project's draft view).
//
// Fix under test: the draft owner key incorporates the project identity
// (draftOwnerKey — "draft:<dir>", with the bare "draft" kept for the default
// project), minted/read symmetrically across the send path (SendStatus,
// createSend, sessionCreateStatus, sync/actions, ChatView.ensureSession).
// Switching projects must therefore start a CLEAN draft error state, and
// switching back must restore project A's rows (nothing persisted — the
// in-memory store simply holds both keys' records).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { SendStatus } from "../../src/components/chat/SendStatus";
import {
  __resetSendActionStatusForTests,
  draftOwnerKey,
  isDraftOwnerKey,
  mintSendAttempt,
  sendActionsFor,
  stampDraftPreparingCreateOp,
  transferCreateOpRecords,
  transferOwnerSendAttempts,
  updateSendAction,
} from "../../src/lib/sendActionStatus";
import { __resetSessionCreateForTests, __seedCreateOpForTests } from "../../src/lib/sessionCreateStatus";
import { setProjectDirRaw } from "../../src/sync/store";

vi.mock("../../src/queue", () => ({
  queueFor: vi.fn(() => []),
  resolveQueued: vi.fn(async () => ({ kind: "recorded" })),
}));

function baseProps(over: Partial<Parameters<typeof SendStatus>[0]> = {}) {
  return {
    sessionId: () => "",
    draft: () => true,
    send: vi.fn(async () => {}),
    uploadProgress: () => null as { done: number; total: number } | null,
    ...over,
  };
}

/** Seed one visible draft error row (definitive rejected) under `dir`'s
 *  draft key. Returns the attemptId. */
function seedRejected(dir: string, detail: string): string {
  const a = mintSendAttempt(draftOwnerKey(dir));
  updateSendAction(a.attemptId, {
    stage: "rejected",
    certainty: "definitive",
    recovery: "restore",
    detail,
  });
  return a.attemptId;
}

function rejectedRow(container: HTMLElement): Element | null {
  return container.querySelector('.sendStatusLine[data-kind="rejected"]');
}

beforeEach(() => {
  setProjectDirRaw("");
});

afterEach(() => {
  cleanup();
  __resetSendActionStatusForTests();
  __resetSessionCreateForTests();
  setProjectDirRaw("");
  vi.clearAllMocks();
});

describe("draftOwnerKey — key shapes", () => {
  it("the default project keeps the legacy bare 'draft' key; a project scopes it", () => {
    expect(draftOwnerKey("")).toBe("draft");
    expect(draftOwnerKey("/a")).toBe("draft:/a");
  });

  it("isDraftOwnerKey recognizes both shapes and rejects session ids", () => {
    expect(isDraftOwnerKey("draft")).toBe(true);
    expect(isDraftOwnerKey("draft:/a")).toBe(true);
    expect(isDraftOwnerKey("ses_abc")).toBe(false);
    expect(isDraftOwnerKey("")).toBe(false);
  });
});

describe("SendStatus — draft send-error rows follow the project switch", () => {
  it("project A's draft error row is invisible in project B's draft view, and restored on switch back", () => {
    seedRejected("/proj/a", "send failed in A");
    seedRejected("/proj/b", "send failed in B");

    setProjectDirRaw("/proj/a");
    const r = render(() => <SendStatus {...baseProps()} />);
    // A's row visible, B's not (the pre-fix defect: BOTH rendered).
    expect(rejectedRow(r.container)?.getAttribute("data-tip")).toBe("send failed in A");
    expect(r.container.textContent).not.toContain("send failed in B");

    // In-app project switch → clean draft error state in B.
    setProjectDirRaw("/proj/b");
    expect(rejectedRow(r.container)?.getAttribute("data-tip")).toBe("send failed in B");
    expect(r.container.textContent).not.toContain("send failed in A");

    // Switch back → A's row is still there (in-memory store retains both).
    setProjectDirRaw("/proj/a");
    expect(rejectedRow(r.container)?.getAttribute("data-tip")).toBe("send failed in A");
    expect(r.container.textContent).not.toContain("send failed in B");
    r.unmount();
  });

  it("the default project (no dir) still reads the legacy bare 'draft' records", () => {
    const a = mintSendAttempt("draft");
    updateSendAction(a.attemptId, {
      stage: "rejected",
      certainty: "definitive",
      recovery: "restore",
      detail: "default-project failure",
    });
    const r = render(() => <SendStatus {...baseProps()} />);
    expect(rejectedRow(r.container)?.getAttribute("data-tip")).toBe("default-project failure");
    r.unmount();
  });

  it("the draft→live owner sweep moves ONLY the current project's draft records", () => {
    const idA = seedRejected("/proj/a", "a-failure");
    const idB = seedRejected("/proj/b", "b-failure");
    // Confirm-create-link semantics: sweep under project A's key.
    const moved = transferOwnerSendAttempts(draftOwnerKey("/proj/a"), "ses_live");
    expect(moved).toBe(1);
    expect(sendActionsFor("ses_live").map((x) => x.attemptId)).toContain(idA);
    expect(sendActionsFor(draftOwnerKey("/proj/b"))).toHaveLength(1); // B untouched
    expect(sendActionsFor(draftOwnerKey("/proj/b"))[0].attemptId).toBe(idB);
  });

  it("transferCreateOpRecords moves a PROJECT-SCOPED draft record (any draft key shape)", () => {
    // The operation-scoped re-key must match records minted under
    // draft:<dir>, not only the bare "draft" of the default project.
    const opId = __seedCreateOpForTests("/proj/a");
    const a = mintSendAttempt(draftOwnerKey("/proj/a"));
    stampDraftPreparingCreateOp(draftOwnerKey("/proj/a"), opId);
    // Make it uncertain (retained) so the transfer target keeps it visible.
    updateSendAction(a.attemptId, {
      stage: "uncertain",
      certainty: "unknown",
      recovery: "retry-same",
      reason: "session-create-unknown",
    });
    const n = transferCreateOpRecords(opId, "ses_recovered");
    expect(n).toBe(1);
    expect(sendActionsFor("ses_recovered").map((x) => x.attemptId)).toContain(a.attemptId);
    expect(sendActionsFor(draftOwnerKey("/proj/a"))).toHaveLength(0);
  });
});
