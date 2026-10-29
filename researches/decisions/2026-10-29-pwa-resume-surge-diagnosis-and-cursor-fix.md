# PWA resume surge diagnosis and session cursor-loss fix — decision memo

**Date:** 2026-10-29  
**Status:** DECIDED (operator / coordinator)  
**Origin:** Incident & investigation 2026-10-28 – 2026-10-29  
**Target artifact:** `researches/decisions/2026-10-29-pwa-resume-surge-diagnosis-and-cursor-fix.md`  

---

## 1. Context: Symptom and Original Theory

On 2026-10-28, an operator reported severe resume latency on an installed Android PWA running ~12 workspace tabs (each tab hosted in an isolated, cross-origin iframe). Upon resuming the app after being backgrounded, the visible workspace exhibited persistent, multi-second "Connection lost — reconnecting…" toasts.

Initial server logs showed:
- ~12 tree opens arriving within 100ms.
- 3 full tree snapshot fallbacks reported as overflow.
- 1,481 selected-session replay frames.
- 2 cursorless selected-session opens at +23.79s and +31.70s.
- ~20 presence POSTs.
- Worker execution latency was consistently fast (<100ms per request, including a 36ms snapshot generation).

**Original Theory:** The delay was attributed to a "resume surge" causing browser/network thread contention and transport exhaustion. Specifically, all ~12 background tabs thawing simultaneously flooded the client network stack and JavaScript runloop, delaying visible-pane stream re-establishment. Proposed remedies centered on **admission control** (Option A: host-coordinated gating of recovery starts to prioritize the visible pane) or **watchdog deferral** (Option C: delaying hidden-pane background reconnections).

---

## 2. Investigation Chain

The investigation proceeded through structured coordinator-led phases:

1. **Solution Brief (`tmp/agent-runs/pwa-resume-surge/brief.md`):** Formulated options O1 (host-coordinated admission), O2 (local hidden spreading), O3 (redundant-recovery deduplication), and O4 (replay/fallback attribution). Lean was initially toward O1 / Option A, subject to empirical proof.
2. **S0 Start-Ownership Research (Task Card `task-2026-10-28t11-55-14-pwa-warm-resume-s0-admission-bounds-research`; `tmp/agent-runs/pwa-resume-surge/s0-research.md`):**
   - Enumerated all **29 stream restart paths** across tree (A1–A13) and session (B1–B16) streams.
   - Identified the **Known Edge** (`docs/ai/hidden-pane-status.md:69–76`): host-hidden panes produce no combined `paneVisible` transition on app resume; their trees were never suspended and thus reconnect via native retries (A3) and watchdog tick/legacyForce (A5/A6).
   - Proved that **no authoritative Stream-2 replay milestone** exists on the wire (no snapshot, no terminator frame); only tree streams emit `snapshot.complete`.
   - Identified that server-side `RingGap` wire signal conflates real ring eviction with `part.append` compatibility fallbacks (`stream_http.go:518–524` vs `tree-transport.ts:1029–1037`).
3. **Architecture Debate (`tmp/agent-runs/pwa-resume-surge/debate.md`):**
   - Concluded with a strict **diagnostics-first** ruling: land observational instrumentation first, capture real production resumes, and refrain from building admission control until client-side contention is empirically demonstrated.
4. **Diagnostics Instrumentation Landing (Commit `b2d3d62`, Task Card `task-2026-10-28t15-08-16-pwa-resume-diagnostics-capture-instrumentation`):**
   - Client: Added closed-enum `stream-open` reason tags and bounded EventSource lifecycle records (`es-life` distinguishing native browser retries `readyState=0` from JS-owned opens) in `web/src/sync/stream-open-diag.ts` and `diaglog.ts`.
   - Worker: Made `stream baseline` logging always-on in `pkg/web/stream_http.go`, explicitly publishing `fallback_reason` (`compatibility_fallback`, `ring_eviction`, `cursorless`, `none`) and `part_append_in_range`.
5. **Production Captures and Interpretation (`tmp/agent-runs/pwa-resume-surge/capture-1-interpretation.md`):**
   - Captured 16:56Z quiet resume, 17:03Z loaded 11-pane storm resume A, and 17:08Z follow-up.

---

## 3. Decision: The Reversal

