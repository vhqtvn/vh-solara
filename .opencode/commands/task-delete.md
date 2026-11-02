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
in `working`, `reported`, or `blocked` state carries work evidence or a closeout
report a coordinator gate may still need, so it is **refused without an explicit
`force`** (`lifecycle_state_protected`) — destroying it would bypass a pending
review, closeout, or decision gate.

A `completed` card enters a **landing-gated retirement path**: it may be retired
as done ONLY when a reachable commit carrying the exact `Task-Card: <card-id>`
trailer is present (the landing-proof contract,
`docs/coordination/RECORD_LIFECYCLE.md`). The verifier is a reachability check
over all branch tips (`git log --branches --fixed-strings --grep=Task-Card:
<card-id>` ≥ 1), never object existence — a reflog-only / orphaned commit does
NOT count. With a reachable trailer the card is deleted normally; without one the
retirement is refused (`landing_not_confirmed`) and the card + report directory
survive. This is the 2026-08-07 lesson made mechanical: never retire a `completed`
card on review approval alone while the commit may yet fail to land.

Landing proven is necessary but not sufficient: retirement also runs the
**retention-preservation gate** (owner-approved 2026-10-25; v3
item-enumerated contract 2026-10-27). Retirement deletes the card AND its
report directory — the last local copy of decision-class knowledge (owner
authorizations, materially-rejected alternatives, non-approve review
verdicts, measured outcomes) — so after the landing proof the v3 gate
checks, in order: (1) the stored `decision_record` is structurally sound;
(2) the INVENTORY BASELINE holds — every decision item currently on the card
(every non-empty owner note, every non-empty `open_questions` entry,
`measured_outcome`, and NON-APPROVE `last_review` / `task_reviewed` signal —
a review that
resolved the card to `completed` is a process record) has a declared slot
(a post-closeout addition is a new-item mismatch and refuses; removals do
NOT remove their slots — deletion cannot launder preservation); and (3)
every declared slot's carrier is committed, branch-reachable, and contains
the card-id anchor AND that item's handle together (verbatim line, or the
canonical `decision-item: <task-id>#<item-id> (<disposition>)` label). A
carrier containing only the card id satisfies NOTHING. Working-tree content
and local-report prose never count. The remedy for a mismatch is the
sanctioned ADD-ONLY re-closeout amendment (stored slots verbatim + fresh
slots for new items). Legacy completed cards without a `decision_record`
— and stored legacy version-1 (v1/v2) records — follow the compatibility
rule: refused only when decision items are present on the card. See
`docs/coordination/RECORD_LIFECYCLE.md` → "Retention preservation".

Task id (exactly one explicit id):
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` (when one exists) for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not chase or fail when it is absent, and do not rediscover these from scratch when it is present.
- git mutations must flow through the `committer` agent via the gated-commit protocol **where `core/gated-commit` is selected**; on profiles without it, automated committing is unavailable — preserve the work, report the missing route, and request separately-authorized activation or operator handling (`.opencode/docs/git-execution-routing.md` → "Capability condition"). Load the `gated-commit` skill for details.
- accept exactly ONE explicit task id from `$ARGUMENTS`. Reject before calling the tool if the input is:
  - missing or empty
  - a wildcard or glob (`*`, `?`, brackets)
  - a selector, comma-list, or "all"-style batch
  - whitespace-separated (spaces, tabs — these would silently slugify to a *different* single id)
  - path-like (`/`, `\`, `..`)
  - more than one id
- before calling the tool, surface what will be destroyed so the operator can confirm intent: read the task card (the card file, or its summary via `list_coordination_tasks`) and display the **task id, title, status, active session alias, and the report directory path**. Deletion is irreversible — the operator must be able to see what is being destroyed *before* the tool runs. This pre-removal display is the confirmation complement to the post-removal `removed` summary printed after the call. (For a malformed card the display degrades to "card exists at <path> but could not be parsed"; still surface the path and id.)
- the optional trailing token `force` (and ONLY the literal token `force`) is an explicit destructive override for a card protected by the active-owner guard, the in-flight lifecycle guard, the `completed` landing gate, OR the retention-preservation gate. `force` is **emergency-only** — it bypasses the landing check (so a `completed` card with no reachable trailer is destroyed without proof of landing) and the preservation check (so unpromoted decision-class content is destroyed with it; the result's `destructive_warning` names exactly what). It is NOT the ordinary `completed`-cleanup route: the ordinary route is for the work to land under a `Task-Card:` trailer, its decision record to resolve, and then retire. Surface what will be destroyed (including any closeout report a coordinator gate may still need) and confirm intent before passing `force`.
- call `plan_state` with:
  - `operation: delete_coordination_task`
  - `task_id: <the single explicit id>`
  - `force: true` ONLY when the operator explicitly supplied the `force` token; otherwise omit it (defaults to false)
  - the current session is passed by the dispatcher automatically
- do NOT auto-retry. If the tool returns a structured refusal, render it verbatim and stop:
  - `refusal.code === "active_working_task"` — an actively-owned working card; the operator must decide whether to re-run with an explicit `force`.
  - `refusal.code === "lifecycle_state_protected"` — a card in `working` (stale, no active owner), `reported`, or `blocked` state whose report evidence a coordinator gate may still need. (In-flight protection is NOT weakened by the completed-retirement path: these statuses are refused EVEN IF a landing commit appears.)
  - `refusal.code === "landing_not_confirmed"` — a `completed` card whose landing is not proven: no reachable commit carries the exact `Task-Card: <card-id>` trailer, or the verifier could not read git history (`refusal.reason` is `no_trailer_match` or `verifier_unavailable`; `refusal.query` names the exact command). The remedy is to ensure the work landed on a branch under the trailer, or to re-run with `force` ONLY for genuine legacy/emergency cleanup.
  - `refusal.code === "decision_record_unresolved"` — a `completed`, landed card whose declared slots do not resolve against committed, branch-reachable git state (`refusal.problems` names each missing/uncommitted/unreachable slot, incl. `anchor_missing` / `handle_not_in_carrier` / `revision_not_reachable` / `path_never_committed`), or whose stored record is structurally degraded. The remedy is to promote the content (commit the decision content / commit the durable file carrying the card-id anchor + the item's handle or label) — NOT force.
  - `refusal.code === "decision_content_unpromoted"` — decision items on the card have no declared slot (a post-closeout addition such as a blocked review, a routine/empty inventory with items present, a legacy card with no decision_record, or a decision-bearing legacy version-1 record; `refusal.items` names them). The remedy is the sanctioned ADD-ONLY re-closeout amendment (stored slots verbatim + fresh slots for the new items), or `force` ONLY for genuine emergency cleanup.
  Re-running with `force` is always a separate, deliberate invocation.
- print the returned `removed` summary (task id, title, status, malformed flag, whether the card and report directory were removed). For a FORCED completed retirement the result also carries `decision_content_destroyed` + `destructive_warning` naming the decision-class content (current items + declared slots) that was destroyed — surface that warning verbatim to the operator.

Return:
- task id
- whether the card was removed and whether the report directory was removed
- the card's last-known title and status (or `malformed: true` if the card could not be parsed)
- if the card was protected (actively owned or lifecycle-guarded) and `force` was not supplied, the structured refusal and the explicit instruction that re-running with `force` is a separate deliberate action

For git operations, follow `.opencode/docs/git-execution-routing.md` — including its "Capability condition" section (on profiles without `core/gated-commit` selected, automated committing is unavailable: preserve the work, report the missing route, and request separately-authorized activation or operator handling).
