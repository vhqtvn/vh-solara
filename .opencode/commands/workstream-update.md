---
description: Update or append to the active or selected workstream without rewriting unrelated memory
agent: build
subtask: false
---

Update a workstream for the active OpenCode session.

Selector:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` (when one exists) for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not chase or fail when it is absent, and do not rediscover these from scratch when it is present.
- git mutations must flow through the `committer` agent via the gated-commit protocol **where `core/gated-commit` is selected**; on profiles without it, automated committing is unavailable — preserve the work, report the missing route, and request separately-authorized activation or operator handling (`.opencode/docs/git-execution-routing.md` → "Capability condition"). Load the `gated-commit` skill for details.
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

For git operations, follow `.opencode/docs/git-execution-routing.md` — including its "Capability condition" section (on profiles without `core/gated-commit` selected, automated committing is unavailable: preserve the work, report the missing route, and request separately-authorized activation or operator handling).
