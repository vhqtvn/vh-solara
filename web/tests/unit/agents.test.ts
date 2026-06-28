// Locks the per-session agent-decoupling fix (commit f661b4d): a per-session
// agent pick must NOT mutate the GLOBAL default, so a session whose own
// resolution is absent keeps falling back to the global instead of silently
// flipping to whatever another session just picked. Only a draft pick
// (sessionID "") updates the global that new sessions inherit.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory localStorage for the node test env — setSelectedAgent persists via
// saveVersioned → localStorage.setItem. (Pattern copied from store.test.ts.)
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

// Mock the API layer so loadAgents() can populate agents() without a network
// round-trip. Agents carry no `.model`, so selectAgentForSession never reaches
// applyModel — no need to mock ./models. ./sync is left real: sessionLastAgent
// returns undefined for any session absent from the store, so agentForSession
// falls through to the global as these tests require.
vi.mock("../../src/api", () => ({
  oc: {
    get: vi.fn((url: string) =>
      url === "/agent"
        ? Promise.resolve([{ name: "G" }, { name: "Y" }])
        : Promise.resolve(null), // /config → null
    ),
  },
}));

import {
  loadAgents,
  selectAgentForSession,
  agentForSession,
  setSelectedAgent,
  selectedAgent,
} from "../../src/agents";

// Populate agents() to [{name:"G"},{name:"Y"}] and resolve the global default:
// config null → stored "" → no "build" → usable[0].name = "G".
beforeAll(async () => {
  await loadAgents();
});

// Re-pin the global before each test (prior tests may have changed it via a
// draft pick). sessionAgentSel is module-private and accumulates across tests,
// so each test below uses a DISTINCT session id.
beforeEach(() => {
  setSelectedAgent("G");
});

describe("selectAgentForSession decoupling", () => {
  it("a per-session pick does not change the global default", () => {
    const before = selectedAgent();
    selectAgentForSession("realA", "Y");
    expect(selectedAgent()).toBe(before);
    expect(selectedAgent()).toBe("G");
  });

  it("a draft pick (empty session id) updates the global default", () => {
    selectAgentForSession("", "Y");
    expect(selectedAgent()).toBe("Y");
  });

  it("a per-session pick does not leak into a session with no own resolution", () => {
    // Pick "Y" for one session, then resolve a DIFFERENT session whose own
    // resolution (sessionAgentSel entry / last-message agent) is absent.
    selectAgentForSession("realC", "Y");
    expect(agentForSession("otherC")).toBe("G"); // NOT "Y"
  });

  it("a session's own override still resolves when set", () => {
    selectAgentForSession("realD", "Y");
    expect(agentForSession("realD")).toBe("Y");
  });
});
