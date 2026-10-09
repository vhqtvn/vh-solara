// @vitest-environment jsdom
//
// Shared mount + mock harness for the ChatView SEND-CLUSTER characterization
// tests (the ~190-LOC send()/sendText()/dispatchQueuedItem/dispatchSend/
// runShell cluster in ChatView.tsx). Centralizes the vi.mock boilerplate every
// send test needs, following the ChatViewDraftSend.test.tsx precedent — but in
// ONE imported helper so each test file stays focused on behavior rather than
// re-declaring ~80 LOC of identical agents/models/sync/queue mocks.
//
// vi.mock declared in an imported helper DOES apply to the importing test
// file's module graph (verified), so a bare `import "./_chatSendHarness"`
// placed BEFORE `import ChatView` is sufficient to register every mock. Each
// test file gets its OWN isolated copy of this module (vitest isolates module
// registries per file), so the `H` handles never leak across files.
import "./_matchMedia";
import { vi, expect } from "vitest";
import { fireEvent } from "@testing-library/dom";
import { waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import type { Accessor } from "solid-js";
// The real sync store (sync/store is NOT mocked — only the sync facade is).
import { state, setState, setSelectedIdRaw, setDraft } from "../../src/sync/store";
import type { QueueInput } from "../../src/queue";
import type { SaveGestureInput, OutboxSaveResult } from "../../src/lib/outbox";
import { produce } from "solid-js/store";
import { __resetSendSingleFlightForTests } from "../../src/lib/sendSingleFlight";
// ChatView default export. Imported AFTER the vi.mock blocks below are hoisted,
// so the component resolves through the mocked module graph.
import ChatViewComp from "../../src/components/ChatView";

export { ChatViewComp as ChatView };

// The fixture agent name (declares an OpenAI/GPT model — used by the draft
// model-migration characterization).
export const GPT_AGENT_NAME = "gpt-build";

// Hoisted, MUTABLE mock handles. `H` is created once per test-file module
// instance and is referenced by the vi.mock factories below (which run later,
// when the mocked modules are imported — by then H is initialized). H itself is
// NOT exported: vitest forbids exporting a vi.hoisted binding, so tests reach
// the handles through the `mocks` getter wrapper (same live references).
const H = vi.hoisted(() => ({
  // createSession: by default drives the REAL setSelectedId against the live
  // sync store (draft->live flip), mirroring production. Override per-test to
  // simulate failure (return null) or a different id.
  createSession: vi.fn(async (): Promise<string | null> => {
    const { setSelectedId } = await import("../../src/sync");
    setSelectedId("new-session-id");
    return "new-session-id";
  }),

  // Slice 2 lever: when true, the createSessionWithCertainty wrapper answers
  // {id:null, certainty:"unknown"} (timeout / proxy-502 shape) WITHOUT calling
  // createSession — for the outcome-unknown draft-send tests.
  createSessionUnknownCertainty: false,

  // enqueue: default resolves a minimal queue item WITHOUT touching the queue
  // store (so the drainer does not fire — the drain is area 5; areas 1-4 care
  // only about the enqueue custody + composer-ownership contract). Override
  // per-test to reject (enqueue failure) or hold open (slow enqueue).
  enqueue: vi.fn(async (_sessionId: string, _input: QueueInput) => ({
    id: "q-enq",
    order: 1,
    state: "pending" as const,
    text: "",
    attachments: [],
    createdAt: 0,
  })),

  // Shared mutable queue store, keyed by sessionId — the authority the mocked
  // queueFor/hasQueueState/claim/resolve read+mutate. Seed it (seedPendingItem)
  // to exercise the drain path (area 5); leave empty to keep the drainer idle.
  queueStore: { items: {} as Record<string, any[]> },

  // Slice 3 (intent recovery): controllable OpenCode down-state. When set,
  // the mocked opencode-lifecycle snapshot reports down_since (daemon-observed
  // death) — the send/dispatch failure paths render the down-tied copy.
  // Faithful default: undefined = no snapshot = never down, so every pre-slice
  // behavior test sees the exact old copy. Set via mocks.lifecycleDownSince.
  lifecycle: { downSince: undefined as string | undefined },

  // Slice 3 (intent recovery): recorder for the REAL notify surface ChatView
  // calls (pushNotification). The mock forwards to the actual implementation
  // (so notification-driven UI keeps working) and records every call for
  // assertions. Read via mocks.notifications().
  notify: { pushed: [] as any[] },

  // claim/resolve/fetchQueue are wired to read+mutate queueStore by default
  // (set in resetHarness), so the drain behaves like a faithful in-memory
  // backend (pending → dispatching → terminal). Override per-test as needed.
  claim: vi.fn(),
  resolve: vi.fn(),
  fetchQueue: vi.fn(),

  // Faithful model-selection state for the draft->live migration test:
  // bySession holds per-session picks, explicit marks which were user-chosen
  // (applyAgentModel respects an explicit pick; migrateModelPick moves one
  // across ids). There is NO global-default fallback in selectionFor, so a
  // real session id resolves to the draft pick ONLY through migration.
  modelsState: {
    bySession: {} as Record<string, { providerID: string; modelID: string; variant?: string }>,
    explicit: new Set<string>(),
  },

  // Send-net-resilience slice 3: the outbox seam ChatView binds into
  // createSend + the replacement controller. Defaults model a HEALTHY memory
  // outbox (save always commits; no captured head → the stale gate never
  // fabricates staleness; no replacement overlays), so every pre-slice test
  // sees the old admission behavior through the new gate. Override per-test
  // via mocks.outbox*.
  outboxSave: vi.fn(async (_input: SaveGestureInput): Promise<OutboxSaveResult> => ({ ok: true })),
  outboxMarkAdmitted: vi.fn(async (_intentId: string, _queueItemId: string) => {}),
  outboxCapturedHeadFor: vi.fn(async () => null),
  outboxDropGesture: vi.fn(async () => {}),
  outboxReconcile: vi.fn(async () => {}),
  outboxReplacementFor: undefined as string | undefined,
}));

// --- agents mock -----------------------------------------------------------
// ChatView's readyToSend memo requires agents() non-empty. Provide one fixture
// agent that declares a GPT model + variant.
vi.mock("../../src/agents", () => ({
  agents: () => [{
    name: GPT_AGENT_NAME,
    description: "gpt agent",
    mode: "primary",
    model: { providerID: "openai", modelID: "gpt-4" },
    variant: "high",
  }],
  selectedAgent: () => GPT_AGENT_NAME,
  agentForSession: () => GPT_AGENT_NAME,
  awaitSendAgent: async () => ({ ok: true, agent: GPT_AGENT_NAME }),
  resolveAgentForSession: () => ({ state: "agent", agent: GPT_AGENT_NAME }),
  adoptDraftAgent: vi.fn(),
  selectAgentForSession: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgent: vi.fn(),
}));

// --- models mock (faithful per-session selection state) --------------------
// readyToSend requires models() non-empty for a draft. selectionFor returns the
// per-session pick ONLY (no global default) so the draft->live migration test
// is meaningful (a real id resolves to the explicit pick only via migration).
vi.mock("../../src/models", () => ({
  models: () => [{
    providerID: "openai",
    modelID: "gpt-4",
    provider: "OpenAI",
    name: "GPT-4",
    label: "OpenAI / GPT-4",
    variants: ["high"],
  }],
  selectionFor: (id: string) => H.modelsState.bySession[id] ?? null,
  findModel: (p: string, m: string) =>
    p === "openai" && m === "gpt-4"
      ? { providerID: "openai", modelID: "gpt-4", variants: ["high"] }
      : undefined,
  chooseModel: (id: string, p: string, m: string) => {
    H.modelsState.bySession[id] = { providerID: p, modelID: m };
    H.modelsState.explicit.add(id);
  },
  chooseVariant: (id: string, variant: string | undefined) => {
    const cur = H.modelsState.bySession[id];
    if (cur) H.modelsState.bySession[id] = { ...cur, variant };
    H.modelsState.explicit.add(id);
  },
  applyModel: vi.fn(),
  applyAgentModel: (id: string, p: string, m: string, variant?: string) => {
    if (H.modelsState.explicit.has(id)) return;
    H.modelsState.bySession[id] = { providerID: p, modelID: m, variant };
  },
  migrateModelPick: (from: string, to: string) => {
    if (from === to) return;
    if (H.modelsState.bySession[from]) {
      H.modelsState.bySession[to] = H.modelsState.bySession[from];
      delete H.modelsState.bySession[from];
    }
    if (H.modelsState.explicit.has(from)) {
      H.modelsState.explicit.add(to);
      H.modelsState.explicit.delete(from);
    }
  },
  loadModels: vi.fn(),
}));

// --- sync mock (real store + controllable createSession) -------------------
// Keep the REAL store so setSelectedId flips the real selectedId/draft signals
// exactly as in production; override only createSession (+ the certainty-
// carrying variant ChatView.ensureSession consumes, slice 2). Tests keep
// controlling the OUTCOME through mocks.createSession; the wrapper adds the
// certainty field. Set mocks.createSessionUnknownCertainty = true to simulate
// the outcome-unknown create failure (timeout / proxy 502 shape).
vi.mock("../../src/sync", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createSession: H.createSession,
    createSessionWithCertainty: async (): Promise<{
      id: string | null;
      certainty: "definitive" | "unknown";
      detail?: string;
    }> => {
      if (H.createSessionUnknownCertainty) {
        return { id: null, certainty: "unknown", detail: "mocked outcome-unknown create" };
      }
      const id = await H.createSession();
      return id
        ? { id, certainty: "definitive" }
        : { id: null, certainty: "definitive", detail: "mocked definitive create failure" };
    },
  };
});

