---
name: formal-verification
description: Agent-authored formal proofs an engine checks. Use when asked to PROVE a provable invariant — pure-logic, algebraic, or state-machine (Lean4-core). Engine routing, scope, and INFORMS-only authority are in the body.
compatibility: opencode
---

# Formal Verification — Agent-Authored Proofs, Engine-Checked (overlay-only S1 pilot)

This skill reproduces a formal-verification **procedure** in which the agent
**AUTHORS** a proof and a rigorous engine **MECHANICALLY CHECKS** it. The
reasoning lives in the agent; the engine provides the language and the checker.
That is the fixed paradigm of this pilot (see "The Paradigm").

It is **distinct from commit-review** (reactive, current-diff-scoped) and
**distinct from contract-invariant-audit** (latent-contract discovery). Its
distinct value is producing a mechanically checked proof of a declared
invariant — and binding that proof to the code via a fidelity artifact so the
proof cannot be laundered into an unearned "the code is correct." That
anti-laundering binding is the pilot's success criterion (see "THE CRUX" and
"Primary metric").

**S1 overlay pilot.** This is an experimental overlay skill. Core promotion is
NOT authorized. The eight S2 evidence classes are unmet until a real pilot runs
(see "S2 record"). Nothing here enters `templates/core/`.

## Current release model — temporary

This block describes the current pilot/adoption model, not a permanent capability constraint.

- **Scope:** Lean4-core is the supported route (pure-logic, algebraic, simple state-machine). TLAPS and mathlib are **not currently supported/evidenced; a requested proof problem may be evaluated as a future pilot.**
- **S2 scoring:** The skill authors Lean4 pilots and **does not score S2**. S2 remains deferred. While the harness is continuously developing, there is **no sunset or calendar backstop** for that deferral. *(Anti-staleness trigger: when "always-growing → matures," replace this no-sunset statement with the then-current S2 lifecycle rule).*
- **Adoption/intake:** **For now**, adopters are operator-managed and intake is the operator's direct channel; **no public request path exists**. *(Anti-staleness trigger: when "managed adopters → public/unmanaged," replace this managed-only/no-public-intake statement with the actual public intake).*

## Scope and authority (recognition detail)

The frontmatter description is intentionally lean (it loads every turn); the
scope/authority detail it carried lives here and in the deeper sections below.

- **Authority:** outputs INFORM only and never gate commits, releases, doctor,
  or updates (see "Authority — INFORMS ONLY"). A proof of a model is never
  laundered into a proof of the code (see "Anti-over-claim rule").
