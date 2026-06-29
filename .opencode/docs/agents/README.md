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

- Keep `opencode.jsonc` permissions synchronized via `vh-agent-harness update` (Go-native emitter in `internal/permconfig/`).
- Treat the permission tables in `internal/permconfig/tables.go` (core agents) or each overlay pack's `permission-pack.jsonc` (overlay agents) as the maintenance surface.
