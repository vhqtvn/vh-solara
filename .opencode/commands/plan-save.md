---
description: Save the latest approved plan from the current conversation into the active session namespace
agent: build
subtask: false
---

Save the latest approved plan from the current conversation into the active session namespace.

Slug:
$ARGUMENTS

Rules:
- consult `docs/ai/codebase-operational-primitives.md` (when one exists) for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not chase or fail when it is absent, and do not rediscover these from scratch when it is present.
- git mutations must flow through the `committer` agent via the gated-commit protocol **where `core/gated-commit` is selected**; on profiles without it, automated committing is unavailable — preserve the work, report the missing route, and request separately-authorized activation or operator handling (`.opencode/docs/git-execution-routing.md` → "Capability condition"). Load the `gated-commit` skill for details.
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

For git operations, follow `.opencode/docs/git-execution-routing.md` — including its "Capability condition" section (on profiles without `core/gated-commit` selected, automated committing is unavailable: preserve the work, report the missing route, and request separately-authorized activation or operator handling).
