# Fleet status configuration — operator decision brief

**Date:** 2026-09-26  
**Status:** COMPLETE (decision brief; Option B recommended: controller-owned JSONC status config via --status-config)  
**Origin:** Fleet-status configuration redesign (slice C1)  

> Promoted-from: tmp/agent-runs/watch-status-20260922/config-brief.md  
> Original date: 2026-09-26  
> Provenance: researcher -> debate -> planner pass, 2026-09-26; read-only static source inspection  
> Scope: fleet status expected worker/project roster configuration surface and application semantics.  

---

Date: 2026-09-26. Researcher → debate → planner completed, read-only.

**DO-NOT-EXECUTE: the operator must personally confirm the direction before ANY implementation.** This is a decision document, not an execution slice. No source changes, tests, git mutations, or durable state were requested or performed by this flow. Recommendations are candidates, not transition authority.

## Decision frame

- Objective: replace the awkward fleet-status roster configuration surface with an ergonomic, extensible mechanism.
- Exact question: where should expected workers/projects live, how should configuration be selected and applied, and should the unpushed roster flags survive?
- Constraints: approved `/vh/fleet/status` API, rollup honesty, condition priorities, global exact project-directory matching and blank handling remain unchanged. Controller expectations must survive missing workers/projects. Nginx, watch client and deployment authentication remain operator-owned.
- Success: one understandable source of expected scope; predictable invalid-config behavior; growth room without implementing new status semantics; bounded implementation.
- Framing confidence: not supplied at kickoff; no formal framing-confidence shift. Mechanism frame retained throughout; no manual step-back requested.

## research.md — verified source packet

Repo-first; no web research needed. The following are researcher-reported current-tree observations, inspected 2026-09-26. Tests were read, not run. Commit approval/unpushed status is supplied operator context, not independently verified here.

| ID | Finding | Source |
|---|---|---|
| E1 | Controller entrypoint is `server`; startup uses flags/env, not a general controller config loader. Root has no shared loader. No established controller config-file location was found in these paths. | `cmd/server.go:31–66`; `cmd/root.go:10–25` |
| E2 | Nonempty `VH_WORKER_SECRET` and `VH_API_TOKEN` override their controller flags. Worker uses `--controller-secret` / `VH_CONTROLLER_SECRET`. Env mapping is selective, not automatic. | `cmd/server.go:40–48,61–62`; `cmd/client-daemon-runtime.go:88–96`; `cmd/auth_flags.go:47–65` |
| E3 | Worker exposes `--project-config`, `--trust-on-open`, identity/controller flags; no general worker config-file flag identified. | `cmd/client-daemon.go:290–324` |
| E4 | Existing roster flags are `--status-worker` and `--status-project`, repeatable StringArray; daemon scope is startup-only. Tests pin worker trimming/deduplication/blank handling and verbatim project directories. | `cmd/server.go:63–64`; `pkg/server/daemon.go:46–66`; `pkg/server/status_test.go:554–648` |
| E5 | Worker `/vh/projects` describes instantiated aggregators (directory/count/epoch), not project configuration declarations. Status discovery on controller decodes only `dir`. | `pkg/web/server.go:2075–2124`; `pkg/server/status.go:776–800` |
| E6 | Project JSONC declares processes/views/display settings, not fleet enrollment. Loader preprocesses JSONC and validates; unknown fields are not explicitly rejected. JSONC helper is private. | `pkg/projectcfg/projectcfg.go:47–70,193–237`; `pkg/projectcfg/jsonc.go:3–7` |
| E7 | Worker-side `alerts.jsonc` is a file precedent with default seeding and temp-file/rename writes. State root uses `VH_STATE_DIR` or user config directory. This does not establish a controller convention. | `pkg/alerts/config.go:166–242`; `pkg/web/notes.go:49–59` |
| E8 | Managed settings poll at 1.2s and emit change notifications; this is not controller configuration application. Researcher's Go-source search found no fsnotify/SIGHUP precedent. | `pkg/web/managed.go:692–700,735–775` |
| E9 | Fleet-status cache uses registry generation/TTL and reads scope during refresh. Live configuration needs synchronized snapshots, configuration-aware cache invalidation and protection from stale in-flight publication. Last sentence is an inference from the code, not an existing feature. | `pkg/server/status.go:280–298,335–349,417–430` |
| E10 | Worker labels offer validate → revision CAS → persist → publish mutation precedent, not a controller config service. | `pkg/web/labels.go:322–376` |
| E11 | Existing unit scope tests and real-tunnel status e2e are relevant verification boundaries. | `pkg/server/status_test.go:554–648`; `tests/e2e/fleet_status_e2e_test.go:3–25` |
| E12 | Invalid worker alerts initialization disables alerts; that fail-soft policy should not automatically carry into expected-scope config. | `cmd/client-daemon-vh.go:223–227` |