### 3.1 Overturning the Surge-as-Contention Theory

Every instrumented capture directly contradicted the hypothesis that the 12-pane resume storm causes visible-pane starvation:
- During the 17:03Z 11-pane storm (2 busy projects, 1,014-frame replay, 2 fresh compatibility fallback trees), the worker served all 13 stream opens in **58ms** (.288–.346s).
- The visible pane's tree snapshot applied in **+134ms** post-onopen, directly in the middle of the storm.
- The 16:56Z long-background resume (a true ring-eviction double fresh fallback, gap 19,782 ≫ 4,096) converged in **<0.5s** (tree applied at +193ms, session snapshot applied at +349ms).
- A full cursorless session re-snapshot at 17:08Z applied in **+481ms**.
- The only measured multi-second transport delay was a **2.36s phone-side radio/ServiceWorker/TLS wake** between EventSource construction (`ts`) and `open@` (wall clock stall 07.257 → 09.614), completely outside application runloop scheduling.

**Disposition:**
- **Option A (Host-Coordinated Admission Ordering): PARKED.** The storm converges sub-second under load. Adding cross-origin host admission tokens, lease deadlines, and lifecycle complexity would add maintenance burden to solve a non-existent contention bottleneck.
- **Option C (Watchdog Reconnect Deferral): HELD.** While the thaw storm was proven to be ~100% JS-owned watchdog synchronization (A5/A6 `legacyForce`, `treeAge=240617ms > 45s`), deferring it yields negligible gain given 58ms total worker burst duration. Held pending evidence from weaker hardware.

### 3.2 What Was Actually Wrong: Session Cursor Loss ("Second Recovery")

The root cause of the afternoon's severe degradation was diagnosed as a recurring **session cursor-loss defect**:
1. When any fresh session stream open initiates, `closeSessionStream()` (`web/src/sync/session-stream.ts:474`) zeroes `sesCursor` and clears the suspend marker.
2. If that open delivers no applied content before the pane is hidden or backgrounded, `suspendSessionStreamForVisibility` closes the connection mid-flight and bumps `sesGen` (`:997`), discarding any in-flight gzip64 snapshot decode (`:860`).
3. The pane parks in an invalid state: *suspended, suspend marker set, but `sesCursor = 0`*.
4. On the subsequent reveal-resume (B3, `:1024`), `openSessionES` sends the preserved `sesCursor = 0` (`had_cursor = false`), forcing an expensive full-session snapshot rebuild.
5. On an hours-alive page with a long transcript and hundreds of DOM nodes, repeated full snapshot rebuilds trigger massive layout/re-render storms that pin the JavaScript thread and hold `reduceConnStatus` at `reconnecting` via the cascade's `convergence-pending` state (which bounds at 15s).

### 3.3 Confirmation: Compatibility Fallback vs Ring Eviction

The 3 "overflow" tree snapshots in the initial journal were proven empirically to be **`part.append` compatibility fallbacks**, NOT ring evictions:
- Worker instrumentation recorded `fallback_reason=compatibility_fallback` with `part_append_in_range=true` on both fresh trees (cursor gap 712 and 1122, well below default ring capacity 4096).
- The tree stream URL at `web/src/sync/tree-transport.ts:945–946` lacked delta opt-in, causing the server to conservatively fall back to a full snapshot whenever a streaming part append fell within the replay window.

---

## 4. The Fix (Commit `e2f0f36`)

Implemented under Task Card `task-2026-10-28t17-34-52-pwa-session-cursor-loss-fix` and landed in commit `e2f0f36efa2141e2366971aa8c095614f099e06b`:

### 4.1 Architecture and Invariants

1. **Per-Session Last-Applied Cursor Memory (`lastKnownSesCursor`):**
   - Maintained in module scope within `web/src/sync/session-stream.ts`.
   - Advances **strictly on applied content** (post generation-guard, post-epoch-guard, post-reducer apply):
     - `applySnap` inside `applySessionSnapshot` (`:882`).
     - `messages.batch` staged (`:1577`).
     - Final message-kind apply (`:1634`).
     - `part.append` flush (`:1738`, applied/skipped frames only).
   - In-flight, unapplied, or discarded decodes never advance the cursor.
