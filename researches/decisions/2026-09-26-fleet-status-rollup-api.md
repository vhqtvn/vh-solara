# Controller fleet-status API — design and first evidence slice

**Date:** 2026-09-26  
**Status:** COMPLETE (solution brief; recommended candidate O2: controller-origin userMux + lazy generation cache)  
**Origin:** Task card `task-2026-09-25-compact-readonly-fleet-status-rollup-api-controller`  

> Promoted-from: tmp/agent-runs/watch-status-20260922/api-brief.md  
> Original date: 2026-09-26  
> Provenance: researcher -> debate -> planner pass, 2026-09-26; read-only static source inspection  
> Scope: compact, server-reduced, read-only controller API for fleet-status rollup (GET /vh/fleet/status).  

---

2026-09-26. Read-only researcher → debate → planner pass. No implementation or tests executed; no durable state created. The prior `brief.md` is untouched. File/line observations below are static working-tree evidence, not deployment or revision-bound runtime proof.

## Decision frame

- Objective: compact, server-reduced, read-only controller API for an operator-owned smartwatch display. API only; client and deployment authentication are operator-owned.
- Settled: server-side endpoint, not bridge distillation. Do not reopen that architecture.
- Constraints: preserve render-never-compute display contract; bound acquisition cost and latency; expose incomplete coverage honestly; no transcripts; existing authentication unless a new credential requirement is demonstrated.
- Success: precise response and freshness semantics plus a narrow, verifiable first execution slice.
- Open question: which endpoint/auth/cache/roster contract can be implemented safely over the actual controller transport?
- Outcome: **debate `need_evidence`, conditional leader O2**. Contract below is the recommended candidate; transport containment is an explicit precondition to full endpoint implementation, not a demonstrated property.
- No kickoff `framing_confidence` supplied; no manual step-back. Phasing follows the concrete evidence gap, not an inferred confidence signal.

## research.md — verified packet

Source policy: repo-first, no external research required. E-labels retained across the comparison. Facts are separate from proposed defaults and design preferences.

| Evidence | Verified fact and locator |
|---|---|
| E1 | Card resolves to `.local/coordinator/tasks/task-2026-09-25t01-45-10-compact-readonly-fleet-status-rollup-api-controller.json:14–38`; API-only display fields, optional roster, unknown coverage; bearer is recommended rather than mandatory. |
| E2 | `pkg/server/coordapi.go:39–87`: coordination bearer protects reads **and mutations**; empty token permits access. It is not a read-only credential. |
| E3 | `pkg/server/daemon.go:123–196,242–263`: userMux is behind auth/CSRF; coordFront is outside user authentication. Worker-host interception precedes userMux, with an existing diagnostics exemption, not a generic API exemption. |
| E4 | `cmd/server.go:21–49`: controller startup uses flags/env settings; no expected-worker roster in this path. |
| E5 | `cmd/auth_flags.go:32–44,82–92`; `pkg/auth/auth.go:103–113,143–184,280–295`: none, OIDC, passphrase, trust-proxy modes. Public none-mode warns rather than refusing. Trust-proxy relies on configured identity header, not verified socket provenance. |
| E6 | `pkg/server/registry.go:21–115`; `pkg/server/daemon.go:368–405`: in-memory registry starts empty, add/offline/prune change state, heartbeat updates LastSeen. No cache invalidation hooks; Get/List expose worker pointers after lock release. |
| E7 | `pkg/server/proxy.go:334–406`: misleadingly named `FetchWorkerSnapshot` fetches **`/vh/diag/latency`**, not tree snapshots. `OpenStream` at 348 has no context argument; ACK read at 364 precedes cancellation watcher at 374–382; body read at 402 is unbounded. `pkg/tunnel/websocket.go:411–418` exposes stream opening. Direct consolidation read reconfirmed proxy lines 334–406. |
| E8 | `pkg/server/diag_aggregate.go:142–216`; `pkg/server/diag_aggregate_test.go:272–314`: contexts/semaphore exist, but completion waits for fetches; timeout test uses a cooperative fake, not proof of pre-ACK termination. |
| E9 | `pkg/web/server.go:2012–2027,2075–2124,2173–2211`: project discovery covers instantiated aggregators; snapshot is per project, tree-only by default without message payload. One worker snapshot is not all-project coverage. |
| E10 | `pkg/state/snapshots.go:439–455,525–618,705–735`; `pkg/state/reducers.go:1695–1717`: snapshot locks and scans resident messages to compute state. Small payload does not imply cheap polling. |
| E11 | `pkg/state/store.go:278–354`: activity and current pending gates exist; `permission_blocked` is sticky/historical. `pkg/aggregator/reconciliation.go:39–75`: reconciliation failure retains prior state; successful HTTP acquisition does not establish live upstream OpenCode truth. |
| E12 | `pkg/server/daemon.go:411–435`: worker public URLs use HTTPS host-pattern. `web/src/sync/url.ts:12–17,37–53`; `web/src/sync/store.ts:194–206`: `dir`/`session` query selection. `pkg/web/server.go:3347–3381`: `/app` is SPA; folded `/` is host shell. `host-web/src/dockview/layoutPersistence.ts:317–343` strips top-level selectors. |
| E13 | `pkg/server/coordapi_test.go:10–98`: existing server httptest auth/fallthrough/offline seams. Lane 1 is co-located Go tests in `pkg/server/`. |
| E14 | Prior `tmp/agent-runs/watch-status-20260922/brief.md:8–12,84–92,153–168` has superseded B0-first advice and useful transport warnings. `docs/architecture/06-auth.md:20–33,120–135` contains warning/refusal inconsistencies; implementation is authoritative for this design. |

