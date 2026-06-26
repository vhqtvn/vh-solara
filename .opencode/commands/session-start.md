---
description: Initialize a compaction-aware OpenCode session with a stable task contract, memory files, artifact workspace, and kickoff checkpoint
agent: build
subtask: false
---

Start this task as a durable OpenCode session.

Session slug:
$ARGUMENTS

Workflow:
- first call `plan_state` with `operation: bind_session_name` and `session_name: $ARGUMENTS`
- capture the stable task contract from the latest user request and current conversation before doing anything else:
  - mission
  - task type: classify as `research`, `implementation`, `benchmark/eval`, or `cleanup/finalization`
  - settled assumptions: what the prompt assumes to be true (so the agent can verify or flag contradictions)
  - exact user requirements
  - exact repo-local skill names when the task depends on them
  - must-read files or docs
  - must-do steps or phases
  - must-not-do constraints
  - required outputs, filenames, or paths
  - exact `Return:` block or final-response checklist when the user provides one, under a dedicated `Final Response Format` section
  - required commands or closeout steps
  - completion checklist
  - keep the user-provided checklist numbering and wording instead of collapsing it into a vague summary
  - do not invent obligations the user did not ask for
- do not invent a skill requirement unless the user asked for it or the workflow clearly depends on it for correctness, cost control, or operational safety
- call `plan_state` with `operation: save_task_contract` and provide a concise markdown contract with those sections
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- before raising any previously-blocked topic, check `.local/cleared-assumptions.yaml` for this workspace. Although `save_task_contract` materializes cleared assumptions into the contract payload, no explicit read step follows, so consult the cleared-assumptions ledger directly. If the operator has already cleared an assumption (for example, a license concern, a dependency constraint, or a tooling limitation), do not re-raise it as a new blocker.
- capture the latest user goal and constraints in a short session brief
- resolve any repo path references from the latest user request and current conversation:
  - call `plan_state` with `operation: resolve_paths` and `path_refs` as a JSON array of path strings (e.g. `'["docs/ai/architecture-brief.md",".opencode/scripts/state-lib.js"]'`)
  - this checks each path against the repo filesystem, appends a structured section to resolved-context.md, and returns per-path status
  - if a path resolves as `missing`, search for the smallest justified replacement, then call `resolve_paths` again with the corrected paths to update the record
  - do not invent replacements when the repo does not support one
- if the user stated which files are likely to change, record those in the task contract
- if the user did not state which files are likely to change but the task type is `implementation` or `benchmark/eval`, infer the likely files and record them as tentative
- if the user specified evidence tier, per-source breakdown, or decision scope for an eval task, capture those in the contract
- infer only the open questions that materially block the next step
- call `plan_state` with `operation: init_session_memory` and provide:
  - `brief_body`
  - `resolved_context_body`
  - `open_questions_body`
- call `plan_state` with `operation: save_checkpoint` and provide:
  - `slug: kickoff`
  - `title: Kickoff`
  - `goal`: one-sentence task goal
  - `next_step`: the immediate next action
  - `body`: a compact kickoff snapshot with goal, hard constraints, resolved context, and first execution step
- if the task is clearly part of a broader long-lived theme, recommend `/workstream-start <slug>` after session start instead of stuffing that cross-session context into the session brief

Return:
- active session alias
- memory dir
- run dir
- kickoff checkpoint id and path
- task contract version and path
- any missing or replaced paths that need attention
- the next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
