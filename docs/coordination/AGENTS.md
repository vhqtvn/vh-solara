# Coordination Docs Rules

These rules apply to `docs/coordination/` and its descendants.

## Purpose

- Keep this directory limited to durable coordination guidance.
- Treat it as the repo's generic coordination brain, not as a second planning
  database.

## Must preserve

- `docs/planning/backlog.md` is still the canonical task-status source of truth.
- `docs/checkpoints/` is still the durable record for meaningful blockers,
  decisions, and closeouts.
- `.opencode/state/` is still the live session and workstream runtime state.

## Do here

- define roles, lanes, conflict rules, prompt templates, handoff templates, and
  blocker policy
- reference the canonical state owners instead of copying their content
- keep examples generic enough for any contributor or agent

## Do not do here

- create parallel committed ledgers for tasks, blockers, deployments, or
  decisions unless the repo-wide state model is intentionally changed
- commit secrets, private hostnames, or machine-only paths
- turn one-session notes into durable guidance
- store longer comparative research or source packets here; put those under
  `researches/decisions/` or `researches/sources/` and link to them instead

## Editing rules

- keep these docs concise and operational
- prefer tables and templates over long narrative explanation
- when a rule here changes the OpenCode surface, update the matching
  `.opencode/agents/`, `.opencode/commands/`, or `opencode.jsonc` entry in the
  same slice
- when a rule here changes reusable review or coordination guidance, update the
  matching `.github/instructions/` or `.github/prompts/` mirror in the same
  slice
