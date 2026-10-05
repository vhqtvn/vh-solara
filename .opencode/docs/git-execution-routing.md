# Git Execution Routing Rule

## Capability condition (read this first)

The committer route described by this document is WIRED only when the
`core/gated-commit` capability is selected in
`.vh-agent-harness/vh-harness-profile.yml` — via `profile: supervised`, or an
explicit `capabilities: [core/gated-commit]` entry. On profiles without it
(`minimal`, `coordination`, `web`, or any selection that does not include the
cluster) the `committer` / `commit-message` / `commit-reviewer` agent blocks
and every `committer` task edge are not wired into opencode.jsonc —
delegation to `committer` falls through to the default task deny. The workflow
sections below describe the SELECTED shape.

The SAFETY rule is unconditional on every profile: raw git mutations
(`git add` / `git commit` / `git push` / `git reset` / …) and direct
`commit-gate.sh` gate-command invocation are denied for every agent except the
committer (and the committer exists only where the capability is selected).
`commit-gate.sh revert <paths>` and the read-only git verbs remain available to
their usual caller groups everywhere.

On profiles WITHOUT the capability selected, an agent holding reviewed,
committable work MUST:

1. **STOP** — do not delegate to `committer` (the route is unwired and will
   deny), do not probe it repeatedly, and never fall back to raw git, the gate
   script, or the operator escape hatch.
2. **PRESERVE** the work: leave it in the working tree uncommitted (and record
   a checkpoint under `.opencode/state/` for long-lived work).
3. **REPORT** the missing route in the closeout/summary: "gated-commit
   capability not selected; automated committing unavailable" — with the exact
   file list that awaits a commit.
