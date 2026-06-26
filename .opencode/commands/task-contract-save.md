---
description: Save or refresh the stable task contract for the active OpenCode session
agent: build
subtask: false
---

Save the active session's task contract.

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- extract only the stable requirements from the latest user request and any explicit follow-up clarifications:
  - mission
  - task type: classify as `research`, `implementation`, `benchmark/eval`, or `cleanup/finalization`
  - settled assumptions: what the prompt assumes to be true
  - exact user requirements
  - exact repo-local skill names when the task depends on them
  - must-read files or docs
  - must-do steps or phases
  - must-not-do constraints
  - required outputs, filenames, or paths
  - exact `Return:` block or final-response checklist when the user provides one, under a dedicated `Final Response Format` section
  - required commands or closeout steps
  - completion checklist
  - files likely to change (from user or inferred)
  - durable vs tmp output rules
- preserve the user's requested closeout headings, numbering, and item wording when they materially constrain the final answer
- do not copy volatile progress notes into the contract
- do not add a skill requirement unless the user asked for it or the workflow clearly depends on it for correctness, cost control, or operational safety
- call `plan_state` with:
  - `operation: save_task_contract`
  - `body`: a concise markdown contract with those sections

Return:
- task contract version and paths
- the strongest obligations captured
- whether the contract changed materially from the prior version

For git operations, follow `.opencode/docs/git-execution-routing.md`.
