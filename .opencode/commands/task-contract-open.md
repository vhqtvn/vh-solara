---
description: Open the stable task contract for the active OpenCode session
agent: build
subtask: true
---

Open the active session's task contract.

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- call `plan_state` with:
  - `operation: read_task_contract`
  - `include_body: true`

Return:
- task contract version and paths
- the contract summary
- the full contract body

For git operations, follow `.opencode/docs/git-execution-routing.md`.
