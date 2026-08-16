# Harness own vs upstream boundary

> NOTE: Promoted from tmp/agent-runs/sb-overlay-vs-upstream_2026-08-16/brief.md to researches/decisions/harness-own-vs-upstream-boundary.md
> Date: 2026-08-16

Question: which harness-waste changes belong to vh-solara locally, which belong upstream in the agent harness, and which first require a new extension seam?

## Context

### Executive decision

Adopt this doctrine:

> **Use local overlays/config/state for project policy and reversible pilots; put reusable mechanisms, safety behavior, and bug fixes upstream; add narrow typed, fail-closed extension seams where legitimate per-project policy currently has no supported input.**

Execution sequence:

1. **O4 now — local choreography and additive pilots:** land only project-owned guidance, skills, state, probes, and interim mitigations.
2. **O3 — typed extension seams:** propose and validate narrow seams for review policy, first-dispatch bootstrap, optional project runtime environment, and dispatch identity where needed.
3. **O1 — upstream generic mechanisms:** contribute proven generic behavior and fixes to harness core, then consume them through a tagged release and `vh-agent-harness update`.
4. **O2 — ownership promotion:** use only as a minimal, time-boxed emergency bridge for one complete managed unit when a named critical pilot cannot wait. It is not the default architecture.

Confidence: **medium overall**. The generated/overlay boundary and most family classifications are high-confidence. The exact dispatch retry implementation seam and external upstream contribution/release route remain low-confidence and need localization.

### Objective

Classify each requested change as:

- **OWN-LOCAL** — project-local overlay pack, project config/state, or project operational guidance;
- **UPSTREAM** — reusable harness-core mechanism, safety rule, bug fix, generated command/agent definition, or embedded-corpus change;
- **NEEDS-NEW-SEAM** — legitimate project variation exists, but current overlays cannot express it without taking ownership of an entire built-in.

For every piece, provide an interim route that is locally landable without pretending the upstream mechanism already exists.

### Constraints

- Never hand-edit generated `AGENTS.md` or anything under `.opencode/`; local harness changes originate under `.vh-agent-harness/` or supported local config/state and render via `vh-agent-harness update`.
- Keep `exec`, `exec-ro`, `exec-sandbox`, and `shell` distinct; do not unify or alias them.
- Preserve committer-exclusive git authority and the model-output-is-candidate invariant.
- Preserve review block recall. The incumbent review remains authoritative through complete overlapping shadow measurement.
- Preserve the prior brief's lifecycle-first and shadow-before-promotion sequence.
- The project does not control upstream's tag-driven release timing.
- Do not broaden this brief into implementation.

### Success criteria

- Every requested family and piece has an ownership classification.
- Missing seams have a bounded shape and explicit authority limits.
- Local interim behavior is honest about advisory versus mechanical guarantees.
- Every proposed slice is independently landable and names a real verifier.
- Application test lanes are invoked only if application code is actually touched.

## Findings

### Grounded evidence summary

Key evidence from the repository and installed harness v0.25.0:

- **E01:** `AGENTS.md` consists of managed generic core plus project mission content; managed `.opencode/` output must not be hand-edited.
- **E02–E04:** overlays add agents, commands, skills, JSON append data, permission packs, callable-graph snippets, and named extension snippets. They cannot shadow core built-ins. The documented replacement route is raise-only whole-file ownership promotion.
- **E06–E07:** `.opencode/config/review-tiers.json` is managed core output, although some role/lens/class data is described as per-repo policy. No project-owned merge layer for those fields was found.
- **E08:** overlay skills are a supported additive unit and remain advisory workflows rather than transition authority.
- **E09–E10:** `/session-start` already binds session state, contract, memory, and kickoff checkpoint. `/handoff-save` uniquely carries receiver targeting and load-bearing premise 4-tuples; `/checkpoint-save` does not.
- **E11–E12:** the durable specialist keep-list and `commit-message` role are managed core. `commit-message` currently authors the exact `Task-Card:` trailer on which record retirement depends.
- **E13–E15:** the current harness already has a read-only git command group, hyphen-aware mutation detection for commands such as `merge-base`, and repo-root-relative path normalization in shell guard.
- **E16–E17:** Go PATH handling is project/environment-specific today and is documented through an explicit `export PATH` inside `exec bash -c`. No current `npm --prefix` denial was reproduced.
- **E18–E19:** commit-gate already owns message-file cleanup on success/release/no-change and through orphan sweeping. `readonly-scripts.sh` is not the cleanup owner.
- **E20:** the exact task/subagent child-creation retry seam responsible for the retry storm was not localized. Existing model-HTTP retry code is a different boundary.
- **E21–E22:** this repo consumes versioned harness migrations; the exact external upstream repository, PR process, unreleased-testing route, and release timing were not established from local canon.
- **E23:** `docs/ai/shell-execution.md` is referenced but absent, which is a documentation contradiction rather than proof of a missing runtime mechanism.
- **E24:** active operational guidance belongs in `docs/ai/`; historical option comparison and rationale belong in `researches/decisions/` when a durable research artifact is explicitly wanted.

