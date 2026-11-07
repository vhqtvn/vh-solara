# Verification Infrastructure & Claims Discipline

This document is the durable operator and maintainer guide for vh-solara's whole-data-flow verification infrastructure. It documents the generation, maintenance, drift guards, oracle honesty rules, and claims discipline governing the verification tooling across the Go HTTP stream handler, wire SSE fixtures, and TypeScript sync client.

For the background research and pilot closure decisions, see:
- [`researches/decisions/2026-10-29-pwa-resume-surge-diagnosis-and-cursor-fix.md`](../../researches/decisions/2026-10-29-pwa-resume-surge-diagnosis-and-cursor-fix.md)
- [`researches/decisions/2026-11-07-whole-flow-verification-pilot.md`](../../researches/decisions/2026-11-07-whole-flow-verification-pilot.md)

---

## 1. The Cursor-Mutant Calibration Harness

### 1.1 Architecture & Disposable Copy
`web/tests/unit/session-cursor-mutants.ts` is a **generated disposable copy** of `web/src/sync/session-stream.ts`. It instruments six calibrated mutation sites (M1–M6) to verify that the property test oracle in `web/tests/unit/session-cursor-property.test.ts` fails with attributed violations when synchronization invariants break:
- **M1:** Cursor advance suppression on batch decodes.
- **M2:** Stale cursor restoration bypass on reveal resume.
- **M3:** Unconditional cursor zeroing on suspend.
- **M4:** Over-eager cursor advance before message reducer completion.
- **M5:** Missing cross-flush mismatch latch.
- **M6:** Premature pendingBatchSeqs clearance.

### 1.2 Whole-File Round-Trip Drift Guard
The property test suite runs an automated drift guard (`web/tests/unit/session-cursor-property.test.ts:868-910`) that:
1. Strips the mutant header and arming hook.
2. Inverts import path rewrites (`../../src/sync/x` → `./x`).
3. Replaces each mutant scaffold (`MUT-SYNC-ORIGINAL <id> BEGIN .. MUT-SITE-END <id>`) with its pinned original production code.
4. Asserts **exact byte equality** between the reconstructed text and `web/src/sync/session-stream.ts`.

**What Red Means:**  
If `session-stream.ts` is edited in production without updating `session-cursor-mutants.ts`, the drift guard turns RED. This prevents the mutant harness from going silently stale.

### 1.3 Regeneration & Scratch Hook
To regenerate `session-cursor-mutants.ts` after production changes:
1. Use the script pattern established in `tmp/agent-runs/formal-verify-fullflow/gen-mutants.mjs` (or apply the header, import rewrites, arming hook, and mutant scaffolds to the updated `session-stream.ts`).
2. Run `npm --prefix web run test:unit -- session-cursor-property.test.ts` to confirm the drift guard and all 6 mutant kills pass.
3. **Scratch Hook (`VH_MUTANTS_COPY`):** To verify that the guard detects drift without modifying the tracked file, point the environment variable at a scratch copy:
   ```bash
   VH_MUTANTS_COPY=./session-cursor-mutants.scratch.ts npx vitest run tests/unit/session-cursor-property.test.ts
   ```

### 1.4 Scaffold Interior Blind-Spot (C-F1 Defer)
The drift guard reconstructs production by substituting pinned originals, which validates fidelity **outside** scaffolds and verifies that the pinned originals match production. However, it does not inspect the active mutant branches *inside* scaffold interiors.
- **Carried Defer O1.1/C-F1:** Add byte-fidelity pins for the mutant branch implementations.
- **Trigger:** `path_touched(web/tests/unit/session-cursor-mutants.ts)` or `path_touched(web/tests/unit/session-cursor-property.test.ts)`.

---

## 2. Go→TS Bridge Fixtures & Handlers

### 2.1 Real Handler Bytes via `httptest`
`pkg/web/stream_bridge_fixture_test.go` exercises the real Go stream handler (`pkg/web/stream_http.go`) via `httptest.NewServer` and records actual response bytes into `web/tests/unit/go-bridge-fixtures/` (10 `.sse` files and `manifest.json`).

### 2.2 Three Shape-Preserving Normalizations
To ensure byte-for-byte determinism across repeated generation runs, three specific transformations are applied identically at capture and comparison:
1. **Retry hint jitter:** The randomized `retry: <n>` header (from `sseRetryBaseMs + rand.Intn(sseRetryJitterMs)`) is normalized to the deterministic base `retry: 2000`.
2. **Deterministic per-life epoch tokens:** The `crypto/rand` store epoch token is normalized to role-based constants:
   - First store life: `ep-0000000000000000000aaaaa`
   - Second store life (epoch change in chain K): `ep-0000000000000000000bbbbb`  
   Because tokens are assigned by role rather than appearance order, distinct store lives never collapse into one token.
3. **Journal timestamp:** The RFC3339 timestamp in the captured `stream baseline` journal header is pinned to a constant string.

### 2.3 Drift Guard & Regeneration
In default test runs, `stream_bridge_fixture_test.go` regenerates all fixtures in memory and compares them against the committed files. Any divergence between Go handler behavior and committed fixtures causes a test failure.