// --- queue mock (controllable, reads/writes H.queueStore) ------------------
// Spread the real module and override the surfaces ChatView's send cluster
// touches. queueFor/hasQueueState/claim/resolve are wired to the in-memory
// queueStore so the drain path (area 5) is faithful.
vi.mock("../../src/queue", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueue: H.enqueue,
    queueFor: (id: string) =>
      (H.queueStore.items[id] || []).filter((m: any) => m.state !== "sent"),
    hasQueueState: (id: string) =>
      (H.queueStore.items[id] || []).some((m: any) => m.state !== "sent"),
    claimQueued: H.claim,
    resolveQueued: H.resolve,
    fetchQueue: H.fetchQueue,
    migrateLegacyQueue: async () => true,
    removeQueued: async () => ({ removed: true }),
    queueMode: () => true,
  };
});

// --- opencode-lifecycle mock (slice 3: controllable down-state) ------------
// Spread the real module; override ONLY `snapshot` so it reports down_since
// when the test sets H.lifecycle.downSince (daemon-observed OpenCode death —
// S1/S2 knowledge: down_since set = down). Default (undefined) = no snapshot,
// matching a worker without lifecycle endpoints, so every failure path keeps
// its exact pre-slice copy.
vi.mock("../../src/opencode-lifecycle", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    snapshot: () =>
      H.lifecycle.downSince
        ? { ...(actual.UNKNOWN_SNAPSHOT as object), state: "failed", down_since: H.lifecycle.downSince }
        : null,
  };
});