Corrections to stale premises:

- Do **not** plan a new read-only-git exemption until a current command reproduces a false denial; the cited cases appear fixed.
- Do **not** plan generic repo-root normalization without a reproduced gap; the central shell-guard path already normalizes relative reads.
- Do **not** add a commit-gate cleanup verb or place cleanup in `readonly-scripts.sh`; cleanup is already gate-owned and exposing it would widen deletion authority.
- Do **not** change `npm --prefix` handling without an exact positive/negative permission probe reproducing the alleged problem.

## Options

### Ownership matrix

#### 1. Review pipeline

| Piece | Decision | Enduring owner | Interim before release | Verification |
|---|---|---|---|---|
| Reviewer model identity | **OWN-LOCAL** | Operator/local model state | Continue using supported gitignored local model-selection state. Do not hard-code provider/model IDs into core. | Resolve configured leaf model state; config validation; `vh-agent-harness doctor`. |
| Measurement window and non-inferiority/block-recall threshold | **OWN-LOCAL** | Project/operator decision | Predeclare locally before examining candidate results. | Schema/config check and receipt proving threshold/window predated result evaluation. |
| Role/lens/class ownership policy | **NEEDS-NEW-SEAM** | Local policy over an upstream merge mechanism | Prefer a project-owned typed review-policy fragment. Whole-file promotion is only an emergency bridge. | `vh-agent-harness update --dry-run`; rendered/origin/ownership diff; schema fixtures; `doctor`; proof that metadata does not change aggregation authority. |
| Leaf count, ordering, and tier enablement | **NEEDS-NEW-SEAM** for selection; **UPSTREAM** for orchestration | Project selects declared capabilities; core executes and validates | Keep incumbent topology authoritative until the seam exists. | Focused fixtures for order, enable/disable, missing leaves, malformed policy, and fail-closed behavior. |
| Generic reviewer leaf definitions/prompts | **UPSTREAM** | Harness embedded corpus/templates | If a critical experiment cannot wait, ownership-promote one minimal complete leaf definition for a time-boxed pilot; never create a duplicate same-name overlay built-in. | Dry-run, source-origin classification, rendered prompt diff, callable graph/config validation, `doctor`. |
| Escalate-on-flag execution | **UPSTREAM** mechanism + **NEEDS-NEW-SEAM** for project trigger policy | Core owns conditional execution; project may declare conservative triggers | Do not emulate a new authority cascade through prompt choreography. Keep the full incumbent panel authoritative during shadow. | Trigger/no-trigger, timeout/failure, malformed flag, and candidate-isolation fixtures. |
| Candidate shadow-measurement harness | **UPSTREAM** | Harness review mechanism | Local work may define the measurement protocol, but cannot claim complete overlap or authority isolation without a mechanical observer/shadow runner. | Every eligible review has incumbent and candidate records; injected candidate failure cannot affect incumbent execution or disposition; permission/authority probe confirms no transition edge. |

##### Required review-policy seam

A typed, schema-validated project fragment may set:

- declared leaf selection;
- roles/lenses and semantic class ownership;
- conservative escalation-trigger policy;
- measurement metadata.

It must not set or replace:

- aggregation algorithm;
- review-gate or commit authority;
- the rule that the incumbent executes during shadow;
- permission or transition authority.

Unknown leaf/class references and malformed policy must fail closed. The candidate must never suppress incumbent execution.

##### Route choice among template change, ownership promotion, and new seam

