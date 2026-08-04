---
description: Destroy one local coordinator task card and its report directory (irreversible hard removal, not a lifecycle status)
agent: build
subtask: false
---

Destroy one unpromoted (or terminal, gate-already-passed) transport task card
and its local report directory.

This is an **irreversible local transport disposal** — the card and its report
directory cease to exist. It is destructive hard removal, NOT a lifecycle
transition: it does NOT mark the task cancelled, does NOT create a tombstone or
archive, does NOT edit `docs/planning/backlog.md`, and must NOT be used to
bypass a promotion, review, or closeout gate.

A card in `draft`, `ready`, or `cancelled` state is freely disposable without
`force` (never worked, or terminal with the review gate already passed). A card
in `working`, `reported`, `blocked`, or `completed` state carries work evidence
or a closeout report a coordinator gate may still need, so it is **refused
without an explicit `force`** — destroying it would bypass a pending review,
closeout, or decision gate.

Task id (exactly one explicit id):
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- accept exactly ONE explicit task id from `$ARGUMENTS`. Reject before calling the tool if the input is:
  - missing or empty
  - a wildcard or glob (`*`, `?`, brackets)
  - a selector, comma-list, or "all"-style batch
  - whitespace-separated (spaces, tabs — these would silently slugify to a *different* single id)
  - path-like (`/`, `\`, `..`)
  - more than one id
- before calling the tool, surface what will be destroyed so the operator can confirm intent: read the task card (the card file, or its summary via `list_coordination_tasks`) and display the **task id, title, status, active session alias, and the report directory path**. Deletion is irreversible — the operator must be able to see what is being destroyed *before* the tool runs. This pre-removal display is the confirmation complement to the post-removal `removed` summary printed after the call. (For a malformed card the display degrades to "card exists at <path> but could not be parsed"; still surface the path and id.)
- the optional trailing token `force` (and ONLY the literal token `force`) is an explicit destructive override for a card protected by the active-owner guard or the pending-gate lifecycle guard. `force` must be deliberate — surface what will be destroyed (including any closeout report a coordinator gate may still need) and confirm intent before passing it.
- call `plan_state` with:
  - `operation: delete_coordination_task`
  - `task_id: <the single explicit id>`
  - `force: true` ONLY when the operator explicitly supplied the `force` token; otherwise omit it (defaults to false)
  - the current session is passed by the dispatcher automatically
- do NOT auto-retry. If the tool returns a structured refusal, render it verbatim and stop:
  - `refusal.code === "active_working_task"` — an actively-owned working card; the operator must decide whether to re-run with an explicit `force`.
  - `refusal.code === "lifecycle_state_protected"` — a card in `working` (stale, no active owner), `reported`, `blocked`, or `completed` state whose report evidence a coordinator gate may still need.
  Re-running with `force` is always a separate, deliberate invocation.
- print the returned `removed` summary (task id, title, status, malformed flag, whether the card and report directory were removed).

Return:
- task id
- whether the card was removed and whether the report directory was removed
- the card's last-known title and status (or `malformed: true` if the card could not be parsed)
- if the card was protected (actively owned or lifecycle-guarded) and `force` was not supplied, the structured refusal and the explicit instruction that re-running with `force` is a separate deliberate action

For git operations, follow `.opencode/docs/git-execution-routing.md`.
