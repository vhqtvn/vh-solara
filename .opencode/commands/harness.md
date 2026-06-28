---
description: Recipe for extending vh-solara's agent harness — add an agent/command/skill via an overlay pack
agent: coordination
subtask: false
---

You are extending the harness, not editing the generated tree. Load this recipe
when asked to add an agent, command, or skill.

## Anti-patterns (do not)

- Never hand-edit a managed file under `.opencode/` or `opencode.jsonc` — those
  are regenerated on every `vh-agent-harness update` and the edit vanishes.
- Do NOT use OpenCode's built-in `customize-opencode` skill to change the harness
  — use an overlay pack. Only invoke `customize-opencode` for a specific reason
  unrelated to the generated tree.

## Golden path — add a subagent via an overlay pack

1. Run `vh-agent-harness guide` to confirm the current state and active overlays.
2. Create a pack directory: `.vh-agent-harness/overlays/<pack>/`.
3. Add `agents/<name>.md` — YAML frontmatter with `description` and
   `mode: subagent`, then a prompt body. The identity tokens — `PROJECT_NAME`,
   `PROJECT_SLUG`, `COORDINATOR_DIR` — resolve at render time (in the source
   corpus they are written as double-brace sentinels).
4. Add `opencode-append.jsonc` at the pack root with:
   - the new agent block (`description`, `mode: subagent`, `prompt:
     "{file:.opencode/agents/<name>.md}"`, and its `permission` map), and
   - `task` `allow-injections` into the core orchestrators `build`,
     `coordination`, and `project-coordinator` so they may delegate to it.
   This file is deep-merged into the rendered `opencode.jsonc`.
5. (Optional) `permission-pack.jsonc` — the pack's self-description of the
   permission entries it contributes (per-agent `location`/`task`/`gateExempt`
   plus `delegateFrom` listing the core orchestrators that get an auto-injected
   task allow entry while the pack is active).
6. (Optional) `callable-graph-snippet.md` — appended to the rendered
   callable-graph; documents routing and surfaced commands.
7. (Optional) `commands/<name>.md` — a `/name` command (frontmatter
   `description` + `agent` + `subtask`).
8. List the pack under `overlays:` in `.vh-agent-harness/vh-harness-profile.yml`.
9. Preview then apply: `vh-agent-harness update --dry-run`, then
   `vh-agent-harness update`.
10. Verify: `vh-agent-harness doctor`; confirm the rendered
    `.opencode/agents/<name>.md` and the agent block in `opencode.jsonc`;
    restart OpenCode so the new roster loads.

Worked reference overlay: run `vh-agent-harness example` to list every
configurable file, then print the embedded pack skeleton with
`vh-agent-harness example .vh-agent-harness/overlays/_pack-skeleton/opencode-append.jsonc`
(and the sibling `permission-pack.jsonc`, `callable-graph-snippet.md`, and
`agents/.keep` under that same `_pack-skeleton/` directory). That skeleton is
embedded in the binary and ships into every consumer repo, so it is the
copy-paste starting point for a new pack.

## Overlay anatomy

A pack at `.vh-agent-harness/overlays/<pack>/` carries two kinds of files:

| Kind | Files | How they apply |
| --- | --- | --- |
| Unit files | `agents/`, `commands/`, `skills/` | Rendered into `.opencode/` 1:1 (ownership `overlay_extension`; auto-overwritten while the pack stays active). |
| Merge-content | `opencode-append.jsonc` | Deep-merged into the rendered `opencode.jsonc` (nested maps recurse; new agent blocks insert, partial agent blocks add their fields). |
| Merge-content | `permission-pack.jsonc` | Materialized to `.opencode/sys-scripts/permission-packs/<pack>.jsonc`; the roster resolver reads that directory dynamically. |
| Merge-content | `callable-graph-snippet.md` | Appended to the rendered callable-graph. |
| Snippets | `*.extend.<slot>.<ext>` | Injected into a named extension slot in a core file (the slot must exist; unknown slots fail closed). |

## Shadowing rule (replacing a core builtin)

Overlays ADD new units; they do not shadow-and-replace. To REPLACE a core
builtin (e.g. rewrite `.opencode/agents/build.md` rather than add a new agent),
do NOT try to shadow it from a pack — that path fails closed. Instead raise the
path to `project_owned` in `.vh-agent-harness/harness-ownership.yml` and edit the
live file directly (raise-only: `platform_managed` -> `project_owned` is allowed;
weakening protection is rejected at apply time).
