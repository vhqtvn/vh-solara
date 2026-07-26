---
description: Promote one draft local coordination task into ready execution state
agent: build
subtask: false
---

Promote one draft local coordination task into ready execution state.

Task id:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- call `plan_state` with:
  - `operation: read_coordination_task`
  - `task_id: $ARGUMENTS`
- stop if the task is not `draft` or `ready`
- if the task only needs metadata edits while preserving its current lifecycle state, prefer `/task-update <id>` instead of overloading draft promotion
- if the task is `task_type: research` and is missing research-contract fields outside normal draft promotion, prefer `/task-repair <id>` when you need to repair the card without changing its lifecycle state
- extract or infer the execution-ready fields that are still missing:
  - `files_in_scope`
  - `success_criteria`
  - `validation_plan`
  - for `task_type: research`, also require any missing research-contract fields:
    - `research_question`
    - `source_policy`
    - optional `source_allowlist`
  - `desired_artifact_type`
  - `target_artifact_path`
  - optional updates to `constraints`, `non_goals`, `dependencies`, `owner_notes`, or `next_action`
  - optional `predicted_impact`: a one-line prediction of the slice's expected impact, captured here at ready-time (skip for routine slices)
- preserve refinement context such as `rough_scope`, `open_questions`, and `ready_criteria`; do not discard it just because the task is now ready
- author the F3 design-readiness envelope (`f3_design_readiness` field in `task_payload`) before calling `ready_coordination_task`. The envelope **INFORMS** the safety-layer validator — it does NOT itself decide or block BUILD-READY; the validator at the lifecycle mutation derives that verdict. Required structure (the canonical field names + closed vocabularies are exported from `.opencode/scripts/f3-design-readiness.js` as `F3_REQUIRED_FIELDS`, `F3_ADVERSARIAL_VERDICTS`, `F3_HAZARD_CLASSES`, `F3_SECONDARY_AUTHORITY_DISPOSITIONS`):
  - top-level `design_digest` binding the WHOLE envelope to the current design (the gate re-derives this digest from the design-bearing fields above and refuses staleness as `stale_design_digest`)
  - `ownership_hazards[]` — the explicit inventory of ownership hazards surveyed. `[]` (explicit-empty) is a valid pass ("author surveyed, named nothing") and is distinct from omitting the field (omission fails closed as `missing_envelope`). An explicit-empty envelope is STILL freshness-bound by `design_digest` — a design change invalidates the prior survey.
  - per named hazard: a declaration (`hazard_id`, `hazard_class: "ownership"`, `hazard_statement`, `affected_boundary`, `competing_authorities[]`, `failure_mode`, `source_records[]` with provenance) + a resolution (`authoritative_owner` — exactly one, `secondary_authority_disposition` ∈ {`removed`,`prohibited`,`delegated_to_authoritative_owner`}, `mechanism_mapping`, `evidence_records[]` with provenance, `design_digest`, `declared_by`/`declared_at`, `blocking_limitations[]`) + an adversarial review (`review_id`, `hazard_id`, `design_digest`, `reviewer_identity` structurally distinct from `declared_by`, `reviewer_provenance`, `counter_cases[]` ≥1, `evidence_checked[]`, `verdict` ∈ {`resolution_supported`,`refuted`,`inconclusive`} — only `resolution_supported` can contribute to a pass, `weakest_supported_claim`, `limitations[]`). The minimum counter-case shape: `counter_case_id`, `preconditions`, `competing_or_missing_event`, `expected_authoritative_owner`, `expected_state_or_outcome`, `forbidden_state_or_outcome`, `resolution_mapping`, `evidence_refs[]`.
  - obtain the adversarial review from a lane distinct from the resolution producer (e.g., `debate`, `ship-review`, or a fresh `researcher` dispatch); record the distinct `reviewer_identity` + `reviewer_provenance` honestly. String-inequality between `reviewer_identity` and `declared_by` is only nominal separation — state its limitation (genuine independence cannot be verified structurally).
  - fabricated evidence is prohibited: every `source_records[]` / `evidence_records[]` entry must carry real capture/verification provenance (a locator, a digest, or a verifiable reference). A model-synthesized artifact with no provenance is more dangerous than prose and fails the evidence clauses.
  - the gate verifies STRUCTURAL completeness, NOT design truth — state "structurally resolved for this design," never "proven solved."
  - an F1 synthesis or F2 rendering artifact is NOT an F3 substitute (F1/F2 INFORM design context; they cannot satisfy or override the F3 gate).
- call `plan_state` with:
  - `operation: ready_coordination_task`
  - `task_id: $ARGUMENTS`
  - `task_payload`: a JSON object containing any missing execution-ready fields, any missing research-contract fields for research tasks, any optional metadata updates, plus the `f3_design_readiness` envelope authored above
- stop if the resulting task still lacks a real file scope, success criteria, or validation plan
- stop if a research task still lacks `research_question`, `source_policy`, `desired_artifact_type`, or `target_artifact_path`

Return:
- task id and updated status
- files in scope
- missing research fields repaired, if any
- remaining open questions, if any
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
