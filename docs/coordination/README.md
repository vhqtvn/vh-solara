# Coordination Layer

> **Term contract.** "Agent harness" is a **HANDLE ONLY**. An agent harness is a repo-resident system of rules, memory, coordination, safety gates, and reusable workflows that makes AI coding agents (and the humans operating them) behave predictably and keep working across context resets and session boundaries. It has six layers: Prescriptive, Cognitive, **Coordination**, Safety, Capability, Environment. This directory carries the **Coordination** layer (routing/tracking/handoff of work).

This directory is the durable coordination layer for cross-boundary work in the
vh-solara repo.

It exists to answer a narrow question:

- how should agents coordinate work, ownership, prompts, handoffs, and blockers

It does not replace the repo's existing state systems.

For durable option comparison and background design rationale, see
[`researches/decisions/2026-04-29-coordination-control-plane-options.md`](../../researches/decisions/2026-04-29-coordination-control-plane-options.md).

## Canonical State Map

Use the existing source of truth that already owns each kind of state.

| State | Canonical location | Notes |
| --- | --- | --- |
| Active task status | `docs/planning/backlog.md` | The backlog is the canonical task queue and status ledger — an **eventually-consistent** shared file. Agents edit it **freely**; split-commit is ENFORCED at the commit boundary by the commit-gate O1 preflight (`acquire` refuses any path list that mixes the ledger with code/docs), and residual drift is reconciled each cycle by the promoter (normalize-check + holding-area reconciliation + backlog-only commit). Code commits never wait on a backlog blob. |
| Durable decisions, blockers, completions | `docs/checkpoints/` | Commit only durable snapshots worth reopening later. |
| Release and environment facts | `docs/deployment/` | Keep provider/demo state in release docs, not in generic coordination files. |
| Live task execution state | `.opencode/state/sessions/<alias>/` | Session-scoped task contracts, checkpoints, handoffs, and open questions. |
| Live cross-session theme state | `.opencode/state/workstreams/<slug>/` | Long-lived local theme context that should not become backlog rows by default. |
| Conditional candidate holding area | `.local/coordinator/tasks/` | Gitignored **transport, not truth** for DEFER/p2 follow-up candidates awaiting curation. Unpromoted candidates may be lost (intentionally fine). The promoter curates DoR-meeting candidates into `backlog.md`. |
| Local operator overlays | `.local/coordinator/` | Private, gitignored operator state and preferences. |

### Free-edits + curation model (eventual consistency)

Agents edit `docs/planning/backlog.md` directly. The ledger is
**eventually-consistent**: there is no real-time per-edit nudge (none is
achievable in opencode v1.14.x), so safety is delivered by two layers that
converge on correctness without blocking edits:

1. **Hybrid split-commit conflict discipline (gate-enforced).** The commit-gate
   O1 preflight refuses an `acquire` whose `--paths` mixes
   `docs/planning/backlog.md` with any other path — so a backlog change can
   never `cas_conflict` a code commit. The rejection message is the teaching:
   agents learn split-commit at the commit boundary. On `cas_conflict` for a
   backlog-only commit, re-read from the new HEAD, re-apply only your rows, and
   retry. Dirty backlog edits are **preserved before any restore** — never
   blind-revert `backlog.md`. See [PROMOTER_RUNBOOK.md](PROMOTER_RUNBOOK.md).
2. **Intake curation.** DEFER findings and p2 follow-ups NEVER become backlog
   rows directly. They land in `.local/coordinator/tasks/` as
   conditional candidates and reach the backlog only after a trigger fires AND
   the promotion Definition of Ready is met (concrete area + file scope +
   validation plan + clear slice + provenance). The promoter runs the
   `check-defer-triggers.js` predicate checker as a review aid (promoter-use-
   only; never a commit hook; never blocking).

