// @vitest-environment jsdom
//
// Focused contract test for P1 — EXPLICIT per-session model/variant pick
// persistence (real sessions): an explicit composer model-picker choice for a
// REAL session must survive a page/app reload and still top the resolution
// chain (server session.model, last-message evidence, global default) and
// still suppress agent-declared model overrides.
//
// The bug (the verified silent-flip): sessionSel + explicitModelPicks were
// in-memory only for real sessions. On reload they were gone, so a reloaded
// session dispatched the stale server session.model (or the global fallback)
// instead of the user's unconsumed explicit choice. The fix mirrors the landed
// sessionAgentPicks store: a per-project pick map (vh.sessionmodels.v1:<dir>)
// with unconditional sanitize, a 200-cap by write time, whole-map write-through
// (LWW cross-tab), Solid-setter-only mutations, re-seed on project switch, and
// a prune on session removal (the ONLY clear path — picks are never consumed
// on send).
//
// These tests exercise the REAL modules (sync/store.ts + models.ts + agents.ts
// where needed — not mocks). Store/model state are module-level singletons, so
// each test calls vi.resetModules() + a dynamic import to start clean; a
// reload is modeled as resetModules() with localStorage surviving.

// jsdom lacks window.matchMedia; importing models/agents pulls in the sync
// facade whose transitive deps may read it at module load. Import the shared
// stub BEFORE any import — see _matchMedia.ts.
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Fixtures ----------------------------------------------------------------

// The operator's explicit pick: a GLM model + a "fast" variant.
const GLM_PROVIDER = "zai";
const GLM_MODEL = "glm-5";
const GLM_VARIANT = "fast";

// A GPT-declaring agent — the agent default that must NOT overwrite the
// restored explicit pick.
const GPT_AGENT = {
  name: "gpt-build",
  description: "gpt agent",
  mode: "primary",
  model: { providerID: "openai", modelID: "gpt-4" },
  variant: "high",
} as const;

type FixtureAgent = {
  name: string;
  description: string;
  mode: string;
  model: { providerID: string; modelID: string };
  variant?: string;
};

