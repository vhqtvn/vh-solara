// @vitest-environment jsdom
//
// Component test for the Copy button's three-path tap/hold wiring in
// ChatView.tsx. The per-message `.msg-copy` button (see ChatView.tsx ~1640-1703)
// uses the pure classifier in ../lib/copyHold:
//
//   onPointerDown -> records Date.now() as copyDownAt; clears the per-row
//                    contextmenu-dedupe flag (thinkingJustCopied).
//   onClick       -> classifyHold(copyDownAt, now):
//                     - "tap"  (< HOLD_THRESHOLD_MS) -> copyMessage      (text-only)
//                     - "hold" (>= HOLD_THRESHOLD_MS) -> copyMessageWithThinking,
//                       unless shouldSkipAfterContextmenu(...) dedupes a touch
//                       long-press whose contextmenu already copied thinking.
//   onContextMenu -> always copies thinking, and arms the dedupe flag so the
//                    synthesized hold-click that follows is skipped (the Android-
//                    Chrome touch double-fire: contextmenu THEN click).
//
// These three paths (tap -> text, hold -> thinking, contextmenu dedupe) live in
// ChatView.tsx, not in copyHold.ts (which is already unit-tested). This test
// covers the WIRING through the rendered component: the gesture handlers, the
// per-row closure state, and the resulting navigator.clipboard.writeText
// payloads. jsdom fires the events synchronously, so the elapsed-time gap between
// pointerdown and click is microseconds (< 450ms) -> "tap" by default; the hold
// and dedupe cases drive a controlled Date.now() to cross the 450ms threshold.
//
// The harness shape (mocks + store seeding) mirrors ChatViewPartlessMessage.

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// code/frame.ts via ChatView's transitive deps). Import the shared stub BEFORE
// any import that triggers layout.ts — see _matchMedia.ts.
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
// Pure leaf module (no Solid runtime) — the single hold-threshold source of
// truth shared with the paste button. Importing it (instead of a magic 500ms)
// keeps the clock-advance tied to the real classifier boundary.
import { HOLD_THRESHOLD_MS } from "../../src/lib/copyHold";

// agents: ChatView's readyToSend memo requires agents() non-empty. Provide one.
vi.mock("../../src/agents", () => ({
  agents: () => [{ name: "build", description: "build agent", mode: "primary" }],
  selectedAgent: () => "build",
  agentForSession: () => "build",
  activeAgent: () => "build",
  selectAgentForSession: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgent: vi.fn(),
}));

// models: readyToSend requires models() non-empty. Provide one model;
// selectionFor("") returns null.
vi.mock("../../src/models", () => ({
  models: () => [{
    providerID: "test",
    modelID: "m1",
    provider: "Test",
    name: "M1",
    label: "Test / M1",
    variants: [],
  }],
  selectionFor: () => null,
  findModel: () => undefined,
  chooseVariant: vi.fn(),
  chooseModel: vi.fn(),
  applyModel: vi.fn(),
  loadModels: vi.fn(),
}));

// jsdom lacks IntersectionObserver, PointerEvent, and ResizeObserver, and does
// not implement the async Clipboard API. Stub fetch too (ChatView onMount may
// issue unrelated fetches). Date.now is controlled per-test so the hold/dedupe
// gestures can cross the 450ms classifier threshold deterministically.
let clock: number;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Fixed, bumpable clock — a hold is elapsed >= HOLD_THRESHOLD_MS (450). A
  // stable base value keeps RelTime/"ago" formatting cosmetic during render.
  clock = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);

  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });

  (globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  })) as any;
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
  (globalThis as any).PointerEvent = class extends MouseEvent {
    pointerId = 0;
    pointerType = "";
  };
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (globalThis as any).fetch = undefined;
  setState("messages", "s1", undefined as any);
  setState("messagesDelivered", "s1", undefined as any);
  setState("messagesError", "s1", undefined as any);
});

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";
import { setState } from "../../src/sync/store";

// A message with BOTH a reasoning part and a text part, so the two copy paths
// produce distinguishable payloads:
//   text-only   -> "the answer is 42"
//   with-think  -> "<think>let me think step by step</think>\nthe answer is 42"
const mkAssistant = (id: string, suffix = ""): any => ({
  id,
  info: { role: "assistant", time: { created: 1000, completed: 2000 } },
  partOrder: ["pReason", "pText"],
  parts: {
    pReason: { id: "pReason", sessionID: "s1", messageID: id, type: "reasoning", text: `let me think step by step${suffix}` },
    pText: { id: "pText", sessionID: "s1", messageID: id, type: "text", text: `the answer is 42${suffix}` },
  },
});

const TEXT_ONLY = "the answer is 42";
const WITH_THINKING = "<think>let me think step by step</think>\nthe answer is 42";

const seed = (byId: Record<string, any>) =>
  setState("messages", "s1", { order: Object.keys(byId), byId });

