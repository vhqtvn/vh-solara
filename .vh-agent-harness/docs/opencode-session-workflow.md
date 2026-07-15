# OpenCode Session Workflow

Use this workflow for any non-trivial OpenCode task that may span multiple turns, evaluations, or specialist handoffs.

For the full layered memory model, see `vh-agent-harness docs opencode-memory-model`.

## Prompt structure

Non-trivial prompts should be classified by task type and include structured fields. See `vh-agent-harness docs opencode-prompt-guide` for the full template set.

Treat long prompts as two layers:

- **stable contract**: mission, assumptions, scope fences, constraints, likely files, durable/tmp rules, and closeout expectations that must survive compaction
- **execution scaffold**: must-read docs, kickoff commands, phase order, checkpoint cadence, and cleanup steps that help the session start cleanly

Required fields for all non-trivial prompts:
- **task type**: use this to select the right workflow (`research`, `implementation`, `evaluation`, or `cleanup/finalization`).
- **mission**: the primary goal of the session.
- **settled assumptions**: treat these as ground truth. Do not waste compute verifying them unless explicitly asked. If you discover a contradiction between these and the codebase, flag it explicitly before proceeding.
- **closeout expectations**: treat this as a strict checklist. The task is not finished until every item is returned.

Additional required fields when the task changes files:
- **exact files likely to change**: list these before editing starts. Confirm or extend this list before making modifications.
- **durable vs tmp output rules**: commit only durable docs. Keep all transient outputs under `tmp/agent-runs/<alias>/`.

Additional required fields for evaluation tasks:
- **evidence tier**: do not make strong claims from thin or smoke-only evidence; state the sample/coverage the claim rests on.
- **per-slice breakdown**: report results per relevant slice rather than a single aggregate when the aggregate can hide regressions.
- **decision scope**: limit recommendations to the stated scope (promotion, rollback, config swap, or exploratory only).

Strongly recommended fields for substantial tasks:
- **in scope**
- **out of scope / non-goals**
- **constraints**
- **success criteria**
- **must-read files / before doing anything else**
- **important framing / decision rule**
- **execution phases**

Strongly recommended fields for evaluation tasks:
- **acceptance standard**: characterize, match, exceed, tolerance-based, or exploratory only
- **primary metrics / gates**: the pass/fail metrics that matter more than secondary diagnostics

## Recommended kickoff block

For longer tasks, prefer an explicit bootstrap block near the top of the prompt:

```text
/session-start <alias>
/workstream-start <slug>   # only for broader long-lived themes
/task-contract-save        # refresh if the kickoff contract needs cleaner structure

Before doing anything else:
- read and follow AGENTS.md
- read and follow opencode.jsonc
- use docs/planning/backlog.md
- /checkpoint-open
- /workstream-open         # only when a workstream already matters
```

Use only the parts that materially matter. Small tasks do not need this much ceremony, and isolated tasks do not need workstream commands.

## Default flow

1. Run `/session-start <alias>` before substantial work. This already captures an initial task contract, resolved-context stub, kickoff checkpoint, and `tmp/agent-runs/<alias>/`.
2. If the task belongs to a broader long-lived theme, run `/workstream-start <slug>` and reopen it with `/workstream-open` when relevant.
3. Use `/task-contract-save` to refresh or tighten the stable contract after clarification, or immediately after kickoff when you want the contract rewritten in a cleaner durable shape. Do not use it for volatile progress notes.
4. Keep the approved implementation plan under the active session with `/draft-plan`, `/approve-plan`, `/plan-save`, and `/implement`.
   - For high-uncertainty read-only direction-finding, prefer `/solution-brief <question>` as the thin wrapper for `researcher -> debate -> planner` before writing or adopting an implementation plan.
     Example: `/solution-brief Should this reusable workflow live as a command wrapper, a repo-local skill, or documented manual choreography?`
     Use `think-mode` when the read-only workflow shape is not obvious.
