// Resolver-level regression lock for the silent agent-flip incidents
// (2026-08-16, 2026-08-26): an existing session that has ever run under some
// agent must NEVER resolve — let alone send — the config/global default
// merely because hydration hadn't caught up. The production posture is
// reproduced exactly: /agent returns [supervisor, coordination], /config
// declares default_agent "coordination", and a session that has run under
// "supervisor" must stay "supervisor" through every window below.
//
// The send-path counterpart (createSend enqueue/POST bodies) lives in
// sendAgentGate.test.ts; the Composer display states in
// ComposerAgentStates.test.tsx.
//
// Acceptance windows (task contract):
//   (a) loaded message window with NO agent-stamped message + a lastAgents
//       entry → resolves that entry, NOT the config default;
//   (b) cold session ABSENT from lastAgents → pending; the gate waits for
//       evidence, times out, or fail-fasts on hydration error — and NEVER
//       hands back the config default;
//   (c) an explicit per-session pick survives a reload (persisted store);
//   (d) evidence-backed agent absent from the live list → unavailable, no
//       silent list[0]/config substitution;
//   (e) draft ("") + provably-empty sessions keep the config-default policy,
//       validated against the loaded list (a stale default demotes to list[0]
//       identically in both branches — never handed back unvalidated);
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";

// In-memory localStorage (node env): the per-session picks map persists
// through saveVersioned exactly as in the browser.
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

import {
  adoptDraftAgent,
  agentForSession,
  awaitSendAgent,
  loadAgents,
  resolveAgentForSession,
  selectAgentForSession,
  selectedAgent,
  type SendAgentOutcome,
} from "../../src/agents";
import {
  lsSessionAgents,
  loadSessionAgents,
  resetSessionAgentPicks,
  sessionAgentPicks,
  setSessionAgentPick,
  setState,
} from "../../src/sync/store";

function seedWindow(id: string, msgs: { mid: string; agent?: string }[]): void {
  setState("messages", id, reconcile({
    order: msgs.map((m) => m.mid),
    byId: Object.fromEntries(
      msgs.map((m) => [
        m.mid,
        { id: m.mid, info: { id: m.mid, sessionID: id, role: "user", ...(m.agent ? { agent: m.agent } : {}) } },
      ]),
    ),
  }));
}

async function boot(): Promise<void> {
  await loadAgents();
  expect(selectedAgent()).toBe("coordination"); // the config default, as in production
}

