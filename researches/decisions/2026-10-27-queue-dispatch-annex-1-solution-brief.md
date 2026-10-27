> Promoted-from: tmp/agent-runs/send-now-queue-solution-20261027/brief.md
> Original date: 2026-10-27
> Provenance: Solution brief (read-only researcher → debate → planner pass) on Send now / Queue design, promoted as durable annex.
> Superseded on conflicts by annex-2 (2026-10-27-queue-dispatch-annex-2-gap-resolution.md); see the dispatching-item-exclusion correction.

# Send now / Queue solution brief

## Scope and decision

Read-only researcher → debate → planner pass. No builds, tests, source changes, durable state, or implementation. This transient brief is the sole write, required by the solution-brief agent's higher-priority output contract notwithstanding the user's request for no writes. All findings are static inspection, not runtime verification.

Objective: default Send now delivers without an activity wait; explicit Queue waits for the entire session tree to be idle. Both retain durable outbox/server admission, persisted per-item intent, custody fencing, and attempt journaling. Legacy mode is unchanged. Success requires visible mobile actions, policy-preserving retries, subtree gating, now bypass of blocked queue items, and honest handling of scheduling races.

**Q1: recommend U5, an always-visible action pair, not prior candidate (a). Q2: conditional lean toward polling plus causal scheduling reservation/reconciliation, but need_researcher before implementation. Q3: recommend dispatchPolicy: now|queue, absent=queue.**

No framing_confidence signal was provided. No manual step-back occurred. One bounded debate revision retained U5 and exposed the scheduling evidence gap. A phased follow-up is necessary because that gap is material.

## 1. UX comparison

Contract compliance is an elimination gate. Criteria rank: (1) prevent silent unintended delay, respecting the supplied mistake asymmetry; (2) mobile visible full-size targets/no hidden gestures; (3) discoverability/stable meaning; (4) accessibility; (5) existing send-state/chip consistency; (6) implementation cost/risk. Ranking and usability predictions are inference/preference, not measured findings. Mobile ergonomics and discoverability remain heavily weighted.

| Rank / candidate | Mobile | Discovery | Mistake asymmetry | Existing UX | Accessibility | Cost/risk and disposition |
|---|---|---|---|---|---|---|
| 1 U5: always-visible Queue + Send now | Dedicated wrapping action row; costs width/height | Both choices always visible | Stable primary now; adjacent-button mistap risk remains | Retains admission/custody/transcript ownership | Native labeled buttons, stable focus | Moderate; winner subject to narrow-screen validation |
| 2 U1 / (a): idle Send; busy Send + Queue | Compact idle | Queue hidden until projected busy | Stale idle hides intentional Queue; state-dependent rendering | Close to current busy controls | Conditional controls may complicate focus/layout | Moderate; reject in favor of stable availability |
| 3 U2 / (b): busy send opens sheet | Large choices; extra tap | Clear after opening | Adds a decision before default send | Adds modal workflow | Focus trap and return required | Higher; does not provide immediate default on initial tap |
| 4 U4 / (d): persistent mode toggle | Compact | Visible mode, but must inspect it | Retained Queue silently delays later sends | Imports settings state into each gesture | Can be accessible but mode must be announced | Higher mode risk; reject sticky mode in v1 |
| Eliminated U3 / (c): always queue, chip promote | One initial action, second action later | Immediate path displaced to chip | Missed promotion silently delays | Adds custody mutation action | Additional action/navigation | Violates default-send-now contract |
| Eliminated hidden long-press/modifier-only | Hidden gesture or desktop dependence | Poor | Users cannot reliably express intended policy | Adds alternate invocation | Cannot be sole accessible route | May supplement, never replace visible Queue |
| Eliminated send then undo-to-queue | Simple initial send | Undo visible only briefly | Cannot reverse already-absorbed prompt | Misleading cancellation promise | Time pressure | No support for reliable undo; reject |

The explicit attack on (a): its largest weakness is not proven target movement, which can be mitigated, but making an intentional Queue action depend on a possibly stale busy projection. Always-visible Queue remains available even when a new turn has not yet reported Busy [E4–E6,E8]. U5's strongest objection is real: extra space and neighboring-action mistakes. Prefer a full action row with generous spacing/wrapping; do not shrink the controls into small split-button targets. A 44×44 CSS-pixel target is a proposed local design target, not a measured result or asserted standards requirement.

