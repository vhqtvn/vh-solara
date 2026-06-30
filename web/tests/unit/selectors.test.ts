import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { setState } from "../../src/sync/store";
import { currentVerb, sessionLastAgent } from "../../src/sync/selectors";
import type { Part } from "../../src/types";

// The Working pill's verb selector. `currentVerb` is a pure read of `state`, so
// we drive the singleton store directly and assert the derived verb/subject/base.
// The elapsed text itself is formatted in ChatView (it owns the ticking clock),
// so here we assert startMs (the timer base) instead of a formatted string.

const SID = "s1";
const MID = "m1";

// Build a one-message assistant turn whose parts are `parts`. `created` is the
// turn-start timestamp (the Waiting/Working fallback elapsed base).
function setTurn(parts: Part[], created = 5000): void {
  setState("messages", SID, {
    order: [MID],
    byId: {
      [MID]: {
        id: MID,
        info: { id: MID, sessionID: SID, role: "assistant", time: { created } },
        partOrder: parts.map((p) => p.id),
        parts: Object.fromEntries(parts.map((p) => [p.id, p])),
      },
    },
  });
}

function setWorking(): void {
  setState("sessions", SID, { id: SID });
  setState("activity", SID, "busy");
}
function setIdle(): void {
  setState("activity", SID, "idle");
}

beforeEach(() => {
  // Solid's setState MERGES objects, so setState("permissions", {}) would leave
  // stale nested keys (e.g. a SID set by a prior test) and pollute later tests.
  // reconcile({}) diffs each slice down to empty — a true reset.
  setState("sessions", reconcile({}));
  setState("messages", reconcile({}));
  setState("activity", reconcile({}));
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
  setState("todos", reconcile({}));
  setState("lastAgents", reconcile({}));
  setState("currentVerbs", reconcile({}));
});

describe("currentVerb (Working pill)", () => {
  it("returns null when the session is not working", () => {
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "tool", tool: "bash",
        state: { status: "running", input: { command: "go test" }, time: { start: 1000 } } },
    ]);
    setIdle();
    expect(currentVerb(SID)).toBeNull();
  });

  it("prefers 'Waiting for approval' when a permission is pending", () => {
    setWorking();
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "tool", tool: "bash",
        state: { status: "running", input: { command: "go test" }, time: { start: 1000 } } },
    ]);
    setState("permissions", SID, { perm1: { id: "perm1", sessionID: SID } });
    expect(currentVerb(SID)).toEqual({ verb: "Waiting for approval", subject: undefined, startMs: 5000 });
  });

  it("prefers 'Waiting for approval' when a question is pending", () => {
    setWorking();
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "reasoning", text: "hmm", time: { start: 1000 } },
    ]);
    setState("questions", SID, { q1: { id: "q1", sessionID: SID, questions: [] } });
    expect(currentVerb(SID)).toEqual({ verb: "Waiting for approval", subject: undefined, startMs: 5000 });
  });

  it("shows the present-tense verb + command for a running bash tool", () => {
    setWorking();
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "tool", tool: "bash",
        state: { status: "running", input: { command: "go test ./..." }, time: { start: 4000 } },
        time: { start: 4000 } },
    ]);
    expect(currentVerb(SID)).toEqual({ verb: "Running", subject: "go test ./...", startMs: 4000 });
  });

  it("shows 'Reading' + the path for a running read tool", () => {
    setWorking();
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "tool", tool: "read",
        state: { status: "running", input: { filePath: "src/parser.go" }, time: { start: 4000 } },
        time: { start: 4000 } },
    ]);
    expect(currentVerb(SID)).toEqual({ verb: "Reading", subject: "src/parser.go", startMs: 4000 });
  });

  it("shows 'Thinking' for a live reasoning part (no time.end)", () => {
    setWorking();
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "reasoning", text: "reasoning…", time: { start: 3000 } },
    ]);
    expect(currentVerb(SID)).toEqual({ verb: "Thinking", subject: undefined, startMs: 3000 });
  });

  it("falls back to 'Working' (turn-level base) when no active part is live", () => {
    setWorking();
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "tool", tool: "bash",
        state: { status: "completed" }, time: { start: 1000, end: 1100 } },
    ]);
    // A bare 'task' tool with no subject and not running also lands in fallback.
    expect(currentVerb(SID)).toEqual({ verb: "Working", subject: undefined, startMs: 5000 });
  });

  it("prefers a running tool over an older live reasoning part", () => {
    setWorking();
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "reasoning", text: "hmm", time: { start: 1000 } },
      { id: "p2", sessionID: SID, messageID: MID, type: "tool", tool: "read",
        state: { status: "running", input: { filePath: "a.go" }, time: { start: 2000 } } },
    ]);
    expect(currentVerb(SID)).toEqual({ verb: "Reading", subject: "a.go", startMs: 2000 });
  });

  it("picks the newest of multiple running tools", () => {
    setWorking();
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "tool", tool: "bash",
        state: { status: "running", input: { command: "first" }, time: { start: 1000 } } },
      { id: "p2", sessionID: SID, messageID: MID, type: "tool", tool: "grep",
        state: { status: "running", input: { pattern: "TODO" }, time: { start: 2000 } } },
    ]);
    expect(currentVerb(SID)).toEqual({ verb: "Searching", subject: "TODO", startMs: 2000 });
  });

  it("omits subject when the running tool has no salient argument", () => {
    setWorking();
    setTurn([
      { id: "p1", sessionID: SID, messageID: MID, type: "tool", tool: "task",
        state: { status: "running", input: {}, time: { start: 2000 } } },
    ]);
    expect(currentVerb(SID)).toEqual({ verb: "Running", subject: undefined, startMs: 2000 });
  });
});

