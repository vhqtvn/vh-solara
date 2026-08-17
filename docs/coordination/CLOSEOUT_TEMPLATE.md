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
- Verifier-infeasible: when the verified seam cannot observe the load-bearing
  outcome (the fixture is too small, there is no prior surface, no real scale,
  or no render available), declare `result: not-demonstrable` (NOT `proven`) →
  `verdict: inconclusive`. The honest authoring workflow routes such a crux to
  defer rather than `completed` — an honesty requirement enforced by author +
  reviewer, NOT a mechanical refusal at the `saveCoordinationTaskCloseout`
  transition (which parses `rewrite-parity` only, never `behavioral-closure`).
  `vh-agent-harness doctor` separately audits saved declarations for internal
  consistency and marks the repo UNHEALTHY on inconsistent ones (FAIL →
  non-zero exit → blocks release G0c). Never record the infeasibility as silent
  prose, and never claim `proven` for an outcome the seam could not observe.
- Outcome vs mechanism: for a user-visible behavior, `proven` must cite an
  OUTCOME observation (the behavior occurred), not a MECHANISM assertion (a
  flag is set, a record exists, a code path ran). Mechanism-without-outcome is
  `result: skipped`, not `proven`.
- Reachability over object existence (for "did this land" cruxes): a crux
  verifier asserting a commit landed MUST assert REACHABILITY — e.g.
  `git merge-base --is-ancestor <sha> <branch>` or
  `git log <branch> --oneline | grep <sha>` — NOT object existence
  (`git show <sha>`, `git cat-file`). `git show` succeeds for an orphaned /
  reflog-only commit, so an object-existence verifier cannot distinguish
  "committed and landed" from "committed and reverted/reset".
