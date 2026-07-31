// @vitest-environment jsdom
//
// Shared mount + mock harness for the ChatView MESSAGE-ROW characterization
// tests — the ~150-LOC `<For>` row callback at ChatView.tsx (~1588-1739), the
// extraction candidate for a future `MessageRow` component.
//
// Centralizes the vi.mock boilerplate every row test needs (agents/models —
// same shape as ChatViewPartlessMessage/ChatViewCopyHold), a CONTROLLABLE
// IntersectionObserver mock (so deferred-row tests can fire intersections), the
// jsdom-missing browser globals ChatView reads at mount/render, and small store
// seed helpers that mutate IN PLACE (preserving message-object references —
// load-bearing for the row-DOM-identity and MessageParts-cache invariants).
//
// Mirrors the `_chatSendHarness` import-time-mock trick: vi.mock declared in an
// imported helper DOES apply to the importing test file's module graph
// (verified), so a bare `import "./_chatRowHarness"` placed BEFORE any
// `ChatView` import registers every mock. Each test file gets its OWN isolated
// copy (vitest isolates module registries per file), so the `ioRecords` array +
// clipboard spy never leak across files.
import "./_matchMedia";
import { expect, vi } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { produce } from "solid-js/store";
import { setState, state } from "../../src/sync/store";
import ChatViewComp from "../../src/components/ChatView";

export { ChatViewComp as ChatView };

// --- agents mock: ChatView's readyToSend memo requires agents() non-empty.
vi.mock("../../src/agents", () => ({
  agents: () => [{ name: "build", description: "build agent", mode: "primary" }],
  selectedAgent: () => "build",
  agentForSession: () => "build",
  activeAgent: () => "build",
  selectAgentForSession: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgent: vi.fn(),
}));

// --- models mock: readyToSend requires models() non-empty; selectionFor("")→null.
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

// --- controllable IntersectionObserver mock --------------------------------
// Each constructed observer records {cb, opts, root, target, disconnected}.
// Deferred-row tests call `fireIntersectFor(target)` to drive activation; the
// other row tests simply let observers sit idle (deferred rows never activate,
// which is fine because those tests use eager rows). The Deferred observer is
// distinguishable from ChatView's loadMoreObserver by rootMargin ("1200px 0px"
// vs "600px 0px 0px 0px"); callers query by the observed `.msg-parts` target.
export interface IORecord {
  cb: IntersectionObserverCallback;
  opts: IntersectionObserverInit;
  root: Element | Document | null;
  target: Element | null;
  disconnected: boolean;
}
export const ioRecords: IORecord[] = [];

class ControllableIO {
  cb: IntersectionObserverCallback;
  opts: any;
  root: Element | Document | null;
  target: Element | null = null;
  disconnected = false;
  constructor(cb: IntersectionObserverCallback, opts: any) {
    this.cb = cb;
    this.opts = opts || {};
    this.root = this.opts.root ?? null;
    // Push the public shape (the instance is also the observer passed back to
    // the callback as the 2nd arg, so it must carry `disconnect`).
    ioRecords.push(this as unknown as IORecord);
  }
  observe(t: Element) {
    this.target = t;
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}

/** Fire an intersection callback for the observer watching `target`. */
export function fireIntersectFor(target: Element, isIntersecting = true): IORecord {
  const rec = ioRecords.find((r) => r.target === target);
  if (!rec) {
    throw new Error(
      "fireIntersectFor: no IntersectionObserver recorded for the given target. " +
        "Ensure the row has mounted (onMount creates the Deferred observer).",
    );
  }
  rec.cb(
    [{ isIntersecting } as unknown as IntersectionObserverEntry],
    { disconnect: () => {} } as unknown as IntersectionObserver,
  );
  return rec;
}

// --- browser globals + per-test reset -------------------------------------

/** Install jsdom-missing browser globals ChatView reads at mount/render. Resets
 *  `ioRecords` so observer counts are per-test. */
export function setupRowGlobals() {
  ioRecords.length = 0;
  (globalThis as any).IntersectionObserver = ControllableIO;
  (globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    // NOTE: `json: () => ({})` (not an array) makes render.ts's flush() throw
    // → it catches and resolves every markdown render to "" → MarkdownHtml's
    // `<Show when={html()}>` stays on the synchronous fallback `.md` branch,
    // so the `.md` element reference is stable (no resource-resolution swap).
    json: async () => ({}),
    text: async () => "",
  }));
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).PointerEvent = class extends MouseEvent {
    pointerId = 0;
    pointerType = "";
  };
  if (!(globalThis as any).requestAnimationFrame) {
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0) as unknown as number;
    (globalThis as any).cancelAnimationFrame = (h: number) => clearTimeout(h);
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
}

