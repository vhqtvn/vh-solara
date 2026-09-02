# Promoter Runbook

> **Term contract.** "Agent harness" is a **HANDLE ONLY**. This runbook carries
> the **Coordination** layer of the harness (routing/tracking/handoff of work).

This is the operational runbook for the **promoter** role: the agent (or
operator) that keeps the transport holding area draining and that batch-promotes
the exceptional candidate that crosses a boundary into `docs/planning/backlog.md`.
It is a procedure, not code.

> **Drain-first default.** Work is drained directly from transport. A card is
> promoted into a backlog row ONLY when it crosses a named boundary — blocked,
> owner-change, or must-survive-session (see "Boundary test" below). The
> canonical lifecycle lives in [RECORD_LIFECYCLE.md](RECORD_LIFECYCLE.md);
> backlog is a status ledger, not a record store.

## Why this role exists

Agents edit `docs/planning/backlog.md` **freely** — direct edits are not
blocked. Two problems still need a curator:

1. **Intake + drain.** Cards live in `.local/coordinator/tasks/` as
   transport. The default is to drain resolved cards directly (work them,
   land them, retire them) — NOT to file a backlog row. The promoter applies
   the **admission bar** (resolve-first / admitted-value) before a card is
   filed, and the **boundary test** before a card is promoted. Without this,
   the holding area re-grows into a reservoir of untriggered noise.
2. **Cycle consolidation.** For the exceptional card that does cross a
   boundary, batch-promoting a coherent cycle's worth of status transitions
   (and normalizing + archiving) is a distinct responsibility from writing
   code.

The promoter is that curator. It does NOT block worker edits — it keeps the
holding area draining, promotes only boundary-crossers into the canonical
ledger, and tidies the ledger each cycle.

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

### 1. Drain transport, promote boundary-crossers

The holding area is a **drain**, not a reservoir. Three tests, in order:

#### 1a. Admission bar (before a card exists)

Before a card is filed, it passes admission (see [RECORD_LIFECYCLE.md](RECORD_LIFECYCLE.md)
→ Intake). The `resolve-first` skill is the front-gate classifier:

- **Resolvable now** → resolve it; do NOT file.
- **Decision-derivable now** → drive to a verdict; do NOT defer.
- **Real deferred work meeting the bar** → file as a `draft` transport card
  with Notes provenance (`source:review-defer` / `source:p2-followup`,
  `trigger:...`, `studied:YYYY-MM-DD`).
- **Duplicate / fog** → collapse into the existing card, or discard.

A DEFER finding from `commit-reviewer` is an **intake predicate**, not an
auto-file: route it through the same admission bar before it becomes a card.

#### 1b. Boundary test (does it need a backlog row?)

The default is to drain resolved transport directly — work the card, land the
commit, retire the card. A card gets a `docs/planning/backlog.md` row ONLY when
it crosses one of these boundaries:

- **Blocked** — needs an external decision or owner input to progress, so its
  blocked state must outlive the discovering session.
- **Owner-change** — responsibility moves to another session/operator, so the
  row is the handoff artifact.
- **Must-survive-session** — longer than one session; the durable status ledger
  (not the transport card) is the right home for its state.

No boundary ⇒ keep draining in transport. Do NOT file a backlog row before or
after by default. A promoted row carries the card's stable ID in Notes so the
join is auditable.

#### 1c. Predicate checker (promoter-use-only, for trigger-gated candidates)

For a deferred candidate whose admission hinges on a trigger, run
`vh-agent-harness defer-triggers` to see which candidates'
`trigger:` conditions are currently met (`path_touched(<path>)` via
`git diff --name-only`, `after_tag(<tag>)` via `git describe`). The checker
is a **promotion-review aid only** — it never runs in a commit hook, never
blocks. A false-negative from the checker is not a hard veto.

**Why the dedicated verb (not bare `node`).** The no-arg
`vh-agent-harness defer-triggers` command runs the canonical checker
(`.opencode/scripts/check-defer-triggers.mjs`) under a strict host-local
sandbox (ModeStrict + NetDeny + DefaultProfile), with no
caller-controlled exe/script/mode. It is granted per-agent to the read-only
roles that evaluate trigger currency (`researcher`, `worker-read-only`) and
resolves for the orchestrator roles (`build` / `coordination` /
`project-coordinator`) through the `vh-agent-harness` wildcard — it is the
engine-reachable form for every role that evaluates trigger currency. The bare `node …` invocation of
that script resolves to DENY under the permission model (no raw `node` grant)
and must not be prescribed. The verb produces the canonical promoter report.

The report prints one line per candidate as `[FLAG] <id> (<file>) — <note>`:

| Flag | Meaning | Action |
|------|---------|--------|
| `[READY]` | Trigger fired AND the card's lifecycle is open (not disposed). | **Actionable** — run the boundary test (1b); if a boundary is crossed, apply the Definition of Ready (1d) and promote. Otherwise drain. |
| `[RE-FIRE]` | Trigger fired BUT the card is already closed for recurrence (`completed` / `cancelled` / `staged`); its watched path was re-touched after disposal. | **Not actionable** — a possible-regression signal worth seeing, but not fresh work. Excluded from the actionable `READY` count. |
| `<state>` | `valid-waiting`, `no-machine-trigger`, `unsupported`, `malformed-compound`, or `cold-glob`. | **Not ready** — refine, repair the trigger grammar, or leave on hold. |

The summary line `R/N candidate(s) are actionable READY (trigger met,
lifecycle open)` counts ONLY open-lifecycle fired cards (re-fires excluded).
When a disposed card re-fires, the report adds:
`Disposed re-fires (completed/cancelled/staged, watched path re-touched —
possible regression, NOT actionable): N`. The closed-for-recurrence status
set is `{completed, cancelled, staged}` — a card in any of these is
disposition-satisfied, so a trigger re-fire is a recurrence/regression
signal, not promotion work.
An always-printed `State breakdown: <state>=<count>  ...` line tallies every
card under its predicate state (sorted alphabetically, joined by two spaces)
so the promoter can triage at a glance. It is printed unconditionally with
the summary (unlike the conditional `Disposed re-fires` line). The
`valid-fired` tally includes BOTH `[READY]` and `[RE-FIRE]` cards — they
share one predicate state; only the flag and the actionable count differ by
lifecycle.

#### 1d. Definition of Ready (for a promoted row)

For the exceptional card that DID cross a boundary (1b), promote it into
`docs/planning/backlog.md` only if ALL of:

- **Trigger fired** (checker confirms) OR **operator override** (recorded in
  Notes as `override:operator`) — for trigger-gated candidates only.
- **Concrete area** (matches a repo boundary / package).
- **File scope** (the candidate names the files/paths it concerns).
- **Validation plan** (how "done" will be checked).
- **Clear slice** (one focused vertical slice, not a grab-bag).
- **Provenance** (the Notes-prefix metadata survives into the backlog row's
  Notes so the origin is auditable).

A candidate that fails the DoR stays in the holding area; it is NOT promoted.
Losing unpromoted candidates is **intentionally fine** — they are not trusted
work yet (transport, not truth). Cards that never cross a boundary are drained
directly and retired on landing; they never reach this step.

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
- **On `could_not_land` (a backlog content-tangle — another session's backlog
  edit landed first), re-read + re-apply + retry.** Re-read the file from the
  new HEAD, re-apply only your rows (matched by stable ID), and retry the
  commit. Reconcile manually from the task cards if two sessions both promoted.

### 4. Eventual-consistency pass (each cycle)

Without a real-time per-edit nudge (unachievable in opencode v1.14.x), drift
accumulates between the backlog and reality. The promoter closes that gap each
cycle with a narrow reconciliation pass. Run ALL of:

1. **Normalize check.** Run
   `vh-agent-harness exec node .opencode/scripts/normalize-backlog.js --check`. It MUST pass. If it
   reports drift (stale `Now`/`Next`/`Later` sections, un-archived history, or
   status/owner inconsistencies), fix the drift first — do NOT commit a backlog
   that fails `--check`.
2. **Reconcile holding area ↔ backlog.** Open
   `.local/coordinator/tasks/` and match cards + closeouts against
   backlog rows:
   - **Apply the boundary test (1b) first.** A candidate is promoted ONLY when
     it crosses a boundary (blocked / owner-change / must-survive-session) AND
     its trigger has fired (for trigger-gated candidates) AND it meets the
     Definition of Ready (1d). No boundary ⇒ drain it directly (work, land,
     retire) — do NOT promote.
    - **Retire done cards on landing.** A `completed` card is retired only after
      a commit carrying the exact `Task-Card: <card-id>` trailer line is
      reachable from a branch (see [RECORD_LIFECYCLE.md](RECORD_LIFECYCLE.md) →
      landing-proof contract). A lingering `completed` card corrupts the count
      signal — drain it, do not park it.
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
- Does not promote a card that has not crossed a boundary — drain-first is the
  default. Does not retire a `completed` card on review approval alone —
  retirement is landing-gated.

## Reference

- [RECORD_LIFECYCLE.md](RECORD_LIFECYCLE.md) — canonical card/DEFER lifecycle
  (drain-first, boundary promotion, landing-gated retirement, the landing-proof
  contract).
- [README.md](README.md) — Canonical State Map and the free-edits + curation model.
- [TASK_MODES.md](TASK_MODES.md) — Non-Negotiable #2 (hybrid split-commit + curation).
- [BLOCKER_POLICY.md](BLOCKER_POLICY.md) — p2 follow-ups route to the holding area.
- [RUNTIME_MODEL.md](RUNTIME_MODEL.md) — transport-versus-truth and promotion rules.
- `.opencode/skills/backlog/SKILL.md` — the backlog skill (conflict discipline +
  intake / boundary / drain routing quick-reference).