**Project metadata flow:** a `fleetStatus` key in `project.jsonc` would not work today. It requires schema/loader changes, worker discovery payload changes, and controller decoding/consumption changes (E5–E6). It also only describes projects the worker can actually report. This is additional cross-boundary work, not cheap reuse of an already transported field.

**Evidence limits:** repository inspection establishes current structure, not tested implementation size or operational restart tolerance. Ergonomic benefits and effort comparisons below are predictions; mechanism choices are preferences. No controller-file convention, reload capability, or public strict JSONC utility should be claimed as existing.

## debate.md — comparison and objections

**Outcome: recommend B, with medium overall confidence.** Controller ownership is strongly supported; startup-only loading is a bounded first-version preference, conditional on operator acceptance of restart-to-apply.

| Option | What it does well | Main weakness / disposition |
|---|---|---|
| A. Existing flags | Zero new parsing; startup configuration visible in service definition/process invocation; lowest change cost. | Restart required; repeated arguments become difficult to audit at scale; awkward home for per-item settings. Rejected as primary because operator already judges this surface poor. |
| B. Controller-owned JSONC | One authoritative fleet roster remains present when workers disappear; object schema can grow; straightforward startup validation. | New loader/path/schema contract. Startup-only version still requires restart. **Recommended.** |
| C. Project declaration | Repo-local participation and metadata can travel with project ownership. | Down, uninstantiated or never-seen projects cannot report themselves. Requires discovery/schema changes. Rejected as sole expected/alerting authority. |
| D. Persisted runtime API | Supports programmatic changes without restarts. | Still needs persistence plus mutation authorization, concurrency, failure handling and a management client. Rejected for first version absent demonstrated demand. |
| B+C hybrid | Central expectations plus distributed labels/hints could be useful later. | Two-source precedence and cross-machine transport cost without current need. Defer, not reject forever. |
| B+flags override | Could temporarily preserve existing launch scripts. | Multiple authorities obscure expected scope. Prefer replacement; if compatibility is necessary, reject file+roster-flags together rather than union/override. |

### Required axis decisions

1. **File versus flags:** choose B; reject A as the long-term primary surface. Keep a single path flag as a file selector, not a roster encoding.
2. **Controller versus project:** choose controller authority. Explicitly reject project-only expected scope. **Filter/metadata and expectation/alerting are separate:** worker declarations can inform selection or labels for visible projects; absence detection needs independently retained controller expectations. Current global project roster remains both filter and missing-project expectation; no rollup redesign is proposed.
3. **Static versus live:** choose startup-only v1; reject polling, fsnotify, SIGHUP and runtime API for this first slice. Polling has an adjacent precedent (E8), but correct live application is additional state/cache work (E9), not merely a file watcher.

### Key objections retained

- A file alone does **not** solve restart-to-change. If no-restart editing is a hard requirement, reject this v1 recommendation and request a bounded live-reload design before implementation.
- JSONC similarity to project config is convention alignment, not reusable strict-loader proof.
- Labels, mutes, thresholds and poll budgets each need defined semantics. Extensible objects do not justify silently accepting settings that do nothing.
- The unpushed configuration change can be reshaped cheaply by operator choice; that is not permission to amend commits or rewrite approved API work.

## brief.md — recommendation for confirmation

### Mechanism and location

Use an explicit controller startup selector, **`--status-config=<path>`**, loading a dedicated JSONC document once. Do not add an implicit search path or env fallback in v1. `/etc/vh-solara/status.jsonc` is a possible operator-managed deployment location, **not an existing repository convention**. A fleet operations repo is another reasonable place to keep the file, independent of worker availability.

An explicit `VH_STATUS_CONFIG` could be added later if desired, but would need documented precedence; the repo does not automatically map arbitrary flags to environment variables.

### Concrete schema sketch

Proposed accepted v1:

```jsonc
{
  "workers": [
    { "id": "build-box" },
    { "id": "laptop" }
  ],
  "projects": [
    { "dir": "/srv/repos/service" },
    { "dir": "/home/operator/repos/tools" }
  ]
}
```

Concrete growth example, **illustrative future schema only; `label` is NOT accepted or implemented in v1**:

```jsonc
{
  "workers": [{ "id": "build-box", "label": "Primary builder" }],
  "projects": [{ "dir": "/srv/repos/service", "label": "Production service" }]
}
```

This satisfies the per-item growth sketch without inventing inert supported options. Mutes, thresholds, TTL and poll budgets are not approved by this document. A future label also needs an explicit consumer/display contract before being called useful functionality.

### Application and failure semantics