### Answers by research question

1. **Placement/auth:** userMux supports more than cookie auth (E3/E5). Nginx can front none-mode or supply a trusted identity header, but must prevent direct bypass and strip/replace spoofable identity headers. Actual nginx configuration was not inspected. Coord bearer does not inherit builtin user auth (E2/E3). Neither user credentials nor coord credentials are read-only; a dedicated credential would be required for native least authority. API-only scope does not itself require a new credential when the operator deliberately owns access controls.
2. **Compute/cache:** E7–E10 justify a purpose-correct bounded fetcher and shared refresh, not per-poll fan-out. Registry transitions can inform invalidation, but hooks/copied observations must be added; instant transport close is not instant cached-body update today (E6).
3. **Roster:** flags fit current startup configuration (E4). Registry-only discovery cannot know workers that have never connected since restart (E6). Project scope must say instantiated aggregators, not filesystem projects (E9).
4. **Validators:** a timestamp changed on every request defeats stable byte identity. Publish immutable serialized generations instead; generation-stable ETags are feasible. This is a design inference, not existing API behavior.
5. **Links:** worker-origin `/app?dir=<encoded>&session=<encoded>` is the supported session route (E12). Controller-relative `/app` would select the wrong origin. Configured host mapping is necessary; DNS/auth reachability remains untested.
6. **Summary:** server English templates preserve the card's render-only requirement (E1); structured-only would move reduction back to the client.
7. **Unknown:** reconcile incomplete data with known severity through separate `overall` and `known_overall`. Timeouts are not proof of worker-down; sticky historical gates are not pending conditions (E11).
8. **Naming/version:** `/api/fleet/status`, single object, `schema: 1` is a proposed controller API naming choice, not an existing route. No evidence mandates `/api/coord/status` or `/vh/status`.

## debate.md — comparisons and objections

Three distinct bundles: **O1** coordination bearer + every-request fan-out; **O2** existing userMux authentication + shared lazy TTL cache; **O3** exact-route read-only token + shared cache.

