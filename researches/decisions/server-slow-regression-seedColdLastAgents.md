# Server-slow regression — seedColdLastAgents reconnect fetch storm

## Context
Operator reported the server "used to not be this slow." A git-archaeology regression hunt identified the change(s) since the last release causing server-side slowness. Read-only source/decision packet.

## Findings
- **Baseline:** last release tag `v1.34.6` (`669faad`, 2026-06-30). STRICTLY since `v1.34.6`, ZERO server code changed (only `web/tests/e2e/*.spec.ts`). Any regression since that exact tag is environmental/upstream.
- **Prime suspect (against the operator's real comparison):** `v1.34.4` (`1a54da6`) — `seedColdLastAgents` in `pkg/aggregator/aggregator.go:167,198-243`. On EVERY event-stream (re)connect it fires upstream `GET /session/:id/message?limit=10` (`MessagesTail`, `pkg/opencode/client.go:321-337`) for EVERY un-opened (cold) session, 8-wide, and `wg.Wait()` (`aggregator.go:239`) BLOCKS `hydrate()` from completing. NO cross-reconnect memoization: `LoadedSessions()` (`pkg/state/store.go:1532`) only tracks client-opened sessions, so every cold session re-fetches on every reconnect. Storm scales with session count × reconnect frequency. SAME path as the agent-label root cause.
- **Secondary (medium-low):** commit `192cef7` (`git describe` = `v1.34.5-5-g192cef7`: 5 commits after `v1.34.5`/`0ef5f57`, 1 before `v1.34.6`/`669faad` — i.e. an unreleased commit that is an ancestor of the `v1.34.6` tag; it is NOT v1.34.5 and NOT the v1.34.6 tag itself) introduced `recomputeCurrentVerbLocked` (`pkg/state/store.go:974`) — bounded extra JSON scan per part-snapshot + per assistant message upsert; additive CPU, not the main culprit. (Verified: `git log -S recomputeCurrentVerbLocked --all` returns only `192cef7`; tags are present and `git describe` works in this clone.)
- **RULED OUT:** `client.Messages` "lost a limit" — always unbounded; `handleStream`/`ensureMessages`/startup ordering unchanged.

## Open forks / fix directions (cheap, reversible)
1. Memoize seeded sessions across reconnects — seed each cold session ONCE, invalidate on `session.remove`.
2. Move cold-seed off the reconnect-critical path — don't block `hydrate()`; seed in the background after hydrate returns, or lazily/bounded per tree-snapshot request.

## Recommendation
Combine (1) + (2): memoize across reconnects AND stop blocking hydrate. Preserve lastAgents end-state correctness (labels eventually populate). Interaction: the FE-side epoch-gate (stale-indicator memo, option S3) prevents `applySnapshot` from wiping correct labels during background seeding, so memoization + non-blocking seed + S3 together resolve both slowness and the agent-label regression. Fork #3 (EnsureMessages architecture) is a separate, deeper decision — HELD pending debate.
