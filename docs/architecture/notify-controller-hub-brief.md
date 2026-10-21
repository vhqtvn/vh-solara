<!-- Promoted from tmp/ 2026-10-21; approved by operator; authority chain: brief → notify-fcm.md v4 §9 -->

# 1. **Chosen architecture**

**Recommendation: controller-pull, with a new durable, enriched worker feed—not polling today's history unchanged.** Debate verdict: **lean**, medium confidence. Workers remain the only detection authority; the controller owns fleet-wide registration, merged history and FCM delivery. This is a design proposal, not implementation approval.

Decision frame: one controller URL and one phone registration; automatically cover newly connected, compatible workers; preserve Pulse 0.3.0's protocol; keep credentials controller-only; prevent concurrent local/central sending; recover retained notices across ordinary restarts and disconnections. The open decision is transport, identity, ownership and migration—not whether to centralize.

| Alternative | Reasoned disposition |
|---|---|
| **Controller-pull** | Choose initially. Reuse the bounded internal GET transport over yamux, including deadlines, body limits and stream—not tunnel—cleanup (`pkg/server/status_transport.go:113–145`). Costs are polling latency and idle work; neither has been measured. |
| **Worker-push with durable batch ACKs** | Reject for the first release, not forever. It can reduce idle requests and dispatch latency, but needs a new reverse event/ACK protocol; current worker-originated stream handling is heartbeat-oriented (`pkg/server/daemon.go:618–642`). ACKs prove ingestion, not phone delivery. It needs the same durable source and dedupe as pull. |
| **Hybrid: push wakeup + pull repair** | Defer pending measured latency/load. It preserves pull recovery and can improve latency, but adds a second mechanism. Hints must remain expendable; periodic repair remains mandatory. |

**Reliability boundary:** exactly-once *central ingestion of durably recorded source events* is the target. Neither exactly-once phone delivery nor unlimited offline retention is promised. Today's ring retains 500 events, swallows persistence failures and restarts empty on missing/corrupt state (`pkg/alerts/history.go:21–27,68–92,108–147`). It cannot satisfy the stated reliability goal unchanged. Events occurring while detection itself is stopped are also outside replay guarantees.

Use a persistent source epoch and sequence, preserved across ordinary worker restarts. Deduplicate `(source_id, epoch, seq)`; assign a separate contiguous controller ID in commit order. Commit event, dedupe, source cursor and dispatch intent together. Use a journal/transactional storage boundary with explicit error reporting and recovery; storage-engine selection remains within the approved implementation design, not an assumption that independent JSON writes are atomic together.

# 2. **Data flow and wire contract v3 → v4**

## Detection, ingestion and sending

1. Worker engine detects a notice and durably appends an enriched source record before declaring it available for centralized delivery. Preserve subtype, session/root/project/title/detail, detection timestamp, origin-worker attendance, profile eligibility and effective cooldown. Current public history omits subtype and attendance (`pkg/alerts/history.go:34–43,119–128`); current sender evaluates profile, attendance and cooldown downstream (`pkg/alerts/notify.go:390–408`).
2. Controller discovers compatible workers through its connected-worker registry, negotiates ownership, and polls each eligible source independently. Existing registration binds a transport to a worker ID but authenticates registration only when its secret is configured; it is not a new ownership capability (`pkg/server/daemon.go:502–514,586–616`; `pkg/tunnel/types.go:15–27`). Require authenticated enrollment and stable source binding. A self-asserted worker ID is not sufficient security evidence.
3. Fetch bounded pages using the committed source cursor. Permit one active fetch per source, bounded fleet concurrency, fair scheduling, deadlines and bounded page/byte work per round. Retry reads after failure; never advance the cursor before commit. A proposed starting poll interval is 3 seconds, subject to measurement—not a latency guarantee.
4. Controller appends global history and dispatch intent atomically. Worker retention reclamation must rely on a later controller durable-watermark acknowledgment, not merely a successful HTTP response. This bounded retention ACK can be part of enrollment/control; it does not make event transport worker-push.
5. Controller applies token policy and scopes, then sends FCM. Phone reconciles controller history and fleet status. History records notices even when delivery is suppressed.

