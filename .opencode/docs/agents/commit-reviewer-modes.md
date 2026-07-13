# Commit Reviewer Modes

The `review_mode` field in `commit-review-result.v2` is a taxonomy/context label. It does not change review behavior. It is set by the caller (not auto-detected) and forwarded through the orchestrator to all leaves across all active tiers.

## Valid modes

| Mode | Meaning |
|------|---------|
| `merge-ready` | Default. Standard merge-readiness review. |
| `security-focused` | Emphasis on security-sensitive surfaces (auth, secrets, input validation, trust boundaries). |
| `docs-only` | The declared change is documentation-only. Review focuses on accuracy, drift, and placement. |
| `coordination-synthesis` | Cross-boundary coordination or synthesis review (handoffs, task cards, multi-session state). |
| `runtime-policy` | Runtime behavior, routing, manifest, or policy changes (e.g. a project's component registry, execution plans, service wiring). |
| `eval-promotion` | Evaluation, benchmark, or model/component promotion-or-rollback changes. |
| `frontend-ui` | Frontend/UI changes (web app, components, styles, browser behavior). |
| `degraded-single-review` | Reserved mode. No behavioral difference from other modes in the current implementation. Documented for future use. |

## Rules

- The field is taxonomy/context only. Do not change review behavior solely because of `review_mode`.
- Do not infer or auto-detect a mode. Set it only if the caller provides one.
- If no mode is provided, use `merge-ready`.
- The orchestrator forwards `review_mode` to all leaves across all active tiers. If leaves disagree on the value, the orchestrator treats this as malformed and blocks.

### Lightweight review

When all changed files match the `lightweight_review.doc_globs` patterns in
`review-tiers.json`, the cascade is replaced by a single-leaf review from the
first active tier. This is not a separate `review_mode` — it is triggered
automatically by the file path analysis in Step 0 of the cascade.

## Validation

If a caller-provided `review_mode` is not one of the eight valid values listed above, both the orchestrator and the leaves must:

1. Default to `"merge-ready"`.
2. Record the unrecognized value in `validation_notes` so the operator is aware.
3. Proceed with the review using the default mode.