beforeEach(() => {
  vi.useRealTimers();
  setState("messages", reconcile({}));
  setState("messagesDelivered", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("lastAgents", reconcile({}));
  resetSessionAgentPicks({});
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// (a) loaded window, no agent-stamped message
// ---------------------------------------------------------------------------
describe("(a) window without agent stamps", () => {
  it("resolves the lastAgents entry — NOT the config default", async () => {
    await boot();
    seedWindow("ses_a", [{ mid: "m1" }, { mid: "m2" }]);
    setState("lastAgents", "ses_a", "supervisor");

    const r = resolveAgentForSession("ses_a");
    expect(r.state).toBe("agent");
    if (r.state === "agent") {
      expect(r.agent).toBe("supervisor");
      expect(r.agent).not.toBe("coordination"); // the incident assertion
    }
  });

  it("no facet either → pending (never the config default)", async () => {
    await boot();
    seedWindow("ses_a", [{ mid: "m1" }]);

    expect(resolveAgentForSession("ses_a").state).toBe("pending");
    expect(agentForSession("ses_a")).toBe(""); // back-compat string: "" while pending
  });

  it("the gate refuses to hand back any agent while evidence-less", async () => {
    await boot();
    seedWindow("ses_a", [{ mid: "m1" }]);

    const out = await awaitSendAgent("ses_a", { timeoutMs: 30 });
    expect(out.ok).toBe(false);
    expect((out as { agent?: string }).agent).toBeUndefined(); // no fabricated value
  });

  it("a live agent stamp outranks a stale facet", async () => {
    await boot();
    seedWindow("ses_a", [{ mid: "m1", agent: "supervisor" }]);
    setState("lastAgents", "ses_a", "coordination");

    const r = resolveAgentForSession("ses_a");
    expect(r.state).toBe("agent");
    if (r.state === "agent") expect(r.agent).toBe("supervisor"); // newest stamp wins
  });
});

// ---------------------------------------------------------------------------
// (b) cold session / no evidence at all
// ---------------------------------------------------------------------------
describe("(b) cold session with no evidence", () => {
  it("absent from lastAgents → pending", async () => {
    await boot();
    expect(resolveAgentForSession("ses_b").state).toBe("pending");
  });

  it("gate times out (bounded wait, loud failure)", async () => {
    await boot();
    vi.useFakeTimers();
    try {
      const p = awaitSendAgent("ses_b", { timeoutMs: 30 });
      await vi.advanceTimersByTimeAsync(50);
      const out = await p;
      expect(out).toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pre-aborted signal settles the gate IMMEDIATELY — no subscription, no timer wait", async () => {
    await boot();
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController();
      ctrl.abort(); // aborted BEFORE the gate is entered
      let out: SendAgentOutcome | undefined;
      awaitSendAgent("ses_b", { timeoutMs: 30_000, signal: ctrl.signal }).then((o) => {
        out = o;
      });
      // ZERO clock advance — only the microtask queue flushes. An
      // already-aborted signal never fires its "abort" listener (that event
      // fired at abort time, before the gate subscribed), so without the
      // upfront aborted check this rides the full 30s window: `out` would
      // still be undefined here and a timeout timer would be armed.
      await vi.advanceTimersByTimeAsync(0);
      expect(out).toEqual({ ok: false, reason: "timeout" }); // caller-aborted = timeout semantics
      expect(vi.getTimerCount()).toBe(0); // no timeout timer was ever armed
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves the moment the facet lands mid-wait", async () => {
    await boot();
    const p = awaitSendAgent("ses_b", { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 10));
    setState("lastAgents", "ses_b", "supervisor");
    const out = await p;
    expect(out).toEqual({ ok: true, agent: "supervisor" });
  });

  it("fail-fasts on hydration error instead of waiting out the timer", async () => {
    await boot();
    const p = awaitSendAgent("ses_b", { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 10));
    setState("messagesError", "ses_b", true);
    const out = await p;
    expect(out).toEqual({ ok: false, reason: "hydration-error" });
  });
});

// ---------------------------------------------------------------------------
// (e) the config-default policy stays legitimate where it belongs
// ---------------------------------------------------------------------------
describe("(e) drafts and provably-empty sessions", () => {
  it("draft ('') resolves immediately to the config default", async () => {
    await boot();
    expect(agentForSession("")).toBe("coordination");
    const out = await awaitSendAgent("");
    expect(out).toEqual({ ok: true, agent: "coordination" });
  });

  it("provably-empty session (hydration delivered, zero messages) → config default", async () => {
    await boot();
    setState("messagesDelivered", "ses_empty", true);
    setState("messages", "ses_empty", { order: [], byId: {} });

    const r = resolveAgentForSession("ses_empty");
    expect(r.state).toBe("agent");
    if (r.state === "agent") expect(r.agent).toBe("coordination");
  });

  it("provably-empty + config default NOT in the loaded list → demotes exactly like the draft branch (list[0], never the stale default)", async () => {
    await boot();
    // Post-boot posture: the live list is [supervisor, coordination] but the
    // GLOBAL default names an agent NOT in it (a config default_agent that
    // points at a since-removed/renamed agent). A draft pick ("") is the only
    // public way to update the global default.
    selectAgentForSession("", "retired-default");
    expect(selectedAgent()).toBe("retired-default");
    setState("messagesDelivered", "ses_empty_retired", true);
    setState("messages", "ses_empty_retired", { order: [], byId: {} });

    // Both branches see the SAME state (loaded list + stale default). The
    // draft branch ("")…
    const draft = resolveAgentForSession("");
    // …and the provably-empty branch (delivered + zero messages) must agree:
    // the stale default is validated against the live list and demoted to
    // list[0] — never handed back as a sendable agent.
    const empty = resolveAgentForSession("ses_empty_retired");
    expect(empty).toEqual(draft);
    expect(empty).toEqual({ state: "agent", agent: "supervisor" }); // list[0], NOT "retired-default"
    expect(agentForSession("ses_empty_retired")).toBe("supervisor");

    // And the stale default never reaches a send outcome.
    const out = await awaitSendAgent("ses_empty_retired");
    expect(out).toEqual({ ok: true, agent: "supervisor" });
  });

  it("delivered-but-nonempty session with no stamps/facet is NOT provably empty → pending", async () => {
    await boot();
    setState("messagesDelivered", "ses_loaded", true);
    seedWindow("ses_loaded", [{ mid: "m1" }, { mid: "m2" }]);

    expect(resolveAgentForSession("ses_loaded").state).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// (c) explicit per-session pick survives a reload
// ---------------------------------------------------------------------------
describe("(c) persisted explicit pick", () => {
  it("persists to the per-project-dir store and rehydrates after a simulated reload", async () => {
    await boot();
    selectAgentForSession("ses_c", "supervisor");

    // Persisted under the dir-scoped versioned key (mirrors lsLastAgents).
    const raw = JSON.parse(mem[lsSessionAgents("")] ?? "null");
    expect(raw?.v).toBe(1);
    expect(raw?.data?.ses_c?.agent).toBe("supervisor");

    // Simulated reload: the in-memory store is gone…
    resetSessionAgentPicks({});
    expect(resolveAgentForSession("ses_c").state).toBe("pending");

    // …and is re-seeded from the persisted copy (switchProject's re-seed path).
    resetSessionAgentPicks(loadSessionAgents(""));
    const r = resolveAgentForSession("ses_c");
    expect(r.state).toBe("agent");
    if (r.state === "agent") expect(r.agent).toBe("supervisor");
  });

  it("the pick outranks a conflicting lastAgents facet", async () => {
    await boot();
    setState("lastAgents", "ses_c2", "build");
    selectAgentForSession("ses_c2", "supervisor");

    const r = resolveAgentForSession("ses_c2");
    expect(r.state).toBe("agent");
    if (r.state === "agent") expect(r.agent).toBe("supervisor");
  });

  it("a per-session pick never mutates the global default", async () => {
    await boot();
    selectAgentForSession("ses_c3", "supervisor");
    expect(selectedAgent()).toBe("coordination"); // global untouched
  });
});

// ---------------------------------------------------------------------------
// (d) evidence agent missing from the live list
// ---------------------------------------------------------------------------
describe("(d) unavailable state (no silent list[0] substitution)", () => {
  it("evidence names an agent not in the live list → unavailable, gate refuses", async () => {
    await boot();
    setState("lastAgents", "ses_d", "retired-agent"); // NOT in [supervisor, coordination]

    const r = resolveAgentForSession("ses_d");
    expect(r.state).toBe("unavailable");
    if (r.state === "unavailable") expect(r.agent).toBe("retired-agent");
    expect(agentForSession("ses_d")).toBe(""); // never list[0] ("supervisor"), never the default

    const out = await awaitSendAgent("ses_d");
    expect(out).toEqual({ ok: false, reason: "unavailable" });
  });
});

// ---------------------------------------------------------------------------
// Cross-window hardening
// ---------------------------------------------------------------------------
describe("cross: draft adoption + pick-store hygiene", () => {
  it("adoptDraftAgent seeds a fresh session's first evidence (draft → live id)", async () => {
    await boot();
    adoptDraftAgent("ses_new", "supervisor");

    const r = resolveAgentForSession("ses_new");
    expect(r.state).toBe("agent");
    if (r.state === "agent") expect(r.agent).toBe("supervisor");
    const out = await awaitSendAgent("ses_new");
    expect(out).toEqual({ ok: true, agent: "supervisor" });
  });

  it("adoptDraftAgent ignores empty inputs (no evidence fabricated)", async () => {
    await boot();
    expect(() => adoptDraftAgent("", "build")).not.toThrow();
    expect(() => adoptDraftAgent("ses_x", "")).not.toThrow();
    expect(resolveAgentForSession("ses_x").state).toBe("pending");
  });

  it("the pick store is capped at 200 by write time (oldest evicted)", async () => {
    await boot();
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 205; i++) {
        vi.setSystemTime(new Date(1_700_000_000_000 + i * 1_000));
        setSessionAgentPick(`ses_cap_${i}`, "supervisor");
      }
      expect(Object.keys(sessionAgentPicks)).toHaveLength(200);
      expect(sessionAgentPicks["ses_cap_0"]).toBeUndefined(); // oldest evicted
      expect(sessionAgentPicks["ses_cap_204"]!.agent).toBe("supervisor"); // newest kept

      const persisted = JSON.parse(mem[lsSessionAgents("")] ?? "null");
      expect(Object.keys(persisted?.data ?? {})).toHaveLength(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
