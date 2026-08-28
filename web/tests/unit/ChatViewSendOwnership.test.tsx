// @vitest-environment jsdom
//
// AREA 2 — Ownership snapshots (send-cluster characterization).
//
// Pins the OWNERSHIP guards in send() so a future createSend extraction
// preserves them. Round-2 (D1) semantics: the TEXT clear is guarded BY VALUE
// (clear only if the composer still holds the tap-time text), and attachments
// are cleared PER OBJECT IDENTITY (exactly the still-present tap-owned set —
// plus this send's own documented mutations: the draft-flush replacement and
// the inline-resolve image parts):
//
//     if (input() === ownedText) setInput("");
//     if (ownedStillPresent.length > 0)
//       setAttachments(cur => cur.filter(a => owned.has(a)));
//
// This prevents a slow (up to 12s) enqueue from erasing state the operator
// entered AFTER pressing Send: an added chip is never owned (survives), a
// keystroke blocks the text clear, and an explicit chip removal is honored
// (never resurrected).
//
// Tests:
//   (1) text changed during the enqueue window -> text NOT cleared.
//   (2) attachment ADDED during the enqueue window -> NOT cleared (chip
//       survives; the inline insert also changes the text, blocking its clear).
//   (3) attachment REMOVED during the enqueue window -> removal HONORED (chip
//       not resurrected) and the SENT text still clears — the text guard is
//       independent of attachment changes (D1).
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
    // Custody confirms. The inline insert appended a markdown ref to the TEXT
    // (so the text guard blocks its clear), and the new chip was added AFTER
    // the tap (never tap-owned — the per-object clear never touches it). The
    // chip and the (appended) text both survive.
    release();
    await awaitSettled();
    expect(composerValue(container)).not.toBe(""); // composer preserved
    expect(removeAttachmentButtons(container).length).toBe(1); // chip preserved
  });

  it("(3) an attachment REMOVED during the enqueue window is honored — not resurrected; the sent text still clears", async () => {
    // Add a chip BEFORE send so the tap snapshot owns [chip]. Then during the
    // enqueue window REMOVE the chip: the text is UNCHANGED. Under the D1
    // per-object guards the text clear is INDEPENDENT of attachment changes:
    // the sent text clears (the message went out — keeping it would duplicate
    // on the next send), and the operator's removal is honored (the chip is
    // never resurrected into the composer).
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
    // The message was SENT (enqueue confirmed) and the text still matched the
    // tap snapshot -> the text clears. The removal is honored: no chip comes
    // back (per-object identity never resurrects a removed attachment).
    expect(composerValue(container)).toBe("");
    expect(removeAttachmentButtons(container).length).toBe(0);
  });
});
