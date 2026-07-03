<!-- CORE -->
<!--
  OWNERSHIP: managed (generic core).
  This file ships with the harness starter. It contains ONLY generic harness
  rules that apply to any repo using the harness. The consuming project's
  domain mission, architecture, and product rules live in AGENTS.mission.md
  (an overlay). At install time the two are concatenated into a single
  AGENTS.md: core first, then mission.
  A consuming project MUST NOT edit this file — extend via AGENTS.mission.md.
-->

# Agent Harness — Core Rules

## Term contract (sacred)

**"Agent harness" is a HANDLE ONLY.** Whenever the term is used it MUST carry
this definition:

> An **agent harness** is a repo-resident system of rules, memory,
> coordination, safety gates, and reusable workflows that makes AI coding
> agents — and the humans operating them — behave predictably and keep working
> across context resets and session boundaries.

It has **six layers**:

1. **Prescriptive** — codified must/must-not rules.
2. **Cognitive** — state surviving context resets.
3. **Coordination** — routing/tracking/handoff of work.
4. **Safety** — hard guarantees enforced regardless of agent intent.
5. **Capability** — reusable roles & workflows.
6. **Environment** — the runtime they execute in.

This definition travels with the handle **forever** — in every `AGENTS.md`,
overlay doc, and generated artifact. Do not let the handle drift to mean
something narrower.

---

`AGENTS.md` is the primary local rule file for this repository. Keep it authoritative and concise. Use the referenced docs for detailed procedures instead of duplicating long checklists here. When operating through OpenCode, also honor `opencode.jsonc` permissions and the selected subagent prompt.

<!-- The line below is filled by the project overlay (AGENTS.mission.md). -->
<!-- PROJECT: one-line description of what this repository builds. -->

## Extending the harness

The `.opencode/` tree and `opencode.jsonc` are **GENERATED** from
`.vh-agent-harness/` plus the embedded corpus. Never hand-edit a managed file
under `.opencode/` — any edit there vanishes on the next
`vh-agent-harness update`. Make your change under `.vh-agent-harness/` instead.

Do NOT use OpenCode's built-in `customize-opencode` skill to change the harness
— use an overlay pack. Only invoke `customize-opencode` when you have a specific
reason unrelated to the generated tree.

Overlays are the extension unit. A pack at
`.vh-agent-harness/overlays/<pack>/` carries `agents/`, `commands/`, `skills/`
plus `opencode-append.jsonc` (deep-merged into the rendered `opencode.jsonc`),
and optionally `permission-pack.jsonc` and `callable-graph-snippet.md`.

Select a pack by listing its name under `overlays:` in
`.vh-agent-harness/vh-harness-profile.yml`, then run `vh-agent-harness update`
(preview with `--dry-run` first).

When unsure, run `vh-agent-harness guide` first. Run `/harness` for the full
add-an-agent / add-command / add-skill recipe and the overlay anatomy.

## Must read

<!-- CORE: generic harness + coordination docs. -->
<!-- PROJECT: add the project's own domain docs here (product brief, architecture, delivery rules, etc.). -->

- `docs/coordination/README.md` for cross-boundary ownership, handoffs, blocker rules, and prompt/closeout coordination
- `docs/coordination/TASK_MODES.md` and `docs/coordination/RUNTIME_MODEL.md` when a task may span multiple sessions, several subagent reports, or a local coordination runtime

## Read when relevant

