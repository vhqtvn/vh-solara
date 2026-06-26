---
description: Update backlog, checkpoints, AGENTS.md, and durable docs after a change
agent: docs-steward
subtask: true
---

Synchronize durable project docs for this work:

$ARGUMENTS

Check and update as needed:
- docs/planning/backlog.md
- docs/checkpoints/
- docs/coordination/
- docs/ai/delivery-rules.md
- AGENTS.md
- .github/copilot-instructions.md
- .github/instructions/
- .github/prompts/

Rules:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- backlog is the source of truth for task state
- if `docs/planning/backlog.md` changed, or a task status moved to `done` / `cancelled`, run `vh-agent-harness exec node .opencode/scripts/normalize-backlog.js` before finishing so active sections stay clean and older history is archived deterministically
- summarize any archive files touched under `docs/planning/archive/`
- durable milestone snapshots belong in docs/checkpoints/
- do not put run-specific benchmark logs into docs/ai/
- keep `.github/instructions/` and `.github/prompts/` aligned with the durable
  coordination and review surfaces they mirror
- if docs mention repo-local skills, keep detailed workflow logic in `.opencode/skills/` and promote only the durable operator guidance humans need to remember
- record changed files and verification notes when moving work to done
- if blocked, record the exact blocker and next decision needed

Output:
- which docs changed
- what status changed
- any archive files changed
- any docs that still need human confirmation

For git operations, follow `.opencode/docs/git-execution-routing.md`.
