# Coordination Report Envelopes

Use structured report envelopes so parallel sessions can be gathered and
compared without rereading chat transcripts.

## Principles

1. Reports are artifacts, not chat blobs.
2. Subagent reports should be factual and scoped.
3. Synthesis reports resolve conflicts and decide what gets promoted.
4. Only promoted conclusions belong in backlog rows, checkpoints, or other
   durable repo docs.

## Minimal Report

Use for `short` tasks or narrow follow-up slices.

```text
Return:
1. Task slice owned
2. Files in scope
3. Validation results
4. Blockers or none
5. Recommended next prompt
```

Prefer this when one session can still hold the whole story.

## Standard Report

Use for subagent reports in `medium` or `long` tasks.

```text
Return:
1. Task slice owned
2. Files touched
3. Decisions made
4. Validation results
5. Blockers
6. Downstream dependencies
7. Durable updates needed
8. Recommended next slice
```

This is the default subagent envelope once handoffs matter.

## Synthesis Report

Use when a coordinator or synthesizer gathers several subagent reports.

```text
Return:
1. Sessions consulted
2. Conflicting findings
3. Resolved view
4. Open risks
5. Durable updates required
6. Recommended next fan-out
```

The synthesis report is the only report shape that should directly drive backlog
or checkpoint promotions for a fan-in cycle.

## Machine-Readable Schemas

These schemas exist so a future local coordinator runtime can validate report
artifacts without becoming a second source of truth.

- `schemas/minimal-report.schema.json`
- `schemas/standard-report.schema.json`
- `schemas/synthesis-report.schema.json`
- `schemas/runtime-task-envelope.schema.json`

## Storage Guidance

- session-local closeout may remain in `.opencode/state/sessions/<alias>/`
- cross-session runtime copies may live under `.local/coordinator/reports/`
- promoted durable conclusions belong in `docs/planning/backlog.md` and
  `docs/checkpoints/`