**Attendance:** capture attendance on the originating worker when detection occurs. A tab attending worker A does not suppress B. `always` bypasses attendance only—not disabled tokens, explicit scopes, cooldown or stale-event policy. Preserve worker profile eligibility independently of whether it has FCM credentials. Centralize delivery cooldown under `(source_id, notice_type, token_hash)` and persist its decisions; retain worker detection suppression, but do not apply another local FCM cooldown to centrally owned events. This makes delayed replay deterministic and avoids A starving B. Detection-time attendance is an explicit v4 semantic choice; current code measures it at `Send` (`pkg/alerts/notify.go:399–405`).

**Ownership fence:** a controller-mode worker starts with local FCM disabled, before tunnel connection. For a previously standalone worker, quiesce and drain local sends while continuing durable detection; serialize watermark H with event assignment; persist controller ownership and H before ACK. Local delivery is permitted only at/below H; central dispatch only above H. Import older retained events as history-only. A lost ACK is reconciled against persistent state; a disconnect never restores local authority. State corruption or missing ownership in controller mode fails closed. Alerts currently initialize before the tunnel agent starts, so negotiation after connection alone is too late (`cmd/client-daemon.go:62–79`; `cmd/client-daemon-vh.go:310–326`; `pkg/web/alerts_feature.go:42–54`).

## Registration and public route ownership

Phone → authenticated controller `/vh/notify/tokens`; controller stores the token centrally. Keep cookie authentication and `X-VH-CSRF: 1`. Public `/vh/notify/*` is central on the main host and every worker subdomain; do not expose worker-local tokens/history there. Existing interception already covers those hosts, but serves the wrong contract (`pkg/server/daemon.go:464–480`).

Illustrative v4 request; placeholder is not a real token:

```http
POST /vh/notify/tokens
X-VH-CSRF: 1
Content-Type: application/json

{"token":"<secret-token>","label":"Operator phone","push_policy":"always"}
```

```json
{"ok":true}
```

Return HTTP 200. Add `push_policy` to the validated DTO; do not remove strict decoding indiscriminately. Omitted policy retains the v3 full-state default `when_unattended`; repeated POST updates registration policy/label, not creates duplicates. The worker success shape is `{"ok":true}`; Pulse sends `always` and accepts successful HTTP without parsing the response (`pkg/web/notify_feature.go:60–71`; `../vh-agent-pulse/mobile/src/main/kotlin/dev/vh/agentpulse/mobile/data/solara/SolaraClient.kt:230–241,345–350`).

GET probe example:

```json
{"enabled":true,"count":1,"policies":{"when_unattended":0,"always":1},"last_attempt":"","last_error":""}
```

Preserve the worker probe fields (`pkg/web/notify_feature.go:80–91,131–136`). `enabled` reports controller sender configuration/readiness, not that every worker is covered; expose coverage separately in admin diagnostics. Pulse currently uses probe HTTP success rather than these body fields for connection verification (`../vh-agent-pulse/mobile/src/main/kotlin/dev/vh/agentpulse/mobile/data/solara/SolaraClient.kt:155–165,330–359`). Never return raw token values.

The proposed worker feed is **private**, e.g. `/vh/internal/notify/feed`, with authenticated controller-only access. Deny it through main-host, worker-host and generic public proxy paths; a private-looking prefix alone is not authorization. Reuse bounded GET transport where appropriate; enrollment and durable-watermark mutation need a separate authenticated control operation, not side-effecting GET.

## Global history and Pulse compatibility

Phone → controller `GET /vh/notify/history?since=40&limit=50`:

```json
{
  "events": [{
    "id":41,"type":"waiting","sessionID":"ses_example","root":"ses_root",
    "project":"/workspace/example","title":"Review requested","detail":"Question pending",
    "ts":1792454400000,
    "kind":"question_pending","count":1,"label":"bason — Review requested",
    "worker":{"id":"bason","name":"bason"},
    "source":{"epoch":"epoch-example","seq":128},
    "ui_url":"https://worker.example/app?session=ses_example&dir=%2Fworkspace%2Fexample"
  }],
  "lastId":41,
  "coverage":{"complete":true,"gaps":[]}
}
```

