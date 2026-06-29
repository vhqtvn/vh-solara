---
name: gated-commit
description: "Gated-commit protocol for vh-solara. Load this skill when you need to commit changes, stage files, or understand the commit-gate enforcement model. Use this whenever the task involves git add, git commit, git push, git reset, or any git write operation."
compatibility: opencode
---

# Gated-Commit Protocol

> **RESTART-GATED (atomic message staging):** The `commit-gate.sh stage-message`
> atomic-heredoc form for `msg-${UUID}` (see "Canonical invocation" below) takes
> effect on the next OpenCode restart — shell-guard loads its allowlist at
> startup. A prompt loaded before that may still predate the allowlist entry
> `.opencode/scripts/commit-gate.sh stage-message *`; if `stage-message` is
> blocked by shell-guard, fall back to the per-line `echo` construction
> described below (it still works). The committer agent has `edit: "deny"` and
> cannot use the Write/Edit tool at all.

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
2. C acquires lock via `commit-gate.sh acquire` (file-based form).
3. C delegates to `commit-reviewer` for tiered cascade review.
4. On APPROVED: C commits via `commit-gate.sh commit`.
5. On BLOCKED/SPLIT: C releases lock via `commit-gate.sh release` and reports blockers to A.

## Canonical invocation (file-based)

**Why:** Inline `--message` and `--paths` (JSON array) arguments cause tree-sitter parse
failures in shell-guard when messages contain newlines, backticks, or other shell-sensitive
characters. File-based args avoid this entirely. `msg-${UUID}` is staged **atomically** in
ONE call via the `stage-message` subcommand (preferred, post-restart); `paths-${UUID}`
stays per-line `echo` (paths rarely contain shell-hostile chars and the committer has
`edit: "deny"`).

### `msg-${UUID}` — atomic `stage-message` heredoc (preferred)

**MANDATE (absolute rule, not a preference):** `.git/commit-gate/msg-${UUID}` MUST be
created via the `commit-gate.sh stage-message --uuid "${UUID}"` subcommand, feeding the
message body through a **quoted** heredoc (`<<'GATE_MSG_EOF'`) on STDIN — ONE tool call,
the gate script owns the write (atomic temp-write + rename, loud failure on error). The
committer agent has `edit: "deny"` (opencode.jsonc) and CANNOT use the Write/Edit tool;
inline `--message "..."` breaks shell-guard's tree-sitter safe-parser on newlines/backticks;
and the OLD per-line `echo >>` construction exhausted the agent step budget mid-write on
long messages (the motivating incident for this subcommand).

**Why the quoted heredoc is safe:** tree-sitter-bash honors the quoted delimiter — the body
is literal, so backticks (`git commit`, `$(echo hi)`, `git reset --mixed`), `$VAR`, single
and double quotes, and newlines produce **zero spurious command nodes**. `commandParts`
skips the redirect token, so the invocation parses to a single command
`[commit-gate.sh, stage-message, --uuid, ${UUID}]`, allowlisted under
`.opencode/scripts/commit-gate.sh stage-message *`. The git-mutation-bypass `allowIf`
exempts the gate-wrapper prefix, so a body that literally contains `git commit`/`git reset`
does NOT trip the forbidden-pattern deny. (Verified adversarially — see `stage-message` is
only active after the restart that loads this allowlist entry.)

**FORBIDDEN — never construct `msg-${UUID}` via:**
- the Write/Edit tool (committer has `edit: "deny"`)
- inline `--message "..."` (breaks the safe-parser on newlines/backticks)
- heredocs that write directly to `.git/commit-gate/msg-${UUID}` OUTSIDE the gate script
  (`cat > .git/commit-gate/msg-${UUID} <<EOF`) — that bypasses the gate script's atomic-write
  + filename-validation ownership
- brace-groups (`{ printf ...; }`), compound one-liners that chain `gen-uuid` with a write
  (e.g. `UUID=$(...gen-uuid) && ... > ...`), or improvised `./tmp` staging dirs

**Fallback (pre-restart or if `stage-message` is blocked):** per-line `echo` redirection
(`echo '...' > msg-${UUID}` then `echo '...' >> msg-${UUID}`, one line per call) still works
and is the chicken-and-egg path used by a slice that ADDS `stage-message` itself. Use it
only when `stage-message` is unavailable; otherwise prefer the atomic one-shot form.

### `paths-${UUID}` — per-line `echo` (unchanged)

`.git/commit-gate/paths-${UUID}` stays per-line `echo` redirection — one path per line, each
`echo` a SINGLE standalone command (`echo '...' > file` first, `echo '...' >> file` after).
Paths rarely contain shell-hostile chars; `echo *: allow` is present in the committer's bash
block and `echo` is in shell-guard's ALLOWED_PATTERNS. Never use the Write/Edit tool, heredocs,
brace-groups, or improvised staging dirs for `paths-${UUID}`.

**Canonical flow (the supported construction — one example):**

