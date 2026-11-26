# Detached OpenCode Restart Test Flake: Diagnosis and Resolution

**Date:** 2026-11-27  
**Status:** RESOLVED FOR 502 (workspace guard and lifecycle fix landed; boot-time 404 unresolved)  
**Source:** Read-only synthesis of a diagnostic study that ran tests (`tmp/agent-runs/cmd-restart-flake-study/report.md`, gitignored, on study revision `1f6225d`); rates and receipts are reported test output, not re-run for the memo.  
**Target artifact:** explicit state identity; boot-time 404 diagnostic instrumentation (unscheduled follow-ups)  

---

## 1. Context and Problem Statement

Intermittent failures in package `cmd` produced `502 "upstream error: EOF"` responses during tests exercising detached OpenCode restarts. The failures struck two tests: `TestRestartRetargetsRunningServerToFreshPort` in `cmd/opencode_retarget_test.go` and `TestLocalServerDetachedRestartFansChildOutputIntoLogs` in `cmd/local-server_test.go`. The retarget test's assertion message incorrectly claimed the daemon kept serving through the old port. Separately, an unresolved boot-time `404` was intermittently observed at `cmd/local-server_test.go:823`.

This memo records the diagnosis conducted on tree `1f6225d`, the landed workspace guard (`1ac87aca`), and the landed lifecycle fix (`823dbc43`) resolving the 502 failures, while the boot-time 404 remains unresolved and the legacy workaround is retired.

## 2. Root Cause: One Defect, Two Victims

The 502 failures stem from a single underlying defect (line citations describe study tree `1f6225d`):
- `TestLocalServerDetachedRestartFansChildOutputIntoLogs` boots a detached local-server via `go localServerCmd.Run(nil, nil)` (`cmd/local-server_test.go:807`). Because nothing owned or cancelled that run's context (only the restart-server hook ever cancelled `vhCtx`, never a process signal; `cmd/local-server.go:102`), the local-server and its death watcher (`cmd/local-server.go:179`, `cmd/opencode_watch.go:487-503`) outlive the test.
- When the test scenario sweep SIGKILLs its fake OpenCode (`cmd/opencode_lock_test.go:266-283`), the lingering watcher interprets this as an unexpected process exit and schedules up to five auto-restart attempts (`cmd/opencode_watch.go:480-485`).
- State, lock, and log paths are resolved at call time from ambient `VH_STATE_DIR` and `os.Getwd()` (`cmd/opencode_detached.go:35-44`, `cmd/opencode_lock.go:92-93`). This couples directly to the two-role flock and starter lock protocols established in `researches/decisions/2026-08-28-oc-spawn-serialization-brief.md` and `researches/decisions/2026-08-28-oc-spawn-lock-experiment.md`, where `.spawn.lock`, `.owner.lock`, and state JSON live under `<state>/opencode/<sha1(cwd)>.*`.
- As a consequence, the stale watcher reads whichever scenario's state file is current and executes `restartDetachedOpenCode` (`cmd/opencode_start.go:354-358`). It sends SIGTERM (`cmd/opencode_detached.go:382-389`) to a later test's fake during its 200 ms request-drain window (`cmd/opencode_lock_test.go:185-198`). The reverse proxy's `ErrorHandler` logs EOF and returns 502 (`pkg/web/opencode_proxy.go:32-36,55`).

The two victims are `cmd/opencode_retarget_test.go` (`TestRestartRetargetsRunningServerToFreshPort`) and subsequent `-count` iterations of the Fans test itself.

## 3. Measured Rates