- **No-engine design-time product:** the proof/spec text, the model↔code
  fidelity binding, and the red-on-divergence code-level test are fully
  producible with NO engine installed; the engine check is an OPTIONAL
  confirmation that waits on operator-provisioned Lean4/TLAPS (see "Capability
  property").
- **Do NOT use for:** liveness/temporal properties, Iris-grade concurrent
  separation logic, model-checking (TLC), current-commit review, or as a
  substitute for repo-specific live verification (see "Honest scope + climbing
  path" and "The Paradigm").

## Authority — INFORMS ONLY (design condition 1)

> Every output of this skill **INFORMS**. It never gates, blocks, approves,
> promotes, releases, or transitions state on its own.

This applies to the authored proof/spec text, the fidelity-binding artifact, the
red-on-divergence test, the classification decision, the engine-check result,
the property-test prefilter output, and any diagnostic metadata.

- No automatic invocation on edits, commits, doctor, release, or update.
- An engine check (green or red) NEVER triggers a stop or gate. It FEEDS the
  existing shipped `behavioral-closure` crux model with real crux evidence; it
  NEVER independently justifies a code `proven` verdict.
- Property-test prefilter output is advisory, separately labelled, and carries
  no doctor hook.
- A green engine check is a token, not reality (see "THE CRUX").

**Critic's blocker (load-bearing):** the fidelity binding, the red-on-divergence
test, and any engine check MUST NOT be wired into any commit, release, doctor,
or update path. Advisory outputs only. Promoting any specific proof or
fidelity test to a hard gate is a SEPARATE decision that must identify the
protected transition, the deterministic predicate, ownership of the validator,
false-positive and recovery behavior, and explicit authority to gate. **This
skill grants no such authority.**

## The Paradigm (design condition 2 — fixed)

The paradigm is fixed: **the agent WRITES the proof; the engine only provides a
rigorous language and mechanically checks it.** Do not re-open it.

- **Lean4 (dependent type theory)** is the primary engine for pure-logic,
  algebraic, and simple state-machine invariants.
- **TLAPS (TLA+ Proof System)** is a deferred engine for the **SAFETY invariants** of
  concurrent-system models. It is expressly **safety-only**. **Liveness /
  temporal / eventual-settlement reasoning is OUT of the pilot** — TLAPS is not
  used for it, and there is no liveness engine in this pilot. State this
  honestly when asked; do not silently accept a liveness claim. *(Note: TLAPS is not currently supported/evidenced; a requested proof problem may be evaluated as a future pilot.)*
- **TLC / model-checking is NOT permitted.** An engine that brute-forces the
  state space is doing the *reasoning*, which violates the agent-authored
  paradigm. If a candidate would require model-checking to "prove," that is the
  honest-exit signal (see "Invocation / Classification Rule (d)").
- **Property-Test Prefilter:** property testing is exposed as an advisory
  `prefilter: property-test | none` field ONLY. It cheaply falsifies candidates
  before proof-authoring. It is NEVER proof evidence, it is NEVER "the proof,"
  and its outputs are separately labelled with no doctor hook.

## Capability property — design-time product needs NO engine installed (design condition 3)

**This skill MUST produce its design-time product with NO engine installed.**
This is a first-class capability property, not a fallback.

The primary outputs are fully producible without any Lean4 or TLAPS reachable:

1. the **proof / spec text** the agent authors (the actual formal artifact);
2. the **fidelity-binding artifact** (the declared model↔code mapping);
3. the **classification decision** (which engine, or the honest-exit label); and
4. the **red-on-divergence code-level test** (the targeted invariant regression
   test that goes red when the modeled invariant is diverged from the code).

The **engine check is an OPTIONAL confirmation step** that waits on
operator-provisioned Lean4 / TLAPS — a separate infra step (see "Engine-invocation
config"). An absent engine never blocks the design-time product and never yields
`proven` (see "Degradation"). Authoring the proof, the binding, and the
red-on-divergence test is the work; the engine check confirms it when the
operator has provisioned the tooling.

## THE CRUX — Model-Fidelity Binding (design condition 4)

**A proof proves the MODEL, not the CODE.** To prevent a diverged model from
being laundered into a code-behavior proof, the design enforces a strict
fidelity binding. The engine check and the fidelity binding are **DISTINCT UNION
evidence** — fail-closed if either fails.

### The canonical motivating failure (GREEN-TESTS / BROKEN-PRODUCT, Pattern-1)

The motivating failure this design exists to prevent is documented at
`researches/sources/2026-07-23-vh-solara-harness-adoption-field-report.md`,
Pattern-1 ("GREEN-TESTS / BROKEN-PRODUCT"); see the design memo for the full
crux. In that pattern, an in-process e2e suite was green but **structurally
could not exercise the load-bearing path**: the fake fixture *always* emitted
the success signal, so it could never produce the *missed* event that the
reconcile path exists to cover. The one lane that could have proven the crux
live/adversarially was abandoned mid-recon (no closeout); no assertion was
written, no proof ran, the crux was never demonstrated — yet the phase shipped
as "complete."

This is the exact laundering this skill targets: a verification artifact was
treated as proof of load-bearing behavior when it was structurally incapable of
exercising that behavior, the proof lane that could close the gap vanished with
no consequence, and "complete" landed anyway. The fidelity binding below is the
direct structural remedy.

### The fidelity binding (enforced)

- **Fidelity-Binding Artifact:** a declared mapping from the model's transitions
  / variables to the code locations they represent. Authored with the proof,
  reviewable, and part of the design-time product (needs no engine).
- **Red-on-Divergence Test:** a targeted code-level invariant regression test
  that **MUST go red on divergence** between the model and the code. This is the
  cheapest recheck that catches a diverged model. The Pattern-1 lesson, stated as
  a rule: a test that *cannot* go red on the load-bearing divergence — because a
  fake always emits the success signal — is **not a fidelity binding; it is the
  laundering surface.** A red-on-divergence test that has been shown to go RED
  when the modeled invariant is deliberately diverged from the code (the
  divergent/pre-fix condition, where the invariant is broken) and GREEN only when
  a reviewed faithful implementation satisfies the invariant (the faithful
  condition) is the minimum credible binding.
- **Distinct Union Evidence:** the engine check AND the fidelity binding must
  both hold. Fail-closed if either fails. The engine check feeds the shipped
  `behavioral-closure` crux model ONLY with real crux evidence and NEVER
  independently justifies a code `proven`.
- **Anti-Over-Claim / Anti-Laundering Rule:** a proof of a model is **not** a
  proof of the code. "Proven" requires (engine-ran) AND (reviewed fidelity
  binding present) AND (red-on-divergence test present). Silent model drift,
  dropping the fidelity binding, or reporting a model proof as a code proof are
  FORBIDDEN. This extends the broader "the token does NOT prove reality" caveat:
  a green engine check, like a green verdict token, must not be laundered into
  "the code is correct" without the repo-specific live verification.
- **Surviving Objection & Falsifier:** the binding is falsifiable evidence, not a
  mechanically proven code↔model equivalence. **If this mechanism STILL lets a
  diverged-model "proven" through — the Pattern-1 failure mode repeats under this
  design — the mechanism has failed.** Record it; do not paper over it.

## Degradation & the result token (design condition 5 — never blocks)

The design-time product (proof/spec + fidelity binding + red-on-divergence test)
is ALWAYS producible and NEVER blocks.

- **Verifier infeasibility (MERGE):** if no engine is reachable, record
  `proof-written-but-unchecked` as diagnostic metadata. This MERGES onto the
  shipped `result: not-demonstrable` / `verdict: inconclusive` — engine
  unavailability is verifier infeasibility, not a new closure property. An engine
  that did not run can NEVER yield `proven`. This is the disciplined response to
  the Pattern-1 "abandoned proof lane" failure: the lane vanishing did not block
  "complete" then either; the fix here is the *honest token*, not a new gate.
- **Claiming "proven" / "green":** claimable ONLY when (the engine actually ran)
  AND (the run is bound to a reviewed fidelity claim) AND (the red-on-divergence
  test is present). The **never-blocks** invariant is preserved either way: a
  missing engine routes to `not-demonstrable`/`inconclusive`, never to a denial.

## Engine-invocation config (design condition 6 — operator/offline only)

The engine is discovered and invoked through a config schema authored separately
at `.opencode/repo-configs/formal-verification-config.json` (committed-project)
with a secrets/local override twin at
`.opencode/repo-configs/formal-verification-config.local.json` (never committed).
The merge is the established **4-level, two-file, field-by-field merge**
(`defaults ← user ← committed-project ← project-local`, resolved by findLast) —
the same convention used elsewhere at `.opencode/repo-configs/`. This is NOT a
parallel config scheme.

- **Provisioning field** (`provisioning: direct-binary | docker-image`): the skill
  invokes the engine the way the operator pinned. Projects can override the user
  default (one project runs Lean4 via a pinned docker image; another uses the
  host binary).
- **Operator-pinned tags ONLY.** `:latest` and unpinned references are forbidden
  by the Provisioning Constraint — a checker result is only meaningful against a
  known engine version. Pin to a real checked tag.
- **Operator / offline provisioning ONLY.** The skill consumes pinned direct
  binaries or pre-built images. It NEVER triggers a networked build.
- **Docker containment is container-side** (read-only mounts, `--network=none`),
  NOT inherited from `exec-sandbox`. The pilot does NOT introduce or imply a new
  safe Docker execution wrapper, a contained-docker-checker `exec` verb, or any
  new harness exec surface. It only documents the container config the operator
  must supply.

Illustrative config sketch (the authoritative schema lives in the config file
above; the operator MUST pin to a real checked tag — `:latest` is forbidden):

```json
{
  "enabled": true,
  "engine": "lean4",
  "provisioning": "docker-image",
  "binary_path": "",
  "docker_image": "<operator-pinned-tag>",
  "onUnavailable": "defer"
}
```

## Invocation / Classification Rule — seconds-fast decision tree

Run this decision tree before authoring anything. Record the chosen branch.

- **(a) Pure-logic / algebraic invariant → Lean4.**
  *Example:* "for integers `a ≤ b` and `b ≤ c`, prove `a ≤ c`."
- **(b) Simple state-machine invariant → Lean4.**
  *Example:* "a single-threaded bounded counter starts in `[0, max]`; `inc` /
  `dec` preserve the bound."
- **(c) Concurrent-protocol SAFETY invariant → Honest exit (TLAPS unsupported).**
  *Example:* "for a lock protocol, no reachable state has two owners."
  *(Note: TLAPS is not currently supported/evidenced; a requested proof problem may be evaluated as a future pilot.)*
- **(d) Honest exit → `property-test-prefilter` or `no-proof`.**
  Liveness / temporal / eventual-settlement, underspecified heuristics, disproportionate-cost claims, or requested engines that are unsupported (e.g. TLAPS/mathlib). Do NOT force a proof; record the exit reason.

**The boundary — when Lean is the wrong tool vs TLA+:** a Lean encoding of a
transition system becomes the wrong tool when **real interleavings / concurrency
must be modeled.** A sequential Lean encoding *erases* the interleavings, so it
cannot represent the concurrent behavior; that is the boundary for deferring to TLAPS.
One line each side:

- Lean side — "the invariant is a property of values / a single-threaded
  transition relation; there is no concurrency to model."
- TLA+ side — "the invariant is a property of *reachable states under
  interleaved actions*; erasing the interleaving erases the behavior."

## Honest scope + climbing path

- **Provable NOW:** pure-logic, algebraic, and simple state-machine invariants
  (Lean4).
- **The Frontier (OUT of pilot / unsupported):** Concurrent-protocol **safety** invariants (TLAPS); Iris-grade concurrent separation logic;
  liveness / temporal / eventual-settlement proofs; mathlib. Do not over-promise. Say "out
  of pilot" and route to (d) when asked.
- **Climbing path:** run this S1 pilot on a bounded set of real candidate
  invariants, establish the baseline value, collect S2 evidence, and evaluate
  cost before expanding to harder concurrency forms or new engines.

## Primary metric — two-sided health signal with PREDECLARED falsifiers

The pilot's success criteria are **two-sided and predeclared BEFORE any pilot
run**. Both sides must be measured; either falsifier firing is a STOP/reshape.

### (a) VALUE side — does it CATCH real bugs an agent's prose reasoning missed?

Run this skill AND a prose-reasoning baseline on the SAME candidate invariant
set, then count **net-new defects caught** (defects the proof/binding surfaced
that the prose reasoning did not).

- **Falsifier:** green check counts rise but **no net-new bug is caught vs prose
  reasoning** → STOP/reshape. Check volume is not value.

### (b) COST side — does it stay cheap / not become ceremony?

Measure proof-authoring latency end-to-end (classification → authored proof →
fidelity binding → red-on-divergence test), excluding the optional engine check.

- **Falsifier:** proof-authoring latency dominates AND lanes start avoiding the
  skill → STOP/reshape.

Both falsifiers are **predeclared**. They are pilot procedure, NOT transition
authority — skill output still never gates, blocks, or transitions state (see
"Authority").

## Property-test prefilter

`prefilter: property-test | none` is an advisory field. Used correctly it cheaply
falsifies a candidate *before* the agent invests in proof-authoring. Rules:

- It is NEVER proof evidence and NEVER "the proof."
- Outputs are separately labelled (`property-test-prefilter`) and carry no
  doctor hook.
- A property test that passes does not promote a candidate toward `proven`; it
  only declines to falsify it cheaply.

## Reversibility / no helper (design condition 7)

This skill is **instruction-only for the pilot.** No frozen-boundary helper
ships: there is no bundled engine-provisioning tool (operator explicitly declined
one), and a manifest/accounting helper is not in scope for this pilot. If a
helper becomes genuinely necessary later — e.g. a deterministic proof-artifact
manifest or a fidelity-binding accounting tool — that is a SEPARATE slice with its
own frozen boundary, self-test, and reversal conditions. **Clean removal of this
skill leaves code untouched** (the only code-level artifact it motivates is the
red-on-divergence test, which lives with the code under test and is owned there).

## The seven design conditions (overlay-only S1 confirmation)

This pilot is bound by seven operator-confirmed conditions. Every run must
respect all seven:

1. **Authority containment** — outputs INFORM only; no auto-invocation; gate
   promotion is a separate decision that grants none; operator/offline
   provisioning only, never a networked build (see "Authority" and "Engine-invocation
   config").
2. **Fixed paradigm** — the agent authors the proof; the engine only checks.
   Lean4 for pure-logic/algebraic/simple state-machine; concurrent-protocol SAFETY invariants route to honest exit (TLAPS unsupported/deferred); TLC/model-checking excluded; property-test is advisory prefilter
   only (see "The Paradigm").
3. **No-engine design-time product** — the proof/spec, fidelity binding,
   classification, and red-on-divergence test are producible with no engine
   installed; the engine check is an optional confirmation (see "Capability
   property").
4. **Model-fidelity binding** — fidelity artifact + red-on-divergence test +
   distinct-union evidence; anti-laundering; engine check feeds the behavioral-
   closure crux only, never independently justifying code `proven` (see "THE CRUX").
5. **Never-blocks degradation** — no engine → `not-demonstrable`/`inconclusive`
   (MERGE); `proven` only when the engine ran + reviewed fidelity + red-on-
   divergence test (see "Degradation").
6. **Operator/offline engine config** — 4-level two-file field merge; pinned tags
   only; docker containment is container-side, not a new exec verb (see
   "Engine-invocation config").
7. **S2 containment** — S2/core is NOT authorized; the eight evidence classes are
   unmet pending a real pilot; instruction-only, no helper (see "S2 record" and
   "Reversibility / no helper").

## S2 record

S2/core promotion is NOT authorized by this skill. The eight S2 evidence classes
remain unmet until a real pilot runs and records positive evidence:

1. **Utility** — net-new defects caught vs prose reasoning (VALUE side).
2. **Cost** — proof-authoring latency remains bounded (COST side).
3. **Safety** — never blocks normal lanes; never gates.
4. **Maintenance** — red-on-divergence tests avoid flakiness.
5. **Determinism** — stable checker-engine results against pinned tags.
6. **Usability** — configuration is easily discoverable.
7. **Adoption** — voluntary selection by developers.
8. **Reversibility** — clean removal leaves code untouched.

This skill only AUTHORS the pilot; it does NOT run a full pilot and does NOT
score S2.

## Anti-over-claim rule (restated)

A proof of a model is not a proof of the code. "Proven/green" requires the engine
to have actually run AND the run to be bound to a reviewed fidelity claim AND the
red-on-divergence test to be present. Silent model drift, dropping the fidelity
binding, reporting a model proof as a code proof, and treating a green engine
check as code correctness are all FORBIDDEN. When the engine did not run, the
honest answer is `result: not-demonstrable` / `verdict: inconclusive` — never
`proven`, never a block.

## Number-evidence: observed, not traced

A verification claim that carries a NUMBER (a pass/fail count, a coverage
figure, a red-cell tally) must state an OBSERVED number with its method — the
flip applied, the test name run, the revert performed — not a TRACED number. A
trace is a reasoning artifact, not an observation, and it MUST state its scope:
a self-consistent trace at the WRONG SCOPE survives review and silently
substitutes for the observation that was never made.

Canonical instance — the exec-sandbox pilot (commit `95e2954`): an isolated
trace of `ApplyFloor` counted 3/9 red cells and passed review, but the real
caller invokes `ApplyFloor` twice; the observed flip gave 6/9. The trace was
self-consistent; its scope was wrong. State the method and the scope; cite the
observation, not the trace.

## References

- `references/pilot-runbook.md` — how to run a bounded slice and the two-sided
  A/B health measurement (VALUE: net-new bugs vs prose; COST: latency), including
  the property-test-prefilter-first step.
- `researches/decisions/2026-08-02-formal-verification-agent-proof-skill.md` —
  the signed-off design spec; the full crux; the supersession of the
  model-check-first draft.
- `.opencode/repo-configs/formal-verification-config.json` — the engine-invocation
  config schema (4-level two-file field merge; authored separately).
- `researches/decisions/2026-07-24-behavioral-closure-pilot.md` — the
  verdict/crux token the engine check FEEDS (never independently justifies
  `proven`).
- `researches/sources/2026-07-23-vh-solara-harness-adoption-field-report.md` —
  Pattern-1 (GREEN-TESTS / BROKEN-PRODUCT), the canonical crux example.