The **promoter** curates candidates, batch-promotes a cycle's consolidated
status transitions (normalize + archive + one backlog commit), and runs the
narrow eventual-consistency pass (normalize `--check`, holding-area ↔ backlog
reconciliation, blind-revert-symptom detection) that repairs residual drift.
It is a curator and cycle-consolidator, not the sole writer — agents write
their own rows.

See [PROMOTER_RUNBOOK.md](PROMOTER_RUNBOOK.md) for the promoter procedure,
the eventual-consistency pass, conflict resolution, and the Definition of
Ready.

## Record Lifecycle

The harness keeps records in a few distinct tiers, each with a different
durability and a different rule for what survives. This section is descriptive
of existing practice; it is not a new state machine, tombstone system, or
promotion engine.

| Surface | Role while active | Durability / truth status | Promotion / retention rule | Cleanup / archive path |
| --- | --- | --- | --- | --- |
| `docs/planning/backlog.md` | Canonical task-status ledger | Committed source of truth (eventually-consistent; hybrid split-commit keeps a backlog edit from blocking a code commit) | Agents edit freely; one backlog commit per cycle; DEFER / p2 candidates promote in only after trigger + Definition of Ready | `done` / `cancelled` rows move to `docs/planning/archive/` via `/backlog-cleanup` |
| `docs/checkpoints/` | Durable decisions, blockers, closeouts | Committed truth — reopen later | Commit only snapshots worth reopening; nothing auto-promotes out | None — durable by design; older checkpoints are retained for retrieval |
| `.opencode/state/sessions/`, `.opencode/state/workstreams/` | Resumable working state (task contracts, checkpoints, workstream briefs) | Local, gitignored — resumable across compaction but **not** truth | Keep small durable state here; bulky outputs go to `tmp/` | Compaction prunes; `/workstream-clear` stops carrying a theme; `/job-cleanup` clears run-scoped artifacts |
| `.local/coordinator/tasks/` | Conditional candidate holding area | Gitignored **transport, not truth** — unpromoted candidates may be lost (intentionally) | Curated into `backlog.md` by the promoter only after trigger + Definition of Ready | Manual / lossy by design |
| `tmp/` (run-scoped scratch, `tmp/agent-runs/<alias>/`) | Disposable run artifacts | Gitignored — never truth, never committed | Keep transient outputs here, never under `docs/` | `/job-cleanup` when the task completes |
| `docs/planning/archive/` | Retrieval-only history of moved-out rows | Committed (archived) | Populated by the normalizer on completion / cancellation | Terminal tier |

## Coordination Planes

Use three distinct planes instead of one overloaded coordinator:

| Plane | Purpose | Canonical examples |
| --- | --- | --- |
| Repo control plane | Shared truth and durable rules | `docs/planning/backlog.md`, `docs/checkpoints/`, `docs/coordination/` |
| Session/workstream plane | Local live state for current or cross-session work | `.opencode/state/sessions/`, `.opencode/state/workstreams/` |
| Runtime messaging plane | Optional fan-out/fan-in transport for long async work | `.local/coordinator/` runtime files, local dashboards, report queues |

The runtime messaging plane is deliberately subordinate to the repo control
plane. Transport is not truth.

## What Belongs Here

- role definitions
- lane definitions
- conflict and ownership rules
- prompt, closeout, and handoff templates
- blocker escalation rules
- launch checklists for cross-boundary work
- review defaults that other tool surfaces can mirror without becoming a second
  state system

## What Does Not Belong Here

- a second task ledger beside `docs/planning/backlog.md`
- a second blocker ledger beside backlog rows and checkpoints
- duplicate release inventories beside `docs/deployment/`
- live session scratch already owned by `.opencode/state/`
- secrets, private hostnames, tokens, or machine-only paths

## Task Modes

Coordination tasks should be classified before fan-out:

- `short`: 1-2 sessions, one owned slice, minimal fan-in
- `medium`: 3-6 sessions, planned handoffs, several reports, one synthesizer
- `long`: 6+ sessions or async/disconnected fan-in that benefits from a runtime
  messaging layer

Use:

