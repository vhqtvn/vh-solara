# Callable Graph

## Public entrypoints

Only these should be treated as direct user-facing agents:

- `coordination` (read-only routing, default primary agent)
- `build` (execution owner, delegated by coordination)

All other agents are delegated specialists.

## Routing model

1. `coordination` routes to `build` by default.
2. `coordination` may directly call read-only specialists when scope is narrow.
3. `build` owns implementation and may call editable specialists.
4. Closeout goes through `commit-message` and/or `ship-review` as needed.

## Delegation ownership

Only these agents should fan out via `permission.task`:

- `build`
- `coordination`
- `project-coordinator`
- `commit-message` (to `commit-reviewer` only)
- `commit-reviewer` (to `commit-reviewer-a`, `commit-reviewer-b`, and `commit-reviewer-c` only; `commit-reviewer-d` deferred until premium tier is enabled)

All other specialists should keep `task: { "*": "deny" }` to prevent lateral drift.

## Specialist classes

This graph lists ONLY the CORE roster shipped by the harness. Overlay packs
(e.g. a web overlay, a project domain overlay, ...) append their own specialists
to this graph via a `callable-graph-snippet.md` that is merged onto this file
when the pack is selected in `vh-harness-profile.yml` `overlays: [...]`. Do not
hand-write overlay specialists here — declare them in the overlay pack's snippet.

- Read-only specialists (core):
  - `project-coordinator`
  - `debate`
  - `planner`
  - `researcher`
  - `repo-explorer`
  - `commit-reviewer`
  - `ship-review`
  - `solution-brief`
  - `media-perception` (opt-in via the `core/media-perception` capability;
    not in any profile preset)
- Editable specialists (core):
  - `docs-steward`

## Opt-in perception routing

`media-perception` is a single read-only perception specialist with
`task: { "*": "deny" }`. It is rendered ONLY when the project selects the
`core/media-perception` capability in `vh-harness-profile.yml`; when
unselected, the agent block is absent and the inbound edges below are
dropped by the permission emitter's present-agent filter.

Four baseline callers may delegate to it (`media-perception: allow`):

- `build`
- `coordination`
- `project-coordinator`
- `researcher` (single outbound edge on an otherwise read-only leaf, so a
  researcher holding a media locator can hand off perception)

Callers hand the specialist a locator plus a modality hint and the full
question set; the specialist returns one consolidated report with
`capability_status: available | unavailable | uncertain`. See the
`media-perception` skill for the caller-facing two-path routing guidance
(in-context perception vs single-delegation).

**Attachment propagation:** parent-session attachments do NOT automatically
propagate into a task child's context. For local media, the caller MUST pass
BOTH `@file <path>` (so the specialist receives the bytes) AND an explicit
`path: <repo-relative path>` (so the specialist has a locator to hand its
capability). For remote media, pass `url: <accessible URL>` (no `@file`
needed — the capability fetches the URL itself). If only a parent attachment
is available without a locator, the caller must request an accessible path or
URL rather than inventing one.

**Caller prompt gating:** each of the four callers carries a conditional block
in its rendered prompt (`*.md.tmpl` → `{{ if .capabilities.media_perception }}`).
When the capability IS selected, the ENABLED branch instructs the caller to
load the skill, make ONE bounded delegation, and use the dual-channel handoff.
When NOT selected, the DISABLED branch instructs the caller to NOT load the
skill, NOT delegate or probe, and to state honestly that media understanding
is unavailable in the current configuration. This ensures callers know whether
the specialist exists without discovering it through trial calls.

## Internal cluster pattern

For private helper families (implemented for debate):

- one visible orchestrator (`debate`)
- hidden helpers (`debate-*`)
- strict task allowlist on the orchestrator:
   - `"task": { "*": "deny", "debate-*": "allow" }`

#### Commit-reviewer cluster

`commit-reviewer` is an internal cluster: one visible orchestrator (`commit-reviewer`) dispatches to hidden leaves across multiple tiers. Tier structure is defined in `.opencode/config/review-tiers.json` — currently Tier 1 (free, B+C), Tier 2 (cheap, A), and Tier 3 (premium, D, disabled). The leaves are identical except for description frontmatter; running independent reviews across tiers reduces single-model blind spots. The orchestrator performs mechanical JSON aggregation with strict consensus within each tier and fail-fast escalation across tiers — all tiers must approve for an overall approve. The delegation ownership rule (§2) applies: only the orchestrator may call the leaves via `task`.

Cluster pattern:
- visible: `commit-reviewer` (orchestrator, in read-only specialists list)
- hidden: `commit-reviewer-a`, `commit-reviewer-b`, `commit-reviewer-c` (leaves, not in callable graph; `commit-reviewer-d` deferred until premium tier enabled)
- task allowlist on orchestrator: `{ "*": "deny", "commit-reviewer-a": "allow", "commit-reviewer-b": "allow", "commit-reviewer-c": "allow" }`
- leaves have `task: { "*": "deny" }` — cannot call anyone
- review modes are documented in `commit-reviewer-modes.md`

## Research-to-debate workflow

For web-grounded option discovery or creative solution finding:

- keep retrieval and source gathering in `researcher`
- hand off grounded options to `debate` for bounded comparison and critique
- do not add a second hidden web-research path under `debate-*` unless the
  callable graph is intentionally revised

## Naming consistency rule

Agent IDs must match across:

- `opencode.jsonc`
- `.opencode/agents/*.md`
- `AGENTS.md`
- `docs/coordination/*` lane and role docs

Do not keep dual IDs for one role (for example a release agent carrying both a
generic name and a project-specific name).


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
