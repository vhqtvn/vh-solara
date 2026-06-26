---
name: repo-recon
description: Generator/maintainer for the project's repo-recon structural data file at `.opencode/repo-configs/repo-recon-data.yml`. Use this whenever the user asks to map the repo, locate entrypoints/hotspots/packages/tests, create or refresh the repo-recon data, or recreate it after a structural change. The data file is external_generated — the harness scaffolds it blank on install, then the project (this skill or project agents) owns it.
compatibility: opencode
---

# Repo-Recon Generator

This skill is the **provider** for the project-scoped repo-recon data file:
`.opencode/repo-configs/repo-recon-data.yml`.

It DEFINES the data contract, and offers three maintenance operations:
**create**, **incremental-update**, and **recreate**. The file is also
human-writable — a maintainer can edit it directly and this skill will respect
hand entries on incremental updates unless they contradict freshly discovered
structure.

## Ownership

- This skill (the SKILL.md + any scripts): **platform_managed**. The harness
  owns it; do not edit it in a consuming project.
- The data file `.opencode/repo-configs/repo-recon-data.yml`:
  **external_generated**. The harness seeds a blank skeleton on first install
  (if missing) and then LEAVES IT ALONE on every update. The project owns the
  contents via this skill or hand edits. The harness never overwrites it.

## Data contract

The file is YAML with four top-level keys (this is the authoritative schema,
mirrored by the harness's `internal/schema/repo_recon.go` validator and checked
by `vh-agent-harness doctor`):

```yaml
# entrypoints — where execution / request handling begins.
entrypoints:
  - name: api            # human label (required if no path)
    path: apps/api/main.py   # OR a path (required if no name)
    note: FastAPI app factory

# hotspots — files most likely to need reading for a change in this repo.
hotspots:
  - name: core-routes
    path: apps/api/routes.py

# packages — the logical package boundaries, keyed by package name.
packages:
  domain:
    path: packages/domain
    role: entities, enums, value objects, policies
  storage:
    path: packages/storage
    role: repos + migrations

# tests — where the test suites live and how to run them.
tests:
  - name: unit
    path: tests/unit
    run: vh-agent-harness exec pytest tests/unit/
  - name: e2e
    path: tests/e2e
    run: vh-agent-harness exec pytest tests/e2e/
```

### Per-section shape rules (enforced by the validator)

- `entrypoints`, `hotspots`, `tests`: arrays of objects. Each object MUST carry
  a `name` OR a `path` (so every entry is actionable). Other keys (`note`,
  `run`, `role`, ...) are free-form and pass through.
- `packages`: a map keyed by package name. Each value is an object (typically
  `path` + `role`).
- No other top-level keys are allowed; unknown keys are reported by
  `vh-agent-harness doctor`.

## Operations

### 1. create (first population)

Use when the data file is empty/blank or does not yet reflect the repo:

1. Read the repo's top-level layout (`apps/`, `packages/`, `tests/`,
   build/run scripts like `Makefile`, `package.json`, `go.mod`).
2. Identify the entrypoints (HTTP servers, CLI `main` packages, background-job entry).
3. Identify hotspots (route definitions, the domain entity file set, the
   background-job loop, assembly/composition points).
4. Enumerate `packages/` (or the repo's package equivalent) with a one-line
   role each.
5. Locate test roots and the canonical run command for each.
6. Write the result to `.opencode/repo-configs/repo-recon-data.yml` conforming
   to the contract above.
7. Validate with `vh-agent-harness doctor` (or the validator) and fix any FieldError.

### 2. incremental-update (refresh in place)

Use when the structure has drifted but the file is mostly current:

1. Read the existing data file.
2. Re-scan the repo for the four sections.
3. For each section, MERGE: add newly-discovered entries, update `path`s that
   have moved, drop entries whose target no longer exists. **Preserve
   hand-written `note`/`role` text unless the underlying path disappeared.**
4. Write back and validate.

### 3. recreate (full rebuild)

Use after a large structural change (monorepo reorg, package rename) where
incremental merge is unreliable:

1. Discard the existing file's discovered entries (but keep a backup of any
   hand-authored notes the maintainer wants to re-apply).
2. Run the `create` flow from scratch.
3. Re-apply preserved notes where they still fit.
4. Write back and validate.

## Writing rules

- Prefer repo-relative paths (forward slashes) over absolute paths.
- One responsibility per entry; avoid duplicating the same file across
  `entrypoints` and `hotspots` unless it genuinely serves both roles.
- Keep `note`/`role` text short and decision-useful — this file is read by
  agents to pick the right starting files, not as a full architecture doc.
- After every write, the file MUST pass the repo-recon validator. If
  `vh-agent-harness doctor` reports FieldErrors, fix them before considering the
  operation complete.

## What this skill is NOT

- It is not a passive reader. It MAINTAINS the data file.
- It does not change source code. It only writes
  `.opencode/repo-configs/repo-recon-data.yml`.
- It does not promote itself into runtime component-selection or policy decisions; it is
  structural orientation data only.
