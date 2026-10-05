---
description: Implement a specific goal without relying on prior conversation context
agent: build
subtask: false
---

Implement this goal:
$ARGUMENTS

- consult `docs/ai/codebase-operational-primitives.md` (when one exists) for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not chase or fail when it is absent, and do not rediscover these from scratch when it is present.
- git mutations must flow through the `committer` agent via the gated-commit protocol **where `core/gated-commit` is selected**; on profiles without it, automated committing is unavailable — preserve the work, report the missing route, and request separately-authorized activation or operator handling (`.opencode/docs/git-execution-routing.md` → "Capability condition"). Load the `gated-commit` skill for details.

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

For git operations, follow `.opencode/docs/git-execution-routing.md` — including its "Capability condition" section (on profiles without `core/gated-commit` selected, automated committing is unavailable: preserve the work, report the missing route, and request separately-authorized activation or operator handling).