To regenerate fixtures after an intentional Go streaming change:
```bash
VH_BRIDGE_FIXTURE_REGEN=1 go test ./pkg/web/ -run TestStreamBridgeFixture
```
*(Use `VH_BRIDGE_FIXTURE_REGEN_FORCE=1` only when bootstrapping a completely missing fixture set).*

### 2.4 Retry-Hint Raw Bounds Defer (O1.2/F2)
The retry-hint normalizer replaces `retry: \d+` with `retry: 2000` but currently does not assert that the pre-normalized value falls within the legal bounds `[sseRetryBaseMs, sseRetryBaseMs + sseRetryJitterMs)`.
- **Carried Defer O1.2/F2:** Add an explicit range check asserting raw retry-hint values before normalization.
- **Trigger:** `path_touched(pkg/web/stream_http.go)` (region around lines 98–99).

---

## 3. Bridge Oracle Honesty Rules

`web/tests/unit/session-cursor-bridge.test.ts` evaluates client consumption using an independent `ObligationOracle` that adheres to four strict honesty rules:

### 3.1 Two-Class Snapshot Witness
The oracle never relies on unconditional `() => true` assertions to discharge snapshot obligations. Instead, it employs two witness classes:
1. **Content Witness (content-residency):** For snapshots carrying message content (e.g. R1@4, E1@4, E2@10), the registration parses the frame JSON for newly-introduced message IDs and fingerprints existing store residency (`byId(id)`). The predicate observes `newly.some(mid => byId(mid) exists)` at settlement.
2. **Wire-Deferred Witness:** For messageless snapshots (e.g. C3), the predicate verifies `lastUrlCursor >= seq` after the URL read.

### 3.2 Epoch-Scoped Identities & Terminal Expiry
Obligations are identified by the tuple `${epoch}:${seq}:${kind}`. Floors are tracked separately per epoch:
- A snapshot from epoch B applying on the client establishes epoch B as the active lifetime.
- Any open obligations belonging to an older epoch A are immediately marked with the explicit terminal disposition **`expired`**.
- Expired obligations are inspectable, excluded from `openObligations()`, and never silently converted to `discharged`.

### 3.3 Settle Idempotence & Edge-Triggered Lifetime Establishment
`ObligationOracle.settle()` is idempotent:
- Lifetime transitions are **edge-triggered** via `establishedEpochs: Set<string>`. Replaying historical snapshot applies during subsequent settlement passes does not re-trigger epoch establishment or reset `activeEpoch` to an old epoch.
- Floor advances remain **level-triggered**, monotone, and epoch-scoped.
- Open obligations are re-tested at each settle, flipping to `applied` if content arrived via repair replay.

### 3.4 Expired-Sweep Launder Pin Defer (8c050640/F1)
Line 360 of `session-cursor-bridge.test.ts` excludes `expired` obligations from the discharge sweep (`o.disp !== "expired"`). Because no committed test schedule currently drives an expired obligation under a later same-epoch snapshot floor with `seq >= obligation.seq`, this clause is unpinned.
- **Carried Defer 8c050640/F1:** Add a launder-shape test verifying that an expired obligation (epoch A @ seq N) is not converted to `discharged` if an identical-seq snapshot from epoch A is encountered later.
- **Trigger:** `path_touched(web/tests/unit/session-cursor-bridge.test.ts)` (standing obligation on the next edit).

---

## 4. Claims Discipline (Epistemic Ceilings)

When interpreting or reporting verification results, maintain these four mandatory distinctions:

1. **Obligation-preservation observations at named revisions, NEVER production correctness:**  
   Verification passes demonstrate that obligations are preserved across the specific executed traces on the committed git revision. They do not prove the absence of bugs under untested interleavings or production network environments.
2. **The round-5b applied-through-merge boundary for snapshot discharge:**  
   The Content witness certifies delivery only for messages that `prependMessagesIfAbsent` inserts into the store. It does not witness inner part modifications on keyed non-completed resident messages that store merge policy leaves untouched.
3. **Live ≠ convergence:**  
   The client connection status reaching `live` indicates only that SSE streaming is active. It does not prove that local store state has fully converged with the server. A 15-second cascade timeout clears `convergence-pending` status even if convergence stalls.
4. **Unit seams — no browser scheduling, no goroutine interleavings:**  
   Node/vitest simulates EventSource events synchronously or via mock timers. It does not replicate browser UI event loops, background tab throttling, ServiceWorker lifecycle, DOM reflow latency, or OS thread preemption.

---

## 5. Summary of Carried Defers

| Defer ID | Target Path | Trigger Condition (`path_touched`) |
|---|---|---|
| **O1.1/C-F1** | `web/tests/unit/session-cursor-mutants.ts`<br>`web/tests/unit/session-cursor-property.test.ts` | `path_touched(web/tests/unit/session-cursor-mutants.ts)` or `path_touched(web/tests/unit/session-cursor-property.test.ts)` |
| **O1.2/F2** | `pkg/web/stream_http.go` (lines 98–99) | `path_touched(pkg/web/stream_http.go)` |
| **OB5/d-F2** | `web/src/sync/session-stream.ts` | `path_touched(web/src/sync/session-stream.ts)` |
| **8c050640/F1** | `web/tests/unit/session-cursor-bridge.test.ts` | `path_touched(web/tests/unit/session-cursor-bridge.test.ts)` |