Diagnostic measurements on tree `1f6225d`:
- **Fans test alone:** 15 failures in 60 iterations (periodic, roughly every fourth iteration, driven by the watcher's retry backoff schedule).
- **Retarget test alone:** 0 failures in 60 iterations (the retarget test did not fail in 60 isolated iterations).
- **Four-test ordered sequence:** (Fans test, two short tests, retarget test): reproduced once (1 of 1) when the stale attempt landed inside the request window (exact selection: `go test ./cmd/ -run '^(TestLocalServerDetachedRestartFansChildOutputIntoLogs|TestOCSpawnHandoffRetentionAndRelease|TestOCSpawnCrashPostState|TestRestartRetargetsRunningServerToFreshPort)$' -count=1 -v`; order is Go's registered order, not regex order).
- **In-package rate:** Low (0 of 3 runs during study; 1 of 4 observed by operator) because the ~0.2 s vulnerable window typically missed the stale attempts by ~0.4 s depending on intervening test durations.
- **Concurrency / Data race:** Clean under `-race` (0 data races detected across iterations; verified with an active detector).

## 4. The Boot-Time 404 (Unresolved)

An intermittent `404` at `cmd/local-server_test.go:823` (`waitLSBootReady`) on `/vh/opencode/status` remains unresolved:
- The route `/vh/opencode/status` is registered unconditionally (`pkg/web/server_routes.go:199`) and on GET returns only 200 or 503 (`pkg/web/opencode.go:159-170`; non-GET returns 405 Method Not Allowed at lines 160-163). A vh-solara server cannot return 404.
- The leading unconfirmed explanation is a foreign listener taking the port between the port reservation probe (`Listen("127.0.0.1:0")` then close at `cmd/local-server_test.go:798-803`) and the server bind at the end of `Run` (`cmd/local-server.go:450-457`).
- Not reproduced: 0 occurrences in 68 detached boots. The study's estimated collision rate (about 0.03% per boot under lane load, a model-derived figure) is too low to explain the one observation, and an undiscovered cause remains possible.

## 5. Landed Fix: Foreign Workspace Guard

Landed in commit `1ac87aca189103f204f4af32b4ded74fe6c3f94a` (`fix(cmd): refuse a detached restart for a foreign workspace`):
- Added an upfront guard in `restartDetachedOpenCode` (`cmd/opencode_start.go`) before taking the starter lock, reading any recorded state, or sending any signal. The guard canonicalizes paths and refuses to restart if the target workspace does not match the ambient workspace derived from `os.Getwd()`.
- Added regression test `TestRestartDetachedRefusesForeignWorkspace` in `cmd/opencode_restart_guard_test.go` (red before the guard was added, green after).
- Corrected the misleading assertion message in `cmd/opencode_retarget_test.go:141` so it no longer blames the old port.
- **Verification receipts:** Fans test alone `-count=30` dropped from 14/30 failures to none (0/30); the four-test sequence dropped from 1/1 retarget failure to pass; `-race` on both tests clean; `go test ./cmd/` green.

## 6. Landed Fix: Local-Server Lifecycle Cancellation

Landed in commit `823dbc43e8c4ca0679996a59a0fcf68461461a95` (`fix(cmd): stop a local-server when its context is cancelled`, parent `dc0a486`, files `cmd/local-server.go` and `cmd/local-server_test.go`):
- **Mechanism:** The body of `localServerCmd.Run` is now `runLocalServer(parent context.Context)`; `Run` passes `context.Background()`, so production behaviour is unchanged. When the parent context is cancelled, the HTTP listener drains and closes first (the order `web.Server.Shutdown` documents, `pkg/web/server_aggregators.go:108-138`), then the server drains its background work, each with its own 2 s context; the run returns once that teardown has finished (it joins the teardown goroutine). The test helpers start the server with a cancellable context and register the stop right after the scenario setup, so the server is gone before the scenario sweep kills the fakes. The restart-server hook is untouched.
- **Verification receipts (build agent, isolated `XDG_CONFIG_HOME`):** New test `TestLocalServerStopsWhenItsContextIsCancelled` was red with the extraction only (`local-server did not return within 5s of its context being cancelled`) and is green with the stop (`--- PASS … (0.31s)`); the Fans test run 5 times verbose shows no `opencode watch:` line after any `--- PASS`, and 30 times plain is ok; `-race -count=3` on the Fans and retarget tests ok; whole `cmd` package once ok; gofmt and vet clean.
- **Review:** Approved by all four seats; the first review was blocked on the shutdown order (server before listener) and was resolved as above.

### 6.1 Remaining Follow-ups and Rejected Alternatives

Remaining follow-ups (not scheduled):
1. **Explicit state identity for detached OpenCode files:** Capture the state-directory base and project key once; use them for state, locks and logs (pass them explicitly through `EnsureDetachedOpenCode` and `restartDetachedOpenCode` rather than resolving ambient env/cwd at call time).
2. **Diagnose the 404 before fixing it:** Instrument `waitLSBootState` to capture the responder's identity (headers, body prefix, and server access log verification) on any non-200.

**Rejected alternatives:**
- *Renaming Fans test to run last:* Only patches package-level test ordering; leaves `-count` repetitions and concurrent executions vulnerable.
- *Skipping Fans test permanently:* Unacceptable loss of test coverage for detached restart output fanning.
- *Disabling automatic restart:* Strips core production self-healing functionality from the death watcher.
- *Adding sleeps:* Masks timing races without fixing the underlying lifecycle leak.
- *Tolerating non-200 at boot:* Masks genuine local-server boot regressions.

## 7. Retired Workaround and Known Limits

- **Workaround retired:** The `-skip` / isolated single-run legacy workaround is retired following the landed lifecycle fix.
- **Known limits after the lifecycle fix:** The death watcher is not joined by the stop (a restart callback already running can outlive cancellation and the helper's `done`); no test pins the shutdown order or the join; the 2 s HTTP drain timeout is ignored; there is no force-close after the grace period (same posture as the restart hook).

## 8. Findings

- **(root cause: lifecycle leak)**: `TestLocalServerDetachedRestartFansChildOutputIntoLogs` leaked its server and death watcher because nothing owned or cancelled that run's context (only the restart-server hook ever cancelled `vhCtx`, never a process signal). source=`cmd/local-server.go:102,179` and `cmd/local-server_test.go:807` (study tree `1f6225d`), confidence=high, type=fact
- **(cross-test interference)**: Stale watchers resolve paths from ambient cwd/env and SIGTERM later test fake OpenCode processes during request drain, producing 502 EOF. source=`cmd/opencode_watch.go:480-485`, `cmd/opencode_start.go:354-358`, `pkg/web/opencode_proxy.go:32-36,55`, confidence=high, type=fact
- **(retarget test isolation)**: `TestRestartRetargetsRunningServerToFreshPort` did not fail in 60 isolated iterations; its failure was entirely collateral damage from the unmanaged Fans test watcher. source=`cmd/opencode_retarget_test.go:141` and study receipts on tree `1f6225d`, confidence=high, type=fact
- **(workspace guard efficacy)**: Guarding restart on `os.Getwd()` prevents foreign workspace restarts and eliminates 502 flakes across test boundaries. source=commit `1ac87aca` and `cmd/opencode_restart_guard_test.go`, confidence=high, type=fact
- **(boot-time 404 ambiguity)**: `/vh/opencode/status` on GET returns only 200 or 503 (non-GET returns 405 Method Not Allowed at lines 160-163); the estimated port collision rate (~0.03% per boot) is too low to explain the single observation at `:823`, leaving an undiscovered cause possible. source=`pkg/web/opencode.go:159-170`, `pkg/web/server_routes.go:199`, and study receipts, confidence=medium, type=inference
- **(lifecycle fix efficacy)**: The focused test shows that the run returns and the port closes within 5 s of cancellation; the Fans test, run 5 times verbose and 30 times plain, showed no watcher line after any test end; the run joins only the HTTP and web teardown, so a restart callback already running can still outlive it. source=commit `823dbc43` build agent receipts (`TestLocalServerStopsWhenItsContextIsCancelled`, Fans test ×30, `-race -count=3`), confidence=high, type=fact

## 9. Contradictions

- **Failure points in Fans test**: The read-only study saw the Fans test fail only at `local-server_test.go:859`. The fix slice's baseline also saw `:836` and a boot-never-ready face at `:823`, all gone with the guard.
- **Shutdown order during cancellation**: The initial review blocked on stopping the background server before draining the listener (which could reject in-flight requests or hang teardown); resolved by draining and closing the HTTP listener first (`pkg/web/server_aggregators.go:108-138`) before background work drain.

## 10. Disclaimer and Next Specialist

This memo represents a durable research and decision-shaping evidence record, not active repo operational policy.

- **Recommended next specialist:** None scheduled. If follow-ups are activated, `build` would execute both (after a `planner` brief for explicit state identity; directly for boot-time 404 diagnostic instrumentation).
