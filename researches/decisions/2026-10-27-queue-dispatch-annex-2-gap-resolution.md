> Promoted-from: tmp/agent-runs/send-now-queue-gap-resolution-20261027/brief.md
> Original date: 2026-10-27
> Provenance: Gap resolution brief on G1–G3 evidence and compatibility, promoted as durable annex (supersedes annex 1 on conflicts).

# Send now / Queue: bounded G1–G3 resolution

## Decision frame and verdict

**Historical backend O3 is REVISED, still blocked—not implementation-ready.** Researcher refresh → debate → planner completed. Debate returned `need_researcher`, not a settled ranking. G2 is statically reachable; G3 has an explicit proposed compatibility contract. G1 has no sufficient, recoverable same-dispatch completion witness established by the inspected interfaces. No finalized S1 or implementation authorization follows.

Objective: close the three evidence gaps without revisiting U5, the operator contract, or custody/journal/certified-recovery authority. Success requires causal release, recovery after missed activity/restart, policy-preserving modern retries, and lossless mode/downgrade handling. Fixed: always-visible Queue + Send now; Enter = now; immutable dispatchPolicy now|queue, absent = queue; durable admission for both; ordinary legacy composer/drainer unchanged. Whole-tree eligibility retains root Busy/Retry or busy descendant exclusion. No framing_confidence signal was supplied; none was inferred or shifted. No manual step-back occurred. One bounded debate revision occurred.

Evidence tier: static current-tree inspection reported by researcher on 2026-10-27, plus pinned upstream source review. No builds, tests, runtime/deployed-version inspection, implementation, durable research, cards, or session-state writes. This consolidated transient brief is the only intended write.

## 1. G1 — causal release remains blocked

### Observations and producers

| Observation | Producer / consumer | Finding |
|---|---|---|
| Exact admitted user message persisted | `pkg/web/queue_delivery_watch.go:14–45,173–202` | **fact:** delivery evidence, not processing completion. Preserve prompt/chip clearance independently. |
| Cascade baselines converged; reconcile/fetch triggered | `web/src/sync/cascade.ts:303–320,411–470`; `web/src/components/ChatView.tsx:2385–2400` | **fact:** synchronization/admission reconciliation, not same-dispatch terminal evidence. |
| Whole-tree activity snapshot | `pkg/state/snapshots.go:840–844,908–944`; `pkg/state/store.go:345` | **fact:** canonical activity under one read lock; missing activity defaults idle. **inference:** not positive readiness on its own. |
| Assistant completion and activity grace | `pkg/state/reducers.go:990–1068`; `pkg/state/grace.go:54–64,93–112` | **fact:** multiple assistant steps can constitute one run; grace is inference. **inference:** a completed step or activity generation is not a terminal receipt for a dispatch. |
| Locally synthesized completed/error fields | `pkg/state/interrupted_sweep.go:125–156` | **fact:** local sweep can synthesize message completion. **inference:** do not treat all completed fields as upstream terminal proof; provenance matters. |
| Latest-assistant/gate envelope | `pkg/state/store.go:324–345,724–748` | **fact:** envelope does not extract assistant parentID; gate facts do not establish per-dispatch terminal correlation. |
| Hydration completed | `pkg/aggregator/hydration.go:50–64,88–115,144–162`; `pkg/aggregator/lifecycle.go:201–206,259–264` | **fact:** only opened sessions get message hydration, status-fetch failure is nonfatal, readiness flag is sticky. **inference:** insufficient restart/readiness barrier. |
| Status reconciliation / live events | `pkg/aggregator/reconciliation.go:57–75`; `pkg/aggregator/lifecycle.go:279–291`; `pkg/state/reducers.go:290–315,345–393` | **fact:** fetch/apply lacks a fetch-generation argument; events can race it; missing statuses clear activity. **inference:** fresh-request completion alone does not certify a causally ordered dispatch completion. |

**Upstream check — facts, with citation limitation:** the repository validation tag is v1.18.14 (`pkg/opencode/db.go:50`), not evidence of the installed version. Researcher inspected these pinned primary sources:

- [prompt.ts](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/session/prompt.ts), symbols `prompt`, `runLoop`, `handleSubtask`: persistence precedes loop execution; assistants have `parentID: lastUser.id`; tool-call assistant completion can precede more steps; loop termination checks finish, tool parts, and latest-user ordering.
- [effect/runner.ts](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/effect/runner.ts), `ensureRunning`, `finishRun`, and [session/run-state.ts](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/schema/src/session/run-state.ts), `runner`: concurrent callers can await the existing runner; finishing emits session idle.
- [session/status.ts](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/session/status.ts), `get/list/set`, and [session-status-event.ts](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/schema/src/session-status-event.ts), `Status/Idle`: session-level status, no durable per-dispatch terminal watermark in these inspected definitions; idle removes the status entry.

External readers did not provide reliable original line numbers. These claims therefore have pinned file+symbol references, **not fabricated file:line locators**. This is an explicit limitation against the requested all-file:line standard.

**Inference:** `parentID == dispatchedMsgID && time.completed` is insufficient; it can identify a completed step rather than completed work. Adding `finish != tool-calls` still omits upstream tool-part and latest-user conditions. Concurrent now messages can change lastUser/share a runner. Neither a persistence-followed-by-status request nor an unrelated session idle excludes the persistence-before-runner-start interval. No complete recoverable terminal contract for each accepted dispatch was established. This is not a proof that no extension could provide one.

### Concrete admissible release rule and missing branch

**Proposed contract — inference, not implemented:** release a scheduling obligation only when (a) the existing classifier certifies nondelivery for that attempt within its existing authority, or (b) authoritative terminal evidence explicitly covers that accepted dispatch, with ordering and recovery semantics. Branch (a) is grounded in `pkg/web/queue_recovery_classify.go:125–158,279–355,361–408` and `pkg/web/queue_custody.go:603–634`. **Branch (b) has no adequate established producer.** Session errors, ambiguity-budget exhaustion, sent persistence, grace, cascade convergence, or elapsed time do not supply it.

Consequently this is a safe partial rule, **not the requested complete release solution**. A sibling completion watcher can transport a valid witness if one becomes available; it cannot manufacture the witness from delivery watcher events.

### Reservation lifecycle — conditional design

All following items are **inference/proposed**, grounded in the current claim/attempt path (`pkg/web/queue_custody.go:450–504`; `pkg/web/queue_drain.go:131–202`), scheduler (`pkg/web/queue_drain_loop.go:338–403,444–470`), and compaction (`pkg/web/queue.go:745–760,884–913`).

1. **Acquire:** durably register an obligation for every daemon dispatch attempt—now and queue—bound to item/message/attempt, immutable policy, custody generation, and upstream incarnation. Couple reservation and exact-ID claim atomically or through an explicitly recoverable write-ahead protocol. Persist the attempt and perform the existing pre-POST fence. Admission alone is not an already-executed obligation.
2. **Check:** Queue requires current-generation whole-tree readiness plus no unresolved relevant obligations. Now bypasses activity/hold waiting, not custody or attempt safety, and creates another obligation. Use a set: one reservation slot cannot represent multiple now dispatches. Revalidate exact selected item and policy **before consuming a certified-resume marker**; do not change certification authority or postpone marker consumption until after POST.
3. **Release:** apply the partial rule above. Do not keep a delivered chip in dispatching to simulate the scheduling hold. Do not let dismissal, sent clearance, or item compaction erase outstanding obligations.
4. **Recover:** restore obligations before enabling Queue; invalidate readiness on reconnect/incarnation changes; obtain a successful current-generation activity baseline with stale-fetch rejection, then reconcile each obligation against nondelivery/terminal authority. Current sticky hydration is inadequate. The process generation starts at 1 per lifecycle (`pkg/oclife/oclife.go:144–180,224–241`); do not equate persisted counters from different daemon lifetimes. Existing restart certification is topology-restricted (`pkg/web/server_config.go:122–131`; `pkg/web/queue_custody.go:180–199`). A durable incarnation identity/protocol is additional design work.
5. **Stranding:** proposed finite reconciliation budget/deadline surfaces a durable visible `completion_evidence_unavailable` state while retaining the hold. No numeric deadline or implementation exists in the cited code for this reservation. This can bound **silent** stranding only after implemented; it cannot guarantee eventual release. Timer-based release is rejected. Eventual release after an accepted no-Busy dispatch remains unresolved.

