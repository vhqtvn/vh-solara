# Authority Classes: Advisory vs. Hard Gates

This document codifies the authority taxonomy for checks and signals in the agent harness. It resolves the "advisory gate" contradiction: a gate has transition authority, whereas an advisory signal must not.

## 1. Advisory Check / Signal (INFORMS)
- **Role:** Observes and reports.
- **Authority:** Never blocks, authorizes, completes, or refuses a protected transition. It has no transition authority, even on tool error.
- **Output:** May produce evidence consumed elsewhere.
- **Requirement:** Must include actionable provenance, ownership, and a next action to prevent signal fatigue.

## 2. Hard Evidence-Gated Completion / Transition
- **Role:** Owns a protected-state predicate.
- **Authority:** Independently decides whether completion or transition is allowed.
- **Output:** May consume evidence produced by advisory checks, but the authority to transition rests entirely here.

## Inventory of Existing Advisory Surfaces
The following existing surfaces are **advisory** checks:
1. **Commit-reviewer DEFER/DROP:** Non-gating review findings; blocking is reserved for BLOCK findings (cross-referenced in `.opencode/agents/commit-reviewer.md`).
2. **Doctor WARN/INFO:** Non-failing health checks, distinct from failing results.
3. **Complexity INFORM:** Complexity-control signals that explicitly inform and never gate.
4. **Lifecycle WarnAndContinue:** Non-blocking policy at selected hooks.
5. **Skill-freshness toast:** Fail-open toast so signal failure does not disrupt session creation.

## Exclusions
The following are **NOT** advisory checks and must not be relabeled as such:
- **Shell-guard `ask`:** Operator-mediated permission that blocks pending a decision.
- **Behavioral-closure / Rewrite-parity:** Declarations whose consistency rules can reject transitions.
- **Pause-new-work:** Hard admission authority; only its descriptive metadata is advisory.
- **DEFER transport:** Belongs to a separate admission/transport lifecycle, not a generic advisory result mechanism.

## Homonym Guard
In the harness, **"advisory"** refers to the *check-authority-class* defined above. This must not be confused with "advisory" as an *evidence-type* in consumer implementations. The harness taxonomy relies on the authority of the check, not the shape of the evidence.

## Risk Guards
- **Signal fatigue:** Advisory signals must carry actionable provenance, ownership, and next-action; they are not a channel for noise.
- **Authority leakage:** A WARN or INFORMS signal does not imply health, completion, or gate status.
- **Mode ambiguity:** A single result must not use a dynamic soft/hard flag; an advisory check cannot unexpectedly switch to transition authority. Any promotion to a blocking rule requires a separate hard-gate owner and decision.
