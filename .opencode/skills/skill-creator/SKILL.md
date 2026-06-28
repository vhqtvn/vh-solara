---
name: skill-creator
description: Guide for creating and updating repo-local OpenCode skills in this coding repository. Use this whenever a user asks to create, update, improve, validate, or troubleshoot a skill under `.opencode/skills/`, or when archived sessions should be distilled into reusable coding workflows.
compatibility: opencode
---

# Skill Creator

Use this skill to create or update repo-local OpenCode skills for this repository.

The target environment is a coding repo, not the ChatGPT skill marketplace. Optimize for:

- repo-local skills under an overlay pack (see "Where skills live" below)
- archived-session mining when repeated workflows already exist
- concise, triggerable descriptions that OpenCode can select correctly
- repo-safe validation and iteration, not ZIP packaging or UI metadata

## Where skills live

**In a repo managed by `vh-agent-harness`, the `.opencode/skills/` tree is
GENERATED** — the harness renders it from `.vh-agent-harness/` plus the embedded
corpus on every `vh-agent-harness update`, so any skill you drop at
`.opencode/skills/<name>/` is overwritten and lost.

- **New skills go in an overlay pack:**
  `.vh-agent-harness/overlays/<pack>/skills/<name>/`. List the pack under
  `overlays:` in `vh-harness-profile.yml` and run `vh-agent-harness update`.
- **The `.opencode/skills/` path is ONLY correct when you are editing
  `templates/core/`** — i.e. developing the harness itself. A consumer repo must
  not hand-edit that generated tree.
- Do NOT use OpenCode's built-in `customize-opencode` skill to add a skill — use
  an overlay pack. Only invoke `customize-opencode` for a reason unrelated to the
  generated tree.
- When unsure, run `vh-agent-harness guide`; run `/harness` for the full
  add-a-skill recipe and overlay anatomy. Use `init_skill.py` with an overlay
  target path (see "Validation").

## What a good repo skill does

- captures a repeated engineering workflow, review pattern, or repo-specific convention
- reduces rediscovery cost without duplicating obvious general knowledge
- makes trigger conditions explicit enough that the `skill` tool can choose it reliably
- stays small enough to load cheaply and pushes detailed material into `references/` or scripts only when needed

## Repo-specific layout

In a harness-managed repo, create the skill inside an overlay pack; the path
shown below is relative to the pack root
(`.vh-agent-harness/overlays/<pack>/`). Use this structure by default:

```text
<pack>/skills/<skill-name>/
  SKILL.md
  references/   # optional
  scripts/      # optional
  assets/       # optional
```

(The `.opencode/skills/<name>/` path is generated — see "Where skills live". Use
it only when editing `templates/core/` to develop the harness itself.)

## When to ask questions

Ask clarifying questions when the skill scope is ambiguous. At minimum, clarify:

1. the repeated user intent or workflow
2. the expected output or decision shape
3. any repo boundaries, commands, or docs the skill must encode

Skip extra questioning when the repo already provides enough evidence:

- archived OpenCode sessions
- existing command or agent prompts
- recurring backlog or checkpoint patterns
- repeated file hotspots or validation flows

## Creation workflow

1. Understand the repeated workflow.
2. Check whether archived sessions or existing repo artifacts already show the pattern.
3. Decide the minimum skill contents:
   - `SKILL.md` only for lightweight guidance
   - `references/` for durable detail that would bloat `SKILL.md`
   - `scripts/` only for deterministic, repeatedly reused operations
4. Initialize or update the skill inside its overlay pack
   (`.vh-agent-harness/overlays/<pack>/skills/<name>/`); use `init_skill.py
   --path` with the overlay target. Only edit under `.opencode/skills/` when you
   are developing the harness itself (`templates/core/`).
5. Validate the frontmatter and structure.
6. Iterate after reviewing how well the skill would trigger.

See `references/workflows.md` for compact workflow patterns.

## Revision discipline

The workflow above covers *creating* skills. Revising an existing skill needs stricter discipline because unbounded edits quietly drift away from a working trigger surface.

- **Prefer bounded edits over rewrites.** Small scoped edits to specific sections beat whole-skill rewrites. Each non-trivial edit carries a one-line justification of intent. Large rewrites are the failure mode this guards against.
- **Strictly-improves-or-reject acceptance gate.** Before accepting a revision, name explicitly: (a) what trigger condition or output the change **improves**, and (b) what prior behavior it must **not break**. If either cannot be named, reject or rescope. This is the manual analog of a held-out validation gate.
- **Record rejected approaches.** When a proposed approach is tried and dropped during revision (or initial creation), add a short entry to `references/rejected.md` so future revisions don't re-propose it. Mirrors the workstream `rejected-options` pattern.

Rationale distilled from `researches/decisions/2026-06-22-skillopt-applicability-skill-harness.md` (operator review only; these are manual conventions, not an automated optimizer).

## Writing rules for this repo

- keep `name` lowercase, hyphenated, and matched to the directory name
- make `description` explicit about trigger phrases such as "use this when..."
- include `compatibility: opencode`
- add `When not to use` sections when adjacent skills might overlap
- prefer short output sections that tell the agent what shape to return
- avoid marketplace, upload, ZIP, or packaging language unless the user explicitly asks for export tooling
- do not assume non-coding end users; optimize for engineering and repo-maintenance workflows

## Validation

Use the bundled validator for quick checks:

```bash
vh-agent-harness exec python .opencode/skills/skill-creator/scripts/quick_validate.py .opencode/skills/<skill-name>
```

When creating a new skill scaffold, use the overlay target path in a
harness-managed repo (the `.opencode/skills/` default is generated and will be
overwritten — `init_skill.py` warns when you point it there):

```bash
vh-agent-harness exec python .opencode/skills/skill-creator/scripts/init_skill.py <skill-name> \
  --path .vh-agent-harness/overlays/<pack>/skills
```

## Output expectations

When you create or update a skill in this repo:

- change the actual skill files, do not just describe them
- keep the diff focused
- update `docs/planning/backlog.md` when the work is substantial
- summarize why the skill should trigger and how it avoids overlap with nearby skills

## References

- `references/workflows.md` for workflow shapes
- `references/output-patterns.md` for concise output sections
- `references/sample-prompts.md` for repo-oriented skill requests
- `references/rejected.md` for approaches tried and dropped (revision-history analog)
