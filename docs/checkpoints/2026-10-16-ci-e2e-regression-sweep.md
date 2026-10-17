# CI-e2e Regression Sweep Arc — Durable Verification Record

Date: 2026-10-16  
Scope: Durable checkpoint recording the root-cause resolution, verification posture, residual risks, and follow-up curation for the 8-failure CI e2e regression sweep across web, fixtures, and aggregator boundaries.  
Commits on local `main` (unpushed, commit-reviewed, gated):
1. `77f8aafdcd6c63f7f8941dff50daed5d667b3b6a` — `fix(web): full-width AmbiguousChip notes stop the e-ink viewport chat collapse`
2. `d41f0bff9ecc4e2063479b582315c1d843ab595e` — `fix(fixtures): /reset clears daemon queue custody (serial-e2e de-flaker)`
3. `4f498f1dea5d38ae91a031dd206936da5e188b52` — `fix(fixtures): backpressure the mp pump so slow subscribers stop severing`
4. `19287ef480578c324e5b66885793003cc0773d02` — `fix(aggregator): re-seed lastAgent on live session.created after reset wipes`

---

## 1. Triggering CI Run & Failure Decomposition

A GitHub Actions CI run on `main` encountered 8 failures across the serial web e2e lane. Analysis decomposed the 8 failures into three distinct mechanism clusters:

1. **e-ink Viewport Collapse Cluster (6 failures in `scroll-follow.spec.ts` under `firefox-eink-scroll`):**
   - Tests (19), (20), (22), (23), (24), (25) failed in the `firefox-eink-scroll` project at 400×600 viewport.
   - Symptom: `.chat-main` height collapsed to ~0px; the in-flow e-ink paging toolbar (`[data-eink="prev-page"]`) was pointer-intercepted by `.chat-status` (`.tasks-count`).
   - Mechanical trigger: A contaminated queue left by an earlier test armed `ambiguousDelivery` mid-run, mounting `.ambiguousChip` with its verbatim ~170-character warning text.
2. **Multiproject Contention SSE Sever Cluster (1 failure in `multiproject.spec.ts` A2):**
   - Test `multiproject.spec.ts` failed during S5 filler workload (`dropped_run=10`, "filler overflow").
   - Symptom: FakeOpenCode SSE subscriber channel filled; `emit` closed the channel on overflow, abruptly severing the SSE connection. On retry #2, a 2048-byte chunk was lost during the reconnect window (SSE has no event replay).
3. **Reasoning Paging CI-Only Failure (1 failure in `eink-surfaces.spec.ts:638`):**
   - Test `e-ink ON: reasoning body pages independently of the transcript` failed with `barInChatView: false` on Chromium in CI.
   - Symptom: Paging bar visibility assertion failed; passes 100% locally across isolated, mini-lane, and full serial lane runs.

---

## 2. Root Causes and Corrective Slices

Four distinct root causes were identified and fixed across four sequential commits:

### Slice 1: CSS Wrapping Fix (`77f8aaf`)
- **Root cause:** In `web/src/components/AmbiguousChip.module.css`, the `.ambiguousChip` warning note was a same-row flex child with `overflow-wrap: anywhere` (min-content = 1ch). In the narrow 400×600 e-ink viewport, the ~170-character string wrapped one character per line, growing unboundedly tall and collapsing `.chat-main` to ~0px.
- **Fix:** Applied the repository queue-detail-note idiom: added `flex-wrap: wrap` to `.ambiguousChip`; converted `.warning` and `.stale` into full-width lines (`flex-basis: 100%; width: 100%`).
- **Behavioral-Closure Receipt (satisfies CSS review tier1_b-F1):**
```behavioral-closure
verdict: proven
result: proven
path: "web/src/components/AmbiguousChip.module.css -> flex-wrap on .ambiguousChip + full-width .warning/.stale flex-basis:100%"
verifier: "web/tests/unit/AmbiguousChip.test.tsx + web/tests/e2e/scroll-follow.spec.ts (firefox-eink-scroll project)"
command: "npm --prefix web run test:unit -- AmbiguousChip && npx playwright test --project=firefox-eink-scroll web/tests/e2e/scroll-follow.spec.ts"
tree: "77f8aafdcd6c63f7f8941dff50daed5d667b3b6a"
outcome: "Unit 8/8 passed; all 6 CI scroll-follow tests passed; .chat-main remains expanded (>300px); e-ink paging toolbar remains clickable without pointer interception"
```
*Standing rule:* Any future `claim_behavioral_completion` on the `AmbiguousChip` path must cite this receipt.

