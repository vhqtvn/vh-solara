---
name: gated-commit
description: "Gated-commit protocol for vh-solara. Load this skill when you need to commit changes, stage files, or understand the commit-gate enforcement model. Use this whenever the task involves git add, git commit, git push, git reset, or any git write operation."
compatibility: opencode
---

# Gated-Commit Protocol

> **Message = file = DATA; command = CONTROL.** The committer stages its commit
> message with the **Write tool** at `tmp/commit-gate-message/msg-${UUID}` — the
> single path its scoped `edit` permission allows (`{ "*": "deny",
> "tmp/commit-gate-message/**": "allow" }`) — and passes it to the gate as
> `--message-file`. The command string never carries message prose, so a message
> body that mentions a git verb can never trip the matcher.

## Summary

The **committer agent (C)** is the sole git-write agent. All workers (A) delegate to it. No other agent may execute `git add`, `git commit`, `git push`, `git reset`, or any git mutation directly.

## Quick reference for workers (A-types)

- You **MUST NOT** execute `git add`, `git commit`, `git push`, `git reset`, or any git mutation directly.
- Delegate to the `committer` subagent with: file list, commit message draft, feature summary, session context.
- The committer acquires a session (lock-free, private index), runs tiered cascade review via `commit-reviewer`, and either commits or releases.
- Optionally delegate to `commit-message` first to draft the message.

## Protocol overview

```
A (delegating agent) → C (committer) → commit-reviewer → C → result back to A
```

1. A sends commit request to C (file list, message, feature summary, session alias).
2. C authors the message with the Write tool, then acquires via `commit-gate.sh acquire --message-file`.
3. C delegates to `commit-reviewer` for tiered cascade review.
4. On APPROVED: C commits via `commit-gate.sh commit`.
5. On BLOCKED/SPLIT: C releases lock via `commit-gate.sh release` and reports blockers to A.

## Canonical invocation (single-line message-file form)

**Why:** The `git-mutation-bypass` forbidden regex scans the RAW command string
BEFORE the tree-sitter allowlist, and the chain-guard carve-out refuses
multi-line commands. So any commit message whose body mentions a git verb
(`commit`/`push`/`checkout`/`branch`/`rebase`/`merge`/`stash`/`reset`/`revert`/
`add`/…) that reaches the command string → DENY. The fix is to keep the message
**out of the command string entirely**: author it as a FILE with the Write tool,
then hand the gate a path via `--message-file`. The single-line
`acquire --message-file <path>` command is message-content-free and passes the
chain-guard carve-out prompt-free, regardless of message prose.

### `msg-${UUID}` — Write tool at `tmp/commit-gate-message/msg-${UUID}`

**MANDATE (absolute rule, not a preference):** The commit message MUST be
authored with the **Write tool** at:

```
tmp/commit-gate-message/msg-${UUID}
```

This is the ONLY path the committer may write — its `edit` permission is scoped
object-form `{ "*": "deny", "tmp/commit-gate-message/**": "allow" }`. The Write
tool creates `tmp/commit-gate-message/` if absent. Write the FULL message body
verbatim; backticks like `git commit`, `$VAR`, single/double quotes, and
newlines are all fine here because they live in a FILE, never in a command
string. `tmp/` is gitignored, so the file never pollutes git status.

`commit-gate.sh` self-creates `.git/commit-gate/` for its own session metadata
(index/meta files); the agent never writes there. The agent never writes
`paths-${UUID}` either — paths go inline as `--paths '<JSON>'`.

**EXPLICITLY BANNED for staging the message** (each is the broken form this
change replaces, or causes a permission prompt / parser failure):
1. ❌ **Heredoc `stage-message` form** —
   `.opencode/scripts/commit-gate.sh stage-message --uuid UUID <<'GATE_MSG_EOF' …`
   — the `git-mutation-bypass` forbidden regex scans the RAW command string
   (including the heredoc body) BEFORE the tree-sitter allowlist, and the
   chain-guard carve-out refuses multi-line commands by design. So any message
   whose body mentions a git verb (`commit`/`push`/`checkout`/`branch`/`rebase`/
   `merge`/`stash`/`reset`/`revert`/`add`/…) → DENY. Intermittent,
   content-dependent, un-debuggable. THIS is what the Write-tool +
   `--message-file` form replaces.