This is a **proposed** payload, not observed output. Preserve existing `sessionID` spelling and numeric `ts`, with additive condition/display/origin fields. The worker's existing fields/types are at `pkg/alerts/history.go:34–43`. `kind/count/label` let Pulse project meaningful records instead of defaulting absent kind to `unknown` (`../vh-agent-pulse/mobile/src/main/kotlin/dev/vh/agentpulse/mobile/data/PulseRepository.kt:643–649`). Define mappings for every emitted notice type before release; do not reconstruct missing historical subtype from free text.

**Timestamp compatibility is a release gate, not a settled fact.** Pulse declares `ts: String?`, while worker v3 emits a number (`../vh-agent-pulse/shared/src/main/kotlin/dev/vh/agentpulse/shared/solara/SolaraHistory.kt:29–69`; `pkg/alerts/history.go:42`). Numeric-token coercion was not executed in this pass. Keep the example numeric to preserve v3; run this exact fixture through the shipped Pulse parser before declaring no-client-change compatibility. If rejected, silently changing `ts` to a string is **not additive**. Stop for an explicit client fix or negotiated compatibility representation; adding another timestamp field does not repair a failing existing decoder.

Global sequencing rules:
- IDs are assigned only with committed central records, never copied from workers or sorted retrospectively by timestamps.
- For `since>0`, return oldest-first records strictly above the cursor; `since=0` returns the newest page ascending, matching current history behavior (`pkg/alerts/history.go:150–188`). `lastId` is the committed global head; page from the last received ID, not directly to that head.
- Apply retention only as prefix truncation. Worker removal, suppression, token scope and delivery failure must not create holes; no per-worker filtering of this legacy cursor stream.
- Pulse detects a central retention gap when the first received ID exceeds its cursor+1, clears its cache, and requests a fleet refresh (`../vh-agent-pulse/mobile/src/main/kotlin/dev/vh/agentpulse/mobile/data/PulseRepository.kt:548–610`).
- Source gaps are different: additive `coverage.gaps` reports source/epoch/missing sequence range. Do not fabricate global ID holes to force refresh. Pulse 0.3.0 will not understand this extension; a source-gap diagnostic and richer client UX require follow-up.
- Preserve central IDs across ordinary restarts. Do not silently recreate a missing/corrupt central ledger at ID 1. Fail closed and require restore/recovery disposition. Pulse's inspected reconciliation does not demonstrate automatic recovery from head regression (`PulseRepository.kt:548–585`, same path above).

## FCM and worker deep links

Illustrative data-only FCM message:

```json
{
  "message": {
    "token":"<secret-token>",
    "data": {
      "vh_kind":"notice","vh_event":"waiting","vh_condition":"question_pending",
      "vh_count":"1","vh_ts":"1792454400000",
      "vh_worker_id":"bason","vh_worker_name":"bason",
      "vh_session_id":"ses_example","vh_history_id":"41",
      "vh_ui_url":"https://worker.example/app?session=ses_example&dir=%2Fworkspace%2Fexample"
    },
    "android":{"priority":"HIGH","collapse_key":"waiting","ttl":"3600s"}
  }
}
```

Preserve existing five keys and string types; worker/session/history/link keys are additive proposals. Existing waiting messages map to permission/question conditions with HIGH priority; finished maps to `session_unread` and session_started to itself, both NORMAL (`pkg/alerts/notify.go:327–375`; `pkg/alerts/notify_test.go:390–413,478–484`). The shown TTL is illustrative; use configured TTL and remaining event freshness, not a fresh full TTL for old replay. Keeping collapse-by-type may collapse wakes from different workers; history remains authoritative. Do not promise one phone banner per notice.

Construct links from the controller's configured worker URL, never an untrusted feed URL: existing worker URLs derive from HostPattern (`pkg/server/daemon.go:651–672`); SPA paths support `/app` with `session` and `dir` query parameters (`pkg/web/static_assets.go:313–322`; `web/src/sync/url.ts:1–45`). Omit a direct link when no usable worker host is configured; do not invent a path-based worker route. The actual deployment's worker host pattern was not inspected.

Pulse currently opens its own dashboard on notification taps; consuming the new link needs an app change (`../vh-agent-pulse/mobile/src/main/kotlin/dev/vh/agentpulse/mobile/data/notifications/AndroidNotificationPresenter.kt:55,80–85`). Browser login is separate from native-app login; existing browser redirects and cookie-domain rules still apply (`pkg/auth/auth.go:94–99,208–234`; `pkg/auth/handlers.go:132–162`). **Core central registration/push/history should require no app feature change, subject to the timestamp/parser gate; worker deep-linking does require one.**