- [TASK_MODES.md](TASK_MODES.md) for selection rules and escalation triggers
- [REPORT_ENVELOPES.md](REPORT_ENVELOPES.md) for the required report shapes
- [RUNTIME_MODEL.md](RUNTIME_MODEL.md) for the local runtime layout and the
  first A2A-shaped coordinator-runtime contract
- [schemas/task-card.schema.json](schemas/task-card.schema.json) for the local
  task-card contract used by `/write-task`, `/research`, `/task-ready`,
  `/task-update`, `/task-repair`, `/task-list`, `/resume-task`,
  `/task-closeout`, and `/task-review`

## Coordination Rules

1. Keep `docs/planning/backlog.md` as the only committed task-status source of
   truth. Agents edit it freely; commit backlog changes SEPARATELY from code so
   a concurrent backlog edit can never block a clean code commit. DEFER/p2
   follow-ups route to `.local/coordinator/tasks/` as conditional
   candidates, not direct backlog rows.
2. Keep `docs/checkpoints/` as the durable record for meaningful blockers,
   decisions, and closeouts.
3. Keep `.opencode/state/` as local runtime coordination state.
4. Keep `.local/coordinator/` local-only and operator-specific.
5. Keep the coordinator thin. Use it to route work, not to replace boundary
   ownership or absorb concrete task detail.
6. **All coding modifications, implementation, research, study, and git operations
   MUST be delegated to the appropriate subagent, command, or execution session.**
   The coordinator must remain read-only. The default delegation target is `build`,
   which owns the execution context and may hand off to other specialists as needed.
   Direct delegation to a narrower specialist (`commit-message`, `researcher`, `planner`,
   `ship-review`, etc.) is acceptable only when the scope is narrow and clearly
   scoped to that specialist's boundary. The coordinator MUST NOT directly edit
   code, run `git add`/`git commit`/`git checkout`, write new files to `packages/`,
   or perform inline research that belongs in a researcher session.
7. For medium and long tasks, use structured report envelopes instead of freeform
   chat summaries.
8. Commit backlog SEPARATELY from code each cycle (hybrid split-commit). At
   fan-in, one synthesizer writes the durable closeout in `docs/checkpoints/`,
   not every worker. DEFER/p2 candidates are curated into the backlog by the
   promoter only after trigger + Definition of Ready.
9. When a coordination change alters durable operating rules, update the
   matching OpenCode or GitHub instruction surface in the same slice.

## Tool Mirrors

Keep reusable coordination behavior aligned across the surfaces that actually
invoke it:

| Surface | Location | Purpose |
| --- | --- | --- |
| OpenCode commands | `.opencode/commands/` | Native repo workflows such as `/coordination`, `/write-task`, `/research`, `/solution-brief`, `/task-ready`, `/task-update`, `/task-repair`, `/task-list`, `/resume-task`, and `/commit-review`. |
| OpenCode primary agents | `opencode.jsonc`, `.opencode/agents/` | Direct chat modes such as `build`, `plan`, and the read-only `coordination` entrypoint. |
| OpenCode subagents | `.opencode/agents/` | Delegated specialists such as `project-coordinator`, `researcher`, `debate`, `commit-message`, `commit-reviewer`, and `ship-review`. |
| Copilot path instructions | `.github/instructions/` | File-scoped GitHub/Copilot guidance that mirrors boundary-specific review rules. |
| Copilot prompt files | `.github/prompts/` | Reusable IDE prompt entrypoints for coordination and file-list review. |

## Review roles

Two distinct review shapes travel under the word "review"; keeping them
separate prevents a deliberation from being mistaken for an authorization:

- **Approval** — a permit / reject / defer decision that **gates** a
  transition. It is an authorization event: the transition does not proceed
  until the approval is granted. Commit, task-promotion, and task-review gates
  are approvals.
- **Panel** — structured deliberation that **informs** a later decision but
  carries no direct transition authority. Its output is a recommendation or
  synthesis, not a permit. Research, debate, planning, and ship-review
  deliberation are panels.