function installFetchStub(agentList: readonly FixtureAgent[] = [GPT_AGENT]): void {
  (globalThis as any).fetch = vi.fn(async (url: string, _init?: unknown) => {
    if (String(url).includes("/oc/agent")) {
      return { ok: true, status: 200, json: async () => agentList } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
}

// Default project dir in jsdom (no ?dir=, no LS_PROJECT) → the ":"-suffixed key.
const KEY = "vh.sessionmodels.v1:";

const readPersisted = (): Record<string, any> =>
  JSON.parse(localStorage.getItem(KEY) ?? "null")?.data ?? {};

beforeEach(() => {
  localStorage.clear();
  installFetchStub();
});

afterEach(() => {
  (globalThis as any).fetch = undefined;
  vi.restoreAllMocks();
});

describe("session model picks — survive reload, stay sticky, prune on removal", () => {
  it("(1) an explicit real-session pick survives a reload (incl. variant)", async () => {
    vi.resetModules();
    const before = await import("../../src/models");
    const sid = "sess-1";
    before.chooseModel(sid, GLM_PROVIDER, GLM_MODEL);
    before.chooseVariant(sid, GLM_VARIANT);
    // The pick was persisted for the real session id.
    expect(readPersisted()[sid]).toMatchObject({ providerID: GLM_PROVIDER, modelID: GLM_MODEL, variant: GLM_VARIANT });

    // Reload: wipe ALL module state (sessionSel + explicitModelPicks + the
    // stores). The pick must come back from the persisted map.
    vi.resetModules();
    const after = await import("../../src/models");
    const sel = after.selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);
  });

  it("(2) stale server evidence never replaces unconsumed explicit intent", async () => {
    // The pick is NOT consumed on send and NOT displaced by server evidence:
    // after a reload, a server-persisted session.model (stale — from an older
    // turn) and last-message stamps must lose to the restored pick.
    vi.resetModules();
    const before = await import("../../src/models");
    const sid = "sess-2";
    before.chooseModel(sid, GLM_PROVIDER, GLM_MODEL);
    before.chooseVariant(sid, GLM_VARIANT);

    vi.resetModules();
    installFetchStub();
    const store = await import("../../src/sync/store");
    const after = await import("../../src/models");
    // Server says GPT (a stale stamp from an older turn)…
    store.setState("sessions", sid, {
      id: sid,
      model: { providerID: "openai", modelID: "gpt-4" },
    });

    // …but the unconsumed explicit pick wins.
    const sel = after.selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);
  });

  it("(3) restored provenance blocks an agent model override post-reload (crux)", async () => {
    // THE CRUX of P1: pre-fix, reload wiped explicitModelPicks and the agent's
    // declared model was applied on the next agent-select (the silent flip).
    // Post-fix the restored pick's provenance suppresses it identically to an
    // in-session explicit pick.
    vi.resetModules();
    const before = await import("../../src/models");
    const sid = "sess-3";
    before.chooseModel(sid, GLM_PROVIDER, GLM_MODEL);
    before.chooseVariant(sid, GLM_VARIANT);

    vi.resetModules();
    installFetchStub();
    const after = {
      models: await import("../../src/models"),
      agents: await import("../../src/agents"),
    };
    await after.agents.loadAgents();
    // Selecting a GPT-declaring agent re-runs applyAgentModel — it must
    // early-return because the restored pick is explicit.
    after.agents.selectAgentForSession(sid, GPT_AGENT.name);

    const sel = after.models.selectionFor(sid);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);
    // Agent selection itself is unaffected.
    expect(after.agents.agentForSession(sid)).toBe(GPT_AGENT.name);
  });

  it("(4) a failed/aborted send never consumes the pick (nothing clears it on send)", async () => {
    // Stickiness: there is NO clear on send anywhere in the send path — the
    // only clear is session removal (test 7). Model it: pick → reload → pick
    // still resolves (as an unsent-but-persisted pick would after a failed or
    // aborted send + reload).
    vi.resetModules();
    const before = await import("../../src/models");
    const sid = "sess-4";
    before.chooseModel(sid, GLM_PROVIDER, GLM_MODEL);

    vi.resetModules();
    const after = await import("../../src/models");
    expect(after.selectionFor(sid)?.modelID).toBe(GLM_MODEL);
  });

  it("(5) sanitize + fail-closed: malformed / version-mismatched / garbage payloads load empty", async () => {
    // (a) corrupt JSON → empty map, no crash.
    localStorage.setItem(KEY, "{not json");
    vi.resetModules();
    let store = await import("../../src/sync/store");
    expect(store.sessionModelPicks).toEqual({});

    // (b) version-mismatched envelope → empty map (no migrate, fail-closed).
    localStorage.setItem(KEY, JSON.stringify({ v: 2, data: { x: { providerID: "a", modelID: "b", t: 1 } } }));
    vi.resetModules();
    store = await import("../../src/sync/store");
    expect(store.sessionModelPicks).toEqual({});

    // (c) matching envelope with garbage data → only well-formed entries kept.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        data: {
          good: { providerID: "zai", modelID: "glm-5", variant: "fast", t: 7 },
          "": { providerID: "zai", modelID: "glm-5", t: 1 }, // empty session id — dropped
          noProvider: { modelID: "glm-5", t: 1 }, // missing providerID — dropped
          noModel: { providerID: "zai", t: 1 }, // missing modelID — dropped
          notObj: "junk", // not an object — dropped
          weirdT: { providerID: "zai", modelID: "glm-5", t: "x" }, // non-number t → clamped to 0, kept
        },
      }),
    );
    vi.resetModules();
    store = await import("../../src/sync/store");
    expect(Object.keys(store.sessionModelPicks).sort()).toEqual(["good", "weirdT"]);
    expect(store.sessionModelPicks["good"]).toEqual({ providerID: "zai", modelID: "glm-5", variant: "fast", t: 7 });
    expect(store.sessionModelPicks["weirdT"]).toEqual({ providerID: "zai", modelID: "glm-5", variant: undefined, t: 0 });

    // (d) an array payload → empty map.
    localStorage.setItem(KEY, JSON.stringify({ v: 1, data: [{ providerID: "zai", modelID: "glm-5", t: 1 }] }));
    vi.resetModules();
    store = await import("../../src/sync/store");
    expect(store.sessionModelPicks).toEqual({});
  });

  it("(6) cap: 201 picks evict the oldest by write time (memory + persisted)", async () => {
    vi.resetModules();
    const store = await import("../../src/sync/store");
    // Deterministic write times: same-ms Date.now() calls would make the
    // oldest-evicted assertion arbitrary among ties.
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => ++t);
    for (let i = 0; i < 201; i++) {
      store.setSessionModelPick(`s${i}`, { providerID: "zai", modelID: `m${i}` });
    }
    expect(Object.keys(store.sessionModelPicks).length).toBe(200);
    // Oldest evicted, newest kept — in memory AND in the persisted map.
    expect(store.sessionModelPicks["s0"]).toBeUndefined();
    expect(store.sessionModelPicks["s200"]).toBeTruthy();
    const persisted = readPersisted();
    expect(Object.keys(persisted).length).toBe(200);
    expect(persisted["s0"]).toBeUndefined();
    expect(persisted["s200"]).toBeTruthy();
  });

  it("(7) session removal prunes the pick in-memory AND persisted (the only clear path)", async () => {
    vi.resetModules();
    const store = await import("../../src/sync/store");
    const { applySessionEvent } = await import("../../src/sync/reconcile");
    store.setSessionModelPick("x", { providerID: GLM_PROVIDER, modelID: GLM_MODEL, variant: GLM_VARIANT });
    expect(store.sessionModelPicks["x"]?.modelID).toBe(GLM_MODEL);
    expect(readPersisted()["x"]?.modelID).toBe(GLM_MODEL);

    applySessionEvent("session.delete", 7, { id: "x" });

    expect(store.sessionModelPicks["x"]).toBeUndefined();
    expect(readPersisted()["x"]).toBeUndefined();
  });

  it("(8) Solid-setter mutations only: bare delete on the read proxy is swallowed; clearSessionModelPick works", async () => {
    vi.resetModules();
    const store = await import("../../src/sync/store");
    store.setSessionModelPick("x", { providerID: GLM_PROVIDER, modelID: GLM_MODEL });
    // The exported store value is a read proxy: a bare `delete` on it is
    // SILENTLY SWALLOWED (Solid store contract) — pin that so nobody "simplifies"
    // clearSessionModelPick into a bare delete.
    delete (store.sessionModelPicks as Record<string, unknown>)["x"];
    expect(store.sessionModelPicks["x"]).toBeTruthy();

    // The sanctioned removal path goes through the setter (produce) and prunes
    // both memory and the persisted map.
    store.clearSessionModelPick("x");
    expect(store.sessionModelPicks["x"]).toBeUndefined();
    expect(readPersisted()["x"]).toBeUndefined();
    // Idempotent: clearing an absent id is a no-op.
    expect(() => store.clearSessionModelPick("x")).not.toThrow();
  });

  it("(9) project-switch re-seed: resetSessionModelPicks swaps memory without clobbering the outgoing project's persisted copy", async () => {
    vi.resetModules();
    const store = await import("../../src/sync/store");
    store.setSessionModelPick("x", { providerID: GLM_PROVIDER, modelID: GLM_MODEL });

    // switchProject's exact mechanism (actions.ts): seed from the NEW dir's
    // persisted map (dirB has none) without persisting.
    store.resetSessionModelPicks(store.loadSessionModels("/work/dirB"));
    expect(store.sessionModelPicks).toEqual({});
    // The OUTGOING project's persisted copy is untouched (no clobber).
    expect(readPersisted()["x"]?.modelID).toBe(GLM_MODEL);
    // And the new dir's key was never written.
    expect(localStorage.getItem("vh.sessionmodels.v1:/work/dirB")).toBeNull();
  });

  it("(10) migrateModelPick persists the draft's transferred intent to the live id", async () => {
    vi.resetModules();
    const M = await import("../../src/models");
    // Explicit draft pick (the P0 draft record — unchanged behavior).
    M.chooseModel("", GLM_PROVIDER, GLM_MODEL);
    M.chooseVariant("", GLM_VARIANT);

    // First send materializes the draft into a real session.
    const liveID = "sess-live-10";
    M.migrateModelPick("", liveID);

    // The transferred intent is persisted for the live id (P1)…
    expect(readPersisted()[liveID]).toMatchObject({ providerID: GLM_PROVIDER, modelID: GLM_MODEL, variant: GLM_VARIANT });
    // …the draft record is consumed…
    expect(localStorage.getItem("vh.model.draft.v1")).toBeNull();
    // …and a reload resolves the live session's pick from the map (the
    // in-memory migration is gone, the pick survives).
    vi.resetModules();
    const after = await import("../../src/models");
    const sel = after.selectionFor(liveID);
    expect(sel).toBeTruthy();
    expect(sel!.providerID).toBe(GLM_PROVIDER);
    expect(sel!.modelID).toBe(GLM_MODEL);
    expect(sel!.variant).toBe(GLM_VARIANT);
  });

  it("(11) write-side fail-closed: junk selections are refused, and the draft id never enters the map", async () => {
    vi.resetModules();
    const store = await import("../../src/sync/store");
    expect(() => store.setSessionModelPick("", { providerID: "a", modelID: "b" })).not.toThrow();
    expect(() => store.setSessionModelPick("x", { providerID: "", modelID: "b" })).not.toThrow();
    expect(() => store.setSessionModelPick("x", { providerID: "a", modelID: "" })).not.toThrow();
    expect(store.sessionModelPicks).toEqual({});
    expect(localStorage.getItem(KEY)).toBeNull(); // nothing persisted

    // The composer path never writes the draft "" into the map.
    const M = await import("../../src/models");
    M.chooseModel("", GLM_PROVIDER, GLM_MODEL);
    expect(store.sessionModelPicks[""]).toBeUndefined();
    expect(readPersisted()[""]).toBeUndefined();
    expect(localStorage.getItem("vh.model.draft.v1")).not.toBeNull(); // draft channel instead
  });
});

