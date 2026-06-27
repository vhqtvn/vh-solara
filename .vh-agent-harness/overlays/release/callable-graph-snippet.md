# callable-graph-snippet.md — `release` overlay pack.

# Merged onto .opencode/docs/agents/callable-graph.md when `release` is active.

## Release specialist (overlay)

- `releaser` — analyzes changes since the last tag, decides the semver bump,
  and creates+pushes the release tag via the sanctioned wrapper
  `scripts/release-tag.sh`. Runs on an already-reviewed HEAD; it does NOT commit
  code (the change was committed through the gated-commit protocol first).

### Delegation edges (overlay-injected)

These orchestrators may delegate a release to `releaser` (auto-injected into
each orchestrator's `permission.task` allowlist by the pack's
`permission-pack.jsonc` → `delegateFrom`):

- `build` → `releaser`
- `coordination` → `releaser`
- `project-coordinator` → `releaser`

`releaser` keeps `task: { "*": "deny" }` — it does not fan out further.

### Separation from the commit gate

`releaser` is a sanctioned PROMOTION flow on an already-committed HEAD, kept
cleanly separate from the gated-commit protocol: it carries `gate: "deny"` (it
does NOT use `commit-gate.sh`) and is not a committer-delegator. Its only
mutation is the single release tag, performed by the project wrapper.
