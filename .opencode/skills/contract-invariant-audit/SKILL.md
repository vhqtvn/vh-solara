---
name: contract-invariant-audit
description: Proactive contract/invariant audit of a declared existing surface across repository history (not the current diff). Use when auditing for latent contract/invariant defects, a disposition-complete ledger, or a milestone audit.
compatibility: opencode
---

# Contract / Invariant Audit (overlay-only S1 pilot)

This skill reproduces a proactive audit **procedure**: it examines a declared
existing surface — potentially dormant, unchanged, or spanning cross-file and
historical boundaries — for latent contract or invariant defects, and produces
a disposition-complete audit ledger whose surviving findings have passed an
adversarial verify/refute step.

It is **distinct from commit-review**, which is reactive, current-diff-scoped,
and already strong at recognizing contract drift introduced by a proposed
change. This skill's distinct value is examining surfaces a current changed-file
review cannot see. That distinctness is the pilot's success criterion (see
"Primary metric" below).

**S1 overlay pilot.** This is an experimental overlay skill. Core promotion is
NOT authorized. The eight S2 evidence classes are unmet until a real pilot runs
(see "S2 record"). Nothing here enters `templates/core/`.

## Authority — INFORMS ONLY (design condition 1)

> Every output of this audit **INFORMS**. It never gates, blocks, approves,
> promotes, releases, or transitions state on its own.

This applies to findings, completeness reports, manifest-helper results, final
ledgers, standing checks, remediation briefs, and rigor-check conclusions.

- No automatic invocation on edits, commits, doctor, release, or update.
- Audit output NEVER triggers a stop or gate.
- Standing checks may be presented as ordinary reports or as
  **doctor-WARN-shaped advisory diagnostics** — never as a doctor failure or a
  protected-transition denial.
- A completeness report proves accounting only; it does not prove semantic
  correctness or review quality.

**Critic's blocker (load-bearing):** the helper and the standing checks MUST
NOT be wired into any commit, release, doctor, or update path. Advisory outputs
only. Promoting any specific invariant to a hard gate is a SEPARATE decision
that must identify the protected transition, the deterministic predicate,
ownership of the validator, false-positive and recovery behavior, and explicit
authority to gate. **This audit grants no such authority.**

## When to use

- Auditing an existing bounded surface for latent contract or invariant defects.
- Producing a disposition-complete invariant ledger across a declared manifest.
- Conducting a milestone audit across unchanged or cross-history code.
- Investigating implicit, cross-unit, or inconsistently enforced contracts.

## When NOT to use

- Reviewing a current commit or changed-file slice — use commit-review instead.
- Ordinary bug diagnosis.
- Ordinary complexity triage.
- Proving test or semantic coverage.
- Establishing a new hard gate.

## The five violation classes (C1–C5)

The audit uses five language- and stack-agnostic classes. They do not name any
language construct, layer, framework, or domain unit.

### C1. Redundant or derived state

State is independently stored, copied, or mutated even though it can be derived
from another authoritative value. Risk: divergence between competing
representations; stale caches or mirrors without an explicit consistency
contract; multiple sources of truth; update ordering that can leave
inconsistent state. This class does not condemn caching or denormalization by
itself — a candidate exists only when the derivation, authority, invalidation,
or reconciliation contract is missing or unreliable.

### C2. Hidden side effects

An operation performs externally observable work that is not apparent from its
name, interface, documented contract, or expected abstraction. Risk: callers
cannot reason locally about consequences; read-looking operations mutate state;
lifecycle, persistence, network, process, or global-state effects are obscured;
testing and rollback assumptions become unreliable.

### C3. Unenforced invariants

A required relationship or state constraint is assumed by code or documentation
but has no reliable enforcing mechanism at the relevant transition. Risk: invalid
states remain representable or reachable; enforcement occurs only in some paths;
checks happen after effects have already occurred; convention is mistaken for
enforcement.

### C4. Unstated preconditions

