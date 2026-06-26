---
description: Reopen the latest or selected session checkpoint together with the current memory overview
agent: build
subtask: true
---

Open a session checkpoint for the active OpenCode session.

Selector:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- call `plan_state` with `operation: read_task_contract` and `include_body: true`
- call `plan_state` with `operation: memory_overview`
- call `plan_state` with:
  - `operation: read_checkpoint`
  - `selector: $ARGUMENTS` if present, otherwise omit it or pass an empty string
  - `include_body: true`

Return:
- the current task contract version, path, and body
- the resolved checkpoint id, title, and path
- the checkpoint body
- the active workstream name when one is bound
- the workstream brief and next-slice summaries when they are present
- the current memory file paths
- the latest open questions, recent decisions, or workstream-side open questions when relevant

For git operations, follow `.opencode/docs/git-execution-routing.md`.
