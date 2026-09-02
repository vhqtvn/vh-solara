# Shell Execution Doc Reconciliation and Ownership Pinning

Date: 2026-09-03 · Scope: Shell execution doc sync (vh-agent-harness 0.26.2)

## Outcome in one paragraph

We successfully reconciled our consumer-owned `docs/ai/shell-execution.md` with the new managed platform version shipped by `vh-agent-harness 0.26.2`. The file was pinned as `project_owned` via a new `.vh-agent-harness/harness-ownership.yml` to preserve its consumer ownership status across harness updates. We folded in the platform content we lacked (the exec-family verb table, forbidden-pattern precedence, canonical-alternatives table, and repo-relative paths enforcement) while keeping our project-specific sections ("The Network-Fetch Reality", "Git Operations", and the `readonly-scripts.sh` wrapper naming). The `migration-stalled` note in `doctor` is now cleared.

## Rejected Option: Overlay-Pack Promotion

Overlay-pack promotion was **REJECTED** due to a mechanism mismatch: per platform `corpus.go:40-46`, overlay packs mirror only the `.opencode/` subtree (`agents/`, `skills/`, `commands/`) and carry no `docs/` paths. Therefore, the `project_owned` override approach was chosen instead.

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Platform source matched 0.26.2 | Manual comparison between sibling checkout `../vh-agent-harness/templates/core/docs/ai/shell-execution.md` and locally rendered platform output | yes |
| Ownership override created | `.vh-agent-harness/harness-ownership.yml` created with `class: project_owned` | yes |
| `doctor` healthy & migration-stalled cleared | `vh-agent-harness doctor` → `HEALTHY`, `0 problem(s), 1 warning(s)`. Logs `1 project-preserved (ownership override)` | yes |
| `diff` clear (no drifted files) | `vh-agent-harness diff` → `0 drifted-vs-render` | yes |

## Contradictions

None detected. The platform document content and the local project extensions were compatible without conflicts.