Correctness depends on caller state, ordering, environment, initialization,
prior validation, or input properties that are not made explicit or mechanically
discoverable. Risk: valid-looking calls fail only under particular sequences;
reusable components carry hidden environmental assumptions; error handling occurs
too late to identify the violated precondition.

### C5. Leaky or misnamed contracts

An interface, name, type, boundary, or documented promise implies a narrower,
stronger, or different behavior than the implementation provides. Risk: callers
build incorrect mental models; internal details leak across boundaries; ownership
or lifecycle is ambiguous; nominally equivalent operations carry materially
different semantics.

## The five-phase pipeline

### Phase 1 — Generate the declared manifest

Produce a stable, reproducible inventory of every unit in the audit's declared
scope (see "Manifest-generator contract"). Minimum manifest record fields:
`unit_id`, `locator`, `unit_type`, `source_anchor`, `discovery_adapter`,
`inclusion_basis`, `enumeration_evidence`, `exclusion_reason`, `shard_id`,
`coverage_tier`. The manifest generator enumerates units — it does not decide
whether a unit is correct or assign a violation class. Use the bundled helper
(`scripts/manifest-helper.js`) for deterministic enumeration and accounting.

### Phase 2 — Assign a per-unit disposition

Every manifested unit must receive exactly one terminal disposition (see
"Per-unit dispositions").

### Phase 3 — Apply the internal completeness check

Before reporting disposition completeness: every manifest unit must have exactly
one disposition; every disposition must reference a known manifest unit;
duplicate unit IDs are rejected; no shard remains unreconciled; all exclusions
are explicit; missing or unexpected units are surfaced; the snapshot anchor must
still match or be explicitly reconciled. This is an internal workflow completion
condition, NOT a repository gate, and it does not prove semantic quality. The
helper's `complete` command performs this accounting deterministically.

### Phase 4 — Adversarially verify or refute candidates

Every candidate intended for the final ledger must undergo a distinct challenge
pass: (1) reconstruct the claimed contract or invariant; (2) locate supporting
evidence; (3) attempt a valid counterexample; (4) search for an existing enforcer,
normalization path, documented exception, or ownership rule; (5) trace relevant
reads, writes, transitions, and preconditions; (6) assess whether observed
behavior contradicts the actual contract rather than an assumed ideal; (7) assign
`verified`, `refuted`, or `indeterminate`; (8) state what new evidence would
reverse or resolve the result. A salient observation cannot enter the verified
ledger merely because it sounds plausible.

### Phase 5 — Publish the audit outputs

Publish the final ranked ledger, the complete manifest and disposition
accounting, advisory standing checks, a remediation brief, the independent
rigor-check record, and scope/cost/coverage-tier/uncertainty declarations.
"No verified violations" is an acceptable outcome.

## Per-unit terminal dispositions

Every manifested unit receives exactly one terminal disposition:

- `clean` — no supported violation survived the primary examination; does not
  prove absolute correctness.
- `candidate_violation` — must name at least one of C1–C5 and provide a precise
  claim and locator.
- `not_applicable` — requires a reason.
- `blocked_by_missing_evidence` — terminal for accounting but MUST NEVER be
  counted as clean.
- `excluded_by_contract` — requires a declared exclusion rule and reason.

Rules: bulk-defaulting units to `clean`, `not_applicable`, or excluded without
unit-level evidence is prohibited.

## Manifest-generator contract

The method uses a **pluggable unit-discovery interface** — it never embeds
language or stack knowledge.

A **discovery adapter** accepts an anchored scope and explicit configuration,
enumerates units deterministically, assigns stable IDs and locators, records how
each unit was discovered, declares its supported granularity, exposes exclusions
and unsupported surfaces, reports its claimed coverage tier, and avoids semantic
violation judgments. The helper forwards the anchored scope to a configured
adapter as JSON on the adapter's stdin (`snapshot_anchor`, roots, exclude,
granularity); a conformant adapter enumerates at that anchor and emits its unit
list as JSON on stdout, so the manifest's `source_anchor` describes the snapshot
the adapter actually enumerated. A localized adapter may use any project-native
index, extractor, or inventory to enumerate its declared units; the core
methodology defines the interface, never the implementation. Adapters live in
the pilot overlay or consuming
project until their generality and stability are established; core methodology
defines the interface, not the stack implementation.