// --- notify mock (slice 3: record-only spy) ---------------------------------
// Forward to the REAL pushNotification (notification-driven UI in these tests
// keeps working unchanged) and record every call so failure-copy tests can
// assert the surfaced notification without poking the store.
vi.mock("../../src/notify", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    pushNotification: (n: any) => {
      H.notify.pushed.push(n);
      return actual.pushNotification(n);
    },
  };
});

// --- outbox mock (slice 3: the BLK-A3 seam under test control) ---------------
// Spread the real module (types + the banner's storageFailure/evictionSuspected
// signals stay real — they can only arm when H.outboxSave is overridden to
// fail) and override exactly the functions ChatView binds: the four seam fns
// injected into createSend / the replacement controller, the queue-sync
// reconcile entry, and the replacement-overlay read. Defaults model a healthy
// memory outbox so all pre-slice tests keep their exact admission behavior.
vi.mock("../../src/lib/outbox", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    saveGesture: H.outboxSave,
    markAdmitted: H.outboxMarkAdmitted,
    capturedHeadFor: H.outboxCapturedHeadFor,
    dropGesture: H.outboxDropGesture,
    reconcileOutboxSession: H.outboxReconcile,
    replacementRequestedFor: (_intentId?: string) => H.outboxReplacementFor,
  };
});

