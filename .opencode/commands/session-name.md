---
description: Bind the current OpenCode session to a human-readable session name
agent: build
subtask: true
---

Bind the current OpenCode session to this session name:
$ARGUMENTS

- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.

Use the `plan_state` tool with:
- `operation`: `bind_session_name`
- `session_name`: `$ARGUMENTS`

If the tool fails, stop and relay the failure briefly.

Return:
- the active session name
- the OpenCode sessionID
- the next recommended command from this flow: `/plan-save <slug>` or `/plans`

For git operations, follow `.opencode/docs/git-execution-routing.md`.
