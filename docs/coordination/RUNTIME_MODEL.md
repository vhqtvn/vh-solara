# Coordination Runtime Model

This document defines the first coordinator-runtime shape for long, many-report,
or async coordination work.

It is intentionally local-first and subordinate to repo canon.

## Three Planes

| Plane | Owns | Must not own |
| --- | --- | --- |
| Repo control plane | backlog, checkpoints, durable coordination rules | live queues, private operator state, raw report chatter |
| Session/workstream plane | current session memory and cross-session theme context | canonical task truth for unrelated work |
| Runtime messaging plane | live task envelopes, waiting-on state, fan-in queues, dashboards | canonical task status, final blocker truth, final decisions |

## Local Runtime Layout

If a runtime coordinator is needed, prefer this local layout:

```text
.local/coordinator/
  AGENTS.local.md
  ACTIVE_SESSIONS.md
  WAITING_ON.md
  tasks/
    <task-id>.json
  research-runs/
    <task-id>.json
  reports/
    minimal/
    standard/
    synthesis/
  dashboards/
    inbox.md
    fan-in.md
  scratch/
```

Nothing under this tree becomes canonical merely because it exists.

## A2A-Lite Task Envelope

Use an A2A-shaped local envelope before introducing any external coordinator or
protocol layer.

Why:

- it enforces structured lifecycle state
- it keeps fan-in artifacts consistent
- it allows a later external transport with less rewrite

Core fields:

- `task_id`
- `coordination_mode`
- `status`
- `lane`
- `requested_by`
- `session_alias`
- `depends_on`
- `files_in_scope`
- `artifacts`
- `summary`
- `confidence`
- `risk`
- `updated_at`

See `schemas/runtime-task-envelope.schema.json`.

## Lifecycle

Use these states for runtime task envelopes:

- `submitted`
- `working`
- `input_required`
- `completed`
- `failed`
- `cancelled`

These states are for transport and collection only. They do not replace backlog
status values.

## External Research Runs

When long-running research is delegated to a provider such as ChatGPT deep
research, Gemini Deep Research, Grok, or Kimi, treat that provider run as one
local runtime artifact:

- attach it to the local research `task_id`
- persist it under `.local/coordinator/research-runs/`
- poll or continue it from the local runtime plane
- promote only the final durable report into `researches/`

Use `schemas/external-research-run.schema.json` for the provider-agnostic local
run-record shape.

## Messaging Rules

For long-running coordination:

- stream progress when the coordinator and workers are simultaneously active
- prefer push or append-only report drops for disconnected work
- keep polling as the fallback recovery path
- keep handoff context narrow; pass the current slice and required docs, not the
  entire history

## Promotion Rules

1. Subagent reports stay local.
2. One synthesizer produces the fan-in view.
3. Only synthesized conclusions are promoted to `docs/planning/backlog.md`,
   `docs/checkpoints/`, or other durable repo docs.
4. Raw runtime artifacts may be deleted or rotated once the promotion is stable.

## Adoption Phases

### Phase 1: Repo-Native Brain

- coordination docs
- prompt templates
- command surfaces
- report schemas

### Phase 2: Local Runtime Support

- local task-envelope files
- local report directories
- dashboards and waiting-on views
- optional validation scripts

### Phase 3: Optional External Transport

- only if multi-machine or cross-runtime orchestration becomes necessary
- external transport still reads from and writes back to repo canon
- external transport must not become the durable source of truth