- `docs/ai/opencode-session-workflow.md` before starting substantial OpenCode work that may span multiple turns, evaluations, or handoffs
- `docs/ai/opencode-prompt-guide.md` before writing non-trivial prompts so they include task type, settled assumptions, contradiction audit, expected files, and closeout expectations
- `docs/ai/opencode-memory-model.md` when shaping or changing agent-memory conventions, workstream memory, or local/private OpenCode state
- `docs/coordination/README.md` when shaping cross-boundary ownership, handoffs, blocker rules, or prompt/closeout coordination
- `docs/coordination/TASK_MODES.md` and `docs/coordination/RUNTIME_MODEL.md` when a task may span multiple sessions, several subagent reports, or a local coordination runtime
- `researches/AGENTS.md` when creating or updating durable comparative research material, source packets, or option memos
- the relevant `researches/decisions/` memo when rethinking the coordinator-session workflow, local task registry, or future external coordinator/runtime options
- the relevant `researches/decisions/` memo when designing or implementing `/write-task`, `/task-ready`, `/task-update`, `/task-repair`, `/task-list`, `/task-open`, `/resume-task`, `/task-closeout`, or `/task-review`
- the relevant `researches/decisions/` memo when designing or changing the repo's durable research workflow, source-packet conventions, long-running research setup, or `/research` entrypoint
- the relevant `researches/decisions/` memo when designing browser-driven external research providers, provider polling/check status flows, or `.local/coordinator/research-runs/`
- `.local/AGENTS.md` when working in local-only operator state such as `.local/coordinator/`, `.local/config/`, or `.local/ssh/`
- `docs/ai/opencode-skills.md` when the task depends on a repo-local OpenCode skill or when you need to know which local skill should be invoked explicitly
- `docs/ai/shell-execution.md` before planning or running shell commands
- `docs/ai/temprary-files.md` before generating temporary artifacts or run-specific outputs
- `docs/planning/current-index.md` when a prompt references "the current plan" or supplies dated planning/checkpoint paths that may have drifted
- task-specific durable guidance under `docs/ai/` when a boundary already has its own playbook
- `opencode.jsonc` when operating through OpenCode and needing the current plan/build permissions, subagents, or command templates
- the matching file under `.opencode/agents/` when handing work to a specific specialist

## Repo-level engineering defaults

- Use clear package boundaries and explicit imports.
- Prefer typed DTOs and repository interfaces over framework-coupled logic.
- Keep the domain/core pure: no network calls, no DB access, no framework imports.
- Lazy-load heavyweight models and external clients.
- Choose the simpler boundary when uncertain.
- Choose deterministic behavior over "smart" behavior.
- Choose testability over flexibility.
- Choose explicit config over hidden magic.
- Choose a stub with a contract over a premature implementation.

<!-- PROJECT: add project-specific engineering defaults (language stack, model/dataset license rules, etc.). -->

## Shell, container, and workspace hygiene

- Run project commands through `harness`. Do not rely on host-level `python`, `pytest`, `npm`, `pnpm`, `yarn`, or `docker compose`.
- The `shell-guard` plugin refuses a list of high-risk patterns (Docker socket access, ad-hoc apt installs, host-key bypass, scp deploys, cloud-provider lifecycle on Terraform-managed resources, raw database writes against protected identity/auth tables, project JWT secrets on the command line). See `docs/ai/shell-execution.md` → "Forbidden patterns". If a deny fires, do not paraphrase the command to evade it — read the rule's `why` and pick the canonical alternative, or surface the situation to the operator.
- For agent-driven shell work, prefer `vh-agent-harness exec <cmd>` and avoid interactive `vh-agent-harness shell` unless a human explicitly asks for it.
- For long-running detached work that may outlive one shell call/session, name the relevant skill explicitly: `gpu-use` for GPU jobs, `bgshell-job` for non-GPU shell jobs (see `docs/ai/opencode-skills.md`).
- Ensure the dev environment is running before containerized commands when required.
- Put transient artifacts under repo-scoped `./tmp/`, never system-level temp paths such as `/tmp`.
- Delete temporary scripts, logs, downloads, and harnesses you created when the task is complete.
- Never commit `./tmp/` contents or ad hoc scratch files unless the change explicitly documents why they are durable and a maintainer has approved it.
- Before committing or closing out work, inspect `git status` and `git diff` so the final state is intentional.

## Command hygiene to avoid permission prompts

Most recurring opencode permission prompts are **not** missing allowlist entries — they come from commands the matcher's safe-parser cannot safely parse, or from non-sanctioned forms. The `shell-guard` parser splits a command into individual `command` nodes and requires **each** to independently match an allowlist entry; an `&&`-chain with even one non-allowlisted verb (e.g. `mkdir`, `python3 -c`, a bare `git branch`) falls back to `ask` or denies. Complex inline quoting (heredocs, deeply nested quotes, brace-groups) can fail safe-parse outright.

Follow these rules to stay on the parsed, sanctioned path:

