---
description: Normalize the backlog structure and archive older done/cancelled history for on-demand retrieval
agent: docs-steward
subtask: true
---

Clean up the canonical backlog after task-state edits or when the user asks to reduce backlog noise.

Scope:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` (when one exists) for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not chase or fail when it is absent, and do not rediscover these from scratch when it is present.
- git mutations must flow through the `committer` agent via the gated-commit protocol **where `core/gated-commit` is selected**; on profiles without it, automated committing is unavailable — preserve the work, report the missing route, and request separately-authorized activation or operator handling (`.opencode/docs/git-execution-routing.md` → "Capability condition"). Load the `gated-commit` skill for details.
- inspect `docs/planning/backlog.md` and `docs/planning/archive/index.md` if it exists
- run `vh-agent-harness exec node .opencode/scripts/normalize-backlog.js`
- if the current work changed task states, review the resulting archive files and confirm the touched task IDs still point to the same notes, links, and verification details
- if the current work also changed other durable docs, run `/docs-sync ...` after backlog cleanup instead of skipping one or the other

Rules:
- preserve task IDs, notes, links, changed-files notes, and verification details exactly
- keep `todo`, `in_progress`, and `blocked` rows in the main backlog
- archive only older `done` and `cancelled` rows
- keep archive files readable on demand under `docs/planning/archive/`; do not move historical rows into `.opencode/state/`
- if the script reports duplicate IDs or invalid status placement, stop and fix the underlying backlog issue instead of hand-waving it away

Output:
- whether the main backlog changed
- archive files touched
- task IDs moved to archive, if any
- any remaining docs that still need `/docs-sync`

For git operations, follow `.opencode/docs/git-execution-routing.md` — including its "Capability condition" section (on profiles without `core/gated-commit` selected, automated committing is unavailable: preserve the work, report the missing route, and request separately-authorized activation or operator handling).
