# OpenCode Session-Scoped Plan State

This is the repo-local v2 daily-driver workflow for OpenCode planning and implementation.

It replaces a single shared `approved-plan.md` with:
- session-scoped approved plans keyed by real OpenCode `sessionID`
- session-scoped human aliases such as `image-lane-audit`
- session-scoped stable task contracts that preserve the original user request
- optional workstream-scoped local memory for cross-session themes such as restructures or skill design
- session-scoped draft files under `.opencode/plans/`
- session-scoped memory files and checkpoints under `.opencode/state/sessions/<alias>/memory/`
- session-scoped artifact manifests under `tmp/agent-runs/<alias>/`
- a no-arg `/implement` flow once the session has a resolvable approved plan

## What problem this solves

- concurrent OpenCode sessions in the same repo do not collide on one mutable plan pointer
- you can bind a session alias once and keep using it through the whole session
- long-lived themes can persist across many sessions without polluting baseline instructions or one session alias
- plan drafting, approval, adoption, and implementation stay local-file-based and human-readable
- the original user contract survives long sessions separately from evolving plans and checkpoints
- the workflow survives long sessions because compaction gets the task contract, the exact final-response format when present, active alias, active workstream, active plan, checkpoints, recent decisions, and top todos

## Final loading model

Repo-local OpenCode extensions live in the standard folders:

- `.opencode/tools/`
- `.opencode/plugins/`
- `.opencode/commands/`
- `.opencode/agents/`

The source of truth is:

- `plan_state` tool: [`.opencode/tools/plan-state.js`](./tools/plan-state.js)
- session continuity plugin: [`.opencode/plugins/session-state.js`](./plugins/session-state.js)
- shell policy plugin: [`.opencode/plugins/shell-guard.js`](./plugins/shell-guard.js)
- coordination hint plugin: [`.opencode/plugins/coordination-hints.js`](./plugins/coordination-hints.js)

The session plugin does not register the tool again. Tool loading and plugin loading are kept separate.

## Tool and plugin responsibilities

`plan_state` is responsible for:
- binding a human session alias to the current OpenCode `sessionID`
- binding an active workstream for cross-session themes
- clearing the active workstream binding without deleting workstream files
- saving approved session plans
- listing approved session plans
- adopting a plan
- resolving the plan for `/implement`
- saving and reading drafts
- approving drafts into the current session plan namespace
- initializing session memory files and the repo-scoped run directory
- initializing workstream memory files under `.opencode/state/workstreams/<slug>/` without overwriting meaningful existing content by default
- updating or appending workstream memory files under `.opencode/state/workstreams/<slug>/`
- saving and reopening the stable task contract
- saving and reopening checkpoints
- appending durable decision-log entries
- saving handoff packets
- recording temporary artifacts and cleaning disposable ones
- batch-resolving repo path references into resolved-context.md
- batch-recording multiple artifacts in one call
- maintaining the local coordination task registry under `.local/coordinator/`
  with task-card create/prepare/read/list/resume/closeout/review operations

`session-state` plugin is responsible for:
- initializing binding metadata on `session.created`
- injecting `OPENCODE_SESSION_ID` and `OPENCODE_CWD` into shell environments
- adding alias, active workstream, task-contract summary, exact final-response format when present, active plan summary, session/workstream memory summaries, checkpoint summaries, and top todos into compaction context

`shell-guard` is responsible for:
- allowing a narrow read-only shell surface for exploration
- requiring `vh-agent-harness ...` for everything outside that narrow read-only surface

`coordination-hints` is responsible for:
- watching `session.diff` and surfacing non-blocking local hints after edits
- warning when a code file crosses the large-file threshold during a turn
- reminding the user when coordination surfaces or backlog state were edited
- warning when one turn mixes coordination-surface edits with product-code edits

## Session naming and scoping

Identity comes from OpenCode itself, not tty or pid heuristics.

- `/session-name image-lane-audit` binds the current OpenCode `sessionID`
- the alias is normalized into a safe local namespace
- child sessions can inherit the parent alias and active workstream through the session plugin

The alias is human-facing. The `sessionID` is the actual concurrency boundary.

Workstreams are theme-facing. A single workstream may span many sessions. Use separate session aliases for separate tasks, and reuse one workstream when those tasks contribute to the same long-lived theme.

## Session-start -> Draft -> Approve -> Implement flow

Recommended startup path for non-trivial work:

```text
/session-start image-lane-audit
/task-contract-save
/draft-plan manifest-fix
/approve-plan manifest-fix
/implement
```

The startup command creates durable memory files, a stable task contract, a kickoff checkpoint, and `tmp/agent-runs/<alias>/` before the main task gets large enough for compaction to matter.