5. Save durable state transitions with `/checkpoint-save <slug>`.
6. Save specialist handoff packets with `/handoff-save <slug>` before delegating or pausing.
7. Clean session-scoped temporary artifacts with `/job-cleanup` when the task is complete.
8. If the task changed backlog state or other durable docs, run `/docs-sync ...`; use `/backlog-cleanup` when you need to normalize/archive backlog history explicitly.

Optional between steps 1 and 3:

- if the workstream already exists or may already contain relevant context, reopen it with `/workstream-open` before editing that theme
- use `/workstream-update` for incremental cross-session notes and `/workstream-clear` when the session should stop carrying theme context

## Coordinator-managed local tasks

When the work is being routed through the local coordinator overlay under
`.local/coordinator/`, keep the control-room flow explicit:

The coordinator is strictly read-only. After routing and task-card shaping, ALL
concrete implementation, research, study, review, and git operations MUST be
delegated to a specialist subagent or `/resume-task` execution session. Return to
coordinator only for fan-in, review synthesis, or blocker shaping. The coordinator
MUST NOT directly edit code, run git mutations, or perform inline research that
belongs in a worker session.

1. use `/coordination` for read-only routing and mode selection
2. use `/write-task` for implementation or study task cards
3. use `/research` for new research task cards that need explicit source policy,
   artifact targets, or resumable local persistence
4. if the task is still in coordinator-side refinement, keep it as `draft`
5. use `/task-ready <id>` once the task has a real file scope, success criteria, and validation plan
6. use `/task-update <id>` when the task metadata should change without moving lifecycle state; keep broad edits in `draft|ready`, owner-only updates in `working`, and narrow follow-up fields in `reported|blocked`
7. if a research task card is incomplete but should keep its current lifecycle state, use `/task-repair <id>`
8. open a fresh execution session and run `/resume-task <id>`
9. if the task is already `working` under another session alias, continue from that same alias unless you explicitly intend a takeover
10. do the work in that execution session
11. end with `/task-closeout <id>` to persist the local report
12. return to the coordinator session and start with `/task-list`
13. use `/task-review <id>` for the specific reported or blocked slice

For `short` mode, stop the coordinator response at step 8 once the handoff is
clear. Do not keep expanding execution plans in coordinator context unless the
user explicitly asks for a worker prompt.

For research tasks, prefer this variant:

1. use `/research` when the task needs explicit source policy, target artifact,
   or long-run workstream setup
2. keep the coordinator out of source accumulation, keep the researcher
   read-only, and let the task card/workstream own the resumable state
3. use `/task-update <id>` for broader metadata adjustments that should not
   change lifecycle state, while respecting the lifecycle-aware update guards
4. use `/task-repair <id>` when a legacy or partial research card must be fixed
   before it can resume cleanly
5. use `/resume-task <id>` in a fresh execution session once the research task
   is ready; for `short` research, end the coordinator turn there unless the
   user explicitly wants a worker prompt
6. for `long` research, checkpoint after the plan is accepted and after each
   major source batch

Do not use ordinary chat summaries as the only coordination record when the
task should survive session churn. Persist it through the task card and local
report path instead.

The local OpenCode plugin surface may also emit non-blocking coordination toasts
after edits when a turn crosses coordination boundaries or grows a code file too
far. Treat these as hints, not policy overrides.

## Skill rule

- Repo-local OpenCode skills are optional helpers, not guaranteed automatic behavior.
- If a task depends on a local skill for correctness, cost control, or operational safety, name it explicitly in the prompt, task contract, or plan.
- Keep the skill catalog read-when-relevant; do not load it into baseline instructions by default just to improve recall.
- See `vh-agent-harness docs opencode-skills` for the current repo-local skill catalog and when manual invocation is worth doing.

## Contract rules

