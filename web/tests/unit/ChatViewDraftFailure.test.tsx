// @vitest-environment jsdom
//
// AREA 3 — Draft->live failure paths (send-cluster characterization).
//
// Pins the draft (New session) send branches in send() so a future createSend
// extraction preserves them. The draft path is a two-stage single-flight:
//   stage 1 — runSendSingleFlight("draft", ensureSession)  [createSession POST]
//   stage 2 — runSendSingleFlight(<liveId>, enqueueTail)   [durable custody]
//
// Tests:
//   (1) createSession() returns null -> text preserved (setInput(text); return).
//   (2) createSession succeeds but enqueue fails -> the draft->live unmount
//       orphans the failure-restore setInput; we characterize the ACTUAL current
//       behavior (the live composer ends up empty; enqueue was attempted).
//   (3) the draft key engages SYNCHRONOUSLY (before ensureSession resolves) and
//       the live key engages AFTER, in the intended order — observed through
//       isSendInFlight at each stage with controllable createSession/enqueue.
import "./_chatSendHarness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { isSendInFlight } from "../../src/lib/sendSingleFlight";
import {
  mocks,
  resetAll,
  setupBrowserGlobals,
  teardownBrowserGlobals,
  draftView,
  typeInto,
  composerValue,
  clickSend,
} from "./_chatSendHarness";
import { selectedId, newSession } from "../../src/sync";

const DRAFT_KEY = "vh.draft.__new__";

describe("AREA 3 — draft->live failure paths", () => {
  beforeEach(() => {
    setupBrowserGlobals();
    resetAll();
    newSession(); // draft hero: selectedId=null, draft=true
  });
  afterEach(() => {
    cleanup();
    teardownBrowserGlobals();
  });

  it("(1) createSession() returns null -> composer text preserved (no enqueue)", async () => {
    mocks.createSession.mockResolvedValue(null); // session creation fails
    const { container } = render(() => draftView(selectedId));
    typeInto(container, "draft hello");
    await clickSend(container);
    // ensureSession returned null -> send() does setInput(text); return BEFORE
    // any enqueue. The draft ChatView is still mounted (no flip), so the restore
    // lands on the live composer the operator sees.
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    // Give the setInput(text) restore a tick to flush.
    await waitFor(() => expect(isSendInFlight("draft")).toBe(false));
    expect(composerValue(container)).toBe("draft hello"); // preserved for retry
    expect(mocks.enqueue).not.toHaveBeenCalled(); // never reached enqueue
    expect(selectedId()).toBeNull(); // still in draft (no session created)
  });

  it("(2) createSession succeeds but enqueue fails -> enqueue attempted; live composer ends empty (restore lands on orphaned draft signal)", async () => {
    // createSession succeeds (default -> flips draft->live, draft ChatView
    // unmounts) but enqueue then fails. send()'s failure-restore setInput(text)
    // fires on the DRAFT ChatView's now-orphaned input signal (unmounted by the
    // flip), so it does NOT reach the live composer. This characterizes the
    // genuine current behavior — a latent fragility the createSend extraction
    // must preserve (not silently change). The text is still recoverable via the
    // persisted draft slot (cleared only on SUCCESS, not failure).
    mocks.enqueue.mockRejectedValueOnce(new Error("enqueue 500"));
    const { container } = render(() => draftView(selectedId));
    typeInto(container, "draft hello");
    // Let the draft-save effect persist the typed text before Send.
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toContain("draft hello"));
    await clickSend(container);
    // createSession flipped draft->live; enqueue was attempted and failed.
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(selectedId()).toBe("new-session-id"); // draft->live flip happened
    // The persisted draft slot is NOT cleared on failure (only on success), so
    // the text remains recoverable on the next New session.
    expect(localStorage.getItem(DRAFT_KEY)).toContain("draft hello");
    // The live composer is empty: the restore setInput fired on the orphaned
    // draft signal, not the live one (the draft ChatView unmounted on the flip).
    expect(composerValue(container)).toBe("");
  });

  it("(3) draft key engages synchronously then the live key engages after — intended order", async () => {
    // Stage 1: hold createSession open. The "draft" single-flight key must be
    // engaged SYNCHRONOUSLY at tap time (before ensureSession resolves) so the
    // draft Send button pulses immediately. The live key is NOT yet engaged.
    let releaseCreate!: () => void;
    mocks.createSession.mockImplementation(
      () => new Promise((res) => { releaseCreate = () => res("live-sess-1"); }),
    );
    let releaseEnq!: () => void;
    mocks.enqueue.mockImplementation(
      () => new Promise((res) => { releaseEnq = () => res({ id: "q", order: 1, state: "pending", text: "", attachments: [], createdAt: 0 }); }),
    );
    const { container } = render(() => draftView(selectedId));
    typeInto(container, "hi");
    await clickSend(container);
    // Stage 1: "draft" engaged, live id not yet known.
    await waitFor(() => expect(isSendInFlight("draft")).toBe(true));
    expect(isSendInFlight("live-sess-1")).toBe(false);
    // Release createSession -> "draft" released, then stage 2 engages the live id.
    releaseCreate();
    await waitFor(() => expect(isSendInFlight("live-sess-1")).toBe(true));
    expect(isSendInFlight("draft")).toBe(false); // draft key released before enqueue
    // Release enqueue -> live key released (settled).
    releaseEnq();
    await waitFor(() => expect(isSendInFlight("live-sess-1")).toBe(false));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
