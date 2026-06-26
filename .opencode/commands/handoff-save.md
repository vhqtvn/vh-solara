---
description: Save a subagent or cross-session handoff packet for the active session
agent: build
subtask: false
---

Save a handoff packet for the active OpenCode session.

Slug:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- call `plan_state` with `operation: read_task_contract`
- call `plan_state` with `operation: memory_overview`
- build a compact handoff that includes:
  - goal
  - current status
  - exact files or outputs that matter
  - constraints and non-goals from the task contract
  - the active workstream name and next-slice context when relevant
  - what should not be re-done
  - the immediate next step
- include a MANDATORY **Verification** section in the handoff body:
  ```markdown
  ## Verification
  | Claim | Verifying command/output | Verified |
  |-------|--------------------------|----------|
  | (each key claim from the handoff) | (exact command or output that proves it) | yes/no |
  ```
- include a **Structured Findings** section:
  ```markdown
  ## Findings
  - **(finding)**: source=..., confidence=high|medium|low, type=fact|assumption|inference
  ```
- include a **Contradiction Flags** line:
  ```markdown
  ## Contradictions
  <!-- List any contradictions encountered, or "None detected." -->
  ```
- call `plan_state` with `operation: save_handoff` and provide:
  - `slug`: `$ARGUMENTS` if present, otherwise `handoff`
  - `title`: a short handoff title
  - `target_agent`: when the destination specialist is clear
  - `next_step`
  - `body`

Return:
- saved handoff id and path
- target agent if one was named
- active workstream when one was bound
- the next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
