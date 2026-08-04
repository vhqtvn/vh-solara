# Coordination Closeout Template

Use this when a coordination-heavy task finishes.

```text
Return:
1. Primary lane and specialist used
2. Files changed
3. Durable docs updated
4. Backlog / checkpoint status updated
5. Validation results
6. Remaining blockers or open questions
7. Recommended next prompt
```

## Behavioral closure (only when a load-bearing path was touched)

When the task touched a load-bearing path (a codepath whose end-to-end execution
is the actual proof the behavior works), include a `behavioral-closure`
declaration so the closeout is honest and non-droppable. Omit it for routine
slices that touch no such path.

````text
```behavioral-closure
verdict: proven              # proven | inconclusive | failed | abandoned
path: <load-bearing path>    # the codepath whose execution proves the behavior
verifier: <test/command>     # the named seam that exercises it
command: <the command>       # the exact command that exercises it
result: proven               # proven | skipped | not-demonstrable (the crux outcome)
```
````

- `verdict: proven` is honest only when the crux `result: proven`. Otherwise the
  verdict MUST be inconclusive, failed, or abandoned.
- The declaration is a declaration, not a proof: a consistent token does not
  prove the path executed — that needs the repo-specific live verification.
- Verifier-infeasible: if the verified seam cannot observe the load-bearing
  outcome (fixture too small, no prior surface, no real scale, no render),
  declare `result: not-demonstrable` → `verdict: inconclusive`. This blocks a
  `completed` closeout and routes to defer — never record the infeasibility as
  silent prose, and never claim `proven` for an outcome the seam could not
  observe.
- Outcome vs mechanism: for a user-visible behavior, `proven` must cite an
  OUTCOME observation (the behavior occurred), not a MECHANISM assertion (a
  flag is set, a record exists, a code path ran). Mechanism-without-outcome is
  `result: skipped`, not `proven`.

## Success-report integrity (verification claims)

"Green" is ambiguous. When a closeout claims verification, distinguish three
SEPARATE senses and never let one stand in for another. These are the F4
assurance/integrity-stewardship properties (A, B1, B2); each can pass or fail
independently.

| Sense | Means | Fails when |
|-------|-------|------------|
| **B1 — full verification** | the canonical full command set actually ran successfully AND the result is bound to the assessed revision/tree | a command was skipped, failed, or cannot be bound to the assessed state; a targeted/smoke run is summarized as full |
| **targeted / smoke** | only a subset ran (e.g. a single `-run` filter, one package, a smoke probe) | (not a failure by itself — it is a failure only if labeled or implied to be full) |
| **B2 — clean transition state** | the working-tree / transition state matches what was reviewed | uncommitted or untracked bytes make the verified state differ from the state being released |

Rules:

- **Targeted or smoke commands must be labeled targeted or smoke.** They must
  never be summarized as full green. If full execution cannot be observed or
  bound to the assessed state, the result is `inconclusive` or
  `not-demonstrable`, not green.
- **B1 and B2 are separate controls.** All canonical commands passing (B1) does
  not imply a clean tree (B2), and a clean tree (B2) does not imply the build
  passed (B1). State both independently.
- **Cleanliness is transition-relative.**
  - **Release / tag transitions require global cleanliness** — the tagged
    commit must be exactly what was verified (release G0b refuses a dirty
    worktree).
  - **Ordinary commit-gate integrity is exact-slice based** and MUST tolerate
    unrelated concurrent dirt. The committed tree for the authorized slice
    equals the reviewed/approved tree for that slice; unrelated concurrent
    working-tree changes are normal and must NOT be erased, reverted, or
    blocked to obtain a cosmetically clean status. Do not require a global
    clean tree at the commit boundary.
- **Declared-scope coverage (F4-A) is structural.** Every item in the declared
  scope should receive a terminal disposition (examined or excluded by
  contract). "Reviewed" or "complete" must not be claimed when a declared item
  lacks a disposition. Structural coverage proves only that each declared item
  was accounted for — never that it was meaningfully examined.

The `behavioral-closure` token (above) is a declaration of crux consistency,
not proof that the cited path executed. It is distinct from B1: a consistent
token does not prove the canonical command ran, and a full-green run does not
prove the load-bearing crux path was the one exercised.

## Motivation check (advisory, distinct property)

When the task was driven by a stated motivation, record whether that motivation
is now satisfied, in plain prose. This is advisory and is NEVER blended into the
behavioral-closure token or a combined "closure passed" verdict.