2. **Send-Side Restoration:**
   - In `openSessionES` (`:771–778`): when live `sesCursor === 0`, `sendCursor` restores `lastKnownSesCursor` for preserving opens.
   - Preserving opens (reveal-resume B3, retry ladder B13) replay from the last-applied point instead of requesting full snapshots.
3. **Intentional Cursorless Forced Recoveries (Anti-Livelock):**
   - Forced recoveries (B10 `part.append` offset-mismatch, B12 silence fallback, B6/B9/B11/B15) deliberately bypass cursor restoration and stay cursorless (`sesCursor = 0`).
   - *Rationale:* Forcing a stale cursor on an offset mismatch would deterministically reproduce the mismatch, wedging the recovery loop into an infinite livelock.
4. **Project Boundary Reset:**
   - `lastKnownSesCursor` map is invalidated on `projectDir()` changes at the `switchProject` boundary, preventing stale cursor contamination across project resets.
5. **Enforcement Across Interleavings:**
   - **Seq cap (`pendingBatchSeqs`):** Bounds claims when append flushes interleave with in-flight batch decodes.
   - **Cross-flush mismatch latch (`mismatchLatchedSids`):** Latches on append mismatch during cascade subsume windows, uniformly gating incremental claims until cleared by an authoritative snapshot apply.

### 4.2 Review Loop Record and Adjudication

The change survived **six rigorous commit-review rounds (R1–R6)**, resolving five real concurrency and interleaving findings:
- **R1:** Fixed lazy project-scope invalidation during zero-open project excursions (A → "" → A).
- **R2 / R2b:** Fixed append-flush vs pending-batch decode races and batch-over-batch clobbering via `pendingBatchSeqs` and claim min-capping.
- **R3:** Addressed same-flush mismatched suffix hazards via flush-local mismatch gating.
- **R4 / R4b:** Addressed cross-flush mismatch hazards under resume-mode cascade subsume windows via uniform latch gating at the top of `claimSessionCursorApplied`.
- **R5 Coordinator Adjudication:**
  - *Contest:* 3 approvals, 1 block regarding whether `applySnap` should advance the cursor floor if `prependMessagesIfAbsent` skips merging repair content for keyed non-completed residents (`web/src/lib/reduce.ts:200–228`).
  - *Ruling:* Snapshot-receipt floor-raise **ACCEPTED**. Freezing cursor advance until full merge completion causes recovery livelocks. The store merge skip was adjudicated **PRE-EXISTING and OUT-OF-SLICE**, pinned bidirectionally in tests (`session-cursor-persistence.test.ts`), and routed to draft card `task-2026-10-28t18-40-00-store-merge-policy-gap-draft`.
- **R6:** Unanimous 4/4 APPROVE confirming boundary pins and absence of drift.

---

## 5. Post-Release Validation

On 2026-10-29 at **05:22Z**, production diagnostics captured a real warm resume on the updated build:
- The reveal-resume open for the active session sent:
  ```text
  cursor=187249 had_cursor=true
  ```
- Reconnection converged in **~908ms**.
- The pre-fix defect shape (`cursor=0 had_cursor=false` forcing a full gzip64 snapshot re-download) was confirmed eliminated in production.

---

## 6. Standing Outcomes

1. **Always-On Baseline Diagnostics:** Worker `stream baseline` logging remains permanently active in Info mode, providing continuous observability of `fallback_reason` and `part_append_in_range`.
2. **Established Diagnostics Protocol:** Retained at `tmp/agent-runs/pwa-resume-surge/capture-1/README.md` for evaluating future mobile network or client-side thaw anomalies.
3. **Closing Deferred B-F3:** Fake-timer tests in `web/tests/unit/streamOpenDiag.test.ts` now drive real production scheduled retry callbacks (tree CLOSED backoff and session retry ladder).

---

## 7. Known Gaps and Deferred Work

1. **Toast/Cascade Grading Amplifiers (Card 2):**
   - `ConnectionToast` lacks an internal expiry and can be orphaned in "reconnecting" by the degraded state (A-F4 residue) or cascade `convergence-pending` (bounded at 15s).
   - Card 2 (orphaned warn clearing and grade transition timestamps) remains unstarted as follow-up polish.