### Race-corner changes

| Prior corner | Consolidated treatment |
|---|---|
| Busy→idle→busy flicker | Canonical activity remains necessary; neither flicker debounce nor generation alone releases obligations. |
| Persistence before Busy | Independent obligation remains after sent clearance. Correction: the current selection/claim path does not itself provide the assumed dispatching-item exclusion (`queue_drain_loop.go:338–403,444–470`; `queue.go:1342–1377`). |
| Missed/short/no Busy, accepted POST | Still blocked without terminal coverage; no timeout fallback. |
| Restart/status failure | Restore durable obligations before readiness; failed/sticky hydration cannot unlock Queue. |
| Queue A bypassed by now B | Retain oldest-eligible selection across pending/resume, atomic exact-ID claim; B creates its own obligation relevant to later Queue eligibility. |
| Certified resume | Retain policy check before marker consumption; never infer retry authority from idle or reservation release. |
| Unrelated actor idle→POST race | Boundary unchanged: observational eligibility, not atomic exclusion against unrelated upstream writers. |

## 2. G2 — modern Retry bypass confirmed statically

**Fact: reachable, not runtime-reproduced.**

1. Stale dispatch recovery can set unknown while retaining message ID without setting ambiguousDelivery: `pkg/web/queue.go:715–741,1010–1055`.
2. Ambiguity marker is added later at reconciliation-budget terminalization: `pkg/web/queue_msg_reconcile.go:375–448`.
3. Composer chooses AmbiguousChip only for marked unknowns; otherwise generic QueueChip: `web/src/components/chat/Composer.tsx:259–279`. Generic unknown exposes Retry: `web/src/components/QueueChip.tsx:123–132`.
4. ChatView projection guard applies to the drainer, not this retry handler: `web/src/components/ChatView.tsx:2322–2327,2359–2372,2679–2687`.
5. Generic retry checks unknown/message ID/dependency/latch, then calls dispatchQueuedItem and upstream POST: `web/src/components/chat/createSend.ts:1530–1567,613–674`.
6. Proxy does not perform queue custody arbitration; subsequent resolve can refuse only after POST: `pkg/web/opencode_proxy.go:40–55`; `pkg/web/queue_http.go:338–345`.

**Fix shape — inference:** modern/policy-owned Retry must not call upstream directly. Guard both rendering and execution, including capability changes during awaits. Admission-response retry reuses the same durable intent/identity/policy via admission; it is not authority to redispatch an existing server-held unknown. For that existing item, daemon reconciliation and certified recovery alone may authorize another attempt. Uncertified unknown offers Wait/Copy or an explicit replacement/new admission under the existing ambiguity contract, never automatic duplicate admission. Absence of an ambiguity marker is not a retry certificate (`queue_recovery_classify.go:125–158,279–355,361–408`). Retain ordinary legacy behavior only outside modern custody/policy-bearing state.

## 3. G3 — selected compatibility contract

**Facts:** schema 1 ignores unknown fields and can erase them on rewrite; inspected reader rejects a newer schema before loading/rewriting (`pkg/web/queue.go:114,529–614,625–643`). List can itself perform recovery/compaction and persist (`pkg/web/queue.go:1010–1055`). Newer-schema refusal is `409 queue_schema_newer`; corrupt file is `500 queue_file_corrupt` (`pkg/web/queue_http.go:80–107,142–150`). Frontend non-2xx fetch can become null, and claim specially handles custody refusal (`web/src/queue.ts:287–318,580–611`). Current capability is schema/daemon, not policy (`pkg/web/server_routes.go:38–51`); daemon-off disables custody arbitration (`pkg/web/queue_http.go:287–292`).

**Chosen contract — inference/proposal:**

