---
description: Save the latest clear plan from the current conversation as a session-scoped draft
agent: build
subtask: false
---

Save the latest clear plan from the current conversation as a draft under `.opencode/plans/<session-name>/`.

Slug:
$ARGUMENTS

Rules:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- if there is no clear plan in the current conversation, say that explicitly and stop
- do not require the plan to be approved yet
- extract only the latest concrete plan body; do not invent missing requirements
- if the plan depends on a repo-local skill workflow, name the exact skill in the draft instead of assuming OpenCode will select it automatically
- first call `plan_state` with `operation: current_session` so you can fail clearly if no session alias is bound
- then call `plan_state` with:
  - `operation`: `save_draft`
  - `slug`: `$ARGUMENTS`
  - `body`: the extracted plan body
- if either tool call fails, stop and relay the failure briefly

After saving:
- report the draft slug and path
- report the active session name
- recommend `/approve-plan <slug>` when the draft is ready

For git operations, follow `.opencode/docs/git-execution-routing.md`.
