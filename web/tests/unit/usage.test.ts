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
  it("returns tok/s and TTFT for a completed turn with output tokens + text part start", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi", time: { start: 1_000_500 } }],
      { time: { created: 1_000_000, completed: 1_010_000 }, tokens: { output: 500 } },
    );
    // duration = 10s → 500/10 = 50 tok/s; ttft = 1_000_500 − 1_000_000 = 500ms
    const s = turnStats(m)!;
    expect(s.tokPerSec).toBe(50);
    expect(s.ttftMs).toBe(500);
    expect(s.output).toBe(500);
  });

  it("returns tok/s only when text/reasoning parts lack time.start", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi" }],
      { time: { created: 1_000_000, completed: 1_005_000 }, tokens: { output: 100 } },
    );
    const s = turnStats(m)!;
    expect(s.tokPerSec).toBeCloseTo(20, 5); // 100 / 5s
    expect(s.ttftMs).toBeNull();
  });

  it("returns null when the turn is not completed (missing duration)", () => {
    const m = mk([{ id: "p1", type: "text", text: "hi", time: { start: 5 } }], {
      time: { created: 1 },
    });
    expect(turnStats(m)).toBeNull();
  });

  it("derives TTFT from a reasoning part when no text part is present", () => {
    const m = mk(
      [{ id: "p1", type: "reasoning", text: "thinking", time: { start: 1_000_300 } }],
      { time: { created: 1_000_000, completed: 1_006_000 }, tokens: { output: 60 } },
    );
    const s = turnStats(m)!;
    expect(s.ttftMs).toBe(300);
    expect(s.tokPerSec).toBeCloseTo(10, 5); // 60 / 6s
  });

  it("ignores tool parts when finding the earliest text/reasoning start", () => {
    const m = mk(
      [
        { id: "t1", type: "tool", time: { start: 1_000_100 } },
        { id: "r1", type: "reasoning", time: { start: 1_000_250 } },
        { id: "x1", type: "text", text: "hi", time: { start: 1_000_500 } },
      ],
      { time: { created: 1_000_000, completed: 1_009_000 }, tokens: { output: 90 } },
    );
    const s = turnStats(m)!;
    expect(s.ttftMs).toBe(250); // reasoning (250), not tool (100) or text (500)
  });

  it("returns null for a user message", () => {
    const m = mk([], { role: "user", time: { created: 1, completed: 2 } });
    expect(turnStats(m)).toBeNull();
  });

  it("skips tok/s when output tokens are missing or non-positive (TTFT still shown)", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi", time: { start: 1_000_500 } }],
      { time: { created: 1_000_000, completed: 1_010_000 }, tokens: { output: 0 } },
    );
    const s = turnStats(m)!;
    expect(s.tokPerSec).toBeNull();
    expect(s.ttftMs).toBe(500);
  });

  it("skips tok/s when duration is non-positive", () => {
    const m = mk(
      [{ id: "p1", type: "text", text: "hi", time: { start: 1_000_500 } }],
      { time: { created: 1_000_000, completed: 1_000_000 }, tokens: { output: 50 } },
    );
    const s = turnStats(m)!;
    expect(s.tokPerSec).toBeNull();
    expect(s.ttftMs).toBe(500);
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
