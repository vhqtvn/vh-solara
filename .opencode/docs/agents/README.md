# OpenCode Agent Governance

This folder contains long-term, reference-only governance docs for the repo's OpenCode agent topology and permissions model.

Use these docs to keep:

- user-facing entrypoints minimal
- specialist behavior predictable
- sensitive host/git/data operations gated

Documents:

- `callable-graph.md`: canonical call graph and public vs internal surfaces
- `read-only-execution-policy.md`: "read-only with controlled execution" model
- `permission-templates.md`: hardened `opencode.jsonc` template blocks

Operational note:

- Keep `opencode.jsonc` permissions synchronized via `.opencode/sys-scripts/update-opencode-config.js`.
- Treat `COMMANDS`, `LOCATION_RULES`, `TASK_RULES`, and `CLUSTER_DEFS` in that script as the maintenance surface.
