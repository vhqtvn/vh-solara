---
description: Clean up session-scoped temporary artifacts recorded for the active OpenCode session
agent: build
subtask: false
---

Clean up temporary artifacts for the active OpenCode session.

Retentions CSV:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- call `plan_state` with:
  - `operation: cleanup_artifacts`
  - `retentions_csv: $ARGUMENTS` if present, otherwise omit it or pass an empty string so the default cleanup policy applies

Return:
- deleted artifacts
- missing artifacts
- skipped artifacts and why they were skipped
- manifest path
- reminder to review `git status` after cleanup

For git operations, follow `.opencode/docs/git-execution-routing.md`.
