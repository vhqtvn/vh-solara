---
name: think-mode
description: Decision helper for picking the right read-only opencode workflow — researcher, debate, one-shot solution-brief, or phased solution-brief (research.md → debate.md → brief.md) — based on the question's uncertainty shape. Use this when the operator asks "should we research / debate / solution-brief this?", before drafting any new read-only session prompt, when the framing is ambiguous about which workflow shape fits, or when a stakeholder reframe has just landed and the workflow choice should be reconsidered.
compatibility: opencode
---

# Think Mode — Pick the Right Read-Only Workflow

Use this whenever the operator is about to start (or asks you to draft) a read-only thinking session and the right shape is not obvious. Return ONE named pattern + a scaffolded prompt.

## When to use

- the operator asks "should we research / debate / solution-brief this?"
- before drafting any new read-only session prompt
- the framing is ambiguous about which workflow shape fits
- a stakeholder reframe has just landed and the workflow choice should be reconsidered

## When NOT to use

- the operator already named the pattern explicitly ("draft a solution-brief prompt", "just a researcher pass")
- implementation work — hand off to `build` directly
- already-settled rules — `planner` or direct `build`
- the operator just said **Process** or **Refine** — those are gate replies, not new think-mode triggers; follow the Operator gate protocol below

## Expected inputs

Before invoking, gather:
- the concrete question or decision the operator needs resolved
- whether the framing is settled or likely to shift (stakeholder input pending)
- whether facts are already available or still need research

## Decision tree

Apply in order; stop at the first match:

1. **Already know the answer / route is settled** → `build` directly. Skip read-only work.
2. **Just need facts, sources, or contradictions** → `researcher` alone. Output: `research.md` (or `researches/sources/...md`). No recommendation.
3. **Facts settled; just picking A vs B** → `debate` alone (often direct delegation from `build` mid-task). Internal packet only — request `debate.md` explicitly if you want it captured.
4. **Need facts + options + a plan** → continue to step 5.
5. **Apply the 90-minute self-check**: *"if the final `brief.md` arrived in 90 minutes, am I confident the framing of the question itself is right?"*
   - **Yes, framing is settled** → one-shot `/solution-brief`. Output: single `brief.md` (decision-frame table + recommendation + execution plan).
   - **No, framing might shift (stakeholder reframe likely, architectural, contentious)** → **phased**: separate `researcher` → `debate` → `solution-brief` sessions producing `research.md` → `debate.md` → `brief.md`, with operator-review bail-out gates between each phase.

## Output shape

Return a short structured answer:

1. **Pattern chosen** — exactly one of: `build` / `researcher` / `debate` / `one-shot solution-brief` / `phased solution-brief`.
2. **Why this and not the adjacent options** — 1–3 sentences naming the uncertainty shape that drove the choice (cite the 90-min check if at step 5).
3. **Scaffolded prompt** — copy-paste-ready opencode session-start prompt in the same shape as `tmp/agent-runs/release-flow-hardening-brief/brief.md` and `tmp/agent-runs/oj1-oj2-localization-redaction-brief/brief.md`. Include: stakeholder context, current state, constraints to respect, decisions to settle (D1–Dn), deliverable path, out of scope.
4. **Bail-out gates** (phased only) — explicit points where the operator should review (`research.md` review → debate, `debate.md` review → brief).
5. **Operator gate.** End by asking the operator to choose:
   - **Process** — launch the chosen workflow now using the scaffolded prompt verbatim.
   - **Refine: <what to change>** — adjust scope / decisions / shape, then re-present and re-ask.
   Do NOT auto-launch. Wait for the operator's reply.

## Operator gate protocol

When the operator replies after a think-mode turn:

### On **Process**
- **Cheap tiers** (`build` / `researcher` / `debate`): the coordination session spawns that subagent directly with the scaffolded prompt.
- **One-shot solution-brief**: spawn the `solution-brief` session with the scaffolded prompt.
- **Phased**: spawn ONLY the first phase (`researcher`). Preserve the inter-phase review gates — do NOT chain research → debate → brief automatically; each phase ends and waits for operator review (the existing bail-out gates).

### On **Refine: <content>**
- If the refinement changes the **framing** (e.g. new stakeholder constraint, scope shift that affects settled-vs-fluid), **re-run the decision tree** — the chosen pattern may change.
- If it is just scope/decision tweaks, edit the scaffolded prompt in place.
- Either way, re-present (pattern + why + revised prompt + the operator gate) and wait again.

### Any other reply
Treat as refinement input — apply to the scaffolded prompt or framing and re-present.

## Anti-patterns

- **`debate` without facts** — call `researcher` first; pure debate hallucinates options.
- **`solution-brief` for narrow factual lookups** — `researcher` alone suffices; `/solution-brief` is wasteful overhead.
- **`solution-brief` for already-settled rules** — `planner` or direct `build`; debate would just stall.
- **`researcher` with implicit recommendation** — by spec, researcher delivers facts not verdicts. If you want a decision, say "decision memo" explicitly.
- **Defaulting to phased for every architectural question** — 3× overhead is real; many questions are well-defined enough for one-shot.
- **Defaulting to one-shot for fluid-framing questions** — discovering "framing was wrong" only at the end is expensive when stakeholders are still weighing in.

## Subtle ambiguities to flag

- **`debate` rarely produces a standalone `.md`** by default — it's an internal step (proposer → critic → synth packet). If the operator wants a captured `debate.md`, demand it in the prompt.
- **`researcher` can produce either `sources/...md` (facts-only) or `decisions/...md` (with recommendation)** — operator phrasing decides; for clean facts-only, say "no recommendation."
- **`/solution-brief` is one read-only pass with at most one evidence-refresh bounce** — not a long iterative research task. For iteration, use phased.

## Real examples from this repo

- **OJ1/OJ2 localization & redaction** → one-shot was correct. Well-defined, low ambiguity. Phased would have been 3× the reading for the same conclusion.
- **Release-flow hardening** → one-shot was correct. Known surface, known constraints.
- **LLM-insights & suggested classifier (stakeholder reframe)** → phased was correct. A "let LLM steer" reframing was actively reshaping the problem, and bail-out gates after `research.md` and `debate.md` let the operator redirect before the planner crystallized.

<!-- Update when a new solution-brief or phased session produces a clear pattern match or anti-pattern -->

## Trigger phrases

- "should we research / debate / solution-brief this?"
- "draft a brief prompt for X"
- "what kind of session should I start for X?"
- "one-shot or phased for this?"
- "I'm not sure if this needs research or just build"
- "Process" / "Refine: …" — gate replies handled by the Operator gate protocol; listed here so the operator knows the contract

## See also

- `AGENTS.md` — canonical role descriptions for researcher / debate / planner / solution-brief
- `docs/coding-agent-in-research/solution-brief/README.md` — solution-brief usage rules
- `vh-agent-harness docs opencode-skills` — overall skills guide