1. **Use the WRITE TOOL for files — never shell heredocs or redirection.**
   - Good: Write tool → `tmp/plan.json`.
   - Bad: `cat <<'EOF' > tmp/plan.json …`, `printf '…' > tmp/x`, `{ …; } > file`, `cat > file`.
   - Why: heredoc-in-braces + redirection tripped the matcher and caused repeated failed-attempt stalls.

2. **Run SINGLE SIMPLE commands — no `&&`-chains, brace-groups, multi-line `python3 -c`, or inline scripts.**
   - Good: three separate calls, OR a script written to repo `./tmp/` run as the simple form: `vh-agent-harness exec python3 tmp/x.py`, `jq -f tmp/f.jq`, `vh-agent-harness exec bash tmp/x.sh`.
   - Bad: `mkdir -p tmp/x && vh-agent-harness exec python3 -c '…' && jq '{a:.b}' f.json`, `python3 -c "import …; [print(x) for x in …]"`.
   - Why: a chain parses as N commands and each must match the allowlist independently; `mkdir` and inline `python3 -c` never do.

3. **All scratch/temp files go under repo `./tmp/` via the Write tool — never `/tmp` or out-of-repo paths.**
   - Good: Write tool → `tmp/scratch/notes.md`.
   - Bad: writing to `/tmp/x`, `/root/x`, or any out-of-repo path.
   - Why: out-of-repo writes trigger permission `ask` prompts that block agents.

4. **Use sanctioned wrappers for recurring needs — never raw `cat /proc/…` or ad-hoc `mkdir`.**
   - Good: `.opencode/scripts/readonly-scripts.sh gen-uuid`, `.opencode/scripts/readonly-scripts.sh prep-tempdir`.
   - Bad: `cat /proc/sys/kernel/random/uuid`, `mkdir -p .git/commit-gate/`.
   - Why: each wrapper subcommand is a single literal allowlist entry; the raw forms are not.

5. **Git operations route through the `committer` subagent (committer-exclusive gate).**
   - Good: delegate `commit`/stage requests to the `committer` agent, which owns `.opencode/scripts/commit-gate.sh`. Pass ONLY this session's explicit file/path list. A concurrently-dirty working tree is normal during concurrent sessions — do not let unrelated dirty files dominate your handoff; they are mechanically excluded by the private-index gate.
   - Bad: running `commit-gate.sh` / `git add` / `git commit` / `git branch …` / `git checkout` / `git status`-driven cleanup directly from build or coordination.
   - Why: the `git-mutation-bypass` rule denies git mutations outside the committer; improvised gate calls and raw cleanups stall runs. For a stray file another session left dirty that this session does NOT own, the sanctioned in-session unblock is `commit-gate.sh revert <paths>` (restores to HEAD; no lock/CAS/index/ref mutation) — not a commit, not raw git, not the operator escape hatch.

6. **Env vars and `timeout` go INSIDE `vh-agent-harness exec bash -c '...'`, never as a host-shell prefix before `harness`.** A prefix runs on the HOST and never reaches the container — shell-guard now rejects it.
   - Good: `vh-agent-harness exec bash -c 'FOO=bar python -m mymodule'`
   - Bad: `FOO=bar vh-agent-harness exec python -m mymodule` (env set on host, never reaches container; now rejected by shell-guard)
   - `timeout` belongs inside the `bash -c` payload, not as a host prefix: `vh-agent-harness exec bash -c 'timeout 300 pytest'`, not `timeout 300 vh-agent-harness exec pytest`.

7. **Repo-relative paths only — never hardcode absolute `/home/<user>/...` paths.** Always reference files repo-relative (`docs/...`, `tmp/...`, `.opencode/...`) or resolve them from the project root. Hardcoded absolute home-dir paths are the recurring cause of the `external_directory` permission prompts — agents fat-finger the username and the out-of-project path trips the matcher. The `shell-guard` plugin already resolves repo-relative paths against the repo root; matching that convention here kills the noise at the source. See `docs/ai/shell-execution.md` for the enforcement rationale.

**Credentials via env vars or env files, never inline in command strings** — already partially enforced by shell-guard rules; stated here as a cross-cutting principle.

## Testing rules

Every meaningful change should add or update tests.

The `tests/` folder is explicitly organized into three categories. Do not create test files directly in the root `tests/` directory except for shared utilities.