### Exact modern composer states

- Idle: Queue secondary and Send now primary, fixed relative positions. Queue remains a queue-policy item even if it is currently eligible to dispatch.
- Root Busy/Retry or any descendant Busy/Retry: same pair; separate Stop at the working indicator, never replacing Send now.
- Activity unknown: same pair. Now skips activity waiting; Queue is admitted durably and waits for confirmed readiness. Any displayed readiness reason must be backed by server scheduling state.
- Empty/invalid payload or admission single-flight: apply existing payload validity/duplicate-submit rules to both. Busy alone never disables Send now. Support attachment-only payloads for both actions.
- Enter: Send now, retaining existing multiline/IME guards. Shift+Enter: newline. Queue accessible through ordinary touch and Tab/Enter; no hidden gesture dependency.
- Capture policy before asynchronous preparation. Later activity changes never reinterpret the click.
- Legacy: existing controls, preferences, and FE drainer unchanged. Gate new UI on positive policy-capable daemon support.

QueueChip should distinguish a waiting queue item from a now item awaiting dispatch, while preserving existing Sending state. SendStatus still owns admission uncertainty; QueueChip owns custody; transcript owns confirmed messages [E15,E17]. Exact copy is not finalized.

## 2. Daemon mechanism and unresolved evidence

| Mechanism | Decision |
|---|---|
| O1: poll-time gate only | Necessary baseline, insufficient alone for persistence-before-Busy double-dispatch |
| O2: admission-held state promoted on idle edge | Extra lifecycle state; missed/short edges and restart still need reconciliation; do not choose alone |
| O3: poll gate plus causal reservation and reconciliation | Conditional leader; keep queue items pending, use independent scheduler reservation rather than delay sent clearance; release/restart contract requires research |

**In-process feasibility is confirmed by code inspection:** complete Store.GateFacts uses the canonical subtree index under lock, including self Busy/Retry [E4]. Read it once per project tick, or expose a narrow canonical accessor if justified. Do not call GET /vh/diag/busy, the O(n) diagnostic builder, or fleet-selected facets that omit sessions. Missing status currently appears idle, so positive readiness needs separate treatment [E4–E6].

| Corner | Proposed treatment / unresolved boundary | Landing points |
|---|---|---|
| Root idle/subtree busy | Queue checks whole tree; now skips activity gate | pkg/web/queue_drain_loop.go; pkg/state/snapshots.go if narrow accessor needed |
| Busy→idle→busy flicker | Recheck current canonical activity; evaluate causal activity generations. Quiet interval may damp noise but neither debounce nor dispatched-at cooldown proves completion | queue_drain_loop.go; conditional state/store.go,reducers.go,snapshots.go |
| Message persisted before Busy | Existing dispatching guard ends on persistence [E3]. Reserve before POST and keep scheduling hold independent of sent; do not delay chip clearance | queue_drain_loop.go,queue_drain.go,queue.go; preserve queue_delivery_watch.go semantics |
| Release after no-Busy, short Busy, rejected or ambiguous POST | Need dispatch-correlated terminal/completion evidence and missed-edge recovery. No timer-only release, no invention of an upstream guarantee | S0 researcher blocker; aggregator/reconciliation.go and upstream event contract |
| Restart/rehydrate/unknown | Queue fails closed pending current-generation readiness and unresolved-dispatch reconciliation. Sticky hydration is inadequate. Now bypasses activity readiness, not admission/custody/journal safety | aggregator/aggregator.go,lifecycle.go,hydration.go,reconciliation.go; scheduling persistence design unresolved |
| FIFO and now bypass | Select oldest eligible by existing Order, across eligible pending/resume items; blocked queue A may be bypassed by now B. Atomically claim exact selected ID, not a second unfiltered oldest scan | queue_drain_loop.go,queue_custody.go,queue.go |
| Certified recovery/same msgid | Continue classification; apply retained policy before POST and before consuming resume marker. Do not fabricate retry certification from busy/idle or release reservations merely on uncertified ambiguity | queue_recovery_classify.go,queue_drain.go,queue_custody.go |
| Other clients race idle→POST | Cannot promise atomicity against unrelated upstream actors. State the observable eligibility guarantee honestly | API/design contract |
| Legacy | No browser-drainer changes and no direct browser-POST escape for modern now | queueDispatchMode.ts; queueDrain.ts regression only |

