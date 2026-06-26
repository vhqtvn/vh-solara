# Coordination Launch Checklist

Before starting substantial cross-boundary work:

1. Open `AGENTS.md`, `docs/planning/backlog.md`, and `docs/planning/current-index.md`.
2. Update or add the backlog row before substantial edits.
3. Start the session with `/session-start <slug>`.
4. Capture any user `Return:` block with `/task-contract-save`.
5. Decide the primary lane and, if useful, ask the coordinator for routing.
6. Bind a workstream only if the theme should survive many sessions.
7. Confirm the exact files likely to change.
8. Confirm which outputs are durable and which stay in `.opencode/state/`,
   `tmp/agent-runs/`, or `.local/`.
9. If the task crosses boundaries, decide the handoff points before editing.
10. Save a checkpoint when the durable story changes.