1. **`tests/unit/`**
   - Pure, fast tests mocking external dependencies.
   - Organized by package/boundary.
   - Minimum expected coverage: domain/core, contracts, and the primary business logic.

2. **`tests/integration/`**
   - Tests that verify infrastructure integration or layer handoffs without booting the entire stack.
   - Example: storage materialization, queue handoff.

3. **`tests/e2e/`**
   - Full-stack tests that boot the app's entrypoints and exercise the real service stack.
   - Example: end-to-end request → handler → response flow, endpoint validation.

Execution examples:

```bash
vh-agent-harness exec pytest tests/unit/
vh-agent-harness exec pytest tests/integration/
vh-agent-harness exec pytest tests/e2e/
```

For any substantial boundary change, also update the relevant docs.

## Output expectations for agents

When making changes:
- explain the boundary being changed
- keep diffs focused
- update tests and docs with code changes
- call out tradeoffs briefly
- do not invent completed integrations you did not actually implement

## Document placement rules

- `docs/ai/` is for durable instructions and workflow guidance.
- `docs/checkpoints/` is for dated durable progress snapshots, decisions, or blockers worth committing.
- Do not place run-specific outputs, benchmark dumps, scratch analysis, or temporary notes in `docs/ai/`.
- If an artifact is transient or only useful for the current run, keep it out of git unless the user explicitly asks to commit it.

## OpenCode operating model

- The default primary agent is `coordination`.
- `plan` is disabled as a selectable primary mode (mode: `subagent`, not callable from any primary agent). Use `planner` as a subagent when you want a short execution brief.
- Use the `coordination` primary agent or `/coordination` for direct read-only coordination sessions. Keep `project-coordinator` as the delegated specialist surface for build/plan handoffs.
- **All coding modifications, implementation, research, study, and git operations MUST be delegated to the appropriate subagent.** The coordinator remains strictly read-only. The default target is `build`, which owns the full execution context (file reads, edits, test runs, release); git mutations are delegated to the `committer` agent — load the `gated-commit` skill or see `.opencode/docs/git-execution-routing.md`. When the scope is narrow and clearly bounded, direct delegation to a specialist is acceptable: `commit-message` for reviewed commit message drafting, `researcher` for read-only source gathering, `ship-review` for whole-change audits, etc. The coordinator MUST NOT directly edit source code, run git mutations, write implementation files, or accumulate research detail that belongs in a subagent session.
- For non-trivial OpenCode work, start with `/session-start <slug>` so the session has a stable task contract, durable memory, a repo-scoped run directory, and a kickoff checkpoint before compaction prunes chat history.
- Use `/checkpoint-save <slug>` at major state transitions and `/handoff-save <slug>` before specialist handoffs or pausing long work.
- Treat the task contract as the stable source of truth for mission, required outputs, required commands, and non-goals. Update it only when the user materially changes the task.
- **Return format capture rule**: When a user message contains a `Return:` block, numbered closeout checklist, or any explicit response-shaping instruction, the agent MUST immediately save it into the task contract under `Final Response Format` (or `final_response_format` in JSON) before doing any work. This is the only mechanism that survives compaction. Do not rely on chat history to remember the user's requested output format. If a session is already running when the user adds a return format, run `/task-contract-save` to update the contract.
- Keep small durable state under `.opencode/state/sessions/<alias>/memory/` and bulky disposable outputs under `tmp/agent-runs/<alias>/`. Clean temporary artifacts with `/job-cleanup` when the task is complete.
- When a theme spans many sessions but is not yet durable repo guidance, bind the session to a local workstream under `.opencode/state/workstreams/<slug>/`, keep only the workstream brief and next slice eligible for compaction, and treat workstream start/init as non-destructive unless the user explicitly asks to reset it.
- Treat user-supplied dated paths as hints, not truth. Resolve them to `exact`, `replaced`, or `missing` and record that mapping in session memory.
- Prefer one focused specialist per boundary:
  - `coordination` / `project-coordinator` for cross-boundary lane selection, handoff shaping, and blocker framing
  - `researcher` for read-only repo + web research, source packets, option comparisons, and contradiction audit
  - `debate` for multi-perspective reasoning and creative option comparison using internal debate helpers
  - `planner` for read-only execution briefs
  - `repo-explorer` for read-only repo mapping, path discovery, and snippet-level inspection
  - `docs-steward` for backlog, checkpoints, `AGENTS.md`, and durable repo guidance
  - `commit-message` for reviewed, file-list-scoped commit message drafting without running `git commit`
  - `commit-reviewer` for tiered cascade review of a change slice (config-driven tiered cascade with fail-fast escalation)
  - `ship-review` for final whole-change read-only review before merge or promotion
  <!-- PROJECT: add project-specific specialists here (e.g. domain auditors, builder roles, runtime/registry guardians, deployment roles). -->
