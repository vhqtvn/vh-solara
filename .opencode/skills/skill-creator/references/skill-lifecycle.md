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
