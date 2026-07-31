// @vitest-environment jsdom
//
// Focused contract test for DRAFT (pre-first-send) composer model-pick
// persistence: an explicit composer model pick made before the first send
// (sessionID === "") must survive a page/app reload AND still win over the
// selected agent's declared model, so the first send dispatches the operator's
// chosen model.
//
// The bug: the pick persisted as the global default (vh.model.default.v1), but
// its EXPLICIT-DRAFT provenance (explicitModelPicks for sessionID "") was
// in-memory only and wiped on reload. On reload the draft init effect re-ran
// agent-model application; with the explicit marker gone, applyAgentModel("",
// agentModel) overwrote the global default, so the first send dispatched the
// agent's model instead of the operator's pick. The fix persists the draft
// Selection AND its explicit provenance together (vh.model.draft.v1), hydrates
// them at module load BEFORE agent-model application, and clears the record when
// the draft is consumed by a first send (migrateModelPick).
//
// These tests exercise the REAL models.ts + agents.ts modules (not mocks). Model
// and agent state are module-level singletons, so each test calls
// vi.resetModules() + a dynamic import to start from a clean slate.

// jsdom lacks window.matchMedia; importing models/agents pulls in the sync
// facade whose transitive deps may read it at module load. Import the shared
// stub BEFORE any import — see _matchMedia.ts.
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Fixtures ----------------------------------------------------------------

// An agent that declares a GPT model + a "high" variant — the agent default
// that must NOT overwrite the operator's restored explicit draft pick.
const GPT_AGENT = {
  name: "gpt-build",
  description: "gpt agent",
  mode: "primary",
  model: { providerID: "openai", modelID: "gpt-4" },
  variant: "high",
} as const;
const GPT_PROVIDER = GPT_AGENT.model.providerID;
const GPT_MODEL = GPT_AGENT.model.modelID;

// Structural shape for the fetch stub's /oc/agent payload (widens the `as const`
// literals so a list of mixed agents is assignable to the stub's parameter).
type FixtureAgent = {
  name: string;
  description: string;
  mode: string;
  model: { providerID: string; modelID: string };
  variant?: string;
};

// The operator's explicit composer pick: a GLM model + a "fast" variant.
const GLM_PROVIDER = "zai";
const GLM_MODEL = "glm-5";
const GLM_VARIANT = "fast";