### Slice 2: Fixture Reset Queue Clearance (`d41f0bf`)
- **Root cause:** POST `/oc/fixture/reset` wiped messages, busy flags, and blockers, but left the daemon-side live queue intact. An earlier test's hung prompt remained in daemon queue custody, leaking into subsequent demo tests, causing reconcile 404s and arming `ambiguousDelivery` mid-run.
- **Fix:** `pkg/fixtures/opencode.go` `handleFixtureReset` now executes `resetSessionQueueState`:
  1. Sweeps and cancels prompt-hold latches.
  2. Deterministically sweeps `queue.json` files (clears journal, items, reconcile budgets).
  3. Drives live daemon queue cleanup via synthetic `session.deleted` → GC-2 `CleanupSession` → synthetic `session.created` re-emit.
- **Side effect:** Reset now re-colds the session's store entry (messages re-hydrate on subsequent open).

### Slice 3: Multiproject Pump Backpressure (`4f498f1`)
- **Root cause:** In `pkg/fixtures/mpworkload.go`, `FakeOpenCode.emit` fan-out performed non-blocking channel sends into each 64-slot `/event` subscriber channel. On channel full, it logged a drop and closed the subscriber, severing the HTTP SSE connection. On resource-constrained 2-core CI runners during a 390-test serial lane, a ≥32ms aggregator stall overflowed the channel (`dropped_run=10`). Real OpenCode backpressures losslessly over TCP.
- **Fix:** Added `emitBackpressure`, retrying full subscriber channels every 2ms within a 2-second grace (`mpEmitGrace`), falling back to drop/close only if grace expires (preserving the wedge contract). Global `emit()` remains untouched for zero regression risk to existing tests.
- **Seam proof:** `pkg/fixtures/multiproject_test.go` `TestMPWorkloadSlowSubscriberBackpressure` pins an alive rate-capped subscriber: red pre-fix (dropped_run=1), green post-fix (0 drops, 304/304 delivered).

### Slice 4: Aggregator Cold-Seed Re-Seed (`19287ef`)
- **Root cause:** `d41f0bf`'s fixture reset emit of `session.deleted` cleared the aggregator's store entry, including `lastAgent` and the cold-seed memo (`s.seeded[id]`). However, the subsequent `session.created` was not re-seeded because `startColdSeed` only executes on initial hydrate. In a connected serial e2e lane, the aggregator never rehydrates mid-run, leaving `lastAgent` empty. Consequently, `tree2-symptoms(c)` timed out waiting for the `.tree-agent` chip in full-lane ordering.
- **Fix:** Added `startCreatedSessionReseed` / `reseedCreatedSessionAgent` in `pkg/aggregator/cold-seed.go`, triggered from `pkg/aggregator/lifecycle.go` upon observing a live `session.created` event. Performs a single-session tail fetch with guards (skips loaded sessions, skips already-seeded, ignores failed fetch without memoizing, no-ops on re-delete race).

---

## 3. Verification Posture

- **Per-slice Seam Closure:** Dual-seam red→green demonstrated for each commit:
  - `77f8aaf`: Vitest unit (8/8) + Playwright `firefox-eink-scroll` 6-test targeted sweep.
  - `d41f0bf`: Go unit/integration TDD (`pkg/fixtures/opencode_resetqueue_test.go`, 458 lines) + `ux.spec.ts` & `scroll-follow.spec.ts` 43/0 serial chain on shared fixtureserver.
  - `4f498f1`: Go unit `TestMPWorkloadSlowSubscriberBackpressure` red→green + A2 spec green ×5 (including repeat-each).
  - `19287ef`: Unit event-ordered red (5.93s timeout) → green + e2e repro red → green.
- **Full Serial Web-e2e Lane Post-Fix:**
  - **Run 1:** 387 passed, 1 failed (`pins-multiclient.spec.ts:151(b)` 5s unpin-convergence timeout), 5 skipped.
  - **Run 2:** 388 passed, 0 failed, 5 skipped (100% clean full lane).
  - The single failure in Run 1 was an isolated timing flake in `pins-multiclient.spec.ts` (passed ×3 isolated and clean in Run 2), mechanism-disjoint from all four commits.
- **Review Panel:** All four commits reviewed and unanimously approved via the gated-commit reviewer cascade, with behavioral-closure receipts bound to committed trees.

---

## 4. Residual Risks & Verification Gates

