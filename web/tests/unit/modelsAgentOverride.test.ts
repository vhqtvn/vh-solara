// @vitest-environment jsdom
//
// Focused contract test for model/agent precedence in the composer:
//   explicit user model pick  >  agent-declared model  >  global default.
//
// Bug: an explicit composer model pick (e.g. GLM) was silently overridden by
// the selected agent's declared model (e.g. GPT), because selectAgentForSession
// unconditionally applied the agent's model via applyModel — which wrote the
// session selection with no notion of "the user already picked for this
// session". The fix: model/agent state carries an in-memory per-session
// "explicit pick" intent; the agent-declared model is applied as a DEFAULT only
// when the session has no explicit pick.
//
// These tests exercise the REAL models.ts + agents.ts modules (not mocks). Model
// and agent state are module-level singletons, so each test calls
// vi.resetModules() + a dynamic import to start from a clean slate.

// jsdom lacks window.matchMedia; importing models/agents pulls in the sync
// facade whose transitive deps may read it at module load. Install the stub
// BEFORE any import — vi.hoisted runs before ESM imports.
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

// --- Fixtures ----------------------------------------------------------------

// An agent that declares a GPT model + a "high" variant.
const GPT_AGENT = {
  name: "gpt-build",
  description: "gpt agent",
  mode: "primary",
  model: { providerID: "openai", modelID: "gpt-4" },
  variant: "high",
} as const;
const GPT_PROVIDER = GPT_AGENT.model.providerID;
const GPT_MODEL = GPT_AGENT.model.modelID;

// A second agent declaring a different model — used to assert that switching
// agents does NOT silently flip an already-established session model.
const CLAUDE_AGENT = {
  name: "claude-build",
  description: "claude agent",
  mode: "primary",
  model: { providerID: "anthropic", modelID: "claude-sonnet" },
  variant: "standard",
} as const;
const CLAUDE_PROVIDER = CLAUDE_AGENT.model.providerID;
const CLAUDE_MODEL = CLAUDE_AGENT.model.modelID;

// Structural shape for the fetch stub's /oc/agent payload. Both fixture agents
// are `as const`; this widens the literals so a list of mixed agents is
// assignable to the stub's parameter.
type FixtureAgent = {
  name: string;
  description: string;
  mode: string;
  model: { providerID: string; modelID: string };
  variant?: string;
};

// A user's explicit composer pick: a GLM model + a "fast" variant.
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
  // so no default/agent leaks between tests.
  localStorage.clear();
  installFetchStub();
});

afterEach(() => {
  (globalThis as any).fetch = undefined;
  vi.restoreAllMocks();
});

