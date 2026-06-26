---
description: Open one local coordination task card and summarize its latest state
agent: build
subtask: false
---

Open one local coordination task card.

Task id:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- call `plan_state` with:
  - `operation: read_coordination_task`
  - `task_id: $ARGUMENTS`
- only if the user explicitly asks for the latest closeout body in full, call the same operation again with `include_body: true`
- summarize:
  - task title and status
  - task type, mode, lane, and report envelope
  - active session owner and claim time when the task is currently `working`
  - draft refinement context when status is `draft`
  - files in scope
  - backlog/workstream links
  - latest report path and summary, if present
  - latest review path and summary, if present
  - next action and next recommended command
  - the explanatory recommendation note whenever extra operational context matters
  - overlap warnings, if any

Return:
- task summary
- latest report summary or path
- overlap/conflict warnings
- next recommended command
- next recommended note, if any

For git operations, follow `.opencode/docs/git-execution-routing.md`.
