---
description: Update local coordination task metadata without changing lifecycle state
agent: build
subtask: false
---

Update one local coordination task card without changing its lifecycle state.

Task id:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- call `plan_state` with:
  - `operation: read_coordination_task`
  - `task_id: $ARGUMENTS`
- stop if the task is `task_type: research` and still lacks any required research-contract field; tell the user to run `/task-repair <id>` first
- enforce the lifecycle-aware update policy:
  - `draft | ready`: broader task-contract metadata may change
  - `working`: only the active owner session may update `owner_notes` or `next_action`
  - `reported | blocked`: only narrow follow-up fields such as `owner_notes` or `next_action` may change
  - `completed | cancelled`: stop; the task is frozen
- identify the metadata that should change while preserving lifecycle state:
  - optional `title`
  - optional `coordination_mode`
  - optional `primary_lane`
  - optional draft/refinement context:
    - `rough_scope`
    - `open_questions`
    - `ready_criteria`
  - optional execution scope:
    - `files_in_scope`
    - `constraints`
    - `non_goals`
    - `success_criteria`
    - `validation_plan`
    - `report_envelope`
  - optional coordination links:
    - `backlog_id`
    - `workstream_slug`
    - `dependencies`
    - `owner_notes`
    - `next_action`
  - optional assessment fields (both skip-for-routine-slices):
    - `predicted_impact` (draft | ready only)
    - `measured_outcome` (reported | blocked only)
  - for `task_type: research`, optional research metadata:
    - `research_question`
    - `source_policy`
    - optional `source_allowlist`
    - `desired_artifact_type`
    - `target_artifact_path`
- do not change lifecycle status, active owner, reports, or reviews
- do not change `workstream_slug`, `report_envelope`, `files_in_scope`, `success_criteria`, or `validation_plan` after execution has started
- call `plan_state` with:
  - `operation: update_coordination_task`
  - `task_id: $ARGUMENTS`
  - `task_payload`: a JSON object containing only the metadata fields that should change

Return:
- task id and preserved status
- updated metadata fields
- current next action
- next recommended command
- next recommended note, if any

For git operations, follow `.opencode/docs/git-execution-routing.md`.
