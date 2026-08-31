// Resolver-ORDERING pins (DEFER-disposition Bundle 1 — brief at
// tmp/agent-runs/defer-disposition-brief/brief.md): the two ordering
// contracts from ad6c138 ("validate provably-empty agent default and settle
// pre-aborted send gate immediately") that agentSilentFlip.test.ts does not
// discriminate:
//
// F1 — unloaded-list pending parity: before loadAgents(), with NO stored
//      default, the draft branch and the provably-empty branch share
//      resolveDraftDefault() and must BOTH resolve {state:"pending"}. ad6c138
//      changed exactly this sub-case for the empty branch (previously
//      {state:"agent", agent:""} — handed to the gate as unavailable); the
//      pin holds draft ≡ provably-empty so neither branch can drift back.
//
// F2 — pre-abort outranks instant resolution: awaitSendAgent's upfront
//      already-aborted check precedes the first-resolution fast path, so an
//      abandoned queue slot can never succeed merely because agent
//      resolution is immediate. The existing pre-abort test
//      (agentSilentFlip.test.ts:167) pits the signal only against a PENDING
//      session — where the fast path is not taken — so it cannot catch a
//      reorder of the two checks; these tests use INSTANTLY resolvable
//      targets (draft / explicit persisted pick / live lastAgents evidence).
//
// Pure resolver/gate tests: node env (no jsdom docblock needed). Fresh
// module state per test (vi.resetModules + dynamic import) — each test gets
// a pristine agents/store registry, so "not loaded / no default" is the REAL
// initial module state, not a reconstructed one. The api mock and the
// localStorage shim mirror agentSilentFlip.test.ts (same production posture:
// /agent → [supervisor, coordination], /config → default_agent
// "coordination").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendAgentOutcome } from "../../src/agents";

type AgentsModule = typeof import("../../src/agents");
type StoreModule = typeof import("../../src/sync/store");

// In-memory localStorage (node env): module-init reads (vh.agent.v1 for the
// global default, the per-dir pick maps) see exactly what each test seeds,
// and the beforeEach wipe keeps tests order-independent.
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

vi.mock("../../src/api", () => ({
  oc: {
    get: vi.fn((url: string) =>
      url === "/agent"
        ? Promise.resolve([{ name: "supervisor" }, { name: "coordination" }])
        : Promise.resolve({ default_agent: "coordination" }),
    ),
  },
}));

// Fresh agents.ts + sync/store instances (one registry after resetModules,
// so the resolver and the test's setState share the SAME store).
async function fresh(): Promise<{ agents: AgentsModule; store: StoreModule }> {
  const agents = await import("../../src/agents");
  const store = await import("../../src/sync/store");
  return { agents, store };
}

beforeEach(() => {
  vi.useRealTimers();
  for (const k of Object.keys(mem)) delete mem[k];
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// F1 — unloaded list + no stored default: draft ≡ provably-empty (pending)
// ---------------------------------------------------------------------------

// The F1 posture, asserted not assumed: the fresh module really is unloaded
// (empty agent list, no persisted global default).
async function freshUnloaded(): Promise<{ agents: AgentsModule; store: StoreModule }> {
  const ctx = await fresh();
  expect(ctx.agents.agents()).toEqual([]); // list NOT loaded
  expect(ctx.agents.selectedAgent()).toBe(""); // NO stored default
  return ctx;
}

describe("F1: list unloaded + no stored default — draft ≡ provably-empty", () => {
  it("draft ('') resolves pending — never an unvalidated '' agent", async () => {
    const { agents } = await freshUnloaded();
    expect(agents.resolveAgentForSession("")).toEqual({ state: "pending" });
  });

  it("provably-empty live session (messagesDelivered, zero messages) resolves the SAME pending", async () => {
    const { agents, store } = await freshUnloaded();
    store.setState("messagesDelivered", "ses_f1", true);
    store.setState("messages", "ses_f1", { order: [], byId: {} });
    expect(agents.isProvablyEmptySession("ses_f1")).toBe(true); // posture: provably empty

    // ad6c138's changed sub-case: pending (draft-identical), NOT the old
    // {state:"agent", agent:""} that the gate downgraded to unavailable.
    expect(agents.resolveAgentForSession("ses_f1")).toEqual({ state: "pending" });
  });

  it("parity: draft and provably-empty resolve identically (the shared resolveDraftDefault policy)", async () => {
    const { agents, store } = await freshUnloaded();
    store.setState("messagesDelivered", "ses_f1_par", true);
    store.setState("messages", "ses_f1_par", { order: [], byId: {} });

    const draft = agents.resolveAgentForSession("");
    const empty = agents.resolveAgentForSession("ses_f1_par");
    expect(empty).toEqual(draft); // the parity pin — the two branches cannot drift apart
    expect(draft).toEqual({ state: "pending" });
  });
});

// ---------------------------------------------------------------------------
// F2 — an already-aborted signal outranks INSTANT resolution
// ---------------------------------------------------------------------------

// The F2 posture: booted exactly like production (list loaded, config
// default applied), so every target below resolves with NO wait.
async function freshLoaded(): Promise<{ agents: AgentsModule; store: StoreModule }> {
  const ctx = await fresh();
  await ctx.agents.loadAgents();
  expect(ctx.agents.selectedAgent()).toBe("coordination"); // the config default, as in production
  return ctx;
}

// Enter the gate with an ALREADY-aborted signal against a target that
// resolves INSTANTLY, and assert the abort outcome wins: {ok:false,
// reason:"timeout"} with ZERO clock advance — never the available agent.
// If the fast-resolution path preceded the abort check (the reorder this pin
// guards against), `out` would be the agent-ok outcome here.
async function gatePreAborted(agents: AgentsModule, sessionID: string): Promise<void> {
  vi.useFakeTimers();
  try {
    const ctrl = new AbortController();
    ctrl.abort(); // aborted BEFORE the gate is entered
    let out: SendAgentOutcome | undefined;
    agents.awaitSendAgent(sessionID, { timeoutMs: 30_000, signal: ctrl.signal }).then((o) => {
      out = o;
    });
    // ZERO clock advance — only the microtask queue flushes (mirrors the
    // pre-abort test in agentSilentFlip.test.ts).
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toEqual({ ok: false, reason: "timeout" }); // caller-aborted = timeout semantics
    expect(out?.ok).not.toBe(true); // never the immediately-available agent
    expect(vi.getTimerCount()).toBe(0); // no timeout timer was ever armed
  } finally {
    vi.useRealTimers();
  }
}

describe("F2: pre-aborted signal outranks instant resolution", () => {
  it("draft (instant config default) → timeout, NOT the available default", async () => {
    const { agents } = await freshLoaded();
    // Instant resolution IS available — without the signal this resolves now:
    expect(agents.resolveAgentForSession("")).toEqual({ state: "agent", agent: "coordination" });
    await gatePreAborted(agents, "");
  });

  it("explicit persisted pick → timeout, NOT the picked agent", async () => {
    const { agents } = await freshLoaded();
    agents.selectAgentForSession("ses_pick", "supervisor");
    expect(agents.resolveAgentForSession("ses_pick")).toEqual({ state: "agent", agent: "supervisor" });
    await gatePreAborted(agents, "ses_pick");
  });

  it("live lastAgents evidence → timeout, NOT the evidence agent", async () => {
    const { agents, store } = await freshLoaded();
    store.setState("lastAgents", "ses_facet", "supervisor");
    expect(agents.resolveAgentForSession("ses_facet")).toEqual({ state: "agent", agent: "supervisor" });
    await gatePreAborted(agents, "ses_facet");
  });
});