If the task belongs to a long-lived theme that should survive many sessions, bind a workstream after session start:

```text
/workstream-start project-restructure
```

After the workstream exists, prefer targeted updates:

```text
/workstream-update
```

## Skills

Repo-local skills are optional helpers, not guaranteed automatic behavior.

- if a task depends on a skill, name it explicitly in the prompt, task contract, or plan
- keep the skill catalog in `docs/ai/opencode-skills.md` as read-when-relevant guidance rather than baseline always-loaded context

## Draft -> Approve -> Implement flow

Recommended path:

```text
/session-name image-lane-audit
/draft-plan manifest-fix
/approve-plan manifest-fix
/plans
/adopt-plan 2026-04-03T14-22-10-manifest-fix
/implement
```

If the plan is already approved in the current conversation, skip the draft step:

```text
/session-name image-lane-audit
/plan-save manifest-fix
/implement
```

`/implement` resolves plans in this order:
1. explicit id or unique prefix passed to `/implement`
2. adopted plan for the current session
3. latest approved plan in the current session
4. short failure with candidate plans

## Where state is stored

```text
.opencode/state/
  session-bindings/
    <session-id>.json
  sessions/
    image-lane-audit/
      index.json
      memory/
        brief.md
        task-contract.md
        task-contract.json
        resolved-context.md
        open-questions.md
        decision-log.md
        artifacts.json
        checkpoints/
          2026-04-10T14-10-00-kickoff.md
        handoffs/
          2026-04-10T16-40-00-follow-up.md
      plans/
        2026-04-03T14-22-10-manifest-fix.md
  workstreams/
    project-restructure/
      index.json
      brief.md
      next-slice.md
      open-questions.md
      rejected-options.md
      links.md
.opencode/plans/
  image-lane-audit/
    manifest-fix.md
tmp/
  agent-runs/
    image-lane-audit/
      manifest.json
      eval/
      logs/
      scratch/
      exports/
.local/
  coordinator/
    tasks/
      task-2026-04-29T12-00-00-queue-audit.json
    reports/
      task-2026-04-29T12-00-00-queue-audit/
        2026-04-29T12-30-00-closeout.md
    dashboards/
    scratch/
```

Approved plan files use frontmatter like:

```yaml
---
id: "2026-04-03T14-22-10-manifest-fix"
title: "Manifest Fix"
session_name: "image-lane-audit"
status: "approved"
created_at: "2026-04-03T14:22:10Z"
cwd: "/abs/path/to/repo"
session_id: "sess_abc123"
---
```

Draft files use frontmatter like:

```yaml
---
slug: "manifest-fix"
title: "Manifest Fix"
session_name: "image-lane-audit"
status: "draft"
created_at: "2026-04-03T14:18:00Z"
updated_at: "2026-04-03T14:20:00Z"
cwd: "/abs/path/to/repo"
session_id: "sess_abc123"
---
```

Session drafts under `.opencode/plans/` are local workflow state and are ignored by git. If a plan needs to become durable repo documentation, move or rewrite it into committed docs intentionally.

Session memory files under `.opencode/state/sessions/<alias>/memory/` are repo-local recovery aids for OpenCode. They are not durable product documentation and should stay concise. Bulky outputs belong under `tmp/agent-runs/<alias>/` and should be cleaned when the task is complete.

The local coordination task registry under `.local/coordinator/` is also
repo-local and gitignored. Use it for coordinator transport and resumable local
task cards, not as a second committed task ledger. Use `/task-list` as the
coordinator inbox for draft, open, reported, and blocked local tasks before drilling
into one card with `/task-open`. Keep `draft` tasks coordinator-only until they
are promoted with `/task-ready`. Treat `working` tasks as actively owned by their
current session alias unless you explicitly mean to take them over.

Workstream memory files under `.opencode/state/workstreams/<slug>/` are also local workflow state. They exist to preserve cross-session theme context such as restructure plans, skill design, or migration thinking without auto-promoting that material into committed repo instructions.

The task contract is the stable source of truth for:
- mission
- exact user requirements
- must-read files or docs
- must-do phases or steps
- must-not-do constraints
- required outputs and exact filenames when relevant
- exact closeout shape under `Final Response Format` when the user supplies a `Return:` block or numbered final checklist
- required commands or closeout steps

Plans are allowed to evolve as the implementation shape changes. Checkpoints are allowed to evolve as progress changes. The task contract should change only when the user materially changes the request.

Workstreams are different from plans:

- a plan answers what this session should execute
- a workstream answers what this broader theme is still figuring out across sessions
- only the workstream brief and next slice should be candidates for compaction or routine loading
- workstream start/init should preserve meaningful existing files unless an explicit reset is requested
- append/update flows are preferred for open questions, rejected options, links, and incremental next-slice notes

