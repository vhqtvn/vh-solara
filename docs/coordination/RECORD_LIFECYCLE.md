# Record Lifecycle (card / DEFER)

> **Term contract.** "Agent harness" is a **HANDLE ONLY**. This doc carries the
> **Coordination** layer (routing/tracking/handoff of work).

This is the canonical lifecycle for **transport cards** — work tracked under
`.local/coordinator/tasks/` (implementation, study, research, DEFER,
p2-followup). It codifies six rules so the holding area stays a **drain**, not
a reservoir:

1. **Drain flow.** Work cards directly from transport. No backlog row is
   created before or after by default.
2. **Promotion is exceptional.** A card gets a `docs/planning/backlog.md` row
   ONLY when it crosses a named boundary (below). Backlog is a status ledger,
   not a record store.
3. **Retire timing is landing-gated.** A `completed` card is deleted only AFTER
   the commit-gate confirms the work landed. Never on review approval alone.
4. **Done cards are deleted.** A `completed` card lingering in transport
   corrupts the count signal; the lifecycle retires it, not parks it.
5. **The landing commit is the durable record.** The reachable commit carrying
   the card id is the record. Checkpoints are reserved for campaign closeouts
   or reopenable decisions. No tombstones, no done-rows.
6. **Intake has a bar.** Drain rules do not stop re-growth. A card is filed only
   after admission (resolve-first / admitted-value), not on every surfaced
   finding.

The holding area is **transport, not truth**. Unpromoted and unretired cards
may be lost — that is intentional, because they are not trusted work yet. Do
not create a parallel committed ledger for them.

## The lifecycle

```
intake (admission bar)
   │   resolve-first / admitted-value BEFORE filing
   ▼
transport work   (.local/coordinator/tasks/, status: draft → ready → working)
   │
   ├── boundary? (blocked / owner-change / must-survive-session)
   │     YES → promote ONE backlog row (exceptional side path)
   │     NO  → keep draining in transport
   ▼
review           (commit-reviewer, separate predicate from landing)
   ▼
landing          (commit-gate commits; commit carries `Task-Card: <card-id>`)
   ▼
retirement       (card deleted AFTER landing confirmed reachable)
```

### Intake (admission bar)

A card is filed only when it passes admission. Before filing, answer:

- **Precise question** — the work can be stated as a sharp question now (fog is
  NOT a ticket; see the fog-vs-ticket test below).
- **Concrete area + file/subsystem scope** — names the repo boundary and the
  files it concerns.
- **Validation approach** — how "done" will be checked.
- **An ADMITTED BLOCKER or reason the work cannot be resolved now** — for
  deferred work, the reason it cannot be done in the current session.
- **A ground-truth-derivable trigger** — when deferral is trigger-dependent, a
  predicate the checker can re-derive from repo state
  (`path_touched(<path>)`, `after_tag(<tag>)`, …).
- **Provenance** — where the candidate came from (`source:review-defer`,
  `source:p2-followup`, …).
- **Dedup** — no materially-equivalent open card already exists.

Disposition at intake (apply the `resolve-first` classifier):

- **Resolvable now** → resolve it; do NOT file.
- **Decision-derivable now** → drive to a verdict; do NOT defer.
- **Real deferred work meeting the bar** → file as a `draft` transport card.
- **Duplicate / fog** → collapse into the existing card, or discard.

### Fog vs ticket (triage test)

A finding is **ticket-ready** when you can state the question precisely now —
even if blocked. A finding is **fog** when you cannot yet phrase it that
sharply: in-scope, but not yet specifiable. Fog belongs in transport only while
it sharpens; it is promoted or retired, never left to accumulate as noise.

## Promotion (exceptional side path)

The default is to drain resolved transport directly. A card is promoted into a
`docs/planning/backlog.md` row ONLY when it crosses one of these boundaries:

- **Blocked** — the card cannot progress without an external decision or owner
  input, so its blocked state must outlive the session that discovered it.
- **Owner-change** — responsibility moves to another session/operator, so the
  row is the handoff artifact.
- **Must-survive-session** — the work is longer than one session and the
  durable status ledger (not the transport card) is the right home for its
  state.

A promoted row carries the card's stable ID in its Notes so the join is
auditable. Promotion does NOT retire the transport card — the card is retired
on landing (below), not on promotion. Conflict discipline for promoted rows
(re-read + re-apply + retry on `could_not_land`, never blind-revert) lives in
the `backlog` skill and the `PROMOTER_RUNBOOK`.

Backlog is a **status ledger**, not a record store: a promoted row tracks live
status, not a durable history of completed work. The durable record is the
landing commit.

## Review approval and landing are DISTINCT predicates