2. ❌ **Unquoted heredoc delimiter** `<<GATE_MSG_EOF` (no quotes) — the body
   undergoes expansion and may produce command nodes that trip shell-guard's
   safe-parser or the git-mutation-bypass regex.
3. ❌ **Redirect-to-file heredoc** — `cat <<EOF > file`, `> file`, or `>> file`
   redirection. Redirect-to-file trips the safe-parser, and the committer's
   scoped `edit` allows ONLY `tmp/commit-gate-message/**`.
4. ❌ **Inline `--message "..."`** — multi-line/newline/backtick content in the
   inline arg breaks the safe-parser (per commit-gate.sh) and is quoting-fragile.
   Use the Write tool + `--message-file` instead.
Also forbidden: brace-groups (`{ printf ...; }`), compound one-liners that chain
`gen-uuid` with a write (e.g. `UUID=$(...gen-uuid) && ... > ...`), or any
improvised staging dir outside `tmp/commit-gate-message/`.

**Why:** these restrictions exist because opencode's bash permission matcher and
the `git-mutation-bypass` forbidden-pattern guard both inspect the raw command
string. Only the single-line `acquire --message-file <path>` form keeps the
command string free of message content, so message prose can never trip the
matcher.

**Canonical flow (the supported construction — one example):**

```bash
# 1. Generate a UUID — SINGLE standalone call. NEVER chain it with anything.
UUID=$(.opencode/scripts/readonly-scripts.sh gen-uuid)

# 2. Author the commit message with the WRITE TOOL at the scoped path.
#    The Write tool creates tmp/commit-gate-message/ if absent. Write the
#    FULL message body verbatim — backticks/$/quotes/newlines are all fine
#    here because they live in a FILE, never in a command string. tmp/ is
#    gitignored, so this file never pollutes git status.
#    Path to write:  tmp/commit-gate-message/msg-${UUID}
#    (This is the ONLY path the committer's scoped edit permission allows.)

# 3. Acquire session — ONE single-line command (message-as-file). The command
#    string is message-content-free, so it passes the chain-guard carve-out and
#    is ALLOWED prompt-free regardless of message prose.
.opencode/scripts/commit-gate.sh acquire --paths '["path/to/file1","path/to/file2"]' --message-file tmp/commit-gate-message/msg-${UUID} --session-alias ALIAS

# 4. (After commit-reviewer APPROVED) commit:
.opencode/scripts/commit-gate.sh commit --uuid "${UUID}" --tree-hash "<HASH>" --message-file tmp/commit-gate-message/msg-${UUID}

# 5. Best-effort cleanup (optional — tmp/ is gitignored; commit-gate.sh does
#    not own tmp/commit-gate-message/ and will not sweep it):
rm tmp/commit-gate-message/msg-${UUID}
```

> **No manual `.git/commit-gate/` cleanup.** `commit-gate.sh` self-cleans its
> own session scratch (`msg-`/`paths-`/`meta-`/`index-`) on successful commit,
> release, AND the `no_changes` no-op branch, and sweeps aged orphans (older
> than `COMMIT_GATE_GC_MAX_AGE`, default 3600s) on those same paths. Agents MUST
> NOT manually `rm` `.git/commit-gate/*` — it is not allowlisted for any agent
> (shell-guard denies it) and is now unnecessary. The agent-owned message file
> under `tmp/commit-gate-message/` is the agent's to clean (optional).

**Blessed one-liner (acquire):**
```
.opencode/scripts/commit-gate.sh acquire --paths '<JSON>' --message-file tmp/commit-gate-message/msg-${UUID} --session-alias ALIAS
```

**Blessed one-liner (commit):**
```
.opencode/scripts/commit-gate.sh commit --uuid UUID --tree-hash HASH --message-file tmp/commit-gate-message/msg-${UUID}
```

**Backward compat:** The old inline `--message`/`--paths` (JSON array) args
still work mechanically, and `--paths-file`/`--message-file .git/commit-gate/…`
forms still parse — but the heredoc `stage-message` construction is
**deprecated and banned** (see above). For new commits, author the message with
the Write tool and pass `--message-file tmp/commit-gate-message/msg-${UUID}`.

## Input format for delegation

When delegating to the committer, provide:

```json
{
  "message": "feat(scope): description",
  "paths": ["path/to/file1", "path/to/file2"],
  "feature_summary": "Brief description",
  "primary_lane": "<one of the project's lanes — e.g. a backend, frontend, data, docs, or infra lane>",
  "session_alias": "session-id",
  "file_cap_override": null
}
```

## Enforcement layers

1. **Layer 1 — shell-guard** (`.opencode/plugins/shell-guard.js`):
   - `git-mutation-bypass` blocks raw git mutations for ALL agents.
   - Gate commands (`commit-gate.sh acquire/commit/release/heartbeat/revert/stage-message`) pass through.

2. **Layer 2 — opencode.jsonc** (generated by the Go-native permission emitter inside `vh-agent-harness update`):
   - `committer`: `gate: "allow"`, `git_readonly: "allow"`, `*: "deny"` — sole gate-enabled agent; commits through the wrapper only. Its `edit` is scoped object-form `{ "*": "deny", "tmp/commit-gate-message/**": "allow" }` so it alone may Write the message scratch file.
   - All other agents: `gate: "deny"`, `*: "deny"`, flat `edit: "deny"`.

3. **Layer 3 — task rules**:
   - `build`, `coordination`, `project-coordinator`, `docs-steward`, plus every agent contributed by an active overlay pack (declared via each pack's permission-pack.jsonc) may delegate to `committer`.
   - `committer` may only delegate to `commit-reviewer`.

## Escape hatch

**Operator-only (host terminal, outside OpenCode):**

If the gated-commit mechanism locks up, the operator recovers from a **host terminal**
(outside OpenCode):

```bash
rm -rf .git/commit-gate.lock/ && git reset --mixed
SKIP_COMMIT_GATE=1 git commit ...
```

This is the operator-only host-terminal path. **No agent may use SKIP_COMMIT_GATE.**
The `SKIP_COMMIT_GATE=1` environment variable has no effect inside OpenCode —
shell-guard does not suppress forbidden patterns for SKIP_COMMIT_GATE from any agent.

**Sanctioned in-session alternative**: `.opencode/scripts/commit-gate.sh revert <paths>` restores working-tree paths to HEAD with no lock/CAS/private index — the in-session way to unblock edits that collided with a concurrent committer, instead of the operator escape hatch.

## Read-only git verbs (passthrough)

These verbs are always allowed and pass through shell-guard:

`git diff`, `git log`, `git show`, `git grep`, `git blame`, `git ls-tree`, `git status`, `git ls-files`, `git cat-file`, `git show-ref`, `git rev-parse`

## Heartbeat refresh (required for long reviews)

Heartbeat refreshes both lock metadata (if a lock dir exists) and per-session metadata
(`meta-${UUID}` in `.git/commit-gate/`). In lock-free mode, the per-session metadata file's mtime
is what TTL-based stale cleanup checks — so **heartbeat is required** for any review that may
exceed the TTL window (default 10 minutes).

```bash
.opencode/scripts/commit-gate.sh heartbeat --uuid "<UUID>"
```

This updates the `heartbeat_at` timestamp in the session metadata without changing any other field.
If the lock dir exists, it also refreshes lock metadata atomically. If no lock dir exists
(lock-free mode), it refreshes the per-session `meta-${UUID}` file, keeping the session alive
during long reviews.

## Cross-references

- `.opencode/docs/git-execution-routing.md` — full routing documentation
- `.opencode/agents/committer.md` — committer agent prompt (the actor, not a consumer of this skill)
- `.opencode/scripts/commit-gate.sh` — the gate wrapper script

## Scratch-space hygiene

ALL scratch and handoff files MUST live in-repo under `tmp/` (the message scratch
file lives at `tmp/commit-gate-message/msg-${UUID}`) or `.git/commit-gate/` (owned
by `commit-gate.sh`). NEVER write to `/tmp` — out-of-repo writes trigger permission
prompts and block unattended runs.

**Author the commit message with the Write tool at
`tmp/commit-gate-message/msg-${UUID}`**, then pass it to the gate via
`--message-file` — never via the heredoc `stage-message` form, an unquoted heredoc
delimiter, a redirect-to-file heredoc, inline `--message`, brace-groups, or an
improvised staging dir. Never use heredocs to write handoff files anywhere.

Build agents MUST also set in-repo cache directories:
- `PYTHONPYCACHEPREFIX=/workspace/tmp/.pycache`
- `RUFF_CACHE_DIR=/workspace/tmp/.ruff_cache`