- No selector: preserve current unconfigured/discovered scope. Never auto-load a sample file.
- Selected missing, unreadable, malformed or schema-invalid file: refuse startup clearly, rather than silently switch to discovered scope.
- Strict validation: reject unknown fields, wrong types and trailing documents; validate object shape and required identity fields. Preserve intentional whitespace-blank ignoring and existing deduplication rather than invent stricter roster semantics.
- Worker normalization remains as currently tested. Nonblank project directories remain **verbatim**: no trimming, path cleaning, resolution, or worker binding.
- Omitted/empty arrays preserve the corresponding current empty-roster behavior; they must not be reinterpreted as an explicit watch-nothing mode.
- Read and validate before serving; apply only a complete validated startup scope. Edits have no effect until restart. There is no last-known-good live reload in v1 because there is no live reload.

### Migration proposal

Prefer removing the new `--status-worker` / `--status-project` surface in favor of the file selector, subject to operator confirmation. Do not preserve override/union rules merely for an unshipped interface. If temporary compatibility is requested, allow flags-only OR file-only and reject simultaneous use.

The configuration intent associated with `1587ffac` is the only migration target. Keep `198cd6e9`, `91c2b2f`, and `36eda6f` and their approved API behavior out of scope. Whether a later authorized change is additive or rewrites unpushed configuration history is **not decided or executed here**.

### First-slice outline — DO-NOT-EXECUTE

Candidate scope, to recheck at authorized kickoff:

- Existing `cmd/server.go`: selector, source conflict handling if retained, startup errors and conversion into existing daemon scope.
- Existing `pkg/server/daemon.go`: only minimal wiring/documentation if needed; no requirement to replace internal roster arrays with a new abstraction.
- Proposed new `pkg/server/status_config.go` and `pkg/server/status_config_test.go`: JSONC decode/validation and scope conversion.
- Existing `pkg/server/status_test.go`: retain exact matching, blanks, expected missing worker/project and current discovery behavior regressions.
- CLI tests under `cmd/`: verify current test placement before adding a proposed `cmd/server_test.go`; test removed flags or compatibility mutex and explicit error paths.
- Existing `tests/e2e/fleet_status_e2e_test.go`: assess whether its daemon-based seam exercises file loading; do not mistake daemon wiring for CLI startup coverage.
- Existing `README.md`: documented startup example, schema, restart requirement, failure policy and migration.
- No `project.jsonc`, worker discovery, auth or frontend changes. No `pkg/server/status.go` concurrency changes for static v1 unless a specific wiring need is established.

Parser design remains an implementation detail to resolve before editing: private JSONC helpers exist, but strict shared reuse is not established. Prefer a bounded reuse/extraction decision over blindly copying a bespoke comment parser. Standard Go strict field decoding uses `json.Decoder.DisallowUnknownFields()`, not a nonexistent option on `json.Unmarshal`; validate end-of-input and null/required-field behavior separately.

Test cases: comments/trailing commas per the chosen JSONC dialect; quoted strings containing comment-like text; unknown/nested keys; malformed/wrong-type/null identities; multiple documents; missing/unreadable file; blank IDs/dirs; nonblank exact dirs; no-file/empty roster behavior; unchanged missing conditions; source conflict if compatibility retained.

Proposed commands only, **not executed**:

```sh
# Lane 1: targeted packages, including CLI coverage
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./cmd ./pkg/server'
# Lane 3: real controller/worker tunnel regression boundary
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/e2e/'
```

These are targeted verification, not full-tree green; neither demonstrates a future hot-reload feature. An authorized implementation must retain actual command receipts bound to its assessed tree.

### Synthesis corrections and uncertainty

The planner output used incorrect legacy flag names (`--expected-*`), overstated a `json.Unmarshal` strict-decoding API, proposed an unapproved commit posture, and named nonexistent future filtered tests as if ready to run. Those suggestions are corrected above: actual flags are `--status-*`; decoder strictness is explicit; history policy remains operator-owned; package-level commands are only proposed. These corrections do not change the debated mechanism leader.

Confidence: high on controller ownership and the discovery/expectation distinction; medium on startup-only v1 as the ergonomic compromise and size estimate. Open uncertainties: operator restart tolerance, need for temporary launch compatibility, and exact parser reuse strategy. No runtime verification was performed.

### Operator decisions — stop here

1. **Mechanism/application:** approve controller JSONC with explicit path and restart-to-apply v1, or require a separate live-reload design first?
2. **Migration:** remove the unpushed roster flags (recommended), or retain temporary mutually exclusive flags-only compatibility?
3. **Schema scope:** approve id/dir-only v1 with labels merely illustrated, or require a separately specified functional per-item label in the initial scope?

**Next recommended command:** none yet. Reply with the three decisions; confirmation is not an automatic instruction to execute this outline. After direction is settled, a separately requested `/draft-plan` can scope implementation without starting it.