// --- default behaviors for the queue drain fns -----------------------------
// Called by resetHarness(). Models a faithful in-memory backend: claim moves
// the oldest pending → dispatching (single winner); resolve records a terminal
// outcome that never repends.
function defaultClaim(id: string) {
  const arr = H.queueStore.items[id];
  if (!arr) return null;
  const it = arr.find((m: any) => m.state === "pending");
  if (!it) return null;
  it.state = "dispatching";
  return { ...it };
}
function defaultResolve(id: string, itemId: string, state: string, detail: string) {
  const arr = H.queueStore.items[id];
  if (!arr) return;
  const it = arr.find((m: any) => m.id === itemId);
  if (it) {
    it.state = state;
    it.detail = detail;
    it.resolvedAt = 2;
  }
}
function defaultFetchQueue(id: string) {
  return Promise.resolve((H.queueStore.items[id] || []).slice());
}

/** Restore every mock handle to its default + clear shared state. Call in
 *  afterEach so tests don't leak enqueue rejections, queue-store items, or
 *  model picks into each other. */
export function resetHarness() {
  H.createSession.mockReset();
  H.createSession.mockImplementation(async () => {
    const { setSelectedId } = await import("../../src/sync");
    setSelectedId("new-session-id");
    return "new-session-id";
  });
  H.enqueue.mockReset();
  H.enqueue.mockImplementation(async () => ({
    id: "q-enq",
    order: 1,
    state: "pending" as const,
    text: "",
    attachments: [],
    createdAt: 0,
  }));
  H.claim.mockReset();
  H.claim.mockImplementation(defaultClaim);
  H.resolve.mockReset();
  H.resolve.mockImplementation(defaultResolve);
  H.fetchQueue.mockReset();
  H.fetchQueue.mockImplementation(defaultFetchQueue);
  H.queueStore.items = {};
  H.lifecycle.downSince = undefined;
  H.notify.pushed = [];
  H.createSessionUnknownCertainty = false;
  H.modelsState.bySession = {};
  H.modelsState.explicit.clear();
  // Slice 3 outbox seam: restore the healthy-memory-outbox defaults.
  H.outboxSave.mockReset();
  H.outboxSave.mockImplementation(async () => ({ ok: true }) as const);
  H.outboxMarkAdmitted.mockReset();
  H.outboxMarkAdmitted.mockImplementation(async () => {});
  H.outboxCapturedHeadFor.mockReset();
  H.outboxCapturedHeadFor.mockImplementation(async () => null);
  H.outboxDropGesture.mockReset();
  H.outboxDropGesture.mockImplementation(async () => {});
  H.outboxReconcile.mockReset();
  H.outboxReconcile.mockImplementation(async () => {});
  H.outboxReplacementFor = undefined;
}

/** Install jsdom-missing browser globals ChatView reads at mount / on render:
 *  a permissive fetch stub, ResizeObserver (scrollEl/contentEl geometry),
 *  IntersectionObserver (load-older + jump-pill sentinels), PointerEvent
 *  (composer gesture handlers), requestAnimationFrame (autosize/nav), and
 *  scrollIntoView (jump-to-message). Tests that need URL-routed fetch replace
 *  globalThis.fetch AFTER calling this. */
