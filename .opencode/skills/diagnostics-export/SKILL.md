---
name: diagnostics-export
description: "Package a safe-to-share bug bundle for vh-solara via `vh-agent-harness diagnostics-export`. Loads when the operator needs to share harness state with a maintainer, file a bug report, or archive session memory for a complex issue. Field-aware secret redaction, repo-local output, never auto-uploaded."
compatibility: opencode
---

# Diagnostics Export (bug-bundle tooling)

> **Operator debugging/support tooling.** Packages selected harness state into a
> single redacted `tar.gz` under repo-scoped `tmp/`. The operator decides
> if/when to share it — the tool **never auto-uploads**.

## When to use

Load this skill (and reach for the subcommand) when the operator asks to:

- **File a bug report** against the harness and needs to attach reproducible
  state (session memory + coordinator state + recent logs/checkpoints).
- **Share debug state with a maintainer** without leaking secrets.
- **Archive session state** for a complex, long-running issue so it can be
  re-inspected later without keeping the live tree dirty.
- **Hand off a hard problem** to another operator, shipping the *state* that
  produced it (not just a prose description).

This is the R5 recommendation from the agent-memory safety study: the single
highest-value **Safety + Capability** item, because a leaking bug bundle is the
fastest way to expose operator secrets, and a useless (over-redacted) bundle is
the fastest way to make support impossible.

## How to invoke

This skill is a **thin wrapper** around the Go subcommand. The redaction lives
in the binary so it is deterministic and unit-tested — do **not** improvise a
shell-based bundle instead.

```bash
# Preview what would be bundled (no archive written):
vh-agent-harness diagnostics-export --dry-run

# Write the archive to repo-scoped tmp/:
vh-agent-harness diagnostics-export

# Choose the output path (relative to repo root, or absolute inside repo):
vh-agent-harness diagnostics-export --output tmp/bug-42.tar.gz
```

## What it does

The subcommand bundles these repo-relative sources (skipping any that are
absent) into one `tmp/diagnostics-<timestamp>.tar.gz`:

- `.opencode/state/` — session + workstream memory (the **primary** payload).
- `.local/coordinator/` — local task registry, research runs.
- `.local/config/` — operator config (**high redaction priority**).
- `docs/checkpoints/` — dated progress snapshots.

It **excludes** (never bundles): `refs/`, `.git/`, `node_modules/`, build
artifacts, and `tmp/` itself (no recursive self-inclusion).

A `manifest.json` is written at the archive root recording: the tool + version,
repo root, created-at, total bytes, the included file list (path + class +
bytes), the excluded paths, and redaction counts by category.

### Redaction (field-aware, applied before archiving)

Three layers compose for defense in depth — non-sensitive fields (paths,
timestamps, ids, statuses, enum values, body text) survive so the bundle stays
**useful**:

1. **Field-name.** Any JSON/YAML/env key whose name (case- and
   separator-normalized) matches a secret-sensitive fragment — `apikey`,
   `api_key`, `token`, `secret`, `password`, `passwd`, `credential`, `auth`,
   `bearer`, `private_key`, `access_key`, `client_secret` — has its value
   replaced with `***REDACTED(Nchars)***` (N = original character count).
2. **Whole-section.** Blocks named `secrets`, `env`, `environment`,
   `credentials` (at any depth) and a top-level `models` config block have
   **every** value redacted regardless of child key names.
3. **Value-pattern.** Standalone values that look like known secret formats —
   `Bearer ...` tokens, AWS-style keys (`AKIA...`), connection strings with
   embedded passwords (`scheme://user:pass@host`) — are scrubbed even when the
   key name is benign.

Structured files (`.json`/`.yaml`/`.yml`/`.jsonl`/`.ndjson`) are parsed → walked
→ re-serialized. Text-ish files (`.env`, `.md`, `.log`, unknown) get line-based
regex scrubbing. Binary or unparseable files are included **as-is** and flagged
in the manifest as `binary_as_is` / `unparsed_as_is` so the operator reviews
them before sharing.

The redaction engine is unit-tested in `internal/cli/diagnostics_test.go`. A
redaction bug is a secret leak, so treat test failures there as release-blocking.

## Safety guarantees

- **Never auto-uploads.** No HTTP, no S3, no clipboard. The archive is a local
  file the operator must move by hand.
- **Never writes outside the repo.** The resolved output path must stay inside
  the repo root; an absolute `--output` that escapes is refused.
- **Repo-scoped `tmp/` only.** Default output is `tmp/diagnostics-<timestamp>.tar.gz`
  per repo hygiene rules — never system temp.
- **No symlinks followed.** Only regular files under the known sources are
  bundled, so an attacker-controlled symlink cannot pull in arbitrary tree
  state.

## Definition of Done (operator checklist)

Before sharing the archive, run through this list:

1. **Run `--dry-run` first.** Read the manifest summary: are the included /
   excluded paths what you expect? Are the redaction counts plausible
   (non-zero where secrets are known to live, not so high that the bundle is
   useless)?
2. **Write the archive** (run without `--dry-run`).
3. **Open the archive** and read `manifest.json` at the root. Confirm the tool
   version, the file list, and the per-category redaction counts.
4. **Spot-check redaction.** Open a few of the redacted files and grep for any
   residual secret-shaped value (a stray `Bearer ...`, an `AKIA...`, a
   `://user:pass@` connection string). The redaction is field-aware, not a
   full content scanner — a secret pasted into free-text body could survive.
5. **Review `binary_as_is` / `unparsed_as_is` files** listed in the manifest.
   These were not parsed, so they were not structurally redacted. Decide
   per-file whether it is safe to share.
6. **Only then** share the archive (attach to the issue, send to the
   maintainer, copy to cold storage). The tool has done its part; sharing is a
   human decision.

## Non-goals / what this is not

- **Not a redaction oracle.** It catches field-aware, structurally-sited
  secrets. It does not semantic-scan free-text body for arbitrary secret
  shapes. The DoD step 4 exists for exactly this reason.
- **Not a transport.** It produces a file. Uploading is a separate, human step.
- **Not a substitute for `commit-gate`/`.gitignore`.** It reads tree state into
  a bundle; it does not change what is tracked or committed.

## Cross-references

- `vh-agent-harness help diagnostics-export` — the authoritative flag/behavior
  reference (the binary's own `--help`).
- `internal/cli/diagnostics.go` + `internal/cli/diagnostics_test.go` — the
  redaction engine and its tests. Treat test failures as secret-leak bugs.
- `.opencode/skills/backlog/SKILL.md` — the `.local/coordinator/tasks/`
  holding-area convention that this tool bundles (transport, not truth).
