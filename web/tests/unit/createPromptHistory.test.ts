// @vitest-environment jsdom
//
// Controller tests for web/src/components/chat/createPromptHistory.ts (the C5
// extraction from ChatView). Mirrors the createComposerAutocomplete.test.ts
// precedent: the factory's deps are injected as fakes, the controller is
// constructed under a Solid `createRoot` owner (so any future effect/cleanup
// register), and the recall state machine is exercised WITHOUT a
// component/reactive-render harness — no ChatView, no autocomplete, no send.
//
// This is the controller-level twin of ChatViewHistorySplit.test.tsx (which
// drives the same state machine through the full ChatView render). The two are
// deliberately complementary: the integration test guards the shared onKeyDown
// dispatcher (autocomplete → send → history precedence); these tests pin the
// factory's recall/step/reset contract directly.
//
// Each setup() registers its root dispose + textarea so afterEach tears them
// down — undisposed roots leak Solid owners across tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createPromptHistory, type PromptHistory } from "../../src/components/chat/createPromptHistory";
import { pushHistory } from "../../src/history";

// onHistoryKey schedules a caret reset on a microtask (queueMicrotask). Flush
// the microtask queue before asserting textarea caret / state that depends on it.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

const disposes: Array<() => void> = [];
const textareas: HTMLTextAreaElement[] = [];

function key(k: string, ctrl = false): KeyboardEvent {
  // cancelable: true is required so preventDefault() actually sets defaultPrevented
  // (KeyboardEvent defaults to cancelable: false, making preventDefault a no-op).
  return new KeyboardEvent("keydown", { key: k, ctrlKey: ctrl, metaKey: false, bubbles: true, cancelable: true });
}

interface Setup {
  hist: PromptHistory;
  input: () => string;
  setInput: (v: string) => void;
  ta: HTMLTextAreaElement;
  dispose: () => void;
}

function setup(sessionId = "session-A"): Setup {
  const [input, setInput] = createSignal("");
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  textareas.push(ta);
  let hist!: PromptHistory;
  const dispose = createRoot((d) => {
    hist = createPromptHistory({
      input,
      setInput,
      textarea: () => ta,
      sessionId: () => sessionId,
    });
    return d;
  });
  disposes.push(dispose);
  return { hist, input, setInput, ta, dispose };
}

// Place the caret so plain Up's caret-start gate passes (selectionStart===0).
function caretStart(ta: HTMLTextAreaElement) {
  ta.selectionStart = 0;
  ta.selectionEnd = 0;
}

describe("createPromptHistory — Up/Ctrl+Up recall split", () => {
  beforeEach(() => {
    localStorage.clear();
    // Seed: global has two prompts; only one belongs to session-A's store.
    //   global      = ["session-A-prompt", "global-only-prompt"]
    //   session-A   = ["session-A-prompt"]
    // "global-only-prompt" is the discriminator: reachable via Ctrl+Up, NOT via
    // plain Up in session-A.
    pushHistory("global-only-prompt"); // global only
    pushHistory("session-A-prompt", "session-A"); // global + session-A
  });

  it("plain Up at caret-start recalls the per-session store; a global-only prompt is NOT reached", async () => {
    const { hist, input, ta } = setup();
    caretStart(ta);
    expect(hist.onHistoryKey(key("ArrowUp"))).toBe(true);
    await flush();
    expect(input()).toBe("session-A-prompt");
    expect(ta.selectionStart).toBe(0); // caret reset to top

    // session-A store has length 1: a second plain Up must NOT cross into global.
    caretStart(ta);
    expect(hist.onHistoryKey(key("ArrowUp"))).toBe(true);
    await flush();
    expect(input()).toBe("session-A-prompt"); // clamped at the single entry
  });

  it("Ctrl+Up recalls from the GLOBAL store and reaches a prompt never sent in this session", async () => {
    const { hist, input, ta } = setup();
    // Ctrl+Up skips the caret-start gate, so caret position is irrelevant.
    expect(hist.onHistoryKey(key("ArrowUp", true))).toBe(true);
    await flush();
    expect(input()).toBe("session-A-prompt"); // global[0]

    expect(hist.onHistoryKey(key("ArrowUp", true))).toBe(true);
    await flush();
    expect(input()).toBe("global-only-prompt"); // global[1] — global-only
  });

  it("plain Up NOT at caret-start does NOT recall (multi-line editing isn't hijacked); returns false", async () => {
    const { hist, input, ta } = setup();
    ta.value = "some text";
    ta.selectionStart = ta.selectionEnd = 4; // caret in the middle
    expect(hist.onHistoryKey(key("ArrowUp"))).toBe(false);
    await flush();
    expect(input()).toBe(""); // untouched — browser default ArrowUp runs
  });

  it("ArrowUp against an empty per-session store returns false (nothing to recall; lets the default run)", async () => {
    // The history module caches per-session stores in-memory (sessionHist Map),
    // so localStorage.clear() does NOT empty a seeded id's cache. Use a session
    // id no test seeds so its per-session store is genuinely empty.
    const { hist, input, ta } = setup("never-seen");
    caretStart(ta);
    expect(hist.onHistoryKey(key("ArrowUp"))).toBe(false);
    await flush();
    expect(input()).toBe("");
  });
});