export function setupBrowserGlobals() {
  (globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  }));
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).IntersectionObserver = class {
    root = null;
    rootMargin = "";
    thresholds = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  (globalThis as any).PointerEvent = class extends MouseEvent {
    pointerId = 0;
    pointerType = "";
  };
  // jsdom lacks requestAnimationFrame in some configs; alias to setTimeout(0).
  if (!(globalThis as any).requestAnimationFrame) {
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0) as unknown as number;
    (globalThis as any).cancelAnimationFrame = (h: number) => clearTimeout(h);
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
}

export function teardownBrowserGlobals() {
  (globalThis as any).fetch = undefined;
}

/** Read/write surface for the mock handles (vitest forbids exporting the
 *  vi.hoisted binding directly, so tests reach the live fns + mutable stores
 *  through these getters). Mutations to `mocks.queueStore` / `mocks.modelsState`
 *  hit the SAME objects the mocked queue/models modules read. */
export const mocks = {
  get createSession() {
    return H.createSession;
  },
  get enqueue() {
    return H.enqueue;
  },
  get claim() {
    return H.claim;
  },
  get resolve() {
    return H.resolve;
  },
  get fetchQueue() {
    return H.fetchQueue;
  },
  get createSessionUnknownCertainty() {
    return H.createSessionUnknownCertainty;
  },
  set createSessionUnknownCertainty(v: boolean) {
    H.createSessionUnknownCertainty = v;
  },
  get queueStore() {
    return H.queueStore;
  },
  // Slice 3 (intent recovery): set to an ISO timestamp to simulate the
  // daemon-observed OpenCode death (snapshot.down_since set); reset to
  // undefined in resetHarness/resetAll.
  get lifecycleDownSince() {
    return H.lifecycle.downSince;
  },
  set lifecycleDownSince(v: string | undefined) {
    H.lifecycle.downSince = v;
  },
  // Slice 3 (intent recovery): every pushNotification call ChatView made
  // (forwarded to the real notify store, recorded here for assertions).
  notifications(): ReadonlyArray<any> {
    return H.notify.pushed;
  },
  get modelsState() {
    return H.modelsState;
  },
  // Send-net-resilience slice 3: the outbox seam handles. Defaults (a healthy
  // memory outbox: save ok, no captured head, no overlays) are restored by
  // resetHarness; override per-test for the BLK-A3 / stale-context gates.
  get outboxSave() {
    return H.outboxSave;
  },
  get outboxMarkAdmitted() {
    return H.outboxMarkAdmitted;
  },
  get outboxCapturedHeadFor() {
    return H.outboxCapturedHeadFor;
  },
  get outboxDropGesture() {
    return H.outboxDropGesture;
  },
  get outboxReconcile() {
    return H.outboxReconcile;
  },
  get outboxReplacementFor() {
    return H.outboxReplacementFor;
  },
  set outboxReplacementFor(v: string | undefined) {
    H.outboxReplacementFor = v;
  },
};

/** Full reset for afterEach: harness handles + the real sync store slices the
 *  send cluster reads (messages / messagesDelivered / activity / permissions /
 *  questions), the selection + draft signals, localStorage (draft + prompt
 *  history), and the single-flight in-flight map. Keeps each test isolated. */
export function resetAll() {
  resetHarness();
  setState(
    produce((s: any) => {
      s.messages = {};
      s.messagesDelivered = {};
      s.messagesError = {};
      s.activity = {};
      s.permissions = {};
      s.questions = {};
      s.messageWindows = {};
    }),
  );
  // Reset selection/draft via the raw store setters (avoid newSession's UI side
  // effects like syncUrl/setView).
  setSelectedIdRaw(null);
  setDraft(false);
  // Clear localStorage keys the send/draft path writes.
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  __resetSendSingleFlightForTests();
}

/** Render helper: a LIVE (non-draft) ChatView for `sessionId`. */
export function liveView(sessionId: string) {
  return <ChatViewComp sessionId={sessionId} />;
}

