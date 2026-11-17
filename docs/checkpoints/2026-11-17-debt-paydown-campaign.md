# Debt-Paydown Campaign Closeout (Waves W0–W8) — 2026-11-17

Durable checkpoint recording the resolution of the 2026-11-16/17 debt-paydown campaign across waves W0–W8, the cold-restore precedence decision, and associated lane probes.

HEAD: `b465a0c2373e85772705ce18850da43943fa04ea` (clean working tree). Total campaign scope: 21 commits (spanning `512b818..b465a0c` on `main`), not pushed.

Note: files under `.local/coordinator/tasks/` and `tmp/agent-runs/` are untracked local transport artifacts and are NOT durable. This checkpoint is the durable repo canon preserving all essential findings, decisions, and receipts.

---

## 1. Executive Summary: Pile 28 → 5 across Waves W0–W8

The campaign began from an audited ledger of 28 candidate DEFER / follow-up cards (`tmp/agent-runs/defer-restudy-2026-11-16/ledger.md`), methodically retiring, paying down, or re-fencing debt across 9 distinct waves:

- **W0 (Retire 9)**: 9 cards retired (refuted premises, already resolved in earlier slices, or declined consequence-free; e.g. e-ink surfaces slack, notificationclick target, pins multiclient flake, backnav breadth, fixture-web boot flock, reset pins/labels unrestored, lane-10 Firefox opt-in).
- **W1 (Web 6 + Real-Embed)** (`512b818..036b5c2`): 6 web/host-web lane defers discharged (`512b818`, `225b5cd`, `ffa4383`, `160e21b`, `036b5c2`), promoting host-web real-embed (Lane 8) to the push/PR matrix following 10 consecutive green scheduled CI runs (docs synced in `a6cc821`).
- **W2 (Go 3 + Matrix Sweep)** (`5334634`, `7a5ed8a`, `80262fd`): PromptAsyncDelayedPersist resetGen fence, mid-pass-3 reconcile restart-fmt pin test, GC-2 next-consumer boundary isolation test, and a full 5-project serial web e2e matrix sweep at `80262fd` (396 passed / 5 deliberate skips / 0 failed in 11.0m; closeout receipt `0cef476`, canonicalized in `3619211`).
- **Precedence Decision** (`25249f8`): settled cold-restore precedence as `saved-wins-with-validation` in `host-web/src/dockview/layoutPersistence.ts:81-90` based on operator sign-off and current-HEAD Lane-9 folded-posture e2e receipt (23/23 green).
- **W3a (Instrumentation + Cells)** (`9c86ef6`, `2ae28b5`): journaled the interrupted-turn mark (per-part shape + turn state in `pkg/state/interrupted_sweep.go`), and pinned cancel-during-grace-retry + dual slow-subscriber backpressure in `pkg/fixtures/multiproject_test.go`.
- **W3b (Lane-4 oc-dispose Probe)** (`dbea345`): zero-code probe proved `server.instance.disposed` forwards cleanly through the full stack on real OpenCode 1.18.34 via the takeover/dispose lever (`POST /vh/reload-project`); SIGTERM arm provably silent.
- **W4 (Empty-Tail Memo Fix)** (`215c1e8`): fixed `reseedCreatedSessionAgent` in `pkg/aggregator/cold-seed.go` to avoid memoizing empty-tail responses, preserving retry-eligibility on subsequent connection/session events.
- **W5 (Falsification Cell Red by Design)**: authored loaded-B / late-A reseed test against `pkg/aggregator/cold-seed.go`; demonstrated RED as predicted (held old tail response clobbered loaded lastAgent with live event). Preserved in run artifacts; zero production commits landed.
- **W6 (Loaded-State Fence)** (`11dc42c`): repaired W5 defect via atomic loaded-state fence (`msgLoaded`) in `Store.SetLastAgents` (`pkg/state/hydration.go`), lifting the W5 red test as the permanent regression pin `TestColdSeedReseedLateHeldResponseKeepsLoadedAgent`.
- **W7 (Adversarial Cells 1–2 + Cell 3 Red)** (`0325295`): pinned reseed delete-mid-fetch and cancel-mid-fetch safety in `pkg/aggregator/cold-seed_test.go`. Cell 3 (delete and recreate same session ID unloaded before old tail response arrives) demonstrated RED.
- **W8 (Incarnation Fence)** (`b465a0c`): repaired W7 cell-3 defect via monotonic `sessionIncarnation` counter in `pkg/state/store.go` bumped on session deletion, adding incarnation-aware cold-seed methods to Store and fencing both single-ID reseed and the batch sibling `seedColdLastAgents`. Verbatim cell-3 regression pin + batch tests landed green.