1. **A2 CI-Efficacy Confirmation (Push Verification Gate):**
   - *Status:* Gate attached to upcoming push; **NOT** a backlog item.
   - *Requirement:* The claim "A2 resolved in CI" remains open until an actual GitHub Actions run confirms `dropped_run=0` under runner contention.
2. **`eink-surfaces.spec.ts:638` CI-Only Failure:**
   - *Status:* Open investigation defer (`defer-eink-surfaces-638-ci-only-investigation`).
   - *Detail:* Chromium `barInChatView: false` was observed only on CI; unreproduced locally across all headless, headed, and full serial lane runs. Font-metrics or display-environment differences remain unproven until next CI observation.
3. **Borderline Viewport Geometry (`scroll-follow.spec.ts:1943`):**
   - *Status:* Operator sign-off defer (`defer-scroll-follow-1943-queue-row-max-height`).
   - *Detail:* Under 400×600 e-ink viewport, an armed AmbiguousChip leaves ~142px visible chat area. Both post-fix full lanes are green; a potential queue-row max-height defense is a UX design decision.
4. **Pins Multi-Client Flake (`pins-multiclient.spec.ts:151`):**
   - *Status:* Watch-class defer (`defer-pins-multiclient-unpin-convergence-flake`).
   - *Detail:* 5s unpin-convergence timeout observed once during lane run 1; passed isolated ×3, passed in mini-lane, and passed clean in lane run 2.

---

## 5. Curated Follow-Up Inventory & Registry Pointers

Curated via the `resolve-first` intake bar and placed per repo convention:

| Item | Topic | resolve-first Classification | Placement & Key Trigger / Ref |
|---|---|---|---|
| **a** | AmbiguousChip behavioral-closure receipt | `resolve-now` | **Resolved now in durable docs:** Surfaced in §2 above (commit `77f8aaf` receipt). Future claims bound by standing rule. |
| **b** | Armed-chip geometry e2e spec (400×600) | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-e2e-ambiguouschip-geometry-spec.json` (`trigger:path_touched(pkg/fixtures/opencode.go)`). |
| **c** | Reset GC-2 boundary isolation & ABA test | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-reset-gc2-boundary-isolation.json` (`trigger:path_touched(web/tests/e2e/queue-delivery-custody.spec.ts)`). |
| **d** | Stale comment in `scroll-follow.spec.ts:908` | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-scroll-follow-stale-recold-comment.json` (`trigger:path_touched(web/tests/e2e/scroll-follow.spec.ts)`). |
| **e** | Reset clears pins/labels without restoration | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-reset-pins-labels-unrestored.json` (`trigger:path_touched(pkg/fixtures/opencode.go)`). |
| **f** | Full web-e2e matrix sweep on fixture touch | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-fixtures-opencode-full-matrix-sweep.json` (`trigger:path_touched(pkg/fixtures/opencode.go)`). |
| **g** | `emitBackpressure` cancel & dual-slow tests | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-emitbackpressure-coverage-gaps.json` (`trigger:path_touched(pkg/fixtures/mpworkload.go)`). |
| **h** | Export `VH_MP_A2_OUT` in `ci.yml` on failure | `executable-now` (boundary crosser: owner-change) | **Promoted to backlog `docs/planning/backlog.md`:** Row `P2-CI-003` under `Next` + local transport card `.local/coordinator/tasks/task-ci-export-vh-mp-a2-out.json`. |
| **i** | Reseed adversarial test permutations | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-reseed-adversarial-coverage.json` (`trigger:path_touched(pkg/aggregator/cold-seed.go)`). |
| **j** | Reseed empty-tail memo marking hardening | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-reseed-empty-tail-memo.json` (`trigger:path_touched(pkg/aggregator/cold-seed.go)`). |
| **k** | `eink-surfaces.spec.ts:638` CI failure study | `defer-with-trigger` (`blocked-on-absent-evidence`)| Local transport card `.local/coordinator/tasks/defer-eink-surfaces-638-ci-only-investigation.json` (`trigger:operator-driven` on next CI red). |
| **l** | Queue-row max-height defense (scroll-follow:1943) | `defer-with-trigger` (`operator-reserved-signoff`)| Local transport card `.local/coordinator/tasks/defer-scroll-follow-1943-queue-row-max-height.json` (`trigger:path_touched(web/src/components/AmbiguousChip.module.css)`). |
| **m** | DelayedPersist `resetGen` fence | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-delayedpersist-resetgen-fence.json` (`trigger:path_touched(pkg/fixtures/opencode.go)`). |
| **n** | `pins-multiclient.spec.ts:151` unpin flake watch | `defer-with-trigger` (`pure-future-watch`) | Local transport card `.local/coordinator/tasks/defer-pins-multiclient-unpin-convergence-flake.json` (`trigger:path_touched(web/tests/e2e/pins-multiclient.spec.ts)`). |

---

## 6. Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| Commit 77f8aaf landed on local main | `git log -1 --oneline 77f8aaf` (fix(web): full-width AmbiguousChip notes...) | yes |
| Commit d41f0bf landed on local main | `git log -1 --oneline d41f0bf` (fix(fixtures): /reset clears daemon queue custody...) | yes |
| Commit 4f498f1 landed on local main | `git log -1 --oneline 4f498f1` (fix(fixtures): backpressure the mp pump...) | yes |
| Commit 19287ef landed on local main | `git log -1 --oneline 19287ef` (fix(aggregator): re-seed lastAgent on live session.created...) | yes |
| AmbiguousChip unit tests pass | `web/tests/unit/AmbiguousChip.test.tsx` (8/8 passed) | yes |
| Full serial web-e2e lane green | Run 1: 387/1/5 (disjoint flake); Run 2: 388/0/5 (100% green) | yes |
| Backlog row P2-CI-003 added to Next | `docs/planning/backlog.md` line check under `## Next` | yes |
| Curated draft cards written to local transport | 13 `.json` cards present in `.local/coordinator/tasks/` | yes |
| Concurrent session files untouched | `git status` verifies only `web/src/queue.ts`, `web/tests/unit/queue.test.ts`, `web/tests/unit/queueDeliveredOverlay.test.ts` (pre-existing) | yes |