// currentVerb's Tier-A facet fallback (Path B2). For an UNOPENED task-tool
// subagent, the daemon ships a RAW tool primitive (tool + trimmed state) on the
// tree stream so the chat row can show rich activity ("Reading parser.go")
// WITHOUT loading Tier-B messages. The selector formats it via the SAME
// toolVerb/toolSubject as the opened path. Precedence: opened child's loaded
// messages (activeVerbFromTurn) → facet → coarse "Working". Opened always wins.
describe("currentVerb (Tier-A facet fallback for unopened subagent)", () => {
  const CHILD = "child";

  // Mark CHILD as working (session present + busy). Mirrors setWorking() but
  // for an arbitrary id — the helpers above hardcode SID.
  function childWorking(): void {
    setState("sessions", CHILD, { id: CHILD });
    setState("activity", CHILD, "busy");
  }

  // Load an assistant turn (with parts) for CHILD, marking it OPENED. Mirrors
  // setTurn() but targets CHILD so currentVerb sees messages loaded.
  function childTurn(parts: Part[], created = 5000): void {
    setState("messages", CHILD, {
      order: [MID],
      byId: {
        [MID]: {
          id: MID,
          info: { id: MID, sessionID: CHILD, role: "assistant", time: { created } },
          partOrder: parts.map((p) => p.id),
          parts: Object.fromEntries(parts.map((p) => [p.id, p])),
        },
      },
    });
  }

  function setFacet(facet: { tool: string; state?: any }): void {
    setState("currentVerbs", CHILD, facet);
  }

  it("formats the facet verb+subject when the child is unopened (no messages)", () => {
    childWorking();
    setFacet({ tool: "read", state: { status: "running", input: { filePath: "src/parser.go" }, time: { start: 4000 } } });
    // No messages loaded for CHILD → facet path.
    expect(currentVerb(CHILD)).toEqual({ verb: "Reading", subject: "src/parser.go", startMs: 4000 });
  });

  it("opened child's loaded messages override the facet (authoritative)", () => {
    childWorking();
    // Stale facet says "Reading old.go"; the live message scan finds a bash run.
    setFacet({ tool: "read", state: { status: "running", input: { filePath: "old.go" }, time: { start: 1000 } } });
    childTurn([
      { id: "p1", sessionID: CHILD, messageID: MID, type: "tool", tool: "bash",
        state: { status: "running", input: { command: "go test" }, time: { start: 9000 } } },
    ]);
    // Messages loaded → activeVerbFromTurn wins, the facet is ignored.
    expect(currentVerb(CHILD)).toEqual({ verb: "Running", subject: "go test", startMs: 9000 });
  });

  it("opened child with no live part degrades to 'Working', NOT the facet", () => {
    childWorking();
    setFacet({ tool: "read", state: { status: "running", input: { filePath: "facet.go" }, time: { start: 1000 } } });
    // Opened turn has only a completed tool — activeVerbFromTurn returns null,
    // but because messages ARE loaded (sm present), the facet must NOT surface.
    childTurn([
      { id: "p1", sessionID: CHILD, messageID: MID, type: "tool", tool: "bash",
        state: { status: "completed" }, time: { start: 1000, end: 1100 } },
    ]);
    expect(currentVerb(CHILD)).toEqual({ verb: "Working", subject: undefined, startMs: 5000 });
  });

  it("degrades to 'Working' when unopened and no facet is present", () => {
    childWorking();
    // No facet, no messages → coarse fallback (the existing spinner behavior).
    expect(currentVerb(CHILD)).toEqual({ verb: "Working", subject: undefined, startMs: 0 });
  });

  it("omits subject when the facet tool has no salient argument", () => {
    childWorking();
    setFacet({ tool: "task", state: { status: "running", input: {}, time: { start: 2000 } } });
    expect(currentVerb(CHILD)).toEqual({ verb: "Running", subject: undefined, startMs: 2000 });
  });

  it("returns null when the session is not working, even if a facet is present", () => {
    setState("sessions", CHILD, { id: CHILD });
    setState("activity", CHILD, "idle");
    setFacet({ tool: "read", state: { status: "running", input: { filePath: "x.go" }, time: { start: 1 } } });
    // sessionWorking gates first; a stale facet left in the map must not render.
    expect(currentVerb(CHILD)).toBeNull();
  });
});

