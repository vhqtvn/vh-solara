---
description: Create or update a local coordination task card under .local/coordinator/tasks/
agent: build
subtask: false
---

Create or update a local coordination task card.

Task details:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- call `plan_state` with `operation: current_session` so the result can record whether a coordinator session alias is already bound
- extract or infer a concrete task card from the latest user request and current conversation:
  - optional `task_id`
  - optional `status`: `draft | ready`
  - `title`
  - `task_type`: `implementation | study | research`
  - `coordination_mode`: `short | medium | long`
  - `primary_lane`
  - optional draft refinement fields:
    - `rough_scope`
    - `open_questions`
    - `ready_criteria`
  - `files_in_scope`
  - `constraints`
  - `non_goals`
  - `success_criteria`
  - `validation_plan`
  - optional `report_envelope`; default from mode when omitted:
    - `short -> minimal`
    - `medium -> standard`
    - `long -> synthesis`
  - optional `backlog_id`
  - optional `workstream_slug`
  - optional `dependencies`
  - optional `owner_notes`
    - for DEFER / p2-followup / review-defer conditional candidates, the Notes-prefix provenance lines (`source:...`, `trigger:...`, `studied:...`) MUST go here, one string per array element — `check-defer-triggers.js` reads them from `owner_notes[]` (NOT from the file body). `trigger:path_touched(<literal-repo-relative-path>)` is the most common predicate; the path is matched as a literal against `git diff --name-only` (no globbing).
  - optional `next_action`
- if the inferred task is a new `task_type: research`, stop and tell the user to use `/research` instead of `/write-task`
  - `/write-task` remains the generic entrypoint for `implementation` and `study`
  - for existing research cards, use `/task-update` for broader metadata edits or `/task-repair` for incomplete research-contract fields
- for `draft` tasks, require meaningful refinement material (`rough_scope`, `open_questions`, or `ready_criteria`)
- for `ready` tasks, require a real file scope and a real validation plan; do not save a vague execution card
- call `plan_state` with:
  - `operation: save_coordination_task`
  - `task_payload`: a JSON object with the task-card fields
- if overlaps are returned, call them out explicitly instead of burying them in prose
- keep the return compact; if the task is `short`, stop at one concrete next command instead of continuing with execution planning in the same coordinator response

Return:
- task id and local path
- status and report envelope
- files in scope
- overlap warnings, if any
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
