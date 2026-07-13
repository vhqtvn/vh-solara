---
name: debugging-loop
description: "Debugging loop for existing bugs — build a deterministic red signal FIRST, then reproduce, minimise, hypothesise, instrument, fix, regression-test, with a 3-line post-mortem. Use this when fixing a bug, chasing a failure, or reproducing a defect. Includes an explicit downgrade-to-human handoff when deterministic red is unavailable."
compatibility: opencode
---

# Debugging Loop

Fix an EXISTING bug by building a red signal BEFORE theorizing. Deterministic
red is the ONLY signal an agent iterates on. The loop:

**build-red → reproduce → minimise → hypothesise → instrument → fix →
regression-test → cleanup + post-mortem.**

For NEW behavior, use `tdd-loop` — there, red drives design; here, red localizes
fault.

## Loop

0. **Localize (step 0, absence-contract).**
   Find the contracted localization artifact (e.g. `<repo>-debugging-loops.md`)
   carrying this repo's failing-test shapes, API endpoints, e2e chains, and repro
   recipes. **No localization file → construct it with the user before
   debugging**; this is step 0, not a failure. Authority-honesty rule: cite only
   endpoints, paths, and recipes that `ls`/glob actually find in the current
   repo; never aspirational names.
   Completion: a localization file exists and every cited target is verifiable
   in-repo.
   See `references/red-signal-recipes.md`.

1. **Build the red signal FIRST (the keystone).**
   A tight, deterministic, agent-runnable pass/fail that goes RED on THIS bug —
   built BEFORE reading code to theorize. If bounded reproduction cannot yield
   one, stop and go to the **Downgrade** section below; do not paper over the gap
   by theorizing.
   Completion: ONE named, already-runnable command or procedure that is
   red-capable + deterministic + fast + agent-runnable.
   See `references/red-signal-recipes.md`.

2. **Reproduce.**
   Run the red signal; confirm it fails for the reported reason.
   Completion: the red signal fails on demand, deterministically.

3. **Minimise.**
   Shrink the red signal to the smallest input or range that still goes red.
   Completion: the minimized case is recorded and still red.

4. **Hypothesise.**
   Generate 3–5 ranked falsifiable hypotheses.
   Completion: hypotheses are ranked by likelihood and each names the one
   observation that would falsify it.

5. **Instrument.**
   Add ONE probe for ONE variable that distinguishes the top hypothesis.
   Completion: one instrumentation point is added, capturing one variable.

6. **Fix.**
   Apply the smallest change that turns the probe's prediction green AND the red
   signal green.
   Completion: the red signal is green and the instrumentation agrees with the
   fix.

7. **Regression-test + cleanup + post-mortem.**
   Add a regression test that would catch this bug returning; remove
   instrumentation and scratch; write a 3-line post-mortem — root cause (one
   line) / why the red signal caught it (one line) / one preventive change (one
   line).
   Completion: regression test in-slice, scratch removed, post-mortem recorded.

## Downgrade when deterministic red is unavailable

Decision 2C. Deterministic red is the ONLY signal an agent iterates on. If
bounded reproduction at step 1 cannot yield one, declare an explicit DOWNGRADE
labeled `human-observed | non-deterministic | not agent-runnable`. Guardrails
(load-bearing — elaboration in `references/downgrade-protocol.md`, the rules
themselves live here):

- A human observation is NEVER promoted to an agent-owned deterministic
  red/green gate.
- Do not continue theorizing as though the agent owns the loop after the
  downgrade.
- Use `diagnostics-export` to package the human handoff (environment, logs,
  traces, repro attempts, safe-to-share observations). Completion: a diagnostics
  bundle identifies what was tried, what a human must observe, and the next
  observation request.
- Use `bgshell-job` ONLY for long-running NON-GPU shell probes (e.g. 50× serial
  reproduction, repeated CLI metric sampling) that outlive one shell call.
  Explicitly NOT for GPU/thermal/compositor/WebGL/visual-observation profiling.
- After the labeled handoff, END the agent-owned debugging loop for that signal;
  do not simulate iteration on an unverifiable signal.

The escape is a deliberate, disclosed downgrade — NOT a silent exclusion, NOT a
second co-equal loop.

## When not to use

- new behavior with no bug → `tdd-loop`
- the signal is already a clean deterministic red you fully understand → apply
  the fix and add the regression test; skip the ceremony
- deterministic red is genuinely unavailable and the handoff is sent → the loop
  ENDS at the downgrade; do not keep iterating

## References

- `references/red-signal-recipes.md` — constructing a deterministic red signal,
  the red-capable + deterministic + fast + agent-runnable checklist, and
  red-signal anti-patterns (flaky, slow, requires-interactive).
- `references/downgrade-protocol.md` — the downgrade/handoff protocol in full:
  label taxonomy, when-to-downgrade decision examples, diagnostics-export
  packaging, and the bgshell-job boundary. The guardrails themselves live above.
