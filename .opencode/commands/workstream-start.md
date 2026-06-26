---
description: Bind the active OpenCode session to a cross-session workstream and initialize its local memory files without overwriting existing context by default
agent: build
subtask: false
---

Start or reopen a workstream for the active OpenCode session.

Workstream slug:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- call `plan_state` with `operation: workstream_overview` for `$ARGUMENTS` before writing anything
- extract only stable cross-session context from the latest user request, current task, and explicit clarifications:
  - workstream goal
  - why this theme should survive many sessions
  - the next concrete slice after the current task
  - open questions that still matter across sessions
  - rejected options or anti-patterns worth not rediscovering
  - key docs, checkpoints, or codepaths to reopen later
- do not copy volatile task progress or a full execution log into the workstream files
- preserve any existing meaningful workstream file content by default
- only pass `replace_existing: true` when the user explicitly wants to reset or overwrite existing workstream files
- call `plan_state` with:
  - `operation: init_workstream_memory`
  - `workstream_name: $ARGUMENTS`
  - `brief_body`
  - `next_slice_body`
  - `open_questions_body`
  - `rejected_options_body`
  - `links_body`
  - `replace_existing: true` only for an explicit reset

Return:
- active session alias
- active workstream name
- whether the workstream already existed
- initialized, replaced, and preserved targets
- workstream dir
- file paths
- the smallest safe next command, usually `/workstream-open`, `/workstream-update`, or `/checkpoint-save`

For git operations, follow `.opencode/docs/git-execution-routing.md`.
