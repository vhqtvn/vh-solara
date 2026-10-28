# Queue dispatch release rule — Path A (behavior-grade interim + witness-gated feature)

**Date:** 2026-10-27  
**Status:** DECIDED (operator)  
**Origin:** incident 2026-10-26  
Contradictions: see annex-2 §5 for the full correction register; none in this memo's own claims.

---

## Context

Under `--daemon-dispatch`, the daemon queue drain loop (`pkg/web/queue_drain_loop.go` `oldestDispatchable`) dispatched the oldest pending item with no busy/idle gate. Incident: 2026-10-26, session ses_f16719085ffetydJlYQ75lAOew (project /home/vhnvn/repo/vh-agent-pulse), queue item q-02ab3ec2fe6251f7 enqueued 18:18:09.970 while a 76-step subagent ran (root idle, subtree busy); POSTed to prompt_async 15 ms later; folded into the running turn at the next step. Root cause was an unrecorded omission, not a decision: the wait-until-idle policy lived in the FE drainer, which daemon dispatch switches to observe-only projection (`web/src/lib/queueDispatchMode.ts`); the policy did not migrate with dispatch ownership.

Feature contract (operator-fixed): default composer action = Send now (folds into running turn); explicit Queue = wait until whole tree idle (root busy|retry OR any descendant busy|retry = not idle); per-item immutable `dispatchPolicy: "now" | "queue"`, absence = "queue"; both through durable admission; UX = U5 always-visible `Queue` + `Send now` buttons; no sticky setting.

Evidence base (inherited from annexes; annex 2 supersedes annex 1 on conflicts):
- **E1:** No dispatch-correlated terminal witness exists today (not message persistence, cascade convergence, tree-idle, assistant-step completion — which multi-step runs and the interrupted-sweep synthesis invalidate — hydration, or status refresh); upstream opencode v1.18.14 (repo validation tag) has none.
- **E2:** Activity observations weakened by sticky hydration, nonfatal status-fetch failure, absent-status clearing, fetch/apply races.
- **E5:** 60s default reconciliation cadence; live events normally prompt.

## Decision: Path A

