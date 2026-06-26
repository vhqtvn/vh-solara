---
description: Open the active or selected workstream overview for the current OpenCode session
agent: build
subtask: true
---

Open a workstream for the active OpenCode session.

Selector:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- call `plan_state` with:
  - `operation: workstream_overview`
  - `workstream_name: $ARGUMENTS` if present, otherwise omit it or pass an empty string

Return:
- active session alias
- resolved workstream name
- linked sessions when relevant
- workstream dir and file paths
- brief and next-slice summaries
- whether there are open questions or rejected options worth reopening now

For git operations, follow `.opencode/docs/git-execution-routing.md`.