2. **Tree Stream `part_delta` Client Opt-In:**
   - Tree stream URL currently lacks the `part_delta=1` query parameter, generating benign compatibility fallbacks whenever `part.append` exists in the ring.
   - Deferred as a post-release protocol optimization (measured cost is negligible: ≤134ms).
3. **Capture-2 on Naturally Slow Occasion:**
   - Recommended on an hours-alive, non-reloaded page to capture complete grade transition logs during an authentic slow resume, definitively benchmarking the render-storm model vs environmental thermal/radio drag.
4. **Store Merge-Policy Gap (Draft Card `task-2026-10-28t18-40-00-store-merge-policy-gap-draft`):**
   - `prependMessagesIfAbsent` (`web/src/lib/reduce.ts:200–228`) skips snapshot repair for keyed non-completed residents (protecting streaming text from clobber).
   - Candidate for formal proof or guarded repair projection.
5. **Formal Verification Arc:**
   - The 6-round review loop demonstrated that manual inspection of concurrent sync interleavings is error-prone.
   - The session sync state machine and store merge policy are designated as the primary candidates for agent-authored formal verification (Lean 4) post-release.

---

## 8. Verification: Measured vs Inferred

To maintain strict epistemic honesty, evidence is classified into verified measurements versus model inferences:

| Item | Status | Basis |
|---|---|---|
| **Sub-second convergence under load** | **Measured (Fact)** | Worker served 13 opens in 58ms; visible tree snapshot applied in +134ms; ring-eviction applied in <500ms; full cursorless snapshot applied in +481ms. |
| **Phone radio/network wake latency** | **Measured (Fact)** | 2.36s delta between JS EventSource construction and `open@` on the phone. |
| **Watchdog thaw synchronization** | **Measured (Fact)** | Directly captured on host-hidden pane (`reason=watchdog detail=tree-stale-force`, clocks 240s/300s). |
| **Compatibility fallback vs eviction** | **Measured (Fact)** | Worker confirmed `part_append_in_range=true` on fresh trees with gap 712/1122 < 4096 capacity. |
| **Pre-fix cursor loss mechanism** | **Measured (Fact)** | Code path verified (`closeSessionStream:474`, `suspendSessionStream:997`); observed at 17:08Z (`cursor=0 had_cursor=false`). |
| **Post-fix production validation** | **Measured (Fact)** | 05:22Z capture confirmed `cursor=187249 had_cursor=true`, converging in ~908ms. |
| **Original afternoon symptom attribution** | **Inference** | Grounded in the observation of 2 cursorless re-snapshots on a long transcript, but no instrumentation was active during the original afternoon incident (n=1 uninstrumented run). |
| **Absence of slow resumes in post-reload runs** | **Inference / Confound** | Captures 16:56Z–17:08Z ran on a freshly reloaded page; cannot definitively exclude thermal throttling on hours-alive hardware without Capture-2. |

---

## 9. Provenance and Key Receipts

- **Solution Brief:** `tmp/agent-runs/pwa-resume-surge/brief.md`
- **S0 Research:** `tmp/agent-runs/pwa-resume-surge/s0-research.md` (Card `task-2026-10-28t11-55-14-pwa-warm-resume-s0-admission-bounds-research`)
- **Debate Record:** `tmp/agent-runs/pwa-resume-surge/debate.md`
- **Capture Protocol & Interpretation:** `tmp/agent-runs/pwa-resume-surge/capture-1/README.md`, `tmp/agent-runs/pwa-resume-surge/capture-1-interpretation.md`
- **Diagnostics Landing:** Commit `b2d3d62b8669e1ec928441fc928ab15b06133110` (Card `task-2026-10-28t15-08-16-pwa-resume-diagnostics-capture-instrumentation`)
- **Cursor Fix Landing:** Commit `e2f0f36efa2141e2366971aa8c095614f099e06b` (Card `task-2026-10-28t17-34-52-pwa-session-cursor-loss-fix`)
- **Coordinator Review & Adjudication:** `.local/coordinator/reports/task-2026-10-28t17-34-52-pwa-session-cursor-loss-fix/2026-10-28T21-39-49-review.md`
- **Store Merge-Policy Gap Draft:** Card `task-2026-10-28t18-40-00-store-merge-policy-gap-draft`
