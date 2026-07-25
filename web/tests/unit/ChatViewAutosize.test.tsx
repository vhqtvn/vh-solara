// @vitest-environment jsdom
//
// Regression test for the composer autosize collapse on session switch-back.
// (Slice A of the composer-history split.)
//
// BUG: switching away from a session with a multi-line draft and back left the
// textarea collapsed toward rows=1 until the next keystroke re-measured. Root
// cause: the autosize effect measured ta.scrollHeight from a queueMicrotask
// callback, which runs BEFORE the browser's style-recalc/layout phase of the
// frame. On switch-back the draft-restore setInput() changes the value, but the
// microtask measured the PRE-LAYOUT (stale) scrollHeight, so the composer was
// sized to the PREVIOUS session's (empty) content. Fix: defer the measure to
// requestAnimationFrame, whose callback runs AFTER layout.
//
// jsdom has NO layout engine (native scrollHeight is a constant 0), so this
// test installs a FAITHFUL model of the race: scrollHeight reflects the value
// as of the last rAF "layout flush", NOT the just-set value. value writes only
// update a `pending` slot; an rAF callback firing commits pending -> laidOut.
// With the OLD queueMicrotask scheduling, autosize runs in a microtask (before
// any rAF flush) -> stale -> wrong height (RED). With requestAnimationFrame the
// rAF flush commits the value first -> current -> correct height (GREEN).
//
// To make stale-vs-correct unambiguous, session A has 4 lines (96px) and B is
// empty (24px). On switch-back to A, the stale measure (B's empty content)
// yields 24px (RED); the post-layout measure (A's 4 lines) yields 96px (GREEN).

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// ChatView's transitive deps). Install the stub BEFORE any import that triggers
// layout.ts — vi.hoisted runs before ESM imports.
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
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

// --- Mocks ------------------------------------------------------------------
// ChatView reads agents()/models() during render (the composer bar). Provide
// empty/minimal fixtures so the component mounts without the real loaders'
// network calls. We do NOT exercise send(), so sync/queue stay real (openSession
// just reserves an empty message slot — safe in jsdom).

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

// --- Faithful layout-race mock ----------------------------------------------
// Per-textarea state: `pending` = the value Solid just wrote; `laidOut` = the
// value as of the last rAF flush. scrollHeight reads `laidOut` (stale until a
// flush). rAF callback firing commits pending -> laidOut for every tracked ta.

const LINE_H = 24; // px per content line (matches the ~1.5 line-height body font)
function linesOf(v: string): number {
  return Math.max(String(v ?? "").split("\n").length, 1);
}

const taLayout = new WeakMap<HTMLTextAreaElement, { pending: string; laidOut: string }>();
const trackedTAs = new Set<HTMLTextAreaElement>();

const TA_PROTO = HTMLTextAreaElement.prototype;
const NATIVE_VALUE_DESC = Object.getOwnPropertyDescriptor(TA_PROTO, "value");
const NATIVE_RAF = window.requestAnimationFrame.bind(window);

let installed = false;
function installLayoutRaceMock() {
  if (installed) return;
  installed = true;
  // value: delegate to jsdom's native setter, then mark layout dirty.
  Object.defineProperty(TA_PROTO, "value", {
    configurable: true,
    enumerable: true,
    get(this: HTMLTextAreaElement) {
      return NATIVE_VALUE_DESC?.get?.call(this) ?? "";
    },
    set(this: HTMLTextAreaElement, v: string) {
      NATIVE_VALUE_DESC?.set?.call(this, v);
      const s = taLayout.get(this);
      if (s) s.pending = String(v);
      else {
        taLayout.set(this, { pending: String(v), laidOut: String(v) });
        trackedTAs.add(this);
      }
    },
  });
  // scrollHeight: derived from the LAID-OUT value (stale pre-flush). Shadows
  // the inherited Element.prototype getter for textareas only.
  Object.defineProperty(TA_PROTO, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      const s = taLayout.get(this);
      const v = s ? s.laidOut : String(NATIVE_VALUE_DESC?.get?.call(this) ?? "");
      return linesOf(v) * LINE_H;
    },
  });
  // rAF callback firing = the layout flush point. Commit pending -> laidOut
  // BEFORE invoking the scheduled callback (autosize), so the measure reads the
  // post-layout value.
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    NATIVE_RAF((time) => {
      for (const ta of trackedTAs) {
        const s = taLayout.get(ta);
        if (s) s.laidOut = s.pending;
      }
      cb(time);
    })) as typeof window.requestAnimationFrame;
}

function restoreLayoutRaceMock() {
  if (!installed) return;
  installed = false;
  if (NATIVE_VALUE_DESC) Object.defineProperty(TA_PROTO, "value", NATIVE_VALUE_DESC);
  // Remove our shadowing getter — the inherited Element getter returns.
  delete (TA_PROTO as any).scrollHeight;
  window.requestAnimationFrame = NATIVE_RAF;
  trackedTAs.clear();
}

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";

// Wait long enough for at least one rAF (jsdom rAF ~16ms) + the microtask queue
// to fully drain, so each session switch's autosize has settled before the next.
const settle = () => new Promise<void>((r) => setTimeout(r, 100));

// versioned-envelope helper matching lib/store.saveVersioned.
function seedDraft(sid: string, text: string) {
  localStorage.setItem("vh.draft." + sid, JSON.stringify({ v: 1, data: text }));
}

describe("composer autosize — session switch-back (slice A)", () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    })) as any;
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
    (globalThis as any).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
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
    installLayoutRaceMock();
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    restoreLayoutRaceMock();
    (globalThis as any).fetch = undefined;
    localStorage.clear();
  });

  it("sizes the textarea to the restored multi-line draft after switching back (not the stale previous-session height)", async () => {
    // Session A has a 4-line draft (-> 96px); session B is empty (-> 24px).
    seedDraft("session-A", "line one\nline two\nline three\nline four");
    const A_H = `${4 * LINE_H}px`; // 96px

    const [sid, setSid] = createSignal("session-A");
    const { container } = render(() => <ChatView sessionId={sid()} />);

    const ta = () => container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
    expect(ta()).toBeTruthy();

    // Let the initial mount's autosize settle.
    await settle();

    // Switch A -> B (empty draft). On the OLD code autosize here measures A's
    // stale 4-line scrollHeight (-> 96px, wrong for B); we let it settle so the
    // stale baseline advances to B's empty value before the switch-back.
    setSid("session-B");
    await settle();

    // Switch back to A — the draft-restore effect re-loads the 4-line draft.
    setSid("session-A");
    await settle();

    // After the switch-back has fully settled:
    //   GREEN (requestAnimationFrame): the rAF flush commits the restored value
    //     before autosize measures -> height tracks the 4-line content (96px).
    //   RED (queueMicrotask): the microtask measures the stale (B's empty)
    //     scrollHeight -> height collapses to a single line (24px).
    expect(ta().style.height).toBe(A_H);
  });
});