/** Render helper: a DRAFT ChatView wrapped in <Show when={!selectedId()}> so a
 *  createSession -> setSelectedId flip UNMOUNTS the draft ChatView exactly as
 *  App.tsx does (the timing that disposes the draft-save effect). Pass the
 *  reactive selectedId accessor from the real sync store. */
export function draftView(selectedId: Accessor<string | null>) {
  return (
    <Show when={!selectedId()}>
      <ChatViewComp sessionId="" draft />
    </Show>
  );
}

// --- store seed helpers ----------------------------------------------------

/** Seed a USER message into the real sync store so the Retry button renders
 *  (m.info.role === "user"). Sets messagesDelivered so the transcript reveals. */
export function seedUserMessage(sessionId: string, messageId: string, text: string) {
  const partId = "p-1";
  setState("messages", sessionId, {
    order: [messageId],
    byId: {
      [messageId]: {
        id: messageId,
        info: { id: messageId, sessionID: sessionId, role: "user", time: { created: 1 } },
        partOrder: [partId],
        parts: { [partId]: { id: partId, sessionID: sessionId, messageID: messageId, type: "text", text } },
      },
    },
  });
  setState("messagesDelivered", sessionId, true);
}

/** Exported for tests that need to reset the live sync signals (selectedId /
 *  draft) back to the draft-hero state, mirroring newSession(). */
export { state, setState };

/** Seed a pending (or overridden-state — slice 3 retry tests seed terminal
 * `failed`/`unknown` items directly) queue item into H.queueStore (the
 * in-memory backend the mocked claim/resolve read+mutate). Returns the item.
 * The drainer will pick up a `pending` item on the next idle drain-trigger
 * effect (area 5); terminal states are never claimed. */
export function seedPendingItem(
  sessionId: string,
  opts: { id?: string; text?: string; sendConfig?: any; opencodeMsgID?: string; attachments?: any[]; state?: "pending" | "dispatching" | "failed" | "unknown"; detail?: string } = {},
) {
  const item = {
    id: opts.id ?? "q-seed-1",
    order: (H.queueStore.items[sessionId]?.length ?? 0) + 1,
    state: opts.state ?? ("pending" as const),
    text: opts.text ?? "seeded prompt",
    attachments: opts.attachments ?? [],
    sendConfig: opts.sendConfig,
    opencodeMsgID: opts.opencodeMsgID,
    detail: opts.detail,
    createdAt: 1,
  };
  (H.queueStore.items[sessionId] ||= []).push(item);
  return item;
}

/** Drive the composer textarea: set its value and fire input (mirrors a user
 *  typing — onInput calls setInput + resets prompt-history walk). */
export function typeInto(container: HTMLElement, value: string) {
  const ta = container.querySelector("textarea.composer-text") as HTMLTextAreaElement;
  if (!ta) throw new Error("composer textarea not found");
  ta.value = value;
  fireEvent.input(ta, { target: { value } });
  return ta;
}

/** Read the composer textarea's current value (the observable of the input()
 *  signal — SolidJS controls value={input()}). */
export function composerValue(container: HTMLElement): string {
  const ta = container.querySelector("textarea.composer-text") as HTMLTextAreaElement | null;
  return ta ? ta.value : "";
}

/** Click the Send button (aria-label "Send" when idle). Waits for it to be
 *  enabled (readyToSend true) first. */
export async function clickSend(container: HTMLElement) {
  const btn = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
  if (!btn) throw new Error('Send button (aria-label="Send") not found');
  await waitFor(() => expect(btn.disabled).toBe(false));
  fireEvent.click(btn);
  return btn;
}

/** Click the Retry action on a user message (aria-label "Retry"). */
export function clickRetry(container: HTMLElement) {
  const btn = container.querySelector('button[aria-label="Retry"]') as HTMLButtonElement;
  if (!btn) throw new Error('Retry button (aria-label="Retry") not found');
  fireEvent.click(btn);
  return btn;
}