| Situation | Rule |
|---|---|
| Ordinary schema-1 file, daemon off | Existing composer/drainer semantics unchanged; omission means queue. No gratuitous migration. |
| Policy-capable daemon opens schema 1 | Read compatibly. Atomically upgrade to schema 2 before first persisted policy/reservation semantics; cannot persist explicit now in schema 1. |
| Schema 2, fully capable enabled daemon | Validate policy-bearing items and retained receipts before accepting loaded state; preserve immutable policy and reservation evidence. |
| Schema 2, daemon off | **Refuse**, before List-side recovery/compaction or any admission/claim/resolve/mutation. Preserve bytes; expose a visible mode-required conflict. Optional separate nonmutating projection may explain held items. No legacy draining of any policy-bearing file. |
| Older inspected schema-1 reader opens schema 2 | Existing newer-schema refusal preserves bytes. Do not claim compatibility with every historical binary or already-loaded old writer. |
| Unsupported capability with explicit now in outbox | Retain durable payload and show support-required error; never drop policy or silently turn it into queue/direct legacy POST. |
| Downgrade requested | No automatic downgrade. Require separately authorized, lossless conversion accounting for receipts, attempts, policies, and outstanding obligations—not just an empty visible queue. No conversion design is authorized here. |

**Now-under-legacy disposition: refuse, never degrade.** Safe refusal for policy-bearing files is intentionally different from unchanged ordinary schema-1 legacy operation. This is the necessary exception to any blanket wording that all daemon-off histories remain unchanged.

Advertise `queueDispatchPolicyVersion: 1` only when the complete policy scheduler is supported **and enabled**. Missing/unsupported capability must not activate modern gestures or reinterpret existing durable now intent. Backend enforces support even if frontend capability is stale. Custody support alone does not imply policy support (`server_routes.go:38–51`; `queue_http.go:209–247,287–292`). Refusal must not appear as an authoritative empty queue through existing null/error handling.

Preserve old canonical identity bytes for normalized queue, distinguish now, validate retained receipt identity: current fingerprint omits policy (`pkg/web/queue.go:1109–1149`). This is a compatibility requirement still needing tests, not a proven property. Quiesce old writers and invalidate loaded caches before upgrade; load has an already-loaded fast path (`queue.go:529–614`), so disk schema rejection is not a live mixed-writer protocol.

## 4. O3 disposition and planner consolidation

**Revised, still blocked.** Retain polling as an eligibility transport, but reject the sufficiency of today's activity/delivery signals as causal completion authority. Revisions are: durable obligation set for both policies; independent retention; stronger readiness/incarnation contract; confirmed modern Retry closure; explicit schema-2 mode refusal.

Alternatives considered (not renamings of historical O3):

- **A1: durable dispatch-correlated terminal receipt.** Preferred evidence target, including shared-run coverage and pre-assistant terminal failure. Not established today.
- **A2: ordered runner-registration/drained watermark barrier.** Alternative if it proves deferred start cannot occur after release and supports restart recovery. Sequential HTTP requests or local event counters alone are insufficient.
- **A3: fail-closed visible blockage.** Safe fallback when evidence is missing, but not the promised liveness solution and not approval to ship a permanently blocked Queue.

**No finalized S1.** Conditional backend boundary only: `pkg/web/queue_drain_loop.go`, `queue_drain.go`, `queue_custody.go`, `queue.go`, `queue_http.go`, `server_routes.go`; preserve `queue_recovery_classify.go` authority and delivery watcher semantics. State/aggregator changes depend on the eventual witness/readiness contract: `pkg/state/store.go`, `reducers.go`, `snapshots.go`; `pkg/aggregator/lifecycle.go`, `hydration.go`, `reconciliation.go`; incarnation work, if needed, belongs at `pkg/oclife/oclife.go` and existing configuration/custody boundaries, not an invented aggregator path. New watcher/journal filenames are intentionally not finalized.

Future scoped test intents—not authored/run:

- No Queue POST while tree is busy, readiness unknown, or a relevant obligation unresolved; now bypasses only activity/hold waiting and still records an obligation.
- Persistence before Busy, multi-step assistant completion, cascade convergence, timeout, stale status, and locally synthesized completion cannot release accepted obligations.
- Missed complete Busy interval and restart recover through a genuine witness; if no seam can demonstrate this, G1 stays inconclusive.
- Multiple now sends retain distinct obligations; sent clearance/compaction/dismissal do not erase them.
- Exact-ID oldest-eligible claim across pending/resume; policy/readiness checked before consuming resume marker; fencing/journal/classifier authority unchanged.
- Modern unmarked unknown Retry never direct-POSTs; admission replay preserves identity and policy without authorizing duplicate delivery.
- Schema-2 daemon-off/newer-reader refusal preserves bytes before mutating List; legacy schema-1 path unchanged; queue fingerprint compatibility and now distinction; retained outbox now survives capability loss.