| Axis | Leading decision | Rejected/parked alternative and reason |
|---|---|---|
| Placement/auth | O2, controller-origin userMux. GET only; normal middleware, no new worker-host bypass. | O1 distributes a mutation-capable credential and bypasses user auth (E2/E3). O3 is a valid future least-authority option, parked because new issuance/config/lifecycle work is not required by the operator-owned-auth directive. |
| Compute/cache | Daemon-owned, coalesced, lazy immutable generation cache. | Every-request acquisition amplifies lock/scan work (E10). Periodic background polling creates work without readers and is unnecessary for first slice. |
| Roster | Optional repeatable `--status-worker=<id>`; configured IDs define scope. No roster means explicitly discovered scope. | Consumer-only roster violates server reduction. Persistent roster database/config subsystem is unnecessary. Discovery must not claim an exhaustive fleet inventory (E6/E9). |
| ETag | Strong hash of exact published JSON bytes, timestamps included. | Weak condition-only validator could leave displayed freshness metadata obsolete. Last-Modified has less precision and does not solve acquisition cost. No validator is simpler but discards the requested conditional-response contract. |
| Summary | Fixed server English, ≤30 Unicode code points. | Structured-only requires client composition; localized templates are unnecessary for this consumer. |
| Unknown | Incomplete required observations force unknown; known severity remains separate. | Degraded-over-unknown alone obscures unobserved conditions. Unknown alone without known severity erases confirmed problems. |

**Critical objection:** O2's cache reduces frequency but does not prove bounded underlying work. Pre-ACK/open-stream cancellation and body limits are unresolved (E7/E8). Debate returned **need_evidence**, not a settled implementation ranking. Read-only planning cannot close that execution gap.

**Consolidation corrections:** debate overstated O2's least-authority benefit: its credentials are still not scoped. Planner omitted schema/max-age/known severity, gave an inconsistent down-worker/complete example, incorrect `pkg/server/tunnel` and `pkg/server/auth` paths, and misstated cancellation as absent after ACK. Those are not accepted findings. Debate did not propose a worker-host exemption; planner's attribution to it was erroneous. A bare `io.LimitReader(n)` silently truncates rather than proving oversized-response detection. The execution slice below requires cap-plus-one validation and retains pre-ACK/open coverage, not just post-ACK reads.

## brief.md — refined candidate contract

### HTTP and authentication

`GET /api/fleet/status` on the controller origin, routed through userMux. Other methods return 405; no mutations, transcripts, or arbitrary proxy target input. Existing auth failures retain middleware behavior (including login redirects where applicable), not a fabricated universal 401 contract. GET remains CSRF-exempt under existing policy. No coord-token alternate access. Operator nginx can constrain path/method and origin exposure; builtin none-mode remains unauthenticated unless protected externally. Document that trust-proxy must not be directly reachable by untrusted clients.

### Full response shape — illustrative incomplete configured fleet

```json
{
  "schema": 1,
  "overall": "unknown",
  "known_overall": "degraded",
  "summary": "Unknown; 2 permissions",
  "gauge": { "value": 0, "available": false, "label": "Coverage incomplete" },
  "coverage": {
    "mode": "expected",
    "inventory_known": true,
    "complete": false,
    "project_scope": "instantiated",
    "required_workers": 2,
    "observed_workers": 1,
    "unknown_workers": 1
  },
  "conditions": [
    { "kind": "permission_pending", "count": 2, "since": "2026-09-26T10:00:00Z", "label": "2 permissions pending", "link": "https://alpha.example.test/app?dir=%2Frepo&session=s1" },
    { "kind": "worker_down", "count": 1, "since": "2026-09-26T10:00:03Z", "label": "1 worker down", "link": null }
  ],
  "workers": [
    { "id": "alpha", "status": "ok", "observed_at": "2026-09-26T10:00:04Z" },
    { "id": "beta", "status": "offline", "observed_at": null }
  ],
  "generated_at": "2026-09-26T10:00:05Z",
  "max_staleness_ms": 15000
}
```

Example URL is illustrative, not a claim about deployed hostname mapping.

### Field rules and rationale