describe("createPromptHistory — Down step-back & draft restoration", () => {
  beforeEach(() => {
    localStorage.clear();
    pushHistory("global-only-prompt");
    pushHistory("session-A-prompt", "session-A");
  });

  it("Down steps back toward the live draft; past zero restores the captured draft", async () => {
    const { hist, input, setInput, ta } = setup();
    setInput("my draft");
    ta.value = "my draft";

    // Walk global: [0] then [1].
    expect(hist.onHistoryKey(key("ArrowUp", true))).toBe(true);
    await flush();
    expect(input()).toBe("session-A-prompt");
    expect(hist.onHistoryKey(key("ArrowUp", true))).toBe(true);
    await flush();
    expect(input()).toBe("global-only-prompt");

    // Down → back to global[0].
    expect(hist.onHistoryKey(key("ArrowDown"))).toBe(true);
    await flush();
    expect(input()).toBe("session-A-prompt");
    // Down past zero → restore the live draft captured at walk start.
    expect(hist.onHistoryKey(key("ArrowDown"))).toBe(true);
    await flush();
    expect(input()).toBe("my draft");
  });

  it("Down while idle (no walk active) is a no-op and returns false", async () => {
    const { hist, input } = setup();
    expect(hist.onHistoryKey(key("ArrowDown"))).toBe(false);
    expect(input()).toBe("");
  });
});

describe("createPromptHistory — scope switch starts a fresh walk", () => {
  beforeEach(() => {
    localStorage.clear();
    pushHistory("global-only-prompt");
    pushHistory("session-A-prompt", "session-A");
  });

  it("switching scopes (Ctrl+Up then plain Up) resets the walk; the global index does not leak into the session walk", async () => {
    const { hist, input, ta } = setup();
    // Walk global to index 1.
    expect(hist.onHistoryKey(key("ArrowUp", true))).toBe(true);
    await flush();
    expect(hist.onHistoryKey(key("ArrowUp", true))).toBe(true);
    await flush();
    expect(input()).toBe("global-only-prompt");

    // Plain Up switches to session mode — resets to session[0], NOT a continuation
    // from the global walk's index 1 (which would read past the 1-entry session
    // store).
    caretStart(ta);
    expect(hist.onHistoryKey(key("ArrowUp"))).toBe(true);
    await flush();
    expect(input()).toBe("session-A-prompt");
  });

  it("switching scopes mid-walk preserves the ORIGINAL live draft (Down-past-zero restores it, not a recalled value)", async () => {
    const { hist, input, setInput, ta } = setup();
    setInput("my original draft");
    ta.value = "my original draft";

    // Walk global, then switch to a session walk mid-stream.
    expect(hist.onHistoryKey(key("ArrowUp", true))).toBe(true);
    await flush();
    expect(hist.onHistoryKey(key("ArrowUp", true))).toBe(true);
    await flush();
    expect(input()).toBe("global-only-prompt");
    caretStart(ta);
    expect(hist.onHistoryKey(key("ArrowUp"))).toBe(true); // switch scope → session[0]
    await flush();
    expect(input()).toBe("session-A-prompt");

    // Down past zero in session mode restores the ORIGINAL typed draft, not the
    // global-recalled value that was on screen when the scope switched. (This is
    // the wasIdle guard on histDraft capture.)
    expect(hist.onHistoryKey(key("ArrowDown"))).toBe(true);
    await flush();
    expect(input()).toBe("my original draft");
  });
});

describe("createPromptHistory — resetHistory seam (C3 onApplied / onInput / send)", () => {
  beforeEach(() => {
    localStorage.clear();
    pushHistory("session-A-prompt", "session-A");
  });

  it("resetHistory abandons an in-flight walk: a subsequent Down is a no-op", async () => {
    const { hist, input, setInput, ta } = setup();
    setInput("draft");
    ta.value = "draft";
    caretStart(ta);
    expect(hist.onHistoryKey(key("ArrowUp"))).toBe(true); // recall session[0]
    await flush();
    expect(input()).toBe("session-A-prompt");

    // The C3 onApplied seam (or onInput / send) invalidates the walk.
    hist.resetHistory();

    // Down must NOT step now — the walk was abandoned. Returns false (no walk).
    expect(hist.onHistoryKey(key("ArrowDown"))).toBe(false);
    expect(input()).toBe("session-A-prompt"); // unchanged by the no-op Down
  });

  it("resetHistory is idempotent and safe when no walk is active", () => {
    const { hist } = setup();
    expect(() => hist.resetHistory()).not.toThrow();
    hist.resetHistory();
    hist.resetHistory();
  });
});

describe("createPromptHistory — dispatcher contract (precedence / fallthrough)", () => {
  beforeEach(() => {
    localStorage.clear();
    pushHistory("session-A-prompt", "session-A");
  });

  it("returns false for keys it does not own (so a caller could chain send/history)", async () => {
    const { hist, input } = setup();
    expect(hist.onHistoryKey(key("Enter"))).toBe(false);
    expect(hist.onHistoryKey(key("a"))).toBe(false);
    expect(hist.onHistoryKey(key("Backspace"))).toBe(false);
    expect(input()).toBe("");
  });

  it("calls preventDefault only when it actually recalled/stepped", async () => {
    const { hist, ta } = setup();
    // Plain Up at caret-start with a populated session store recalls → preventDefault.
    caretStart(ta);
    const e1 = key("ArrowUp");
    expect(hist.onHistoryKey(e1)).toBe(true);
    expect(e1.defaultPrevented).toBe(true);

    // A non-recall (caret NOT at start) must NOT preventDefault. The value must
    // be non-empty so jsdom honors selectionStart=4 (it clamps to value.length,
    // so an empty value would clamp to 0 and re-arm the caret-start gate).
    ta.value = "some text";
    ta.selectionStart = ta.selectionEnd = 4;
    const e2 = key("ArrowUp");
    expect(hist.onHistoryKey(e2)).toBe(false);
    expect(e2.defaultPrevented).toBe(false);
  });
});

afterEach(() => {
  while (disposes.length) disposes.pop()!();
  for (const ta of textareas) ta.remove();
  textareas.length = 0;
  vi.restoreAllMocks();
});
