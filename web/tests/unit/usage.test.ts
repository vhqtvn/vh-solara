import { describe, expect, it } from "vitest";
import { fmtTurnStats, turnStats } from "../../src/usage";
import type { MessageView } from "../../src/types";

// Build a MessageView from an array of raw parts + an info override. `info`
// defaults to a completed assistant turn so individual cases only spell out the
// fields they vary. Tokens/time live in passthrough JSON the daemon forwards
// untouched (pkg/state/store.go), so fixtures carry them raw.
function mk(parts: any[], info: any = {}): MessageView {
  const byId: Record<string, any> = {};
  const order: string[] = [];
  for (const p of parts) {
    byId[p.id] = p;
    order.push(p.id);
  }
  return {
    id: "m1",
    partOrder: order,
    parts: byId,
    info: { id: "m1", sessionID: "s1", role: "assistant", ...info },
  };
}

describe("turnStats", () => {
  // 1. Single text part, PURE decode rate: tok/s = output / text decode window,
  //    NOT the old full-turn average (output / (completed − created)).
  it("computes tok/s from the text-part decode window, not the full turn", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi", time: { start: 1_000_500, end: 1_002_500 } }],
      { time: { created: 1_000_000, completed: 1_010_000 }, tokens: { output: 200 } },
    );
    // text decode window = 2000ms → 200 / 2s = 100 tok/s
    // (old full-turn avg would be 200 / 10s = 20 — explicitly NOT this)
    const s = turnStats(m)!;
    expect(s.tokPerSec).toBe(100);
    expect(s.ttftMs).toBe(500); // 1_000_500 − 1_000_000
    expect(s.output).toBe(200);
  });

  // 2. TTFT exclusion: a large gap before the text part start must NOT dilute
  //    the decode rate — the denominator is the text window only.
  it("excludes TTFT from the decode rate (huge pre-text gap leaves tok/s unchanged)", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi", time: { start: 5_000_500, end: 5_002_500 } }],
      { time: { created: 1_000_000, completed: 5_010_000 }, tokens: { output: 200 } },
    );
    const s = turnStats(m)!;
    expect(s.ttftMs).toBe(4_000_500); // huge TTFT
    expect(s.tokPerSec).toBe(100); // still 200 / 2s — decode window only
  });

  // 3. Tool/shell/subagent exclusion: their state.time intervals (bash, task)
  //    must NOT enter the denominator.
  it("excludes tool/shell/subagent state.time from the decode denominator", () => {
    const m = mk(
      [
        { id: "x1", type: "text", text: "hi", time: { start: 1_000_500, end: 1_002_500 } },
        { id: "b1", type: "tool", tool: "bash", state: { time: { start: 1_002_600, end: 1_008_000 } } },
        { id: "t1", type: "tool", tool: "task", state: { time: { start: 1_008_100, end: 1_009_900 } } },
      ],
      { time: { created: 1_000_000, completed: 1_010_000 }, tokens: { output: 200 } },
    );
    const s = turnStats(m)!;
    // bash (5400ms) + task (1800ms) excluded → only the 2000ms text window counts
    expect(s.tokPerSec).toBe(100);
    expect(s.ttftMs).toBe(500);
  });

  // 4. Reasoning exclusion: a reasoning part's own time interval is excluded
  //    from the decode denominator (only TEXT parts count).
  it("excludes reasoning-part time from the decode denominator", () => {
    const m = mk(
      [
        { id: "r1", type: "reasoning", text: "thinking", time: { start: 1_000_300, end: 1_002_000 } },
        { id: "x1", type: "text", text: "hi", time: { start: 1_002_100, end: 1_004_100 } },
      ],
      { time: { created: 1_000_000, completed: 1_005_000 }, tokens: { output: 200 } },
    );
    const s = turnStats(m)!;
    // reasoning 1700ms excluded → text 2000ms only → 100 tok/s
    expect(s.tokPerSec).toBe(100);
    expect(s.ttftMs).toBe(300); // TTFT still derived from reasoning start
  });

  // 5. Multi-step turn: two text parts separated by a tool. The tool gap between
  //    them must NOT inflate the denominator — output over the UNION of text.
  it("sums output over the union of two text parts, ignoring the tool gap", () => {
    const m = mk(
      [
        { id: "a", type: "text", text: "one", time: { start: 1_000_500, end: 1_002_500 } },
        { id: "b", type: "tool", tool: "bash", state: { time: { start: 1_002_600, end: 1_006_000 } } },
        { id: "c", type: "text", text: "two", time: { start: 1_006_100, end: 1_008_100 } },
      ],
      { time: { created: 1_000_000, completed: 1_009_000 }, tokens: { output: 400 } },
    );
    const s = turnStats(m)!;
    // union = 2000ms + 2000ms = 4000ms (3400ms tool gap excluded) → 400 / 4s
    expect(s.tokPerSec).toBe(100);
    expect(s.ttftMs).toBe(500);
  });

  // 6. Zero-duration / single-token text part (start === end despite output):
  //    dropped so it never produces Infinity/NaN. If a valid part exists, the
  //    rate is computed from it alone; if it's the only part, rate is null.
  it("drops zero-duration text parts instead of dividing by ~0", () => {
    const withValid = mk(
      [
        { id: "z", type: "text", text: "x", time: { start: 1_000_500, end: 1_000_500 } },
        { id: "v", type: "text", text: "y", time: { start: 1_001_000, end: 1_003_000 } },
      ],
      { time: { created: 1_000_000, completed: 1_005_000 }, tokens: { output: 200 } },
    );
    const s = turnStats(withValid)!;
    expect(Number.isFinite(s.tokPerSec)).toBe(true);
    expect(s.tokPerSec).toBe(100); // only the 2000ms valid part counts

    const onlyZero = mk(
      [{ id: "z", type: "text", text: "x", time: { start: 1_000_500, end: 1_000_500 } }],
      { time: { created: 1_000_000, completed: 1_005_000 }, tokens: { output: 200 } },
    );
    expect(turnStats(onlyZero)!.tokPerSec).toBeNull(); // fail closed, no Infinity
  });

  // 7. Missing end (in-flight/aborted text part): decode not finalized → no rate,
  //    even though completed/created exist.
  it("suppresses tok/s when a text part has start but no end", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi", time: { start: 1_000_500 } }],
      { time: { created: 1_000_000, completed: 1_010_000 }, tokens: { output: 200 } },
    );
    const s = turnStats(m)!;
    expect(s.tokPerSec).toBeNull();
    expect(s.ttftMs).toBe(500); // TTFT still available
  });

  // 8. No text part at all (turn was only tool calls): fail closed → no rate.
  it("returns null tok/s when there is no text part", () => {
    const m = mk(
      [
        { id: "t1", type: "tool", tool: "bash", state: { time: { start: 1_000_500, end: 1_004_000 } } },
      ],
      { time: { created: 1_000_000, completed: 1_005_000 }, tokens: { output: 200 } },
    );
    const s = turnStats(m)!;
    expect(s.tokPerSec).toBeNull();
    expect(s.ttftMs).toBeNull();
  });

  // 9. Anthropic numerator caveat (informational): for providers that don't
  //    break out reasoning, wire tokens.output is reasoning-INCLUSIVE, so the
  //    rate is overstated relative to true visible output. This is a numerator
  //    problem only — the DENOMINATOR is still the pure text decode window, and
  //    the rate is computed normally. Not fixable from the wire alone.
  it("computes rate from text intervals even when output is reasoning-inclusive (Anthropic)", () => {
    // Anthropic-like: reasoning 150 tokens NOT subtracted from output(400).
    const m = mk(
      [
        { id: "r1", type: "reasoning", text: "thinking", time: { start: 1_000_300, end: 1_003_300 } },
        { id: "x1", type: "text", text: "hi", time: { start: 1_003_400, end: 1_005_400 } },
      ],
      { time: { created: 1_000_000, completed: 1_006_000 }, tokens: { output: 400 } },
    );
    const s = turnStats(m)!;
    // denominator = text 2000ms (reasoning 3000ms excluded); numerator 400 is
    // reasoning-inclusive → 400 / 2s = 200 tok/s, overstated vs true visible.
    expect(s.tokPerSec).toBe(200);
    expect(s.output).toBe(400);
  });

  // --- Preserved TTFT / guard behavior ---

  it("returns null when the turn is not completed (no time.completed)", () => {
    const m = mk([{ id: "p1", type: "text", text: "hi", time: { start: 5 } }], {
      time: { created: 1 },
    });
    expect(turnStats(m)).toBeNull();
  });

  it("derives TTFT from a reasoning part when no text part is present (tok/s null)", () => {
    const m = mk(
      [{ id: "p1", type: "reasoning", text: "thinking", time: { start: 1_000_300, end: 1_002_000 } }],
      { time: { created: 1_000_000, completed: 1_006_000 }, tokens: { output: 60 } },
    );
    const s = turnStats(m)!;
    expect(s.ttftMs).toBe(300);
    expect(s.tokPerSec).toBeNull(); // no text part → no decode interval
  });

  it("ignores tool parts when finding the earliest text/reasoning start", () => {
    const m = mk(
      [
        { id: "t1", type: "tool", tool: "bash", state: { time: { start: 1_000_100 } } },
        { id: "r1", type: "reasoning", text: "hmm", time: { start: 1_000_250 } },
        { id: "x1", type: "text", text: "hi", time: { start: 1_000_500, end: 1_001_500 } },
      ],
      { time: { created: 1_000_000, completed: 1_009_000 }, tokens: { output: 90 } },
    );
    const s = turnStats(m)!;
    expect(s.ttftMs).toBe(250); // reasoning (250), not tool (100) or text (500)
  });

  it("clamps TTFT to 0 when the earliest part start precedes info.time.created (clock skew)", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi", time: { start: 999_900, end: 1_001_900 } }],
      { time: { created: 1_000_000, completed: 1_005_000 }, tokens: { output: 100 } },
    );
    const s = turnStats(m)!;
    expect(s.ttftMs).toBe(0); // clamped, not −100 and not null
    // tok/s still derived from the 2000ms text decode window
    expect(s.tokPerSec).toBe(50); // 100 / 2s
  });

  it("returns null for a user message", () => {
    const m = mk([], { role: "user", time: { created: 1, completed: 2 } });
    expect(turnStats(m)).toBeNull();
  });

  it("skips tok/s when output tokens are missing or non-positive (TTFT still shown)", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi", time: { start: 1_000_500, end: 1_002_500 } }],
      { time: { created: 1_000_000, completed: 1_010_000 }, tokens: { output: 0 } },
    );
    const s = turnStats(m)!;
    expect(s.tokPerSec).toBeNull();
    expect(s.ttftMs).toBe(500);
  });

  it("returns null tok/s when a text part carries no time bounds at all", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi" }],
      { time: { created: 1_000_000, completed: 1_005_000 }, tokens: { output: 100 } },
    );
    const s = turnStats(m)!;
    expect(s.tokPerSec).toBeNull(); // no decode interval available
    expect(s.ttftMs).toBeNull();
  });
});

describe("fmtTurnStats", () => {
  it("formats both values joined by a middot (ms under 1s)", () => {
    expect(fmtTurnStats({ tokPerSec: 42.3, ttftMs: 380, output: 500 })).toBe(
      "42.3 tok/s · 380ms TTFT",
    );
  });
  it("formats TTFT in seconds past 1s", () => {
    expect(fmtTurnStats({ tokPerSec: 5, ttftMs: 1234, output: 10 })).toBe(
      "5.0 tok/s · 1.23s TTFT",
    );
  });
  it("returns empty when neither value is present", () => {
    expect(fmtTurnStats({ tokPerSec: null, ttftMs: null, output: 0 })).toBe("");
  });
  it("renders TTFT alone when tok/s is absent", () => {
    expect(fmtTurnStats({ tokPerSec: null, ttftMs: 712, output: 0 })).toBe("712ms TTFT");
  });
});
