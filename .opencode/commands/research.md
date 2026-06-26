---
description: Prepare a durable research task with source policy, artifact target, and long-run coordination context
agent: build
subtask: false
---

Prepare a research task that can survive long-running work, interruption, and
later review.

Research request:
$ARGUMENTS

Workflow:
- call `plan_state` with `operation: current_session`
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths, helper functions, container names, env conventions, and API response shapes before acting — do not rediscover these from scratch.
- git mutations must flow through the `committer` agent via the gated-commit protocol. Load the `gated-commit` skill for details.
- before raising any previously-blocked topic, check `.local/cleared-assumptions.yaml`. `/research` often runs before any session task contract exists, so consult the cleared-assumptions ledger directly at this stage. If the operator has already cleared an assumption (for example, a license concern, a dependency constraint, or a tooling limitation), do not re-raise it as a new blocker.
- if a different session alias is already bound and it is clearly carrying an
  unrelated execution task, stop and tell the user to switch to the coordinator
  session or a fresh planning session before preparing long-running research
- extract or infer a concrete research task from the latest user request and the
  current conversation:
  - optional `task_id`
  - optional `status`: `draft | ready`
    - prefer `ready` when the request already has a concrete file scope,
      success criteria, and validation plan and the user wants execution to
      start next
  - `title`
  - `task_type: research`
  - `coordination_mode`: `short | medium | long`
    - prefer `short` for one-session evidence gathering
    - prefer `medium` for several subquestions or one later synthesis pass
    - prefer `long` when the work should survive interruption, many sources, or
      repeated follow-ups
  - `primary_lane: research`
  - `research_question`: the exact question being answered
  - `source_policy`:
    - `repo_only`
    - `web_repo`
    - `restricted_sites`
  - optional `source_allowlist`: domains or source families to prefer or
    restrict to
  - `desired_artifact_type`:
    - `sources` for evidence-first work
    - `decision` only when the user explicitly wants comparison or recommendation
  - optional `target_artifact_path` under `researches/sources/` or
    `researches/decisions/`
  - optional draft refinement fields:
    - `rough_scope`
    - `open_questions`
    - `ready_criteria`
  - `files_in_scope`: the repo docs, codepaths, and durable target paths that
    define or receive the research
  - `constraints`
  - `non_goals`
  - `success_criteria`
    - include explicit citation quality, contradiction audit, and durable-output
      expectations
  - `validation_plan`
    - include at least one check for source quality or evidence coverage
  - optional `report_envelope`; default from mode when omitted
  - optional `backlog_id`
  - optional `workstream_slug`
    - if mode is `long` and this is omitted, default it to the eventual task id
  - optional `dependencies`
  - optional `owner_notes`
- for `draft` research tasks, require meaningful refinement material before
  saving
- for `ready` research tasks, require a concrete file scope, success criteria,
  and validation plan; do not save a vague execution card
- if `target_artifact_path` is omitted:
  - default to `researches/sources/YYYY-MM-DD-<topic>-sources.md` when
    `desired_artifact_type` is `sources`
  - default to `researches/decisions/YYYY-MM-DD-<topic>-decision.md` when
    `desired_artifact_type` is `decision`
- call `plan_state` with:
  - `operation: save_coordination_task`
  - `task_payload`: a JSON object with the task-card fields
- if overlaps are returned, call them out explicitly
- if the saved task is `long`:
  - choose or reuse a `workstream_slug`
  - call `plan_state` with:
    - `operation: bind_workstream`
    - `workstream_name: <workstream_slug>`
  - call `plan_state` with:
    - `operation: init_workstream_memory`
    - `workstream_name: <workstream_slug>`
    - `brief_body`: a compact research brief with question, source policy,
      desired artifact, target path, and stop conditions
    - `next_slice_body`: the proposed research plan or first source-gathering
      pass
    - `open_questions_body`: unresolved scope or evidence gaps
    - `links_body`: the target artifact path, allowlisted domains, and key repo
      docs to reopen
  - explain that long research should checkpoint after plan approval and after
    each major source batch
- do not activate the task yet
- do not auto-write `researches/` artifacts from this command
- if the task is `short` and `ready`, stop after one concrete handoff
  (`/resume-task <id>`) instead of appending more execution planning unless the
  user explicitly asks for a subagent prompt
- recommend `/resume-task <id>` for execution in a fresh session once the task
  is ready

Return:
- task id and local path
- status and report envelope
- research question
- source policy and allowlist
- desired artifact type and target artifact path
- workstream binding, if created
- overlap warnings, if any
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