- **Template/core change:** generic leaf prompts, aggregation, escalation execution, and the observational shadow runner.
- **New extension seam:** per-project role/lens/class/leaf selection and trigger policy.
- **Ownership promotion:** only a temporary bridge for one complete stable unit, never the normal customization model.

#### 2. Session lifecycle

| Piece | Decision | Enduring owner | Interim before release | Verification |
|---|---|---|---|---|
| Task/slice-bound hub rotation | **OWN-LOCAL pilot**, then **UPSTREAM guidance candidate** | Local operating policy initially | Add concise project guidance/checklist and collect evidence; boundaries, not arbitrary turn counts, remain primary. | Rendered diff if injected through a sanctioned source/slot; `doctor`; lifecycle walkthrough showing fresh binding at a task boundary. |
| Automatic `/session-start` plus contract on first concrete dispatch | **NEEDS-NEW-SEAM** | Upstream dispatch/bootstrap mechanism with local task identity input | Require explicit session start before delegation. Do not claim this is automatic. | Fixture: first dispatch creates exactly one binding, contract, memory, and kickoff checkpoint; duplicate request returns/reuses the same bootstrap; failed bootstrap does not spawn children. |
| Fold ordinary handoff ergonomics into checkpoint | **UPSTREAM** | Managed command/schema | Continue using checkpoint for durable progress and handoff for receiver-targeted transfer. | Backward-compatible command/schema fixture; old checkpoints reopen; supplied receiver fields survive. |
| Receiver, next step, and premise 4-tuple preservation | **UPSTREAM invariant** | Core checkpoint/handoff/resume workflow | Preserve `/handoff-save`; do not retire it. | End-to-end handoff/resume fixture re-derives a premise and detects a deliberately stale value. |
| Retire `/handoff-save` | **BLOCKED pending UPSTREAM parity** | Core | No local duplicate or early retirement. | Search/reachability of all callers plus receiver/premise-parity proof. |

##### Required pre-dispatch bootstrap seam

Input should include task identity, slice identity, intended receiver, and source session. It should idempotently bind/create the destination session, persist the stable task contract, save the kickoff checkpoint, and return the existing bootstrap on a duplicate request. It may create session state but may not approve plans, commits, reviews, or permissions.

#### 3. Specialist and skill roster

| Piece | Decision | Enduring owner | Interim before release | Verification |
|---|---|---|---|---|
| `review-blocker-fix` skill | **OWN-LOCAL pilot → UPSTREAM candidate** | Start in a project overlay; promote only after cross-project evidence | Add as an advisory overlay skill without new transition authority. | Harness skill validation; update dry-run/rendered diff; `doctor`; catalog check after required OpenCode restart; callable/permission probe; bounded workflow walkthrough. |
| `web-e2e-surgery` skill | **OWN-LOCAL** | vh-solara overlay | Encode the repo-specific eight-lane localization, serial fixture constraints, Go PATH, and Playwright procedures locally. | Skill validation/catalog checks; validate referenced commands and docs. Run application lanes only when an implementation actually changes app/test code. |
| Pure bookkeeping routing to `docs-steward` | **OWN-LOCAL routing policy** | Project guidance/dispatch policy | Route suitable tasks to the existing specialist; do not create another authority surface or duplicate `docs-steward`. | Callable/permission probe and sample routing packet; confirm no git-mutation authority is added. |
| `commit-message` retirement | **UPSTREAM**, currently blocked | Core agent/commit contract | Retain it until exact `Task-Card:` trailer authorship has a mechanically verified replacement. | Card-driven gated-commit fixture; exact trailer inserted once; commit reachable from intended branch; record retirement proof. |
| Trailer authorship migration | **UPSTREAM** | Gate/committer contract or another explicit reviewed core source | Design deterministic card-ID input and fail-closed handling before changing the roster. | Valid/invalid card IDs, multi-card behavior, ad-hoc commit behavior, exact trailer and reachability tests. |
| Generated durable-specialist keep-list | **UPSTREAM** | Managed core guidance | Do not edit generated `AGENTS.md` or own the full core file for one roster item. | Update dry-run/rendered diff from authoritative upstream source; graph and permissions have no dangling references; `doctor`. |
| Generic subtractive roster override | **NEEDS-NEW-SEAM only if evidence emerges** | Core resolver | Do not build it for one retirement. Prefer universal upstream retirement if the role is obsolete everywhere. | Multi-consumer need; resolver rejects removal of depended-on agents; graph/permission closure tests. |

