---
description: Load the repo-root coordination context for cross-boundary planning, handoffs, and blocker shaping
agent: coordination
subtask: false
---

Prepare for coordination work from the repo root.

Read these files in order:

- `AGENTS.md`
- `docs/coordination/README.md`
- `docs/coordination/TASK_MODES.md`
- `docs/coordination/REPORT_ENVELOPES.md`
- `docs/coordination/RUNTIME_MODEL.md`
- `docs/coordination/ROLES.md`
- `docs/coordination/LANES.yaml`
- `docs/coordination/CONFLICT_MATRIX.yaml`
- `docs/planning/current-index.md`
- `docs/planning/backlog.md`

When relevant, also read:

- `docs/coordination/PROMPT_TEMPLATE.md`
- `docs/coordination/CLOSEOUT_TEMPLATE.md`
- `docs/coordination/HANDOFF_TEMPLATE.md`
- `docs/coordination/BLOCKER_POLICY.md`
- `.github/copilot-instructions.md`
- `docs/deployment/`
- `.local/demo-server/AGENTS.md`
- `docs/ai/deployment-workflow.md`
- `.local/deployments/AGENTS.md`

If local-only coordination notes exist under `.local/coordinator/`, you may
read them for operator context, but treat them as private working material only:

- do not cite them in backlog rows, checkpoints, or durable repo docs
- do not treat them as canonical task or release state
- for new research tasks that need durable local persistence, prefer `/research`
  over generic `/write-task`
- for `short` mode once lane selection is clear, stop at one concrete handoff;
  do not continue with execution planning in coordinator context unless the
  user explicitly asks for a subagent prompt

Return:

- files loaded
- task mode recommendation
- primary lane recommendation
- report envelope to require
- runtime layer to use
- canonical state owners to use
- conflict risks to watch
- escalation trigger if the task should move to `long`
- first likely docs, agents, commands, or prompt files to touch
- which specialist, command, or execution session should take the concrete slice
  next to keep coordinator context thin
- when local persistence is warranted, whether the next step should be
  `/research` or `/write-task` instead of continuing in ephemeral chat

Keep the return brief for `short` tasks. If the runtime layer and canonical
state owners are unchanged defaults, omit boilerplate and end on the single
next command.