---

## 7. Findings

- **AmbiguousChip flex layout failure mode**: `min-content = 1ch` on a flex row child with `overflow-wrap: anywhere` forces unbounded vertical growth at narrow viewports (400px), collapsing sibling flex containers (`.chat-main`).  
  *Type:* fact · *Confidence:* high · *Source:* commit `77f8aaf` + DOM inspection in Playwright.
- **Fixture queue custody leakage across serial tests**: Clearing messages on `/oc/fixture/reset` without resetting daemon queue custody allows in-flight prompt claims to survive into subsequent tests, arming ambiguous delivery warnings on unrelated runs.  
  *Type:* fact · *Confidence:* high · *Source:* commit `d41f0bf` + `pkg/fixtures/opencode_resetqueue_test.go`.
- **SSE severing under channel overflow**: FakeOpenCode closing subscriber channels on channel-full causes hard SSE disconnections that lose events during client reconnect.  
  *Type:* fact · *Confidence:* high · *Source:* commit `4f498f1` + `pkg/fixtures/multiproject_test.go`.
- **Aggregator store wipe without re-seed**: Reset's `session.deleted` event wipes the store's cold-seed memo, but `session.created` was not triggering a single-session tail fetch because `startColdSeed` only ran on initial hydrate.  
  *Type:* fact · *Confidence:* high · *Source:* commit `19287ef` + `pkg/aggregator/coldseed_reseed_test.go`.
- **A2 CI-efficacy verification gate posture**: Complete resolution of A2 failure cannot be fully claimed until observed in a real CI execution on GitHub Actions runners (`dropped_run=0`).  
  *Type:* inference · *Confidence:* high · *Source:* commit `4f498f1` review notes.
- **`eink-surfaces.spec.ts:638` CI-only divergence**: Difference between CI and local execution is likely tied to headless font rendering or subpixel geometry affecting `barInChatView`.  
  *Type:* assumption · *Confidence:* medium · *Source:* commit `77f8aaf` / `19287ef` review discussions.

---

## 8. Contradictions

- **Backlog vs. Local Transport Card Precedent Divergence:** Older backlog entries in `docs/planning/backlog.md` (e.g. `P2-API-006`, `P2-AGG-009`, `P2-WEB-052`) filed review-defers directly into `Later` with `trigger:path_touched(...)` tags. Codified repo discipline in `RECORD_LIFECYCLE.md` and the `backlog` skill now mandates that review defers are intake predicates held in `.local/coordinator/tasks/` as `status:draft`, promoted to `backlog.md` only upon crossing a lifecycle boundary (blocked, owner-change, must-survive-session). This contradiction was resolved by holding items b–g and i–n in local transport cards while promoting only item h (`P2-CI-003`, owner-change to build agent) to `docs/planning/backlog.md`.
