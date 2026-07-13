# Red signal recipes (debugging)

How to build the deterministic red signal that step 1 of `debugging-loop`
requires. The red signal is the keystone: every later step (reproduce,
minimise, hypothesise, instrument, fix) is only meaningful because something
deterministic goes red. Build it before reading code to theorize.

## The four-property checklist

A step-1 red signal must satisfy all four. A signal missing any one is not the
keystone — fix it or go to the Downgrade section in `SKILL.md`.

- **Red-capable** — it actually fails today, on this bug. A test that passes is
  not a red signal; it is a wish.
- **Deterministic** — same input, same verdict, every run. No wall-clock, no
  thread-race, no "usually fails". If it only fails sometimes, it is not yet a
  red signal; tighten it or serialize it (see `bgshell-job` boundary below).
- **Fast** — seconds, not minutes. A slow red signal gets skipped under time
  pressure and breaks the iterate-fast rhythm of the loop.
  - *Exception — predeclared-aggregate red.* A slow signal still satisfies *fast*
    when ALL of: **predeclared threshold** — the pass/fail gate was stated before
    running (e.g. "0 failures in serial ×50"), not chosen after the result;
    **reproducible count** — the aggregate verdict repeats across runs (same
    direction, same approximate count), not a one-off; **no cheaper seam** — the
    isolation seam is green, so faster seams provably cannot go red (the runtime
    is necessary, not lazy); **bgshell-hosted** — the long runtime runs under
    `bgshell-job`, not blocking one shell call. Shape: cross-test contamination
    where isolation is green and only the serial aggregate goes red.
- **Agent-runnable** — invocable as one named command or procedure with no human
  in the loop (no clicking, no typing into a prompt, no "look at the screen and
  tell me if it is wrong").

## Recipe

1. **Pick the narrowest seam** the bug is observable at — from the localization
   file (`<repo>-debugging-loops.md`). Prefer the cheapest seam that still goes
   red: a unit seam over an integration seam, an integration seam over a full
   e2e chain.
2. **Exercise ONLY the buggy path.** Do not bootstrap the whole app if a single
   call reproduces the defect. Strip every input that does not change the
   verdict.
3. **Seed deterministically.** Pin everything that could vary between runs: a
   fixed clock, a fixed RNG seed, a fixed input file, a fixed request body, a
   serialized run order. Determinism is not a property you hope for; it is a
   property you impose.
4. **Assert expected-vs-actual.** The expected value comes from the contract
   (spec, prior good behavior, a golden file), never from re-running the code
   under test (that would be tautological).
5. **Wrap it as one command.** A script or a single test case that any agent or
   CI can invoke by name, exits non-zero on the bug, and prints the diff that
   explains the failure.

## Red-signal anti-patterns

Each of these fails one of the four properties. If you catch yourself writing
one, stop and rebuild.

- **Flaky** — fails only sometimes (wall-clock dependent, order dependent,
  network dependent). Fails *deterministic*. Tighten by pinning the varying
  input; if it cannot be pinned, the signal may belong in the Downgrade.
- **Slow** — takes minutes or needs a cold start. Fails *fast*. Move work out of
  the path, or drop to a cheaper seam. **Exception:** if the slow red is a
  predeclared-aggregate (isolation green, serial red, bgshell-hosted — see the
  *fast* exception above), the long runtime is necessary and the aggregate count
  is the red; do NOT drop to a cheaper seam that cannot go red.
- **Requires-interactive** — needs a human to click, type, or visually confirm.
  Fails *agent-runnable*. This is the most common trigger for the Downgrade (see
  `references/downgrade-protocol.md`).
- **Coupled-to-implementation** — asserts internal state rather than observable
  behavior, so it describes the bug rather than demonstrating it. Survives a
  rewrite that reintroduces the bug. Re-state it against the contract.

## Handoff to the rest of the loop

Step 1 is done when a named, one-command red signal exists. Steps 2–3
(reproduce, minimise) refine that same signal; they do not replace it. If
minimising breaks determinism, you have stepped across the boundary the Downgrade
exists for — re-read the guardrails in `SKILL.md` before continuing.
