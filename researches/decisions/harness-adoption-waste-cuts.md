# Harness-adoption waste cuts

> NOTE: Promoted from tmp/agent-runs/sb-harness-waste_2026-08-15/brief.md to researches/decisions/harness-adoption-waste-cuts.md
> Date: 2026-08-16

Question: **How should we restructure the harness's review pipeline, session lifecycle, and specialist roster to cut its two dominant waste sources without weakening the safety gates?**

## Context

### Objective

Reduce the two dominant waste sources:

- the flat four-leaf commit-review panel's token and wall-clock cost;
- unbounded coordinator hub sessions and their context/cache churn.

### Constraints

- Root `AGENTS.md` and `.opencode/` are generated. Changes must originate in sanctioned `.vh-agent-harness/` overlays, harness templates/upstream source, or a newly established extension/ownership seam, followed by `vh-agent-harness update`.
- Current overlays can add units but cannot shadow core built-ins. Core reviewer/config/session-command changes therefore require an explicit extension seam, ownership promotion, or upstream harness change—not duplicate overlay definitions.
- `exec`, `exec-ro`, `exec-sandbox`, and `shell` must remain distinct.
- The committer-exclusive git gate and model-output-is-candidate invariant are non-negotiable.
- No candidate reviewer may gain landing authority until block-recall non-inferiority is measured against the incumbent panel.
- Slices must be independently landable; Slice 1 must fit the weekend of 2026-08-16/17.
- Harness/config slices use harness verification seams. The eight application test lanes apply only if application code is touched.

### Success criteria

- Materially reduce the current ~319k I/O tokens per review and median ~19-minute review-and-gate flow.
- Protect the incumbent population's 10.1% blocked-review value through measured, per-review overlap rather than inferred leaf yield.
- Prevent mega-hub coordinator accumulation by making concrete work task/slice-bound.
- Route repetitive procedures to skills and existing specialists unless a distinct durable process/authority boundary is demonstrated.
- Preserve all git, gate, permission, and candidate-output safety invariants.

### Open question resolved

The safe restructuring is not an immediate panel trim. It is a lifecycle-first rollout followed by an authority-neutral shadow measurement program, then narrowly evidence-gated review routing.

### Decision

Adopt a staged **O4 → O1 → O2** sequence:

1. **Land lifecycle and skill-first roster improvements first (O4).** Make coordinator sessions task/slice-bound, with turn/I/O limits only as backstops; preserve the receiver and premise-tuple semantics of handoffs; route bookkeeping to `docs-steward`; add reusable build skills for isolated review-blocker fixes and repeated e2e surgery. Do not alter review authority in this slice.
2. **Build a fully overlapped, non-authoritative review shadow (O1).** Evaluate a B-first candidate with a conservative risk-triggered complementary reviewer while the incumbent A/B/C/D panel remains the sole source of gate disposition.
3. **Evaluate semantic-stakes routing in shadow (O2).** Use deterministic protected-surface and transition-risk signals, not file/line count, with unknown/high-risk changes falling back to the incumbent panel. Promote only classes that satisfy predeclared non-inferiority criteria.
4. **Reject B-only plus sampled full-panel audits (O3) as the primary safety-preserving topology.** Sampling detects drift but permits unaudited false approvals to land; the current evidence cannot establish B-only recall.

This preserves the healthy boundaries: coordinator read-only discipline, committer-exclusive git authority, model output as candidate rather than transition authority, and distinct exec-family verbs.

## Findings

### High-confidence facts

- The audit is full-population: 10,359 sessions, 73,522 bash calls, and all 1,389 review verdicts.
- Review consumes ~319k I/O tokens per run and ~3.2M per blocking outcome; outcomes are 88.1% approve, 10.1% block, and 1.4% split; review+gate is median ~19 minutes and p90 ~52 minutes.
- The active rendered config has one flat parallel A/B/C/D tier. The later premium tier is disabled, so the documented fail-fast cross-tier cascade cannot execute.
- B produces 61% of observed blocks at 23% of leaf spend. A blocks 1.1% and has p90 latency of 818 seconds. The audit does not contain the per-review overlap matrix needed to calculate unique recall for B, B+X, or any routed subset.
- The rendered callable-graph description contradicts the active flat configuration and must not be treated as ground truth.
- Coordinator burn is concentrated in mega-hubs: the top three sessions account for 31%; the largest reached 316 turns, 275 children, 513k peak context, and 59 compressions.
- `/session-start` creates the task contract, memory, resolved context, and kickoff checkpoint. `/handoff-save` overlaps checkpoint structure but uniquely carries receiver-targeted context and load-bearing premise tuples.
- Repetitive work supports rerouting 11% bookkeeping to `docs-steward`, and skill-first treatment for the 8% isolated review-blocker fixes and 17% repeated e2e surgery.
- `commit-message` is not removable solely from low usage: current committer/record-lifecycle contracts assign it Task-Card trailer semantics.
- The 120-session retry storm and shell-hygiene denials are real opportunities but are separate change surfaces from review topology and coordinator lifecycle.

