# Skill lifecycle rules

Two rules governing how craft skills are structured across the core/overlay
boundary and how new core skills reach `templates/core/`. These are distinct
from skill-design craft (`references/skill-design-vocabulary.md`), which governs
content quality within a skill.

## S1 — Localization split as a first-class pattern

When a craft skill carries repo-specific examples (a debug-loop recipe, a TDD
seam list, an e2e chain template), standardize on:

> **core discipline skeleton + contracted overlay localization file**

The core skill holds the discipline (steps, checks, failure modes) domain-free.
It references a **named localization artifact** for the repo-specific material
(e.g. `<repo>-debugging-loops.md`), and the **absence of that artifact is step 1
of the workflow**: "no localization file found → construct one with the user
before proceeding."

This is the repo's "stub with a contract over premature implementation" default
(AGENTS.md → repo-level engineering defaults), generalized to skills. The core
never hardcodes a repo's hotpaths; the overlay never reimplements the
discipline. A consumer that lacks the localization file gets a clear, actionable
gap instead of a skill that silently assumes the wrong repo.

### Placement — overlay dir mirroring the core skill name

The localization file's recommended home is an **overlay directory mirroring the
core skill name** — `.vh-agent-harness/overlays/<consumer>/skills/<skill-name>/<repo>-<localization>.md`,
holding only the localization file (no `SKILL.md`). Per the overlay merge model
documented in `.opencode/commands/harness.md` (→ Overlay anatomy / Shadowing
rule: overlays ADD new units and render 1:1 into `.opencode/skills/`; they do
not shadow-and-replace a core builtin), the core's `SKILL.md` and `references/`
survive byte-identical and the localization file lands as a sibling — no shadow,
no drop. This placement has been validated in practice via
`vh-agent-harness update --dry-run` and a real `update`.

## S2 — Overlay-pilot-then-promote

A new core skill MUST pilot in at least one overlay against a real repo before
promotion to `templates/core/`.

Rationale: `templates/core/` ships into every consumer's baseline context-load
(see `references/skill-design-vocabulary.md` → The two loads). A half-baked skill
promoted too early taxes every consumer's context whether they use it or not.
Piloting first proves the trigger surface, completion criteria, and failure-mode
coverage against a real workload. This dovetails with the existing `--dry-run`
preview discipline and the domain-free-core rule (AGENTS.md): pilot, observe,
then promote only what survived.

### Stable hold-ID + evidence-record contract (release-relevant state)

S2's "held for pilot" state is release-relevant: a release-readiness gate must
be able to discover, from canonical records alone, whether a held skill's pilot
has landed. Rather than redesigning S2, pin a two-surface contract that any
release gate can cross-check by a stable join key:

- **Canonical backlog row (the hold).** When a skill/design is held under S2,
  create a tagged row in the project's canonical backlog carrying a STABLE HOLD
  ID of the form `s2-hold: S2-<skill>-001` — the `s2-hold:` token prefix is what
  a release gate enumerates rows by. This row is authoritative for "a strict S2
  hold exists."
- **Evidence packet slot (the verdict).** In the project's evidence/research
  packet, create a slot joined to that SAME stable hold ID, carrying a verdict
  of `PENDING` or `SATISFIED`. This slot is authoritative for "the pilot
  succeeded."

Lifecycle of the hold:

1. **On hold:** create the tagged backlog row + a `PENDING` evidence slot, both
   carrying the same stable hold ID.
2. **On pilot landing:** add real pilot provenance (which repo, which workload,
   what was observed) + positive evidence to the slot, then set its verdict to
   `SATISFIED`.
3. **On resolution:** only AFTER the slot is `SATISFIED`, resolve (close) the
   backlog row.

The join key is the STABLE HOLD ID — never narrative prose. A release gate
cross-checks both surfaces and blocks while any hold is `PENDING`, while the two
surfaces disagree, or while the join is missing, duplicated, or ambiguous. This
keeps S2's release-relevant state discoverable without altering S2's core
pilot-then-promote discipline.