**Domain-free fallback (the helper default):** when no semantic adapter exists,
the fallback enumerates the anchor snapshot's tracked-file inventory
(`git ls-tree -r --name-only <anchor>` filtered by roots/exclusions), so the
discovered units are consistent with the recorded `source_anchor` (the inventory
and the anchor come from the same commit). Operators may also supply explicit
include/exclude patterns and operator-declared contract units. The fallback MUST
record its limitations and normally claims `declared-inventory`, NOT
`adapter-complete`. An anchored manifest requires a resolvable anchor — the
helper rejects an unresolvable ref rather than silently emitting the live index
under a stale anchor.

> **Fallback limit (explicit):** a file manifest may be complete as a file
> inventory while remaining incomplete as a declaration, transition, or
> cross-unit contract inventory. `declared-inventory` is NOT semantic-unit
> enumeration. That distinction must remain explicit in every run.

**Coverage tiers:**

- `adapter-complete` — the adapter deterministically enumerated every supported
  unit of its declared unit model within the anchored scope, with unsupported
  surfaces and exclusions disclosed.
- `declared-inventory` — every unit emitted by the declared sources and rules
  has been accounted for, but the rules are not known to enumerate every
  semantic unit.
- `sample` — only an explicitly selected subset was examined.

No tier establishes semantic correctness.

## Outputs (concise)

Four output families; the decision brief carries the full column schemas — do
not bloat the ledger with columns the brief already defines.

- **Ranked ledger** — verified/indeterminate findings with violation class,
  contract claim, adversarial result, evidence, confidence, impact, risk rank,
  cheapest recheck, and recommended disposition. Refuted candidates stay in the
  rigor record only.
- **Standing-check record** — reusable observation recipes; `authority` is always
  `advisory`; presentation is report or doctor-WARN-shaped only.
- **Remediation brief** — finding IDs, desired contract, affected units, smallest
  coherent slice, alternatives, compatibility, suggested verification, residual
  risk, non-goals. Must not claim remediation is implemented.
- **Rigor-check record** — second-opinion pass over audit quality (see below).

## Primary metric — distinctness A/B (operator-sharpened, design condition 2)

The pilot's success criterion is the **distinctness A/B test**: run this audit
AND commit-review on the SAME slice, then measure net-new findings — specifically
violations in code NOT touched by recent commits (the structural blind spot
per-commit review cannot see).

For each surviving finding, classify it as one of: `duplicate-of-commit-review`,
`net-new-in-untouched-code`, or `indeterminate`. Record the rates.

**Falsifier:** if the audit only restates commit-review findings, the
differentiation hypothesis FAILS → STOP/reshape. Candidate volume is not a
success metric; a run with no verified findings is valid.

## Stop/reshape + rigor sampling (pilot procedure, NOT enforcement)

**Stop or reshape the audit if** any of these hold (design condition 6 —
documented as pilot procedure, never as an enforced gate):

1. candidate volume is high but verified-survivor yield is low;
2. the rigor-check repeatedly restores wrongly rejected candidates;
3. most survivors duplicate commit-review findings;
4. the fallback requires undisclosed semantic assumptions;
5. unit IDs or anchors are unstable;
6. exclusions grow without clear reasons;
7. the cost of disposition dominates the resulting evidence;
8. completion requires silently treating unknown units as clean.

