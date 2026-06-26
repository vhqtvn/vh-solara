---
description: Final read-only review of the full current change before merge-worthy changes
agent: ship-review
subtask: true
---

Perform a final review of the full current change.

Review target:
$ARGUMENTS

Inspect:
!`git status --short`
!`git diff --stat`
!`git diff -- . ':(exclude)package-lock.json'`

Review for:
- boundary discipline
- unnecessary scope creep
- missing tests
- manifest/runtime drift
- cross-layer aggregation contract / evidence-role drift
- evaluation overclaiming
- docs/backlog drift
- risky fallback behavior
- naming or semantic ambiguity

## Return-Type Contract Check
If the diff modifies function return types, extracts helpers, or changes callable signatures:
- List every caller of the modified function
- Verify each caller is compatible with the new return type
- If callers would break, flag as a finding

## Refactor Validation
When proposing a code transformation (helper extraction, rename, signature change):
- Run the relevant test suite against the proposed change
- If no tests cover the code being refactored, flag as a finding
- Recommend adding tests before applying the refactor

Required output:
1. what looks good
2. blocking issues
3. non-blocking issues
4. exact files to revisit
5. overall review confidence: high / medium / low
6. overall risk level: low / medium / high
7. merge recommendation: APPROVE / NEEDS CHANGES
