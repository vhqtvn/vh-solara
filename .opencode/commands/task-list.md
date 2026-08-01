---
description: List the coordinator inbox for local task cards under .local/coordinator/
agent: build
subtask: true
---

List the local coordination task inbox.

Selector:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- first call `plan_state` with `operation: current_session`
- determine the status filter from `$ARGUMENTS`:
  - default to `draft,ready,working,reported,blocked`
  - if the user explicitly asks for `all`, include `completed,cancelled` too
  - if the user names statuses, pass only those statuses
- call `plan_state` with:
  - `operation: list_coordination_tasks`
  - `task_statuses_csv`: the resolved comma-separated statuses
- summarize the inbox in coordinator order:
  - `reported` and `blocked` first
  - then `working`
  - then `ready`
  - then `draft`
- for each task, call out:
  - task id and title
  - status, mode, lane, and report envelope
  - active session owner when a task is currently `working`
  - draft refinement context when the task is still `draft`
  - backlog/workstream links when present
  - latest report summary when present
  - next action and next recommended command
  - the explanatory recommendation note whenever extra operational context matters
- when the response carries a `quarantine` array (degraded cards), render a prominent "Degraded coordination-task cards" section BEFORE the healthy inbox:
  - for each `quarantine` entry: list `card_id`, repo-relative `path`, and the `offending_fields` (and `problems` when extra context helps)
  - state plainly that these cards failed read-path validation and were REFUSED at the action boundary — do NOT recommend any lifecycle transition (`/task-ready`, `/resume-task`, etc.) for them
  - the correct next action for a degraded card is inspection or repair (open the stored card at the listed path), never promotion
  - note that healthy cards remain fully available below and that `healthy_total` / `healthy_status_counts` exclude the degraded ones
  - a degraded card may still appear in the `tasks` list with `degraded: true` and a `next_recommended_note` pointing at inspection — this is intentional (compat) and is NOT a signal to act on it
- if the list is empty, say so plainly and suggest `/write-task` only when the user is clearly trying to start a new durable local slice

Return:
- session alias and active workstream, if any
- status counts (prefer `healthy_status_counts` for a trusted projection; `status_counts` includes degraded cards)
- degraded-card quarantine section, when present (card id, path, offending fields)
- attention-needed tasks first
- whether the inbox is empty
- next recommended note, if any

For git operations, follow `.opencode/docs/git-execution-routing.md`.
