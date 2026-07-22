// @vitest-environment jsdom
//
// Regression test for the O1 collapsed-frontier cold-stub REVEAL-GATE DEADLOCK
// (ISSUE 1).
//
// Background: the O1 collapsed-frontier projection collapses most idle sessions
// to CollapsedBranchStub rows, so opening one is a COLD load. A cold session
// delivers in TWO SSE frames:
//   1. messages.batch  — wholesale-sets state.messages[sid] (DOM grows)
//   2. messages.loaded — sets state.messagesLoaded[sid]=true (NO DOM change)
//
// ChatView's reveal gate holds `.chat-content` at opacity:0 (CSS class `.ready`
// absent) until `revealed()` is true. Before the fix `revealed()` was
// `ready() && (delivered() || messageFailed())`, and `ready()` was flipped true
// ONLY inside `maybeRestore()` — which is driven by a content ResizeObserver.
// On a cold load where the user has a STOREED READ ANCHOR not present in the
// partial batch, maybeRestore() defers (anchor absent + delivered=false) without
// setting ready. messages.loaded then flips delivered=true but adds NO DOM, so
// the ResizeObserver never re-fires → maybeRestore never re-runs → ready stays
// false → revealed() false → transcript stuck at opacity:0 FOREVER. Switch-away
// +back worked because on the 2nd visit messages were resident AND delivered.
//
// In jsdom ResizeObserver is a no-op stub, so the ONLY drivers of maybeRestore
// are the switch-effect rAF fallback and the new delivered-flip self-heal
// effect — which cleanly isolates that effect under test.

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// code/frame.ts via ChatView's transitive deps). Install the stub BEFORE any
// import that triggers layout.ts — vi.hoisted runs before ESM imports.
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
import { cleanup, render, waitFor } from "@solidjs/testing-library";

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

// sync: keep the REAL store — we drive state.messages / messagesLoaded directly
// to reproduce the two-frame cold delivery. (No override needed.)

// jsdom lacks window.matchMedia (module-load read by layout.ts),
// IntersectionObserver, PointerEvent, and ResizeObserver. Stub fetch too
// (ChatView onMount may issue unrelated fetches). ResizeObserver is a deliberate
// no-op so the only drivers of maybeRestore are the rAF fallback + the new
// delivered-flip self-heal effect.
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
  (globalThis as any).fetch = undefined;
});

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";
import { state, setState } from "../../src/sync/store";
import { clearReadAnchor, setReadAnchor } from "../../src/lib/scroll";

// Minimal MessageView stub. ChatView's render reads m.info.role (for the
// user-turn navigator filter), m.partOrder, m.parts, m.id. With partOrder=[]
// no PartView is rendered, keeping the test cheap and isolated from Part.
const mkMsg = (id: string): any => ({
  id,
  info: { role: "user" },
  partOrder: [],
  parts: {},
});

const readyClass = (container: HTMLElement): string =>
  container.querySelector(".chat-content")?.className ?? "";

describe("ChatView reveal-gate — O1 cold-stub deadlock self-heal", () => {
  afterEach(() => {
    cleanup();
    clearReadAnchor("s1");
    clearReadAnchor("s2");
    setState("messages", "s1", undefined as any);
    setState("messages", "s2", undefined as any);
    setState("messagesLoaded", "s1", undefined as any);
    setState("messagesLoaded", "s2", undefined as any);
    setState("messagesError", "s1", undefined as any);
    setState("messagesError", "s2", undefined as any);
  });

  it("reveals when a cold session delivers the stored-anchor messages only in the loaded frame", async () => {
    // Stored read anchor that is ABSENT from the partial batch (m4).
    setReadAnchor("s1", "m4");

    const { container } = render(() => <ChatView sessionId="s1" />);
    // openSession (called from ChatView's session effect on mount) reserves a
    // cold empty slot; messagesLoaded stays false.
    await waitFor(() => expect(state.messages["s1"]).toBeTruthy());

    // Frame 1 — messages.batch: order grows but the seeded anchor m4 is absent.
    setState("messages", "s1", {
      order: ["m1", "m2", "m3"],
      byId: { m1: mkMsg("m1"), m2: mkMsg("m2"), m3: mkMsg("m3") },
    });
    // Drain the microtask + rAF queue so the switch-effect rAF fallback fires.
    // It defers (anchor absent + delivered=false) and leaves the gate closed.
    await new Promise((r) => setTimeout(r, 30));
    expect(readyClass(container)).not.toMatch(/\bready\b/);

    // Frame 2 — messages.loaded: delivered() flips true but adds NO DOM. Before
    // the fix the ResizeObserver never re-fired → maybeRestore never re-ran →
    // the gate stayed closed forever (the deadlock). The delivered-flip self-heal
    // effect must re-run maybeRestore → with delivered=true the defer condition
    // is false → maybeRestore proceeds → setReady(true) → revealed() → .ready.
    setState("messagesLoaded", "s1", true);
    await waitFor(() => {
      expect(readyClass(container)).toMatch(/\bready\b/);
    });
  });

  it("latch keeps a revealed transcript shown across a transient delivered() drop (resync re-snapshot)", async () => {
    // Anchor IS present in the batch — first reveal takes the normal path.
    setReadAnchor("s2", "m1");
    const { container } = render(() => <ChatView sessionId="s2" />);
    await waitFor(() => expect(state.messages["s2"]).toBeTruthy());
    setState("messages", "s2", { order: ["m1"], byId: { m1: mkMsg("m1") } });
    setState("messagesLoaded", "s2", true);
    await waitFor(() => {
      expect(readyClass(container)).toMatch(/\bready\b/);
    });

    // Simulate a resync/reconnect cold re-snapshot: applySessionSnapshot sets
    // messagesLoaded=false on a cold snapshot, so delivered() transiently drops.
    // The base gate would close (ready && delivered → false); the per-session
    // reveal latch must hold the already-shown, populated transcript visible.
    setState("messagesLoaded", "s2", false);
    // Give effects a tick to settle; the .ready class must NOT disappear.
    await new Promise((r) => setTimeout(r, 30));
    expect(readyClass(container)).toMatch(/\bready\b/);
  });
});