// ---------------------------------------------------------------------------
// b-F1 (review blocker): the pick stores' sole clear path is session removal —
// but the session-removed effect only fires for the DISCRETE session.delete
// event (and the eager archive prune). A session deleted while this browser is
// OFFLINE misses its session.delete; the reconnect's AUTHORITATIVE FULL
// snapshot then replaces s.sessions wholesale WITHOUT the removal cascade, so
// the persisted pick survived (vh.sessionmodels.v1 / vh.sessionagents.v1) — and
// a server-side id REUSE would restore + dispatch the PRIOR occupant's pick.
// The fix: the wholesale snapshot projection diffs prior vs incoming session
// ids and records a snapshot-prune-picks effect; orchestration runs the same
// clear functions the session-removed path runs. Frontier-scoped partial
// snapshots (snap.partial) are EXEMPT — they merge by scope and omission from
// them is NOT deletion.
// ---------------------------------------------------------------------------
const AGENT_KEY = "vh.sessionagents.v1:";

const readAgentPersisted = (): Record<string, any> =>
  JSON.parse(localStorage.getItem(AGENT_KEY) ?? "null")?.data ?? {};

// A frontier-scoped partial detail frame carrying only the frontier session
// (the buried/deleted-elsewhere session is legitimately absent from scope).
function scopedPartialSnapshot(seq: number, scopeId: string) {
  return {
    seq,
    epoch: "e1",
    sessions: [{ id: scopeId }],
    partial: {
      mode: "tree-stream-1-frontier",
      scope: [scopeId],
      authority: {
        sessions: "frontier",
        activity: "frontier",
        gate: "frontier",
        lastAgents: "frontier",
        currentVerbs: "frontier",
        questions: "global",
        permissions: "global",
        unread: "global",
      },
    },
  } as any;
}

