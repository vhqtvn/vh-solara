---
name: backlog
description: "Backlog ledger discipline for vh-solara — conflict-safe edits to docs/planning/backlog.md (hybrid split-commit) plus DEFER/follow-up curation routing. Load this skill before editing the backlog, when handling a cas_conflict on the backlog, or when deciding where a DEFER/p2 finding should land."
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
   `cas_conflict` without losing a collaborator's status update.
2. **Curation routing (composition O1).** Where DEFER / p2 / follow-up findings
   land (the holding area), and the Definition of Ready a candidate must meet
   before it is promoted into a backlog row.

Plus the picking contract (R1): re-study the cited files/state before acting on
any backlog row — a row is a pointer, not a substitute for the work it points
at.

## Quick reference

- **Editing the ledger:** re-read from disk immediately before your edit; edit
  only your own task rows (match the stable ID); keep one backlog commit per
  cycle, separate from any code commit.
- **On `cas_conflict`:** re-read from the new HEAD, re-apply your row change,
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
- **DEFER / p2 / follow-up:** capture to `.local/coordinator/tasks/`
  via `/write-task` with Notes provenance. Do **not** add a backlog row
  directly. Promotion happens only after the predicate checker confirms the
  trigger and the Definition of Ready is met.

## Conflict discipline (hybrid split-commit)

### Why split-commit

`backlog.md` is edited by every active session; a code commit is owned by one
session. If a code commit bundles an incidental backlog edit, a concurrent
session's later backlog edit can `cas_conflict` the whole code commit and block
it. The fix is at the **commit layer**: keep backlog edits out of code commits.

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

### On `cas_conflict` (the anti-pattern and the fix)

When `commit-gate.sh commit` reports a `cas_conflict` on `backlog.md`, it means
another session committed a backlog edit after your `acquire` snapshot. The
gate will have preserved your intended changes; the recovery is:

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
node .opencode/scripts/normalize-backlog.js --check
```

If the check fails on either pass, rerun the normalizer (without `--check`)
and recompute both exact path sets before committing.

If the ledger changes concurrently or a `cas_conflict` occurs on the
backlog-only commit, apply the normal `cas_conflict` recovery (re-read from
the new HEAD, re-apply, retry) — but because the normalizer is deterministic
over the ledger + archives, the safer path is to re-read the ledger, rerun
the normalizer over the complete working tree, and recompute both exact path
sets before retrying. Do NOT revert the archive companions to unblock.

## Curation routing (DEFER / p2 / follow-up)

### Holding area = `.local/coordinator/tasks/`

DEFER findings (from `commit-reviewer`), p2 follow-ups, and other conditional
candidates land in `.local/coordinator/tasks/` as **conditional
candidates**, not as backlog rows. The holding area is **transport, not
truth** — unpromoted candidates may be lost, and that is intentional: they are
not trusted work yet.

Capture a candidate via `/write-task` with **Notes provenance** so the
promoter can evaluate it later:

```
source:review-defer            # or source:p2-followup
trigger:path_touched(src/auth/x.go)   # the predicate that, when true, makes this real
studied:2026-04-30             # when the finding was produced
```

`source:review-defer` means the candidate came out of a `commit-reviewer`
DEFER. `source:p2-followup` means it came from a p2 blocker-disposition. The
`trigger:` line is the predicate the checker evaluates (see below). `studied:`
is the date the finding was produced, for staleness awareness.

### Promotion Definition of Ready (DoR)

A candidate reaches `backlog.md` only when **all** of the following hold:

1. **Trigger fired OR operator override.** The predicate checker
   (`.opencode/scripts/check-defer-triggers.js`) confirms the `trigger:` line
   is currently met, OR the operator explicitly marks
   `override:operator` in Notes.
2. **Concrete area.** The candidate names the repo boundary it belongs to
   (`api`, `web`, `storage`, `docs`, …).
3. **File scope.** The candidate names the files / directories it touches.
4. **Validation plan.** The candidate states how the change will be verified
   (tests, gates, manual checks).
5. **Clear slice.** The candidate is scoped to one vertical slice or one
   focused boundary change — not an open-ended theme.
6. **Provenance.** The Notes block carries `source:` / `trigger:` / `studied:`
   (or `override:operator`).

If any element is missing, the promoter leaves the candidate in holding and
records what is missing on the task card.

### Predicate checker (promoter-use-only)

`.opencode/scripts/check-defer-triggers.js` reads the task cards, regexes for
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
to re-check; the agent capturing the finding routes it to
`.local/coordinator/tasks/` with provenance, and the promoter decides
promotion. The reviewer never writes a backlog row, and the capturing agent
never writes a backlog row for a DEFER either — both route through holding.

## Picking contract (R1)

Before acting on any backlog row, **re-study the cited files and state**. A
row is a pointer (stable ID + one-line task + owner + links), not a
substitute for the work it points at. Re-read the linked design memo, the
referenced source, and the current state of the area before you start. If the
row's framing no longer matches the code, surface the drift rather than
executing a stale plan.

## Cross-references

- `docs/planning/backlog.md` — the ledger itself
- `.opencode/scripts/normalize-backlog.js` — executable format spec (sections, statuses, columns, dup-ID rejection)
- `.opencode/scripts/check-defer-triggers.js` — promotion predicate checker (promoter-use-only)
- `docs/coordination/PROMOTER_RUNBOOK.md` — promoter procedure: curation, batch-promote, hybrid CAS preservation
- `docs/coordination/BLOCKER_POLICY.md` — p2 follow-ups route to the holding area
- `.opencode/skills/gated-commit/SKILL.md` — the commit layer this discipline depends on (commit backlog separately from code; `commit-gate.sh revert` is the anti-pattern on `backlog.md`)
