---
description: Prepare a grounded solution brief through researcher, debate, and planner
agent: build
subtask: false
---

Prepare a grounded solution brief for this question:

$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- before raising any previously-blocked topic, check `.local/cleared-assumptions.yaml`. `/solution-brief` may run without a current session task contract, so consult the cleared-assumptions ledger directly at this stage. If the operator has already cleared an assumption (for example, a license concern, a dependency constraint, or a tooling limitation), do not re-raise it as a new blocker.
- call the `solution-brief` subagent with the full question
- `solution-brief` is read-only; it chains `researcher` -> `debate` -> `planner`
  internally and returns a compact recommendation packet
- do not use this command for routine implementation requests, narrow factual
  lookups, or tasks that clearly need only `researcher` or `planner`
- if the task is likely non-trivial and no durable session is active yet, recommend
  `/session-start <slug>` before the next concrete execution step

Return:
- decision frame
- researcher packet summary
- debate recommendation and key objections
- planner brief
- confidence and remaining uncertainty
- next recommended command

Example invocations:
- `/solution-brief Should this repo express reusable compare-and-plan workflows as command wrappers, repo-local skills, or documented manual choreography?`
- `/solution-brief For long-running evaluation orchestration, should the repo prefer a repo-local skill, coordinator task cards, or a thin command wrapper over existing specialists?`

Reference:
- See `docs/coding-agent-in-research/solution-brief/README.md` for the live workflow note, reverse-escalation guidance, and linked research trail.

For git operations, follow `.opencode/docs/git-execution-routing.md`.
