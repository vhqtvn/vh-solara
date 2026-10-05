---
description: Reopen the latest or selected session checkpoint together with the current memory overview
agent: build
subtask: true
---

Open a session checkpoint for the active OpenCode session.

Selector:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` (when one exists) for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not chase or fail when it is absent, and do not rediscover these from scratch when it is present.
- git mutations must flow through the `committer` agent via the gated-commit protocol **where `core/gated-commit` is selected**; on profiles without it, automated committing is unavailable — preserve the work, report the missing route, and request separately-authorized activation or operator handling (`.opencode/docs/git-execution-routing.md` → "Capability condition"). Load the `gated-commit` skill for details.
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

For git operations, follow `.opencode/docs/git-execution-routing.md` — including its "Capability condition" section (on profiles without `core/gated-commit` selected, automated committing is unavailable: preserve the work, report the missing route, and request separately-authorized activation or operator handling).
