---
description: Create or update a local coordination task card under .local/coordinator/tasks/
agent: build
subtask: false
---

Create or update a local coordination task card.

Task details:
$ARGUMENTS

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- call `plan_state` with `operation: current_session` so the result can record whether a coordinator session alias is already bound
- extract or infer a concrete task card from the latest user request and current conversation:
  - optional `task_id`
  - optional `status`: `draft | ready`
  - `title`
  - `task_type`: `implementation | study | research | docs | verification`
  - `coordination_mode`: `short | medium | long`
  - `primary_lane`
  - optional draft refinement fields:
    - `rough_scope`
    - `open_questions`
    - `ready_criteria`
  - `files_in_scope`
  - `constraints`
  - `non_goals`
  - `success_criteria`
  - `validation_plan`
  - optional `report_envelope`; default from mode when omitted:
    - `short -> minimal`
    - `medium -> standard`
    - `long -> synthesis`
  - optional `backlog_id`
  - optional `workstream_slug`
  - optional `dependencies`
  - optional `owner_notes`
    - for DEFER / p2-followup / review-defer conditional candidates, the Notes-prefix provenance lines (`source:...`, `trigger:...`, `studied:...`) MUST go here, one string per array element — `check-defer-triggers.mjs` reads them from `owner_notes[]` (NOT from the file body). `trigger:path_touched(<literal-repo-relative-path>)` is the most common predicate; the path is matched as a literal against `git diff --name-only` (no globbing). Create these advisory candidates as `status: draft` (not `ready`): their trigger has not fired and they lack the file scope + validation plan `ready` requires.
  - optional `next_action`
- if the inferred task is a new `task_type: research`, stop and tell the user to use `/research` instead of `/write-task`
  - `/write-task` remains the generic entrypoint for `implementation`, `study`, `docs`, and `verification`
  - for existing research cards, use `/task-update` for broader metadata edits or `/task-repair` for incomplete research-contract fields
- for `draft` tasks, require meaningful refinement material (`rough_scope`, `open_questions`, or `ready_criteria`)
- for `ready` tasks, require a real file scope and a real validation plan; do not save a vague execution card
- note: if this task will cross BUILD-READY (`draft → ready` via `/task-ready`), an F3 design-readiness envelope will be required at promotion — begin gathering provenance-bearing evidence for the ownership-hazards survey now (fabricated evidence is prohibited; the envelope binds to the current design via `design_digest`)
- **Intake bar (admission BEFORE filing).** A card is filed only when it passes admission — drain rules do not stop re-growth (the holding area is a drain, not a reservoir). Before `save_coordination_task`, run the `resolve-first` triage and require ALL of:
  - **Precise question** — ticket-ready, not fog (a finding is ticket-ready when you can state the question precisely now, even if blocked; fog is in-scope but not yet specifiable).
  - **Concrete area + file/subsystem scope** — names the repo boundary and the files/paths it concerns.
  - **Validation approach** — how "done" will be checked.
  - **An ADMITTED BLOCKER or reason the work cannot be resolved now** — for deferred work, why it cannot be done in the current session.
  - **A ground-truth-derivable trigger** — when deferral is trigger-dependent, a predicate the checker can re-derive from repo state (`trigger:path_touched(<path>)`, `trigger:after_tag(<tag>)`, …).
  - **Provenance** — `source:review-defer` / `source:p2-followup` / etc., plus `studied:YYYY-MM-DD`.
  - **Dedup** — no materially-equivalent open card already exists (surface overlaps explicitly instead of burying them).
- **Dispositions at intake** (apply before filing):
  - **resolvable-now** → resolve it; do NOT file a card.
  - **decision-derivable-now** → drive to a verdict; do NOT defer.
  - **real deferred work meeting the bar** → file as `status: draft` (NOT `ready`) with the Notes-prefix provenance in `owner_notes[]` (the `trigger:` grammar line is parsed from `owner_notes[]`).
  - **duplicate / fog** → collapse into the existing card, or discard.
- call `plan_state` with:
  - `operation: save_coordination_task`
  - `task_payload`: a JSON object with the task-card fields
- if overlaps are returned, call them out explicitly instead of burying them in prose
- keep the return compact; if the task is `short`, stop at one concrete next command instead of continuing with execution planning in the same coordinator response

Return:
- task id and local path
- status and report envelope
- files in scope
- overlap warnings, if any
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
