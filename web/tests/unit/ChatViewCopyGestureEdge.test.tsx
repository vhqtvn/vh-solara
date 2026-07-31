// @vitest-environment jsdom
//
// Area 1 — Copy gesture event wiring + lifetime: the EDGE cases NOT already
// covered by ChatViewCopyHold.test.tsx.
//
// ChatViewCopyHold.test.tsx already pins the three core paths through the
// mounted `.msg-copy` button (tap→text, hold→thinking, contextmenu+synth-click
// dedupe→single thinking copy) plus per-row dedupe isolation. This file closes
// the TWO remaining gaps in the per-row copy state machine
// (ChatView.tsx ~1622-1700) that an extraction into `MessageRow` MUST preserve:
//
//   (4) Programmatic / keyboard click WITHOUT a preceding pointer-down carries
//       no hold intent → copyDownAt stays at its 0 sentinel → classifyHold
//       returns "tap" → text-only copy. (A broken downAt===0 sentinel would
//       always classify as "hold" since Date.now()-0 >= 450 is always true.)
//   (5) Blur / cancel clears the pending gesture: a pointer press sets
//       copyDownAt; focus leaving the button (onBlur) resets it to 0 so a LATER
//       keyboard activation classifies as "tap" instead of misclassifying from
//       the stale pointer timestamp.
//
// These exercise the ACTUAL row button event sequence through the mounted
// ChatView (not the pure helpers, which have their own copyHold.test.ts).
//
// TESTS-ONLY: no production source is modified.
import "./_chatRowHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@solidjs/testing-library";
import { fireEvent } from "@testing-library/dom";
import {
  ChatView,
  installClipboardSpy,
  mountChatView,
  mkAssistant,
  mkReasoningPart,
  mkTextPart,
  seedMessages,
  setupRowGlobals,
  teardownRowGlobals,
} from "./_chatRowHarness";
import { setState } from "../../src/sync/store";

// A message with BOTH a reasoning and a text part so the two copy paths produce
// distinguishable payloads (msgTextWithThinking wraps reasoning in <think>;
// msgTextOnly does not). partOrder ["pt","pr"] → with-thinking payload contains
// "<think>", text-only payload is just "hello".
const copyMsg = () =>
  mkAssistant("m1", ["pt", "pr"], {
    pt: mkTextPart("pt", "hello"),
    pr: mkReasoningPart("pr", "secret thought"),
  });

// ChatView's onClick handler calls Date.now() to classify hold vs tap. Drive a
// controllable clock so a "hold" is deterministic without a real 450ms wait.
let clock: number;
let dateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setupRowGlobals();
  clock = 1_700_000_000_000;
  dateSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  dateSpy.mockRestore();
  teardownRowGlobals();
  setState("messages", "s1", undefined as any);
  setState("messagesDelivered", "s1", undefined as any);
  setState("messagesError", "s1", undefined as any);
  cleanup();
});

const copyBtn = (container: HTMLElement) =>
  container.querySelector("button.msg-copy") as HTMLButtonElement;

describe("Area 1 (edges) — Copy gesture wiring not covered by ChatViewCopyHold", () => {
  it("keyboard/programmatic click with NO pointer-down fires text-only copy (tap sentinel)", async () => {
    // No pointerdown precedes the click (Enter/Space on a focused Copy button,
    // or any programmatic .click()). onPointerDown never ran for this gesture,
    // so copyDownAt stays at its initial 0 sentinel → classifyHold(0, now)
    // returns "tap" → copyMessage (text-only).
    //
    // MUTATION OBSERVED: if classifyHold's downAt===0 sentinel broke (e.g. the
    // extraction inlined an elapsed comparison without the guard), Date.now()-0
    // is always >= 450 → this would classify as "hold" and copy THINKING. The
    // assertion fails (writes[0] would contain "<think>").
    const writes = installClipboardSpy();
    const { container } = await mountChatView("s1");
    seedMessages("s1", { m1: copyMsg() });
    const btn = copyBtn(container);

    // Deliberately NO fireEvent.pointerDown. Advance the clock to prove the
    // sentinel — not a sub-threshold elapsed time — is what makes this a tap.
    clock += 5_000;
    fireEvent.click(btn);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("hello"); // text-only, NO <think>
  });

  it("blur clears the pending gesture so a later activation classifies as tap", async () => {
    // A pointer press records copyDownAt = T. Focus then leaves the button
    // (onBlur) → resets copyDownAt to 0 (gesture context ended). A SUBSEQUENT
    // activation must classify as "tap" (text-only), NOT misclassify from the
    // stale pointer timestamp (which, with the clock advanced, would be "hold").
    //
    // MUTATION OBSERVED: if the extraction dropped the onBlur handler (or
    // stopped resetting copyDownAt), the later click would see the stale T plus
    // an advanced clock → classifyHold → "hold" → THINKING copy. The assertion
    // fails (writes[0] would contain "<think>").
    const writes = installClipboardSpy();
    const { container } = await mountChatView("s1");
    seedMessages("s1", { m1: copyMsg() });
    const btn = copyBtn(container);

    fireEvent.pointerDown(btn); // copyDownAt = T
    fireEvent.blur(btn); // onBlur → copyDownAt = 0
    clock += 5_000; // cross the threshold; a stale timestamp would now be "hold"
    fireEvent.click(btn); // classifyHold(0, ...) → "tap" → text-only

    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("hello"); // text-only, NOT thinking
  });
});