#### 4. Hygiene

| Piece | Decision | Enduring owner | Interim before release | Verification |
|---|---|---|---|---|
| Go available on exec PATH | **OWN-LOCAL workaround**; optionally **NEEDS-NEW-SEAM** | Project environment policy; generic validated environment seam only if justified | Keep the documented `exec bash -c` PATH export. Do not change verb identities or inject host prefixes. | Compare sanctioned Go probe with and without explicit project PATH; verify host env is unchanged and all exec-family contracts remain distinct. |
| Project run-shape environment injection | **NEEDS-NEW-SEAM only if workaround cost merits it** | Upstream mechanism, local validated env additions | No urgent change; explicit PATH is functional. | Positive runtime-env fixture; forbidden/secrets fields rejected; no host leakage; mode-floor and verb-specific tests. |
| Repo-root absolute/relative normalization | **UPSTREAM bug class, apparently already fixed** | Shell guard | Reproduce a concrete inconsistent consumer before filing work. | Run equivalent in-repo forms from root/subdirectory; `..` and symlink escapes remain denied. |
| Read-only git exemption | **UPSTREAM, already fixed in current core** | Shell guard/allowed-command tables | No implementation unless a specific read-only command currently fails. | Positive probes for documented read-only commands and negative probes for adjacent mutations such as `merge`, `merge-file`, and `update-index`. |
| `npm --prefix` allowlist shape | **EVIDENCE-GATED** | Local permission addition only if the issue is agent-specific and supported; otherwise upstream parser/table fix | Reproduce the exact sanctioned form first. | Positive probes for documented web/host-web scripts; negative probes for malformed prefix, unauthorized lifecycle mutation, and unwrapped host npm. |
| `commit-gate.sh` cleanup verb | **REJECT; cleanup already UPSTREAM/core-owned** | Commit gate | Keep automatic cleanup. Fix a reproducible leak inside the gate rather than expose deletion authority. | Existing success/release/no-change/orphan cleanup fixtures; malicious message path outside allowed prefix cannot be deleted. |
| Cleanup through `readonly-scripts.sh` | **REJECT** | N/A | None. Mutation does not belong in a read-only helper. | Confirm helper surface remains narrow. |

Local `permission-pack.jsonc` entries are appropriate only for a genuine project-specific command shape that the supported permission seam can safely express. They are not a substitute for parser correctness, generic shell safety, runtime environment handling, or core gate cleanup.

#### 5. Dispatch retry storm

| Piece | Decision | Enduring owner | Interim before release | Verification |
|---|---|---|---|---|
| Localize the authoritative dispatch/child-creation boundary | **RESEARCH/LOCALIZATION FIRST** | Read-only seam investigation | Do not edit guessed files or reuse model-HTTP retry code. | Produce exact owner, call path, state transitions, and reproduction showing where duplicate child/session creation occurs. |
| Logical dispatch idempotency/dedupe | **UPSTREAM** after localization | Authoritative child-creation boundary | Use stable task/slice identity locally, dispatch sequentially, inspect existing children before retrying. | Identical logical requests create/return one child; distinct task IDs and intentional fan-out remain distinct. |
| Bounded backoff/retry | **UPSTREAM** after localization | Same boundary | Permit at most one manual retry after inspection; never auto-spawn on ambiguous failure. | Transient pre-acceptance failure retries within bound; validation/permission failures do not retry; child-created-unknown never retries. |
| Local mitigation | **OWN-LOCAL choreography** | Project coordinator guidance | Stable logical identity, sequential dispatch, inspect-before-one-retry, no parallel identical retry. | Bounded walkthrough and child/session-ID comparison before retry. |

##### Required dispatch contract

The eventual request should carry a stable logical dispatch ID, parent session ID, task/slice ID, target agent, payload digest, and attempt number. Dedupe should be keyed at least by parent, logical ID, and target. A duplicate in pending/accepted/child-created state returns the existing result. Retries are bounded and allowed only for known transient failures before acceptance. A missing immediate response is not proof of failure, and a child-created-with-unknown-completion state is never automatically retried.

This contract is a target design, not a claim about the present implementation. The implementation surface remains unlocalized.

#### 6. Durable ownership rule

