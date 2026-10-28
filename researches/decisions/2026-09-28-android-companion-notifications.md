# Android companion notifications — solution brief

**Date:** 2026-09-28  
**Status:** COMPLETE (solution brief; FCM first, controller-owned sender, replaceable transport contract)  
**Origin:** Controller-side companion-app notification program (slice S1)  

> Promoted-from: tmp/agent-runs/android-push-20260928/brief.md  
> Original date: 2026-09-28  
> Provenance: researcher -> debate -> planner pass, 2026-09-28; read-only static source inspection  
> Scope: operator Android notification destination enrollment at controller, admin UI management, and fleet attention notifications.  

---

2026-09-28 · researcher → debate → planner · advisory, read-only pass

## Decision frame

**Objective:** let the operator enroll Android notification destinations at the controller, manage them in the admin UI, and receive fleet attention notifications in their companion app.

**Constraints:** one controller URL; self-hosted single operator; no third-party dependency without strong justification; cookie-session auth, explicit `X-VH-CSRF: 1` on mutations, controller-owned `/vh/*` routing on worker subdomains, strict JSONC configuration, bounded resource use, additive response schemas. No implementation, test execution, durable state, or task cards in this pass. This file is the only output written.

**Success:** a usable app contract; honest distinction between provider acceptance and visible Android delivery; stable enrollment and bounded deduplication; no false recovery from missing coverage; a staged, evidence-gated route to implementation.

**Open question:** which delivery transport can satisfy the operator's self-hosting preference and actual phone's background-delivery requirements, and what controller boundary should own enrollment and policy?

**framing_confidence:** not supplied at kickoff; not assigned or shifted during this pass. Phased behavior is recommended because transport priority and target-device delivery remain unsettled, not because an inferred framing signal triggered it.

## Per-question verdicts

1. **Transport: conditional tie, not implementation approval.** Prefer **self-hosted UnifiedPush using RFC Web Push** if avoiding Google-hosted delivery is the overriding requirement and operating a push server plus Android distributor is acceptable. Prefer **FCM** if conventional Android integration and lower device-lifecycle engineering burden dominate. Do not implement both by default. A native app cannot obtain dependable background delivery merely by accepting RFC 8291 ciphertext: a push-service/receiver arrangement is still required. Self-hosting that arrangement can avoid third-party hosted services, but adds software and operational responsibility. Reject a custom persistent socket and browser-only notifications for v1.
2. **Sender: controller.** Add a bounded active observer using the existing fleet acquisition service, not an independent worker fan-out and not side effects inside rollup construction. Current generations are lazy: attaching sends only to requested refreshes would stop detection when no UI polls. Workers offer richer local events but cannot reliably report their own disappearance or evaluate fleet-wide absence; their subscription/presence model conflicts with one controller URL. V1 promises observed aggregate transitions, not every worker/session event.
3. **Registry: separate protected controller-local store, sibling admin dialog.** Reuse the config-holder persistence pattern, not the fleet roster schema or worker alerts profile. Use a masked `NotificationDestinationsDialog` beside `FleetStatusDialog`; enroll/update/revoke through cookie-authenticated, explicitly CSRF-protected controller routes. Installation IDs are identifiers, not credentials or ownership isolation.
4. **Vocabulary: exact nine fleet condition names; `off | fleet` device scope.** Per-device condition selection, explicit transition IDs, coverage-aware state, persistent suppression, bounded retry and short expiry. Do not inherit misleading `current` semantics or presence-based suppression from worker push.

## Research packet and evidence register

Repo-first inspection, supplemented by fresh primary sources for Android transport behavior. Source inspection is not runtime verification. Labels below are retained from research.