Open material fact: what observation proves completion or terminal failure of the same accepted dispatch, is ordered/recoverable after missed Busy transitions, and survives restart? An endlessly held queue is not a satisfactory liveness solution; a finite timeout is not proof of idle safety. Research must also determine which prior now/queue dispatches contribute to a subsequent queue hold. Until resolved, O3 is a direction, not an implementable settled design. The next cycle is researcher → debate, not build.

## 3. Schema and admission

Proposed top-level immutable field: dispatchPolicy: "now" | "queue". Omission means queue for old queue records, IDB outbox rows, and wire callers. New default gestures explicitly write now. Keep policy outside sendConfig and upstream prompt bodies.

1. createSend.ts captures policy before awaits; Composer and ChatView pass explicit action. Same-item retry preserves original policy. New replacement/send gesture defaults now. Audit createAmbiguousReplacement.ts rather than reclassifying an uncertain existing attempt.
2. Thread through PreparedSendPayload in lib/sendActionStatus.ts, OutboxPayload in lib/outbox/store.ts, all enumerated copies/replay in lib/outbox/index.ts, and queue.ts types/enqueue [E11].
3. Normalize policy in same-text supersede/twin/re-admission comparisons; now and queue must not collapse solely because text matches [E14].
4. Extend queue_http.go request, queue.go item/admission validation and serialization. Missing accepted as queue; explicit unsupported, null, empty, or wrong-type values rejected. Proposed 400 code queue_invalid_dispatch_policy. Invalid disk policy must fail closed and preserve bytes.
5. Include policy in admission identity [E12]. Preserve old canonical hash bytes for queue by omitting its normalized policy member in the fingerprint encoding; include now. This needs fixture proof, not merely a claim. Never re-admit identical receipt identity with conflicting intent.
6. Recommend schema version 2 for policy-bearing storage. Current schema 1 ignores unknown fields and can drop them on rewrite; it does NOT reject unknown fields. Old readers reject a newer schema version [E13]. Avoid gratuitous migration of legacy-only files. Explicitly settle mode-flip/downgrade handling before rollout; safe refusal must not be described as unchanged legacy behavior.
7. Proposed daemon-only capability queueDispatchPolicyVersion: 1 in server_routes.go. Existing daemonDispatchCapable indicates custody, not policy support [E10]. Unknown capability must not silently convert an explicit now intent into legacy queue behavior.

## 4. Contradictions and confidence

- Current busy Queue/Stop replacement, queueMode rejection, and attachment-only Queue restriction conflict with the desired modern UI, not with the reported ground truth [E9]. Isolate modern changes; do not change legacy settings semantics.
- Existing FIFO narrative is stronger than resume-first implementation; policy-aware ordering must explicitly cover resumptions [E1].
- User-message persistence proves delivery, not turn completion [E3]. Sticky hydration does not prove current activity readiness [E5]. These invalidate tempting implementation shortcuts.
- Generic retry directly calls dispatchQueuedItem; unknown QueueChip may expose Retry. Modern reachability remains unverified, not a confirmed additional bug: createSend.ts:1530–1567; QueueChip.tsx:123–132.
- Researcher identified historical browser-only/parked descriptions superseded by current outbox/certified-recovery code. Do not treat those historical descriptions as current implementation constraints.
- Planner output contained unsupported path rewrites and incorrectly said schema 1 rejects unknown fields. This consolidated brief corrects both against E11/E13 and drops the unsolicited durable research-memo edit. No such edits were made.
- No contradiction found with the operator's verified incident, upstream absorption assumption, or mandatory custody/journal constraints.

Confidence: high in inspected code boundaries; medium-high in U5 contract fit, medium in unmeasured ergonomics; medium in O3 direction, low in release/restart implementation readiness. No runtime verification occurred.

## 5. Ordered execution brief (conditional, not authorization)

### S0 — research leftovers, then re-debate