4. **REQUEST** separately-authorized activation: the operator either adds
   `core/gated-commit` under `capabilities:` in
   `.vh-agent-harness/vh-harness-profile.yml` (the narrower choice — it does
   not also switch the debate cluster on) or handles the commit themselves
   from a host terminal. Activation is the operator's config change; after
   `vh-agent-harness update`, a running opencode session that predates the
   change must be restarted to load the new permissions (see "How to update
   permissions" below).

## The rule

Only the **committer agent (C)** may execute git mutations. All other agents —
including `build` and every project-supplied specialist (whatever the project
names in its overlay packs), `default`, and all read-only specialists — must
delegate commit requests to the committer agent, which runs them through the
gated-commit protocol. On profiles where `core/gated-commit` is not selected
there IS no committer agent in the wiring — the delegation leg of this rule
cannot run; follow "Capability condition" above instead (the no-raw-git half
of the rule still binds unconditionally).

Subagents that commit (`build` plus any project specialist that delegates to
the committer — declared in each overlay pack's permission-pack.jsonc) delegate
to `committer` via task delegation. The committer acquires a lock, delegates to
`commit-reviewer` for tiered cascade review, and either commits or releases
based on the review result.

## Why this exists

After DCP context-compaction events, agents lose inline prompt rules and may attempt
direct git mutations. The gated-commit protocol ensures every mutation goes through
review. Three enforcement layers make direct bypass by non-human agents extremely
difficult; see the threat model in the gated-commit spec for known residual risks.

## Enforcement layers

### 1. Shell-guard plugin (`.opencode/plugins/shell-guard.js`)

- **Gate commands** (`commit-gate.sh acquire/commit/release/heartbeat/revert/stage-message`)
  are in `ALLOWED_PATTERNS` and pass through shell-guard.
- **Read-only probe** (`commit-gate.sh status`) is a pure-read metadata lookup (lock/session
  state) that lives in the readonly group, so ALL agents — including gate-exempt ones
  (`build`/`coordination`/`project-coordinator`/`docs-steward`) — get prompt-free lock checks.
  It is not a gate command.
- **Canonical invocation (single-line message-file form):** The committer authors its
  commit message with the **Write tool** at `tmp/commit-gate-message/msg-${UUID}` — the
  single path its scoped object-form `edit` allows (`{ "*": "deny",
  "tmp/commit-gate-message/**": "allow" }`) — then passes it to the gate as
  `--message-file`. The command string never carries message prose, so the
  `git-mutation-bypass` forbidden regex (which scans the RAW command string before the
  tree-sitter allowlist) and the chain-guard carve-out (which refuses multi-line
  commands) can never reject a commit because of its message body.
  ```bash
  .opencode/scripts/commit-gate.sh acquire --paths '<JSON>' --message-file tmp/commit-gate-message/msg-${UUID} --session-alias ALIAS
  ```
  Banned for staging the message: the heredoc `stage-message` form, unquoted heredoc
  delimiters, redirect-to-file heredocs, and inline `--message "..."`. See
  `.opencode/skills/gated-commit/SKILL.md`.
- **No manual cleanup of the message scratch:** `commit-gate.sh` reclaims
  `tmp/commit-gate-message/msg-${UUID}` itself — on successful commit, release, and
  the `no_changes` no-op branch, plus an aged-orphan GC sweep (older than
  `COMMIT_GATE_GC_MAX_AGE`, default 3600s) — exactly as it does for its own
  `.git/commit-gate/` scratch. Agents MUST NOT `rm` anything under
  `tmp/commit-gate-message/` — `rm` is not allowlisted for any agent (shell-guard
  denies it) and is now unnecessary on both scratch surfaces.
- **Git mutation bypass** (`git-mutation-bypass` in forbidden-patterns) blocks
  raw `git add`, `git commit`, `git reset`, `git push`, etc. for ALL agents.
- **Operator escape hatch**: `SKIP_COMMIT_GATE=1` is operator-only (host terminal).
  It has no effect inside OpenCode â shell-guard does not suppress forbidden
  patterns for SKIP_COMMIT_GATE from any agent, and commit-gate.sh refuses
  SKIP_COMMIT_GATE when running inside an OpenCode session (detected via
  `/proc/self/environ`). See "Operator escape hatch" section below.

### 2. opencode.jsonc permissions (generated by the Go-native emitter inside `vh-agent-harness update`)

Per-agent bash permission gates:
- `committer`: `gate: "allow"`, `git_readonly: "allow"`, `*: "deny"` — sole gate-enabled agent; commits through the wrapper only, never raw git
- All other agents: `gate: "deny"`, `git_readonly: "allow"` (or deny), `*: "deny"` — no git writes, no gate commands

Task delegation gates:
- `build`, `coordination`, `project-coordinator`, `docs-steward`, plus every agent contributed by an active overlay pack (declared via each pack's permission-pack.jsonc): may delegate to `committer` — **these blocks and edges are emitted only when `core/gated-commit` is selected** (see "Capability condition")
- `committer`: may only delegate to `commit-reviewer`

### 3. Agent prompts (`.opencode/agents/*.md`, `AGENTS.md`)

Agent prompts reference this document and route commits through the committer agent.

## Current trusted agent

| Agent        | Permission | Scope |
|--------------|------------|-------|
| `committer`  | allow      | gate commands, git_readonly |
| All others   | deny       | gate commands (git_readonly varies by agent) |

## Escape hatch

**Operator-only (host terminal, outside OpenCode):**

If the gated-commit system is blocking legitimate work and the committer agent is
unavailable or broken, the operator can bypass the gate from a **host terminal**
(outside OpenCode):

1. Clear any stuck lock: `rm -rf .git/commit-gate.lock/ && git reset --mixed`
2. Run: `SKIP_COMMIT_GATE=1 git commit ...`

`SKIP_COMMIT_GATE=1` is operator-only. It has no effect inside OpenCode:
- **shell-guard**: does not suppress forbidden patterns for agents with SKIP_COMMIT_GATE=1
- **commit-gate.sh**: detects OpenCode context via `/proc/self/environ` and refuses
  SKIP_COMMIT_GATE=1 when OPENCODE_SESSION_ID is present in the initial environment

No agent may use SKIP_COMMIT_GATE=1. If the gate mechanism is stuck, escalate to the operator.

**Sanctioned in-session alternative**: `.opencode/scripts/commit-gate.sh revert <paths>` restores working-tree paths to HEAD with no lock/CAS/private index — use it to unblock a session whose edits collided with a concurrent committer instead of the operator escape hatch.

## How to update permissions

Permission content (command groups, per-agent bash/task decisions, delegateFrom
edges) is emitted by the Go-native permission emitter (`internal/permconfig/`)
invoked inside `vh-agent-harness update`'s render pipeline. The canonical tables
live in `internal/permconfig/tables.go`; the resolver that historically rewrote
`opencode.jsonc` (`update-opencode-config.js`) is now a deprecated stub.

1. Edit command groups or per-agent decisions in `internal/permconfig/tables.go`
   (for core agents) or the overlay pack's `permission-pack.jsonc` (for overlay
   agents).
2. Re-build the binary, then run: `vh-agent-harness update`
3. Restart opencode to load the new config.

## Read-only git verbs (automatic passthrough)

The following git verbs are read-only and pass through shell-guard without
restriction (source: `.opencode/repo-configs/allowed-commands.js`):

- `git diff`, `git log`, `git show`, `git grep`, `git blame`
- `git ls-tree`, `git status`, `git ls-files`, `git cat-file`
- `git show-ref`, `git rev-parse`

## Cross-references

- `docs/ai/shell-execution.md` — the `vh-agent-harness exec` golden rule and forbidden patterns
- `AGENTS.md` → "OpenCode operating model" — references this document
- `.opencode/plugins/shell-guard.js` — forbidden pattern enforcement
- `.opencode/sys-scripts/update-opencode-config.js` — DEPRECATED stub (permission generation is now Go-native)
- `.opencode/scripts/commit-gate.sh` — the gate wrapper script
- `.opencode/agents/committer.md` — committer agent prompt
- the gated-commit design memo in your project's decisions/ — full spec
