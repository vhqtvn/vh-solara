// @vitest-environment jsdom
//
// AREA 2 — Ownership snapshots (send-cluster characterization).
//
// Pins the OWNERSHIP-SNAPSHOT clear guard in send() so a future createSend
// extraction preserves it. send() captures the composer's exact text + the
// attachment ARRAY REFERENCE right before enqueue, and clears ONLY if the
// composer STILL holds that identical state when custody confirms:
//
//     if (input() === snapText && att.attachments() === snapAtts) { clear }
//
// Reference identity on the array catches any add/remove (setAttachments always
// produces a NEW array); value equality on text catches any keystroke. This
// prevents a slow (up to 12s) enqueue from erasing state the operator entered
// AFTER pressing Send.
//
// Tests:
//   (1) text changed during the enqueue window -> NOT cleared.
//   (2) attachment ADDED during the enqueue window -> NOT cleared (chip survives).
//   (3) attachment REMOVED during the enqueue window -> NOT cleared — this
//       isolates the array-IDENTITY guard (text is unchanged, so only the
//       attachment-array mismatch blocks the clear).
//
// The enqueue mock is held open with a controllable promise so we can mutate the
// composer mid-window, then release custody and observe the (non-)clear. We
// gate assertions on isSendInFlight(SID)===false — the single-flight releases in
// `finally` ONLY after the snapshot/clear callback has fully run, so it is the
// authoritative "send settled" signal (the composer value alone can't drive the
// wait, since on a no-clear it's unchanged from before release).
import "./_chatSendHarness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { fireEvent } from "@testing-library/dom";
import { isSendInFlight } from "../../src/lib/sendSingleFlight";
import {
  mocks,
  resetAll,
  setupBrowserGlobals,
  teardownBrowserGlobals,
  liveView,
  typeInto,
  composerValue,
  clickSend,
} from "./_chatSendHarness";

const SID = "s-live";

// A minimal queue item the held-open enqueue resolves with on release.
const OK_ITEM = { id: "q-enq", order: 1, state: "pending" as const, text: "", attachments: [], createdAt: 0 };

// Hold enqueue open: returns a release() that confirms custody. Lets the test
// mutate the composer inside the (up to 12s) enqueue window.
function holdEnqueue() {
  let release!: () => void;
  mocks.enqueue.mockImplementation(
    () => new Promise((res) => { release = () => res(OK_ITEM); }),
  );
  return () => release();
}

// Drive the hidden <input type="file"> to add an attachment through the real
// createAttachments pipeline (inline mode is ON by default for a non-vision
// model, so this inserts a markdown ref at the caret AND adds a chip).
function addFileViaInput(container: HTMLElement, name: string, mime: string) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  if (!input) throw new Error("file input not found");
  const file = new File(["x"], name, { type: mime });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

function removeAttachmentButtons(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('button[aria-label="Remove attachment"]'));
}

// Wait for the held-open enqueue send to fully settle: the single-flight
// releases in `finally` only after the snapshot/clear callback completes.
function awaitSettled() {
  return waitFor(() => expect(isSendInFlight(SID)).toBe(false));
}

describe("AREA 2 — ownership snapshot: state entered DURING enqueue is not erased", () => {
  beforeEach(() => {
    setupBrowserGlobals();
    resetAll();
  });
  afterEach(() => {
    cleanup();
    teardownBrowserGlobals();
  });

  it("(1) text changed during the enqueue window is NOT cleared", async () => {
    const release = holdEnqueue();
    const { container } = render(() => liveView(SID));
    typeInto(container, "hello");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1)); // enqueue held open
    // Operator keeps typing while the slow enqueue is in flight.
    typeInto(container, "hello world");
    expect(composerValue(container)).toBe("hello world");
    // Custody confirms. The ownership snapshot (snapText="hello") no longer
    // matches input()="hello world" -> the clear is SKIPPED. New text survives.
    release();
    await awaitSettled();
    expect(composerValue(container)).toBe("hello world"); // NOT cleared
  });

  it("(2) an attachment ADDED during the enqueue window is NOT cleared (chip survives)", async () => {
    const release = holdEnqueue();
    const { container } = render(() => liveView(SID));
    typeInto(container, "hello");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    // Add an attachment mid-window (inline chip + markdown ref inserted).
    addFileViaInput(container, "note.txt", "text/plain");
    await waitFor(() => expect(removeAttachmentButtons(container).length).toBe(1));
    // Custody confirms. The composer text + attachments both changed during the
    // window -> the ownership snapshot no longer matches -> clear SKIPPED. The
    // chip and the (appended) text both survive.
    release();
    await awaitSettled();
    expect(composerValue(container)).not.toBe(""); // composer preserved
    expect(removeAttachmentButtons(container).length).toBe(1); // chip preserved
  });

  it("(3) an attachment REMOVED during the enqueue window is NOT cleared (isolates the array-identity guard)", async () => {
    // Add a chip BEFORE send so snapAtts captures [chip]. Then during the enqueue
    // window REMOVE the chip: the text is UNCHANGED (only the array identity
    // changes), so the ONLY thing blocking the clear is the attachment-array
    // reference mismatch — isolating that guard from the text guard.
    const release = holdEnqueue();
    const { container } = render(() => liveView(SID));
    addFileViaInput(container, "note.txt", "text/plain");
    await waitFor(() => expect(removeAttachmentButtons(container).length).toBe(1));
    typeInto(container, "hello");
    await clickSend(container);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    const textAtSend = composerValue(container);
    // Remove the chip during the enqueue window (text is unchanged).
    fireEvent.click(removeAttachmentButtons(container)[0]);
    await waitFor(() => expect(removeAttachmentButtons(container).length).toBe(0));
    expect(composerValue(container)).toBe(textAtSend);
    release();
    await awaitSettled();
    // NOT cleared: the attachment-array identity mismatch blocked the clear even
    // though the text matched the snapshot. This is the reference-identity guard.
    expect(composerValue(container)).toBe(textAtSend);
  });
});