- `schema`: integer 1. Additive optional fields may extend v1; incompatible semantic changes require a new schema/explicit migration, never silent reinterpretation.
- `coverage.mode`: `expected|discovered`. Expected uses normalized, deduplicated configured IDs only; other connected workers are excluded. Discovered uses copied registry membership, including known offline workers. `inventory_known` means **an explicit intended scope is configured**, not proof that no other real machines exist.
- `coverage.complete`: every required worker/project acquisition succeeded within bounds and validity age; discovered-empty is explicitly false. Nonempty discovered scope can be complete **within that scope** while inventory_known remains false. Configured absent workers are `missing`; registered closed/offline workers are `offline`. Missing/offline imply incomplete session coverage. A successful discovery returning zero projects is valid zero-session coverage. Mid-refresh roster-generation change invalidates the result. Filesystem projects outside instantiated aggregators are not promised.
- `required_workers`: scope size; `observed_workers`: workers with wholly successful discovery and all required project snapshots; `unknown_workers = required_workers - observed_workers`. Any failed/limited project makes that worker incomplete. A discovered-empty fleet has all three counts zero but complete=false.
- `workers`: sorted by ID. `status` exact enum `ok|offline|missing|timeout|error|limited`. `limited` covers configured byte/project/worker caps; malformed/non-2xx responses use error. `observed_at` is completion time of a wholly successful worker acquisition, otherwise null; no last-good timestamp is laundered into success.
- `known_overall`: `degraded|attention|nominal`, in that priority. Down/missing/session_error → degraded; current pending permission/question or session_retry → attention; otherwise nominal. Nominal here means no known condition, not confirmed health.
- `overall`: same three values plus `unknown`. If coverage incomplete, unknown overrides severity; otherwise equal known_overall. This cleanly preserves the card's known severity ordering and its incomplete-data rule.
- `conditions`: at most one aggregate per kind, nonzero counts only, exactly this order: `permission_pending`, `question_pending`, `worker_down`, `worker_missing`, `session_error`, `session_retry`. Wait/error/retry counts are sessions; down/missing counts are workers. A session can contribute to multiple distinct kinds, so condition counts are not summed as unique sessions. Only own-session gate activity is used; subtree_busy does not double count. `permission_blocked` and finish_reason alone do not establish a current pending/error condition. Timeout/error acquisition does not imply worker_down.
- Contributions from successful project observations can remain visible even when another project fails; denominator and overall remain unavailable/unknown. Failed observations never contribute last-good waits as current. Observations describe the worker store, not guaranteed upstream OpenCode freshness (E11).
- `since`: nullable UTC RFC3339 first continuously observed controller time for current contributors; minimum across known continuous contributors. Reset a contributor after loss of evidence, disappearance, reconnect or restart; do not infer upstream event time. Null until continuity can be established. Routine intervals between valid cache refreshes are not evidence gaps.
- `label`: server-authored English. `link`: nullable absolute trusted worker-origin `/app` URL with encoded dir/session. Choose representative contributor by worker ID, directory, session ID; never use arbitrary request Host. No host mapping or offline/missing target ⇒ null in v1. No credentials in links. UI routes are verified, deployed link reachability is not.
- `summary`: bounded server English ≤30 Unicode code points, fixed templates/count abbreviations. Unknown prefixes `Unknown; ` with highest-priority known condition, or `Unknown coverage`. No conditions + complete ⇒ `Nominal`. Labels/gauge are server display text; client never reduces fleet facts.
- `gauge`: preserve object/numeric card contract. Value is own busy-or-retry sessions / total included sessions, clamped 0–1. Complete zero-session scope ⇒ value 0, available true, label `No sessions`. Incomplete ⇒ value 0 **placeholder**, available false, label `Coverage incomplete`. Availability is a render directive, not client inference.
- `generated_at`: UTC RFC3339 publication time of immutable generation. `max_staleness_ms`: client display-age ceiling, not a guarantee of upstream health. Do not derive new timestamps per GET. Global refresh budget bounds acquisition skew; stale status must not be hidden behind a recent publication timestamp.

