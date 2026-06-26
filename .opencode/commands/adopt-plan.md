---
description: Mark a saved plan as the active plan for the current session
agent: build
subtask: true
---

Adopt this plan id or unique prefix for the current session:
$ARGUMENTS

- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.

Use the `plan_state` tool with:
- `operation`: `adopt_plan`
- `selector`: `$ARGUMENTS`

If the tool fails, stop and relay the failure briefly.

Return:
- the adopted plan id
- the active session name
- the next recommended command: `/implement`

For git operations, follow `.opencode/docs/git-execution-routing.md`.