- Agent usage guidance:
  - use `researcher` when the task depends on facts: existing patterns, docs, API behavior, version constraints, prior decisions, or contradictions
  - use `debate` only for genuinely hard decisions with multiple plausible approaches; keep it evidence-bound and call `researcher` first when facts are missing
  - use `planner` to turn an agreed direction into a compact execution brief for `build`
  - for high-uncertainty tasks, prefer `researcher -> debate -> planner -> build`; send routine or obvious work directly to `build`
  - when you want that high-uncertainty chain as one read-only compare-and-plan pass, prefer `/solution-brief <question>`
    See `docs/coding-agent-in-research/solution-brief/README.md` for the bounded workflow note and linked research trail.
- For multi-session coordination work, classify the task as `short`, `medium`, or `long` before fanning out. Use `docs/coordination/TASK_MODES.md` and `docs/coordination/RUNTIME_MODEL.md` to decide whether `.opencode/state/` is enough or whether a local runtime layer under `.local/coordinator/` is justified.
- Use `repo-explorer` as a path finder and call-graph tracer first. Ask for exact full file bodies only through an explicit read command when needed.
- For read-only shell inspection, prefer narrow commands such as `ls`, `find`, `grep`, `sed -n`, `head`, `tail`, `jq`, and `git grep`. Avoid `cat` dumps for exploration.
- Prefer the standard command templates under `.opencode/commands/` when they fit the task: `coordination`, `harness`, `write-task`, `research`, `solution-brief`, `task-ready`, `task-update`, `task-repair`, `task-list`, `task-open`, `resume-task`, `task-closeout`, `task-review`, `repo-map`, `read-files`, `draft-plan`, `approve-plan`, `plan-save`, `plans`, `adopt-plan`, `implement`, `implement-goal`, `workstream-start`, `workstream-open`, `workstream-update`, `workstream-clear`, `backlog-cleanup`, `docs-sync`, `ship-review`, and `commit-review`.
- Commit gate rule for every agent/session: before any `git commit` attempt, run `commit-reviewer` (typically via `/commit-review`) on the exact slice, read the reviewer response, and stop when it returns blocked/split guidance.
- **Escape hatch:** If the gated-commit mechanism locks up, the operator can bypass it: `rm -rf .git/commit-gate.lock/ && git reset --mixed` clears the lock and index, then `SKIP_COMMIT_GATE=1 git commit ...` commits directly. This is operator-only — agents must never use this path.
- When using `/commit-review`, always provide a `Feature summary` and `Exact file list`. Prefer naming the `Primary lane` and any relevant repo rules/docs up front. If the review intentionally spans more than 8 files, include `File-cap override` with a short reason. Use `docs/coordination/PROMPT_TEMPLATE.md` or `.github/prompts/commit-review.prompt.md` for the repo-standard request shape.
- Prefer the session-memory commands when the task is long-lived or artifact-heavy: `session-start`, `task-contract-save`, `task-contract-open`, `checkpoint-save`, `checkpoint-open`, `handoff-save`, and `job-cleanup`.
- For the local coordinator workflow, keep the split strict:
  - `/coordination` for read-only routing and task-mode advice
  - `/write-task` to create or update a local task card, including coordinator-only drafts
  - `/research` to prepare research tasks with explicit source policy, artifact targets, and long-run workstream setup
  - `/task-ready` to promote a refined draft into executable `ready` state
  - `/task-update` to adjust task metadata without changing lifecycle state, subject to lifecycle-aware mutability guards
  - `/task-repair` to repair incomplete research-task contract fields without changing lifecycle state
  - `/task-list` to open the control-room inbox for draft, open, reported, and blocked local tasks
  - `/resume-task <id>` to bootstrap an execution session from that card
  - `/task-closeout <id>` to persist a local closeout report
  - `/task-review <id>` to record the coordinator-side decision after reviewing the result
