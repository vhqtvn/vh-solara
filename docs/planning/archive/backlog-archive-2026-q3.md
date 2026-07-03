# Backlog Archive: 2026 Q3

This file stores older `done` and `cancelled` rows moved out of `docs/planning/backlog.md` by `.opencode/scripts/normalize-backlog.js` so the main backlog can stay focused on active work.

## Done

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |
| P1-AGG-002 | done | AGG | Slice — fan out `hydrate` trailing upstream calls concurrently (memo #2). `pkg/aggregator/aggregator.go`: collapse serial `SessionStatuses`/`ListQuestions`/`ListPermissions` into 3-way `sync.WaitGroup` fan-out; errors swallowed + `log.Printf` (decision (a)). GATE confirmed `opencode.Client` goroutine-safe. | build | 2026-07-01. DONE. Changed: `pkg/aggregator/aggregator.go` (`hydrate`: 3 serial enrichment GETs `SessionStatuses`/`ListQuestions`/`ListPermissions` → 3-way concurrent `sync.WaitGroup` fan-out, ctx-bound, `defer wg.Done` panic-safe; error semantics = swallow+`log.Printf` (decision (a)) preserving prior best-effort behavior — NOT surfaced, so `/vh/reload` semantics unchanged), `pkg/aggregator/aggregator_test.go` (+`TestHydrateFansOutStatusQuestionsPermissionsConcurrently` deterministic concurrency proof; +`TestHydrateSwallowsEnrichmentErrors`). GATE confirmed `opencode.Client` goroutine-safe. Verified: `go build`/`vet`/`gofmt` clean; `go test ./pkg/aggregator/` ok; `go test -race ./pkg/aggregator/` ok. No commit. Decision memo: `researches/decisions/session-load-residual-speedups.md` (#2). | [session-load-residual-speedups.md](../../researches/decisions/session-load-residual-speedups.md) |

## Cancelled

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |
