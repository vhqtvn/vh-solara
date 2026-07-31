# 2026-07-31 — Resolve-First DEFER-Processing Skill Design Sign-Off

## Decision

Operator **SIGNED OFF** the `resolve-first` DEFER-processing skill design,
accepted **AS-IS, no overrides**. All forks resolved; the design holds.

- **Finalized brief:** `tmp/agent-runs/defer-skill-design-improve/resolve-first-defer-skill-design.md`
  (1090 lines, 14 sections).
- **Path note:** this brief path is gitignored/disposable. It is the **spec**
  that informs a **SEPARATE-REPO handoff** — the skill will be built as a
  vh-agent-harness S1 overlay under
  `.vh-agent-harness/overlays/resolve-first-pilot/` (separate repo), NOT in
  this repo.
- **Optional follow-up (flagged, not done this session):** promotion of the
  brief into `researches/decisions/` for durable preservation is an
  operator follow-up. It was not performed this session.

## What holds (design summary)

- **Resolve-now default** + **Step-0 premise-verify** + **3-gate combiner**
  (4-field rubric behind it).
- **The load-bearing split:** adequate-evidence + value<total-cost =
  legitimate `won't-do`; tradeoff-unclear = bounded decision work NOW
  (never a stealth `won't-do`).
- **6 dispositions** (factual-drop / resolve-now / decide-to-verdict incl.
  won't-do+collect-named-fact / defer-with-trigger [4 hardened tags] /
  S2-hold / decay-close), with heavier-than-resolution proof obligations on
  the parking dispositions.
- **Comparison rubric** (9 axes A0–A9, combiner-first lexicographic
  tiebreaker); anti-gaming proof; scoreboard = source-separated
  disposition ledger (read-pattern, INFORMS-only, no new helper).
- **Fork #1 (trigger grammar)** = option (c): unsupported watches are
  invalid defers; silent-drop blind spot sealed by **F1**
  (scope/future-eligibility honesty), **F2** (required watch-loss
  acknowledgment with 3 closure outcomes), **F3**
  (collect-named-fact/operator-request escape hatch closed).
- **Fork #2 (checker recency)** = verified no drift (card split 19 met /
  21 not-met / 29 no-trigger-line; changed-paths transiently 280→281 due
  to concurrent dirty tree, environmental).
- **§14 data-vs-judgment separation holds.**

## Confirmed adjudications (accepted defaults)

1. **External-advisory monitoring is NOT a retained DEFER** (full won't-do /
   relocate to existing mechanism with receipt / separate scoped proposal).
2. **Firefox visual sign-off = operator-owned release-policy question, NOT
   an enforceable deferred gate.**
3. **Receipt = mandatory procedural review artifact** (checker can't
   enforce; skill requires it).

## Confirmed-live evidence correction (operator-confirmed)

- **Fork #1 `||` finding is LIVE and worse than initially recorded.** The
  greedy `path_touched` regex swallows `||` into a garbage path arg → that
  arg is evaluated as `not-touched-since-ref` (met:false because the garbage
  path is not in the diff) — **NOT** reported as `unknown-predicate`.
- The in-code comment at `check-defer-triggers.js:269-270` **FALSELY claims**
  unrecognized predicates report `unknown-predicate`. This
  comment-vs-behavior contradiction is being filed to vh-agent-harness as a
  **SEPARATE checker bug.**
- **Design unaffected:** option (c) routes around it (unsupported watches
  are rejected regardless of how `||` mis-parses). The brief's §2 grounding
  was refined this session so the evidence record matches the code.

## Routing note

The overlay-pack build (`.vh-agent-harness/overlays/resolve-first-pilot/`)
is a **harness-side handoff in a SEPARATE repo.** NO skill, overlay, helper,
or `researches/` artifact was authored in this repo this session. The brief
is the spec that informs that handoff.

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Brief §2 precision edit landed (greedy-regex / not-touched-since-ref / 269-270 comment note all present in §2) | `grep` for `check-defer-triggers.js:269-270`, `greedy \`path_touched`, `swallows \|\| and everything` → all resolve to line 101 (§2 observer row), none in §9/§10/§12 | yes |
| Checkpoint created | `ls docs/checkpoints/2026-07-31-resolve-first-defer-skill-design-signoff.md` | yes |
| No skill/overlay/researches authored | `git status --short` shows only this new checkpoint; brief is gitignored (not shown); concurrent dirty tree untouched vs baseline | yes |

## Findings

- **design complete**: source=operator sign-off, confidence=high, type=fact