Read pkg/web/queue_delivery_watch.go,queue_drain_loop.go,queue_drain.go,queue_recovery_classify.go; pkg/aggregator/lifecycle.go,hydration.go,reconciliation.go; pkg/state/reducers.go,snapshots.go. Establish dispatch-correlated completion/rejection/restart/readiness facts from current upstream sources if repo evidence is insufficient. Audit modern retries in web/src/components/chat/createSend.ts, web/src/components/QueueChip.tsx, web/src/components/ChatView.tsx. Resolve mode-flip/downgrade semantics. Return evidence packet, then debate; do not create durable research or implement while Q2 remains need_researcher.

### S1 — backend gate, after S0 settles

Exact principal files: pkg/web/queue_drain_loop.go,queue_drain.go,queue_custody.go,queue.go. Conditional only: pkg/state/store.go,reducers.go,snapshots.go; pkg/aggregator/aggregator.go,lifecycle.go,hydration.go,reconciliation.go; pkg/web/queue_lifecycle.go,posthydrate_lifecycle.go,server_aggregators.go if subscription/reconciliation wiring requires them.

Minimal internal policy type/default and persisted scheduling prerequisites must accompany S1; full public admission/UI follows S2. Do not enable a partial feature. Tests accompany this slice: pkg/web/queue_drain_loop_test.go,queue_drain_test.go,queue_recovery_classify_test.go,queue_delivery_watch_test.go,queue_subscriber_lifecycle_test.go; pkg/state/gates_lean_test.go. Run commands 1–2 below.

### S2 — schema, admission, durable FE intent, UI

Files: pkg/web/queue.go,queue_http.go,server_routes.go; web/src/queue.ts; web/src/lib/queueDispatchMode.ts,sendActionStatus.ts,outbox/store.ts,outbox/index.ts; web/src/components/ChatView.tsx,QueueChip.tsx,SettingsDialog.tsx; web/src/components/chat/Composer.tsx,createSend.ts,createAmbiguousReplacement.ts. Existing Composer.css was reported; inspect docs/ai/web-css-architecture.md before choosing minimal styling or a proposed co-located Composer.module.css. No broad CSS migration or new sticky settings.

Schema tests: pkg/web/queue_admission_test.go,queue_schema_http_test.go,queue_compact_test.go, and queue reconcile tests localized before edits. FE: web/tests/unit/createSendAttempts.test.ts,SendOutbox.test.tsx,outbox.test.ts,queue.test.ts,queueDispatchMode.test.ts,QueueChip.test.tsx,ComposerRetryWiring.test.tsx; proposed new ComposerDispatchPolicy.test.tsx. Test old receipts, omitted/explicit queue equivalence, invalid values, policy-sensitive duplicates, IDB replay/retry, attachment-only, Enter/focus, unsupported capabilities and legacy. Run commands 1,3–4.

### S3 — race/interaction proof and closeout

Extend pkg/fixtures/opencode.go and web/tests/e2e/queue-delivery-custody.spec.ts. Keep web/playwright.queue-delivery.config.ts isolated; a new spec requires updating exact testMatch. Add post-persistence/pre-Busy control: existing pre-persistence hold does not test the relevant gap [E16].

Mandatory regression pair: (1) root idle + descendant busy: queue item durably pending, zero upstream prompt arrivals; after confirmed idle, exactly one eligible dispatch; (2) same tree state: now item arrives upstream while descendant remains busy. Also cover Retry/deep descendants, blocked queue A/now B, two queue items with first persistence before Busy, flicker, failed status hydrate, restart/missed edges, certified same-msgid resume and delayed exact persistence, stale fencing, and flag-off legacy behavior.

Commands, all proposed and not run:

```bash
# 1. Lane 1: web backend package
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./pkg/web/'
# 2. Lane 1: state/aggregator, when touched
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./pkg/state/ ./pkg/aggregator/'
# 3. Lane 5: scoped web unit tests (new test name applies after authoring)
vh-agent-harness exec npm --prefix web run test:unit -- createSendAttempts SendOutbox outbox queue QueueChip ComposerRetryWiring ComposerDispatchPolicy
# 4. Lane 5: types
vh-agent-harness exec npm --prefix web run typecheck
# 5. Lane 6: dedicated daemon custody e2e
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && npm --prefix web run test:e2e -- --config=playwright.queue-delivery.config.ts --project=chromium --workers=1 --retries=0'
# 6. Lane 6: headed interaction verification
vh-agent-harness exec make test-queue-delivery-headed-docker
```