// sessionLastAgent backs the per-agent chip in the tree. On a COLD tree (no
// session opened), the client holds no messages, so the chip must render from
// the snapshot-seeded lastAgents map. Once a session is opened (messages
// loaded), the live scan is authoritative and reflects streaming updates.
describe("sessionLastAgent (tree chip / cold + live)", () => {
  const COLD = "cold";
  const LIVE = "live";

  it("returns undefined when neither messages nor a seeded lastAgent exist", () => {
    expect(sessionLastAgent("none")).toBeUndefined();
  });

  it("renders from the snapshot-seeded lastAgents map on a COLD tree (no messages)", () => {
    // No messages loaded for COLD — the tree-only snapshot carries none. The
    // snapshot seeds lastAgents so the chip renders before any open.
    setState("lastAgents", COLD, "build");
    expect(sessionLastAgent(COLD)).toBe("build");
  });

  it("prefers the live message scan when messages are loaded (authoritative)", () => {
    // Seed a stale value; opening the session must reflect the live agent.
    setState("lastAgents", LIVE, "plan");
    setState("messages", LIVE, {
      order: ["m1"],
      byId: {
        m1: { id: "m1", info: { id: "m1", sessionID: LIVE, role: "assistant", agent: "build" }, partOrder: [], parts: {} },
      },
    });
    expect(sessionLastAgent(LIVE)).toBe("build");
  });

  it("returns undefined when loaded but no assistant message carries an agent", () => {
    setState("lastAgents", LIVE, "build");
    setState("messages", LIVE, {
      order: ["m1"],
      byId: {
        m1: { id: "m1", info: { id: "m1", sessionID: LIVE, role: "user" }, partOrder: [], parts: {} },
      },
    });
    // Loaded + authoritative: no assistant → undefined (NOT the stale seed).
    expect(sessionLastAgent(LIVE)).toBeUndefined();
  });
});
