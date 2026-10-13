// einkCheck — pure-helper unit tests (node env: the module has no DOM
// coupling, so importing it here WITHOUT the jsdom opt-in is itself the
// purity proof). Covers the requested-diagnostics contract:
//   - positive / negative / absent / throwing matchMedia outcomes;
//   - companion queries ((update: fast), (monochrome: 0)) never clue — they
//     are ordinary-display context for the summary only;
//   - copy framing: clues ("compatible with"), never identification; manual
//     enablement is offered in the negative and unavailable outcomes.
import { describe, expect, it } from "vitest";
import { runEinkDisplayCheck, type EinkCheckResult, type MatchMediaLike } from "../../src/lib/einkCheck";

const mm = (map: Record<string, boolean>): MatchMediaLike => (q) => ({ matches: !!map[q] });

const ALL_QUERIES = [
  "(update: slow)",
  "(update: none)",
  "(monochrome)",
  "(update: fast)",
  "(monochrome: 0)",
];

describe("runEinkDisplayCheck — outcomes", () => {
  it("positive: (update: slow) + (monochrome) → 2 clues, suggests=true, clue-framed summary", () => {
    const r = runEinkDisplayCheck(mm({ "(update: slow)": true, "(monochrome)": true }));
    expect(r.status).toBe("ok");
    expect(r.suggests).toBe(true);
    expect(r.clues).toHaveLength(2);
    for (const c of r.clues) expect(c).toContain("compatible with");
    expect(r.summary).toContain("2 of the checked display signals are compatible with an e-ink panel");
    expect(r.summary).toContain("up to you");
    // All five queries were consulted — companions included, as context.
    expect(r.signals.map((s) => s.query)).toEqual(ALL_QUERIES);
  });

  it("positive: (update: none) alone is a clue (paper-like output)", () => {
    const r = runEinkDisplayCheck(mm({ "(update: none)": true }));
    expect(r.status).toBe("ok");
    expect(r.suggests).toBe(true);
    expect(r.clues).toHaveLength(1);
    expect(r.clues[0]).toContain("does not update after rendering");
    expect(r.summary).toContain("One of the checked display signals is compatible with an e-ink panel");
  });

  it("negative: all queries false → no clues, suggests=false, neutral summary offering manual enablement", () => {
    const r = runEinkDisplayCheck(mm({}));
    expect(r.status).toBe("ok");
    expect(r.suggests).toBe(false);
    expect(r.clues).toHaveLength(0);
    expect(r.summary).toContain("No e-ink signals reported");
    expect(r.summary).toContain("enable E Ink mode manually");
  });

  it("companions ((update: fast), (monochrome: 0)) are summary context only — they NEVER produce clues", () => {
    const r = runEinkDisplayCheck(mm({ "(update: fast)": true, "(monochrome: 0)": true }));
    expect(r.status).toBe("ok");
    expect(r.suggests).toBe(false);
    expect(r.clues).toHaveLength(0);
    expect(r.summary).toContain("No e-ink signals reported");
    // The ordinary-display context is folded into the summary…
    expect(r.summary).toContain("fast updates");
    expect(r.summary).toContain("a color framebuffer");
    // …and manual enablement is still offered.
    expect(r.summary).toContain("enable E Ink mode manually");
  });

  it("absent matchMedia (null / undefined) → unavailable, manual copy, suggests=false", () => {
    for (const absent of [null, undefined]) {
      const r = runEinkDisplayCheck(absent as null | undefined);
      expect(r.status).toBe("unavailable");
      expect(r.signals).toHaveLength(0);
      expect(r.clues).toHaveLength(0);
      expect(r.suggests).toBe(false);
      expect(r.summary).toContain("unavailable");
      expect(r.summary).toContain("enable E Ink mode manually");
    }
  });

  it("throwing matchMedia → graceful unavailable, no crash", () => {
    const r = runEinkDisplayCheck(() => {
      throw new Error("matchMedia is not defined here");
    });
    expect(r.status).toBe("unavailable");
    expect(r.suggests).toBe(false);
    expect(r.summary).toContain("enable E Ink mode manually");
  });

  it("null-returning matchMedia (broken mid-run) → unavailable", () => {
    let call = 0;
    const r = runEinkDisplayCheck(() => {
      call++;
      if (call === 1) return { matches: true };
      return null; // answers once, then breaks
    });
    expect(r.status).toBe("unavailable");
    expect(r.signals).toHaveLength(0); // partial results are discarded, not guessed from
    expect(r.suggests).toBe(false);
  });
});

describe("runEinkDisplayCheck — copy framing (clues, never identification)", () => {
  // Every outcome the helper can produce, including mixed ones.
  const results: EinkCheckResult[] = [
    runEinkDisplayCheck(mm({ "(update: slow)": true, "(update: none)": true, "(monochrome)": true })),
    runEinkDisplayCheck(mm({ "(monochrome)": true })),
    runEinkDisplayCheck(mm({})),
    runEinkDisplayCheck(mm({ "(update: fast)": true, "(monochrome: 0)": true })),
    runEinkDisplayCheck(null),
    runEinkDisplayCheck(() => {
      throw new Error("boom");
    }),
  ];
  const strings = () => results.flatMap((r) => [r.summary, ...r.clues]);

  it("no string ever claims the device IS e-ink or uses detect/identify wording", () => {
    for (const s of strings()) {
      expect(s).not.toMatch(/\bis an? e-?ink/i);
      expect(s).not.toMatch(/\b(detect|identif)\w*/i);
    }
  });

  it("every positive clue is 'compatible with' phrased; every result mentions enabling as the user's choice or manual option", () => {
    for (const r of results) {
      for (const c of r.clues) expect(c).toContain("compatible with");
    }
    // Positive outcomes leave enabling to the user…
    expect(results[0].summary).toContain("up to you");
    // …negative and unavailable outcomes keep the manual path explicit.
    expect(results[2].summary).toContain("enable E Ink mode manually");
    expect(results[4].summary).toContain("enable E Ink mode manually");
    expect(results[5].summary).toContain("enable E Ink mode manually");
  });

  it("suggests is true only when a positive clue exists", () => {
    expect(results.map((r) => r.suggests)).toEqual([true, true, false, false, false, false]);
  });
});
