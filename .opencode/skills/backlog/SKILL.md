---
name: backlog
description: "Backlog ledger discipline for vh-solara — conflict-safe edits to docs/planning/backlog.md (hybrid split-commit) plus DEFER/follow-up curation routing. Load this skill before editing the backlog, when handling a could_not_land (content-tangle) on the backlog, or when deciding where a DEFER/p2 finding should land."
compatibility: opencode
---

# Backlog Ledger Discipline

> **Edits are allowed; conflicts are resolved at the commit layer, not by
> blocking edits.** `docs/planning/backlog.md` is the shared task-status ledger.
> Agents edit it freely, commit it **separately** from code, and never blind-
> revert it. DEFER/p2 findings land in `.local/coordinator/tasks/`
> first, never directly as backlog rows.

## Summary

This skill owns two disciplines that share one file (`docs/planning/backlog.md`):

1. **Conflict discipline (hybrid split-commit).** How to edit the ledger without
   a concurrent edit blocking your code commit, and how to recover from a
   `could_not_land` (the backlog content-tangle) without losing a
   collaborator's status update.
2. **Intake + drain routing (composition O1).** Where DEFER / p2 / follow-up
   findings land (the holding area), the **admission bar** a candidate must
   pass before it is filed, the **boundary test** that decides whether it needs
   a backlog row, and the drain-first default for everything that does not.

Plus the picking contract (R1): re-study the cited files/state before acting on
any backlog row — a row is a pointer, not a substitute for the work it points
at. The canonical lifecycle (intake → transport work → review → landing →
retirement, with promotion as an exceptional side path) lives in
`docs/coordination/RECORD_LIFECYCLE.md`.

## Quick reference

- **Drain-first default.** Work cards directly from transport. No backlog row
  is created before or after by default. A card is promoted ONLY when it
  crosses a boundary (blocked / owner-change / must-survive-session). See
  `docs/coordination/RECORD_LIFECYCLE.md`.