- Treat the task contract as more stable than the plan or the latest checkpoint.
- Use it to capture the mission, exact user requirements, scope fences, constraints, success criteria, must-read files, must-do steps, required outputs, required commands, and non-goals.
- Use `Required outputs` for concrete deliverables, paths, and filenames. Use `Final response format` for the exact closeout schema when the user supplies a `Return:` block or numbered final checklist, and preserve that structure verbatim.
- If the user specifies likely files to change, durable vs tmp output rules, acceptance standards, or primary evaluation gates, keep those explicit in the contract instead of leaving them implied in phase text.
- Do not leave closeout expectations only in chat history. If the agent would need that list after compaction, it belongs in the contract.
- Update it only when the user materially changes the task. Do not rewrite it just because progress changed.
- Keep volatile progress, findings, and decision summaries in checkpoints and the decision log instead of bloating the contract.
- Definition of Done items must be verifiable. Prefer Yes/No conditions tied to files, commands, tests, artifacts, or explicit decision outputs. Avoid vague phrases such as "works," "looks good," "cleaned up," or "done properly" unless paired with observable evidence.

## Memory rules

- Compaction is aggressive. Do not rely on chat history alone for long tasks.
- Put small, durable session memory under `.opencode/state/sessions/<alias>/memory/`.
- Put bulky, disposable outputs under `tmp/agent-runs/<alias>/`.
- Record important outputs in the session artifact manifest before expecting to revisit them later.

## Workstream rules

- If the work belongs to a long-lived theme that should survive many sessions, bind the session to a workstream with `/workstream-start <slug>`.
- Use workstreams for themes such as restructure planning, skill creation, migration shape, or evaluation strategy, not for every small task.
- Treat `/workstream-start` as safe reopen/init. It should preserve meaningful existing workstream files unless the user explicitly asks to reset them.
- Prefer `/workstream-update` for appending next-slice items, open questions, rejected options, or links instead of rewriting whole files.
- Keep only the workstream `brief.md` and `next-slice.md` eligible for compaction or routine loading.
- Keep `open-questions.md`, `rejected-options.md`, and `links.md` retrieval-only unless they materially change the next action.
- Do not use workstreams as a second plan system. Plans stay session-scoped; workstreams stay theme-scoped.
- Use `/workstream-clear` when the task no longer belongs to the active theme and the session should stop carrying that context forward.
- Promote stable shared rules out of `.opencode/state/` into committed docs instead of growing workstream memory indefinitely.

## Path rules

- Do not trust dated or user-supplied file paths blindly.
- Resolve each important path to `exact`, `replaced`, or `missing` and save that mapping in `resolved-context.md`.
- Prefer stable entrypoints such as `docs/planning/backlog.md` and `docs/checkpoints/` when locating current planning or checkpoint context.

## Checkpoint rules

Checkpoint at these moments:
- kickoff
- after a major finding or decision
- before a long-running evaluation or job
- before a specialist handoff
- before commit or closeout

Keep checkpoints short and decision-oriented, and note which contract obligations are now satisfied or still pending.

Every checkpoint MUST include a **Verification** table:
```markdown
## Verification
| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| (each key claim) | (exact command or output that proves it) | yes/no |
```

Each claim in the checkpoint must have a corresponding verification row. Unverified claims must be marked `no` with a note on what still needs to be checked.

Include a **Structured Findings** section to help downstream sessions assess evidence quality:
```markdown
## Findings
- **(finding)**: source=..., confidence=high|medium|low, type=fact|assumption|inference
```

**Contradiction flags** must be explicit, never silently omitted:
```markdown
## Contradictions
<!-- List any contradictions encountered, or "None detected." -->
```

Before commit-specific checkpoints, run the commit reviewer on the exact change
slice (normally via `/commit-review`) and read its response. If the reviewer
marks the slice blocked or recommends split, do not proceed to `git commit`
until the blocking issues are resolved or the slice is re-scoped.

When a prompt uses explicit phases, checkpoint at the phase boundaries that change the durable story: a gate definition, a protocol decision, a promotion/rollback recommendation, or a pre-closeout state change. Do not checkpoint every trivial substep.

When a checkpoint records a material decision in the decision log, that entry should cross-reference the Verification-table row that grounded it and name the downstream artifact or checkpoint it authorizes — this carries the dependency link as prose, since the `episodic` record type already covers such remembered decisions and no new record type is introduced.