---

## 2. Headline: Two Real Production Defects Found and Fixed

Beyond test coverage and debt cleanup, the campaign uncovered and repaired two genuine production concurrency defects in OpenCode session state aggregation:

### Defect 1: Late Reseed Response Clobbered Authoritative Loaded State (`W5` → `W6`)
- **Mechanism**: `reseedCreatedSessionAgent` checked whether a session's messages were already loaded only at entry before firing the async HTTP `MessagesTail` request. If the tail response was delayed, and authoritative history arrived concurrently (e.g. via `SetSessionMessages` or live event stream) installing agent B, the returning tail GET with stale agent A invoked `Store.SetLastAgents(sid, A)`. This unconditionally clobbered agent B with stale agent A and broadcast a regressive live `KindLastAgentSet` event to connected clients.
- **Fix (`11dc42c`)**: Placed an atomic loaded-state fence inside `Store.SetLastAgents` (`pkg/state/hydration.go`). When `s.msgLoaded[sid]` is true, `SetLastAgents` declines the write under `s.mu`. Both single-session reseed and batch `seedColdLastAgents` route through this method, protecting both cold-seed paths by construction.
- **Regression Pin**: `TestColdSeedReseedLateHeldResponseKeepsLoadedAgent` (`pkg/aggregator/cold-seed_test.go`).

### Defect 2: Stale Old-Incarnation Response Seeded Recreated Session and Starved Re-Seed (`W7` → `W8`)
- **Mechanism**: When a session was deleted and quickly recreated under the same session ID while a cold-seed tail GET was in flight, the returning response from the dead incarnation wrote its stale agent into the fresh incarnation AND marked the session cold-seeded in the aggregator memo. This corrupted the new session's agent and starved the fresh incarnation's own re-seed from ever fetching its true agent. Crucially, the batch sibling `seedColdLastAgents` suffered from the exact same flaw during batch hydration fan-out.
- **Fix (`b465a0c`)**: Introduced a monotonic per-session `sessionIncarnation` counter in `Store`, incremented exclusively in `deleteSessionLocked` and never reset. Added incarnation-aware store primitives (`SessionIncarnation`, `MarkColdSeededAtIncarnation`, `SetLastAgentAtIncarnation`). `reseedCreatedSessionAgent` and batch `seedColdLastAgents` capture the incarnation prior to dispatch and submit writes bound to that incarnation; late arrivals for superseded incarnations are safely dropped.
- **Regression Pins**:
  - `TestColdSeedReseedDeleteRecreateUnloadedBeforeOldResponse` (cell-3 verbatim pin)
  - `TestColdSeedBatchDeleteRecreateMidFanOutKeepsFreshIncarnationClean`
  - `TestColdSeedBatchMarkedThenRecreatedBeforeFinalWriteDeclinesStaleWrite`

---

## 3. Remaining Debt Pile (5 Cards) and Evidence Bars

Five cards remain in the coordination pile, each parked behind a concrete, falsifiable evidence gate:

1. **Read-Position Candidate-Set Poll** (`task-2026-11-07t06-16-02-defer-read-position-candidate-set-poll-does-not-assert-which-candidate-landed`):
   - *Status*: Parked (HOLD).
   - *Evidence Bar*: Geometric boundary selection in `web/tests/e2e/read-position.spec.ts`. Candidates already carry distinct `data-mid` runtime values. Re-evaluating candidate-set assertions is 0 LOC justified until `ChatView.tsx` `bottommostReadFromDom` changes bottommost-row semantics AND a mutation demonstrates incremental detection value across configured browsers without false-red flakiness.
2. **Instant-Abort Interruptor Identity (R1 vs R2)** (`defer-instant-abort-cause-recurrence`):
   - *Status*: Parked (HOLD).
   - *Evidence Bar*: Requires a live production recurrence of the historical October 31 7–27ms pre-parts abort signature with the capture protocol followed (freezing `opencode.log` and events DB before restart). Daemon journal already self-captures `oc instance disposed`. 0 implementation LOC justified without causal bridge to historical runs.
3. **Interrupted-Sweep Recency Guard Residual** (`defer-interrupted-sweep-idle-reported-residual`):
   - *Status*: Parked (HOLD).
   - *Evidence Bar*: Residual idle-reported-while-generating shape across two reconcile intervals. W3a (`9c86ef6`) instrumented mark time via `vhlog.Info "interrupted turn marked"` in `pkg/state/interrupted_sweep.go`. Recurrence capture is now a single grep on that journal line. Reopen only on captured false-marker recurrence or upstream runner-side liveness signal.
