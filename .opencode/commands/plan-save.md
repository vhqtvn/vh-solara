---
description: Save the latest approved plan from the current conversation into the active session namespace
agent: build
subtask: false
---

Save the latest approved plan from the current conversation into the active session namespace.

Slug:
$ARGUMENTS

Rules:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- if there is no clear approved plan in the current conversation, say that explicitly and stop
- extract only the latest approved plan; do not invent missing requirements
- save only the plan body markdown; the tool adds frontmatter automatically
- first call `plan_state` with `operation: current_session` so you can fail clearly if no session alias is bound
- then call `plan_state` with:
  - `operation`: `save_plan`
  - `slug`: `$ARGUMENTS`
  - `body`: the extracted approved plan body
- if either tool call fails, stop and relay the failure briefly

After saving:
- report the new plan id
- report the active session name
- say whether the user should adopt it with `/adopt-plan <id>`
- if the conversation is still exploratory rather than approved, direct the user to `/draft-plan <slug>` instead

For git operations, follow `.opencode/docs/git-execution-routing.md`.
