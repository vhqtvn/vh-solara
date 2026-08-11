---
description: Manage the repo-scoped pause on NEW work (engage / status / disengage)
agent: build
subtask: false
---

Manage the repo-scoped pause on NEW work across enumerated dispatch entrypoints.

Action (engage | status | disengage):
$ARGUMENTS

This is the operator UX for `vh-agent-harness pause-new-work`. Run the matching
CLI verb through `vh-agent-harness exec` and report the result verbatim.

- if the action is `engage` (optionally followed by a reason string):
  - run `vh-agent-harness exec vh-agent-harness pause-new-work engage <reason>`
  - report the sentinel path and that covered new-work admissions are now refused
  - state explicitly that IN-FLIGHT WORK IS NOT AFFECTED
- if the action is `status` (or empty):
  - run `vh-agent-harness exec vh-agent-harness pause-new-work status`
  - report engaged / disengaged / degraded and the sentinel path
- if the action is `disengage`:
  - run `vh-agent-harness exec vh-agent-harness pause-new-work disengage`
  - report that covered new work is permitted again

Naming honesty (load-bearing — do not soften): this is a repo-scoped pause on
NEW work across enumerated dispatch entrypoints. It is NOT a global pause, NOT
an abort/kill switch, and NOT an agent-loop interlock. Never describe it as
"pausing every agent" or "global ESTOP".

Covered new-work seams (refused when engaged):
- coordination task activation (`ready`->`working` dispatch only; in-flight
  `working`->`working` resume/reclaim/takeover is continuation and stays
  available)
- bgshell launch + resume (NEW spawn only; the stop path is untouched)
- OpenCode TaskTool dispatch (`@subagent` / new child task)
- the dispatch commands `/implement` `/implement-goal` `/research`
  `/solution-brief` (the "begin new delegated work" class)

Deliberately NOT blocked (so status/closeout/recovery/drafting/continuation
stay reachable): ordinary chat, diagnostic tools, ordinary non-dispatch tool
calls by an in-flight root turn, `/resume-task` (it is BOTH a new-dispatch AND
a continuation entry point — the precise `ready`->`working` gate in
`activateCoordinationTask` is the seam, so blanket-blocking the command would
forbid in-flight continuation), and all state/utility/diagnosis/review/planning
commands (including `/write-task`, which creates candidate transport and does
not begin execution).

Return:
- the action taken and the sentinel path
- the resulting state (engaged / disengaged / degraded)
- a one-line reminder of the bounded scope (new-work-only; in-flight untouched)
