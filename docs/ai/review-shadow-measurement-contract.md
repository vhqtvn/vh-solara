# Review shadow-measurement contract (pre-S2 measurement design)

Status: **measurement contract only — NO behavior change**. This document
predeclares the measurement design and promotion-rule SHAPE for the eventual
review-candidate shadow program (brief-1 Slices S2–S4; brief-2 Phase 3). It
changes no review execution, no reviewer seats, no aggregation, no gate
authority today. Implementation requires the upstream/core seam work named in
brief-2 (overlays cannot shadow `commit-reviewer` or `review-tiers.json`).

**Standing invariant for the entire shadow program: the incumbent A/B/C/D
panel remains the SOLE source of gate disposition.** Candidate output is
observational. It can never authorize, block, or alter a transition, and it
can never suppress or delay incumbent execution.

## 1. Per-review overlap record (fields every eligible review must log)

For each eligible review, captured for BOTH the incumbent panel (per leaf)
and the candidate topology (per leaf):

| Field | Meaning |
|---|---|
| `incumbent_verdict` / `candidate_verdict` | Final per-side verdict (approve / block / split) per leaf and aggregated. |
| `candidate_approval_where_incumbent_blocks_or_splits` | The critical divergence class: every case where the incumbent blocked or split but the candidate approved. Each such case is individually enumerated — never summarized as a count alone. |
| `candidate_only_findings` / `incumbent_only_findings` | Material findings raised by exactly one side, with the finding text. |
| `finding_class` | Class of each material finding (e.g. correctness, security, contract, tests, docs, style). |
| `semantic_stakes_class` | Deterministic semantic-stakes class of the reviewed change (per the S3 classifier design: protected-surface/transition-risk signals, NOT file/line size). Critical classes: security, data-integrity, public-contract, gate/permission, persistence/migration, concurrency. |
| `divergence_disposition` | For each divergent finding: `duplicate` (other side raised the same issue in other words) / `explained` (difference justified by topology design) / `true_miss` (one side missed a real issue). |
| `complement_or_risk_trigger` | Whether the candidate's complementary reviewer or escalation trigger fired, and which trigger. |
| `cost_and_latency` | Token cost and wall-clock latency for BOTH paths (incumbent leaves and candidate leaves), per review. |

A review is **eligible** for the shadow window iff both sides actually
completed (candidate failure makes the record ineligible-incomplete and is
itself logged — it must never affect the incumbent run).

## 2. Promotion-rule SHAPE (predeclared structure)

Numeric values are operator inputs (§3); the RULE STRUCTURE is fixed now,
before any result observation:

1. **Critical-class zero-unexplained-miss rule.** Zero unexplained
   candidate false approvals in the critical semantic-stakes classes
   (security, data-integrity, public-contract, gate/permission,
   persistence/migration, concurrency). Any unexplained critical miss
   freezes promotion and retains the incumbent route for that class.
   Explained divergences require an individually recorded adjudication.
2. **No aggregation masking.** Low-risk volume can never offset a critical
   miss. Every critical divergence is adjudicated individually; aggregate
   non-inferiority statistics are computed and reported PER class, never only
   overall.
3. **Efficiency requirement.** Measured safety parity alone is insufficient:
   the candidate must materially reduce cost and/or latency versus the
   incumbent path, measured from the §1 cost/latency fields.
4. **Class-limited promotion with conservative fallback.** Evidence may
   authorize only the semantic-stakes classes sufficiently represented in
   the shadow window. Unknown, mixed, protected, and under-evidenced classes
   always retain the full incumbent fallback.

## 3. Operator inputs — REQUIRED before any result observation

The following are **named placeholders, deliberately unset**. They MUST be
fixed by the operator and committed (schema/config receipt) BEFORE the first
shadow result is observed. A bound chosen after seeing results is void.

- `OVERALL_NON_INFERIORITY_BOUND` — numeric overall non-inferiority margin
  for block-recall (UNSET — operator input).
- `EVALUATION_WINDOW` — shadow window definition (start/end or minimum
  eligible-review count; UNSET — operator input).
- `CRITICAL_CLASS_MIN_SAMPLE` — minimum per-class eligible-review count for
  §2.4 class-limited promotion (UNSET — operator input).
- Candidate reviewer model identity location — supported gitignored local
  model-selection state (brief-2 ownership matrix row 1); must be recorded in
  the same predeclaration receipt.

**Must-predate-result-observation note:** the predeclaration receipt
(config/schema check proving these values existed before evaluation) is a
hard prerequisite for Slice 3D promotion. Expected block-recall effect before
measurement: **unknown by design** — the program measures non-inferiority,
it does not assume it.

## 4. What this contract does NOT authorize

- No reviewer seat removal, addition, or reordering.
- No candidate landing authority of any kind (fail-closed: malformed
  candidate output is recorded observationally and cannot affect incumbent
  execution or disposition).
- No size/file-count-based routing (semantic-stakes classes only, and only
  observationally until promotion).
- No change to the committer-exclusive git gate or the
  model-output-is-candidate invariant.

## Verification hooks (for S2 implementation, not now)

Every eligible review carries a complete overlap record; candidate output
cannot authorize a transition (authority probes); critical-class divergences
are individually inspectable; cost/latency recorded for both paths; the
predeclaration receipt predates the first observed result.
