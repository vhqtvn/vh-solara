# Send now / Queue: EX interim corner rule — rubric Application 2 adjudication (annex 4)

**Date:** 2026-10-27  
**Status:** COMPLETE (adjudication; Candidate A adopted by the landed S2 interim gate)  
**Origin:** Task card `queue-idle-gate-send-now` (slice S2)  

> Promoted-from: tmp/agent-runs/queue-interim-corner-rule-20261027/report.md  
> Original date: 2026-10-27  
> Provenance: researcher pass task ses_e879eaabffe10AfYEfDOCdhDn, 2026-10-27  
> Relationship: adjudicates the release-rule memo's "Rubric reuse" Application 2 (interim corner release rule — gate C1, weigh C2) for the S2 interim gate; annex-2/annex-3 supersession lines are unaffected.  

---

> Transient research packet (task-scoped). Read-only pass; no code touched, no git operations.
> Ground truth: researches/decisions/ memos committed at f240a03 (verified: HEAD == f240a03 via
> `git log`). Topic is **stable / repo-local** — no external sources consulted, none needed.
> Source policy: repo canon first (the three memos + code at HEAD), then rubric application.

## Research question

Which corner rule should the EX behavior-grade interim idle gate on the daemon queue drain loop
adopt, per the committed decision memo's "Rubric reuse" Application 2 ("interim corner release
rule … gate C1, weigh C2")? For each of the 7 race corners from annex-2 §1: BLOCK dispatch,
ALLOW dispatch, or FAILS-CLOSED-HOLD pending the S3 upstream terminal witness.

## Scope fences (settled — not re-litigated)

- Behavior-grade only: no obligations, no scheduler, no timer release, no human override
  (memo Decision 1-2; hard ground rules).
- Eligibility aggregate = in-process canonical subtree state (Store.GateFacts /
  subtreeBusyCount), NOT the busy-diag HTTP endpoint (busy_diag.go:35-39 "not hot paths";
  memo Decision 1; annex-1 E4).
