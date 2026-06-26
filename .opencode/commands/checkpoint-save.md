---
description: Save a durable session checkpoint for compaction recovery and later reopening
agent: build
subtask: false
---

Save a concise checkpoint for the active OpenCode session.

Slug:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session` and stop if no session alias is bound
- call `plan_state` with `operation: read_task_contract` and `include_body: true`
- call `plan_state` with `operation: memory_overview` to inspect the current memory files and latest checkpoint
- if the user materially changed the mission, required outputs, or must-do steps since the last contract save, update the contract first with `operation: save_task_contract`
- extract the latest durable state from the current conversation:
  - what changed
  - the strongest evidence or outputs produced
  - the next step
  - any unresolved blocker
  - which contract obligations are now satisfied or still pending
- include a MANDATORY **Verification** section in the checkpoint body:
  ```markdown
  ## Verification
  | Claim | Verifying command/output | Verified |
  |-------|--------------------------|----------|
  | (each key claim about what changed) | (exact command or output that proves it) | yes/no |
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
- call `plan_state` with `operation: save_checkpoint` and provide:
  - `slug`: `$ARGUMENTS` if present, otherwise `checkpoint`
  - `title`: a short checkpoint title
  - `goal`: one-sentence task goal
  - `next_step`: the immediate next action
  - `body`: the compact checkpoint body
- if the conversation contains a material decision, also call `plan_state` with `operation: append_decision`

Return:
- saved checkpoint id and path
- task contract version in force for this checkpoint
- whether a decision-log entry was added
- the next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