describe("session picks — wholesale full-snapshot prune (b-F1 missed session.delete)", () => {
  it("(12) a full snapshot omitting the session prunes BOTH picks in-memory AND persisted", async () => {
    vi.resetModules();
    const store = await import("../../src/sync/store");
    const { applySnapshot } = await import("../../src/sync/reconcile");
    // Two RESIDENT sessions, both picked (model + agent stores).
    store.setState("sessions", "s-gone", { id: "s-gone" });
    store.setState("sessions", "s-keep", { id: "s-keep" });
    store.setSessionModelPick("s-gone", { providerID: GLM_PROVIDER, modelID: GLM_MODEL, variant: GLM_VARIANT });
    store.setSessionModelPick("s-keep", { providerID: "openai", modelID: "gpt-4" });
    store.setSessionAgentPick("s-gone", "build");
    store.setSessionAgentPick("s-keep", "plan");
    expect(readPersisted()["s-gone"]?.modelID).toBe(GLM_MODEL);
    expect(readAgentPersisted()["s-gone"]?.agent).toBe("build");

    // Reconnect after an OFFLINE delete of s-gone (its session.delete was never
    // delivered): the authoritative FULL snapshot (no `partial`) replaces the
    // session set wholesale, omitting s-gone.
    applySnapshot({ seq: 10, sessions: [{ id: "s-keep" }], epoch: "e1" } as any);

    // The session is gone from the store…
    expect(store.state.sessions["s-gone"]).toBeUndefined();
    // …so BOTH persisted picks are pruned — in memory AND in localStorage —
    // via the real effect-consumption path (applySnapshot → projection →
    // interpretEffects → clear*Pick).
    expect(store.sessionModelPicks["s-gone"]).toBeUndefined();
    expect(readPersisted()["s-gone"]).toBeUndefined();
    expect(store.sessionAgentPicks["s-gone"]).toBeUndefined();
    expect(readAgentPersisted()["s-gone"]).toBeUndefined();
    // The diff is scoped to DISAPPEARED ids: the surviving session's pick is
    // untouched (this is a diff, not a nuke).
    expect(store.sessionModelPicks["s-keep"]?.modelID).toBe("gpt-4");
    expect(readPersisted()["s-keep"]?.modelID).toBe("gpt-4");
    expect(store.sessionAgentPicks["s-keep"]?.agent).toBe("plan");
  });

  it("(13) a frontier-scoped partial that omits the session NEVER prunes the picks (exemption)", async () => {
    vi.resetModules();
    const store = await import("../../src/sync/store");
    const { applyScopedSnapshot } = await import("../../src/sync/reconcile");
    store.setState("sessions", "s-buried", { id: "s-buried" });
    store.setSessionModelPick("s-buried", { providerID: GLM_PROVIDER, modelID: GLM_MODEL });
    store.setSessionAgentPick("s-buried", "build");

    // A scoped partial carries only the FRONTIER — s-buried is legitimately
    // absent (buried detail outside scope), NOT deleted. Pruning here would
    // nuke picks for every non-frontier session on every reconnect.
    applyScopedSnapshot(scopedPartialSnapshot(11, "s-frontier"));

    // Merge semantics: the buried session stays resident…
    expect(store.state.sessions["s-buried"]).toBeTruthy();
    // …and BOTH picks survive — in memory AND persisted.
    expect(store.sessionModelPicks["s-buried"]?.modelID).toBe(GLM_MODEL);
    expect(readPersisted()["s-buried"]?.modelID).toBe(GLM_MODEL);
    expect(store.sessionAgentPicks["s-buried"]?.agent).toBe("build");
    expect(readAgentPersisted()["s-buried"]?.agent).toBe("build");
  });

  it("(14) id-reuse end state: after the snapshot prune, no resolution restores the prior occupant's picks", async () => {
    vi.resetModules();
    const store = await import("../../src/sync/store");
    const { applySnapshot } = await import("../../src/sync/reconcile");
    const M = await import("../../src/models");
    const A = await import("../../src/agents");
    store.setState("sessions", "s-reuse", { id: "s-reuse" });
    // The PRIOR occupant's explicit picks, seeded at store level (a UI
    // chooseModel would also stamp the id-agnostic GLOBAL default — not this
    // assertion's subject).
    store.setSessionModelPick("s-reuse", { providerID: GLM_PROVIDER, modelID: GLM_MODEL, variant: GLM_VARIANT });
    store.setSessionAgentPick("s-reuse", "old-occupant-agent");

    // Offline delete + reconnect (full snapshot omits the id → prune)…
    applySnapshot({ seq: 10, sessions: [], epoch: "e1" } as any);
    // …then the server REUSES the id for a brand-new session.
    store.setState("sessions", "s-reuse", { id: "s-reuse" });

    // Model: selectionFor finds NO restored pick — falls through every rung
    // to null (no explicit pick, no session model, no message evidence, no
    // global default in this env).
    expect(M.selectionFor("s-reuse")).toBeNull();
    expect(store.sessionModelPicks["s-reuse"]).toBeUndefined();
    expect(readPersisted()["s-reuse"]).toBeUndefined();
    // Agent: resolution is pending — NOT the prior occupant's agent.
    expect(A.resolveAgentForSession("s-reuse").state).toBe("pending");
    expect(A.agentForSession("s-reuse")).toBe("");
    expect(readAgentPersisted()["s-reuse"]).toBeUndefined();
  });
});