```bash
# 1. Generate a UUID — SINGLE standalone call. NEVER chain it with a file write.
UUID=$(.opencode/scripts/readonly-scripts.sh gen-uuid)

# 2. Ensure scratch directory exists
.opencode/scripts/readonly-scripts.sh prep-tempdir

# 3a. Stage the commit message ATOMICALLY via stage-message — ONE tool call,
#     quoted heredoc on STDIN. Backticks/$/quotes/newlines are all literal here;
#     the gate script writes msg-${UUID} atomically (temp + rename, loud failure).
.opencode/scripts/commit-gate.sh stage-message --uuid "${UUID}" <<'GATE_MSG_EOF'
feat(scope): summary line

Body text — backticks like `git commit`, dollar $VAR, quotes 'single'/"double"
are all literal inside a QUOTED heredoc and produce zero spurious parse nodes.

Co-Authored-By: ...
GATE_MSG_EOF

# 3b. Write paths-${UUID} via per-line echo redirection (one path per line), NOT
#     the Write/Edit tool (committer has edit:deny). Each echo is a SINGLE
#     standalone command:
#       echo '<path 1>'  >  .git/commit-gate/paths-${UUID}   # first path
#       echo '<path 2>'  >> .git/commit-gate/paths-${UUID}   # append each later path
#    paths-${UUID}  -> one path per line (newline-separated)

# 4. Acquire session
.opencode/scripts/commit-gate.sh acquire \
  --paths-file ".git/commit-gate/paths-${UUID}" \
  --message-file ".git/commit-gate/msg-${UUID}" \
  --session-alias ALIAS

# 5. No manual cleanup — the gate reaps stale session scratch automatically.
#    `commit-gate.sh` runs its GC on the commit, release, and `no_changes`
#    paths: it sweeps aged orphans (msg-/paths-/meta-/index-/merge-) older
#    than COMMIT_GATE_GC_MAX_AGE. Agents MUST NOT manually
#    `rm` `.git/commit-gate/*` scratch — the bare-`rm` form is not allowlisted
#    for any agent (shell-guard denies it) and is now redundant.
```

> **Automatic scratch cleanup:** `commit-gate.sh` self-cleans session-uuid
> scratch (`msg-`/`paths-`) on successful commit, release, AND the `no_changes`
> no-op branch, and sweeps aged orphans (older than `COMMIT_GATE_GC_MAX_AGE`,
> default 3600s) on those same paths. Abandoned and no-op sessions may leave
> scratch behind temporarily, but it is reaped on the next
> commit/release/`no_changes` operation by TTL. Agents MUST NOT manually `rm`
> `.git/commit-gate/*` — it is not allowlisted for any agent (shell-guard
> denies it) and is now unnecessary.

**Blessed one-liner (acquire):**
```
.opencode/scripts/commit-gate.sh acquire --paths-file .git/commit-gate/paths-${UUID} --message-file .git/commit-gate/msg-${UUID} --session-alias ALIAS
```

**Blessed one-liner (commit):**
```
.opencode/scripts/commit-gate.sh commit --uuid UUID --tree-hash HASH --message-file .git/commit-gate/msg-${UUID}
```

**Backward compat:** The old inline `--message` and `--paths` (JSON array) still work but
are marked **legacy** — avoid them for messages with newlines/backticks or large path lists.
File-based args take precedence when both forms are provided.

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
   - Gate commands (`commit-gate.sh acquire/commit/release/stage-message/heartbeat/revert/status`) pass through.

2. **Layer 2 — opencode.jsonc** (generated by the Go-native permission emitter inside `vh-agent-harness update`):
   - `committer`: `gate: "allow"`, `git_readonly: "allow"`, `*: "deny"` — sole gate-enabled agent; commits through the wrapper only.
   - All other agents: `gate: "deny"`, `*: "deny"`.

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
- `researches/decisions/2026-06-03-gated-commit-brief.md` — full spec
- `researches/decisions/2026-06-09-concurrent-commit-gate-design.md` — lock-free concurrent commit design

## Scratch-space hygiene

ALL scratch and handoff files MUST live in-repo under `.git/commit-gate/` or `/workspace/tmp/`.
NEVER write to `/tmp` — out-of-repo writes trigger permission prompts and block unattended runs.
**Construct `.git/commit-gate/msg-${UUID}` via the atomic `commit-gate.sh stage-message` subcommand** (one quoted-heredoc tool call — see "Canonical invocation" above), and **`paths-${UUID}` via per-line `echo` redirection** (`echo '...' > file` then `echo '...' >> file`, one line per call) — never via the Write/Edit tool, ad-hoc heredocs that write directly to those paths, brace-groups, or improvised staging dirs. Never use heredocs to write handoff files anywhere.

Build agents MUST also set in-repo cache directories:
- `PYTHONPYCACHEPREFIX=/workspace/tmp/.pycache`
- `RUFF_CACHE_DIR=/workspace/tmp/.ruff_cache`
