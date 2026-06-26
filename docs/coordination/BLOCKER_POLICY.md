# Blocker Policy

## Severity

- `p0`: Cannot proceed safely or truthfully without a user or operator decision.
- `p1`: Work can continue in a narrower lane, but the main objective is blocked.
- `p2`: Follow-up or cleanup blocker that does not stop the current slice.

## Recording Rules

Use the existing state owners:

- task-level blocked status -> `docs/planning/backlog.md`
- durable blocker context -> `docs/checkpoints/`
- transient current-session blocker notes -> `.opencode/state/sessions/<alias>/memory/`
- private operator reminders -> `.local/coordinator/`

Do not create a separate committed blocker ledger beside those systems.

## Escalation Rules

1. Move the backlog row to `blocked` when the main slice cannot complete.
2. State the exact blocker and the next decision needed.
3. Save a checkpoint if the blocker is durable enough to matter across sessions.
4. Use a handoff only when the next owner is different from the current owner.

## Examples

- `p0`: conflicting product rule, missing credential the agent cannot access, live rollout risk that needs operator confirmation
- `p1`: waiting on a boundary owner while a smaller docs or audit slice can still proceed
- `p2`: optional cleanup or follow-up task discovered during closeout