Both can feed an approval, but neither **is** the approval: a panel may
recommend "approve," but the approval still has to fire through its own gate.

## Default Flow

For cross-boundary work:

1. Open `docs/planning/backlog.md` and `docs/planning/current-index.md`.
2. Start or reopen the OpenCode session with `/session-start <slug>`.
3. Classify the task as `short`, `medium`, or `long`.
4. Bind a workstream if the theme will span multiple sessions.
5. Use `coordination`, `/coordination`, or the `project-coordinator` subagent to
   pick the lane, specialist, prompt shape, and report envelope, then hand the
   concrete slice off promptly so the coordinator stays thin.
6. Record durable state in backlog rows and checkpoints, not in new ad hoc
   ledgers.

For `short` tasks, treat coordination as a routing consult, not a standing work
session. Once the next owner is clear, stop at one concrete handoff instead of
continuing with execution planning in coordinator context.

For self-managed execution tasks that should survive chat compaction but remain
local-only:

Keep the coordinator session limited to routing, task-card shaping, review, and
fan-in. Once a task card or owning specialist exists, do not keep detailed
execution notes in the coordinator context.

1. Use `/coordination` or the coordinator session to shape the slice.
2. Save implementation or study slices with `/write-task`.
3. Save new research slices with `/research` instead of generic `/write-task`.
4. If the slice is still exploratory, keep it in `draft`.
5. Promote the draft with `/task-ready <id>` once it becomes execution-ready.
6. Use `/task-update <id>` when the card metadata should change without moving
   lifecycle state, but keep broad contract edits in `draft|ready`, owner-only
   edits in `working`, and narrow follow-up edits in `reported|blocked`.
7. If a research task card is incomplete but should keep its current lifecycle
   state, repair it with `/task-repair <id>`.
8. Open a fresh execution session and run `/resume-task <id>`.
9. If the task is already `working` under another session alias, resume only
   from that same alias unless you explicitly intend a takeover.
10. End the execution session with `/task-closeout <id>`.
11. Return to the coordinator session and start with `/task-list`.

Do not keep extending the coordinator thread after step 8 unless the user
explicitly wants a subagent prompt or a synthesis pass. The task card plus
`/resume-task` is the handoff boundary.

For research-heavy work:

1. Use `/research` instead of generic `/write-task` when source policy, durable
   artifact targeting, or long-run workstream setup matters.
2. Keep the coordinator thin and push source-gathering or option synthesis into
   the read-only researcher; let the command and task registry own durable
   setup.
3. When a question is still contested after the initial research frame, prefer
   `/solution-brief <question>` as the thin read-only wrapper for
   `researcher -> debate -> planner` instead of turning the coordinator thread
   into a long compare-and-plan session.
   Example: `/solution-brief For long-running evaluation orchestration, should the repo prefer a repo-local skill, coordinator task cards, or a thin command wrapper over existing specialists?`
   Reference: `docs/coding-agent-in-research/solution-brief/README.md`
4. Use `long` mode when the research should survive interruption, several
   source passes, or delayed synthesis.
5. Use `/task-update <id>` for broader metadata edits that should not change the
   current lifecycle state, while respecting the lifecycle-aware mutability
   guards.
6. Use `/task-repair <id>` if a legacy or partial research card must be repaired
   before it can resume cleanly.
7. If the research card is `ready`, stop the coordinator response at the single
   handoff command `/resume-task <id>` unless the user explicitly asks for a
   subagent prompt.
8. Decide the next move with `/task-review <id>`.

## Local Overlay

The suggested local overlay is:

```text
.local/coordinator/
  AGENTS.md
  ACTIVE_SESSIONS.md
  WAITING_ON.md
  LOCAL_OVERRIDES.example.yaml
  tasks/
  reports/
  dashboards/
  scratch/
```

That overlay is intentionally private and gitignored. See
[RUNTIME_MODEL.md](RUNTIME_MODEL.md) for the first runtime layout and the
transport-versus-truth rules.