| ID | Sourced fact and locator |
|---|---|
| E1 | `pkg/alerts/push.go:49–171`: stdlib RFC 8291/VAPID transport is mixed with worker profile/presence gating and `(type,device)` cooldown. Only `off` is excluded; `current` is not a focused-session delivery guarantee. |
| E2 | `pkg/alerts/push.go:174–212,394–409`: normal urgency, 24h TTL, per-send goroutines, 404/410 removal, weak nonempty-field subscription validation and silent other errors. Existing crypto is reusable; these delivery policies are not a suitable controller contract. |
| E3 | `pkg/web/alerts_feature.go:14–35,181–250`, `pkg/alerts/presence.go:8–82`, `pkg/alerts/config.go:23–46,158–167`: worker-local project stores, ephemeral heartbeat devices, vocabulary `finished/waiting/stuck-thinking/runaway/stalled`. |
| E4 | `pkg/server/status.go:5–108,139–217,244–260,968–1001`: fleet schema 1 and nine conditions; unread/done are informational. |
| E5 | `pkg/server/status.go:342–353,406–550,993–1000,1739–1769`: lazy single-flight generations, registry/config validity stamps, default 5s cache TTL and 15s refresh budget. `since` is contributor continuity, not event identity; polling can miss cycles. |
| E6 | `pkg/server/status_config.go:18–88,106–179,425–546`, `cmd/server.go:47–67`: strict JSONC reads, canonical JSON writes, caps, serialized persist-before-swap; unconfigured persistence is read-only/409. |
| E7 | `pkg/auth/auth.go:85–100,165–234`, `pkg/auth/handlers.go:106–125`, `pkg/server/daemon.go:203–226,265–363`: cookie auth, up to 7d lifetime/24h idle, form login; `/vh/` gets 401, but global CSRF protects `/api/`, requiring explicit `/vh/` mutation checks. Controller families need host-interceptor precedence. |
| E8 | `web/src/components/AdminMenu.tsx:34–60,119–125,168–178`, `FleetStatusDialog.tsx:8–37`, `web/tests/unit/FleetStatusDialog.test.tsx:1–26`: existing sibling-dialog, portal and API-error test patterns. |
| E9 | `pkg/version/version.go:44–75,177–203`: tunnel floors 1.67.0 and first-shipping-tag selection-vocabulary contract. Actual tag compliance was not checked. This is not the Android API version contract. |
| E10 | [RFC 8030 §§2,5–7](https://www.rfc-editor.org/rfc/rfc8030), [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292): application server → push service → user agent; acceptance is not delivery; encryption and VAPID do not provide Android wakeup. |
| E11 | [Android Doze](https://developer.android.com/training/monitoring-device-state/doze-standby), [FCM priority](https://firebase.google.com/docs/cloud-messaging/android/message-priority): network restrictions, shared FCM connection, high-priority visible delivery attempts and possible deprioritization. |
| E12 | [FCM Android client](https://firebase.google.com/docs/cloud-messaging/android/client), [server authorization](https://firebase.google.com/docs/cloud-messaging/auth-server): Firebase project, compatible Google services, server service-account OAuth. Play Store distribution of the APK itself is not required. |
| E13 | [UnifiedPush introduction](https://unifiedpush.org/developers/intro/), [distributors](https://unifiedpush.org/users/distributors/): Web Push server delivery and Android distributor; downstream delivery is implementation-specific; self-hosting is possible. |
| E14 | [Chrome Web Push](https://developer.chrome.com/docs/extensions/how-to/integrate/web-push), `web/src/push.ts:11–15,60–91`: browser PushManager reuse does not remove Chrome's FCM dependency or produce APK-owned notifications. |
| E15 | [Android notification permission](https://developer.android.com/develop/ui/views/notifications/notification-permission), [FCM token management](https://firebase.google.com/docs/cloud-messaging/manage-tokens), [HTTP v1 send](https://firebase.google.com/docs/cloud-messaging/send/v1-api): permission and registration lifecycle must be handled. Pin SDK/send-contract versions; do not substitute a Firebase installation ID for a send token. |

External sources checked by researcher on 2026-09-28. The referenced `.local/coordinator/tasks/task-2026-09-25t01-45-10-*.json` had no match; `.local/AGENTS.md` was missing. The claimed 17-commit context was therefore not reconstructed. No Android app source/build seam was supplied or established.

### Materially distinct options

| Option | Server cost | Android/operations cost | Principal tradeoff |
|---|---|---|---|
| O1 Controller + FCM | New OAuth/token lifecycle and provider adapter; existing Web Push crypto does not replace FCM authorization | Conventional Firebase integration, notification permission/channels/token refresh; compatible Google services needed | Lower predicted lifecycle burden, but Google outbound calls and service-account custody |
| O2 Controller + self-hosted UnifiedPush | Extract reusable RFC crypto/VAPID; secure endpoint egress; operate push server | Distributor installation/connector integration, selected implementation's encryption support and battery settings; real-device testing | No hosted provider required, but additional software/operations and unmeasured Doze behavior |
| O3 Custom direct receiver/socket | Queue/stream/backfill plus any push-service roles chosen | Highest reconnect, foreground/background and OEM lifecycle burden | No mandatory provider, but ordinary sockets do not evade Doze |
| O4 Browser/PWA push | Reuse browser enrollment with new controller policy | Minimal native work | Not equivalent to companion-owned notifications; Chrome still uses FCM |

Cost rankings are **predictions**, not measurements. Sovereignty and operational simplicity are competing **preferences**. No background-delivery SLA has been assumed.

## Debate outcome, objections, and synthesis corrections

Debate returned **tie O1/O2**, medium confidence; controller/store/UI boundary was recommended. No manual step-back or reframe-and-diverge occurred. Strong objections retained: FCM introduces real hosted-service and credential dependencies; UnifiedPush does not prove Doze reliability; lazy aggregate observations are not event logs; worker Pusher reuse would import incompatible policy.

The planner produced a gap-closing outline, not an approved implementation plan. This consolidation corrects internal draft inconsistencies rather than accepting them as evidence:

- `kind` remains the condition name; `transition` is separate.
- `event_id` is unique per emitted transition and stable only across its retries. `episode_id` groups an incident; it MUST NOT be used to deduplicate all count/clear events.
- Keep idempotent **PUT by installation ID**, not the planner's accidental POST-only registration drift.
- `/vh/` mutations need explicit CSRF; there is no global `/vh/` CSRF guarantee.
- A 15s refresh **budget** is not a selected polling interval.
- A valid generation may have incomplete coverage. Positive evidence can justify an alert; incomplete evidence cannot justify absence, a downward count, or a clear.
- A 401 requires reauthentication; no refresh-token API or transparent credential renewal exists in this proposal.
- Cooldown survives clear/reappear so flapping cannot bypass suppression.

## Proposed controller design

All numbers and policies below are **provisional design choices**, not existing behavior or operator approval.

**Store:** explicit controller notification-state path, separate from `status.jsonc`/fleet roster and worker profiles. Strict JSONC-readable configuration, canonical JSON writes, bounded typed schema, serialized persist-before-swap; owner-only file permissions and atomic replacement. Do not silently provision it when unset: capabilities report read-only and mutations return 409. Provider credentials/private VAPID keys live in protected server-only storage or credential references, never public config responses. Persist registry and bounded episode/suppression/outbox state with explicit schema migration rules. Protect backups like credentials.

**Observer:** while enabled destinations exist, request the same bounded fleet service approximately every 5s, single in-flight acquisition with jitter/backoff on failure. Do not bypass cache or create duplicate fan-out. Consume only completed, still-current registry/config generations. Delivery happens asynchronously through a bounded queue, never under status/config locks. Policy/config revision changes fence stale queued work; disabling/deleting a destination prevents unsent work from proceeding.

**Bounds:** propose at most 32 destinations, registration body 16 KiB, name 80 characters, opaque FCM token 4096 characters, endpoint 2048 characters, serialized plaintext event 2048 UTF-8 bytes, queue 256 pending events globally, two concurrent sends, 10s send timeout. Preserve newest state per destination/condition during coalescing; expose overflow/suppression counts. Initial retry schedule 5s/30s/120s, honoring bounded Retry-After and expiry. Terminal invalid-registration responses disable the matching registration revision, not a freshly rotated token. Distinguish last attempt, provider acceptance, terminal error and unknown delivery.

**Egress:** FCM fixed provider endpoints; RFC delivery HTTPS and explicit allowed hosts/ports with controlled resolution, TLS validation and redirects disabled. Private self-hosted destinations require an explicit allowlist exception; block metadata/link-local and unexpected resolved addresses. Authentication does not make arbitrary outbound URLs safe. Do not copy current nonempty-only subscribe validation.

## V1 condition and suppression policy

Exact condition enum:

`permission_pending`, `question_pending`, `worker_down`, `worker_missing`, `project_missing`, `session_error`, `session_retry`, `session_unread`, `session_done`.

Scope is `off | fleet`: fleet means the controller's existing configured fleet selection, not every project ever observed. Do not filter capped presentation `projects[]` as if it were complete inventory. Per-worker/project/current-session filtering is deferred until contributor identities and completeness semantics are designed.

Default selection: permission/question, infrastructure missing/down and session error/retry. Unread/done opt-in. Proposed transitions: `appeared`, `count_changed`, `cleared`; device policy can select which are shown, with appeared/count_changed default and cleared opt-in.

- New enrollment/config-incompatible baseline is captured silently; test-send or current status is available to inspect existing problems. Compatible persisted baselines survive restart. Unknown coverage never becomes a silent reset to healthy.
- Permission/question appearances and session errors are immediate on reliable positive observation. Infrastructure appearances, retry and ordinary count changes stabilize for 30s. These thresholds need tuning with the operator.
- For incomplete coverage, retain prior known state; permit a supported positive appearance or increase, but do not infer decreases/clear. V1 may conservatively require globally complete coverage for negative transitions until per-condition completeness is available.
- Maintain separate `(destination, kind)` last-alert suppression for five minutes, independent of episode lifecycle. Coalesce pending changes to newest state; after cooldown send only if still relevant. A clear before a suppressed appearance is sent cancels the stale appearance. Clear notifications only follow an episode whose appearance was accepted; acceptance still does not prove receipt.
- Each emitted transition gets its own `event_id`; retries reuse it. `episode_id` remains stable from appearance to clear. Do not use ETag or `since` as identity. App deduplicates by `event_id`, and may replace/update its visible notification using `episode_id` or condition grouping.
- Propose 120s expiry for transient attention/count notifications and 300s for infrastructure/clear, validated on device. App discards expired payloads and fetches current fleet status on tap. No exactly-once or every-completion promise.

## Android API contract draft — DO NOT IMPLEMENT YET

All routes are proposed controller-owned API-class routes. The entire family receives method-independent `hostInterceptor` precedence while handlers retain method restrictions. All require the existing authenticated session. All mutations additionally require `X-VH-CSRF: 1` and JSON Content-Type where a body is present. Responses are additive: clients ignore unknown response fields; server mutation decoding rejects unsupported fields rather than silently accepting typos.

| Method and path (prefix `/vh/fleet/notifications`) | Contract |
|---|---|
| GET `/capabilities` | `schema:1`, implemented/enabled transports only, writable status, condition vocabulary, limits and optional VAPID public key/key ID |
| GET `/destinations` | `{schema:1,destinations:[masked metadata]}`; never raw token, endpoint or auth key |
| PUT `/destinations/{installation_id}` | Idempotent enrollment/rotation; registration schema below. 201 new, 200 updated. Omitted policy preserves existing policy or applies documented defaults for a new destination. |
| PATCH `/destinations/{installation_id}/policy` | Complete replacement of the small policy object below; 200 masked record. Missing policy members rejected. |
| DELETE `/destinations/{installation_id}` | Revoke registration and cancel pending work; idempotent 204 |
| POST `/destinations/{installation_id}/test` | Rate-limited test queueing; 202 `{schema:1,event_id,state:"queued"}`. Never claim device delivery. Subsequent list metadata shows provider outcome. |

Other statuses: 400 invalid schema/keys; 401 reauthenticate; 403 missing CSRF; 404 unknown target; 409 store read-only or transport unavailable; 413 body too large; 429 rate/cap exceeded; 500 persistence failure (no published new state); 503 queue/provider temporarily unavailable. Error body: `{ "schema":1, "error":{"code":"store_read_only","message":"Notification storage is not configured"} }`; messages must not echo secrets.

### JSON Schema draft (2020-12): registration and policy

This draft describes a future union, NOT a commitment to ship both transports. Capabilities restrict the accepted branch to the selected implemented provider.

```json
{
  "$schema":"https://json-schema.org/draft/2020-12/schema",
  "$defs":{
    "condition":{"enum":["permission_pending","question_pending","worker_down","worker_missing","project_missing","session_error","session_retry","session_unread","session_done"]},
    "policy":{"type":"object","additionalProperties":false,"required":["scope","conditions","transitions"],"properties":{
      "scope":{"enum":["off","fleet"]},
      "conditions":{"type":"array","uniqueItems":true,"maxItems":9,"items":{"$ref":"#/$defs/condition"}},
      "transitions":{"type":"array","uniqueItems":true,"maxItems":3,"items":{"enum":["appeared","count_changed","cleared"]}}
    }},
    "address":{"oneOf":[
      {"type":"object","additionalProperties":false,"required":["transport","token"],"properties":{"transport":{"const":"fcm"},"token":{"type":"string","minLength":1,"maxLength":4096}}},
      {"type":"object","additionalProperties":false,"required":["transport","endpoint","keys"],"properties":{
        "transport":{"const":"webpush"},"endpoint":{"type":"string","format":"uri","maxLength":2048},
        "vapid_key_id":{"type":"string","maxLength":128},
        "keys":{"type":"object","additionalProperties":false,"required":["p256dh","auth"],"properties":{"p256dh":{"type":"string","pattern":"^[A-Za-z0-9_-]+$"},"auth":{"type":"string","pattern":"^[A-Za-z0-9_-]+$"}}}
      }}
    ]}
  },
  "type":"object","additionalProperties":false,"required":["schema","name","address"],
  "properties":{"schema":{"const":1},"name":{"type":"string","minLength":1,"maxLength":80},"address":{"$ref":"#/$defs/address"},"policy":{"$ref":"#/$defs/policy"}}
}
```

Installation ID: app-generated UUID, persisted across app launches, URL path component; do not use a provider token as the ID. Additional semantic validation: Web Push `p256dh` must decode to a valid 65-byte uncompressed P-256 public point, `auth` to 16 bytes, plus the egress policy above. JSON `format` validation alone is insufficient.

### JSON Schema draft: delivered event

```json
{
  "$schema":"https://json-schema.org/draft/2020-12/schema",
  "type":"object",
  "required":["schema","event_id","episode_id","kind","transition","count","observed_at","since","expires_at","coverage_complete","title","body","relative_link"],
  "properties":{
    "schema":{"const":1},"event_id":{"type":"string","format":"uuid"},"episode_id":{"type":"string","format":"uuid"},
    "kind":{"enum":["permission_pending","question_pending","worker_down","worker_missing","project_missing","session_error","session_retry","session_unread","session_done"]},
    "transition":{"enum":["appeared","count_changed","cleared"]},
    "count":{"type":"integer","minimum":0},
    "observed_at":{"type":"string","format":"date-time"},
    "since":{"type":["string","null"],"format":"date-time"},
    "expires_at":{"type":"string","format":"date-time"},
    "coverage_complete":{"type":"boolean"},
    "title":{"type":"string","maxLength":120},"body":{"type":"string","maxLength":512},
    "relative_link":{"type":"string","const":"/"}
  }
}
```

Semantic checks: cleared implies count zero; other transitions count positive. Use RFC3339 UTC times. `since` is advisory source continuity, nullable when unavailable; retain last known episode value on a clear. `/` is a safe initial tap destination; Android refreshes `/vh/fleet/status`. No undocumented SPA deep route is promised. Future links must be trusted relative allowlisted paths, never arbitrary Host-derived URLs. Titles/bodies contain no transcript, secrets or sensitive session titles by default.

Test payload is a distinct schema-1 envelope `{schema:1,type:"test",event_id,observed_at,expires_at,title,body,relative_link:"/"}`, not a fabricated fleet condition. Future condition messages may add fields without breaking clients.

### Metadata response shapes

```json
{
  "schema":1,
  "transports":["webpush"],
  "writable":true,
  "vapid":{"key_id":"controller-key-1","public_key":"base64url-uncompressed-P256"},
  "limits":{"destinations":32,"registration_bytes":16384,"payload_bytes":2048},
  "conditions":["permission_pending","question_pending","worker_down","worker_missing","project_missing","session_error","session_retry","session_unread","session_done"]
}
```

```json
{
  "schema":1,
  "id":"c4efbe31-f151-4e1c-8b60-3d1d5f004bb5",
  "name":"Operator phone",
  "transport":"webpush",
  "policy":{"scope":"fleet","conditions":["permission_pending","question_pending"],"transitions":["appeared","count_changed"]},
  "registration_state":"active",
  "updated_at":"2026-09-28T12:00:00Z",
  "last_attempt_at":null,
  "last_accepted_at":null,
  "last_error":null,
  "last_test":{"event_id":"929ea089-801c-48d3-9aeb-53a69d84e551","state":"queued"}
}
```

Metadata timestamps are nullable RFC3339; `registration_state` is `active|invalid`; policy scope controls enablement. `last_error` is null or `{code,message,at}` with sanitized text. Test state is `queued|accepted|failed|expired`, never `delivered`. These response examples are typed shape drafts, not evidence that endpoints exist.

### What the Android app must implement

1. Use configured HTTPS controller origin and a persistent protected cookie jar. Builtin passphrase auth: form POST `/auth/login`, retain returned cookies and redirects, verify success with authenticated capabilities GET. A 200 login response alone may be the failure form. nginx-owned auth is deployment-specific; do not invent a generic nginx login API. Require reauthentication on 401 without repeatedly retrying mutations.
2. Fetch capabilities and select only an implemented transport. Request Android notification permission and establish notification channels; registration alone does not prove permission to display.
3. **FCM branch:** configure Firebase project/app and supported SDK, obtain actual provider registration token, PUT it, repeat on token rotation. Service-account credentials remain exclusively on the controller. Proposed HTTP v1 data mapping: `message.token` plus `message.data.vh_event` containing the UTF-8 JSON event string, bounded inside provider limits; use appropriate visible-notification priority and short TTL. The receiver parses, deduplicates, checks expiry and promptly displays. Pin and test the SDK/send pair before contract freeze; installation IDs/FIDs are not interchangeable with send tokens.
4. **Web Push branch:** enroll with the selected UnifiedPush distributor/push server; use a connector/encryption arrangement proven to support RFC 8291. Receiver creates/retains its P-256 private key and 16-byte auth secret; upload only public `p256dh`, auth secret and endpoint over authenticated TLS. Controller's VAPID public key is separate from receiver encryption keys; private VAPID key never leaves server. If the service restricts subscriptions to an application-server key, enroll with advertised VAPID key and key ID. Controller encrypts JSON and signs VAPID; receiver decrypts `aes128gcm`. Endpoint/key/VAPID rotation requires re-enrollment. Distributor capability is a test gate, not assumed from protocol naming.
5. Display from payload without requiring a background authenticated fetch. Persist a bounded event-ID dedup cache; treat episode ID only as grouping. On tap open the app/controller origin and fetch current status. No authentication secret in links or payloads. Logout/revocation policy must be explicit; server logout currently does not revoke notification destinations automatically.

## Proposed slices — DO-NOT-EXECUTE

Every file, command and test below is an outline only. No source modification or test run is authorized by this brief. New paths are proposals, not existing files.

### S1 — choose one candidate and validate target-device delivery (recommended first)

Resolve the operator's Google-versus-distributor deployment preference, target Android version/OEM and acceptable latency/battery posture. Start with the selected candidate, not two full provider implementations. Pin the SDK/distributor/key exchange and verify its smallest receive/display path on the actual phone: background, locked/Doze, network switch, reboot, permission denied, provider-token/endpoint rotation and expired Solara cookie. Do not claim force-stopped delivery is supported; characterize it. Record actual visible outcomes and latency, not just HTTP acceptance. If selected candidate fails, refresh researcher evidence and return to debate with the named failure; do not silently switch providers.

**File scope:** no vh-solara source changes. Any authorized later experiment must use an operator-agreed transient location and Android repo/device seam; none is currently established. No credentials/accounts/deployment provisioning are authorized here. Acceptance threshold is an operator decision. If device execution is unavailable, return `not-demonstrable`, not green.

### S2 — controller registry and API boundary

Existing candidates: `cmd/server.go`, `cmd/server_test.go`, `pkg/server/daemon.go`; read pattern `pkg/server/status_config.go`. Proposed new: `pkg/server/notifications_config.go`, `pkg/server/notifications_config_test.go`, `pkg/server/notifications_api.go`, `pkg/server/notifications_api_test.go`. Keep crypto extraction out of this transport-neutral slice. Establish protected path/config schema, caps, masked responses, auth/CSRF, idempotent rotation, policy and host precedence. **Lane 1:** malformed JSON/unknown keys, cap failures, persistence failure/concurrency, unauthenticated/CSRF errors, worker-host routing, secret redaction and stale-registration races.

### S3 — observed-condition state machine and bounded queue

Existing candidates: `pkg/server/status.go`, `pkg/server/status_test.go`, `pkg/server/daemon.go`; proposed `pkg/server/notifications.go`, `pkg/server/notifications_test.go`. Keep provider fake. **Lane 1:** valid-vs-stale generations, partial coverage positives/negative suppression, stable baseline/restart, per-transition IDs, flaps, disabled policy, TTL/caps and cooldown. **Lane 3:** proposed `tests/e2e/fleet_notifications_e2e_test.go` using existing `tests/e2e/harness.go` and `fleet_status_e2e_test.go` patterns: real controller/worker/yamux events reach fake sink without browser polling; worker disconnect/missing evidence and recovery behave honestly.

### S4 — selected provider only

FCM branch: proposed `pkg/server/notifications_fcm.go` and `_test.go`, protected credential wiring in `cmd/server.go`. Decide standard-library OAuth implementation versus a narrowly justified maintained library explicitly; neither is free security/maintenance work.

RFC branch: existing `pkg/alerts/push.go`, `pkg/alerts/push_test.go`; proposed transport-only `pkg/webpush/` package and tests, preserving worker behavior while exposing independent encrypt/sign/send primitives. No import of worker profile/presence policy into controller. **Lane 1:** existing RFC vector preservation, VAPID, bounded requests, endpoint validation, retries/invalidations and race fencing. **Lane 3:** fake provider end-to-end boundary. Re-run S1 real-device acceptance against production integration; fake sinks cannot prove Android wakeup.

### S5 — admin UI and contract documentation

Existing: `web/src/components/AdminMenu.tsx`, `web/tests/unit/AdminMenu.test.tsx`. Proposed: `web/src/components/NotificationDestinationsDialog.tsx`, matching `.module.css`, `web/tests/unit/NotificationDestinationsDialog.test.tsx`; proposed durable docs only in a later authorized implementation slice, e.g. `docs/guides/android-notifications.md`. Show masked destination name/transport/health, policy enablement, condition filters, test acceptance/error and revoke confirmation; do not expose token text. **Lane 5:** portal dismissal, masking, policy edits, 401/403/409, errors and queued-vs-accepted feedback. Standard small dialog; no new CSS-heavy effect is needed. Lane 5 does not establish real-browser interaction reachability; later changes must satisfy applicable receipt rules without calling DOM-unit evidence a real interaction proof.

### Verification command outlines — DO-NOT-EXECUTE

```text
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./pkg/server/ ./pkg/alerts/'
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/e2e/'
vh-agent-harness exec npm --prefix web run test:unit
vh-agent-harness exec npm --prefix web run typecheck
```

These are verified repo runner families, not receipts. Include a new transport package in the selected targeted run once it exists. No tests ran in this pass; neither targeted nor full verification is claimed. No commit/tag/clean-tree claim is made.

### Release boundary

Controller-only app API schema 1 does not automatically require a worker tunnel floor change. Preserve the open `pkg/version` same-tag rule for existing fleet vocabulary. If implementation adds worker facts or changes controller/worker vocabulary, explicitly scope `pkg/version/version.go` and its tests and bind the new vocabulary/floor to the same shipping tag. Re-derive actual release state before release; this pass did not verify it.

## Load-bearing premise 4-tuples

Read/Glob entries below are side-effect-free tool recipes to re-derive mutable premises, not executed test commands. Observations are the researcher's 2026-09-28 inspection; rerun before implementation.

| value | source | re_derivation_command | observed_at |
|---|---|---|---|
| Worker Pusher is coupled to profile/presence; crypto requires isolation | E1–E3 | Read `pkg/alerts/push.go` lines 49–212; Read `pkg/web/alerts_feature.go` lines 14–35 | 2026-09-28 |
| Fleet acquisition is lazy and generation-stamped | E5 | Read `pkg/server/status.go` lines 406–550 | 2026-09-28 |
| Since is contributor continuity, not event ID | E5 | Read `pkg/server/status.go` lines 940–1026 and 1739–1769 | 2026-09-28 |
| Exact nine condition vocabulary lives in server status | E4 | Read `pkg/server/status.go` lines 5–108 and 968–1001 | 2026-09-28 |
| Explicit /vh mutation CSRF and family host precedence are necessary | E7 | Read `pkg/server/daemon.go` lines 203–226 and 265–363 | 2026-09-28 |
| Cookie sessions expire; form login failure can return 200 | E7 | Read `pkg/auth/auth.go` lines 85–100 and 165–234; Read `pkg/auth/handlers.go` lines 106–125 | 2026-09-28 |
| Holder provides strict persistence pattern, not destination schema | E6 | Read `pkg/server/status_config.go` lines 18–88 and 425–546 | 2026-09-28 |
| Sibling admin dialog and unit-test precedent exists | E8 | Read `web/src/components/AdminMenu.tsx`; Read `web/tests/unit/FleetStatusDialog.test.tsx` | 2026-09-28 |
| Version floor/same-tag contract exists, shipping compliance unknown | E9 | Read `pkg/version/version.go` lines 44–75 and 177–203; separately inspect release evidence when authorized | 2026-09-28 |
| Referenced context card was unavailable | Research Glob output | Glob `.local/coordinator/tasks/task-2026-09-25t01-45-10-*.json`; Read `.local/AGENTS.md` if it now exists | 2026-09-28 |

## Operator decisions remaining

1. **Dependency posture:** Google-hosted FCM plus service-account credentials, or operate a self-hosted push server and compatible Android distributor? Recommendation under the stated self-hosting preference: evaluate O2 first only if that extra deployment is acceptable; otherwise O1 is the conventional choice. No provider setup was authorized.
2. **Acceptance:** target phone/Android, acceptable background latency and battery/foreground-service concessions. These set S1's pass/fail criteria.
3. **Security boundary:** if using a LAN/private push server, exact HTTPS host/port allowlist and trust configuration. Do not open arbitrary private egress.
4. **Product policy:** approve silent initial baseline, aggregate rather than every-session-event semantics, defaults/cooldown and optional clears; decide whether app logout also revokes this installation. Recommended logout UX offers explicit “sign out and stop notifications”; ordinary server logout alone does not imply revocation.

## Confidence, uncertainty, next command

High confidence in controller ownership, separate registry, existing code reuse limits and auth/routing requirements. Medium confidence in comparative implementation burden and proposed event policy. Transport selection is **unsettled**, and actual Android delivery has **no runtime verification**. Missing historical card context and unverified release compliance remain explicit limitations.

**Recommended next command (operator-issued; advisory only):**

`/research S1 Android notification transport: evaluate the operator-selected FCM or self-hosted UnifiedPush candidate, pin receiver/provider versions and target-device acceptance criteria, and return the smallest authorized real-device delivery experiment; no vh-solara implementation or durable state.`

Resolve the deployment preference with the operator first; do not run both provider implementations to avoid making that protected decision. If S1 surfaces a material fact gap, refresh researcher evidence and re-run debate before implementation planning. This brief is a candidate design, not transition authority.