# 3. **Failure-mode table**

| Failure | Required v4 behavior |
|---|---|
| Controller restart | Recover committed events, source cursors, dedupe, ownership and dispatch decisions together. Re-pull uncommitted pages. A prepared-but-unclaimed intent can proceed; an attempt durably claimed before the crash is ambiguous and is not blindly resent. |
| Worker restart | Preserve source epoch, sequence, spool and central ownership. Fence local FCM before initialization. New epoch only for genuine source-state replacement, reported as discontinuity—not every restart. |
| Worker offline N hours | If daemon remains running, spool detected notices locally; reconnect resumes committed cursor. Preserve all records within agreed disk/retention bounds. If detection was stopped, do not invent missed events. Old events remain history but are not pushed after the agreed freshness threshold. |
| Tunnel drop mid-page / ACK loss | Commit a complete validated page or nothing. Retry read; dedupe source records. Lost durable-watermark ACK only delays reclamation. Ownership ACK loss requires state reconciliation, never local fallback. |
| Duplicate source delivery | Unique source tuple prevents duplicate central records/intents. Retain cursor/dedupe knowledge beyond public history pruning. A repeated detector emission with a new source sequence is not transport duplication. |
| Ambiguous FCM result | Record sanitized attempt state; no blind resend after timeout/crash. This may lose a push wakeup but not the committed history. Provider/device duplication is not eliminated by server dedupe. |
| Token UNREGISTERED | Prune only on canonical FCM UNREGISTERED evidence; generic HTTP 404/410 is insufficient. Preserve other tokens and history, expose masked diagnostics. Re-registration must not be deleted by a stale result from an older token generation. |
| Worker-local FCM still configured, including reported bason | New controller-mode worker ignores/refuses local FCM even before connection. Controller dispatch requires acknowledged durable fence. Legacy workers remain excluded; exclusion does not disable their local sends. Remove/revoke worker credentials before rollback-capable rollout. |
| Spool full, persistence error or source reset | Do not ACK non-durable events or silently claim completeness. Raise visible degraded coverage; apply an approved overflow policy. Arbitrarily long outage plus finite disk cannot meet absolute no-loss. |
| Central ledger lost/corrupt | Stop ingestion/dispatch and restore authoritative state; never silently reset public IDs. Disaster recovery requires explicit operator/client-cursor disposition. |

Keep attempts distinct from intents: persisting an intent alone does not prevent duplicate sends. Persist a claimed attempt before the external call; crash between claim and call is an accepted best-effort push omission. Existing worker delivery has a limited refresh/retry path, including a 5xx retry (`pkg/alerts/notify.go:472–484`); the proposed no-ambiguous-retry policy is a deliberate v4 change, not a statement that existing code never retries.

# 4. **Migration & rollout order**

1. **Approve contract and reliability bounds first.** Set retention, overflow, stale-push threshold, authentication and polling acceptance targets; resolve the Pulse parser gate. No implementation or production changes in this brief pass.
2. **Prepare central credentials and recovery.** Securely provision controller FCM credentials; never copy phone tokens into prompts/logs. Back up legacy token/history files with restrictive permissions. Remove worker credentials through an authorized rollout before allowing old binaries to reappear.
3. **Deploy new controller in staging/disabled-dispatch mode.** Migrate tokens, expose new public contract and updated admin UI, archive legacy history, stop overlapping watcher. Surface eligible/ineligible workers clearly. Do not enable dispatch merely because polling works.
4. **Deploy capable workers independently.** Controller-connected mode defaults to central-only FCM. Persist/enforce ownership at startup, advertise capability, negotiate H and source identity. New compatible workers automatically enroll; no phone registration or per-worker FCM credential configuration is needed.
5. **Enable dispatch per fenced source.** Import pre-H data history-only; dispatch only post-H eligible events. Verify real tunnel recovery and isolated fake-FCM receipts before a controlled real-phone canary.
6. **Reset legacy Pulse connection once where needed.** Explicit Log out → Connect clears old cursor and registration skip state. Connect alone is insufficient. This also avoids treating the old controller history namespace as the new one (`../vh-agent-pulse/mobile/src/main/kotlin/dev/vh/agentpulse/mobile/data/PulseRepository.kt:325–353,380–399`; `../vh-agent-pulse/mobile/src/main/kotlin/dev/vh/agentpulse/mobile/push/FcmRegistrar.kt:84–89,121–125`; `../vh-agent-pulse/mobile/src/main/kotlin/dev/vh/agentpulse/mobile/PulseApp.kt:138–142`).

