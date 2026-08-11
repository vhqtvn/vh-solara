# 2026-08-11 — Archive defect chain + archive-failure visibility feature

## Context

A real operator incident: a 1073-descendant root session was archived, unarchived, re-archived; the archive cascade died partway twice, leaving ~300 live subsessions whose archived parents were gone from the live tree. Those stragglers rendered as plain ROOT sessions with no orphan banner and no recovery affordance. The operator hand-repaired via `POST /vh/archive`. This work makes recurrence impossible and adds operator visibility for the residual stuck-root case.

## What shipped

Seven commits on `main`:

| Commit | Arc | What |
|---|---|---|
| `2cefbcd` | defect | authoritative archived-ID snapshot + Defect-3 orphan backstop sweep |
| `cfbe254` | defect | `isOrphanLocked` consults snapshot — genuine orphans flagged + sweep propagates |
| `933ebaa` | defect | server-owned archive cascade — survives disconnect, retries, resumes |
| `0ef2c06` | defect | RT4 partial-resume — re-archive completes the remainder |
| `46249a0` | test | coverage for fetch-error + 409-re-derive edge branches |
| `134d894` | feature | archive-failure visibility — banner + per-project registry + SSE + clear-on-success |
| `32ee1e3` | feature | archive-failure backstop — active-jobs registry + race-free OOB reconcile |

## Defects fixed (RT1–RT4 proven)

- **D1 (cascade)**: the archive loop was request-bound (`r.Context()`), abort-on-first-error (502), non-resumable; a mobile screen-off cancelled it mid-loop → partial archive. Now a server-owned background job under the existing `bgCtx`/`bgWG` lifecycle: responds `200 + affected` immediately (job accepted), retries transient per-id `SetArchived` failures (5 attempts, 500ms–8s backoff ±20% jitter), retains failed ids (never removes/queue-cleans/unpins on failure), resumes idempotently via `archivedDescendants`. **RT1** (retry→completion; request-cancel crux; stuck descendant→orphan; stuck root→explicit failure, never orphan) proven.
- **D2 (classification)**: `isOrphanLocked` treated an absent live-store parent as a root → stragglers unflagged. Now delegates to `chainTerminatesAtArchivedLocked` (snapshot authority — the same function the sweep uses, so emit and sweep always agree). **RT2** (flag survives rehydrate + daemon restart; OrphanBanner renders) + **RT3** (live/unresolvable/cycle root never flagged) proven.
- **D3 (backstop)**: nothing swept for stragglers. Now an `archivedSnapshot` on the Store (populated from `/session?archived=true` at hydrate + every 5s reconcile) + `sweepOrphansLocked` flags live sessions whose ancestor chain terminates at a confirmed-archived root. The snapshot is the cross-restart authority (tombstones are in-memory and lost on restart — the fix deliberately does not rely on them).
- **Resume (RT4)**: re-issuing `POST /vh/archive` on a partially-archived root completes the remainder via `resumeArchiveAffected` (derives the remaining live descendants from authoritative OpenCode state — both `/session` and `/session?archived=true`). Proven (`TestArchiveJob_ReissueOnPartiallyArchivedRootCompletesRemainder`).

## Archive-failure visibility feature

The residual case: a permanently-stuck root (OpenCode 403, or retry exhaust) is invisible on the mobile SPA — the `200`-accepted response looks like success. Two slices:

- **Visibility (`134d894`)**: per-project `(dir,id)` upsert failure registry (replacing an append-only slice); clear-on-success at the bg-job success funnel (`archive.go:309`, all three success branches); SSE `archive-failures.snapshot` bootstrap + `archive-failures.updated` transient (per-project, labels-precedent); `ArchiveFailureBanner` in the Sidebar (tree-independent, distinct labels — "Archive failed", never "orphan"); retry via the existing `POST /vh/archive` (CSRF auto). behavioral-closure: inconclusive/not-demonstrable (boundaries tested, no live Playwright e2e).
- **Backstop (`32ee1e3`)**: active-jobs registry (`archiveJobsActiveRoots map[archiveFailureKey]bool` under `bgMu`); 5s server-side backstop ticker (`runArchiveBackstop`) clears OOB-resolved failures when (root resolved per snapshot+store via `IsArchiveRootResolved`) AND (no active cascade in registry). Establishes the `bgMu → store.s.mu` / `bgMu → archiveFailuresMu` lock order (the three locks never nested before; single legal order, deadlock-free). behavioral-closure: proven (BT1–BT4 under `-race`).

**Design decisions** (researcher → debate → planner): in-memory current-daemon-only (persistence deferred — needs a downtime-reconciliation protocol unproven; in-daemon clear proven first); per-project `(dir,id)` upsert (not an append-log, not worker-global); clear-on-success + authoritative reconcile backstop (not explicit OOB hooks, which race the bg retry); classified-reason-only display (never raw `opencode.Error.Body`).

## Honest residuals (none reintroduce the original defect)

- **e2e banner path** not exercised by Playwright (Go SSE emission + Vitest banner render prove the boundaries; the live SPA→daemon SSE→banner path is not one end-to-end test). DEFER card `defer-archive-failure-e2e-banner-path`.
- **Non-root-keyed failure contention** untested (correctness intact via one-shot-per-id + self-healing backstop). DEFER card `defer-archive-backstop-nonroot-key-contention-test`.
- **Cross-restart**: failure registry is in-memory by design (debate Decision 1); a pre-restart stuck-root warning is lost on daemon restart — the root itself stays live + re-archivable, only the historical failure fact is lost.
- **SQLite unarchive coupling** untouched (archive is HTTP-only via `SetArchived`; unarchive remains the only direct-SQLite path via `opencode.UnarchiveSessions`).

## Pointers

- Session memory: `.opencode/state/sessions/archive-defect-chain/memory/` (task-contract, resolved-context, 12 checkpoints, decision-log, handoffs).
- Research packet: `researches/sources/archive-failure-lifecycle.md` (the 7-gap lifecycle questionnaire + evidence).
- Unarchive seam contract: `docs/architecture/opencode-sqlite-unarchive.md`.
