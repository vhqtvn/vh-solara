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

## Motivation check (advisory, distinct property)

When the task was driven by a stated motivation, record whether that motivation
is now satisfied, in plain prose. This is advisory and is NEVER blended into the
behavioral-closure token or a combined "closure passed" verdict.

