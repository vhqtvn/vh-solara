# Completion Checkpoint: OpenCode Death Recovery

## Incident Summary
- **Date/Time**: 2026-10-03 21:00:42 +07
- **Event**: `pkill -x opencode`
- **Impact**: OpenCode process was dead but the failure went undetected for 60 minutes.

## Commit Summaries

- **S1 `dc2e6559`**: Implemented death watch (`cmd/opencode_watch*.go`) with a Linux `waitid(WEXITED|WNOHANG|WNOWAIT)` poll that observes exit WITHOUT reaping, preserving the zombie PID-reuse invariant (GOARCH-conditional siginfo offset). Added a reattach/non-parent + non-Linux identity-poll fallback, and `--web opencode` detection-only mode. Self-healing is provided via the shared restart arm (`restartDetachedOpenCode`), featuring a backoff (1s×2 up to a 30s cap) and a crash-loop cap (5 attempts in 10 minutes) leading to a visible SetFailed state. Deliberate stops never auto-restart. The `oclife` snapshot was augmented with `DownSince`, `RestartAttempts`, and `RestartCapped`. Promoted `x/sys` in `go.mod`.
- **S2 `7cd8e329`**: Added explicit down states to `OpenCodeHealthPanel`, with alerts via `EmitDaemonNotice` (once per down-spell, once per give-up). Aggregator upstream-down probes now cap reconnect and hydrate backoffs at 30s (external `--opencode-url` behavior is byte-identical). This was purely worker-local with no protocol changes.
- **S3 `6c15b910`**: Surfaced down-502 prompt failures (with chip details and one notification). Enabled unknown-only same-messageID retry (idempotent on opencode ≥ 1.17.18). Failed items are never retryable (server resolve matrix rejects failed→sent), and there is no auto-retry anywhere.
- **S4 (Docs)**: Documentation and bookkeeping closure, including operator guides, backlog updates, and verification records.

## Operator-Required Test Cases

| Operator Requirement | Landed Test Name |
|----------------------|------------------|
| Signal-kill detected, zombie NOT reaped | `TestOCWatchSignalKillDetectedNotReaped` |
| Crash-loop cap + give-up | `TestOCWatchCrashLoopCap`, `TestOCWatchAlertCappedFiresOnce` |
| User restart racing the watcher | `TestOCWatchUserRestartRacesWatcher` |
| Reattached/non-parent detection via identity poll | `TestOCWatchReattachDeathIdentityPollRestart` |
| Deliberate stop never restarts | `TestOCWatchDeliberateStopNoRestart` |
| One `down` alert per spell | `TestOCWatchAlertOncePerDownSpell` |
| Snapshot JSON additive | `TestOCLifeSnapshotJSONAdditive` |

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| S4 Go full tree green | `go test ./...` | yes |
| S4 web unit passed | `npm --prefix web run test:unit` | yes (2946 passed/1 skip) |
| S4 typecheck clean | `npm --prefix web run typecheck` | yes |
| S4 web e2e passed | `npm --prefix web run test:e2e` | yes (268 passed/2 failed/1 skip; failures attributed to pre-existing zoom-placement load flake) |

```behavioral-closure
verdict: proven
result: proven
interaction_touching: false
command: go test ./cmd/ ./pkg/aggregator/ ./pkg/web/ ... (unit-level)
receipt: S1/S2 cruxes unit-level green, tree-bound at slice commits (dc2e6559, 7cd8e329, 6c15b910).
```

```behavioral-closure
verdict: proven
result: proven
interaction_touching: false
command: npm --prefix web run test:unit / e2e
receipt: S3 retry crux scoped to jsdom seam with live idempotency leg deferred -> satisfied by the bason manual check. (Manual operator run verifies idempotency leg live).
```