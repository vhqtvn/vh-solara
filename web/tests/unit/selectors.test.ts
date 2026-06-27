import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { setState } from "../../src/sync/store";
import { currentVerb } from "../../src/sync/selectors";
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
