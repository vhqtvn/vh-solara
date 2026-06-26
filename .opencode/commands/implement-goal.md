---
description: Implement a specific goal without relying on prior conversation context
agent: build
subtask: false
---

Implement this goal:
$ARGUMENTS

- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.

If this work is likely to span multiple steps, evaluations, or specialist handoffs:
- ensure the task is running inside a session started with `/session-start <slug>` or an equivalent bound session with initialized memory
- persist a task contract early and keep it updated only when the user materially changes the request
- if the work depends on a repo-local skill workflow, name the exact skill in the task contract or plan instead of assuming automatic selection
- resolve any dated or user-supplied file paths before relying on them
- do not rely on chat history alone for durable task state

Before changing files:
- restate the intended change in 3-6 bullets
- identify the exact files you will touch
- call out any risky assumptions

Then implement the smallest complete change.

For git operations, follow `.opencode/docs/git-execution-routing.md`.
