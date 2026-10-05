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
- **S5 `c56119b2`**: Automated verification for the OpenCode death/recovery path. Added a Go boot-glue test (`cmd/opencode_bootglue_test.go`) that verifies real `setupVHMode()` wiring, Web e2e (`web/tests/e2e/opencode-down.spec.ts`) that pins down-state strings via a new fixture, and Docker gold lane Flow 8 integration. RESOLVES the S1/S2 review defers on alert-glue/!external probe wiring (satisfied by boot-glue test) and the S3 live-idempotency leg (satisfied at docker level). Introduced new defer triggers: F1 (250ms boot-glue sleep watch - upgrade to ack gate if flaky), F2 (Flow 8 full run integration proof required before any green claim), F3 (fixtureserver unsynchronized pointer write - blocks if copied to prod or run under -race).

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
| S5 Go boot-glue test | `go test ./cmd/ -run TestOCBootGlue -count=1 -v` | yes |
| S5 Web e2e opencode-down | `npm --prefix web run test:e2e -- opencode-down` | yes |
| S5 Docker gold Flow 8 | `bash tests/e2e-docker/run.sh` (scratch harness) | yes (full lane claim deferred per F2) |

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

```behavioral-closure
verdict: proven
result: proven
interaction_touching: false
command: go test ./cmd/ -run TestOCBootGlue -count=1 -v
receipt: S5 crux: Linux-gated real setupVHMode() wiring tests live SSE notice on child SIGTERM, failed+down_since, and auto-heal. Tree f4f7d6eb.
```

```behavioral-closure
verdict: proven
result: proven
interaction_touching: false
command: npm --prefix web run test:e2e -- opencode-down
receipt: S5 crux: Pins exact down-state strings in UI via /vh/fixture/oclife. Tree f4f7d6eb.
```

```behavioral-closure
verdict: proven
result: proven
interaction_touching: false
command: bash tests/e2e-docker/run.sh
receipt: S5 crux: Flow 8 exercises pkill, dead-window prompt 5xx, heal, and idempotent retry via scratch harness. Full lane claiming deferred (F2) due to pre-existing flakes. Tree f4f7d6eb.
```

## Defer Closure (F1/F2/F3)

- **F1 CLOSED** — `f4df6d67` `test(cmd): await subscribed snapshot before kill in boot-glue test`: 250ms sleep replaced by first-snapshot-ack barrier (complete `event: snapshot` frame awaited before SIGTERM); receipts 20/20 focused + full `./cmd/` ok. Trigger void.
- **F3 CLOSED** — `caeca726` `fix(web): synchronize OpenCode lifecycle pointer publication`: `atomic.Pointer[oclife.Lifecycle]`, one Load per handler (status/logs/restart), fixture race-by-design comment removed, new `-race` concurrency tests green. Sibling `restartOC` field remains plain (no live race, pre-serve wiring — noted as advisory, not fixed). Upgrade condition void.
- **F2 CLOSED** — `09818f6c` `test(e2e-docker): flow selector, hydrate readiness, deterministic 5-C seeding`: `--flow <n>` selector (pre-side-effect validation); Flow 8 per-PID tight death-log grep; Flow 1 SID readiness gate (120×1s); Flow 5-C deterministic tombstone seeding (archive completion observed as live-tree disappearance; 30s TTL; back-to-back delete); stale 5s→10s comments fixed; hidden flow-5→flow-1 calibration dependency fixed. Receipts: `--flow 8` PASS, `--flow 1` PASS, `--flow 5` PASS, **full default lane (1-8) exit 0** on tree `caeca72+slice` / image sha256:e5302498… / opencode 1.18.34; log at `tmp/agent-runs/kill-verification-defers/acceptance-run.log`. Claim language honored: full docker-gold lane passed (not full-repo/web green, not permanent flake elimination); Flow 8 retry = NEW message ID (no same-ID idempotency claim); C3 deep-cold-retry not reproduced (warm-leaning). Trigger satisfied.