---
description: Implement the resolved session plan, optionally overriding by id or prefix
agent: build
subtask: false
---

Resolve the target plan for the current OpenCode session and implement it.

- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.

First call the `plan_state` tool with:
- `operation`: `resolve_plan`
- `selector`: `$ARGUMENTS` if the user provided one, otherwise omit it or pass an empty string
- `include_body`: `true`

Then call the `plan_state` tool with:
- `operation`: `read_task_contract`
- `include_body`: `true`

If the tool fails, stop and relay the failure briefly.

Use the returned `plan`, `resolved_via`, `path`, and `body` as the execution brief under the current task contract. Do not ask the user to paste plan text again.

For non-trivial work:
- prefer an active session started with `/session-start <slug>` so durable memory, checkpoints, and artifact cleanup are available
- treat the task contract as the stable source of truth for mission, required outputs, required commands, and non-goals
- if the task contract or plan names a repo-local skill, honor it explicitly; do not assume automatic skill selection otherwise
- resolve dated or user-supplied file paths before relying on them
- checkpoint major state transitions with `/checkpoint-save <slug>` instead of relying on chat memory alone

Before changing files:
- restate the intended change in 3-6 bullets
- identify the exact files you will touch
- call out any risky assumptions

Execution rules:
- make the smallest complete change that satisfies the goal
- prefer existing patterns in this repo over inventing new abstractions
- do not silently change manifests, aggregation/verdict policy, or evaluation logic unless the task explicitly asks for it
- if the task crosses boundaries, stop and note which specialist agent should handle the next part

After changes:
- summarize the diff
- list any follow-up work
- suggest targeted verification commands

For git operations, follow `.opencode/docs/git-execution-routing.md`.