4. **Batch `seedColdLastAgents` Empty-Tail Memoization** (`task-2026-11-17t06-39-03-defer-seedcoldlastagents-batch-hydrate-still-memoizes-empty-tails-unconditionally-w4-residual-reviewer-corroborated-3`):
   - *Status*: Draft (Parked, operator-gated).
   - *Evidence Bar*: W4 fixed the single-ID reseed path; the batch hydration path still marks cold-seeded on empty tails. Reopen on observed recurrence of a session pinned-empty by the batch path across disconnect windows, or the next legitimate touch of `seedColdLastAgents`.
5. **Pre-Existing `pkg/state` -race Flake `TestPartUpsertBurst_IncidentFixture`** (`task-2026-11-17t13-10-15-defer-pre-existing-pkg-state--race-flake-testpartupsertburst_incidentfixture-diagnostics.resetfortest-vs-grace-timer-race-pristine-head-reproduced`):
   - *Status*: Draft (Parked, operator-gated).
   - *Evidence Bar*: Diagnosed as an internal race between `diagnostics.ResetForTest` and an active grace-timer in `pkg/state`. Reproduced on pristine HEAD prior to W8 changes. Reopen on next legitimate touch of `pkg/state` diagnostics/grace-timer test infrastructure or CI flake report.

---

## 4. Residuals and Advisories

- **Precedence Decision Evidence Pointer**: The exploratory brief at `tmp/agent-runs/defer-restudy-2026-11-16/hostweb-precedence-brief.md` is gitignored. The authoritative canon is recorded in `host-web/src/dockview/layoutPersistence.ts:81-90` (commit `25249f8`): cold start restores `saved-wins-with-validation`, with seed used solely as fallback for the default workspace when no blob exists.
- **Dockerfile.e2e Unpinned OpenCode & Version Drift**: W3b probe verified `server.instance.disposed` forwarding on OpenCode 1.18.34. The incident observed on 2026-10-31 occurred on OpenCode 1.19.5. `Dockerfile.e2e` uses an unpinned install script (`curl -fsSL https://opencode.ai/install | bash`). An explicit version pin in `Dockerfile.e2e` remains an optional future CI hardening task.
- **SIGTERM vs Takeover/Dispose Distinction**: Confirmed empirically in W3b: OpenCode emits NO `server.instance.disposed` event on SIGTERM (stream drops with `unexpected EOF`); the event is emitted exclusively on explicit instance disposal (e.g. `POST /instance/dispose` via `/vh/reload-project`).
- **Optional Direct-Event Pin Hardening**: W6 review noted that `TestColdSeedReseedLateHeldResponseKeepsLoadedAgent` verifies store state `s.LastAgent(sid)` retention; an optional test hardening could additionally subscribe to the store event listener to verify that no regressive `KindLastAgentSet` event was broadcast.

---

## 5. Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| Pile reduced from 28 to 5 | 5 task cards active in `.local/coordinator/tasks/` | yes |
| Defect 1 fixed (loaded-state fence) | Commit `11dc42c`; `TestColdSeedReseedLateHeldResponseKeepsLoadedAgent` passes | yes |
| Defect 2 fixed (incarnation fence) | Commit `b465a0c`; `TestColdSeedReseedDeleteRecreateUnloadedBeforeOldResponse` + batch pins pass | yes |
| Campaign commit range reachable | `git merge-base --is-ancestor 512b818 b465a0c` exit 0; `git merge-base --is-ancestor b465a0c main` exit 0 | yes |
| Campaign commit count | 21 commits in campaign range (`512b818..b465a0c` excluding govulncheck `6ecde3a`) | yes |
| Working tree clean | `git status --porcelain` empty prior to checkpoint doc | yes |

---

## 6. Findings

- **Campaign Velocity & Debt Reduction**: source=git history and `.local/coordinator/tasks/`, confidence=high, type=fact. 28 candidate defers triaged to 5 parked cards across waves W0–W8.
- **Production Vulnerabilities in Cold-Seed Aggregation**: source=falsification cells in W5 and W7, confidence=high, type=fact. Cold-seed reseed and batch hydration had two reachable races (loaded-state clobber and recreation incarnation clobber), both fully repaired with atomic fences and monotonic incarnation tracking.
- **Dispose Signal Delivery**: source=W3b container logs (`dbea345`), confidence=high, type=fact. `server.instance.disposed` emits on takeover/dispose HTTP call, but never on SIGTERM.
- **Cold Restore Precedence Canon**: source=`host-web/src/dockview/layoutPersistence.ts` (`25249f8`), confidence=high, type=fact. Operator settled `saved-wins-with-validation`.

---

## 7. Contradictions

None detected.
