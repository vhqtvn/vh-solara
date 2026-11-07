# Whole-data-flow verification pilot — closing decision memo

**Date:** 2026-11-07  
**Status:** DECIDED (coordinator / operator)  
**Research question:** Can end-to-end data-flow obligations across Go emission, SSE wire transport, and TypeScript client consumption be verified with independent oracles, real handler bytes, and calibration mutants without full browser or LLM overhead?  
**Scope / Source policy:** Read-only study of committed artifacts on `main` up to `8c050640d6d748e17f0c9608ed9dd0e32559d7ea`. No uncommitted code executed; test runs and receipts drawn from commit records and review ledgers.  
**Target artifact:** `researches/decisions/2026-11-07-whole-flow-verification-pilot.md`  

---

## 1. Context and Scope

Following the PWA resume-surge cursor fix (`e2f0f36`), manual review of complex concurrent sync interleavings was recognized as error-prone. The whole-data-flow verification pilot was launched to construct an automated, high-assurance verification bridge spanning server-side stream emission in Go (`pkg/web/stream_http.go`), wire SSE transport, and client-side cursor progression in TypeScript (`web/src/sync/session-stream.ts`).

The pilot executed across five incremental slices (preceded by S0 foundation research and S1 mutant calibration in commit `c05cb914`):
1. **O1.1 (Harness freshness & whole-file drift guard):** Commit `cd96e1c3`.
2. **O1.2 (Go→TS obligation bridge & fixture generation):** Commit `817f442`.
3. **F3 (Two-class snapshot witness & negative control):** Commit `211d24f`.
4. **OB5 (Epoch handshake bridge with distinct lifetime epochs):** Commit `7818f4ce`.
5. **Settle idempotence micro-slice (Edge-triggered lifetime establishment):** Commit `8c050640`.

All 83 commits in the encompassing coordination arc (`b2d3d62..8c050640`) have landed on `main` and are pushed to `origin/main` (`main == origin/main @ 8c050640`).

---

## 2. Per-Slice Verification Outcomes

### Slice 1: O1.1 — Harness freshness & drift guard (`cd96e1c3`)
Commit `cd96e1c3` restored the freshness of `web/tests/unit/session-cursor-mutants.ts` after the production session-stream module drifted by +315/−10 lines during concurrent epoch-handshake work. It replaced the previous 5-region text pin with a robust, whole-file round-trip drift guard in `web/tests/unit/session-cursor-property.test.ts` that enforces exact structural parity outside marked mutant sites. Full calibration verified that all 6/6 canonical mutant kills reproduced identically to the original S1 datum with zero false greens.

### Slice 2: O1.2 — Real Go→TS obligation bridge (`817f442`)
Commit `817f442` implemented the core Go→TS bridge across `pkg/web/stream_bridge_fixture_test.go`, committed `.sse` wire fixtures in `web/tests/unit/go-bridge-fixtures/`, and consumer test `web/tests/unit/session-cursor-bridge.test.ts`. Fixtures are generated from the actual Go HTTP stream handler using `httptest` with recorded determinism receipts (double-capture byte equality) and three shape-preserving normalizations (retry hint, epoch token, and journal timestamp). The client test feeds real wire bytes through `session-stream.ts`, drives reconnects using the actual remembered URL cursor, and asserts five-way fallback truthfulness (`compatibility_fallback`, `ring_eviction`, `stale_cursor_exceeds_head`, `cursorless`, `none`) against an independent oracle. A byte-fidelity canary proved real decoding (corrupt byte fails apply), while no-stranding (E1/E2) and legitimate under-advance (R1/R2) chains passed.

### Slice 3: F3 — Two-class snapshot witness (`211d24f`)
Commit `211d24f` resolved the bridge oracle's reliance on trivial snapshot acceptance by replacing unconditional `() => true` predicates with a two-class snapshot witness. The **Content** class parses frame JSON for introduced message IDs, fingerprints current store residency at registration, and observes `newly.some(resident)` (scoped to the round-5b applied-through-merge boundary). The **Wire-deferred** class tracks messageless snapshots via `lastUrlCursor >= seq`. In a red-first four-leg negative control test, a registered-but-withheld valid snapshot provably neither raises the floor nor discharges obligations, confirming that the oracle independently verifies delivery rather than mirroring production assumptions.

### Slice 4: OB5 — Epoch handshake bridge with distinct lifetime epochs (`7818f4ce`)
Commit `7818f4ce` extended the bridge to distinct lifetime epochs across server store reboots. The Go harness generates per-life deterministic epoch tokens and emits real `epoch_mismatch` fallback scenarios. The TypeScript oracle was hardened with epoch-scoped identities (`${epoch}:${seq}:${kind}`) and per-epoch floors: dead-epoch obligations receive the explicit terminal disposition `expired` instead of being silently discharged by the new epoch's floor. When the client reconnects after an epoch mismatch, it claims the NEW epoch's repair point (`cursor=7&epoch=ep-b`). A dead-cursor perturbation test proved that treating a dead cursor as valid is caught by both the memory-open detector and reconnect URL assertions. Red-first tests against the pre-OB5 unscoped oracle demonstrated that the old oracle permitted false-green cross-epoch floor sweeps and deduplication swallows.

### Slice 5: Settle idempotence micro-slice (`8c050640`)
Commit `8c050640` fixed a latent oracle defect where repeatedly calling `settle()` after an epoch transition replayed historical snapshot applies, flipping `activeEpoch` back to the old epoch and incorrectly expiring open obligations in the new epoch. The fix made lifetime establishment edge-triggered via an `establishedEpochs: Set<string>` tracker, while keeping floor raises monotone and level-triggered. This ensures settle idempotence: `expired` is an immutable terminal disposition that can never be laundered back to `discharged` upon re-settlement.

---

## 3. Honest Ceilings (Vocabulary Contract)

To maintain rigorous truth in claims, all verification outcomes in this pilot are bounded by the following explicit epistemic ceilings:

1. **obligation-preservation OBSERVATIONS at named revisions, NEVER production correctness:**  
   The suite observes that specific obligations are preserved across defined execution traces under the exact tree state of the tested commits. It does not prove the global absence of defects or general production correctness across arbitrary environments.
2. **the round-5b applied-through-merge boundary for snapshot discharge:**  
   The Content witness claims only what `prependMessagesIfAbsent` provably inserts into the store. It does not witness internal part fields of pre-existing keyed residents that the merge policy deliberately skips.
3. **live ≠ convergence (cascade timeout clears pendingness without convergence):**  
   A client connection transitioning to a live state does not guarantee store convergence. The connection cascade incorporates a 15-second safety timeout that clears pendingness even if state reconciliation is incomplete or stalled.
4. **unit seams — no browser scheduling, no goroutine interleavings:**  
   All tests execute within node/vitest and Go `testing` unit harnesses. They do not simulate browser event loop scheduling, DOM reflow latency, ServiceWorker thread lifecycle, OS network stack buffering, or non-deterministic goroutine race interleavings.

---

## 4. Standing Infrastructure

The pilot established four durable verification components:

1. **Mutants harness + drift guard (`web/tests/unit/session-cursor-mutants.ts` & `session-cursor-property.test.ts`):**  
   A disposable mutated copy of `session-stream.ts` providing 6 calibrated mutation sites (M1–M6) covering cursor tracking, mismatch latching, and pending batch sequences. Protected by an automated whole-file round-trip drift guard.
2. **Bridge fixtures + guards (`pkg/web/stream_bridge_fixture_test.go` & `web/tests/unit/go-bridge-fixtures/`):**  
   10 committed `.sse` fixtures emitted directly from the Go stream handler, paired with `manifest.json`. Protected by an in-memory regenerate-and-compare test that fails if handler output diverges from committed fixtures.
3. **Two-class witness (`web/tests/unit/session-cursor-bridge.test.ts`):**  
   Independent Content-residency and Wire-deferred predicates that audit snapshot application without querying production bookkeeping flags.
