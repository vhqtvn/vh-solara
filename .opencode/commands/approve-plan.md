---
description: Approve a saved draft into the current session plan namespace
agent: build
subtask: true
---

Approve this draft slug into the current session plan namespace:
$ARGUMENTS

- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.

Use the `plan_state` tool with:
- `operation`: `approve_draft`
- `slug`: `$ARGUMENTS`

If the tool fails, stop and relay the failure briefly.

Return:
- the approved plan id
- the draft path that was approved
- the active session name
- whether `/implement` can use it immediately or whether `/adopt-plan <id>` is still recommended

For git operations, follow `.opencode/docs/git-execution-routing.md`.