| Controller | Worker | Safe behavior during rollout |
|---|---|---|
| Old | Old | Existing incompatible controller API/local-worker behavior remains. Not a supported centralized fleet. |
| Old | New, controller mode | Worker spools; local FCM stays off. No compatible controller ownership means no central pushes. Temporary notification outage is explicit, not a local fallback. |
| New | Old | Mark unsupported and do not centrally dispatch that worker's notices. Upgrade it for full coverage. Merely disabling its FCM does not provide missing durable-feed/capability semantics. |
| New | New | Automatic enrollment, durable fence, pull replay, central-only delivery. |
| Controller rolled back | Already centralized new worker | Preserve fence/spool; no local fallback. Restore compatible controller. Legacy binaries must not reopen a migrated store blindly. |
| New controller | Worker downgraded to old binary | Unsupported: old binary may ignore ownership. Remove/revoke local credentials beforehand; stop central eligibility when capability disappears. No silent dual-delivery fallback. |

Keep standalone local FCM for explicitly standalone installs. This is separate from outbound controller-connected mode, not a timeout-based fallback. Require explicit, coordinated transfer to return a previously centralized worker to standalone delivery.

# 5. **Fate of the existing controller notify program**

- **Keep admin UI and test-send, merge their backend into the central registry/dispatcher.** Relocate administrative list/PATCH/DELETE/test/history-read operations to `/vh/admin/notify/*`; update the UI in the same release. Existing registrations currently share `/vh/notify/*` (`pkg/server/daemon.go:301–322`), and the UI consumes that program (`web/src/components/NotifyDialog.tsx:16–36,226–241,323–360`). Test messages are explicitly labeled and do not create fake worker-detection history.
- **Retire the overlapping fleet-count notification watcher.** Do not run it alongside per-session dispatch. Keep fleet status itself. Preserve old history read-only and document lost aggregate-condition notification features; any desired controller-health alerts need a separately approved, nonoverlapping category. Existing watcher samples aggregated conditions rather than consuming worker events (`pkg/server/notify_watcher.go:95–110,159–235,282–339`).
- **Keep `--notify-store` as the configured storage anchor.** Perform a versioned, atomic migration with backup and fail-closed validation. Preserve token IDs, values, labels, creation/use/error metadata and scopes. Controller schema1 is an object with token records/scopes, not the worker's token array (`pkg/server/notify_store.go:70–72,103–125`; `pkg/alerts/tokens.go:37–43,173–193`). Do not replace it with the worker store implementation wholesale.
- **Migrate policy conservatively to `when_unattended`.** Preserve `scope.enabled=false`. Map compatible condition filters explicitly; unsupported old conditions remain dormant and visible rather than becoming unrestricted. A later Pulse full-state POST sets `always` but must not override administrative disable/scopes. This is a proposed policy choice requiring approval, not preservation of previously nonexistent policy metadata.
- **Archive old history without mixing namespaces.** Its wire/storage model differs (`pkg/server/notify_history.go:85–141,403–493`). New per-session history starts a new documented namespace at rollout; existing clients need the reset procedure above. Archive/read cursor stay separate from global v4 event IDs.
- **Preserve secret hygiene:** masked IDs and label-or-hash diagnostics; no raw token/key payload logging. Existing worker logging explicitly follows that convention (`pkg/alerts/notify.go:431–439`).

# 6. **Slice plan**

All paths below are expected scope, not edits already made. New files are proposed. Begin implementation only after approval; use the repository review/commit gates.

