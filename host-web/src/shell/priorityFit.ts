// Priority-fit membership logic for the workspace tabstrip (pure, no DOM).
//
// The strip shows as many workspace tabs as FIT the available width, choosing
// the visible set by ATTENTION priority rather than truncation order:
//
//   active → needs-you → unread → running → prev-active (one-slot recency) →
//   remaining; ties by canonical index, never count magnitude.
//
// Priority selects MEMBERSHIP only. The rendered row always stays in CANONICAL
// workspace order (store order) — priority never reshuffles what is visible,
// it only decides WHO is visible. Design decisions D1/D4 (operator-approved
// 2026-09-29): one-slot recency with no timers, and honest saturation (when
// nothing more fits, the overflow list holds the rest).
//
// Deterministic by construction: same inputs → same outputs, no clocks, no
// randomness, no DOM reads. Widths arrive pre-measured (the hidden measuring
// row in Tabstrip.tsx); host-web has NO UI zoom, so all values are plain px.

/** Membership priority tiers, lower number = higher priority. */
export const TIER = {
  /** The active workspace — always visible (the load-bearing invariant). */
  ACTIVE: 0,
  /** Any pane needs the operator (needs_permission / needs_reply). */
  NEEDS_YOU: 1,
  /** Any pane has unread output. */
  UNREAD: 2,
  /** Any pane is running. */
  RUNNING: 3,
  /** The workspace that was active immediately before the current one
   *  (one-slot recency, D1 — no timers, no recency grace). */
  PREV_ACTIVE: 4,
  /** Everything else — quiet workspaces, ordered by canonical index. */
  REMAINING: 5,
} as const;

export type PriorityTier = (typeof TIER)[keyof typeof TIER];

/** The per-workspace inputs `priorityTier` decides from. `needsYou` /
 *  `running` / `unread` are counts, but ONLY their nonzero-ness matters
 *  (any-pane-nonzero): magnitude is NEVER a tie-breaker (D4). */
export interface PriorityCandidate {
  /** Workspace id. */
  id: string;
  /** Canonical index (workspaces() order) — the tie-breaker within a tier. */
  index: number;
  /** True iff this is the active workspace. */
  active: boolean;
  /** True iff this is the one-slot prev-active workspace. */
  prevActive: boolean;
  /** needs-you session count (needsYouCountFor). */
  needsYou: number;
  /** Summed running count across panes (statusPairsFor); only >0 matters. */
  running: number;
  /** Summed unread count across panes (statusPairsFor); only >0 matters. */
  unread: number;
}

/** The tier of one workspace. Pure, total, deterministic. */
export function priorityTier(c: PriorityCandidate): PriorityTier {
  if (c.active) return TIER.ACTIVE;
  if (c.needsYou > 0) return TIER.NEEDS_YOU;
  if (c.unread > 0) return TIER.UNREAD;
  if (c.running > 0) return TIER.RUNNING;
  if (c.prevActive) return TIER.PREV_ACTIVE;
  return TIER.REMAINING;
}

/** Rank candidates by (tier asc, canonical index asc). Returns a new array;
 *  the input is untouched. The first entry is the ACTIVE workspace whenever
 *  one is present (unique tier-0). */
export function rankByPriority(candidates: PriorityCandidate[]): PriorityCandidate[] {
  return candidates.slice().sort((a, b) => {
    const ta = priorityTier(a);
    const tb = priorityTier(b);
    if (ta !== tb) return ta - tb;
    return a.index - b.index;
  });
}

/** A width-tagged id in RANKED order (rankByPriority output mapped through
 *  the measuring row's numbers). Width <= 0 means "not measured yet". */
export interface FitCandidate {
  id: string;
  width: number;
}

export interface FitOptions {
  /** The tabs container's clientWidth in px (plain layout px — no zoom). */
  available: number;
  /** Horizontal gap between adjacent tabs (px). */
  gap: number;
  /** Width to reserve for the "⋯" overflow trigger whenever anything would
   *  be hidden (trigger + cue badge + strip gap). */
  overflowReserve: number;
}

export interface FitResult {
  /** Visible ids, in RANKED (priority) order — the caller renders them in
   *  CANONICAL order regardless. */
  visible: string[];
  /** Hidden ids (overflow list members), in ranked order. */
  hidden: string[];
}

/**
 * Decide which ranked candidates fit `available` width. Greedy walk in
 * priority order:
 *  - the FIRST ranked candidate (the active workspace, by construction) is
 *    ALWAYS visible, even if it alone exceeds the budget — "active always
 *    visible" outranks fit;
 *  - every further candidate is taken iff its (width + gap) fits the
 *    remaining budget; otherwise it goes to overflow WHOLE (a tab is never
 *    truncated or squeezed) and the walk CONTINUES — a lower-ranked, smaller
 *    tab may still fit after an oversized one spilled (D4);
 *  - when anything is hidden, the budget is `available - overflowReserve`
 *    (room for the "⋯" trigger).
 *
 * Measurement-pending fallback: a non-positive `available` or any unknown
 * (<=0) width returns everything visible — the strip's pre-measure render is
 * all-tabs, exactly like the reference pattern (web TabBar).
 */
export function computeFits(ranked: FitCandidate[], opts: FitOptions): FitResult {
  const n = ranked.length;
  if (n === 0) return { visible: [], hidden: [] };
  const measured = ranked.every((c) => Number.isFinite(c.width) && c.width > 0);
  if (!(opts.available > 0) || !measured) {
    return { visible: ranked.map((c) => c.id), hidden: [] };
  }
  const totalGap = opts.gap * (n - 1);
  const totalWidth = ranked.reduce((sum, c) => sum + c.width, 0);
  if (totalWidth + totalGap <= opts.available) {
    return { visible: ranked.map((c) => c.id), hidden: [] };
  }
  const budget = Math.max(opts.available - opts.overflowReserve, 0);
  const visible: string[] = [];
  const hidden: string[] = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    const c = ranked[i];
    const cost = c.width + (visible.length > 0 ? opts.gap : 0);
    if (i === 0 || used + cost <= budget) {
      visible.push(c.id);
      used += cost;
    } else {
      hidden.push(c.id);
    }
  }
  return { visible, hidden };
}