### Bounded next step, with stop rule

Debate requested a researcher refresh; planner proposed one more upstream trace. **Do not blindly repeat the already-completed trace.** The only justified refresh is an exact-line, version-scoped confirmation of a candidate terminal receipt or ordered barrier, using a scenario matrix: delayed runner start; missed complete Busy interval; multi-step tools; overlapping now prompts/changing lastUser; failure before assistant creation; reconnect; restart; evidence retention/incarnation. Each row must name witness, dispatch coverage, ordering, durability/recovery, or explicitly missing contract. Then re-run debate only if material new evidence exists.

If no candidate contract is available—as in the current packet—stop and route the upstream prerequisite to the operator. Recommend requiring an upstream/versioned terminal or ordered-barrier contract before activating Queue scheduling. The operator may authorize that work, pause the feature, or explicitly change the liveness contract to visible fail-closed blockage. No manual cancellation/acknowledgment may be represented as proof that an accepted dispatch completed. No automatic implementation or durable ticket follows.

Suggested next prompt, only if a concrete source/version candidate is supplied:

`/solution-brief Confirm the named upstream dispatch-terminal or ordered-registration/drain contract against the G1 scenario matrix in tmp/agent-runs/send-now-queue-gap-resolution-20261027/brief.md. Exact pinned-source locators; one bounded researcher refresh then debate only on new material evidence. Preserve U5/custody/policy. If absent, stop at operator disposition; no implementation or durable artifacts.`

## 5. Contradictions and corrections

1. Prior brief implies a dispatching exclusion ending on persistence; inspected pending selection/claim does not itself enforce that exclusion (`queue_drain_loop.go:338–403,444–470`; `queue.go:1342–1377`). The independent reservation need is stronger, not weaker.
2. Projection's no-POST expectation is contradicted by reachable generic Retry (G2 citations above).
3. Assistant completed/grace cannot be promoted from heuristic to dispatch-terminal authority (`reducers.go:990–1068`; `grace.go:54–64,93–112`; `interrupted_sweep.go:125–156`).
4. Historical cascade wording is superseded by current precise baseline/ringGap behavior (`cascade.ts:303–320,411–470`); convergence remains nonterminal.
5. Historical v1.17.18 source packet is not today's validation tag (`researches/sources/opencode-v1.17.18-messageid-exact-lookup.md:3–14`; `pkg/opencode/db.go:50`). Neither tag proves deployed capability.
6. Safe refusal of policy-bearing daemon-off files is not blanket unchanged legacy behavior (G3 citations above).
7. Planner returned incorrect `pkg/aggregator/queue*`, recovery and oclife paths; consolidated paths above correct them. Planner also proposed marker retention after POST failure, overly broad nondelivery examples, and manual cancellation as a terminal substitute. Those are **rejected**: gate before marker consumption, retain existing classifier authority, and never infer terminal truth from operator dismissal. Its concern that the inspected older reader silently drops schema 2 is also corrected: unknown schema-1 fields can disappear; newer schema is refused. G2/G3 are not reopened by those planner questions.

## 6. Confidence and explicit unknowns

High confidence in reported static local paths and modern Retry reachability; medium confidence in the proposed compatibility/obligation design. Insufficient evidence for a complete causal release/restart protocol. No runtime verification or actual deployment version was obtained. No numeric stranding bound, durable terminal producer, or implemented policy readiness barrier was established. External file:line locators remain unavailable; pinned symbol citations are the explicit exception. The October 13 delivery receipt does not close these general completion/recovery gaps (`docs/checkpoints/2026-10-13-queue-delivery-caveat-closure.md:48–84`).

The outcome is an honest blocked design with G2 and G3 resolved at static-audit/design level—not a claim that the feature is implemented, S1 settled, or behavior proven.
