# Pilot runbook — formal verification (overlay-only S1)

This is a procedural runbook for running a bounded pilot slice and the
**two-sided** A/B health measurement (VALUE: net-new bugs vs prose reasoning;
COST: proof-authoring latency). It produces **advisory evidence only** — no
gate, no commit/release/doctor/update effect. See `SKILL.md` for the full
procedure, authority line, paradigm, and the model-fidelity binding; see the
design brief for the canonical crux and the supersession history.

This pilot is **instruction-only**. There is no bundled helper and no bundled
engine. The design-time product (proof/spec text + fidelity binding +
red-on-divergence test) is producible with NO engine installed; the engine check
is an OPTIONAL confirmation that waits on operator-provisioned Lean4 / TLAPS (a
separate infra step — see `.opencode/repo-configs/formal-verification-config.json`). *(Note: TLAPS is not currently supported/evidenced; a requested proof problem may be evaluated as a future pilot.)*

## 0. Confirm the design-time product needs no engine

Before running anything, confirm the capability property holds: you can produce
the proof/spec, the fidelity binding, the classification decision, and the
red-on-divergence test with no engine reachable. (Optional: note whether an
engine IS reachable for §4, but do not let its absence block §1–§3.)

## 1. Declare a bounded slice

Record, before running anything (state every field explicitly — use `none` where
it does not apply, so the run ledger has no silent gaps):

- **candidate invariant** — the property to prove, stated precisely (the crux
  claim, not a vague goal).