// Fetch stub for loadAgents(): /oc/agent returns the agent list, everything
// else returns an empty object (loadAgents also hits /oc/config for
// default_agent, which we want absent so the fixture agent is the resolved
// default). Installed per-test before the dynamic import + loadAgents().
function installFetchStub(agentList: readonly FixtureAgent[] = [GPT_AGENT]): void {
  (globalThis as any).fetch = vi.fn(async (url: string, _init?: unknown) => {
    if (String(url).includes("/oc/agent")) {
      return { ok: true, status: 200, json: async () => agentList } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
}

beforeEach(() => {
  // models.ts / agents.ts hydrate from localStorage at module load; start clean
  // so no default/agent/draft leaks between tests.
  localStorage.clear();
  installFetchStub();
});

afterEach(() => {
  (globalThis as any).fetch = undefined;
  vi.restoreAllMocks();
});

describe("draft composer model pick — survives reload, beats agent default, clears on send", () => {
  it("(1) module reload preserves the explicit draft selection", async () => {
    vi.resetModules();
    const before = await import("../../src/models");
    // The exported key follows the vh.model.<name>.v1 convention.
    expect(before.LS_DRAFT).toBe("vh.model.draft.v1");
    const KEY = before.LS_DRAFT;

    // Explicit draft pick before reload.
    before.chooseModel("", GLM_PROVIDER, GLM_MODEL);
    before.chooseVariant("", GLM_VARIANT);
    // The draft record (Selection + provenance) was persisted atomically.
    expect(localStorage.getItem(KEY)).not.toBeNull();

    // Reload: wipe ALL module state (in-memory sessionSel + explicitModelPicks
    // are gone). Hydration must restore the draft pick from LS_DRAFT.
    vi.resetModules();
    const after = await import("../../src/models");

    const sel = after.selectionFor("");
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);
  });

  it("(2) agent initialization cannot overwrite the restored explicit pick (crux)", async () => {
    // THE CRUX: an explicit draft pick must survive reload AND still win over the
    // selected agent's declared model. Pre-fix the explicit marker was in-memory
    // only; on reload applyAgentModel("", GPT) overwrote the global default, so
    // the first send would have dispatched GPT instead of the operator's GLM.
    vi.resetModules();
    const before = await import("../../src/models");
    before.chooseModel("", GLM_PROVIDER, GLM_MODEL);
    before.chooseVariant("", GLM_VARIANT);

    // Reload: wipe in-memory state. (A draft has no server session, so unlike
    // the sent-session recovery tests we seed nothing in the sync store — the
    // pick must come back purely from LS_DRAFT.)
    vi.resetModules();
    installFetchStub();
    const after = {
      models: await import("../../src/models"),
      agents: await import("../../src/agents"),
    };
    // loadAgents resolves the default agent (GPT-declaring); it does NOT itself
    // apply the agent model (it only calls setSelectedAgent).
    await after.agents.loadAgents();

    // Simulate the ChatView draft init effect (ChatView.tsx ~:178), which re-
    // applies the selected agent's model to the draft on load.
    after.agents.selectAgentForSession("", GPT_AGENT.name);

    // The restored explicit GLM pick must win (provider + model + variant).
    const sel = after.models.selectionFor("");
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);
  });

  it("(3) first send migrates the pick and clears the draft storage", async () => {
    vi.resetModules();
    const M = await import("../../src/models");
    const KEY = M.LS_DRAFT;

    M.chooseModel("", GLM_PROVIDER, GLM_MODEL);
    M.chooseVariant("", GLM_VARIANT);
    expect(localStorage.getItem(KEY)).not.toBeNull();

    // The draft is materialized into a real session on first send.
    const liveID = "sess-live-3";
    M.migrateModelPick("", liveID);

    // The draft storage is cleared — a consumed draft must NOT carry over into
    // the next draft (abandoned-draft-carry-over is the named risk).
    expect(localStorage.getItem(KEY)).toBeNull();

    // The pick (Selection + explicit provenance) migrated to the live session
    // in-memory.
    const sel = M.selectionFor(liveID);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);
  });

  it("(4) sent-session recovery still uses server/message state (Option C unchanged)", async () => {
    // Regression guard: real-session model resolution stays server/message-
    // authoritative. A real session's model resolves from the server-persisted
    // session.model (inline) / last user-message stamp, NEVER from the draft
    // storage. (Mirrors the Option-C coverage in modelsAgentOverride.test.ts (d).)
    vi.resetModules();
    installFetchStub();
    const store = await import("../../src/sync/store");
    const M = await import("../../src/models");
    const A = await import("../../src/agents");
    const KEY = M.LS_DRAFT;

    const sid = "sess-4";
    // A REAL session with a server-persisted (inline) model.
    store.setState("sessions", sid, {
      id: sid,
      model: { providerID: GLM_PROVIDER, modelID: GLM_MODEL, variant: GLM_VARIANT },
    });
    await A.loadAgents();
    // Switching to a GPT-declaring agent must NOT clobber the server model.
    A.selectAgentForSession(sid, GPT_AGENT.name);

    const sel = M.selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);
    // No draft record was written for a real-session flow.
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("(5) real session IDs are never written to the draft key", async () => {
    vi.resetModules();
    const M = await import("../../src/models");
    const KEY = M.LS_DRAFT;

    // A pick for a REAL session must NOT touch the draft key.
    const realID = "sess-real-5";
    M.chooseModel(realID, GLM_PROVIDER, GLM_MODEL);
    M.chooseVariant(realID, GLM_VARIANT);
    expect(localStorage.getItem(KEY)).toBeNull();

    // A draft pick writes the record. Assert its shape: a bare Selection with
    // NO session id of any spelling.
    M.chooseModel("", GPT_PROVIDER, GPT_MODEL);
    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    const env = JSON.parse(raw!);
    expect(env.v).toBe(1);
    expect(env.data).toBeDefined();
    expect(env.data.providerID).toBe(GPT_PROVIDER);
    expect(env.data.modelID).toBe(GPT_MODEL);
    expect(env.data).not.toHaveProperty("sessionID");
    expect(env.data).not.toHaveProperty("sessionId");
    expect(env.data).not.toHaveProperty("id");
    expect(env.data).not.toHaveProperty("sid");

    // Migrate (draft→live) clears the draft key entirely — the live id never
    // leaks into it, even across the transfer.
    M.migrateModelPick("", "sess-live-5");
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
