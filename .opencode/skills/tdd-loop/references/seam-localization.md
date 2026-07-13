# Seam localization (TDD)

The contracted localization artifact that the `tdd-loop` core skeleton points
at. In a consumer repo this is a file such as `<repo>-tdd-seams.md`, authored by
the overlay (or by the user on first run). The core skill never hardcodes repo
hotpaths; this file does.

This file instantiates the **S1 localization-split pattern** defined in
`templates/core/.opencode/skills/skill-creator/references/skill-lifecycle.md`
(`## S1 — Localization split as a first-class pattern`): the core skill holds
the discipline domain-free, and this file holds the repo-specific map.

## What a seam is

A seam is the contract boundary a test attaches to — the place where a new
behavior becomes observable without depending on internal structure. Pre-agreeing
seams is what makes the loop predictable across runs and keeps refactor safe: a
test attached at a seam survives a behavior-preserving refactor; a test welded to
internals does not.

## Step-1 absence procedure

When the seam map is absent, constructing it IS step 1 of the loop — not a
failure, not a skip. With the user, walk the repo and record, for each
boundary the project is willing to test at:

- the seam name (one short noun)
- the package or path that implements it
- the test directory and runner command that exercises it
- the shape of input the seam accepts and the shape of output it promises

Stop and confirm the map with the user before writing any test.

## Authority-honesty rule (load-bearing)

Every authority reference in the seam map — package name, source path, test
directory, runner command — MUST be real and verifiable in the current repo
state. Cite only what `ls`, glob, or the runner actually finds. A seam map that
cites a package which does not exist yet is worse than no map: it sends the loop
at a phantom boundary. If a needed boundary does not exist, say so explicitly and
build it before adding it to the map.

## AGENTS.md co-localization (load-bearing)

A consumer's `AGENTS.md` (or equivalent primary rule file) usually carries a
"testing rules" section: where tests live, what runner to use, what counts as a
unit vs integration vs e2e test. When you localize the seam map, reconcile that
section in the SAME slice. A skill seam map and a stale testing-rules section
diverge silently and become two sources of truth; the cheaper one wins and the
discipline erodes. If the two disagree, fix `AGENTS.md` to match the verified
seam map (or fix the map to match a testing rule you re-verified).

## Seam shapes

Name the shape of each seam so the test attaches at the right rung:

- **Unit seam** — a pure function or module boundary; no I/O. Test directory is
  the consumer's unit-test path; runner is the consumer's unit runner.
- **Integration seam** — a repository, port, or adapter boundary where one layer
  hands off to another (storage materialization, queue handoff). Test directory
  is the consumer's integration path.
- **E2E seam** — a CLI, HTTP, or other entrypoint that exercises the real
  service stack end-to-end. Test directory is the consumer's e2e path.

A vertical slice may cross more than one seam; that is expected. The point is
that each seam the slice touches is named in the map and has a verifiable test
home.

## Seam-map file shape

A minimal domain-free skeleton the overlay localizes. Keep every entry
verifiable:

```markdown
# <repo> TDD seams

## <seam-name>
- implements: <package or path>          # must resolve under ls/glob
- tested at: <test directory>            # must resolve under ls/glob
- runner: <exact runner command>         # must exit non-zero on failure
- accepts: <input shape>
- promises: <output shape>
```

When the consumer repo already documents test conventions, point this file at
those conventions rather than restating them — one source of truth.