## Shell and read-only policy

Read-only specialists should prefer OpenCode file/navigation tools when available.

When shell inspection is needed, the intended narrow read-only surface is:
- `ls`
- `find`
- `grep`
- `sed -n`
- `head`
- `tail`
- `jq`
- `git` and `git grep`

Avoid `cat` for broad exploration and avoid dumping full files unless explicitly needed.

Anything outside that read-only surface should run through `vh-agent-harness ...`.

## Session continuity and compaction

The repo config makes session behavior explicit:

- `share: manual`
- automatic compaction enabled
- tool-output pruning enabled
- reserved token buffer configured
- watcher ignore covers `.opencode/state/**` and other generated noise

This keeps long sessions durable without loading large noisy docs by default.

## Quick troubleshooting

- `No active OpenCode session alias is bound for this session`:
  run `/session-start <name>` for the full workflow, or `/session-name <name>` for a lightweight bind
- `No active workstream is bound for this session`:
  run `/workstream-start <slug>` or bind one through `plan_state` before trying to write workstream files
- `The session is carrying stale workstream context`:
  run `/workstream-clear` to detach the current session without deleting the workstream itself
- `Draft plan does not exist`:
  verify the slug and the current session alias
- `No approved plan is available in the current session`:
  run `/approve-plan <slug>` or `/plan-save <slug>`
- `Checkpoint or handoff content was lost after compaction`:
  reopen it with `/checkpoint-open` or inspect the task contract and memory files under `.opencode/state/sessions/<alias>/memory/`
- `The agent drifted away from the original user request`:
  reopen the contract with `/task-contract-open`; if the user changed the ask, refresh it with `/task-contract-save`
- temporary outputs are piling up under `tmp/agent-runs/<alias>/`:
  record them in the artifact manifest and run `/job-cleanup`
- `Plan id prefix is ambiguous`:
  rerun `/adopt-plan` or `/implement` with a longer prefix
- helper CLI runs outside OpenCode do not resolve the session:
  pass `--session-id <id>` or set `OPENCODE_SESSION_ID`

## Verification

Syntax and load checks:

```bash
vh-agent-harness exec node --check .opencode/scripts/state-lib.js
vh-agent-harness exec node --check .opencode/scripts/draft-plan.js
vh-agent-harness exec node --check .opencode/scripts/approve-plan.js
vh-agent-harness exec node --check .opencode/scripts/session-bind.js
vh-agent-harness exec node --check .opencode/scripts/session-current.js
vh-agent-harness exec node --check .opencode/scripts/plan-save.js
vh-agent-harness exec node --check .opencode/scripts/plan-list.js
vh-agent-harness exec node --check .opencode/scripts/plan-adopt.js
vh-agent-harness exec node --check .opencode/scripts/plan-resolve.js
vh-agent-harness exec node --check .opencode/scripts/verify-session-state.js
vh-agent-harness exec node --check .opencode/tools/plan-state.js
vh-agent-harness exec node --check .opencode/plugins/session-state.js
vh-agent-harness exec node --check .opencode/plugins/shell-guard.js
vh-agent-harness exec node --check .opencode/plugins/coordination-hints.js
vh-agent-harness exec node --check .opencode/scripts/coordination-hints-lib.js
vh-agent-harness exec node --check .opencode/scripts/verify-coordination-hints.js
vh-agent-harness exec node .opencode/scripts/verify-coordination-hints.js
vh-agent-harness exec pytest tests/unit/scripts/test_verify_coordination_hints.py
```

End-to-end session and draft flow:

```bash
vh-agent-harness exec node .opencode/scripts/verify-session-state.js --prefix demo-session-state
```

That verifier now exercises:
- draft -> approve -> adopt -> resolve
- session memory initialization
- workstream initialization, non-destructive reopen, append/update, clear, and overview
- task contract save/read plus compaction summary injection
- kickoff checkpoint save/read
- decision-log append
- handoff save
- child-session inheritance of alias and active workstream
- artifact record + cleanup
- resolve_paths batch path resolution
- record_artifacts batch artifact registration

Manual CLI spot checks:

```bash
vh-agent-harness exec node .opencode/scripts/session-bind.js --session-id demo-session-a image-lane-audit
vh-agent-harness exec node .opencode/scripts/draft-plan.js --session-id demo-session-a manifest-fix <<'EOF'
1. Update manifests.
2. Verify routing.
EOF
vh-agent-harness exec node .opencode/scripts/approve-plan.js --session-id demo-session-a manifest-fix
vh-agent-harness exec node .opencode/scripts/plan-adopt.js --session-id demo-session-a 2026-
vh-agent-harness exec node .opencode/scripts/plan-resolve.js --session-id demo-session-a --json
```