**Rigor-check (the independent second opinion):** sample a set of downgraded,
refuted, or killed candidates (record method and size), reconstruct each rejected
claim, and agree or disagree with the original disposition; restore any wrongly
killed candidate for verification; AND probe ONE latent violation class that may
have been under-sampled. The rigor-check does not guarantee absence of unsampled
defects — it measures whether the primary pass disposes of candidates
responsibly and whether a class appears systematically neglected.

## Reversibility (design condition 5)

If unit enumeration requires semantic judgment the fallback cannot supply
deterministically, **reverse to an instruction-only overlay skill**. The helper
MUST accept operator/adapter-supplied cross-unit units verbatim (via
`manifest --units <file>`) and MUST NEVER infer them. If the helper would have to
make a semantic decision to enumerate a unit, that is the reversal signal.

## The seven design conditions (overlay-only S1 confirmation)

This pilot is bound by seven confirm-with-conditions from the design debate.
Every run must respect all seven:

1. **Authority containment** — outputs INFORM only; no auto-invocation; gate
   promotion is a separate decision (see "Authority").
2. **Distinctness primary metric** — the A/B test against commit-review is the
   success criterion; the falsifier requires the operator to stop or reshape the
   pilot procedure (see "Primary metric"). This is pilot procedure, not
   transition authority — audit output still never gates, blocks, or transitions
   state (see "Authority").
3. **Frozen helper boundary** — the helper is discovery/accounting only; no
   semantic evaluation, no C1–C5 assignment, no ranking (see helper header).
4. **Determinism** — identical inputs produce byte-identical manifest IDs and
   order; the helper ships a `--self-test` that proves this.
5. **Reversibility** — reverse to instruction-only if enumeration needs semantic
   judgment; the helper never infers cross-unit units (see "Reversibility").
6. **Stop/reshape + rigor sampling as procedure** — documented conditions, not an
   enforced gate (see above).
7. **S2 containment** — S2/core is NOT authorized; the eight evidence classes are
   unmet pending a real pilot (see "S2 record").

## S2 record

S2/core promotion is NOT authorized by this skill. The eight S2 evidence classes
remain unmet until a real pilot runs and records positive evidence: real repeated
trigger, manifest reproducibility, disposition completeness, semantic precision,
net-new value, cost evidence, failure-mode evidence, and authority containment.
This skill only AUTHORS the pilot; it does NOT run a full pilot and does NOT
score S2.

## Anti-coverage-theater rule

Manifest completeness is mandatory and must be demonstrated, never asserted. It
proves accounting only for the declared unit model and anchored scope. A run may
use the label "full-surface" only when the surface is declared, the unit model is
stated, enumeration evidence is reproducible, unsupported surfaces are disclosed,
exclusions are explicit and justified, all shards reconcile, the snapshot remains
valid or is explicitly reconciled, every manifested unit has exactly one terminal
disposition, and the coverage tier supports the claim. Even then, "full-surface"
means complete enumeration under the declared unit model — not that all semantic
contracts were discovered or that every verdict is correct. Silent sampling,
silent budget truncation, undisclosed exclusions, and extrapolating semantic
certainty from unit count are prohibited.

## Helper

`scripts/manifest-helper.js` — deterministic discovery/accounting (Node stdlib
only, no network). FROZEN BOUNDARY: discovery and accounting only.

- `manifest --roots <globs> --exclude <globs> [--adapter '<cmd>'] [--anchor <ref>] [--granularity <name>] [--units <file>] --out <file>`
- `complete --manifest <file> --dispositions <file>` — exit 0 on complete, 2 on
  malformed accounting (a `candidate_violation` disposition is NOT a failure).
- `--self-test` — hermetic discover→manifest→complete exercise proving
  determinism and completeness accounting.

Run via `vh-agent-harness exec node .opencode/skills/contract-invariant-audit/scripts/manifest-helper.js ...`.

## References

- `references/pilot-runbook.md` — how to run a bounded slice and the A/B
  distinctness test.
- `researches/decisions/2026-07-29-contract-invariant-audit-capability.md` — the
  signed-off design spec; full output column schemas; reversal conditions.