describe("ChatView Copy button — tap/hold/contextmenu wiring", () => {
  it("tap (elapsed < HOLD_THRESHOLD_MS) copies text-only via copyMessage", async () => {
    const { container } = render(() => <ChatView sessionId="s1" />);
    await waitFor(() => expect((container as any).ownerDocument && true).toBe(true));
    seed({ m1: mkAssistant("m1") });
    setState("messagesDelivered", "s1", true);

    const copyBtn = await waitFor(() => {
      const el = container.querySelector(".msg-copy") as HTMLElement | null;
      if (!el) throw new Error("copy button not rendered");
      return el;
    });

    // Fresh gesture: pointerdown records copyDownAt = clock; click follows
    // immediately so classifyHold sees ~0ms elapsed -> "tap" -> copyMessage.
    fireEvent.pointerDown(copyBtn);
    fireEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(TEXT_ONLY);
  });

  it("hold (elapsed >= HOLD_THRESHOLD_MS) copies thinking via copyMessageWithThinking", async () => {
    const { container } = render(() => <ChatView sessionId="s1" />);
    await waitFor(() => expect((container as any).ownerDocument && true).toBe(true));
    seed({ m1: mkAssistant("m1") });
    setState("messagesDelivered", "s1", true);

    const copyBtn = await waitFor(() => {
      const el = container.querySelector(".msg-copy") as HTMLElement | null;
      if (!el) throw new Error("copy button not rendered");
      return el;
    });

    // Pointerdown records copyDownAt at clock T0; advance the clock past the
    // 450ms threshold before the click so classifyHold -> "hold" (and, with no
    // prior contextmenu, shouldSkipAfterContextmenu is false) -> thinking copy.
    fireEvent.pointerDown(copyBtn);
    clock += HOLD_THRESHOLD_MS;
    fireEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(WITH_THINKING);
  });

  it("contextmenu dedupes the synthesized hold-click (single thinking copy)", async () => {
    // The Android-Chrome touch long-press double-fire: a touch hold fires
    // onContextMenu FIRST (copies thinking, arms the per-row dedupe flag) and
    // then a synthesized onContextMenu-less click that classifies as "hold".
    // Without the dedupe the click would copy thinking a SECOND time. The
    // contract (ready_criteria) is a SINGLE thinking copy for the gesture.
    const { container } = render(() => <ChatView sessionId="s1" />);
    await waitFor(() => expect((container as any).ownerDocument && true).toBe(true));
    seed({ m1: mkAssistant("m1") });
    setState("messagesDelivered", "s1", true);

    const copyBtn = await waitFor(() => {
      const el = container.querySelector(".msg-copy") as HTMLElement | null;
      if (!el) throw new Error("copy button not rendered");
      return el;
    });

    fireEvent.pointerDown(copyBtn);   // copyDownAt = clock T0
    fireEvent.contextMenu(copyBtn);   // thinkingJustCopied = true; copy #1 (thinking)
    clock += HOLD_THRESHOLD_MS;                      // cross the threshold before the click
    fireEvent.click(copyBtn);          // hold + flag set -> shouldSkip -> NO copy #2

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(WITH_THINKING);
  });

  it("a prior row's armed dedupe flag does not suppress the next row's gesture", async () => {
    // Behavioral isolation guard (ready_criteria "two rows' gestures do not
    // share state"). Row 1 performs a contextmenu+hold-click dedupe, which arms
    // its `thinkingJustCopied` flag. Row 2 then does a FRESH hold-click with NO
    // contextmenu: its copy MUST still happen.
    //
    // NOTE: the guarantee here is observable no-cross-row poisoning, NOT closure
    // topology. onPointerDown resets the flag for EVERY gesture (ChatView.tsx
    // ~1651), so row 2 is reset before its classify regardless of whether the
    // flag is per-row or component-scoped — a shared flag with this reset would
    // observe identically. This test therefore guards the reset contract (a
    // future change that removes the pointerdown reset AND hoists the flag would
    // break row 2's copy), not the `let` declaration placement.
    const { container } = render(() => <ChatView sessionId="s1" />);
    await waitFor(() => expect((container as any).ownerDocument && true).toBe(true));
    seed({
      m1: mkAssistant("m1"),
      m2: mkAssistant("m2", " (2)"),
    });
    setState("messagesDelivered", "s1", true);

    const buttons = await waitFor(() => {
      const els = container.querySelectorAll(".msg-copy");
      if (els.length < 2) throw new Error(`expected 2 copy buttons, got ${els.length}`);
      return Array.from(els) as HTMLElement[];
    });
    const [btn1, btn2] = buttons;

    // Row 1: contextmenu then hold-click -> dedupes to one thinking copy.
    fireEvent.pointerDown(btn1);
    fireEvent.contextMenu(btn1);
    clock += HOLD_THRESHOLD_MS;
    fireEvent.click(btn1);

    // Row 2: fresh hold-click, NO contextmenu -> must copy thinking (call #2).
    fireEvent.pointerDown(btn2);
    clock += HOLD_THRESHOLD_MS;
    fireEvent.click(btn2);

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(1, WITH_THINKING);
    expect(writeText).toHaveBeenNthCalledWith(
      2,
      "<think>let me think step by step (2)</think>\nthe answer is 42 (2)",
    );
  });
});