- **Intake bar (before filing).** A card is filed only after admission:
  resolve-first / admitted-value (precise question, concrete area + file scope,
  validation approach, an ADMITTED BLOCKER, a ground-truth-derivable trigger
  when deferral is trigger-dependent, provenance, dedup). Dispositions at
  intake: resolvable-now → resolve (don't file); decision-derivable-now →
  drive to verdict (don't defer); real deferred work meeting the bar → file as
  `draft`; duplicate/fog → collapse or discard.
- **Editing the ledger (for promoted rows):** re-read from disk immediately
  before your edit; edit only your own task rows (match the stable ID); keep
  one backlog commit per cycle, separate from any code commit.
- **On `could_not_land`:** re-read from the new HEAD, re-apply your row change,
  retry. **Do NOT revert `backlog.md` to unblock** — that discards a
  collaborator's update. Do NOT use `commit-gate.sh revert` on the backlog
  (that path restores working-tree files to HEAD; on the ledger it is the
  blind-revert anti-pattern).
- **Format:** the executable spec is `.opencode/scripts/normalize-backlog.js`.
  Sections `Now` / `Next` / `Later` (active) and `Done` / `Cancelled`
  (history); statuses `todo` / `in_progress` / `blocked` (active) and `done` /
  `cancelled` (history); columns `| ID | Status | Area | Task | Owner | Notes | Links |`.
  Duplicate IDs are rejected. Run `/backlog-cleanup` (or
  `vh-agent-harness exec node .opencode/scripts/normalize-backlog.js`) after a
  batch edit.
- **Retire on landing, not on review approval.** A `completed` card is retired
  only after a commit carrying the exact `Task-Card: <card-id>` trailer line is
  reachable from a branch (a `git log --branches --fixed-strings --grep`
  reachability check, each candidate post-filtered to an exact trailer line, NOT
  object existence; see RECORD_LIFECYCLE.md → landing-proof contract for the
  exact form).
- **DEFER / p2 / follow-up:** capture to `.local/coordinator/tasks/`
  via `/write-task` with Notes provenance — but only after the admission bar.
  Do **not** add a backlog row directly. Promotion happens only after a
  boundary is crossed AND the Definition of Ready is met.

## Conflict discipline (hybrid split-commit)

### Why split-commit

`backlog.md` is edited by every active session; a code commit is owned by one
session. If a code commit bundles an incidental backlog edit, a concurrent
session's later backlog edit can content-tangle the whole code commit (it
lands as `could_not_land`) and block it. The fix is at the **commit layer**:
keep backlog edits out of code commits.

### Edit contract

1. **Re-read from disk immediately before editing.** The file you read at the
   start of your session may be stale by the time you edit. Re-read, then edit
   in the same turn.
2. **Edit only your own task rows**, matched by stable ID (`P1-CORE-001`,
   `P2-API-003`, …). Do not rewrite rows you do not own; if a row needs a
   status you did not produce, route the request through the promoter or the
   owning session.
3. **Commit backlog separately from code.** A code commit's `--paths` list
   must not include `docs/planning/backlog.md`. If your slice touched both,
   make two commits: one for code, one for the backlog row update.
4. **Batch one backlog commit per cycle.** Collect the cycle's status
   transitions, then commit them together. This minimizes concurrent-edit
   surface and matches the promoter's batch-promote cadence.

### On `could_not_land` (the anti-pattern and the fix)

When `commit-gate.sh commit` reports a `could_not_land` on `backlog.md` (reason
`merge_failed`/`write_tree_failed`), it means another session committed a
backlog edit after your `acquire` snapshot and the blob-level CAS merge could
not reconcile the two same-file edits. The gate will have preserved your
intended changes; the recovery is:

1. **Re-read `backlog.md` from the new HEAD** (the post-conflict state, which
   now includes the other session's row update).
2. **Re-apply your row change** on top of that state — edit only your row, by
   stable ID.
3. **Retry the backlog commit** (re-acquire if the gate requires it).

**Do NOT revert `backlog.md` to unblock.** A blind revert discards the other
session's status update, which is exactly the data loss the hybrid model
exists to prevent. In particular:

- `commit-gate.sh revert docs/planning/backlog.md` restores the working-tree
  file to HEAD. On source files this is the sanctioned in-session unblock; on
  the ledger it is the **blind-revert anti-pattern** — do not use it for
  `backlog.md`. Use the re-read + re-apply + retry flow above instead.
- The operator-only escape hatch (`rm -rf .git/commit-gate.lock/ && git reset
  --mixed`) is operator-only and out of scope here; agents never use it.

### Format pointer

The executable format spec is `.opencode/scripts/normalize-backlog.js`. It
enforces the section/status/column vocabulary and rejects duplicate IDs. Treat
it as the source of truth for shape; this skill only summarizes. Run
`/backlog-cleanup` after any batch edit so `Now` / `Next` / `Later` stay
active-only and history archives under `docs/planning/archive/`.

### Two-commit normalizer protocol

A normalizer run (`vh-agent-harness exec node .opencode/scripts/normalize-backlog.js`,
or `/backlog-cleanup`) may change `docs/planning/backlog.md` **together with**
files under `docs/planning/archive/` — managed archive files like
`backlog-archive-<period>.md` and `archive/index.md`, including created,
updated, or removed files. **This does not create an exception to the
backlog-only commit rule.** The commit-gate's `O1 backlog_must_commit_separately`
preflight refuses any `acquire` whose `--paths` mixes `docs/planning/backlog.md`
with another path (status `path_error` / `backlog_must_commit_separately`),
there is no archive-companion carveout, and the normalizer's archive companions
are NOT ordinary "code/docs" changes that could ride alongside unrelated work.

**Build/host prestep — who runs the normalizer.** The committer agent's
permission profile denies both `vh-agent-harness *` and bare `node`, so the
committer **cannot run `normalize-backlog.js` itself** — neither the write pass
nor the `--check` pass. The normalizer must be run by **build**
(`vh-agent-harness exec node .opencode/scripts/normalize-backlog.js`) or by the
**operator host-side** BEFORE the closeout is handed to the committer. The
committer then lands the already-normalized two-commit transaction (backlog-only
commit + archive-companion commit) against the working tree build/host prepared.
This documents the current permission split — it is NOT a carve-out: do not
relax the committer profile from a doc edit (that is a separate coordinator
decision).

Treat the normalizer output as **one work-cycle transaction** landed through
**two reviewed commits, back to back**:

1. **Commit `docs/planning/backlog.md` alone** — a backlog-only acquire; no
   other path may travel in the same commit.
2. **Immediately commit only the changed, created, or removed
   `docs/planning/archive/**` companions** as one archive-companion commit.

Neither commit may contain unrelated paths. **Do not stop, hand off, close
out, or report the normalization complete between the two commits** — they
are one logical transaction, and any session that resumes your work must see
them as a pair, not as a half-finished normalization.

Run the normalizer check over the complete working tree (not just the ledger)
**before the first commit and again after the archive-companion commit**:

```
vh-agent-harness exec node .opencode/scripts/normalize-backlog.js --check
```

If the check fails on either pass, rerun the normalizer (without `--check`)
and recompute both exact path sets before committing.

If the ledger changes concurrently or a `could_not_land` occurs on the
backlog-only commit, apply the normal `could_not_land` recovery (re-read from
the new HEAD, re-apply, retry) — but because the normalizer is deterministic
over the ledger + archives, the safer path is to re-read the ledger, rerun
the normalizer over the complete working tree, and recompute both exact path
sets before retrying. Do NOT revert the archive companions to unblock.

## Intake + drain routing (DEFER / p2 / follow-up)

### Holding area = `.local/coordinator/tasks/`

DEFER findings (from `commit-reviewer`), p2 follow-ups, and other conditional
candidates are NOT filed by reflex. The holding area is **transport, not
truth** — unpromoted candidates may be lost, and that is intentional: they are
not trusted work yet. The lifecycle is **drain-first**: file only what passes
the admission bar, drain resolved cards directly, promote only boundary-crossers.

### Step 1 — Admission bar (should this card exist?)

Before a card is filed, the `resolve-first` classifier triages the disposition:

- **Resolvable now** → resolve it; do NOT file.
- **Decision-derivable now** → drive to a verdict; do NOT defer.
- **Real deferred work meeting the bar** → file as a `draft` transport card
  with Notes provenance.
- **Duplicate / fog** → collapse into the existing card, or discard.

A card is filed only when ALL of the admission bar hold:

- **Precise question** — ticket-ready, not fog (see fog-vs-ticket below).
- **Concrete area** — the repo boundary it belongs to.
- **File / subsystem scope** — the files or directories it touches.
- **Validation approach** — how "done" will be checked.
- **An ADMITTED BLOCKER or reason the work cannot be resolved now** — for
  deferred work, why it cannot be done in the current session.
- **A ground-truth-derivable trigger** — when deferral is trigger-dependent, a
  predicate the checker can re-derive from repo state
  (`path_touched(<path>)`, `after_tag(<tag>)`, …).
- **Provenance** — `source:review-defer` (from `commit-reviewer` DEFER),
  `source:p2-followup` (from a p2 blocker-disposition), `studied:YYYY-MM-DD`.
- **Dedup** — no materially-equivalent open card already exists.

A DEFER finding from `commit-reviewer` is an **intake predicate**, not an
auto-file: route it through this admission bar before it becomes a card.

### Step 2 — Boundary test (does it need a backlog row?)

Filed cards are drained directly by default — work them, land the commit,
retire the card. A card is promoted into a `docs/planning/backlog.md` row ONLY
when it crosses one of these boundaries:

- **Blocked** — needs an external decision or owner input to progress, so its
  blocked state must outlive the discovering session.
- **Owner-change** — responsibility moves to another session/operator.
- **Must-survive-session** — longer than one session; the durable status ledger
  is the right home for its state.

No boundary ⇒ drain in transport; no backlog row is created before or after.

### Step 3 — Definition of Ready (for a promoted row)

For the exceptional card that DID cross a boundary, promote it into
`docs/planning/backlog.md` only when ALL of:

1. **Trigger fired OR operator override.** For trigger-gated candidates, the
   predicate checker (`.opencode/scripts/check-defer-triggers.mjs`) confirms
   the `trigger:` line is currently met, OR the operator explicitly marks
   `override:operator` in Notes.
2. **Concrete area.** The candidate names the repo boundary it belongs to.
3. **File scope.** The candidate names the files / directories it touches.
4. **Validation plan.** The candidate states how the change will be verified.
5. **Clear slice.** One vertical slice or one focused boundary change — not an
   open-ended theme.
6. **Provenance.** The Notes block carries `source:` / `trigger:` / `studied:`
   (or `override:operator`), surviving into the backlog row's Notes.

If any element is missing, the promoter leaves the candidate in holding and
records what is missing on the task card.

### Predicate checker (promoter-use-only)

`.opencode/scripts/check-defer-triggers.mjs` reads the task cards, regexes for
`trigger:` lines in Notes, and reports which candidates' conditions are
currently met. It supports a small predicate vocabulary (`path_touched(<path>)`,
`after_tag(<tag>)`). It is:

- **Promoter-use-only.** Run by the promoter during a promotion cycle.
- **Never wired into a commit hook.** It does not block commits.
- **Never blocking.** It prints a report; it does not gate anything.

This is a first-slice MVP predicate engine, not a full rules system.

### Reviewer DEFER never becomes a direct backlog row

A `commit-reviewer` DEFER disposition is an **intake predicate**, not a
backlog insertion. The reviewer's DEFER grammar tells the next reviewer what
to re-check; the agent capturing the finding routes it through the admission
bar above before filing a transport card, and the promoter decides promotion.
The reviewer never writes a backlog row, and the capturing agent never writes a
backlog row for a DEFER either — both route through intake.

## Picking contract (R1)

Before acting on any backlog row, **re-study the cited files and state**. A
row is a pointer (stable ID + one-line task + owner + links), not a
substitute for the work it points at. Re-read the linked design memo, the
referenced source, and the current state of the area before you start. If the
row's framing no longer matches the code, surface the drift rather than
executing a stale plan.

## Cross-references

- `docs/planning/backlog.md` — the ledger itself
- `docs/coordination/RECORD_LIFECYCLE.md` — canonical card/DEFER lifecycle (drain-first, boundary promotion, landing-gated retirement, landing-proof contract)
- `.opencode/scripts/normalize-backlog.js` — executable format spec (sections, statuses, columns, dup-ID rejection)
- `.opencode/scripts/check-defer-triggers.mjs` — promotion predicate checker (promoter-use-only)
- `docs/coordination/PROMOTER_RUNBOOK.md` — drain-first promoter procedure: admission bar, boundary promotion, hybrid CAS preservation
- `docs/coordination/BLOCKER_POLICY.md` — p2 follow-ups route to the holding area
- `.opencode/skills/gated-commit/SKILL.md` — the commit layer this discipline depends on (commit backlog separately from code; `commit-gate.sh revert` is the anti-pattern on `backlog.md`)
