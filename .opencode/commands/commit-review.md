---
description: Final read-only review of a scoped change slice using a required explicit file list
agent: commit-reviewer
subtask: true
---

Perform a final review of a specific change slice.

Review target:
$ARGUMENTS

Required input shape:
- feature summary
- exact file list
- optional primary lane
- default file-count cap: 8 files
- optional file-cap override with explicit reason when a broader slice is
  intentional
- optional known dependencies or relevant repo rules/docs
- optional review mode: `merge-ready` (default), `security-focused`, `docs-only`, `coordination-synthesis`, `runtime-policy`, `eval-promotion`, `frontend-ui`, or `degraded-single-review`
- optional non-goals
- optional validation already run

If the request does not include both a feature summary and an explicit file
list, stop and say that both are required for `/commit-review`.

If the file list appears to exceed 8 paths and the request does not explicitly
state that the cap is being overridden, stop and say that `/commit-review`
defaults to 8 files unless the caller provides an explicit override and a short
reason.

If review mode is omitted, assume `merge-ready` and state that assumption in the
review output.

If primary lane is omitted, infer the most likely lane from the file list and
state that assumption in the review output.

> **Lightweight review**: If all changed files match the `lightweight_review`
> globs in `review-tiers.json`, the cascade automatically reduces to a single
> free-tier leaf. No special flag is needed.

## Orchestrator contract

The `commit-reviewer` agent is a tiered cascade commit reviewer. It will:
1. Load tier configuration from `.opencode/config/review-tiers.json`.
2. Obtain the active task contract via the `plan_state` MCP tool
   (`operation: current_session` then `operation: read_task_contract,
   include_body: true`) BEFORE invoking any tier, so it can be forwarded as the
   Spec-axis input to every leaf. When no session is bound, it forwards
   `task_contract: null` and the leaves evaluate the Standards axis only
   (no-contract fallback, graceful).
3. For each active tier, invoke its leaf reviewers in parallel.
4. Pass the full review context (feature summary, file list, inspection
   commands below, lane defaults, the task contract from step 2, and all
   user-provided context) to all leaves in each tier.
5. Mechanically aggregate leaf results using strict consensus within each tier,
   then combine across tiers with fail-fast escalation.

The orchestrator does NOT perform independent review. It only invokes leaves
and aggregates. All leaves within a tier receive the same review instructions.

## Inspection scaffold (for orchestrator reference only)

Inspect:
!`git status --short`
!`git diff --cached --stat`
!`git diff --cached -- . ':(exclude)package-lock.json'`

Note: The diff expansion above is for the orchestrator's own reference to understand the change scope. The orchestrator must NOT inline the expanded diff into leaf task parameters — pass the tree_hash instead so leaves can read the diff via `git diff HEAD <tree_hash>`.

## Review rules (forwarded to leaves)

- act as an independent auditor, not a collaborator defending the current patch
- review the named files first and stay scoped to them
- honor the nearest relevant `AGENTS.md`, the lane defaults in
  `docs/coordination/LANES.yaml`, and any path-scoped guidance that clearly
  matches the declared file set
- only expand outside the list when a listed file clearly depends on another
  path, and call that dependency out explicitly
- treat parallel-agent ownership as intentional; do not criticize missing work
  outside the declared file set unless it blocks correctness of the reviewed
  slice
- do not assume omitted work is intentional unless it is declared in non-goals
- use the current git diff as context, but do not let unrelated dirty files
  dominate the review
- ignore style, lint, and minor naming preferences unless they hide a
  correctness, maintainability, or boundary risk
- prioritize regressions, boundary violations, runtime drift, contract drift,
  missing tests, risky fallback behavior, and misleading claims over cosmetic
  issues
- if a file-cap override was explicitly requested, acknowledge it and keep the
  review organized by the declared file set instead of drifting into whole-branch
  review

Review for:
- boundary discipline
- unnecessary scope creep inside the declared file set
- missing tests
- manifest/runtime drift
- cross-layer aggregation contract / evidence-role drift
- evaluation overclaiming
- docs/backlog drift
- risky fallback behavior
- naming or semantic ambiguity
- cross-file dependencies that the declared slice may have missed

## Output contract

The orchestrator will emit a single aggregated JSON code block using
`commit-review-result.v2` schema with `tiers_executed`, `tiers_skipped`, and
`leaf_results` sub-object (keyed by tier+leaf letter, e.g. `tier1_b`), followed by a
brief human-readable summary covering:
- Overall verdict and confidence
- Tiers executed and their individual verdicts
- Key blocking issues (if any)
- Notable followups
- Whether leaves within each tier agreed or disagreed

After receiving the orchestrator result, the caller should:
- On **approve**: proceed to `git commit`
- On **blocked**: fix blocking issues and re-run `/commit-review`
- On **split**: split the change into separate commits and re-review each

Suggested request shape:

```text
/commit-review
Feature summary:
- ...

Primary lane:
- api

Exact file list:
- path/a
- path/b

File-cap override:
- no

Known dependencies or relevant repo rules/docs:
- ...

Review mode:
- merge-ready

Non-goals:
- ...

Validation already run:
- ...
```
