---
description: Review one task closeout from the coordinator side and record the next lifecycle decision
agent: build
subtask: false
---

Review one coordination task closeout from the coordinator side.

Task id:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- call `plan_state` with:
  - `operation: read_coordination_task`
  - `task_id: $ARGUMENTS`
  - `include_body: true`
- stop if no closeout report exists and there is nothing durable to review
- inspect the latest closeout against:
  - task scope
  - success criteria
  - validation plan
  - remaining blockers
  - whether any durable backlog/checkpoint promotion is still needed
- choose the next lifecycle state explicitly:
  - `ready` when follow-up implementation or study is required
  - `reported` when the report is acceptable but a manual promotion/decision still remains
  - `blocked` when the next move depends on an external blocker
  - `completed` when the task is actually finished
  - `cancelled` only when the task should stop permanently
- call `plan_state` with:
  - `operation: review_coordination_task`
  - `task_id: $ARGUMENTS`
  - `title`
  - `body`
  - `task_status`
  - `next_action`
- note that the coordinator review itself is also persisted as a local markdown artifact under the task report directory
- do not auto-edit backlog rows or checkpoints here; only recommend that promotion when justified

Return:
- task id and new status
- review summary
- review artifact path
- whether durable backlog/checkpoint promotion is still needed
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
