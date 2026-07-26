---
description: Approve a saved draft into the current session plan namespace
agent: build
subtask: true
---

Approve this draft slug into the current session plan namespace:
$ARGUMENTS

- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.

Before approving, author the F3 design-readiness envelope into the draft plan's frontmatter as a `f3_design_readiness` key (a JSON-stringified envelope). The same envelope shape + authority discipline described in `/task-ready` applies. The envelope **INFORMS** the safety-layer gate — it does NOT itself decide or block BUILD-READY; the validator at the lifecycle mutation derives that verdict. Required elements:

- top-level `design_digest` binding the WHOLE envelope to the current design (the gate re-derives this digest from the frontmatter-stripped plan body and refuses staleness as `stale_design_digest`)
- `ownership_hazards[]` — the explicit inventory; `[]` (explicit-empty) passes as "author surveyed, named nothing" and is distinct from omitting the field (omission fails closed as `missing_envelope`). Explicit-empty is STILL freshness-bound by `design_digest`.
- per named hazard: declaration + resolution (exactly one `authoritative_owner`, every secondary authority disposed) + adversarial review. Only `verdict: resolution_supported` contributes to a pass; `refuted` and `inconclusive` fail closed.
- the canonical field names + closed vocabularies are exported from `.opencode/scripts/f3-design-readiness.js` (`F3_REQUIRED_FIELDS`, `F3_ADVERSARIAL_VERDICTS`, `F3_HAZARD_CLASSES`, `F3_SECONDARY_AUTHORITY_DISPOSITIONS`).
- fabricated evidence prohibited; the adversarial review must come from a lane distinct from the resolution producer; the gate verifies STRUCTURAL completeness, NOT design truth; F1/F2 artifacts are NOT F3 substitutes.

Use the `plan_state` tool with:
- `operation`: `approve_draft`
- `slug`: `$ARGUMENTS`

If the tool fails (including an F3 refusal with a reason code), stop and relay the failure briefly.

Return:
- the approved plan id
- the draft path that was approved
- the active session name
- whether `/implement` can use it immediately or whether `/adopt-plan <id>` is still recommended

For git operations, follow `.opencode/docs/git-execution-routing.md`.