## Options

- **O1 — measured two-stage cascade:** B-first candidate, immediate conservative escalation signals, and a risk-triggered complement, fully shadowed against the incumbent panel.
- **O2 — semantic-stakes routed panel:** deterministic protected-surface/transition classification with conservative unknown fallback.
- **O3 — B-only plus sampled/risk audits:** largest immediate savings but unacceptable unmeasured per-commit recall risk.
- **O4 — lifecycle-first/no authority change:** task-bound coordinator sessions, handoff-compatible checkpoints, existing-specialist routing, and build skills.

### Debate recommendation

**Recommendation: recommend O4 → O1 → O2; reject O3. Confidence: medium.**

#### Why O4 leads now

- It attacks one dominant waste source immediately without changing review authority.
- Task-boundary rotation is better grounded than a hard 80-turn/~2M-I/O rule; thresholds should only catch sessions that fail to rotate naturally.
- Folding handoff ergonomics into checkpointing is reasonable only if receiver identity, next step, and premise 4-tuples remain explicit. Low command usage is not evidence that the semantics are unnecessary.
- Existing evidence supports `docs-steward` routing and skills for repeated procedures, not an immediate new `web-e2e-surgeon` authority surface.

#### Why O1 is the eventual leader

- B is the strongest efficiency anchor in the audit.
- A is a plausible candidate for removal from the common critical path because of cost, tail latency, and low block production.
- However, B's 61% block production is not block recall. C/D complement selection is also unsupported by current evidence.
- Therefore the candidate must remain observational while every eligible review also receives the incumbent result.

#### Why O2 remains conditional

- Semantic stakes are safer than file/line size as a routing basis.
- Classification introduces its own false-lightweight risk; unknown, mixed, protected, or high-risk changes must conservatively fall back.
- It should first produce shadow metadata and a confusion/miss ledger, not gate decisions.

#### Why O3 loses

- Sampled full-panel audits do not protect each un-audited commit.
- The aggregate audit cannot establish B-only unique recall.
- Using O3 authoritatively would weaken the existing per-commit safety posture.

#### Seed adjudication

- **Survives conditionally:** fewer default reviewer seats and a real escalation path—but only after shadow non-inferiority evidence.
- **Loses:** size-led lightweight routing. A small auth, permission, schema, concurrency, or gate change can be high stakes.
- **Survives separately:** PATH and shell-guard hygiene work.
- **Modified:** rotate primarily at task/slice boundaries; fixed turn/I/O thresholds are backstops.
- **Partly survives:** checkpoint can absorb handoff ergonomics, but not erase handoff semantics.
- **Loses for now:** a new e2e specialist; use a skill first.
- **Survives:** bookkeeping to `docs-steward`; review-blocker-fix as a build skill.
- **Loses now:** retiring `commit-message` without migrating and verifying trailer ownership.
- **Deferred:** retiring `explore`; low usage is insufficient and it is immaterial to the dominant waste decision.
- **Separate:** dispatch retry dedupe/backoff and hygiene normalization.

### Block-recall protection protocol

During shadow rollout, the full A/B/C/D panel remains the sole review authority. For each eligible review record:

- incumbent and candidate verdict;
- candidate approval where incumbent blocks or splits;
- candidate-only and incumbent-only material findings;
- finding class and semantic-stakes class;
- whether divergence is duplicate, explained, or a true miss;
- complement/risk trigger;
- candidate and incumbent cost and latency.

Before observing rollout results, the operator must set the numeric overall non-inferiority bound and evaluation window. Promotion additionally requires:

1. **Critical-class rule:** zero unexplained candidate false approvals in critical security, data-integrity, public-contract, gate/permission, persistence/migration, and concurrency classes. Any miss freezes promotion and retains the incumbent route for that class.
2. **No aggregation masking:** low-risk volume cannot offset a critical miss; every critical divergence is adjudicated individually.
3. **Efficiency rule:** measured safety parity alone is insufficient; the candidate must materially reduce cost and/or latency.
4. **Class-limited promotion:** evidence may authorize only classes represented sufficiently in the shadow window. Unknown/mixed classes retain conservative fallback.

Expected block-recall effect before measurement: **unknown**. The design is intended to measure non-inferiority, not assume it.

## Open forks

### Confidence

- **High:** flat-panel/config contradiction; waste concentration; safety of lifecycle-first sequencing; task-boundary rotation over arbitrary thresholds; skill-first e2e treatment; need to preserve handoff semantics; inability to retire `commit-message` as a roster-only edit.
- **Medium:** B-first will be the best eventual candidate topology and lifecycle changes will materially reduce coordinator burn.
- **Low/unknown:** exact B, B+X, or routed-panel block recall; best complement leaf; optimal threshold backstop; class-specific savings; exact extension surface needed for core review changes.