1. **EX (existing queue) — behavior-grade interim gate now**: daemon dispatch gated on visible whole-tree idleness (in-process canonical state, e.g. GateFacts over subtreeBusyCount; NOT the diag HTTP endpoint). Fixes the entire observably-busy class including the incident. Corner release rule (busy never observed) chosen via rubric Application 2 below.
2. **FE (policy feature) — strict O3**: dormant until a durable per-dispatch terminal witness (or equivalent ordered-registration/drain barrier contract) is validated upstream. `queueDispatchPolicyVersion: 1` advertised ONLY when the witness-backed scheduler is complete and enabled. Schema/U5 composer work stays designed-not-shipped until then (a Queue button that doesn't queue is a lie).
3. **G2 — custody-bypass bug (confirmed, live today)**: modern Retry path reaches `dispatchQueuedItem` direct-POST around daemon custody (unmarked `unknown` → generic QueueChip Retry → direct POST; 409 refusal can only fire after). Fixed as a standalone first slice: guard at render + execution; modern Retry must replay through admission, never direct-POST; override of custody ≠ retry certificate.
4. **G3 — schema/mode-flip contract (settled)**: schema 2 for policy-bearing files; policy-capable daemon upgrades schema 1→2 atomically before first policy persistence; schema 2 + daemon off = refuse before ANY mutation, preserve bytes, visible conflict; `now` under legacy drainer = refuse, never silently degrade to queue; no automatic downgrade; normalized-queue receipts keep old canonical bytes (policy omitted), `now` includes the member — compatibility is a test obligation.

## Rubric — options (O1–O5)

**Criteria:**
- **C1: Promise integrity (weight ×5)** — 5 proof-grade / 3 behavior-grade (fails only under total evidence loss) / 1 dispatches into observably busy tree. **GATE:** C1=1 in any shipped state disqualifies.
- **C2: Unattended liveness (weight ×4)**
- **C3: Mobile override burden (weight ×3)**
- **C4: Shippability now (weight ×3)**
- **C5: Forward migration (weight ×2)**

**Scores:**
- **O1: Quiet-window timer — 64** (C1=2 — can fire in the persistence→busy gap)
- **O2: Fail-closed + human — 51** (C2=2 — holds not rare; one obligation stalls overnight queue)
- **O3: Upstream contract — 73** (adopted for FE)
- **O4: Observed-episode release — 54** (ordering ≠ terminal correlation; short turns route to backstop)
- **O5: O2-now + O3-parallel — 53** (interim burden unsupported)

## Rubric — paths (A/B/C)

- **A: Interim gate on EX + strict O3 FE — SELECTED, 66, gate-clean**
  - Scores: C1=3 (EX rises 1→3; FE inactive, no promise) · C2=4 (corner mis-dispatches rather than stalls — waived) · C3=5 · C4=4 (small local gate; obligation machinery deferred to witness) · C5=4.
- **B: Strict O3 everywhere — 66 but GATED OUT**
  - Scores: EX stays C1=1 in the shipped state (the filed bug remains live awaiting perfection); C4=2 (local bug made contingent on external repo).
- **C: Manual-interim (O2 product) — 51**
  - Scores: C1=4 but C2=2 / C3=2 (routine override on a phone, overnight stalls).  
  *Note:* A corner-local fail-closed+override is a variant of A's Application-2 release rule, NOT a revival of Path C.

**Head-to-head:**
- A vs B decided solely by the gate (equal totals).
- A vs C decided by C2/C3 against C's C1 edge.

## Witness-gated release-rule state machine (from debate; activates with FE)

1. Capability unavailable → scheduler off, no advertisement; legacy schema-1 unchanged; schema-2/daemon-off refusal stands.
2. Eligibility requires current-generation whole-tree baseline + no unresolved obligations; unknown ≠ idle.
3. Obligation durably registered before every upstream attempt (both policies; Now bypasses waiting, never custody/fencing/journaling).
4. Held: persistence, sent-clearance, dismissal, compaction, timeout, and uncorrelated Busy→idle do NOT discharge; surface `completion_evidence_unavailable`, never auto-release.
5. Discharged only by validated terminal receipt/barrier covering that dispatch, or existing certified-nondelivery authority.
6. Tree-idle + all obligations discharged → exact-ID claim; its dispatch creates the next obligation.
7. Reconnect/restart: restore obligations, invalidate readiness before enabling Queue. Human release is NOT in the default; any future override contract = consent, never completion proof, never policy rewrite.

## Waiver register (operator-accepted, Path A)

- **W1:** EX corner mis-dispatch under total evidence loss (frequency unmeasured).
- **W2:** FE deferred until witness.
- **W3:** Two release-rule regimes coexist until migration.
- **W4:** Unrelated-actor idle→POST races remain (local eligibility ≠ global exclusion).

## Flip triggers

- Witness validated against annex-2 scenario matrix → FE activates (A converges to B's end-state).
- Corner mis-dispatch observed → re-score EX row via Application 2.
- Trust bar shifts to proof-grade for EX → A becomes B, re-run rubric.

## Rubric reuse (Applications)

- **App 2 — interim corner release rule** (visible-idle-only recheck vs positive-evidence observed-episode vs quiet-window): gate C1, weigh C2.
- **App 3 — upstream terminal-contract candidates** (per-dispatch receipt vs ordered-registration/drain barrier vs runner-idle watermark): dominant C1/C5, C4 scores upstream coupling.

## Authorized slice order

1. **G2 custody-bypass fix** (standalone, live bug).
2. **EX interim gate** (App 2 first).
3. **Upstream contract spec + validation** (App 3).
4. **FE schema/U5/composer** (gated on 3).
5. **Tests + closeout** (regressions: queue item pending while root-idle-but-subtree-busy; G2 retry no longer direct-POSTs; witness-gated tests per annex 2).

## Annexes

- [annex-1 solution brief (2026-10-27)](./2026-10-27-queue-dispatch-annex-1-solution-brief.md) — promoted from `tmp/agent-runs/send-now-queue-solution-20261027/brief.md`
- [annex-2 gap resolution (2026-10-27)](./2026-10-27-queue-dispatch-annex-2-gap-resolution.md) — promoted from `tmp/agent-runs/send-now-queue-gap-resolution-20261027/brief.md`; supersedes annex-1 on conflicts, incl. the dispatching-item-exclusion correction.
- [annex-3 upstream witness verdict (2026-10-27)](./2026-10-27-queue-dispatch-annex-3-upstream-witness.md) — promoted from `tmp/agent-runs/queue-upstream-witness-20261027/packet.md`; upstream witness verdict committed `11107d6`
- [annex-4 interim corner rule (2026-10-27)](./2026-10-27-queue-dispatch-annex-4-interim-corner-rule.md) — promoted from `tmp/agent-runs/queue-interim-corner-rule-20261027/report.md`; interim corner rule committed `d5d8153`
