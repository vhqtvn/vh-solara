// Locks the per-session agent decoupling (commit f661b4d and the
// silent-flip slice): a per-session agent pick must NOT mutate the GLOBAL
// default, and an existing session with NO agent evidence of its own
// resolves PENDING — never the global/config default, never another
// session's pick. Only a draft pick (sessionID "") updates the global that
// new sessions inherit. Explicit per-session picks live in the PERSISTED
// sessionAgentPicks store (sync/store.ts), seeded per project dir.
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
// applyModel — no need to mock ./models. ./sync is left real: for a session
// with no seeded evidence (no persisted pick, no window stamp, no lastAgents
// facet) the resolver returns PENDING — the state these tests assert.
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
// draft pick). The module-level sessionAgentPicks store accumulates picks
// across tests, so each test below uses a DISTINCT session id.
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
    // resolution (persisted pick / last-message agent / lastAgents facet) is
    // absent. Under the silent-flip contract such a session resolves PENDING
    // ("") — NOT the global default "G" and NOT another session's "Y": an
    // existing session with no evidence must never silently adopt a default.
    selectAgentForSession("realC", "Y");
    expect(agentForSession("otherC")).toBe(""); // pending — neither "Y" nor "G"
  });

  it("a session's own override still resolves when set", () => {
    selectAgentForSession("realD", "Y");
    expect(agentForSession("realD")).toBe("Y");
  });
});
