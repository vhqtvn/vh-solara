---
description: Save a durable local closeout report for one coordination task and checkpoint the execution session
agent: build
subtask: false
---

Save a durable local closeout report for one coordination task.

Task id:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- call `plan_state` with `operation: current_session` and stop if no session alias is bound
- call `plan_state` with:
  - `operation: read_coordination_task`
  - `task_id: $ARGUMENTS`
- stop if the task is not currently `working`
- stop if the task is currently `working` but owned by a different `active_session_alias`
- use the task card's `report_envelope` to shape the closeout:
  - `minimal` for short work
  - `standard` for normal execution slices
  - `synthesis` only when the task actually gathered or reconciled multiple reports
- choose the closeout status carefully:
  - `completed` only when the task is truly finished
  - `blocked` when the next action depends on an unresolved blocker
  - otherwise `reported`
- extract the durable closeout from the current conversation:
  - what changed
  - files touched
  - validation run
  - blockers or remaining risks
  - next action
  - whether promotion into backlog/checkpoints is recommended later
  - optional `measured_outcome`: the actual result (vs any `predicted_impact` recorded at ready-time), captured here at closeout-time (skip for routine slices)
- call `plan_state` with:
  - `operation: save_coordination_task_closeout`
  - `task_id: $ARGUMENTS`
  - `title`
  - `body`
  - `task_status`
  - `report_envelope`
  - `promotion_recommended`
  - `next_action`
  - `measured_outcome` (optional)
- call `plan_state` with:
  - `operation: save_checkpoint`
  - `slug: task-closeout`
  - `title: Task Closeout`
  - `goal`: one-sentence task goal
  - `next_step`: the next action handed back to the coordinator
  - `body`: a compact checkpoint noting the saved closeout, status, validation, and follow-up
- do not edit `docs/planning/backlog.md` or `docs/checkpoints/` automatically from this command

Return:
- task id and updated status
- closeout report path
- whether promotion into durable repo canon is recommended
- checkpoint id and path
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