describe("model/agent precedence — explicit user pick beats agent-declared model", () => {
  it("(a) explicit GLM pick survives selecting a GPT-declaring agent", async () => {
    vi.resetModules();
    const { chooseModel, chooseVariant, selectionFor } = await import("../../src/models");
    const { loadAgents, selectAgentForSession, agentForSession } = await import("../../src/agents");
    await loadAgents();

    const sid = "sess-a";
    // Explicit USER gesture: pick GLM + a variant for this session.
    chooseModel(sid, GLM_PROVIDER, GLM_MODEL);
    chooseVariant(sid, GLM_VARIANT);

    // Now select a GPT-declaring agent for the SAME session. Before the fix the
    // agent's model overwrote the explicit GLM pick.
    selectAgentForSession(sid, GPT_AGENT.name);

    // The explicit GLM pick must win (provider + model + variant).
    const sel = selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);

    // Agent selection itself is unaffected: the GPT agent is still the selected
    // agent for this session (model precedence must not depend on agent and vice
    // versa).
    expect(agentForSession(sid)).toBe(GPT_AGENT.name);
  });

  it("(b) no explicit pick — selecting an agent inherits its declared model", async () => {
    vi.resetModules();
    const { selectionFor } = await import("../../src/models");
    const { loadAgents, selectAgentForSession } = await import("../../src/agents");
    await loadAgents();

    const sid = "sess-b";
    // Do NOT call chooseModel/chooseVariant — there is no explicit user pick.
    selectAgentForSession(sid, GPT_AGENT.name);

    // The agent-declared model applies as the DEFAULT for the session.
    const sel = selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GPT_PROVIDER);
    expect(sel!.modelID).toBe(GPT_MODEL);
    expect(sel!.variant).toBe(GPT_AGENT.variant);
  });

  it("(d) reload-sim: a sent session's model survives a post-reload agent switch", async () => {
    // Regression for the reload hole: explicitModelPicks is in-memory only and
    // is wiped on reload. After a send, OpenCode stamps session.model
    // server-side; a reload clears the in-memory explicit-pick intent, so
    // without honoring the server-persisted model a subsequent agent switch
    // would let the new agent's declared model clobber it (the original bug
    // re-emerging). Models the reload as vi.resetModules() (wipes sessionSel +
    // explicitModelPicks + the sync store singleton) and re-seeds the server
    // snapshot (state.sessions[id].model) that arrives on load.
    //
    // PROVENANCE SCOPE: this seeds an INLINE model on the session record, so
    // the guard resolves it via inlineSessionModel(sessionID) directly — the
    // INLINE-session-model path (the per-session server value), NOT the
    // production hoist path. Projected snapshots under hoist=1 strip this field
    // and resolve through projectConstants.model; that distinct case is covered
    // by (f).
    vi.resetModules();
    const before = await import("../../src/models");
    const sid = "sess-d";
    // 1) Pre-reload: the user explicitly picked GLM (intent is in-memory only).
    before.chooseModel(sid, GLM_PROVIDER, GLM_MODEL);

    // 2) Reload: wipe ALL module state, then re-seed the server snapshot.
    vi.resetModules();
    installFetchStub();
    const after = {
      store: await import("../../src/sync/store"),
      models: await import("../../src/models"),
      agents: await import("../../src/agents"),
    };
    after.store.setState("sessions", sid, {
      id: sid,
      model: { providerID: GLM_PROVIDER, modelID: GLM_MODEL, variant: GLM_VARIANT },
    });
    await after.agents.loadAgents();

    // 3) After reload, switch to the GPT-declaring agent.
    after.agents.selectAgentForSession(sid, GPT_AGENT.name);

    // 4) The server-persisted GLM model must survive.
    //    PRE-FIX: applyAgentModel's guard only checked explicitModelPicks (empty
    //    after reload), so GPT clobbered GLM -> sel.modelID === "gpt-4" (RED).
    //    POST-FIX: the guard also honors sessionModel(sid) -> GLM sticks (GREEN).
    const sel = after.models.selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);
    // Agent selection itself is unaffected.
    expect(after.agents.agentForSession(sid)).toBe(GPT_AGENT.name);
  });

  it("(e) established session model sticks across an agent switch even with NO explicit pick", async () => {
    // Intentional semantic broadening: once a session has an established server
    // model (here, a prior agent-inherited send stamped GPT), switching agents
    // must NOT silently flip it — even though the user never made an explicit
    // composer pick. Switching agents is about persona/instructions, not the
    // model; a user who wants the new agent's model can explicitly pick it.
    // PRE-FIX this was RED (Claude replaced GPT); POST-FIX the guard honors
    // sessionModel(sid) -> GPT sticks (GREEN).
    //
    // PROVENANCE SCOPE: like (d), this seeds an INLINE model on the session
    // record (state.sessions[id].model), so the guard resolves via
    // inlineSessionModel(sessionID) directly — the INLINE-session-model path
    // (the per-session server value), NOT the production hoist path. Projected
    // snapshots under hoist=1 strip this field and resolve through
    // projectConstants.model; that distinct case is covered by (f).
    vi.resetModules();
    installFetchStub([GPT_AGENT, CLAUDE_AGENT]);
    const store = await import("../../src/sync/store");
    const { selectionFor } = await import("../../src/models");
    const { loadAgents, selectAgentForSession, agentForSession } = await import("../../src/agents");
    await loadAgents();

    const sid = "sess-e";
    // A prior agent-inherited send established GPT server-side. No chooseModel.
    store.setState("sessions", sid, {
      id: sid,
      model: { providerID: GPT_PROVIDER, modelID: GPT_MODEL },
    });

    // Switch to a Claude-declaring agent.
    selectAgentForSession(sid, CLAUDE_AGENT.name);

    // GPT sticks; Claude does NOT replace it.
    const sel = selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GPT_PROVIDER);
    expect(sel!.modelID).toBe(GPT_MODEL);
    // Agent selection itself is unaffected.
    expect(agentForSession(sid)).toBe(CLAUDE_AGENT.name);
  });

  it("(f) hoisted projectConstants.model ALONE does not make a session sticky across an agent switch", async () => {
    // Production tree stream always sends hoist=1: many projected rows have their
    // inline model STRIPPED and resolve ONLY through projectConstants.model. That
    // hoisted value is a snapshot-compression/display fallback (the backend hoists
    // the common value from active captured sessions, pkg/state/projection.go),
    // NOT per-session user intent. Option C's original guard keyed on
    // sessionModel() (which falls back to the hoisted value), so such a session
    // wrongly read as "established" and the agent-declared model never applied —
    // it stayed sticky on the hoisted common value across an agent switch. The
    // refine narrows the WRITE guard to the INLINE session model
    // (inlineSessionModel, no projectConstants fallback); selectionFor() still
    // resolves DISPLAY through sessionModel() (hoist-aware), so a session that
    // merely inherited the project-common model still follows an agent switch.
    vi.resetModules();
    installFetchStub([GPT_AGENT]);
    const store = await import("../../src/sync/store");
    const { selectionFor } = await import("../../src/models");
    const { loadAgents, selectAgentForSession, agentForSession } = await import("../../src/agents");
    await loadAgents();

    const sid = "sess-f";
    // NO inline model on the session record — only the project-common hoisted
    // value, which is a display fallback, not per-session intent.
    store.setState("sessions", sid, { id: sid });
    const HOISTED_PROVIDER = "anthropic";
    const HOISTED_MODEL = "claude-sonnet";
    store.setState("projectConstants", { model: { providerID: HOISTED_PROVIDER, id: HOISTED_MODEL } });

    // Select a GPT-declaring agent for the SAME session.
    selectAgentForSession(sid, GPT_AGENT.name);

    // The agent's declared model applies: the hoisted common value must NOT make
    // the session sticky.
    // PRE-REFINE (RED): sessionModel(sid) fell back to projectConstants.model →
    // the guard fired → GPT never applied → sel.modelID === HOISTED_MODEL.
    // POST-REFINE (GREEN): inlineSessionModel(sid) is undefined (no inline
    // model) → the guard does not fire → GPT applies.
    const sel = selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GPT_PROVIDER);
    expect(sel!.modelID).toBe(GPT_MODEL);
    expect(sel!.variant).toBe(GPT_AGENT.variant);
    // Agent selection itself is unaffected.
    expect(agentForSession(sid)).toBe(GPT_AGENT.name);
  });

  it("(g) a last user-message model (no inline session model) is protected across an agent switch", async () => {
    // COVERAGE (GREEN both before and after the refine — NOT a red signal): the
    // guard already honored lastUserMessageModel(sessionID) via its ?? chain, so
    // a session with NO inline model AND NO projectConstants model, but whose
    // most recent user message carries a model, must be protected across an
    // agent switch. The message-provenance signal is per-session user intent
    // (the user sent with that model), distinct from the hoisted display default
    // covered by (f). This test pins that the refine's switch from sessionModel
    // to inlineSessionModel did NOT weaken the message-provenance branch.
    vi.resetModules();
    installFetchStub([GPT_AGENT, CLAUDE_AGENT]);
    const store = await import("../../src/sync/store");
    const { selectionFor } = await import("../../src/models");
    const { loadAgents, selectAgentForSession, agentForSession } = await import("../../src/agents");
    await loadAgents();

    const sid = "sess-g";
    // NO inline model on the session record, NO projectConstants model.
    store.setState("sessions", sid, { id: sid });
    store.setState("projectConstants", undefined);
    // A user message carrying a model — the message-provenance signal read by
    // lastUserMessageModel (selectors.ts: info.role === "user" + info.model).
    const MSG_PROVIDER = "google";
    const MSG_MODEL = "gemini-pro";
    store.setState("messages", sid, {
      order: ["m1"],
      byId: {
        m1: {
          id: "m1",
          info: { id: "m1", sessionID: sid, role: "user", model: { providerID: MSG_PROVIDER, modelID: MSG_MODEL } },
          partOrder: [],
          parts: {},
        },
      },
    });

    // Switch to a Claude-declaring agent.
    selectAgentForSession(sid, CLAUDE_AGENT.name);

    // The user-message model sticks; Claude does NOT replace it.
    const sel = selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(MSG_PROVIDER);
    expect(sel!.modelID).toBe(MSG_MODEL);
    // Agent selection itself is unaffected.
    expect(agentForSession(sid)).toBe(CLAUDE_AGENT.name);
  });
});