export function teardownRowGlobals() {
  (globalThis as any).fetch = undefined;
}

/** Install a navigator.clipboard.writeText spy; returns the captured writes. */
export function installClipboardSpy(): string[] {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: (t: string) => {
        writes.push(t);
        return Promise.resolve();
      },
    },
    configurable: true,
    writable: true,
  });
  return writes;
}

/** Render ChatView for `sessionId` and wait for openSession to reserve the cold
 *  slot BEFORE the test seeds messages (seeding before the slot is reserved can
 *  be clobbered by openSession's empty `{order:[],byId:{}}`). */
export async function mountChatView(sessionId: string) {
  const utils = render(() => <ChatViewComp sessionId={sessionId} />);
  await waitFor(() => expect((state as any).messages[sessionId]).toBeTruthy());
  return utils;
}

// --- store seed helpers (all IN PLACE → preserve message references) -------

/** Seed messages for a session (wholesale) and mark delivered. */
export function seedMessages(sessionId: string, byId: Record<string, any>) {
  setState("messages", sessionId, { order: Object.keys(byId), byId });
  setState("messagesDelivered", sessionId, true);
}

/** Append a message IN PLACE (keeps all existing message-object references —
 *  load-bearing for `<For>` row-DOM-identity). */
export function appendMessage(sessionId: string, msg: any) {
  setState(
    "messages",
    sessionId,
    produce((sm: any) => {
      sm.order.push(msg.id);
      sm.byId[msg.id] = msg;
    }),
  );
}

/** Stream a new part onto an existing message IN PLACE. Mirrors the production
 *  upsertPart shape (partOrder.push + parts[id]=part) so the message object AND
 *  its existing parts keep their references (load-bearing for MessageParts'
 *  keyed cache → no remount). */
export function streamPart(sessionId: string, messageId: string, part: any) {
  setState(
    "messages",
    sessionId,
    produce((sm: any) => {
      const msg = sm.byId[messageId];
      if (!msg.partOrder.includes(part.id)) msg.partOrder.push(part.id);
      msg.parts[part.id] = part;
    }),
  );
}

// --- message/part builders -------------------------------------------------

export function mkTextPart(id: string, text: string): any {
  return { id, type: "text", text };
}
export function mkReasoningPart(id: string, text: string): any {
  return { id, type: "reasoning", text };
}
/** A synchronous marker part (agent/step-finish/patch/...). Renders a stable
 *  `[data-kind=<type>]` element via PartMarker with NO resource fetch — the
 *  robust observable for MessageParts-cache reference-equality assertions
 *  (no createResource swap can change the element identity). */
export function mkMarkerPart(id: string, type: string, extra: Record<string, any> = {}): any {
  return { id, type, ...extra };
}

export function mkAssistant(
  id: string,
  partOrder: string[],
  parts: Record<string, any>,
  extraInfo: Record<string, any> = {},
): any {
  return {
    id,
    info: { role: "assistant", time: { created: 1000, completed: 2000 }, ...extraInfo },
    partOrder,
    parts,
  };
}

/** Minimal user message (no parts) — cheap row for padding the list past
 *  EAGER_TAIL so a target assistant row becomes deferred. */
export function mkUser(id: string): any {
  return { id, info: { role: "user", time: { created: 1000 } }, partOrder: [], parts: {} };
}

// NOTE: `setState`/`state` are imported at the top for internal use only and are
// NOT re-exported here. Re-exporting imported bindings through a vi.mock-bearing
// helper produces a broken live binding under vitest's transform (verified: the
// `_chatSendHarness` re-export of state/setState is dead code, never consumed).
// Test files import `setState` directly from `../../src/sync/store` for their
// afterEach cleanup, mirroring ChatViewPartlessMessage.test.tsx.
