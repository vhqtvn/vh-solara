// @vitest-environment jsdom
//
// Integration coverage for the composer's split Up/Ctrl+Up recall (slice B).
// history.test.ts covers the store contract; this file exercises the onKeyDown
// state machine in ChatView that history.test.ts cannot reach:
//   - plain Up at caret-start recalls from the PER-SESSION store only;
//   - Ctrl+Up recalls from the GLOBAL store and can reach prompts never sent in
//     the current session;
//   - Down steps back in the active mode;
//   - switching scopes (Up <-> Ctrl+Up) starts a fresh walk (no index leakage);
//   - switching sessions resets the walk cursor.
//
// The stores are seeded directly via pushHistory (the same module ChatView
// imports), so this avoids the full send() machinery.

vi.hoisted(() => {
  if (!(window as any).matchMedia) {
    (window as any).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

vi.mock("../../src/agents", () => ({
  agents: () => [],
  selectedAgent: () => "",
  agentForSession: () => "",
  activeAgent: () => "",
  selectAgentForSession: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgent: vi.fn(),
}));
vi.mock("../../src/models", () => ({
  models: () => [],
  selectionFor: () => null,
  findModel: () => undefined,
  chooseModel: vi.fn(),
  chooseVariant: vi.fn(),
  applyModel: vi.fn(),
  applyAgentModel: vi.fn(),
  migrateModelPick: vi.fn(),
  loadModels: vi.fn(),
}));

// Seed the history stores the same module ChatView reads. Imported AFTER the
// component mocks so all modules resolve against one registry.
import { pushHistory } from "../../src/history";
import ChatView from "../../src/components/ChatView";

// Solid flushes re-renders on a microtask; a short timer also drains jsdom's rAF
// (the autosize effect schedules one per input() change).
const settle = () => new Promise<void>((r) => setTimeout(r, 30));

// Stub scrollHeight so the autosize effect (reads ta.scrollHeight) doesn't see
// jsdom's constant 0 and collapse the textarea. We assert input VALUE, not
// height, so a constant is fine.
const TA_PROTO = HTMLTextAreaElement.prototype;
let scrollHeightDesc: PropertyDescriptor | undefined;
function stubScrollHeight() {
  scrollHeightDesc = Object.getOwnPropertyDescriptor(TA_PROTO, "scrollHeight");
  Object.defineProperty(TA_PROTO, "scrollHeight", {
    configurable: true,
    get() {
      return 48;
    },
  });
}
function restoreScrollHeight() {
  if (scrollHeightDesc) Object.defineProperty(TA_PROTO, "scrollHeight", scrollHeightDesc);
  else delete (TA_PROTO as any).scrollHeight;
}

describe("composer Up/Ctrl+Up recall split (slice B)", () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    })) as any;
    if (!(window as any).matchMedia) {
      (window as any).matchMedia = (q: string) => ({
        matches: false,
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      });
    }
    (globalThis as any).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as any).PointerEvent = class extends MouseEvent {
      pointerId = 0;
      pointerType = "";
    };
    stubScrollHeight();
    localStorage.clear();
    // Seed: global has two prompts; only one belongs to session-A's store.
    //   global      = ["session-A-prompt", "global-only-prompt"]
    //   session-A   = ["session-A-prompt"]
    //   session-B   = []  (never pushed)
    // "global-only-prompt" is the discriminator: reachable via Ctrl+Up, NOT via
    // plain Up in session-A.
    pushHistory("global-only-prompt"); // global only
    pushHistory("session-A-prompt", "session-A"); // global + session-A
  });
  afterEach(() => {
    cleanup();
    restoreScrollHeight();
    (globalThis as any).fetch = undefined;
    localStorage.clear();
  });

  function up(ta: HTMLTextAreaElement, ctrl = false) {
    // Plain Up requires the caret at the very start; Ctrl+Up does not.
    if (!ctrl) {
      ta.selectionStart = 0;
      ta.selectionEnd = 0;
    }
    fireEvent.keyDown(ta, { key: "ArrowUp", ctrlKey: ctrl, bubbles: true });
  }
  function down(ta: HTMLTextAreaElement) {
    fireEvent.keyDown(ta, { key: "ArrowDown", bubbles: true });
  }

  it("plain Up recalls from the PER-SESSION store; a global-only prompt is NOT reached", async () => {
    const { container } = render(() => <ChatView sessionId="session-A" />);
    const ta = container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    ta.focus();
    await settle();

    up(ta); // session-A store[0]
    await settle();
    expect(ta.value).toBe("session-A-prompt");

    // session-A store has length 1; a second plain Up must NOT cross into global
    // and surface "global-only-prompt".
    up(ta);
    await settle();
    expect(ta.value).toBe("session-A-prompt");
  });

  it("Ctrl+Up recalls from the GLOBAL store and reaches a prompt never sent in this session", async () => {
    const { container } = render(() => <ChatView sessionId="session-A" />);
    const ta = container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
    ta.focus();
    await settle();

    up(ta, true); // global[0]
    await settle();
    expect(ta.value).toBe("session-A-prompt");

    up(ta, true); // global[1] — global-only, NOT in session-A's store
    await settle();
    expect(ta.value).toBe("global-only-prompt");
  });

  it("Down steps back toward the live draft in the active mode", async () => {
    const { container } = render(() => <ChatView sessionId="session-A" />);
    const ta = container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
    ta.focus();
    // Type a live draft so the recall snapshot is non-empty.
    fireEvent.input(ta, { target: { value: "my draft" } });
    await settle();
    expect(ta.value).toBe("my draft");

    up(ta, true); // global[0]
    await settle();
    expect(ta.value).toBe("session-A-prompt");
    up(ta, true); // global[1]
    await settle();
    expect(ta.value).toBe("global-only-prompt");

    down(ta); // back to global[0]
    await settle();
    expect(ta.value).toBe("session-A-prompt");
    down(ta); // past zero -> restore the live draft
    await settle();
    expect(ta.value).toBe("my draft");
  });

  it("switching scopes (Ctrl+Up then plain Up) starts a fresh walk; the global index does not leak into the session walk", async () => {
    const { container } = render(() => <ChatView sessionId="session-A" />);
    const ta = container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
    ta.focus();
    await settle();

    // Walk global to index 1 (global-only-prompt).
    up(ta, true);
    await settle();
    up(ta, true);
    await settle();
    expect(ta.value).toBe("global-only-prompt");

    // Now plain Up switches to session mode — it must reset to session[0], NOT
    // continue from the global walk's index 1 (which would read past the end of
    // the 1-entry session store).
    up(ta);
    await settle();
    expect(ta.value).toBe("session-A-prompt");
  });

  it("switching scopes mid-walk preserves the original live draft (Down-past-zero restores it, not a recalled value)", async () => {
    const { container } = render(() => <ChatView sessionId="session-A" />);
    const ta = container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
    ta.focus();
    fireEvent.input(ta, { target: { value: "my original draft" } });
    await settle();

    // Walk global, then switch to a session walk mid-stream.
    up(ta, true);
    await settle();
    up(ta, true);
    await settle();
    expect(ta.value).toBe("global-only-prompt");
    up(ta); // switch scope -> session[0]
    await settle();
    expect(ta.value).toBe("session-A-prompt");

    // Down past zero in session mode must restore the ORIGINAL typed draft, not
    // the global-recalled value that was on screen when the scope switched.
    // (Without the wasIdle guard on histDraft capture, histDraft would have been
    // overwritten with "global-only-prompt" on the scope switch.)
    down(ta);
    await settle();
    expect(ta.value).toBe("my original draft");
  });

  it("switching sessions resets the walk cursor: plain Up in a session whose store is empty does not recall", async () => {
    const [sid, setSid] = createSignal("session-A");
    const { container } = render(() => <ChatView sessionId={sid()} />);
    const ta = () => container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
    ta().focus();
    await settle();

    // Start a global walk in session-A (cursor now non-zero).
    up(ta(), true);
    await settle();
    up(ta(), true);
    await settle();
    expect(ta().value).toBe("global-only-prompt");

    // Switch to session-B (empty per-session store).
    setSid("session-B");
    await settle();

    // Plain Up in B must recall NOTHING (session-B store is empty) — and the
    // prior global walk's cursor must NOT have leaked (no global recall on a
    // plain-Up keypress).
    up(ta());
    await settle();
    expect(ta().value).toBe("");

    // Ctrl+Up still reaches the global store cross-session.
    up(ta(), true);
    await settle();
    expect(ta().value).toBe("session-A-prompt");
  });
});
