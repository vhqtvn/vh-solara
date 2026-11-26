# Detached OpenCode Restart Test Flake: Diagnosis and Resolution

**Date:** 2026-11-27  
**Status:** PARTIALLY RESOLVED (workspace guard landed; lifecycle cleanup planned)  
**Target artifact:** cmd/local-server.go, cmd/local-server_test.go (planned lifecycle slice)  

---

## 1. Context and Problem Statement

Intermittent failures in package `cmd` produced `502 "upstream error: EOF"` responses during tests exercising detached OpenCode restarts. The failures struck two tests: `TestRestartRetargetsRunningServerToFreshPort` in `cmd/opencode_retarget_test.go` and `TestLocalServerDetachedRestartFansChildOutputIntoLogs` in `cmd/local-server_test.go`. The retarget test's assertion message incorrectly claimed the daemon kept serving through the old port. Separately, an unresolved boot-time `404` was intermittently observed at `cmd/local-server_test.go:823`.

This memo records the diagnosis conducted on tree `1f6225d`, the landed workspace guard, and the planned lifecycle cleanup so the scratch study is no longer needed.

## 2. Root Cause: One Defect, Two Victims

The 502 failures stem from a single underlying defect:
- `TestLocalServerDetachedRestartFansChildOutputIntoLogs` boots a detached local-server via `go localServerCmd.Run(nil, nil)` (`cmd/local-server_test.go:807`). Because its `vhCtx` is cancelled only on process signal (`cmd/local-server.go:102`), the local-server and its death watcher (`cmd/local-server.go:179`, `cmd/opencode_watch.go:487-503`) outlive the test.
- When the test scenario sweep SIGKILLs its fake OpenCode (`cmd/opencode_lock_test.go:266-283`), the lingering watcher interprets this as an unexpected process exit and schedules up to five auto-restart attempts (`cmd/opencode_watch.go:480-485`).
- State, lock, and log paths are resolved at call time from ambient `VH_STATE_DIR` and `os.Getwd()` (`cmd/opencode_detached.go:35-44`, `cmd/opencode_lock.go:92-93`). This couples directly to the two-role flock and starter lock protocols established in `researches/decisions/2026-08-28-oc-spawn-serialization-brief.md` and `researches/decisions/2026-08-28-oc-spawn-lock-experiment.md`, where `.spawn.lock`, `.owner.lock`, and state JSON live under `<state>/opencode/<sha1(cwd)>.*`.
- As a consequence, the stale watcher reads whichever scenario's state file is current and executes `restartDetachedOpenCode` (`cmd/opencode_start.go:354-358`). It sends SIGTERM (`cmd/opencode_detached.go:382-389`) to a later test's fake during its 200 ms request-drain window (`cmd/opencode_lock_test.go:185-198`). The reverse proxy's `ErrorHandler` logs EOF and returns 502 (`pkg/web/opencode_proxy.go:32-36,55`).

The two victims are `cmd/opencode_retarget_test.go` (`TestRestartRetargetsRunningServerToFreshPort`) and subsequent `-count` iterations of the Fans test itself.

## 3. Measured Rates

Diagnostic measurements on tree `1f6225d`:
- **Fans test alone:** 15 failures in 60 iterations (periodic, roughly every fourth iteration, driven by the watcher's retry backoff schedule).
- **Retarget test alone:** 0 failures in 60 iterations (cannot fail on its own).
- **Four-test ordered sequence:** (Fans test, two short tests, retarget test): 1 failure in 1 run (reproduces deterministically when the offset aligns the stale attempt with the retarget test's 200 ms window).
- **In-package rate:** Low (0 of 3 runs during study; 1 of 4 observed by operator) because the ~0.2 s vulnerable window typically missed the stale attempts by ~0.4 s depending on intervening test durations.
- **Concurrency / Data race:** Clean under `-race` (0 data races detected across iterations; verified with an active detector).

## 4. The Boot-Time 404 (Unresolved)

An intermittent `404` at `cmd/local-server_test.go:823` (`waitLSBootReady`) on `/vh/opencode/status` remains unresolved:
- The route `/vh/opencode/status` is registered unconditionally (`pkg/web/server_routes.go:199`) and returns only 200 or 503 (`pkg/web/opencode.go:159-170`). A vh-solara server cannot return 404.
- The only code-consistent explanation is a foreign listener taking the port between the port reservation probe (`Listen("127.0.0.1:0")` then close at `cmd/local-server_test.go:798-803`) and the server bind at the end of `Run` (`cmd/local-server.go:450-457`).
- Not reproduced: 0 occurrences in 68 detached boots. The derived "about 0.03% per boot" probability under local lane churn is a theoretical estimate, not an observed rate.

## 5. Landed Fix: Foreign Workspace Guard

Landed in commit `1ac87aca189103f204f4af32b4ded74fe6c3f94a` (`fix(cmd): refuse a detached restart for a foreign workspace`):
- Added an upfront guard in `restartDetachedOpenCode` (`cmd/opencode_start.go`) before taking the starter lock, reading any recorded state, or sending any signal. The guard canonicalizes paths and refuses to restart if the target workspace does not match the ambient workspace derived from `os.Getwd()`.
- Added regression test `TestRestartDetachedRefusesForeignWorkspace` in `cmd/opencode_restart_guard_test.go` (red before the guard was added, green after).
- Corrected the misleading assertion message in `cmd/opencode_retarget_test.go:141` so it no longer blames the old port.
- **Verification receipts:** Fans test alone `-count=30` dropped from 14/30 failures to none (0/30); the four-test sequence dropped from 1/1 retarget failure to pass; `-race` on both tests clean; `go test ./cmd/` green.

## 6. Planned Follow-ups and Ordering

Durable structural resolution will proceed in the following order:
1. **Stop lingering local-servers:** Wire `localServerCmd.Run` (`cmd/local-server.go`) to honor command context cancellation; update test helpers (`cmd/local-server_test.go`) so server teardown and watcher termination complete before scenario sweep.
2. **Explicit state identity:** Capture state-directory base and project key once at arm/guard creation and pass them explicitly through `EnsureDetachedOpenCode` and `restartDetachedOpenCode` rather than resolving ambient env/cwd at call time (a partial conversion is not acceptable).
3. **Diagnose the 404 before touching it:** Instrument `waitLSBootState` to capture responder identity (headers, body prefix, and server access log verification) on any non-200.

**Rejected alternatives for now:**
- *Renaming Fans test to run last:* Only patches package-level test ordering; leaves `-count` repetitions and concurrent executions vulnerable.
- *Skipping Fans test permanently:* Unacceptable loss of test coverage for detached restart output fanning.
- *Disabling automatic restart:* Strips core production self-healing functionality from the death watcher.
- *Adding sleeps:* Masks timing races without fixing the underlying lifecycle leak.
- *Tolerating non-200 at boot:* Masks genuine local-server boot regressions.

## 7. Temporary Workaround and Known Limits

- **Temporary workaround (to retire with the planned lifecycle slice):** If isolating legacy runs:
  `go test ./cmd/ -skip '^TestLocalServerDetachedRestartFansChildOutputIntoLogs$'` followed by `go test ./cmd/ -run '^TestLocalServerDetachedRestartFansChildOutputIntoLogs$' -count=1`.
- **Known limits of the landed guard:** Stale death watchers from the Fans test still survive and retry up to five times (each attempt is now harmlessly refused); leaked local-server goroutines from the Fans test still accumulate across repeated `-count` iterations until the lifecycle slice lands.
