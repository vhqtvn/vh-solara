---
description: Resume a local coordination task into the current execution session
agent: build
subtask: false
---

Resume a local coordination task into the current execution session.

Task id:
$ARGUMENTS

Workflow:
- call `plan_state` with:
  - `operation: read_coordination_task`
  - `task_id: $ARGUMENTS`
- stop if the task is `draft`, `completed`, or `cancelled`
- if the task is `draft`, tell the user to finish refinement and run `/task-ready <id>` first
- if the task is `task_type: research` and the recommendation note says research-contract fields are missing, stop and tell the user to run `/task-repair <id>` first
- if the task is already `working` under a different `active_session_alias`, stop unless the user explicitly asks to take over that active task
- call `plan_state` with `operation: current_session`
- if a different session alias is already bound and it is clearly unrelated to this task, stop and tell the user to open a fresh session instead of mixing two tasks into one alias
- if no session alias is bound, call `plan_state` with:
  - `operation: bind_session_name`
  - `session_name: <task-id>`
- if the task card names a `workstream_slug`, call `plan_state` with:
  - `operation: bind_workstream`
  - `workstream_name: <workstream_slug>`
- call `plan_state` with:
  - `operation: activate_coordination_task`
  - `task_id: $ARGUMENTS`
  - include `force_takeover: true` only when the user explicitly asks to take over an already-working task owned by another session alias
  - treat this transition as the moment when the task's `next_action` becomes
    the owned execution closeout step instead of any pre-execution setup text
- build a compact session brief from the task card:
  - title
  - task type
  - coordination mode
  - primary lane
  - files in scope
  - current next action
  - report envelope required at closeout
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- before raising any previously-blocked topic, check `.local/cleared-assumptions.yaml` for this workspace. At this point in the workflow the task contract may not yet have been refreshed for the resumed session, so use the cleared-assumptions ledger directly. If the operator has already cleared an assumption (for example, a license concern, a dependency constraint, or a tooling limitation), do not re-raise it as a new blocker.
- call `plan_state` with:
  - `operation: init_session_memory`
  - `brief_body`
  - `resolved_context_body`
  - `open_questions_body`
- call `plan_state` with:
  - `operation: save_task_contract`
  - `body`: a compact task contract built from the task card
    - mission: complete or advance the task card
    - user requirements: title, mode, lane, backlog/workstream links
    - must do: files in scope, success criteria, validation plan
    - must not do: constraints and non-goals
    - required outputs: code/doc changes plus the local closeout report under `.local/coordinator/reports/<task-id>/`
    - final response format: summarize the work, files changed, validation, blockers/follow-up, and whether `/task-closeout` was saved
    - required commands: include `/task-closeout <task-id>` before ending the session
- call `plan_state` with:
  - `operation: resolve_paths`
  - `path_refs`: JSON array built from `files_in_scope`
- call `plan_state` with:
  - `operation: save_checkpoint`
  - `slug: resume`
  - `title: Resume Task`
  - `goal`: one-sentence task goal from the card
  - `next_step`: the first execution step
  - `body`: a compact resume snapshot with scope, constraints, validation plan, and required closeout path

Return:
- active session alias
- task id and updated status
- workstream binding, if any
- task contract path and version
- resume checkpoint id and path
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