### Cache/freshness mechanics

Proposed unmeasured defaults: 5 s refresh TTL, 15 s display maximum age, 3 s total refresh budget, 2 s per-worker end-to-end budget including queue/discovery/projects, 8 concurrent workers, sequential project reads per worker, 1 MiB per response, 8 MiB cumulative per worker, 64 projects per worker, 128 workers per refresh. Deterministically mark budget/cap exclusions limited/timeout; do not silently truncate into complete coverage. These are initial safety budgets, not throughput claims.

Cache lives in a Daemon-owned status service; one refresh in flight, reused by concurrent callers, service-owned context rather than first caller ownership. Registry value-copy/generation API avoids mutable pointer races. Invalidate membership/liveness changes (add, offline, remove/prune/reconnect), not every heartbeat. Recheck copied transport state before serving. Detected changes prevent serving a stale nominal generation; build a current incomplete liveness projection or run bounded refresh. Stale in-flight generations cannot overwrite newer liveness. This guarantees invalidation when **observed**, not zero-latency discovery of real network failure.

Requests within valid TTL return immutable bytes. After TTL, coalesce a bounded refresh; do not indefinitely serve last-good conditions. Failure publishes explicit incomplete observations, not stale pending conditions stamped fresh. Stale generation must not remain eligible for 304 after invalidation/TTL. `ETag` is quoted strong hash of exact serialized body, stable within generation; regenerate timestamp/body/tag only on publication. Evaluate If-None-Match according to HTTP semantics. Send `Cache-Control: private, no-cache` and ETag on 200/304; no shared proxy cache authorization. A 304 never advances observation time or the client's display-age deadline. Conditional requests save transfer within TTL, not worker refresh cost across TTL. Last-Modified unnecessary.

## First execution brief — resolve evidence gap, not build the entire API

**Slice S1 objective:** establish a purpose-correct, resource-bounded JSON read path over the actual multiplexed transport. Preserve existing diagnostics behavior. No status endpoint/cache/roster/client implementation yet.

**Exact proposed S1 files:**
- New `pkg/server/status_transport.go`: narrowly scoped internal worker-JSON acquisition seam with explicit paths/budgets, if a parallel helper is the safer implementation.
- New `pkg/server/status_transport_test.go`: containment and actual multiplexer tests in lane 1.
- Existing `pkg/server/proxy.go`: inspect/reuse framing; modify only if sharing is necessary and diagnostics semantics stay unchanged.
- Conditional scope expansion **only if stream opening requires it**: `pkg/tunnel/websocket.go` and co-located `pkg/tunnel/websocket_test.go`. Reconfirm actual test placement before editing; expansion adds `go test ./pkg/tunnel/`, not a false server-only proof.

**Required sequence and acceptance:**
1. Re-derive transport/auth/snapshot premises below and inspect actual transport interface/yamux version. Establish whether stream-open can be bounded without abandoning goroutines or closing the parent tunnel. Do not assume a context argument or deadline method exists.
2. Author deterministic adversarial tests using the real multiplexer path (loopback/in-memory peer acceptable; cooperative fetch fake insufficient). Cases: stream-open blocked/saturated, blocked handshake write, ACK never arrives, stalled HTTP headers, stalled body, body cap+1, malformed/non-2xx, normal successful tree JSON.
3. Prove a single end-to-end context bounds **all stages**, not just body read. Bound handshake/header/body allocation. Detect excess body by bounded cap-plus-one read and explicit limit error, not silent LimitReader truncation. Reclaim streams/watchers on completion/cancel; repeated stalled requests must not accumulate retained work. No claim that closing transport cancels worker snapshot CPU.
4. Keep another stream on the same tunnel working during and after cancellation/limit failures. Show transport ownership cleanup and no parent-session teardown. Assert deadline with bounded test tolerance, not arbitrary exact wall-clock equality.
5. Run targeted proof and full lane 1; retain command/outcome/tree binding in eventual execution closeout. No proof claims from the test names or from this plan.

