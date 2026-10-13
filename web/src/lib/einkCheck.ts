// Requested E Ink display-signal check — a PURE helper. It inspects display
// media features through an INJECTED matchMedia-like function (no window /
// document / navigator access of its own) and returns a results object; the
// only caller is the Settings dialog's explicit "Check display signals"
// click. Contract (mirrors the e-ink profile's manual-first design):
//
//   - clues, never identification: positive results are phrased as
//     "compatible with" an e-ink panel; nothing claims the device IS one;
//   - no auto-activation: the result never touches the einkProfile pref —
//     positive clues may at most justify surfacing an Enable button whose
//     click is a separate, explicit user action;
//   - failure-tolerant: an absent, null-returning, or throwing matchMedia
//     degrades to a neutral "unavailable" result, and manual enablement
//     stays available regardless of the outcome;
//   - display media features only — no UA string or client-hint reads of
//     any kind.

/** Minimal matchMedia shape the check needs (structural, for testability). */
export type MatchMediaLike = (query: string) => { matches: boolean } | null | undefined;

export interface EinkSignal {
  /** The media query that was evaluated. */
  query: string;
  /** What the display reported for it. */
  matches: boolean;
}

export interface EinkCheckResult {
  /**
   * "ok" — every query was evaluated; "unavailable" — the environment cannot
   * answer (no / throwing / null-returning matchMedia).
   */
  status: "ok" | "unavailable";
  /** Per-query outcomes (empty when unavailable). */
  signals: EinkSignal[];
  /** Clue sentences for the POSITIVE e-ink-compatible signals only. */
  clues: string[];
  /**
   * Overall clue-framed sentence. Never identification; manual enablement is
   * offered in the negative and unavailable outcomes.
   */
  summary: string;
  /**
   * True when at least one positive clue was reported — callers may use this
   * to surface an EXPLICIT Enable affordance. Never a mandate.
   */
  suggests: boolean;
}

// Queries whose POSITIVE match is an e-ink-compatible clue. `(update: slow)`
// = output changes slowly; `(update: none)` = output does not change after
// rendering (paper-like); `(monochrome)` = a nonzero monochrome framebuffer
// depth. None of these IDENTIFIES an e-ink panel — they are reported as
// compatibility clues only.
const CLUE_CHECKS: { query: string; clue: string }[] = [
  {
    query: "(update: slow)",
    clue: "Your display reports slow updates — this is compatible with an e-ink panel.",
  },
  {
    query: "(update: none)",
    clue:
      "Your display reports output that does not update after rendering — this is compatible with e-ink-style paper output.",
  },
  {
    query: "(monochrome)",
    clue: "Your display reports a monochrome framebuffer — this is compatible with an e-ink panel.",
  },
];

// Companion queries: useful context for the summary, but their matches are
// the ORDINARY-display case and never produce clues. `(update: fast)` is a
// normally-updating display; `(monochrome: 0)` is a color framebuffer.
const COMPANION_CHECKS: string[] = ["(update: fast)", "(monochrome: 0)"];

const UNAVAILABLE_SUMMARY =
  "Display signals are unavailable in this browser — you can still enable E Ink mode manually.";

function unavailable(): EinkCheckResult {
  return { status: "unavailable", signals: [], clues: [], summary: UNAVAILABLE_SUMMARY, suggests: false };
}

export function runEinkDisplayCheck(matchMediaLike: MatchMediaLike | null | undefined): EinkCheckResult {
  if (typeof matchMediaLike !== "function") return unavailable();
  const signals: EinkSignal[] = [];
  const clues: string[] = [];
  try {
    for (const c of CLUE_CHECKS) {
      const m = matchMediaLike(c.query);
      if (!m) return unavailable();
      signals.push({ query: c.query, matches: !!m.matches });
      if (m.matches) clues.push(c.clue);
    }
    for (const q of COMPANION_CHECKS) {
      const m = matchMediaLike(q);
      if (!m) return unavailable();
      signals.push({ query: q, matches: !!m.matches });
    }
  } catch {
    // A matchMedia that throws (unsupported feature, unparsed query,
    // sandboxed environment) cannot answer honestly — report unavailable,
    // never guess.
    return unavailable();
  }
  if (clues.length > 0) {
    const n = clues.length;
    const summary =
      `${n === 1 ? "One" : n} of the checked display signals ${n === 1 ? "is" : "are"} compatible with an e-ink panel. ` +
      "Clues only — enabling E Ink mode is always up to you.";
    return { status: "ok", signals, clues, summary, suggests: true };
  }
  // Negative outcome: fold in the ordinary-display context the companions
  // carry, without ever phrasing it as identification.
  const ctx: string[] = [];
  if (signals.some((s) => s.query === "(update: fast)" && s.matches)) ctx.push("fast updates");
  if (signals.some((s) => s.query === "(monochrome: 0)" && s.matches)) ctx.push("a color framebuffer");
  const note = ctx.length > 0 ? ` (${ctx.join(" and ")} reported)` : "";
  const summary = `No e-ink signals reported by this display${note} — you can still enable E Ink mode manually.`;
  return { status: "ok", signals, clues, summary, suggests: false };
}
