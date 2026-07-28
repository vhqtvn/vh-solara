// @vitest-environment jsdom
//
// F-SHAPE-B UX safety net for S5: a completed-but-partless assistant message
// (completed assistant message with ZERO resident renderable parts) must NEVER
// render as a silent empty "completed" message. The brief fetch window before
// parts arrive (the residual hydration gap) OR a real fetch failure must show
// an explicit placeholder instead.
//
// The S5 primary fix (Go side) makes the daemon serve parts by deriving
// loaded-state from resident parts. This is defense-in-depth for the RESIDUAL
// case the daemon cannot fully close: the UI must never silently render a
// completed message as empty while its parts are not resident.
//
// This is a RENDER test through the full ChatView (same harness shape as
// ChatViewRevealDeadlock): it seeds a completed-partless assistant message and
// asserts the placeholder DOM is present, then guards the predicate (resident
// parts → no placeholder) and the failed variant (messagesError → failed hint).

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

// jsdom lacks window.matchMedia (module-load read by layout.ts),
// IntersectionObserver, PointerEvent, and ResizeObserver. Stub fetch too
// (ChatView onMount may issue unrelated fetches). ResizeObserver is a deliberate
// no-op so the only drivers of maybeRestore are the rAF fallback + effects.
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
import { setState } from "../../src/sync/store";

// A COMPLETED assistant message with ZERO resident parts — the F-SHAPE-B
// residual hydration shape. partOrder is empty so groupParts() resolves nothing
// and MessageParts would (before the fix) render an empty .msg-parts.
const mkPartlessCompleted = (id: string): any => ({
  id,
  info: { role: "assistant", time: { created: 1000, completed: 2000 } },
  partOrder: [],
  parts: {},
});

// A COMPLETED assistant message WITH a resident text part — the negative case:
// the placeholder must NOT appear once parts are resident.
const mkCompletedWithText = (id: string): any => ({
  id,
  info: { role: "assistant", time: { created: 1000, completed: 2000 } },
  partOrder: ["p1"],
  parts: { p1: { id: "p1", sessionID: "s1", messageID: id, type: "text", text: "hello" } },
});

const seed = (byId: Record<string, any>) =>
  setState("messages", "s1", { order: Object.keys(byId), byId });

describe("ChatView F-SHAPE-B — partless-completed assistant message safety net", () => {
  afterEach(() => {
    cleanup();
    setState("messages", "s1", undefined as any);
    setState("messagesLoaded", "s1", undefined as any);
    setState("messagesError", "s1", undefined as any);
  });

  it("renders a loading placeholder (not empty content) for a completed-but-partless assistant message", async () => {
    // The residual hydration window: the turn completed (info.time.completed),
    // but no parts are resident yet. Before the safety net this rendered an
    // EMPTY .msg-parts under a fully-populated message head — a silent
    // "completed, 0 parts" message. The placeholder must be present instead.
    const { container } = render(() => <ChatView sessionId="s1" />);
    // openSession (called from ChatView's session effect on mount) reserves a
    // cold empty slot; wait for it before seeding.
    await waitFor(() => expect((container as any).ownerDocument && true).toBe(true));
    seed({ m1: mkPartlessCompleted("m1") });
    setState("messagesLoaded", "s1", true);

    // The assistant row must be present (guards against a false red from the
    // message not rendering at all).
    await waitFor(() =>
      expect(container.querySelector(".msg.assistant")).toBeTruthy(),
    );
    // The safety-net placeholder must be present (RED before the fix).
    await waitFor(() =>
      expect(container.querySelector(".msg-partless")).toBeTruthy(),
    );
    // Pending variant (no session error) — explicit, not a silent empty row.
    const ph = container.querySelector(".msg-partless") as HTMLElement;
    expect(ph.getAttribute("data-failed")).toBe("false");
    expect(ph.textContent).toMatch(/loading/i);
  });

  it("does not show the placeholder once the completed assistant message has resident parts", async () => {
    // Negative guard for the predicate: once a part resolves, groupParts()
    // returns it and the placeholder MUST disappear (no false positive on a
    // fully-hydrated completed message).
    const { container } = render(() => <ChatView sessionId="s1" />);
    seed({ m1: mkCompletedWithText("m1") });
    setState("messagesLoaded", "s1", true);

    await waitFor(() =>
      expect(container.querySelector(".msg.assistant")).toBeTruthy(),
    );
    // Give effects a tick to settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector(".msg-partless")).toBeNull();
  });

  it("shows the explicit failed variant when the session hydration errored (messagesError)", async () => {
    // A real fetch failure: messagesError flips true (the existing session-level
    // facet). The partless-completed message would otherwise spin a loading
    // placeholder forever — misleading, since parts will never arrive. The
    // placeholder must surface the failure explicitly instead.
    const { container } = render(() => <ChatView sessionId="s1" />);
    seed({ m1: mkPartlessCompleted("m1") });
    setState("messagesError", "s1", true);

    await waitFor(() =>
      expect(container.querySelector(".msg.assistant")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(container.querySelector(".msg-partless")).toBeTruthy(),
    );
    const ph = container.querySelector(".msg-partless") as HTMLElement;
    expect(ph.getAttribute("data-failed")).toBe("true");
    expect(ph.textContent).toMatch(/failed/i);
  });
});
