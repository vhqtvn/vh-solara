# Coordination Task Modes

Use these modes to keep coordination proportional to the real fan-out and
fan-in load.

The mode is about coordination load, not code size.

## Mode Table

| Mode | Use when | Required surfaces | Required report envelope | Escalate when |
| --- | --- | --- | --- | --- |
| `short` | 1-2 sessions, one owned slice, little or no fan-in | `docs/planning/backlog.md`, session memory, scoped review | `minimal` | another lane becomes active, or the task now needs several reports |
| `medium` | 3-6 sessions, 2+ lanes, planned handoffs, several reports | backlog, session memory, one workstream, one synthesizer | `standard` from workers, `synthesis` for fan-in | work becomes async/disconnected, or fan-in cannot be tracked safely in one workstream |
| `long` | 6+ sessions, repeated fan-out/fan-in, async/disconnected execution, many reports | backlog, checkpoints, workstream memory, optional local runtime coordinator | `standard` from workers, recurring `synthesis` | mode stays `long` until the fan-in surface is reduced again |

## Selection Rules

Choose `short` when most of these are true:

- one primary lane owns the next slice
- one implementer or reviewer can carry the task
- the outcome fits one backlog row and maybe one checkpoint
- waiting-on state is small enough for session memory alone

Choose `medium` when most of these are true:

- more than one lane must contribute
- you expect 2-5 subagent reports
- handoffs matter more than raw throughput
- one coordinator or synthesizer can still keep the live state coherent in one
  workstream

Choose `long` when any of these are true:

- 6 or more sessions may contribute
- reports arrive asynchronously or from disconnected sessions
- multiple subagents may finish in parallel while the coordinator is offline
- waiting-on state, retries, or synthesis history no longer fit cleanly in one
  workstream brief plus next slice

## Operating Rules By Mode

### Short

- use `/coordination` only when lane selection is unclear
- treat coordination as a one-turn routing consult, not a standing work session
- keep live state in the session alias
- once the lane is known, move the concrete slice into the owning specialist or
  `/resume-task` execution session instead of solving it in coordinator context
- if durable local persistence is needed, use `/research` for new research
  slices and `/write-task` for implementation or study slices, then leave
  coordinator context
- stop after one concrete next command; do not append a second execution plan
  packet in the coordinator response unless the user explicitly asks for it
- prefer one owned file list per implementer
- use `/commit-review` for the slice and `/ship-review` only at the end if the
  overall change warrants it

### Medium

- start with `/coordination`
- bind a workstream
- keep the coordinator focused on routing and synthesis; push each owned slice
  into a specialist or execution session
- require structured `standard` reports from subagents
- nominate one synthesizer before parallel work starts
- let only the synthesizer write the final backlog/checkpoint promotion for that
  fan-in cycle

### Long

- keep repo truth in backlog and checkpoints
- use `.opencode/state/workstreams/` for theme context
- keep the coordinator as a fan-in surface, not a running work log; concrete
  slices still belong to owned specialists or runtime tasks
- add a local runtime coordinator under `.local/coordinator/` only for
  transport, collection, and synthesis support
- keep raw reports local; promote only synthesized conclusions

## Escalation And De-Escalation

Escalate `short -> medium` when:

- a second lane owns meaningful work
- the closeout now depends on several subagent reports
- one session can no longer hold the active state safely

Escalate `medium -> long` when:

- more than 5 subagent reports are expected
- subagents are long-lived or disconnected
- the coordinator now needs a queue, dashboard, or retry loop

De-escalate when fan-in has been reduced enough that:

- one synthesizer has promoted the current conclusions
- waiting-on state is small again
- the next slice can be run from session/workstream memory alone

## Non-Negotiable Rules

1. Transport is not truth.
2. Commit backlog SEPARATELY from code (hybrid split-commit). This applies
   **during execution** as well as at fan-in: an agent editing
   `docs/planning/backlog.md` keeps that edit in a backlog commit distinct from
   its code commit, so a concurrent backlog edit can never block a clean code
   commit. On `cas_conflict`, re-read from the new HEAD, re-apply only your
   rows, and retry — never revert `backlog.md`. DEFER/p2 follow-ups route to
   `.local/coordinator/tasks/` as conditional candidates and reach the
   backlog only after trigger + Definition of Ready. See
   [PROMOTER_RUNBOOK.md](PROMOTER_RUNBOOK.md).
3. Subagent reports capture facts first; synthesis resolves conflicts.
4. Raw runtime notes stay local unless promoted into backlog or checkpoints.
5. Coordinator context stays thin; concrete work moves to owned specialists or
   execution sessions as soon as the lane is known.