| Slice | Expected files | Tests and acceptance |
|---|---|---|
| **S0: freeze wire/ownership/reliability contract** | `docs/architecture/notify-fcm.md`; fixtures under `pkg/server/*_test.go` and `pkg/web/notify_feature_test.go` | Specify every notice mapping, numeric timestamp compatibility, reset procedure and invariants. Run exact history/FCM fixtures through shipped Pulse parsing in a separately authorized verification task; no sibling edits in this task. Stop if additive compatibility fails. |
| **S1: durable worker source and fence** | `pkg/alerts/history.go`, `engine.go`, `notify.go`, `presence.go`, relevant config; proposed `notify_outbox.go`/`notify_ownership.go`; `pkg/web/alerts_feature.go`; `cmd/client-daemon.go`, `cmd/client-daemon-vh.go` | Lane 1 `pkg/alerts`/`pkg/web`: append errors, crash recovery, stable epoch/sequence, attendance snapshot, profile eligibility, ownership/H races, local-send drain, startup before tunnel, missing/corrupt state. Do not assert that the current 500-event ring is sufficient. |
| **S2: enrollment and isolated feed** | `pkg/tunnel/types.go`, `pkg/agent/daemon.go`, `pkg/server/daemon.go`, worker route wiring and proposed feed handler | Lane 1 `pkg/server` and worker handlers; lane 3 `tests/e2e` with `StartCluster`: authenticated binding, capability rejection, lost ACK reconciliation, public route denial on all host/proxy paths, bounded reads, stream cleanup and surviving unrelated traffic. |
| **S3: transactional central ingestion/history** | `pkg/server/notify_history.go`; proposed `notify_ingest.go` and ledger files; `status_transport.go` only if required | Lane 1 `pkg/server`: interleaved sources, duplicates, atomic cursor/event/intent recovery, prefix retention, source gaps, source replacement, head nonregression, full disk. Lane 3 real tunnel reconnect and partial-page failures. |
| **S4: registry migration and central dispatcher** | `pkg/server/notify_store.go`, `notify_http.go`, `notify_transport.go`; proposed `notify_dispatch.go`; shared alert payload/classifier code only if narrowly factored | Lane 1 `pkg/server` + `pkg/alerts`: schema migration/rollback refusal, policy omission reset, disabled/scope preservation, generation-safe UNREGISTERED pruning, generic 404 no-prune, Android payload parity, A-attended/B-unattended, durable cooldown and ambiguous attempts. Lane 2 `tests/integration/notify_lifecycle_test.go`: detection → durable feed → central fake-FCM request. |
| **S5: public/admin migration and independent-rollout proof** | `pkg/server/daemon.go`, `notify_http.go`, `notify_watcher.go`; `web/src/components/NotifyDialog.tsx` and matching tests; contract doc | Lane 1 route/DTO tests; lane 5 web unit/typecheck for admin changes. Lane 2 auth/CSRF regressions. Lane 3 proposed `tests/e2e/notify_central_test.go`: complete old/new matrix, restart cutover boundaries, second worker auto-enrollment, one registration, no local fake-FCM requests, one central ledger event per source tuple. |

Narrow command families for approved execution:

```text
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./pkg/alerts/ ./pkg/server/ ./pkg/web/'
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/integration/'
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/e2e/'
vh-agent-harness exec npm --prefix web run test:unit
vh-agent-harness exec npm --prefix web run typecheck
```

These are planned tests, not execution receipts. Tunnel tests should extend the existing bounded-transport seam (`pkg/server/status_transport.go:116–128` references its `tests/e2e/status_transport_s1_test.go` coverage). Before claiming delivery success, retain revision-bound evidence of the actual detection→tunnel→central history→fake-FCM path. A real-device canary must separately observe notification receipt and history reconciliation; deep-link taps, if later implemented, require real interaction evidence. No test or phone observation was run in this pass.

# 7. **Contradiction audit**

