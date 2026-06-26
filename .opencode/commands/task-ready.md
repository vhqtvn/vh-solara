---
description: Promote one draft local coordination task into ready execution state
agent: build
subtask: false
---

Promote one draft local coordination task into ready execution state.

Task id:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- call `plan_state` with:
  - `operation: read_coordination_task`
  - `task_id: $ARGUMENTS`
- stop if the task is not `draft` or `ready`
- if the task only needs metadata edits while preserving its current lifecycle state, prefer `/task-update <id>` instead of overloading draft promotion
- if the task is `task_type: research` and is missing research-contract fields outside normal draft promotion, prefer `/task-repair <id>` when you need to repair the card without changing its lifecycle state
- extract or infer the execution-ready fields that are still missing:
  - `files_in_scope`
  - `success_criteria`
  - `validation_plan`
  - for `task_type: research`, also require any missing research-contract fields:
    - `research_question`
    - `source_policy`
    - optional `source_allowlist`
  - `desired_artifact_type`
  - `target_artifact_path`
  - optional updates to `constraints`, `non_goals`, `dependencies`, `owner_notes`, or `next_action`
- preserve refinement context such as `rough_scope`, `open_questions`, and `ready_criteria`; do not discard it just because the task is now ready
- call `plan_state` with:
  - `operation: ready_coordination_task`
  - `task_id: $ARGUMENTS`
  - `task_payload`: a JSON object containing any missing execution-ready fields, any missing research-contract fields for research tasks, plus optional metadata updates
- stop if the resulting task still lacks a real file scope, success criteria, or validation plan
- stop if a research task still lacks `research_question`, `source_policy`, `desired_artifact_type`, or `target_artifact_path`

Return:
- task id and updated status
- files in scope
- missing research fields repaired, if any
- remaining open questions, if any
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
