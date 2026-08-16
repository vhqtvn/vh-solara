# Coordinator and build-session lifecycle discipline (harness)

Status: **advisory operational guidance** (OWN-LOCAL pilot per the 2026-08-16
ownership brief; upstream-candidate). Nothing here changes review authority,
git authority, exec-family verbs, or permission edges. Sources:
`tmp/agent-runs/sb-harness-waste_2026-08-15/brief.md` (Slice S1),
`tmp/agent-runs/sb-overlay-vs-upstream_2026-08-16/brief.md` (Phase 1 Slice 1A),
`docs/checkpoints/2026-08-16-phase0-harness-verification.md` (0B evidence).

## Why

Coordinator burn concentrates in mega-hub sessions (top-3 sessions = 31% of
coordinator spend; the largest reached 316 turns / 275 children / 59
compactions), and the 2026-08-10 dispatch storm showed a single degenerate
parent message can create 119 near-empty child sessions in minutes. Boundaries
— not thresholds — are the primary control.

## Rotation protocol (task/slice boundaries are PRIMARY)

1. **Rotate at task/slice boundaries.** A coordinator hub session ends when the
   current task or slice is handed off, committed, or explicitly deferred.
   Start the next slice in a fresh session (`/session-start <alias>`), not by
   growing the hub. *Check: the hub you are in has a named task/slice and that
   scope is closed before you accept the next one.*
2. **Turn/token thresholds are BACKSTOPS, not triggers.** If a session passes
   ~80 turns or context pressure warnings without a natural boundary, treat it
   as a rotation warning: close out at the nearest coherent boundary. Never
   rotate mid-slice just because a counter tripped. *Check: any rotation you
   perform names either a completed boundary or a backstop warning + the
   nearest coherent stop point.*
3. **Explicit session start before first concrete dispatch.** Bind the
   destination session (`/session-start`, task contract, memory, kickoff
   checkpoint) BEFORE delegating the first concrete work item. This is manual
   choreography today — the automatic bootstrap seam is upstream work
   (brief-2 Slice 1B) and must not be emulated with auto-spawn loops.
   *Check: the session exists with a task contract before its first child
   dispatch.*

## Handoff-compatible checkpoints (preserve `/handoff-save`)

4. **Durable progress → `/checkpoint-save`; receiver-targeted transfer →
   `/handoff-save`.** `/handoff-save` stays the canonical receiver-targeted
   handoff; do not retire or duplicate it. The checkpoint-fold ergonomics are
   upstream work; locally, keep using both commands for their own jobs.
5. **Receiver identity + premise 4-tuples stay explicit** in every handoff
   packet crossing a session boundary. Each load-bearing premise travels as
   the 4-tuple, never as bare truth:
   `(value, source, re_derivation_command, observed_at)`.
   The receiver re-derives before acting; a disagreement means the premise is
   stale and must be re-adjudicated, never silently re-asserted.
   *Check: every handoff names its receiver and each load-bearing premise
   carries all four tuple fields.*

## Dispatch discipline (interim storm mitigation — from Phase 0B)

The authoritative child-creation boundary is OpenCode core's task tool
(external; see the Phase-0 checkpoint). Until an upstream dedupe/backoff
exists:

6. **Stable logical dispatch identity** — one named task/slice identity per
   logical dispatch; the dispatch prompt names it.
7. **Dispatch sequentially.** Never emit multiple parallel `task` calls for
   the same logical work (the storm was 119 identical calls in ONE message).
8. **Inspect existing children before at most ONE manual retry.** After an
   ambiguous dispatch failure, list the parent's existing children first; a
   child-created-unknown state is never automatically retried.
9. **Never auto-spawn on ambiguous failure.** A missing immediate response is
   not proof of failure.

*Check: no dispatch loop you author retries without an inspection step, and
none spawns children programmatically.*

## Bookkeeping routing (docs-steward)

10. **Pure bookkeeping routes to the existing `docs-steward` specialist**:
    DEFER-card curation, backlog ledger edits, checkpoint scribe work, docs
    normalization. This is a routing-policy change only — no new agent, no
    new skill, no authority widening. Coordination/build sessions stop
    absorbing this work inline. *Check: a bookkeeping request you receive is
    delegated to `docs-steward` rather than executed in the hub.*

## What this guidance does NOT do

- No reviewer seat, aggregation, or gate-authority change (see
  `docs/ai/review-shadow-measurement-contract.md` for the shadow program that
  must precede any such change).
- No automated child-session creation, no retry automation.
- No change to committer-exclusive git authority, exec-family verb
  separation, or the candidate-output invariant.