**Commands, after tests exist:**

```text
vh-agent-harness exec /usr/local/go/bin/go test ./pkg/server/ -run TestStatusTransport -count=1 -v
vh-agent-harness exec /usr/local/go/bin/go test ./pkg/server/
```

`TestStatusTransport` is a proposed test prefix, not an existing runnable proof. If tunnel package changes: additionally `vh-agent-harness exec /usr/local/go/bin/go test ./pkg/tunnel/`. Race/stress probes may supplement, never replace the adversarial acceptance cases. The server package command is full **lane 1 package coverage**, not full repository verification.

**Success branch:** concrete retained receipt demonstrates all stages bounded and unrelated stream survival; return the measured constraints through researcher/debate to confirm O2, then draft API implementation slice. Likely later files: `cmd/server.go`, `pkg/server/daemon.go`, `pkg/server/registry.go`, new `pkg/server/fleet_status.go`, `fleet_status_test.go`, registry tests and relevant durable API docs (only in a separately authorized implementation session).

**Failure/infeasible branch:** return `inconclusive/not-demonstrable` or failed with exact limiting stage; no endpoint promotion. Refresh researcher on the named transport fact and re-run bounded debate before choosing transport changes or a different acquisition strategy. A missing test seam is not proof the transport is impossible. Neither planner prose nor this brief is implementation authorization.

### Load-bearing premises as 4-tuples

`Read(path, lines)` is a side-effect-free read-tool re-derivation instruction, not an invented shell command. Re-read before acting; observed_at below is the static research pass date, not runtime proof.

| value | source | re_derivation_command | observed_at |
|---|---|---|---|
| userMux is user-auth protected; coord bearer independently permits mutations | E2/E3 | `Read(pkg/server/coordapi.go,39–87); Read(pkg/server/daemon.go,123–196)` | 2026-09-26 |
| none/OIDC/passphrase/trust-proxy exist; public none warns and header trust depends on deployment | E5 | `Read(cmd/auth_flags.go,32–92); Read(pkg/auth/auth.go,103–184); Read(pkg/auth/auth.go,280–295)` | 2026-09-26 |
| existing helper requests diagnostics and installs cancellation only after ACK | E7, directly reconfirmed | `Read(pkg/server/proxy.go,334–406); Read(pkg/tunnel/websocket.go,411–418)` | 2026-09-26 |
| registry is memory-only with pointer views, no cache-generation hooks/expected roster | E4/E6 | `Read(cmd/server.go,21–49); Read(pkg/server/registry.go,21–115)` | 2026-09-26 |
| acquisition must discover instantiated projects then use per-project tree snapshots | E9 | `Read(pkg/web/server.go,2012–2124); Read(pkg/web/server.go,2173–2211)` | 2026-09-26 |
| worker UI link uses worker-origin /app and dir/session query selectors | E12 | `Read(pkg/server/daemon.go,411–435); Read(web/src/sync/url.ts,12–53); Read(pkg/web/server.go,3347–3381)` | 2026-09-26 |

## Contradictions, confidence, next command

Card refinements requiring acknowledgment: actual snapshot helper is diagnostics; degraded-first versus incomplete→unknown requires known_overall; gauge remains numeric/object but gains availability; roster/cache/transport extend the implied file scope; instantiated-project scope and worker-store freshness are narrower than an unqualified live fleet claim. No client work or new auth system is smuggled into scope.

High confidence in cited static findings; medium in O2 design preference; low/unmeasured in default budgets and live deployment behavior. No tests executed, no benchmark, no live nginx/DNS/auth verification, no tree-bound behavioral receipt. Prior brief untouched; only this scratch brief written.

**Next recommended command:** `/draft-plan Resolve S1 transport containment evidence from tmp/agent-runs/watch-status-20260922/api-brief.md; no fleet endpoint implementation before the evidence gate.` After an execution session authors the tests, run the lane-1 commands above. This preserves the debate's need_evidence verdict rather than presenting a provisional contract as proven.
