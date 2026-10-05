---
description: Detach the active OpenCode session from its current workstream without deleting workstream files
agent: build
subtask: false
---

Clear the active workstream binding for the current OpenCode session.

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` (when one exists) for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not chase or fail when it is absent, and do not rediscover these from scratch when it is present.
- git mutations must flow through the `committer` agent via the gated-commit protocol **where `core/gated-commit` is selected**; on profiles without it, automated committing is unavailable — preserve the work, report the missing route, and request separately-authorized activation or operator handling (`.opencode/docs/git-execution-routing.md` → "Capability condition"). Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- if no active workstream is currently bound, return that nothing changed
- otherwise call `plan_state` with `operation: clear_workstream`

Return:
- active session alias
- previous workstream name
- confirmation that the workstream files were not deleted
- the smallest safe next command, usually `/workstream-start <slug>`, `/checkpoint-save`, or the task’s next plan step

For git operations, follow `.opencode/docs/git-execution-routing.md` — including its "Capability condition" section (on profiles without `core/gated-commit` selected, automated committing is unavailable: preserve the work, report the missing route, and request separately-authorized activation or operator handling).