### Remaining uncertainty

1. Per-review leaf overlap and unique material-finding attribution are absent.
2. The numeric non-inferiority margin and shadow-window size require operator disposition before Slice 2.
3. Current overlay rules cannot shadow core reviewer/session built-ins; implementation must choose upstream/template work, ownership promotion, or a new extension slot.
4. Prompt-level lifecycle changes may not ensure adoption; the weekend slice should prefer low-risk mechanical ergonomics without auto-dispatch loops.
5. The exact dispatch retry seam has not yet been localized.

### Phased execution brief

#### Slice 1 — Weekend: lifecycle protocol and skill-first roster

**Boundary / sanctioned surface**

- Establish the project/upstream overlay contribution for coordinator lifecycle guidance and routing.
- Add proper repo-local skill units for isolated review-blocker fixes and repeated e2e surgery through `.vh-agent-harness/overlays/<pack>/skills/<skill>/SKILL.md` (plus any generated catalog/callable contributions required by harness conventions).
- Route pure bookkeeping work to the existing `docs-steward` specialist.
- Prefer fresh task/slice-bound sessions at first concrete dispatch. Use turn/I/O thresholds only as warnings/backstops.
- Add a checkpoint-compatible receiver-targeted handoff payload, or improve the preferred choreography while retaining `/handoff-save` compatibility.
- Record the O1 shadow measurement contract, but do not change review execution or authority.

**Non-goals**

- No reviewer seat, aggregation, or gate-authority change.
- No `commit-message` or `explore` retirement.
- No new e2e specialist.
- No retry-storm or shell-guard implementation.
- No application code changes.

**Dependencies:** none, except selecting an already active overlay or sanctioned upstream template contribution rather than duplicating core built-ins.

**Risk:** low to medium. Prompt-only guidance may have weak adoption; make the preferred path mechanically easy, but do not automate child creation in a way that can reproduce retry storms.

**Acceptance criteria**

- Rendered coordinator guidance makes task/slice boundaries the primary rotation trigger.
- Handoff-capable state retains receiver, next step, and premise `(value, source, re_derivation_command, observed_at)` tuples.
- Bookkeeping routes to `docs-steward` without widening authority.
- Both build skills render, validate, and are callable only from intended surfaces.
- Review authority and git permissions are unchanged.

**Verification lane**

- Harness seam: `vh-agent-harness update --dry-run`; inspect ownership classification and rendered diff; canonical update; `vh-agent-harness doctor`; skill validation/catalog checks; callable-graph/routing fixtures; targeted permission probes; bounded lifecycle walkthrough across a task-boundary handoff.
- Explicitly verify no new git mutation edge and no exec-family alias/unification.
- Application lanes 1–8: **none**, because application code is untouched.

#### Slice 2 — Review candidate instrumentation and full-overlap shadow

**Boundary / sanctioned surface**

- First establish or use a sanctioned core extension/upstream template seam; overlays cannot shadow `commit-reviewer` or `review-tiers.json`.
- Correct the stale callable-graph/config story as part of the same authoritative source change.
- Run a B-first candidate and conservative risk-triggered complement non-authoritatively while the incumbent full panel still completes and controls the gate.
- Persist complete per-review overlap fields needed by the recall protocol.

**Non-goals**

- No reviewer seat removal or candidate landing authority.
- No B-only path.
- No size-based production routing.
- No unsupported choice of C or D as permanent complement.

**Dependencies:** sanctioned core extension/upstream route; predeclared operator non-inferiority bound and evaluation window.

**Risk:** medium. Shadow overlap temporarily raises spend; faulty plumbing must not let candidate output influence transitions.

**Acceptance criteria**

- Every eligible shadow review has complete incumbent/candidate comparison data.
- Candidate output cannot authorize a gate transition.
- Malformed candidate output fails closed observationally and cannot affect incumbent execution.
- Critical-class divergences are individually inspectable.
- Cost and latency are recorded for both paths.

**Verification lane**

- Harness seam: dry-run/render/ownership review/update/doctor; orchestrator/config fixtures for tier enablement, escalation, malformed leaves, failure handling, and authoritative-vs-observational separation; permission/authority probes; bounded live full-overlap shadow.
- Application lanes 1–8: **none**, unless implementation unexpectedly touches vh-solara application code.

#### Slice 3 — Semantic-stakes classifier, shadow-only

**Boundary / sanctioned surface**

- Add deterministic observational classification based on protected ownership, authority/transition type, and semantic signals.
- Include docs/research, generated/mechanical, product logic, auth/permission, persistence/migration, concurrency, public contract, gate/runtime policy, mixed, and unknown cases.
- Unknown, mixed, and protected cases conservatively map to full incumbent fallback in the candidate policy.