| Handoff / candidate assumption | Re-derived truth and disposition |
|---|---|
| §7 direct-worker path remains settled | It is explicitly the prior decision (`docs/architecture/notify-fcm.md:399–442`). Operator centralization now supersedes it. v4 must retain the history of that decision and replace its route partition with central public API + relocated admin + private feed, preserving cookie/CSRF compatibility. |
| Workers have no notify routes | Stale interception comment: current worker token routes exist (`pkg/web/notify_feature.go:41–91`), while controller interception remains universal (`pkg/server/daemon.go:464–469`). Correct the comment; do not merely bypass interception to each worker. |
| Pulse speaks the complete worker v3 history schema | Too strong. Its DTO projects kind/count/label/string timestamp, while the worker has type/sessionID/numeric timestamp (`../vh-agent-pulse/shared/src/main/kotlin/dev/vh/agentpulse/shared/solara/SolaraHistory.kt:29–69`; `pkg/alerts/history.go:34–43`). Add display fields and verify timestamp decoding before asserting unchanged-client compatibility. |
| Durable ring already gives no-loss replay | False as an absolute: cap500, swallowed errors, no fsync in inspected persistence path, empty-on-corrupt load (`pkg/alerts/history.go:21–27,68–92,108–147`). New durable source and explicit bounds required. |
| Worker restart should rotate epoch | Rejected planner suggestion. Ordinary restart must preserve epoch/sequence; only genuine source reset changes epoch. |
| New worker behind old controller may resume local FCM | Rejected planner suggestion for controller mode. Fail closed and spool; no fallback on absence of handshake. |
| Generic 404/410 proves UNREGISTERED | Rejected. Preserve canonical-evidence-only pruning, with explicit tests. |
| Existing sender has no retries | Not uniformly true: worker delivery documents refresh and limited 5xx retry (`pkg/alerts/notify.go:472–484`). v4 ambiguity policy must be explicit. |
| 400 rather than 409 proves deployed `--notify-store` state | Source supports the policy-field rejection (`pkg/server/notify_http.go:115–123,183–188`), not a live deployment conclusion. Recheck runtime separately. |
| bason enabled, zero tokens, named service account; Pulse installed version; cited commit deployment | Operator-reported context, not verified by source inspection. No live probe, credential inspection, deployment or commit-ancestry verification was performed. |

**Pulse follow-up, no fix here:** `FcmRegistrar.onToken` skips POST for an already-REGISTERED matching token hash (`../vh-agent-pulse/mobile/src/main/kotlin/dev/vh/agentpulse/mobile/push/FcmRegistrar.kt:84–89`). Bind future registration state to server identity and payload/policy version, and re-register when either changes. Explicit logout clears registrar state (`same file:121–125`); use Log out → Connect for this rollout. Merely upgrading or reconnecting to the same URL is insufficient.

The planner's draft also proposed stringifying `ts`, omitted `lastId` in an example, and offered unmeasured latency numbers. Those suggestions are not adopted: this consolidated brief preserves v3 types pending the parser gate, includes `lastId`, and labels polling targets unmeasured.

# 8. **Open risks / decisions left to the operator**

**Approve or amend these policy choices:**
1. Pull-first architecture and fail-closed controller ownership, accepting temporary notification outage during mixed-version rollout instead of local fallback.
2. Retention/disk budget and outage horizon; overflow behavior. Recommend durable spool with explicit degraded state rather than silent ring eviction. An unbounded no-loss guarantee is not feasible on finite disk.
3. Freshness threshold for delayed push and detection-time attendance. Recommend always retain history within retention, but suppress stale push storms.
4. Conservative migrated `when_unattended`, retained admin scopes, retirement of aggregate watcher notifications, and explicit one-time Pulse logout/reconnect.
5. Supported authenticated worker-enrollment posture and rollback prohibition while usable worker FCM credentials remain.

**Investigable gates—not questions to burden the operator with prematurely:** execute the Pulse timestamp fixture; verify actual worker host pattern/browser auth; verify controller and bason runtime readiness without exposing secrets; measure poll capacity/latency; prove crash/cutover tests. If numeric timestamp parsing fails, bring back the protected contract decision rather than silently changing v3 or promising no client change.

Confidence: **medium** in pull-first direction; high in the cited source-level incompatibilities; unverified in runtime behavior, performance and device delivery. `framing_confidence` was not supplied; the frame did not shift. No manual step-back occurred. Researcher → debate → bounded researcher clarification → planner completed; contradictory planner suggestions were rejected as documented above.

Next recommended command, **after approval**, is `/draft-plan` for S0 and the ownership/durability contract, referencing this brief—not `/implement` yet. Do not start the full build until S0 closes the compatibility gate and the approved scope identifies verification commands.

Requested parent artifact: `tmp/notify-controller-hub-brief.md`. Consolidated scratch copy: `tmp/agent-runs/notify-controller-hub/brief.md`. No source, sibling repository, durable docs, task cards or session state were changed; only that transient brief was written. No tests or deployment changes were performed.

awaiting operator approval — no implementation started