- **Review approval** — `commit-reviewer` returned `approve` for the slice.
  This means the change is acceptable to commit. It does NOT mean the change
  landed.
- **Landing** — the commit-gate committed the slice and the resulting commit is
  reachable from a branch (any local branch tip — see the landing-proof
  contract below).

A card is retired as `done` only on **landing**, never on review approval
alone. The 2026-08-07 lesson: a card was deleted on review approval alone and
the commit later failed to land, so the work was lost from the record while the
gate reported failure. Review approval is necessary but not sufficient.

## The landing-proof contract

A `completed` card may be retired as done ONLY when a commit carrying the exact
`Task-Card: <card-id>` trailer line is reachable from a branch. The verifier is
a **reachability** check (per the closure-verifier reachability rule — never
object existence):

```
git log --branches --fixed-strings --grep=Task-Card: <card-id>
```

The `--grep` is a substring pre-filter; the verifier then post-filters each
candidate commit's body to a line EXACTLY equal to `Task-Card: <card-id>` (a
`Task-Card: alpha-next` line does NOT satisfy card `alpha`). ≥1 exact, reachable
match means the work landed and the card may be retired. 0 matches means the
work has NOT landed; the card MUST NOT be retired (it stays `completed`, and if
the commit failed it is re-driven).

- **Branch scope.** `--branches` walks ALL local branch tips (`refs/heads/*`)
  — branch-GENERIC with no hardcoded `main` (mirrors doctor #24's
  `git rev-list --branches`); a match proves BOTH landing AND reachability in
  one query. The choice is deliberately broader than a single integration
  branch: it avoids bricking retirement on a stale/wrong gate-reported branch
  name, and a card is local transport (gitignored), so a premature retire is a
  local self-footgun, not a system-integrity breach. The singular `<branch>`
  notation used in earlier drafts is realized branch-generically by `--branches`.
- **Exact trailer line.** A commit body carries one `Task-Card: <card-id>`
  line per card the commit satisfies. The verifier matches the line exactly
  (trimmed equality), not as a substring — prefix collisions (`alpha` vs
  `alpha-next`) do not authorize the shorter id.
- **Committer is pass-through.** The committer agent does not rewrite the
  commit message, so the trailer MUST originate in the `commit-message` draft
  — it cannot be gate-appended today.
- **Future hardening (NOT v1).** A gate-appended trailer and a gate-ledger
  card-id→commit join are documented future-hardening, not the v1 contract.

### Legacy

The landing-proof requirement applies to **new cards filed after codification**.
Pre-existing cards in transport at codification time are grandfathered (retired
under the prior convention); once the Slice-2 retirement CODE lands, all
`completed` retirements are landing-gated regardless of filing date.

## Records

The **landing commit** (carrying the card id via the `Task-Card:` trailer) is
the durable record of completed work. There are:

- **No tombstones** — retiring a transport card leaves no marker card behind;
  the reachable commit is the record.
- **No done-rows by default** — a drained card is not transcribed into a
  backlog `Done` row. Only cards that crossed the promotion boundary have a
  backlog history row (and the normalizer archives those).
- **Checkpoints only for campaign closeouts / reopenable decisions** — a single
  card's completion is recorded by its landing commit, not a checkpoint. A
  checkpoint is written when a decision, blocker, or campaign closeout is worth
  reopening later.

## What this does NOT change

- `docs/planning/backlog.md` remains the canonical task-status ledger; its
  format, normalizer, and split-commit discipline are unchanged.
- `commit-reviewer` DEFER findings remain non-blocking; the intake bar governs
  whether a DEFER finding becomes a transport card, not whether it blocks.
- The operator escape hatch and the gated-commit protocol are unchanged.
- `/task-delete <id>` remains the sanctioned single-card retire wrapper for
  `draft`/`ready`/`cancelled` cards. For `completed` cards, retirement is
  landing-gated: the sanctioned op enforces the reachability check, so a direct
  `rm` of a `completed` card is NOT equivalent — it bypasses the landing check.

## Reference

- [PROMOTER_RUNBOOK.md](PROMOTER_RUNBOOK.md) — drain-first promoter procedure
  + boundary promotion + backlog conflict discipline.
- [README.md](README.md) — Canonical State Map (transport vs truth).
- [RUNTIME_MODEL.md](RUNTIME_MODEL.md) — transport-versus-truth and promotion.
- `.opencode/skills/backlog/SKILL.md` — backlog edit discipline + intake /
  boundary / drain routing quick-reference.
- `.opencode/agents/commit-message.md` — the `Task-Card:` trailer convention
  for card-driven commits.
- `.opencode/agents/commit-reviewer.md` — DEFER as an intake predicate routed
  through the admission bar.
