# CLAUDE.md.template
# Rendered from this file + .vh-agent-harness/project.config.json at install time.
# Lines starting with # are comments for the template author; strip them on render.

Build vh-solara.

{{MISSION_SUMMARY}}
# (from .vh-agent-harness/project.config.json: project.mission_summary)

## Architecture

{{ARCHITECTURE_SUMMARY}}
# (from .vh-agent-harness/project.config.json: project.architecture_summary — rendered as bullets)

## How to work here

- Read `AGENTS.md` for the full harness rules (term-contract, shell hygiene,
  command hygiene, delegation, commit gate, memory model).
- Run all commands through `harness`. Do not rely on host-installed tooling.
- The coordinator is read-only; delegate all coding/research/git to specialists.
- Git mutations route through the `committer` subagent (gated-commit protocol).
- Keep scratch under `./tmp/` (repo-relative). Never absolute home-dir paths.
