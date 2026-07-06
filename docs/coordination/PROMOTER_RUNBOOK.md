# Promoter Runbook

> **Term contract.** "Agent harness" is a **HANDLE ONLY**. This runbook carries
> the **Coordination** layer of the harness (routing/tracking/handoff of work).

This is the operational runbook for the **promoter** role: the agent (or
operator) that curates conditional candidates from
`.local/coordinator/tasks/` into `docs/planning/backlog.md` and that
batch-promotes consolidated status transitions each cycle. It is a procedure,
not code.

## Why this role exists

Agents edit `docs/planning/backlog.md` **freely** — direct edits are not
blocked. Two problems still need a curator:

1. **DEFER / follow-up intake.** DEFER findings and p2 follow-up/cleanup items
   should NOT become backlog rows directly. They land in
   `.local/coordinator/tasks/` as conditional candidates and reach the
   backlog only after a trigger fires AND a Definition of Ready is met. Without
   a curator, the backlog fills with untrusted, untriggered noise.
2. **Cycle consolidation.** Even with free edits, batch-promoting a coherent
   cycle's worth of status transitions (and normalizing + archiving) is a
   distinct responsibility from writing code.

The promoter is that curator. It does NOT block worker edits — it shapes what
gets *promoted into* the canonical ledger from the holding area, and it tidies
the ledger each cycle.

## Who runs it

- **Initially:** the operator, or a `coordination` session acting for the
  operator. No dedicated agent is required to start.
- **Later (optional):** a dedicated promoter agent may be introduced. Until
  then, the promoter is a human-in-the-loop responsibility.

## Cadence

Promote on any of these triggers:

- **Per cycle:** at the end of a work cycle (a slice or fan-in batch lands).
- **On demand:** when an operator or coordinator needs the canonical backlog to
  reflect current reality (e.g. before opening a new cycle, before a release).
- **Per-N-completions:** after every N task closeouts, to keep the active
  sections tidy (N is operator choice; start with 1 per cycle and relax).

## Procedure

### 1. Curate conditional candidates (DEFER / follow-up intake)

1. **Read the holding area.** Open `.local/coordinator/tasks/` and scan
   for candidate cards carrying Notes-prefix provenance (`source:review-defer`,
   `source:p2-followup`, `trigger:...`, `studied:YYYY-MM-DD`).
2. **Run the predicate checker.** Execute
   `node .opencode/scripts/check-defer-triggers.js` to see which candidates'
   `trigger:` conditions are currently met (`path_touched(<path>)` via
   `git diff --name-only`, `after_tag(<tag>)` via `git describe`). The checker
   is a **promotion-review aid only** — it never runs in a commit hook, never
   blocks. A false-negative from the checker is not a hard veto.
3. **Apply the Definition of Ready (DoR).** Promote a candidate into
   `docs/planning/backlog.md` only if ALL of:
   - **Trigger fired** (checker confirms) OR **operator override** (recorded in
     Notes as `override:operator`).
   - **Concrete area** (matches a repo boundary / package).
   - **File scope** (the candidate names the files/paths it concerns).
   - **Validation plan** (how "done" will be checked).
   - **Clear slice** (one focused vertical slice, not a grab-bag).
   - **Provenance** (the Notes-prefix metadata survives into the backlog row's
     Notes so the origin is auditable).
4. **Do NOT promote** candidates that fail the DoR. They stay in the holding
   area. Losing unpromoted candidates is **intentionally fine** — they are not
   trusted work yet (transport, not truth).

### 2. Batch-promote cycle status transitions

1. **Reconcile against canon.** Open `docs/planning/backlog.md` and identify the
   rows whose status, owner, notes, or links need to change to match the cycle's
   completed work. Match by stable task ID (`<phase>-<AREA>-<NNN>`).
2. **Re-read from disk before editing.** The backlog is a shared ledger; load
   the latest content immediately before your edit. Edit only the rows you own
   for this cycle.
3. **Batch-edit the backlog.** Apply all pending transitions in one edit pass:
   - `todo` → `in_progress` (work started)
   - `in_progress` → `done` (closeout filed, with changed files + verification)
   - `in_progress` → `blocked` (exact blocker + next decision)
   - new rows for DoR-meeting candidates (new ID, never overload)
   - `cancelled` for abandoned items (with a short reason)