Recommend two layers only if the operator later requests durable artifacts:

1. **Canonical operational checklist under `docs/ai/`**, e.g. `docs/ai/harness-change-ownership.md`:
   - Is the behavior project-domain-specific?
   - Can an additive overlay unit express it?
   - Is it a supported typed permission/config addition?
   - Does it replace a managed built-in?
   - Is the variation legitimately per-project?
   - If yes but no narrow seam exists, propose a typed fail-closed seam.
   - If it is a generally reusable mechanism or bug fix, route upstream.
   - Use ownership promotion only as a declared, time-boxed fork with an exit.
   - Never patch generated output.
   - Verify with dry-run, origin/ownership/rendered diff, doctor, and targeted authority/permission fixtures.
2. **Decision rationale under `researches/decisions/`** only if a committed research decision record is explicitly desired. A memo is evidence/rationale, not active operational policy.

Also resolve the broken reference to absent `docs/ai/shell-execution.md`: locate its intended replacement or restore correct canonical guidance in a separate docs slice. Do not infer a runtime bug from the missing document.

### Debate result and objections

The debate returned **recommend**, selecting the O4 → O3 → O1 doctrine.

Strongest objections and resolutions:

1. **Typed seams still depend on unknown upstream release timing.** Confirmed. Local pilots and mitigations must remain useful but explicitly advisory; no release date or acceptance is assumed.
2. **Local choreography cannot guarantee complete review overlap, lifecycle bootstrap, or storm prevention.** Confirmed. It is interim only and cannot impersonate the missing mechanical mechanism.
3. **Whole-file promotion may be the only immediate mechanical local route for review policy.** Confirmed. It is allowed only as a narrow bridge, because permanent promotion turns generic core into a drifting project fork.
4. **The dispatch seam is unlocalized.** Confirmed. The brief settles the safety/idempotency contract, not the implementation location; localization must precede code changes.
5. **Some hygiene assumptions are stale.** Confirmed. Read-only git and cleanup appear resolved; npm remains unproven.

**Recommendation: O4 → O3 → O1 doctrine**

## Open forks

### O2 emergency bridge policy

Ownership promotion is justified only when all are true:

1. A named, materially necessary pilot is blocked because an additive/typed seam does not exist.
2. Waiting for upstream would prevent the required evidence collection, not merely delay convenience.
3. The promoted scope is exactly one minimal complete managed unit.
4. Existing review, permission, commit, and candidate-authority invariants remain intact.
5. The bridge records its upstream dependency, migration target, version boundary, and sunset.

Exit when the typed upstream seam is released and consumed, or when the pilot ends. If the bridge expands into multiple unrelated built-ins or indefinitely owns generic mechanisms, stop and re-adjudicate; it has become the rejected broad-fork strategy.

### Confidence and remaining uncertainty

#### High confidence

- Additive overlay versus managed built-in boundary.
- Whole-file ownership promotion is coarse and drift-prone.
- Project-specific skills and operational policy belong locally.
- Generic orchestration, gate behavior, retry mechanics, and generated roster changes belong upstream.
- `/handoff-save` cannot be retired before receiver and premise-tuple parity.
- Read-only git and commit-message cleanup assumptions are stale in current core.
- Operational guidance belongs in `docs/ai/`; decision rationale alone does not establish active policy.

#### Medium confidence

- Typed review-policy and bootstrap seams are the best enduring shape. They fit the evidence and authority boundaries, but upstream acceptance is not established.
- A validated project runtime-environment seam may be worthwhile; the current explicit Go PATH workaround may be sufficient.

#### Low confidence / open

- Exact source and state machine of the 2026-08-10 dispatch retry storm.
- Exact upstream repository, contribution procedure, test-unreleased path, acceptance criteria, and release timing.
- Whether `npm --prefix` currently has any defect.
- Whether multiple consumers need a generic subtractive roster seam.

### Phased, individually landable execution brief

#### Phase 0 — Re-derive and localize

**Slice 0A: hygiene verification**

- Classification: verify-only; no assumed fix.
- Confirm current read-only git, repo-root normalization, and commit-message cleanup behavior.
- Reproduce or close the `npm --prefix` concern.
- Resolve the absent shell-execution-doc reference.
- Verifiers: exact permission probes; focused shell-guard/commit-gate fixtures where available; `vh-agent-harness doctor`.

