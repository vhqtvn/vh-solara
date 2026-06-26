---
description: Update or append to the active or selected workstream without rewriting unrelated memory
agent: build
subtask: false
---

Update a workstream for the active OpenCode session.

Selector:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- call `plan_state` with:
  - `operation: workstream_overview`
  - `workstream_name: $ARGUMENTS` if present, otherwise omit it or pass an empty string
- choose the smallest safe mutation:
  - use `append_workstream_note` for new `next_slice`, `open_questions`, `rejected_options`, or `links` entries
  - use `write_workstream_file` only when intentionally replacing the whole target, usually `brief` or a fully refreshed `next_slice`
- when appending, call `plan_state` with:
  - `operation: append_workstream_note`
  - `workstream_name: $ARGUMENTS` if present
  - `workstream_target`
  - `title` only when a section heading is helpful
  - `body`
- when replacing, call `plan_state` with:
  - `operation: write_workstream_file`
  - `workstream_name: $ARGUMENTS` if present
  - `workstream_target`
  - `body`

Return:
- active session alias
- active workstream name
- updated target and path
- whether the change was append or replace
- the smallest safe next command, usually `/workstream-open` or `/checkpoint-save`

For git operations, follow `.opencode/docs/git-execution-routing.md`.