4. **Normalize.** Run `/backlog-cleanup` (or
   `vh-agent-harness exec node .opencode/scripts/normalize-backlog.js`) so
   `Now` / `Next` / `Later` stay active-only and history is archived under
   `docs/planning/archive/`.
5. **Commit backlog SEPARATELY from code.** Delegate a single gated commit via
   the committer agent, passing `docs/planning/backlog.md` (and any archived
   rows) as the explicit file list. Do NOT bundle backlog changes into a code
   commit — that is the whole point of the hybrid split-commit model.

### 3. Conflict resolution (hybrid CAS preservation)

Because agents edit the backlog freely, a content conflict on
`docs/planning/backlog.md` CAN occur. The resolution contract:

- **NEVER revert `backlog.md` to unblock.** `commit-gate.sh revert <paths>` is
  for stray CODE files this session does not own; applying it to `backlog.md`
  discards other agents' promoted state. This is the anti-pattern.
- **Preserve dirty backlog before any restore.** If a code commit needs to
  restore unrelated paths, HARVEST any dirty `backlog.md` edits first (copy the
  working-tree content aside), then restore, then re-apply the harvested
  backlog content. The shared ledger is never blind-reverted.
- **On `cas_conflict`, re-read + re-apply + retry.** Re-read the file from the
  new HEAD, re-apply only your rows (matched by stable ID), and retry the
  commit. Reconcile manually from the task cards if two sessions both promoted.

### 4. Eventual-consistency pass (each cycle)

Without a real-time per-edit nudge (unachievable in opencode v1.14.x), drift
accumulates between the backlog and reality. The promoter closes that gap each
cycle with a narrow reconciliation pass. Run ALL of:

1. **Normalize check.** Run
   `node .opencode/scripts/normalize-backlog.js --check`. It MUST pass. If it
   reports drift (stale `Now`/`Next`/`Later` sections, un-archived history, or
   status/owner inconsistencies), fix the drift first — do NOT commit a backlog
   that fails `--check`.
2. **Reconcile holding area ↔ backlog.** Open
   `.local/coordinator/tasks/` and match cards + closeouts against
   backlog rows:
   - **Promote** candidates whose trigger has fired AND that meet the Definition
     of Ready (concrete area + file scope + validation plan + clear slice +
     provenance). Apply step 1 of the main procedure.
   - **Detect orphans.** A backlog row with no corresponding card, no closeout,
     and no recent activity is an anomaly — either close it (`cancelled` with a
     reason) or flag it for the operator. Do NOT silently delete history.
3. **Detect blind-revert symptoms.** Compare the current backlog against the
   last cycle's committed state (`git log -- docs/planning/backlog.md`). A row
   that regressed (e.g. `done` → `todo`) or went MISSING vs last cycle is the
   signature of a blind-revert of the ledger (the anti-pattern from section 3).
   If detected, restore the lost rows from the prior commit and note the repair
   in the row's Notes.
4. **Land backlog changes as a backlog-only commit.** Every backlog change from
   this pass MUST be a single backlog-only gated commit (path list =
   `["docs/planning/backlog.md"]` and nothing else). The commit-gate O1 preflight
   would refuse a mixed acquire anyway; keep the pass clean by never bundling
   backlog with code. Code commits never wait on a backlog blob.

## What the promoter does NOT do

- Does not edit code, tests, or non-backlog docs (that is worker territory).
- Does not synthesize technical conclusions (that is the synthesizer's job at
  fan-in; the promoter only promotes status + curated candidates).
- Does not run the normalizer as a substitute for editing — normalize only
  after the batch edit lands.
- Does not bypass the gated commit. Promotion commits go through the committer
  like any other.
- Does not wire the predicate checker into a commit hook or any blocking path.
- Does not run an automated staleness cull (R5). Stale candidates simply remain
  in the holding area; cull-by-hand later if the holding area grows large.

## Reference

- [README.md](README.md) — Canonical State Map and the free-edits + curation model.
- [TASK_MODES.md](TASK_MODES.md) — Non-Negotiable #2 (hybrid split-commit + curation).
- [BLOCKER_POLICY.md](BLOCKER_POLICY.md) — p2 follow-ups route to the holding area.
- [RUNTIME_MODEL.md](RUNTIME_MODEL.md) — transport-versus-truth and promotion rules.
- `.opencode/skills/backlog/SKILL.md` — the backlog skill (conflict discipline +
  curation routing quick-reference).