- Prefer repo-local OpenCode skills under `.opencode/skills/` for reusable workflows that should be discoverable through the native `skill` tool, but do not assume automatic selection; name the skill explicitly when it matters to correctness, cost, or operational safety.
- Do not mix runtime routing, semantics, and promotion claims into one undisciplined change. Hand off between specialists when crossing boundaries.
- Any component or configuration promotion, rollback, or profile change must name the affected manifests or profiles and the exact evidence that justifies it.
- Any docs-only checkpoint or backlog update must preserve history and reflect actual code and validation state, not intent alone.

## Backlog tracking rules

The canonical planning documents live under `docs/planning/` and `docs/checkpoints/`.

### Canonical files
- `docs/planning/backlog.md` is the source of truth for task status.
- `docs/planning/archive/` stores older `done` / `cancelled` rows moved out of the active backlog for on-demand retrieval.
- `docs/planning/roadmap.md` describes phase ordering and milestone intent.
- `docs/checkpoints/` stores dated progress snapshots only when a checkpoint is worth committing.

### Agent update requirements
- Before substantial work, update the matching row in `docs/planning/backlog.md` to `in_progress` and add owner/date notes. If no matching row exists, add a new task instead of reusing an unrelated one.
- When finishing work, move the task to `done` and record the changed files and verification performed.
- If new follow-up work is discovered, add a new task with a new ID instead of overloading the current task.
- If blocked, move the task to `blocked` with the exact blocker and the next decision needed.
- Do not delete old tasks silently. Move abandoned items to `cancelled` and leave a short reason.
- After backlog edits that complete/cancel work or otherwise create section drift, run the backlog normalizer (`/backlog-cleanup` or `vh-agent-harness exec node .opencode/scripts/normalize-backlog.js`) so `Now` / `Next` / `Later` stay active-only and older history is archived under `docs/planning/archive/`.
- Do not rewrite unrelated task history while updating the backlog.

