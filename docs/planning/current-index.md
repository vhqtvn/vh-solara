# Current Plan Index

This is a thin, truth-derived index for resolving references to "the current plan" and handling dated planning/checkpoint paths.

## What "current" means here

- **Status truth**: [`backlog.md`](backlog.md) is the canonical source of truth for task status (active work stays in Now / Next / Later).
- **Direction**: [`roadmap.md`](roadmap.md) holds the higher-level phase arc and milestone intent.
- **History**: `docs/checkpoints/` contains dated, durable snapshots of decisions and progress.
- **Live-local**: Session and workstream state under `.opencode/state/` is local to the run/machine and is not canonical.

## Resolution rule for dated paths

Treat any user- or prompt-supplied dated path (e.g., in `docs/checkpoints/` or `docs/planning/`) as a **hint**. When resolving a path:

1. Check if the exact path exists.
2. If missing, look for a newer or replaced file that supersedes it (e.g., a newer checkpoint on the same theme).
3. If it cannot be found or mapped, treat it as missing.
4. Record this resolution mapping (`exact`, `replaced`, or `missing`) in your session memory.

Always start your search in `docs/planning/` and `docs/checkpoints/`.

## Current pointers (as of 2026-08-20)

- **Backlog**: [`docs/planning/backlog.md`](backlog.md)
- **Roadmap**: [`docs/planning/roadmap.md`](roadmap.md)
- **Latest Checkpoint**: `docs/checkpoints/2026-08-20-ui-zoom-placement-campaign-closure.md`
- **Archived History**: `docs/planning/archive/` contains older completed/cancelled backlog tasks normalized out of the active list.