- Legacy (daemon-off, schema-1) unchanged; gate lives inside the daemon dispatch loop only
  (maybeStartQueueDrainLoop's DaemonDispatchEnabled check, queue_drain_loop.go:157).
- Custody fence + attempt-journal invariants untouched; gate sits before claim / before
  resume-marker consumption (annex-2 §1 reservation lifecycle item 2's ordering).

## Code facts the rule rests on (all read at HEAD = f240a03)

- **(finding)** The drain loop's tick does, per discovered session lane: certified recovery pass
  FIRST, then `oldestDispatchable` → resume-or-claim, one work item per lane per tick
  (queue_drain_loop.go:338-405); `oldestDispatchable` (444-471) returns a `dispatching+RequeuePending`
  item (resume) before the oldest `QueuePending` item (claim). There is NO busy gate today.
  source=pkg/web/queue_drain_loop.go, confidence=high, type=fact
- **(finding)** `Aggregator.Store()` exposes the canonical `*state.Store` to the web layer
  (pkg/aggregator/aggregator.go:357) — the loop already holds the aggregator (`aggForExisting`,
  queue_drain_loop.go:340). The gate needs no new wiring.
  source=pkg/aggregator/aggregator.go:357, confidence=high, type=fact
- **(finding)** `subtreeBusyCount[id]` = number of **busy/retry** sessions in id's subtree
  inclusive of self (store.go:928-952; maintained at the setActivityAtLocked chokepoint,
  reducers.go:190-215). **Error is excluded by design** (the carve-out; tree_finish_cascade_test.go:449-461,
  fleet_selection_test.go:364). This exactly matches the operator contract's
  "root busy|retry OR any descendant busy|retry = not idle" (memo Context).
  source=pkg/state/store.go + tests, confidence=high, type=fact
- **(finding)** `GateFacts.SubtreeBusy` is `subtreeBusyCount[sid] > 0` via the one shared
  derivation `gateFactsFromScalars` (snapshots.go:840-844, 942; accessor GateFacts 908-945).
  Missing activity renders idle (`act == "" → ActivityIdle`, snapshots.go:841-844) — a
  never-observed session is NOT positively busy.
  source=pkg/state/snapshots.go, confidence=high, type=fact
- **(finding)** `GateFacts` does not expose parent links; exact root resolution exists as
  `rootOfLocked` (store.go:1367). Annex-1 E4 pre-authorizes "read [GateFacts] once per project
  tick, **or expose a narrow canonical accessor if justified**" (annex-1 §2 feasibility note).
  source=pkg/state/store.go:1367 + annex-1 §2, confidence=high, type=fact
- **(finding)** TRAP rejected: `Store.SendableNow`/`SendCASState` (snapshots.go:1388-1440) looks
  like a ready-made gate but embeds /vh/send-only semantics — pending question/permission holds,
  latest-assistant-completed, TurnStopping, and `exists=false ⇒ not sendable` (an accidental
  absent=hold). Using it would silently widen the hold class beyond the operator contract.
  source=pkg/state/snapshots.go:1388-1440, confidence=high, type=fact
- **(finding)** Post-restart, the in-memory store is cold; queue lanes are rediscovered from
  durable queue.json (discoverSessions FS scan, queue_drain_loop.go:479-514) while the
  aggregator repopulates sessions via hydrate/reconcile (60s default cadence, live events prompt
  — memo E5). Status snapshots clear missing statuses to idle
  (SetActivityFromStatuses, reducers.go:290-395). So "absent from store" is the routine
  post-restart posture for a pending lane.
  source=queue_drain_loop.go:479-514 + reducers.go:290-395, confidence=high, type=fact
- **(finding)** Within one lane (per-session queue store) all items target the same session,
  hence the same tree — a lane-level gate is automatically FIFO-preserving (the oldest item
  holds iff the tree holds). Cross-lane ordering is already one-item-per-lane-per-tick.
  source=queue_drain_loop.go:338-371 (per-lane iteration), confidence=high, type=fact

## Vocabulary

- **BLOCK** — skip the lane this tick; selected item untouched (stays `pending`, or resume marker
  stays unconsumed). Re-evaluated next tick (250ms `drainLoopTick`, queue_drain_loop.go:90).
- **ALLOW** — proceed to claim/marker-consumption + POST under the existing custody machinery.
- **HOLD** — fail-closed disposition that does NOT self-heal on the plain observable-busy
  predicate; persists until some additional condition (here: only S3's witness). No override,
  no timer (banned).

## Candidates

All three share: corner 2 BLOCK (fixed by the task); corner 6 no-selection-change (gate applies
after `oldestDispatchable`, before claim/marker consumption — FIFO and resume-precedence
untouched); corner 7 BLOCK-until-idle for BOTH modes with the check firing BEFORE consuming the
`RequeuePending` marker (annex-2 §1 ordering), while `certifiedRecoveryPass` keeps running
every tick regardless of busy (classification ≠ dispatch). The candidates differ only on the
genuinely open corners: 1, 3, 4, 5.

### Candidate A — Visible-idle-only recheck, absent=allow ("pure observational gate")

Every dispatch decision re-reads canonical activity at decision time. A lane dispatches iff the
target session's **effective root** is observably not busy in the canonical store. A session/root
**absent** from the store is not observably busy → allow (W1 absorbs it).

| Corner | Disposition |
|---|---|
| 1 Busy→idle→busy flicker | **ALLOW-if-canonically-idle** — fresh read per tick per lane at claim time; NO debounce, NO cooldown, NO cross-tick memory. A dispatch landing in a transient canonical-idle gap is W1-class (waived), not a gate failure. |
| 2 Root idle + descendant busy/retry | **BLOCK** (fixed; root-resolved `subtreeBusyCount > 0`). |
| 3 Unknown/stale after restart/rehydrate | **ALLOW** — absent = no busy evidence = not observably busy. Hydration/readiness is not consulted at all (trivially honors "hydration ≠ fresh readiness"). |
| 4 First-message-persisted-before-Busy | **ALLOW** — no cross-item memory; item 2's own tick's canonical read decides. Fold-into-running-turn in the gap = W1. |
| 5 Missed/short/never-observed Busy after own dispatch | **NO GATE ACTION** for the in-flight item (existing stale-threshold → certified ladder → delivery watcher own it, queue_drain_loop.go:27-45); for the NEXT item: same as corner 4 → typically ALLOW. |
| 6 FIFO/selection when blocked | **No change** — lane holds its oldest item; other lanes proceed; resume-before-pending precedence kept. |
| 7 Certified resume/recovery while busy | **BLOCK** — gate wraps both modes before marker consumption; classifier authority untouched. |

Mechanism (one line): in `tick()` between `oldestDispatchable()` and the mode branch
(queue_drain_loop.go:368-381), call a narrow canonical accessor on `a.Store()`
(aggregator.go:357) — `TreeBusyForDispatch(sid) (busy, exists bool)` = RLock + `rootOfLocked`
(store.go:1367) + `subtreeBusyCount[root] > 0` (the single index GateFacts.SubtreeBusy derives
from, snapshots.go:942) — `busy ⇒ skip lane`; `!exists ⇒ proceed` under A.

### Candidate B — Visible-idle + hold-on-absent ("fail-closed on the restart window")

Identical to A wherever the store has an entry; differs ONLY on corner 3.

| Corner | Disposition (deltas from A) |
|---|---|
| 1 Flicker | same as A (ALLOW-if-canonically-idle; no debounce). |
| 3 Unknown/stale after restart | **HOLD** — lane holds until the target's root has a canonical entry (first post-restart observation via hydrate/reconcile/events). Self-heals in one observation when upstream is healthy; **indefinite** for orphaned FS-discovered queue sessions the aggregator never adopts (under A those converge to terminal-failed via the POST error receipt ladder instead). Note: B does NOT close the present-but-STALE window (hydration ≠ fresh readiness applies to present entries too) — it only closes absence. |
| 4, 5 | same as A (ALLOW / no gate action). |

Mechanism: same accessor; branch becomes `busy || !exists ⇒ skip lane`.

### Candidate C — Observed-episode per-tree serialization (O4-flavored positive evidence)

A's rule for a lane with no prior loop dispatch this "episode", PLUS a per-tree episode latch:
after the loop POSTs to a tree, further dispatches/resumes to that tree wait until a
busy→idle EPISODE is observed on that tree (busy seen at one tick, gone at a later tick).
No timer, no override.

| Corner | Disposition (deltas from A) |
|---|---|
| 1 Flicker | same as A for an un-armed lane; for an armed lane, a bare idle gap does NOT release (no intervening observed busy). |
| 3 Unknown/stale | same as A (ALLOW) — kept identical to isolate the comparison axis. |
| 4 Persist-before-Busy | **HOLD→episode** — directly closes the second-item fold gap whenever busy eventually arrives. |
| 5 Missed/short/never-observed Busy | **HOLD — potentially INDEFINITE**: a turn completing between ticks never arms the busy observation; the latch only discharges on an (uncorrelated) later busy→idle — the O4 flaw the memo names ("ordering ≠ terminal correlation; short turns route to backstop", memo line 41) with the backstop (timer) banned. |
| 7 Certified resume | BLOCK-until-idle AND **exempt from the episode latch** — otherwise a connect_failed requeue self-deadlocks (the POST never landed, busy never arrives, the latch never discharges). The exemption is itself new corner-surface. |

Mechanism: A's branch + a per-tree episode latch in `queueDrainLoop` state (armed on POST
receipt, discharged by per-tick GateFacts diff busy→idle at the root), resume lanes exempt.

## Rubric scoring (memo criteria; scale 1-5; C1×5 **gate**, C2×4, C3×3, C4×3, C5×2; max 85)

Scale verified against the memo's own arithmetic: Path A's printed cells (C1=3, C2=4, C3=5,
C4=4, C5=4) sum to its printed total 66 under exactly these weights. C1 anchors per the memo:
5 proof-grade / 3 behavior-grade (never dispatches into an observably busy tree; fails only
under evidence loss) / 1 dispatches into observably busy tree (**disqualified**).

| Criterion (weight) | A visible-idle/absent=allow | B visible-idle/absent=hold | C episode-serial |
|---|---|---|---|
| C1 promise integrity (×5) | **3** — blocks every observably-busy posture incl. the incident; never dispatches into an observably busy tree; residual mis-dispatches are evidence-loss/lag class (flicker gap, persist gap, cold restart) = the memo's waived corner class | **3** — same observable-busy blocking; additionally closes the absent window, but the present-but-stale window remains, so still behavior-grade | **3** — never dispatches observably-busy, but its discharge evidence (any busy→idle after our POST) is uncorrelated with the arming dispatch (the memo's own O4 note), so the extra integrity is illusory; where it "fails" it stalls rather than protects |
| C2 unattended liveness (×4) | **5** — no added stalls anywhere; orphans converge via the existing error-receipt ladder | **3** — new hold classes: every restart with pending lanes waits out the cold-store window (usually one hydrate beat; 60s-reconcile tail when events are quiet), and orphaned FS-discovered lanes hold INDEFINITELY with no override and no timer (the O2 shape at smaller scale) | **2** — missed/short busy ⇒ indefinite per-tree stall; "holds not rare" for fast-turn workloads (the memo's O2/C2=2 language) |
| C3 mobile override burden (×3) | **5** — no new holds ⇒ no new override temptation | **4** — no override exists; orphan-hold is a phone-visible stuck chip with no action | **2** — stuck chips with no phone action become routine for short turns (operators will demand the banned override) |
| C4 shippability now (×3) | **5** — smallest diff: one narrow accessor + one branch at the selection site; no new loop state | **4** — same + absence semantics to define and restart/orphan windows to test | **2** — per-tree latch state in the loop, episode observation via GateFacts diffing, resume-exemption to avoid self-deadlock: several new corners of its own |
| C5 forward migration (×2) | **4** — the observational predicate is exactly S3's eligibility FLOOR (S3 adds obligations + generation freshness on top); the one flip is absent=allow → unknown≠idle, a one-direction TIGHTENING at cutover (safe direction; pinned test inverts) | **5** — absent=hold already matches S3's "unknown ≠ idle / restore before readiness; failed/sticky hydration cannot unlock" posture; S3 only adds obligations | **3** — the episode latch is NOT what S3 keeps (obligations + witness replace it); latch state is loop-local and non-durable (inconsistent across restarts) and must be unwound |
| **Total** | **73** | **61** | **41** |

## Recommendation

**Candidate A — visible-idle-only recheck with absent=allow.** Total 73 vs B 61 vs C 41.

Decision procedure per the memo's own Application-2 instruction ("gate C1, weigh C2"): all three
candidates are C1 gate-clean (C1=3; none ever dispatches into an observably busy tree), so C2
decides — A's 5 vs B's 3 vs C's 2. This mirrors the memo's Path-A-vs-C head-to-head shape
("decided by C2/C3"). W1 is the operator's explicit acceptance of exactly A's residual class.

### Strongest honest objection (steelman of runner-up B)

A opens a real mis-dispatch window on **every daemon restart with a pending queue and a busy
tree**: the cold store has no activity evidence, the first ticks dispatch immediately, and the
item folds into a running turn — the incident class, recreated by a routine operator action
(restarts are most likely precisely during long subagent runs). B closes that window with a hold
that usually self-heals in one hydration beat, is the exact posture S3 will require anyway, and
migrates with zero behavior flip at the absent corner (A instead ships a behavior S3 must
visibly tighten — post-S3, queues that used to dispatch instantly after restart will start
holding, a user-visible regression at cutover). If restarts-with-pending-queues prove common in
practice, B's C2=3 is underestimated.

Why A still wins: B's protection is weaker than it looks — it closes only the ABSENT door while
the STALE door (present-but-lagging entry: hydration ≠ fresh readiness, statuses-race clearing,
the task's own corner-3 note) stays open for both candidates, so B buys a partial reduction of
one corner at the cost of a new stall class plus C4/C3 drag; and the W1 waiver plus the memo's
explicit "corner mis-dispatches rather than stalls — waived" posture pre-adjudicates this exact
trade in A's favor.

### Tie / noise call

**No tie; margin is outside scoring noise.** The 12-point A−B margin spans three criteria
(C2 +2 notches, C3 +1, C4 +1, against B's C5 +1) — overturning it requires a ≥2-notch
disagreement on C2 alone, i.e. holding that B's stalls are as rare as A's no-stalls, which the
indefinite orphan-hold and the routine restart window contradict. Scale granularity: one notch
on one criterion = 2-5 points; single-notch reviewer disagreement anywhere cannot close 12.

## S2 test obligations implied by A (pkg/web/queue_drain_loop_test.go style)

Style: real loop via `newDrainTestServer` + `fakeOCForDrain` (queue_drain_loop_test.go:101-129);
drive canonical state deterministically through the aggregator's own reducer path
(`srv.aggForExisting("").Store().Apply(...)` with session/status/message events — no test-only
backdoors); assert holds via `f.arrivals()==0` + item stays `QueuePending` across ≥5 ticks
(tick overridden to 30ms), releases via `waitForDrain`.

1. **TestQueueIdleGateSubtreeBusyHoldsUntilIdle — THE mandatory incident regression**: root R +
   child C in the store, child busy (assert setup via `Store().GateFacts()["R"].SubtreeBusy`);
   enqueue item on R → ≥1s of ticks with **zero upstream POSTs** (`f.arrivals()==0`, item
   `QueuePending`); then Apply child-idle → exactly ONE arrival, item `QueueDispatching`.
2. **TestQueueIdleGateRootSelfBusyHolds** — root itself busy, no descendants → hold; idle →
   dispatch (pins self-inclusive subtree count).
3. **TestQueueIdleGateRetryClassHolds** — child activity=retry → hold (pins retry ∈ busy-class,
   store.go:930).
4. **TestQueueIdleGateErrorAllows** — child activity=error → dispatch (pins the error carve-out
   as DELIBERATE contract behavior: error ≠ running; tree_finish_cascade_test.go:449-461).
5. **TestQueueIdleGateAbsentSessionDispatches** — corner 3 pin: enqueue on a session the store
   has never seen (`srv.queues.store(root, "ghost")`) → dispatch proceeds. Comment must say this
   pins W1/absent=allow deliberately and is the test S3 inverts (tightening).
6. **TestQueueIdleGateWholeTreeFromChildLane** — item on child C1 while sibling C2 busy → hold
   (pins ROOT-resolved semantics via `rootOfLocked`, not own-subtree-only); idle → dispatch.
7. **TestQueueIdleGateFlickerNoDebounce** — corner 1 pin: busy observed, then a statuses-driven
   clear to idle → next tick dispatches despite the recent busy (no cooldown).
8. **TestQueueIdleGateSecondItemAfterPersistenceBeforeBusy** — corner 4 pin: item 1 dispatches
   on an idle tree; drive the delivery watcher's sent resolution (Apply message.updated with
   item 1's correlation id — queue_delivery_watch.go:14-45) while the tree still shows idle;
   enqueue item 2 → dispatches (arrivals==2). Pins the W1 allow deliberately (S3 flip target).
9. **TestQueueIdleGateResumeWaitsForIdle** — corner 7: seed a requeue-shaped item
   (`dispatching` + `RequeuePending`, the direct-seeding pattern of
   queue_drain_loop_test.go:596-613) with the tree busy → zero arrivals AND marker still
   present; idle → resume fires with the SAME correlation id.
10. **TestQueueIdleGateDoesNotBlockCertifiedPass** — busy tree + stale `dispatching` item:
    certified classification still advances while the lane is gate-held (guards the placement:
    gate at selection, never around `certifiedRecoveryPass`).
11. Legacy/default-off: already pinned by `TestDrainLoopFlagOffStartsNoLoop`
    (queue_drain_loop_test.go:181-199) — the gate lives inside the loop, unreachable when off;
    cite, don't duplicate.
12. If the narrow accessor lands in pkg/state: gates_lean_test.go-style unit tests (root
    resolution incl. orphan roots; retry in / error out; the `(busy, exists)` contract).

Lane-6 Playwright extension (real-browser incident pair) is S3's obligation per the memo's
slice order #5 and annex-1 §S3 — not S2's.

## Contradictions

1. **W1 wording vs partial-lag corners** — W1 says "total evidence loss", but the flicker gap,
   persist-before-Busy, and cold-restart corners are partial lag, not total loss. Resolution:
   C1's own anchor defines the disqualifier as "dispatches into an observably busy tree"
   (memo line 31), which A never does; the partial-lag class is the memo's separately accepted
   "corner mis-dispatches rather than stalls — waived" (Path A C2 note). Recorded, not blocking.
2. **Annex-1's implied dispatching-item exclusion** — annex-1 §2 implied a dispatching-exclusion
   ending on persistence; annex-2 §5.1 corrects that no such exclusion exists in the selection
   path. A adds no cross-item memory — consistent with annex-2 (obligations are S3's).
3. **Ground-rule wording "via Store.GateFacts" vs root resolution** — the GateFacts map carries
   no parent links, so exact root resolution needs `rootOfLocked` (store.go:1367) beside the map
   read, or a narrow accessor over the same index. Annex-1 E4 pre-authorizes the narrow
   accessor. Both shapes read the identical `subtreeBusyCount` index — no semantic divergence.
4. **SendableNow looks reusable but is not** (see code facts) — rejected shortcut, not a memo
   contradiction.

None of these block the recommendation.

## Confidence + artifact disposition

- Code facts: high (all read at HEAD = f240a03).
- Rubric application: medium-high — weights/scale verified exactly by Path A's printed total
  (66); O-row cell values beyond the printed ones are inferred, but this pass scores fresh
  candidates against the criteria text, not the O-rows.
- Recommendation is this researcher's synthesis applying an operator-decided rubric; the rubric
  itself is settled operator policy (memo Status: DECIDED).
- Artifact type: option comparison (decision-shaped) but **transient by task instruction** —
  lives only in tmp/. If the coordinator wants it durable, the promotion target is
  `researches/decisions/` as an Application-2 annex to the release-rule memo; live-doc promotion
  targets once S2 lands: none (the gate's behavior contract belongs in the S2 closeout +
  eventually the queue design doc — not in researches/).
- Next: S2 execution session consumes this packet (`/resume-task` on `queue-idle-gate-send-now`);
  escalate to `debate` at the coordinator ONLY if the coordinator rejects the absent=allow
  disposition — that is the single judgment-laden call in this pass.

## Findings register (summary)

- **(finding)** No busy gate exists in the drain loop today; selection = resume-first then FIFO
  pending, per lane per tick. source=queue_drain_loop.go:338-471, confidence=high, type=fact
- **(finding)** `subtreeBusyCount` = busy/retry, self-inclusive, error-excluded — matches the
  operator's whole-tree idleness contract exactly. source=store.go:928-952, confidence=high, type=fact
- **(finding)** Absent-from-store is the routine post-restart posture for rediscovered lanes;
  missing activity renders idle canonically. source=snapshots.go:841-844 + queue_drain_loop.go:479-514, confidence=high, type=fact
- **(inference)** Lane-level gating is automatically FIFO-preserving (all lane items share one
  tree). source=store-per-session structure, confidence=high, type=inference
- **(inference)** A wins under the memo's own App-2 procedure (gate C1 → weigh C2); margin 12 is
  outside noise. source=rubric application above, confidence=medium-high, type=inference
- **(assumption)** B's indefinite orphan-hold is rare (FS-discovered sessions the aggregator
  never adopts). Unmeasured; if wrong, B's C2 rises toward 4 and the margin narrows to ~7-9 —
  still A. type=assumption
