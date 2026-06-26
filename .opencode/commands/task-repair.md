---
description: Repair one incomplete local research task card without changing its lifecycle status
agent: build
subtask: false
---

Repair one incomplete local research task card.

Task id:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- call `plan_state` with:
  - `operation: read_coordination_task`
  - `task_id: $ARGUMENTS`
- stop if the task is not `task_type: research`
- identify the missing research-contract fields that must be repaired:
  - `research_question`
  - `source_policy`
  - optional `source_allowlist`
  - `desired_artifact_type`
  - `target_artifact_path`
- stop if the task already has a complete research contract; tell the user to use `/task-update <id>` for broader metadata changes instead
- preserve the current lifecycle status; this command repairs metadata and does not promote or resume the task
- call `plan_state` with:
  - `operation: repair_coordination_task`
  - `task_id: $ARGUMENTS`
  - `task_payload`: a JSON object containing only the missing research-contract fields to repair
- stop if the resulting task still lacks any required research-contract field

Return:
- task id and preserved status
- repaired research fields
- current next action
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
