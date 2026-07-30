// @vitest-environment jsdom
//
// AREA 1 — Enqueue failure and retry (send-cluster characterization).
//
// Pins the no-loss + recoverability contract of send()/sendText() so a future
// createSend extraction can be verified safe:
//   (1) a FAILED enqueue preserves the composer text (no silent loss); the
//       operator re-presses Send.
//   (2) retrying after a failure submits once (a second enqueue lands) and on
//       success clears the composer.
//   (3) the single-flight guard RELEASES after an enqueue failure so a genuine
//       retry is not permanently blocked (isSendInFlight flips back to false).
//   (4) an OLD-message retry (the Retry button on a user message) calls
//       sendText() directly — which MUST NOT clear the composer (the retry
//       caller does not own whatever the operator is currently typing).
//
// Driven through ChatView's public surface (textarea + Send / Retry buttons)
// following the ChatViewDraftSend.test.tsx pattern; all module mocks live in
// the shared _chatSendHarness.
//
// Timing note: send() is async and suspends at `await enqueue` (and earlier at
// `await ensureSession`). A failure leaves the composer UNCHANGED (it was
// already the typed text), so asserting composerValue cannot drive the wait —
// we wait on the enqueue call COUNT (the authoritative progress signal) and on
// isSendInFlight (the single-flight settle signal) instead.
import "./_chatSendHarness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { isSendInFlight } from "../../src/lib/sendSingleFlight";
import {
  mocks,
  resetAll,
  setupBrowserGlobals,
  teardownBrowserGlobals,
  liveView,
  seedUserMessage,
  typeInto,
  composerValue,
  clickSend,
  clickRetry,
} from "./_chatSendHarness";

const SID = "s-live";

describe("AREA 1 — enqueue failure and retry (no-loss + recoverability)", () => {
  beforeEach(() => {
    setupBrowserGlobals();
    resetAll();
  });
  afterEach(() => {
    cleanup();
    teardownBrowserGlobals();
  });

  it("(1) a failed enqueue preserves the composer text (no silent loss)", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("offline / 5xx"));
    const { container } = render(() => liveView(SID));
    typeInto(container, "hello");
    await clickSend(container);
    // Wait for the enqueue to actually run (send() suspends at await enqueue).
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    // Settled: the failure path restored setInput(text) and the guard released.
    await waitFor(() => expect(isSendInFlight(SID)).toBe(false));
    // The composer MUST still hold "hello" (sendText returned false -> send()'s
    // ownership-snapshot failure branch did setInput(text)).
    expect(composerValue(container)).toBe("hello");
    const [, payload] = mocks.enqueue.mock.calls[0] as [string, { text: string }];
    expect(payload.text).toBe("hello");
  });

  it("(2) retrying after a failure submits once and clears on success", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("transient"));
    const { container } = render(() => liveView(SID));
    typeInto(container, "hello");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    // Wait until the failed send has FULLY settled (guard released) so the
    // retry's single-flight can engage — otherwise the re-tap is IGNORED.
    await waitFor(() => expect(isSendInFlight(SID)).toBe(false));
    expect(composerValue(container)).toBe("hello"); // preserved by failure path
    // Retry: press Send again. The default enqueue now resolves -> success.
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(composerValue(container)).toBe("")); // cleared
  });

  it("(3) the single-flight guard releases after an enqueue failure (retry not blocked)", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("boom"));
    const { container } = render(() => liveView(SID));
    typeInto(container, "hello");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    // The guard released in finally so a retry can engage it again.
    await waitFor(() => expect(isSendInFlight(SID)).toBe(false));
  });

  it("(4) an old-message Retry does NOT clear the current composer (sendText owns no composer)", async () => {
    // Seed a USER message so the Retry button renders, then type a NEW draft.
    // Clicking Retry calls retry(m) -> sendText(oldText, SID) directly (NOT
    // send()), and sendText MUST NOT touch the composer. The NEW draft survives.
    const { container } = render(() => liveView(SID));
    seedUserMessage(SID, "m-old", "old message text");
    await waitFor(() => expect(container.querySelector('button[aria-label="Retry"]')).toBeTruthy());
    typeInto(container, "new draft I'm writing");
    expect(composerValue(container)).toBe("new draft I'm writing");
    clickRetry(container);
    // sendText enqueued the OLD text (default enqueue resolves) — wait for it.
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    const [, payload] = mocks.enqueue.mock.calls[0] as [string, { text: string }];
    expect(payload.text).toBe("old message text"); // the OLD message was resent
    // The NEW draft is untouched (sendText never calls setInput).
    expect(composerValue(container)).toBe("new draft I'm writing");
  });
});