- **classification branch** — the seconds-fast decision tree result: `(a) Lean4`
  / `(b) Lean4` / `(c) Honest exit (TLAPS unsupported)` / `(d) honest-exit`. Record the branch AND the
  one-line reasoning (e.g. "real interleavings must be modeled → TLAPS, not a
  sequential Lean encoding"). *(Note: TLAPS is not currently supported/evidenced; a requested proof problem may be evaluated as a future pilot.)*
- **engine target** — `lean4` / `none` (TLAPS unsupported), and the pinned tag the operator
  provisioned (or `none` — the engine is optional for the design-time product).
- **model↔code scope** — the code locations the model's transitions/variables
  map to (the surface the fidelity binding will cover).
- **liveness check** — confirm the claim is a SAFETY invariant (or record the
  honest-exit if it is liveness/temporal — OUT of pilot).
- **time / cost budget** — a wall-clock ceiling for proof-authoring (classification
  → authored proof → fidelity binding → red-on-divergence test), excluding the
  optional engine check. Budget exhaustion feeding the COST falsifier is a
  stop/reshape trigger (see §6).
- **completion / stop conditions** — what marks the run done (the design-time
  product is authored AND the red-on-divergence test is shown to go red on
  divergence AND the two-sided measurement is recorded) and what stops it early
  (a falsifier firing; see §6).

Keep the first slice narrow — one crux invariant, not a repository-wide campaign.

## 2. Property-test prefilter FIRST (advisory, never proof evidence)

Before authoring the proof, run the `prefilter: property-test | none` step on the
candidate. This cheaply falsifies candidates that are wrong before you invest in
proof-authoring.

- A property test that **fails** here → the candidate is falsified; record it and
  stop. No proof is needed.
- A property test that **passes** does NOT promote the candidate toward `proven`;
  it only declines to falsify it cheaply. Proceed to proof-authoring with no
  added confidence from the prefilter.
- Label the output `property-test-prefilter`. It is separately recorded, never
  mixed into proof evidence, and carries no doctor hook.

If no cheap property test exists for the candidate, record `prefilter: none` and
proceed.

## 3. Author the design-time product (NO engine needed)

Produce all three; none requires an engine to be reachable:

1. **The proof / spec text** — the formal artifact the agent authors (Lean4 proof
   script, or TLA+ spec + proof obligation). This is the primary work product. *(Note: TLAPS is not currently supported/evidenced; a requested proof problem may be evaluated as a future pilot.)*
2. **The fidelity-binding artifact** — a declared mapping from each model
   transition / variable to the code location it represents. Reviewable. Part of
   the design-time product.
3. **The red-on-divergence code-level test** — a targeted invariant regression
   test that MUST go red on divergence between the model and the code. The
   Pattern-1 rule: a test that *cannot* go red on the load-bearing divergence
   (because a fake always emits the success signal) is **not a fidelity binding;
   it is the laundering surface.** Show the test goes RED when the modeled
   invariant is deliberately diverged from the code (the divergent/pre-fix
   condition) and GREEN on a reviewed faithful implementation (the faithful
   condition) before treating it as a binding.

Anti-laundering check at author time: ask "could this test go red on the crux
divergence?" If the honest answer is no (a fixture short-circuits the path), the
binding is invalid — re-author it so the divergence is observable, or record the
candidate as `not-demonstrable`.

## 4. (Optional) Engine check — only if operator-provisioned Lean4 / TLAPS reachable

*(Note: TLAPS is not currently supported/evidenced; a requested proof problem may be evaluated as a future pilot.)*

If and only if the operator has provisioned a pinned engine, run the authored
proof through it. The engine config comes from
`.opencode/repo-configs/formal-verification-config.json` (+ its `.local.json`
twin), resolved by the 4-level two-file field merge. The skill never triggers a
networked build; it consumes the pinned binary or pre-built image.

- **Green** → the proof checks against the model. This is **distinct-union
  evidence part A**; part B (the fidelity binding + red-on-divergence test) must
  ALSO hold. Green alone is a token, not reality.
- **Red / unknown / engine absent** → record `proof-written-but-unchecked` (or
  the checker failure). This MERGES to `result: not-demonstrable` /
  `verdict: inconclusive`. **Never blocks. Never `proven`.**

Recording `proven` is claimable ONLY when: the engine actually ran AND the run is
bound to a reviewed fidelity claim AND the red-on-divergence test is present.

## 5. Two-sided A/B health measurement (the pilot success criteria)

Both sides are **predeclared** and both must be measured on the SAME candidate
set. Either falsifier firing is a STOP/reshape.

### (a) VALUE side — net-new bugs vs prose reasoning

Run this skill AND a prose-reasoning baseline (an agent reasons about the same
invariant in prose, no formal proof) on the SAME candidate invariant set. Count:

- `defect-caught-by-proof-only` — defects the proof/binding surfaced that prose
  reasoning did not.
- `defect-caught-by-both` — defects both surfaced.
- `defect-caught-by-prose-only` — defects prose surfaced that the proof/binding
  did not (a sign the formalization erased the crux — the Pattern-1 failure
  mode).
- `no-defect` — neither surfaced a defect (valid outcome).

**Net-new = `defect-caught-by-proof-only`.** Falsifier: green check counts rise
but net-new is ~0 (or, worse, `defect-caught-by-prose-only` is nonzero — the
formalization laundered the crux) → STOP/reshape.

### (b) COST side — proof-authoring latency

Measure end-to-end proof-authoring wall time per candidate (classification →
authored proof → fidelity binding → red-on-divergence test), **excluding** the
optional engine check. Track the distribution and whether lanes start avoiding
the skill.

Falsifier: latency dominates AND avoidance appears → STOP/reshape.

## 6. Stop/reshape decision

Apply the stop/reshape conditions (SKILL.md):

- VALUE falsifier fires (no net-new vs prose; or formalization laundered the
  crux — `defect-caught-by-prose-only` > 0).
- COST falsifier fires (latency dominates; lanes avoid the skill).
- The fidelity binding cannot be made to go red on divergence (Pattern-1
  laundering surface) and cannot be re-authored to do so → the candidate is
  `not-demonstrable`, not a forced `proven`.
- The classification forced a sequential Lean encoding onto a concurrent
  invariant (erasing interleavings) → re-classify to honest-exit. *(Note: TLAPS is not currently supported/evidenced; a requested proof problem may be evaluated as a future pilot.)*
- A liveness / temporal claim was accepted into a proof path → re-route to
  honest-exit (d); liveness is OUT of pilot.

If a falsifier fires, STOP and reshape rather than continue.

## 7. Record for the S2 evidence file

Capture (this is advisory evidence for a future, separate S2 decision — NOT an
S2 score):

- slice declaration: candidate invariant, classification branch + reasoning,
  model↔code scope, liveness-check result, engine target + pinned tag (or `none`);
- the authored proof/spec (or a locator to it);
- the fidelity-binding artifact (or a locator);
- the red-on-divergence test (locator) and the RED-on-divergence /
  GREEN-on-faithful-implementation demonstration;
- property-test-prefilter result (`property-test-prefilter` labelled) or `none`;
- engine-check result: green / red / `proof-written-but-unchecked`; the recorded
  `result`/`verdict` mapping (`proven` ONLY if engine ran + reviewed fidelity +
  red-on-divergence test; else `not-demonstrable`/`inconclusive`);
- VALUE counts: `defect-caught-by-proof-only` / `-both` / `-prose-only` /
  `no-defect`; net-new total;
- COST: proof-authoring latency distribution; lane-avoidance observations;
- any stop/reshape condition that fired and the action taken.

This runbook produces no gate. Any red-on-divergence test it motivates lives with
the code under test (owned there), and any engine-check result is advisory
distinct-union evidence that feeds the shipped behavioral-closure crux model —
never an independent justification of code `proven`.
