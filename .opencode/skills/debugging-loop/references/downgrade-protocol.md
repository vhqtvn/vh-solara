# Downgrade / handoff protocol (debugging)

The D2C escape from `debugging-loop`. **The guardrails themselves live in
`SKILL.md` → "Downgrade when deterministic red is unavailable".** This reference
carries only the how-to: the label taxonomy, when-to-downgrade decision
examples, the diagnostics-export packaging recipe, and the bgshell-job boundary.
It does not restate the guardrails.

## Why a downgrade exists

This escape exists because step 1 has a hard boundary: the loop only iterates on
deterministic, agent-runnable red (the rule lives in `SKILL.md` step 1). Some
real bugs cannot be made to cross that boundary — a render defect only a human
eye confirms, a race that never tightens, a failure that needs hardware the
agent cannot drive. Pretending the agent still owns those loops produces theater:
theorizing against a signal it cannot verify. The downgrade makes that boundary
explicit and disclosed instead of silent.

## Label taxonomy

Tag the handoff with exactly the label that fits. The label decides what a human
must do next.

- **`human-observed`** — the defect is real and reproducible, but the pass/fail
  verdict requires a human sense: a visual judgment of a rendered frame, a
  subjective quality call, a tactile or audio confirmation. The agent can show
  the artifact; a human must read the verdict.
- **`non-deterministic`** — the defect reproduces but not on demand: a race or
  timing pathology that resists serialization, or appears only under load the
  loop cannot impose deterministically. The agent has tried to tighten it and
  failed within a bounded budget.
- **`not agent-runnable`** — reproducing the defect needs an environment,
  credential, or device the agent cannot drive: a real payment provider, specific
  physical hardware, a closed desktop session.

One label per handoff. If two fit, pick the more restrictive (it sets stricter
expectations on the human side).

## When to downgrade vs. keep trying

Worked decision examples. Use these before declaring a downgrade — the bar is
"bounded reproduction cannot yield deterministic red", not "this is hard".

- **Render bug visible only under real GPU load** → `human-observed`. The agent
  cannot read the frame; downgrade.
- **Race that fails 1-in-50 but tightens under 50× serial repeat** → NOT a
  downgrade yet. Drive the 50× repeat with `bgshell-job`; if a deterministic
  failing seed falls out, that becomes the red signal. Downgrade only if
  repeated runs never converge on a reproducible seed.
- **Defect a human must judge against a design spec** → `human-observed`.
- **Failure only on a real cloud provider with live credentials** →
  `not agent-runnable`. Downgrade; do not attempt to forge credentials or bypass
  the provider.
- **Flaky under the agent's runner but deterministic under a stricter serialized
  runner** → NOT a downgrade. Tighten the runner first.

## Packaging the handoff (diagnostics-export)

Use the `diagnostics-export` skill to bundle a safe-to-share package. The bundle
must let a human pick up the signal without rediscovering it:

- **environment** — repo state, runner, platform, relevant config (the redaction
  layer scrubs secrets; confirm with `--dry-run` first).
- **what was tried** — every red-signal attempt and why each failed the
  four-property checklist.
- **repro attempts** — the minimized inputs and the commands that were run.
- **the next observation request** — the one concrete thing a human must observe
  or do that the agent cannot (look at this frame, run this on that device,
  watch this metric under load).

Completion of the downgrade path: a labeled diagnostics bundle exists, the next
observation request is named, and the agent-owned loop for this signal has
ENDED.

## bgshell-job boundary

`bgshell-job` is for long-running NON-GPU shell probes that outlive one shell
call. It is a tool inside the deterministic-red attempt, not a second loop.

- **IN** — 50× serial reproduction of a flaky test, repeated CLI metric sampling
  under load, long soak runs of an e2e chain, repeated API probing to surface a
  timing pathology. These stay inside the loop because their output CAN become a
  deterministic red (a failing seed, a sampled threshold crossing).
- **OUT** — GPU thermal profiling, compositor/frame-timing capture, WebGL
  rendering inspection, or any path whose verdict requires visual observation.
  These cannot become an agent-owned deterministic red; they go to the Downgrade.

After a labeled handoff, the agent-owned loop for that signal ends. Using
`bgshell-job` to keep "iterating" on a signal that was already downgraded is
exactly the theater the guardrail forbids.