4. **Epoch-scoped oracle (`web/tests/unit/session-cursor-bridge.test.ts`):**  
   Lifetime-aware obligation oracle enforcing epoch-qualified identities, edge-triggered lifetime establishment, terminal `expired` dispositions, and settle idempotence.

---

## 5. Reopen Triggers

Work in this domain should not be reopened casually. Future investigation is gated on the following strict triggers:

1. **A NAMED browser coverage gap (not generic 'more browser tests'):**  
   Reopen only if an authentic on-device or Playwright e2e failure reveals a discrepancy between unit-seam EventSource simulation and real browser network/DOM behavior—specifically naming the unobserved browser scheduling or event-order phenomenon.
2. **O2/Lean formal verification only against named questions with a tooling-readiness prerequisite:**  
   Reopen mathematical proof efforts (such as Lean 4 models of `prependMessagesIfAbsent` or the session sync state machine) only against a specifically articulated safety invariant, and only after formal verification tooling readiness (environment, mathlib availability, and automated CI checking) has been established rather than assumed.

---

## 6. Carried Defers and Trigger Predicates

Four trigger-gated follow-up items remain in the coordination holding area:

| Defer ID | Target File / Area | Trigger Predicate (`path_touched`) | Minimal Action When Trigger Fires |
|---|---|---|---|
| **O1.1/C-F1** | `web/tests/unit/session-cursor-mutants.ts`, `web/tests/unit/session-cursor-property.test.ts` | `path_touched(web/tests/unit/session-cursor-mutants.ts)` or `path_touched(web/tests/unit/session-cursor-property.test.ts)` | Pin byte fidelity inside mutant scaffold active branches (hardening the scaffold interior blind-spot). |
| **O1.2/F2** | `pkg/web/stream_http.go:98-99` | `path_touched(pkg/web/stream_http.go)` | Add explicit range checking on raw retry-hint values before normalizer normalization. |
| **OB5/d-F2** | `web/src/sync/session-stream.ts` | `path_touched(web/src/sync/session-stream.ts)` | Upgrade K3 Detector-2 from string substitution to an executed-mutant leg. |
| **8c050640/F1** | `web/tests/unit/session-cursor-bridge.test.ts` | `path_touched(web/tests/unit/session-cursor-bridge.test.ts)` (next edit) | Add an oracle-only launder-shape pin ensuring expired A@N plus later A-snapshot@N remains expired. |

---

## 7. Findings

- **(pilot slices landed and pushed)**: source=`git log b2d3d62..8c050640` and `git rev-parse main origin/main`, confidence=high, type=fact
- **(drift guard efficacy)**: source=`web/tests/unit/session-cursor-property.test.ts:44-90`, confidence=high, type=fact
- **(real handler byte emission)**: source=`pkg/web/stream_bridge_fixture_test.go:48-120`, confidence=high, type=fact
- **(oracle honesty bounds)**: source=`web/tests/unit/session-cursor-bridge.test.ts:280-410`, confidence=high, type=fact
- **(radio wake dominates resume latency)**: source=`tmp/agent-runs/pwa-resume-surge/capture-1/README.md` and capture-3, confidence=high, type=fact
- **(unit seams omit runtime concurrency)**: source=codebase inspection of node/vitest single-threaded JS runloop vs browser WebWorkers/ServiceWorkers, confidence=high, type=fact

---

## Contradictions

- **Corpus style drift vs researches/AGENTS.md**: Prior decision memos across `researches/decisions/` (17 files) omitted the mandatory `## Contradictions` section specified in `researches/AGENTS.md`. This closing memo corrects that divergence by providing this explicit section.
- **Pilot internal consistency**: None detected within the verification pilot results. All 5 slices adhered to red-first discipline, established monotone invariants, and corroborated the recorded findings without conflicting claims.

---

## 9. Disclaimer and Next specialist

This memo represents a durable research and decision-shaping evidence record, not active repo operational policy. Operational instructions reside in `docs/ai/verification-infra.md`.

- **Recommended next specialist:** `docs-steward` for backlog synchronization and durable documentation maintenance; `planner` if a named browser coverage gap or formal proof trigger fires.
