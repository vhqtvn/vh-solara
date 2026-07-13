---
name: tdd-loop
description: "Test-driven development loop for new behavior — red, green, refactor, next vertical slice. Use this when adding or changing behavior test-first at pre-agreed seams. Loads when the user asks to TDD a feature, write tests first, drive an implementation with tests, or settle when refactor should happen."
compatibility: opencode
---

# TDD Loop

Drive NEW behavior test-first, one vertical slice at a time. The loop is
**red → green → refactor → next slice**. Refactor is IN-LOOP (canonical TDD),
not deferred to review.

This skill is for new or changed behavior. For an EXISTING bug, use
`debugging-loop` — there, red localizes fault; here, red drives design.

## Loop

1. **Localize seams (keystone gate).**
   Find the contracted seam map (e.g. `<repo>-tdd-seams.md`) that names where
   this repo allows tests to attach. **No seam map → construct it with the user
   before writing any test**; this is step 1, not a skip. Two load-bearing
   sub-rules:
   - **Authority-honesty:** cite only packages, paths, and test directories that
     `ls`/glob actually find in the current repo. Never aspirational names.
   - **AGENTS.md co-localization:** in the SAME slice, reconcile the consumer's
     `AGENTS.md` testing-rules section with the seam map. A skill seam map and a
     stale `AGENTS.md` testing-rules section are two sources of truth; keep them
     one.
   Completion: a seam map exists, every cited target is verifiable in-repo, and
   `AGENTS.md` testing rules agree with it.
   See `references/seam-localization.md`.

2. **Pick ONE vertical slice.**
   One behavior, end-to-end across the seams it needs — not one horizontal layer
   spread across all features. The slice is the load-bearing keystone: it is what
   makes the red signal and the integration proof real.
   Completion: the slice is named with a one-line behavior statement and the
   seam it exercises.

3. **Red.**
   Write one failing test at a pre-agreed seam, for this slice only.
   Completion: the test runs, fails for the INTENDED reason, and the failure is
   not a setup or import error.

4. **Green.**
   Write the minimum code that makes the relevant tests pass.
   Completion: the relevant tests pass.

5. **Refactor (in-loop).**
   While tests are green, make at most one small, behavior-preserving clarity
   improvement within the current vertical slice; rerun the relevant tests.
   Completion: the relevant tests pass AND (the refactor is verified OR you
   explicitly record that no refactor is needed). Do not begin another behavior
   change until this check is complete.

6. **Next slice.**
   Return to step 2.
   Completion: the next slice is named, or the feature is done.

## Anti-patterns (leading words)

- **Implementation-coupled tests** — assert internal structure instead of
  behavior at the seam; they break under refactor and fight the green-refactor
  rhythm. Detect: the test reads private fields, mocks internals, or renames in
  lockstep with the code.
- **Tautological tests** — the expected value is recomputed the same way as the
  implementation, so the test asserts the code equals itself. Detect: the
  expected literal was produced by running the code under test.
- **Horizontal slicing** — one layer for all features (all models, then all
  controllers), which defers the end-to-end red signal. Detect: many tests green
  but no single behavior demonstrable end-to-end.

## When not to use

- existing bug, flaky failure, or fault-localization → `debugging-loop`
- exploratory spike with no stable contract → write a throwaway; do not TDD it
- the seam itself does not exist yet → build the seam (and its seam-map entry)
  first, then re-enter the loop

## References

- `references/seam-localization.md` — building `<repo>-tdd-seams.md`, seam
  shapes, the authority-honesty rule, and the `AGENTS.md` co-localization
  requirement in full.