**Slice 0B: dispatch seam localization**

- Classification: prerequisite to UPSTREAM retry fix.
- Locate the authoritative logical-dispatch and child/session-creation path and establish a deterministic retry-storm reproduction.
- Verifier: one logical request under induced ambiguous/transient failure, with an inspectable ledger of attempts and created child IDs.

#### Phase 1 — Lifecycle-first local controls

**Slice 1A: task-bound lifecycle checklist**

- Classification: OWN-LOCAL pilot.
- Specify explicit session start before first dispatch, task/slice boundary rotation, receiver-targeted handoff use, and stable logical dispatch identity.
- Interim: manual/advisory, explicitly not automatic.
- Verifiers: source diff; if harness-rendered input changes, `vh-agent-harness update --dry-run`, rendered diff, and `vh-agent-harness doctor`; bounded lifecycle walkthrough.

**Slice 1B: upstream bootstrap/checkpoint seam specification**

- Classification: NEEDS-NEW-SEAM + UPSTREAM.
- Specify idempotent first-dispatch bootstrap and checkpoint receiver/premise parity.
- Preserve `/handoff-save` until end-to-end parity is proven.
- Verifiers: contract/schema fixtures and stale-premise resume scenario.

#### Phase 2 — Additive local skills and routing

**Slice 2A: `review-blocker-fix` pilot**

- Classification: OWN-LOCAL pilot, upstream candidate after evidence.
- Verifiers: skill validation, update dry-run, rendered diff, doctor, catalog after restart, callable/permission probe.

**Slice 2B: `web-e2e-surgery`**

- Classification: OWN-LOCAL permanently unless generalized beyond vh-solara.
- Verifiers: same harness checks plus reference validation against the actual eight-lane test canon. No app test lane is required merely to add the skill.

**Slice 2C: docs-steward bookkeeping routing**

- Classification: OWN-LOCAL policy.
- Route to the existing specialist; do not create a duplicate skill/agent.
- Verifiers: prompt/routing diff and permission/callability check.

#### Phase 3 — Review policy and shadow seams

**Slice 3A: local measurement policy**

- Classification: OWN-LOCAL.
- Predeclare model identity location, observation window, and block-recall/non-inferiority decision rule without changing incumbent topology or authority.
- Verifier: config/schema receipt proving declarations existed before results.

**Slice 3B: typed review-policy seam proposal**

- Classification: NEEDS-NEW-SEAM.
- Separate project seat/role/class/trigger selection from upstream orchestration and aggregation.
- Verifiers: dry-run/render/doctor in a future implementation plus fail-closed policy fixtures.

**Slice 3C: observational shadow mechanism**

- Classification: UPSTREAM.
- Require full eligible-case overlap, candidate failure isolation, stable result schema, and zero transition authority.
- Verifiers: overlap completeness, injected failure, and authority-isolation fixtures.

**Slice 3D: evidence-gated promotion**

- Classification: local operator decision over upstream mechanism.
- Only after the predeclared window and block-recall argument pass.
- Verifier: report bound to the declared window/threshold; incumbent and candidate records complete for every eligible case.

#### Phase 4 — Upstream core migrations

Independently upstream:

1. generic reviewer prompts and escalate-on-flag orchestration;
2. review observer/shadow runner;
3. idempotent first-dispatch bootstrap;
4. checkpoint receiver and premise-tuple parity;
5. Task-Card trailer migration followed by `commit-message` retirement and keep-list cleanup;
6. dispatch dedupe/backoff at the localized child-creation boundary;
7. any reproduced generic shell/parser/path bug.

Each upstream slice needs focused harness fixtures, rendered-corpus checks, `vh-agent-harness update --dry-run`, rendered/origin diffs, `vh-agent-harness doctor`, and positive/negative permission probes where authority is involved. Consumption in vh-solara occurs only after an upstream tag is available and the rendered migration is reviewed.

#### Phase 5 — Conditional O2 bridge

Activate only after Phases 1–3 identify a named critical pilot blocked solely by the missing seam. Record exact promoted unit, source origin, safety invariants, upstream dependency, and sunset. Verify with ownership classification, update dry-run, rendered diff showing exactly the intended complete unit, doctor, and the same authority/recall fixtures owed by the eventual seam.