**Non-goals**

- No file/line-size authority rule.
- No use of attention-only metadata as transition authority.
- No production routing until class-specific non-inferiority is demonstrated.

**Dependencies:** Slice 2's reliable overlap instrumentation.

**Risk:** medium despite observational status; a misleading classifier can bias later promotion. Treat under-classification as a router defect.

**Acceptance criteria**

- Deterministic fixture matrix covers all named classes and conservative fallback.
- Shadow logs identify route/class confusion and incumbent misses by proposed route.
- Any future promotion recommendation is class-limited and evidence-bound.

**Verification lane**

- Harness seam: dry-run/render/update/doctor; classifier fixtures; authority probes; live shadow comparison.
- Application lanes 1–8: **none**.

#### Slice 4 — Evidence-gated cascade promotion

**Boundary / sanctioned surface**

- Promote only the candidate topology/classes that pass the predeclared O1/O2 non-inferiority protocol.
- Keep full incumbent fallback for critical, unknown, mixed, or under-evidenced classes.
- Continue a bounded random full-panel audit for drift detection after promotion; it supplements, rather than justifies, the initial authority change.

**Non-goals**

- No global panel trim based on aggregate block share.
- No removal of critical fallback.

**Dependencies:** completed, adjudicated shadow window; operator acceptance of the measured result.

**Risk:** high relative to prior slices because this changes transition-adjacent review authority.

**Acceptance criteria**

- Zero unexplained critical-class false approvals in the predeclared window.
- Overall non-inferiority bound met.
- Material cost/latency improvement measured.
- Fail-closed behavior, committer exclusivity, and candidate-output invariant remain demonstrably intact.

**Verification lane**

- Harness seam plus live gated-commit exercises across representative classes; retained command/outcome receipts bound to the assessed tree.
- Application lanes 1–8 only if representative fixture changes deliberately touch those app surfaces; do not claim app-lane coverage otherwise.

#### Slice 5 — Shell/exec hygiene normalization (independent)

**Boundary / sanctioned surface**

- Put Go on the sanctioned exec environment PATH without aliasing exec-family verbs.
- Normalize repo-root absolute paths where safe.
- Exempt read-only git forms from mutation-bypass detection while preserving all git mutation denial/exclusivity rules.
- Normalize/allow the sanctioned `exec npm --prefix web run <script>` shape.
- Add a sanctioned commit-gate message cleanup operation rather than raw `rm`.

**Non-goals:** no gate-authority widening; no generic shell relaxation; no app behavior changes.

**Dependencies:** none.

**Risk:** medium; parser/normalization changes can accidentally over-allow or over-deny.

**Acceptance criteria:** targeted probes reproduce each audited denied-approved shape, remove the false denial, and retain denials for adjacent unsafe mutations or malformed forms.

**Verification lane:** shell-guard/parser/plugin fixtures, explicit allow/deny permission probes, update/render/doctor. Application lanes 1–8: **none**.

#### Slice 6 — Dispatch retry-storm dedupe/backoff (independent)

**Boundary / sanctioned surface**

- Localize the actual dispatch/retry implementation before planning edits.
- Add idempotency/deduplication for logically identical in-flight dispatches and bounded retry/backoff.
- Preserve legitimate distinct and concurrent dispatches.

**Non-goals:** no reviewer topology, lifecycle protocol, or hygiene changes in this slice.

**Dependencies:** dispatch seam localization and a deterministic reproduction fixture.

**Risk:** medium to high; overly broad dedupe can collapse legitimate work.

**Acceptance criteria**

- Repeated identical dispatch attempts within the defined retry scope produce one child/session.
- Transient failures retry only within a bounded policy.
- Distinct task identities and intentional fan-out remain distinct.
- Usage accounting is not inflated by near-empty duplicate sessions.

**Verification lane:** targeted harness/plugin unit fixture and bounded load/retry test, plus render/doctor if generated surfaces change. Application lanes 1–8: **none**, unless seam localization finds this behavior in vh-solara Go or web application code; if so, use the corresponding localized lane rather than assuming a harness-only verifier.

#### Slice 7 — Trailer migration and roster retirement evaluation (optional, later)

**Boundary**

- If retirement remains desirable, explicitly migrate `Task-Card:` trailer authorship away from `commit-message`, update committer/record-lifecycle contracts, and verify end-to-end trailer reachability before removal.
- Evaluate `explore` by unique process value and replacement coverage, not usage alone.

**Non-goals:** this is not required to achieve the dominant waste reduction.

**Dependencies:** explicit replacement owner and contract migration plan.

**Verification lane:** harness render/doctor, callable graph and permission probes, gated-commit trailer fixture/live exercise. Application lanes 1–8: **none**.