Runners are sourced from web/package.json:8–18, Makefile:140–150, and AGENTS.md's ten-lane localization. Other lanes are not automatically required for this scoped change. Browser execution must include actual Send now/Queue clicks and keyboard input, visible outcome, assessed revision, and retained receipt; direct API tests alone do not prove interaction reachability. Targeted tests must not be called full verification. If unresolved causality cannot be demonstrated, closeout is inconclusive, not proven. All test authoring/execution is future work.

## Evidence register

All entries below are fact, from researcher static current-tree inspection on 2026-10-27; recommendations above are inference/preference unless marked otherwise. No test results are asserted.

- E1: pkg/web/queue_drain_loop.go:83–90,338–403,451–470 — tick, recovery/selection/claim ordering.
- E2: pkg/web/queue_custody.go:450–488; pkg/web/queue.go:1342–1374; pkg/web/queue_drain.go:182–202 — mutex claim, fence/journal before POST.
- E3: pkg/web/queue_delivery_watch.go:14–45,173–202 — exact persistence resolves sent, not processing completion.
- E4: pkg/state/store.go:345; pkg/state/snapshots.go:840–844,908–979; pkg/state/busy_diag.go:35–39 — canonical subtree facts, absent-status caveat, diagnostic cost.
- E5: pkg/aggregator/lifecycle.go:201–206,259–264; pkg/aggregator/hydration.go:88–115,144–162 — sticky hydration/nonfatal status fetch.
- E6: pkg/aggregator/reconciliation.go:40–75; pkg/state/reducers.go:305–315,345–378 — reconciliation interval and status application race.
- E7: pkg/web/queue_recovery_classify.go:125–158; pkg/web/queue_custody.go:603–634; pkg/web/queue_drain.go:139–174 — certification, same msgid and resume consumption.
- E8: web/src/sync/selectors.ts:131–157; web/src/statusEmitter.ts:169–185 — tree working and separate unknown.
- E9: web/src/components/chat/Composer.tsx:158–165,509–542; web/src/components/chat/createSend.ts:894–905; web/src/components/SettingsDialog.tsx:462–473 — current UI/preference restrictions.
- E10: web/src/lib/queueDispatchMode.ts:24–53; web/src/queueDrain.ts:104–111; pkg/web/server_routes.go:38–51 — projection/legacy boundary and capability.
- E11: web/src/components/chat/createSend.ts:482–550,568–573,1462–1498; web/src/lib/sendActionStatus.ts:121–133; web/src/lib/outbox/store.ts:38–42; web/src/lib/outbox/index.ts:749–765,904–912; web/src/components/chat/createAmbiguousReplacement.ts:189–216 — payload-copy surface.
- E12: pkg/web/queue.go:1109–1128,1140–1149,1204–1251; pkg/web/queue_http.go:209–247 — admission fingerprints/receipts/request.
- E13: pkg/web/queue.go:114,529–583,625–643 — schema 1 unknown-field loss versus newer-version refusal.
- E14: web/src/lib/outbox/index.ts:500–550,779–800,843–885 — text-only reconciliation/supersede matching.
- E15: web/src/components/QueueChip.tsx:90–106 — pending/dispatching rendering.
- E16: web/playwright.queue-delivery.config.ts:5–29,87–115; web/tests/e2e/queue-delivery-custody.spec.ts:15–32 — isolated lane and existing hold limitation.
- E17: researches/decisions/2026-09-25-send-state-ux-design-and-defers.md:16–32,60–68 — surface ownership.
- E18: docs/checkpoints/2026-10-13-queue-delivery-caveat-closure.md:48–84 — historical clearance verification scope.
- E19: researches/decisions/2026-10-10-send-convergence-cascade-and-connstatus.md:59–83,211–212 — connectivity not delivery authority.

Next recommended command/prompt: `/solution-brief Resolve only the remaining causal queue-hold release/restart/readiness evidence and modern retry reachability gaps from this brief; keep U5 and the operator contract fixed. Researcher refresh first, then debate; no implementation or durable research artifacts.`