- Interaction-reachability (interaction-touching changes): when the
  load-bearing path is a **user-interaction path** — correctness depends on a
  real user action reaching the handler in the real runtime, NOT a direct API
  call that bypasses the event model — the crux MUST carry an
  **interaction-reachability receipt** in addition to the command receipt
  above. This is the runtime-blindspot class (e.g. a cross-origin iframe
  swallows host events; the API test passes; the real user event never
  arrives). See AGENTS.md → "Behavioral closure" → "Interaction-reachability
  receipt" for the five governing conditions. The receipt fields live INSIDE
  the same `behavioral-closure` block (additive to the crux above), using an
  `interaction_` prefix to avoid collision with the existing `verifier`/
  `command`/`result` fields:

  ````text
  # added inside the ```behavioral-closure block when interaction_touching: true
  interaction_touching: true
  interaction_action: <real gesture/input — not a programmatic stand-in>
  interaction_target: <behavior the action is meant to trigger>
  interaction_environment: <real runtime — NOT a mocked/jsdom/headless stand-in>
  interaction_verifier: <command that exercises the REAL event path>
  interaction_outcome: <user-visible outcome a human would see>
  interaction_tree: <git sha / revision>
  interaction_evidence: outcome | mechanism
  ````
  - An API-call-returned / flag-set / code-path-ran receipt is MECHANISM, not
    OUTCOME → `interaction_evidence: mechanism` paired with `result: proven`
    is REJECTED by the gate; downgrade to `result: skipped`, never `proven`,
    unless the user-visible outcome was actually observed in the real
    environment (`interaction_evidence: outcome`).
  - A passing receipt is "structural completeness only," NEVER "reachability
    proven" — the gate verifies presence/consistency, not that the event
    reached the handler.
  - A reviewer (or the advisory `interaction-reachability` skill, when named)
    may DEFER a shallow/inconsistent/non-falsifiable receipt; this is ADVISORY
    ONLY — no BLOCK, approval, or unblock authority.
  - **Enforcement surface:** the `vh-agent-harness doctor` health check (check
    #14, `behavioral-closure`) scans durable closeout artifacts for the receipt
    and FAILs when `interaction_touching: true` is declared but the receipt is
    missing/incomplete, or when `interaction_evidence: mechanism` is paired
    with `result: proven`. This is structural enforcement, NOT advisory — a
    doctor FAIL blocks release and flags the repo UNHEALTHY. (The
    closeout-transition gate `saveCoordinationTaskCloseout` does NOT parse
    `behavioral-closure`; it enforces only the opt-in `rewrite-parity` Stage-2
    contract. The behavioral-closure honesty model — including the
    interaction-reachability receipt — lives entirely in the doctor audit.)
  - When no verified seam can observe the outcome in the real environment →
    `result: not-demonstrable` → `verdict: inconclusive` → the doctor check
    accepts the honest declaration, and the closeout routes to defer rather
    than `completed`.

## Rewrite-parity contract (only for explicitly-declared deletion/rewrite slices)

When the task was an explicitly-declared deletion or rewrite slice — the task
contract carried `mode: deletion_replacement` or `mode: modification_only_rewrite`
— include a `rewrite-parity` contract so the closeout is honest and non-
droppable about behavioral parity across the rewrite. Omit it for ordinary
deletes, refactors, renames, or any slice that was not a declared rewrite-parity
slice (the gate is opt-in and carries zero burden on ordinary work).

````text
```rewrite-parity
{
  "version": 1,
  "applies": "<what this contract governs>",
  "mode": "deletion_replacement",
  "prior_surface": {
    "id": "<component id>",
    "revision": "<git sha the prior surface was inventoried against>",
    "paths": ["<repo-relative path>"],
    "inventory_complete": true
  },
  "behaviors": [
    {
      "id": "<behavior id>",
      "description": "<behavior that must be preserved across the rewrite>",
      "prior_evidence": ["<locator into the prior surface>"],
      "verifier": { "kind": "<test kind>", "locator": "<command/probe>" },
      "result": {
        "status": "proven",
        "receipt": "<HEAD <sha>: <command> -> <outcome>"
      }
    }
  ]
}
```
````

Field legend (the fenced block itself MUST be valid JSON — no `//` comments;
copy the shape above verbatim and fill the angle-bracket placeholders):

- `mode`: `deletion_replacement` | `modification_only_rewrite`.
- `prior_surface.inventory_complete`: `true` = the declared `paths` cover the
  full tree-bound deletion/modify set for this slice; `false` = a declared
  subset (partial inventory).
- `behaviors[].result.status`: `proven` | `planned` | `failed` | `skipped` |
  `not-demonstrable`.
- `behaviors[].result.receipt`: a non-empty locator stringifying the verification
  outcome (conventionally `HEAD <sha>: <command> -> <outcome>`). The gate
  enforces presence (structural completeness); the tree-binding honesty — that
  the receipt references the assessed tree and not a stale or fabricated one —
  is author + reviewer, exactly like the `behavioral-closure` token (a
  consistent receipt does not prove the command ran against the right tree).

- **Stage 1 (commit-gate, pre-commit):** the contract is supplied explicitly via
  `--rewrite-parity-contract <file>` at acquire. The gate validates the schema,
  binds `prior_surface.revision` to the acquire-time HEAD, cross-checks
  `prior_surface.paths` against the tree-bound deletion/modify set, and requires
  a planned verifier per behavior. Flag absent ⇒ no rewrite-parity gating.
- **Stage 2 (closeout transition, status=completed):** every behavior must be
  `proven` with a non-empty `receipt`. `planned`/`failed`/`skipped`/
  `not-demonstrable`/missing-receipt refuse completion. `not-demonstrable`
  routes to defer — never record the infeasibility as silent prose.
- The contract is a declaration, not a proof: a structurally-complete contract
  can still carry weak evidence. The verifier/receipt honesty is author +
  reviewer, exactly like the `behavioral-closure` token.
- doctor runs an independent structural-consistency audit of committed
  ```rewrite-parity blocks (defense-in-depth; not the sole authority).

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