### Task formatting rules
- Use stable IDs such as `P1-CORE-001` or `P2-API-003`.
- Keep each task scoped to one clear vertical slice or one focused boundary change.
- Prefer areas that match repo boundaries (e.g. `api`, `web`, `storage`, `docs`, or the project's own package names).
- Completed tasks must include enough notes for a reviewer to understand what changed without diff-mining the branch.

# vh-solara — Mission & Engineering Notes

This repository builds **vh-solara** — a single Go binary that runs next to
OpenCode on each machine: it aggregates OpenCode's state into a resumable,
real-time view and serves a custom, mobile-first web UI (a SolidJS SPA,
installable as a PWA) embedded via `//go:embed`. Each instance connects to a
central controller through a persistent multiplexed WebSocket tunnel (yamux), so
an operator can reach and drive any machine's OpenCode sessions from one URL with
**no inbound network access to the worker**.

It lets an operator:
- watch and drive OpenCode sessions/subsessions (tree, streaming chat, diffs,
  terminal, git actions) from a phone or desktop, in real time;
- reach worker machines through the controller tunnel without exposing them;
- declare repo-resident managed processes + embedded views per project.

## Toolchain

- **`go` may not be on `PATH`.** It lives at `/usr/local/go/bin/go`; prefix:
  `export PATH=$PATH:/usr/local/go/bin`.
- Module: `github.com/vhqtvn/vh-solara`, Go 1.25.
- Build the CLI: `go build ./...` (uses the committed `pkg/web/dist/` placeholder,
  so no frontend build is needed for a plain build or `go test`).
- Run Go tests: `go test ./...`. Format check: `gofmt -l pkg cmd main.go`.
- Releases are **tag-driven**: pushing a `v*` tag triggers the GitHub Actions
  release workflow, which stamps `cmd.Version` via ldflags. There is no in-repo
  version constant — "bump version" = create and push the next `vX.Y.Z` tag.

## Web frontend (`web/`)

- SolidJS SPA built with Vite; TypeScript. `make web` builds the SPA into a
  **gitignored staging dir** (`web/dist-build/`), NOT into `pkg/web/dist/`. A
  self-contained fallback `pkg/web/dist/index.html` is tracked so `//go:embed
  dist` compiles and a cold `go build`/`go test` works with **no frontend build**
  (it renders a "web UI was not built" banner — fully self-contained, with no
  `/assets` or `/sw.js` references). Embed-producing targets (`make build`/
  `install`/`fixtures`, the release workflow) **materialize** — copy
  `web/dist-build/*` → `pkg/web/dist/` — immediately before `go build`, so the
  binary embeds the real SPA. `make web` alone leaves `git status` clean (a CI
  guard asserts `pkg/web/dist/index.html` is untouched). NOTE: `make build` /
  materialize overwrites `pkg/web/dist/index.html` locally; do NOT commit in that
  state — restore the committed placeholder first (operators:
  `git checkout -- pkg/web/dist/index.html`; agents: route through the committer
  / `.opencode/scripts/commit-gate.sh revert pkg/web/dist/index.html`).
- Full build (Node ≥ 20): `make build` (or `make web` for the SPA only).
- SPA unit tests: `cd web && npx vitest run`. Typecheck: `npm run typecheck`.
- Playwright e2e: `cd web && export PATH=$PATH:/usr/local/go/bin && npx playwright
  test` (the `webServer` runs `scripts/fixture-web.sh`, which builds the SPA and
  `go run ./tools/fixtureserver`, so go must be on PATH). The e2e suite is serial
  and shares fixture state.
- Go e2e harness: `tests/e2e/` (`e2e.StartCluster()`).

## Web frontend performance — Firefox/WebRender GPU gotchas

The UI runs on the user's GPU. Firefox/WebRender punishes a few CSS patterns far
harder than Chromium and can pin a GPU to ~99°C while looking innocent. Avoid
these on large/scrolling/always-present surfaces (the chat scroll, message list,
reasoning body):

- **`mask-image` / `-webkit-mask` on a scroll container is the worst** — it forces
  the whole scrollable content to render to an offscreen surface and re-rasterize.
  A gradient edge-fade mask on `.chat-scroll`/`.reasoning-body` re-rastered the
  entire transcript **on every scroll frame** ("scroll and the temp climbs"). It
  was the actual culprit behind a long heat saga; removed (see `lib/scrollEdges.ts`).
- **`backdrop-filter: blur` re-blurs the backdrop every frame** — don't use it on
  overlays (removed from `.restart-overlay`).
- **`contain: paint` / `content-visibility: auto` per element made it WORSE** on
  Firefox WebRender (each becomes a compositing surface/blob; too many blow past
  the GPU surface budget into a stuck-hot state). Not a perf fix here.
- **Per-frame work scales with total DOM** (a repaint/animation can trigger a
  full-document display-list rebuild), so cap streaming re-render rate (the live
  markdown stream is coalesced to ~5fps in `components/Part.tsx`) and prefer cheap
  DOM ops (`lib/streamMd.ts` appends text nodes; never rewrites a growing node).
- Diagnosing: a bare repro page often won't reproduce it — the cost is the real
  app's complex scene. Capture a Firefox profiler trace and look under
  `Update the rendering → Paint` for `ViewportFrame::BuildDisplayList` (display
  list) vs `Grouper`/`GetBlobItemData` (blob raster). Headless browsers do not
  GPU-rasterize, so they cannot reproduce the heat.

## Conventions

- State-changing `/vh/*` requests require the `X-VH-CSRF: 1` header (the SPA's
  `installCsrf()` adds it automatically; raw `fetch` in tests must set it).
- Per-project runtime data lives under `.vh-solara/` (gitignored — distinct from
  this harness's `.vh-agent-harness/`). A project may commit
  `.vh-solara/project.jsonc` to declare managed processes — see
  [`docs/guides/managed-projects.md`](../docs/guides/managed-projects.md). Building the embedded
  view app itself: [`docs/guides/custom-views.md`](../docs/guides/custom-views.md).

## Not applicable

vh-solara is a host-run Go binary + embedded SPA — **not** container-first, and it
has no datasets, promotable model components, or credentialed demo API. The
container-first / dataset / component-promotion / demo-API sections of the mission
template are intentionally omitted.
