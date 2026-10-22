# vh-solara × vh-agent-pulse: /vh/notify/* FCM channel contract — v4 (2026-10-21)

**Status.** v4 is **approved design / pre-implementation** (operator-approved
2026-10-20/21; design authority: the consolidated controller-hub brief at
`docs/architecture/notify-controller-hub-brief.md` — a researcher → debate → planner chain —
with the open timestamp gate subsequently executed and settled as Position C,
§7.2). Server-side, v1–v3 are implemented at commits `70607590` (slice 1:
history ring + token registry + routes), `26cd6add` (slice 2: FCM HTTP v1
sender), the v2 closeout slice (`c2bf5c26`), and `16ff64a`/`a1e82ade` (v3
slices A/B). **v4 is not yet implemented: until slices S1–S5 land, shipped
behavior remains v3.** This document states the v4 contract and freezes the
acceptance bars later slices must meet (§9). Golden wire fixtures for the v4
public shapes are pinned at `pkg/server/testdata/notify_v4/` and
machine-checked since S0 by `pkg/server/notify_v4_fixture_test.go`.

This document is the **canonical server copy** of the contract; the client's
`PROJECT.md` §9 mapping + checkpoint addendum point here. **Drift rule:** any
divergence between the two repos' behavior and this document must be flagged
cross-repo and reconciled here — never silently deviated from in either
implementation.

Scope (v4): **the central notification channel** — the controller's public
`/vh/notify/*` surface (token registration, probe, merged global history),
its FCM (Firebase Cloud Messaging) HTTP v1 sender, the private
worker→controller notify feed, and the worker-side detection + durable-source
machinery that feeds it. Workers remain the only detection authority; the
controller owns fleet-wide registration, merged history, and FCM delivery
(FCM credentials exist only on the controller). Explicitly **standalone**
installs keep the v3 worker-local channel unchanged (§3.6). See §7 for the
2026-10-14 direct-to-worker settlement and its 2026-10-21 supersession.

## 1. Changelog

### v1 → v2 (2026-10-14)

Three contract points were open in v1 and are now confirmed:

1. **`Notice.Kind` added** — waiting notices carry a true
   `permission | question` sub-kind, recorded at the engine emission site
   (`permission.asked`/`permission.updated` → `permission`;
   `question.asked` → `question`). The authorized `input_pending` fallback
   (an ambiguous blended condition) was **not** needed. The distinction
   surfaces downstream as `vh_condition: permission_pending |
   question_pending` in the FCM data (§3.3). Note: the *history* events
   (§3.1) do **not** carry the kind in v1–v3 — the distinction exists only in
   the push data and the wire `notice` event payload. (v4 surfaces it as the
   additive `kind` field, §1 v3→v4 (c).)
2. **`finished` → `vh_condition=session_unread`** (a client-side naming
   decision): a root-turn-finished push arrives with
   `vh_event=finished`, `vh_condition=session_unread`. Review counts on the
   client derive from `session_unread` only.
3. **`vh_count` fixed `"1"`** in v1: counts are never aggregated into push
   payloads. The client derives counts from fleet status + history
   reconciliation (§5), never from `vh_count`.

### v2 → v3 (2026-10-18)

Three additive changes, client-approved; no v2 field changed shape.

1. **Per-token `push_policy`** (`when_unattended | always`, default
   `when_unattended`). The attendance rung of the gating ladder (§3.4 rung 3)
   becomes **per token**: an attending device suppresses pushes only to
   `when_unattended` tokens; `always` tokens are delivered regardless of
   attendance. **Full-state POST rule:** `POST /vh/notify/tokens` treats the
   body as the token's complete desired state — a re-POST **without**
   `push_policy` RESETS the token to `when_unattended`; clients must always
   send the field (§3.1). The probe reports policy counts (§3.1).
2. **Observability** (§3.8): per-attempt failure log lines (token identified
   by label-or-hash, **never** the token value), a periodic channel-health
   line (~10 min), and `last_attempt`/`last_error` probe fields with
   LATEST-COMPLETED-ATTEMPT semantics (a later success **clears**
   `last_error`; only sanitized status+reason, never payloads).
3. **New notice type `session_started`** — a root session started running
   (§3.7). `vh_event=session_started`, `vh_condition=session_started`,
   `vh_count="1"`, **NORMAL** priority, `collapse_key=session_started`.
   Sweep-detected (up to ~one sweep interval + propagation latency); the
   first sweep after daemon start is a silent baseline; exactly one notice
   per running-count increase. Visible on **all channels** (SSE, webhooks,
   Web Push, FCM) subject to the same profile `types` filter as every other
   type — profiles with an explicit `types` list do **not** receive it until
   the operator adds it.

### v3 → v4 (2026-10-21 — approved design / pre-implementation)

Centralization per the operator's controller-hub requirement, plus one
negotiated breaking type change. Design authority:
`docs/architecture/notify-controller-hub-brief.md`; timestamp verdict in §7.2.

- **(a) Centralization.** The controller owns the public `/vh/notify/*`
  surface on **every host it serves** — the main host and every per-worker
  subdomain. Workers detect notices; the controller delivers them. FCM
  credentials are configured **controller-only**; controller-mode workers
  never hold or use them.
- **(b) `ts` type change — breaking, negotiated (Position C).** Public
  history `events[].ts` is now a **decimal string of Unix epoch
  milliseconds** on **both public surfaces** — the controller-served global
  history AND the standalone worker's public history. v3 emitted a JSON
  number; this is an explicit **breaking v3 type change**, negotiated and
  documented — not backward-compatible, not silent. Conversion happens at
  the **public DTO boundary**; internal storage and the private
  worker→controller feed remain **numeric int64**. The FCM data field
  `vh_ts` was already a string and stays one. Rationale (§7.2): the shipped
  Pulse 0.3.0 client declares `ts: String?` and its kotlinx.serialization
  1.11.0 strict-mode parser rejects a JSON number for it; the executed
  timestamp gate + debate rejected numeric and settled Position C.
  *Decoupled recommended follow-up (Pulse repo — NOT this contract's
  scope): client-side tolerant parsing + parse-failure reporting.*
- **(c) Additive fields on public history events** (exact names/shapes per
  §3.1 and the golden fixtures): `kind` (the condition vocabulary of
  §3.3/§9.1 — history now surfaces the distinction v2 added to push data),
  `count` (notices collapsed into the record; `1` today — the field exists
  so a future aggregation needs no wire change), `label` (pre-rendered
  display label, `"<worker name> — <title>"`), `worker`
  (`{"id","name"}` — the origin worker), `source` (`{"epoch","seq"}` — the
  durable-source identity of §9.2; epoch a string, seq an integer), and
  `ui_url` (deep link to the origin worker's `/app` with `session` + `dir`
  query params; **omitted** when no usable worker host is configured — the
  one history-event field that may be absent).
- **(d) `coverage` additive on the history response:**
  `{"complete": <bool>, "gaps": [<gap>]}`. **Source gaps** — a worker's
  durable feed losing a sequence range (spool overflow, persistence error,
  source reset) — are reported here as `{source_id, epoch, from_seq,
  to_seq}` entries. Central ids are **never** fabricated into holes to
  force a client refresh; global-id gap semantics (§5) remain purely about
  central prefix truncation.
- **(e) Central id rules.** Central history ids are assigned in
  **committed append order**, **strictly increasing**, retained by
  **prefix truncation only**; `lastId` is the committed global head; the
  `since`/`limit`/ascending/paging rules are **unchanged from v3** (§3.1).
  Central ids survive controller restarts; a lost or corrupt central
  ledger fails closed (no silent restart at id 1 — §9).
- **(f) FCM data message gains five additive keys**: `vh_worker_id`,
  `vh_worker_name`, `vh_session_id`, `vh_history_id`, `vh_ui_url`. The
  existing five keys (`vh_kind`, `vh_event`, `vh_condition`, `vh_count`,
  `vh_ts`) and their semantics are unchanged, as are the priority rules
  (`waiting` → HIGH, everything else NORMAL) and collapse-by-`vh_event`.
- **(g) Registration and probe, served centrally.** `POST
  /vh/notify/tokens` keeps the exact v3 request/response shape incl.
  `push_policy` and the **full-state POST rule** (§3.1). The probe keeps
  its field shape; `enabled` now reports **controller sender
  configuration/readiness** — not that every worker is covered; worker
  coverage is reported separately (admin diagnostics + `coverage`).
- **(h) Attendance moves to detection time on the origin worker** —
  **per-worker isolation**: a tab attending worker A does not suppress
  worker B's notices. The attendance snapshot travels in the durable
  source record; `always` bypasses attendance **only** (not disabled
  tokens, explicit scopes, cooldown, or stale-event policy). Worker
  profile eligibility is preserved independently of FCM credentials.
- **(i) Cooldown moves central and persists**, keyed
  `(source_id, type, token_hash)`. Delivery-cooldown decisions survive
  controller restarts and replay deterministically (delayed replay cannot
  starve one worker for another). Worker **detection** suppression
  (per-(type, session) dedup) stays on the worker; no second local FCM
  cooldown is applied to centrally owned events.
- **(j) Ownership fence — fail-closed.** A controller-mode worker starts
  with local FCM **disabled, before tunnel connection**; a disconnect
  never restores local authority; corrupt or missing ownership state in
  controller mode fails closed. No local fallback during mixed-version
  rollout — a temporary notification outage is explicit. Standalone
  worker-local FCM remains for **explicit standalone installs** (§3.6).
- **(k) Route ownership.** `/vh/notify/*` is served centrally on all
  hosts incl. worker subdomains (worker-local token/history routes are
  not exposed there). The legacy admin surface relocates to
  `/vh/admin/notify/*`. The worker→controller feed is **private**:
  `/vh/internal/notify/feed`, authenticated controller-only, denied on
  every public host/proxy path.
- **(l) Legacy controller history archived read-only.** The 2026-09-28
  controller notify program's history keeps a **separate namespace**; the
  new central history starts a new documented namespace at rollout.
  Clients migrate via the one-time **Log out → Connect** reset (§5);
  Connect alone is insufficient.
- **(m) The fleet-condition watcher's aggregate notification delivery is
  retired**; its admin UI + test-send merge into the central program at
  `/vh/admin/notify/*`. Fleet **status** itself is kept; the aggregate
  fleet-count notification feature is documented as lost; any future
  controller-health alerts need a separately approved, non-overlapping
  category.

## 2. Overview

The server detects noteworthy session states — a turn finished, a session
waiting on human input (permission or question), a session degraded (stuck
thinking, runaway command, stalled), a root session starting to run, a
worker's OpenCode process dying — and delivers them as:

- **in-app notice events** on the project store bus (existing surface, not
  this contract);
- **Web Push** to subscribed browsers (existing worker-side channel);
- **FCM data-only messages** to registered device tokens — **sent by the
  controller** in v4 (this contract);
- retained **notice history** at `GET /vh/notify/history` — the
  controller's merged global history, recorded BEFORE any delivery gating
  so suppressed notices are retained too (this contract). The standalone
  worker's own public history serves the same v4 event DTO.

v4 flow: the worker engine detects a notice and **durably appends an
enriched source record** (subtype, session/root/project/title/detail,
detection timestamp, origin-worker attendance, profile eligibility) before
declaring it available; the controller discovers compatible workers through
its connected-worker registry (authenticated enrollment, stable source
binding), polls each eligible source's private feed independently with a
committed cursor, and **atomically** appends global history + dispatch
intent; the central sender applies token policy and scopes, then sends FCM.
The phone registers once with the controller and reconciles controller
history + fleet status.

FCM messages are **data-only** (no `notification` block): the client app owns
presentation entirely and renders from the `vh_*` data fields.

**Reliability boundary (v4):** exactly-once *central ingestion of durably
recorded source events* is the target. Neither exactly-once phone delivery
nor unlimited offline retention is promised: the durable worker spool is
bounded (§9.8) and degrades visibly; events occurring while detection itself
is stopped are outside replay guarantees.

## 3. The contract

### 3.1 Routes

All public routes live on the controller and ride session-cookie auth +
`X-VH-CSRF: 1` on mutating POSTs (worker-compatible; unchanged from v3).

| Route | Owner | Surface |
|---|---|---|
| `POST /vh/notify/tokens` | controller | public — every host (main + worker subdomains) |
| `GET /vh/notify/tokens` (probe) | controller | public — every host |
| `GET /vh/notify/history` | controller | public — every host |
| `/vh/admin/notify/*` (list/PATCH/DELETE/test/history-read) | controller | admin (relocated legacy surface) |
| `/vh/internal/notify/feed` + enrollment/ACK control | controller ↔ worker | **private**, authenticated controller-only |
| worker daemon notify routes | worker | **standalone mode only** — never exposed on controller-served hosts |

#### `POST /vh/notify/tokens` — register / refresh a device token (central)

Request (v3 shape, unchanged):

```json
{"token": "<fcm-device-token>", "label": "<optional device label>",
 "push_policy": "<when_unattended | always>"}
```

`push_policy` optional, defaults to `when_unattended`. **Full-state POST
rule (unchanged):** the body is the token's complete desired state — a
re-POST **without** `push_policy` RESETS the token to `when_unattended`.
Clients must always send the field on every register/refresh. Idempotent by
token value; labels optional, truncated to 64 **runes**. The token is stored
in the central registry (§3.2). Golden fixture:
`pkg/server/testdata/notify_v4/registration_request_v4.json`.

Responses:

| Status | Body | When |
|---|---|---|
| 200 | `{"ok":true}` | registered (idempotent by token) |
| 400 | `{"ok":false,"error":"token required"}` | empty token |
| 400 | `{"ok":false,"error":"invalid push_policy"}` | `push_policy` present but not `when_unattended`/`always` |
| 400 | `{"ok":false,"error":"token limit reached"}` | registry full (32) and token new |
| 500 | `{"ok":false,"error":"…"}` | persistence failure |
| 503 | `{"ok":false,"error":"notify unavailable"}` | central channel unconfigured (checked BEFORE body validation — 503 wins over 400) |

#### `GET /vh/notify/tokens` — channel probe (central)

Never an error. Response (v3 field shape, unchanged; central semantics):

```json
{"enabled": true, "count": 1, "policies": {"when_unattended": 0, "always": 1},
 "last_attempt": "", "last_error": ""}
```

- `enabled:true` iff the **controller's** sender is configured and attached.
  It does **not** mean every worker is covered — worker coverage is reported
  separately (admin diagnostics; `coverage` on history, (d)). Pulse 0.3.0
  verifies connectivity by this route's HTTP success alone — keep it
  200-always.
- `policies`: token counts by push_policy; the two counts sum to `count`.
- `last_attempt`/`last_error` keep the v3 LATEST-COMPLETED-ATTEMPT semantics
  (§3.8), now describing the **central sender's** attempts.
- Token values and labels are **never** returned by any read route.
  Golden fixture: `pkg/server/testdata/notify_v4/probe_response_v4.json`.

#### `GET /vh/notify/history?since=<id>&limit=<n>` — merged global history

Golden fixtures: `pkg/server/testdata/notify_v4/history_response_v4.json`
(complete coverage) and `history_response_gaps.json` (source gaps).

```json
{
  "events": [{
    "id": 41, "type": "waiting", "sessionID": "ses_example", "root": "ses_root",
    "project": "/workspace/example", "title": "Review requested",
    "detail": "Question pending",
    "ts": "1792454400000",
    "kind": "question_pending", "count": 1, "label": "bason — Review requested",
    "worker": {"id": "bason", "name": "bason"},
    "source": {"epoch": "epoch-example", "seq": 128},
    "ui_url": "https://worker.example/app?session=ses_example&dir=%2Fworkspace%2Fexample"
  }],
  "lastId": 41,
  "coverage": {"complete": true, "gaps": []}
}
```

Event fields:

- **v3 base (always present, no omitempty):** `id` (integer), `type`,
  `sessionID`, `root`, `project`, `title`, `detail` (strings). The v3
  daemon-level shape is preserved: a daemon-level notice (e.g. the worker's
  OpenCode process died) carries `type:"stalled"`, `title:"OpenCode"`, and
  **empty** `sessionID`/`root`/`project` by design.
- **v4 additive:** `kind` (string — the condition vocabulary of §3.3/§9.1;
  the v1–v3 "no `kind` field" rule is reversed by (c)), `count` (integer;
  notices collapsed into this record — `1` today), `label` (string —
  `"<worker name> — <title>"`), `worker` (`{"id": string, "name": string}`
  — the origin worker), `source` (`{"epoch": string, "seq": integer}` —
  §9.2; `source_id` equals `worker.id` in the one-source-per-worker v4
  design), `ts` (**decimal string of epoch milliseconds** — (b); v3 emitted
  a JSON number; a JSON number here is now a contract violation), and
  `ui_url` (string — deep link to the origin worker's `/app` with `session`
  and `dir` query params; daemon-level notices link the worker's `/app`
  root). Links are constructed from the **controller's configured worker
  host pattern**, never from a feed-supplied URL. `ui_url` is the **only**
  event field that may be absent — omitted when no usable worker host is
  configured; no path-based worker route is invented.

Response fields: `events` (the page), `lastId` (integer — the committed
global head), `coverage` (object — `{"complete": bool, "gaps": []}` when
nothing is missing; otherwise `gaps` carries `{source_id, epoch, from_seq,
to_seq}` entries naming each source's missing inclusive sequence range).
Source gaps are never represented as fabricated central-id holes (d).

Paging (unchanged from v3):

- **`since > 0`:** events with `id > since`, **ascending (oldest-first)**,
  at most `limit` of them — forward paging (§5).
- **`since` omitted/0:** the newest `limit` events, ascending.
- **`limit`:** `0`/absent → 50; values above 200 are clamped to 200;
  `limit` > 200 is therefore not an error.
- Negative `since` or `limit` (or non-numeric) →
  `400 {"ok":false,"error":"bad since"|"bad limit"}`.
- **`lastId`:** the committed global head — the client's resume cursor. It
  can exceed the newest returned event after prefix truncation — `lastId`
  is a head pointer, not "the id of the last event returned". Page from the
  last id actually received, never directly to `lastId`.

Central id rules ((e), restated): assigned only with committed central
records (never copied from workers, never sorted retrospectively by
timestamp); strictly increasing; persisted across controller restarts;
retention applies **only as prefix truncation** — worker removal,
suppression, token scope, and delivery failure must not create holes; there
is **no per-worker filtering** of this stream. A lost or corrupt central
ledger stops ingestion/dispatch and fails closed (§6, §9).

#### `/vh/admin/notify/*` — relocated administrative surface

The 2026-09-28 controller notify program's list/PATCH/DELETE/test/
history-read operations relocate here in the same release as the public
cutover; their backend merges into the central registry/dispatcher. Test
messages are explicitly labeled and never create worker-detection history.
The legacy program's history is archived read-only in a separate namespace
((l)); its read cursor never mingles with v4 global ids.

#### `/vh/internal/notify/feed` — private worker feed

Bounded GET pages over the yamux tunnel (deadlines, body limits,
stream-not-tunnel cleanup); one active fetch per source; committed-cursor
based; retry reads after failure; the cursor never advances before commit.
Enrollment and the durable-watermark (H) mutation are separate
**authenticated control operations**, not side-effecting GETs. The feed is
denied on main-host, worker-host, and generic public proxy paths — a
private-looking prefix alone is not authorization. The feed and all
internal storage keep **numeric int64** timestamps ((b)).

### 3.2 Token storage semantics (central registry)

Tokens live in the controller's notify store (the `--notify-store`
configured storage anchor). v4 performs a **versioned, atomic migration**
with backup and fail-closed validation: token ids, values, labels,
creation/use/error metadata, and scopes are preserved;
`scope.enabled=false` stays disabled; migrated policy defaults
conservatively to `when_unattended`; unsupported legacy condition filters
stay dormant and visible rather than becoming unrestricted. (The worker
store — JSON array at `<VH_STATE_DIR>/notify-tokens.json`, atomic
tmp+rename, 0600 — remains only for standalone mode.) Cap: 32 tokens.
Token values are secrets-in-transit: never returned over the wire, never
logged; cooldown state keys on a truncated hash of the token, not the
token itself. Dead-token pruning is evidence-gated (§3.5); there is no
client-side unregister route.

### 3.3 FCM message shape

Endpoint: FCM HTTP v1 `POST /v1/projects/{project_id}/messages:send`, OAuth2
bearer token from the service-account JWT flow (RS256 assertion,
`scope=https://www.googleapis.com/auth/firebase.messaging` (the full URL —
`firebase.messaging` is shorthand only), exchanged at the credentials file's
`token_uri`, cached and refreshed ~5 min before expiry). In v4 this sender
runs **on the controller** (credentials controller-only, (a)).

The message is **data-only** (no `notification` block). Data fields — all
values are strings (an FCM data-message requirement):

| Key | Value |
|---|---|
| `vh_kind` | `"notice"` (fixed in v2) |
| `vh_event` | `waiting \| finished \| stuck-thinking \| runaway \| stalled \| session_started` |
| `vh_condition` | see table below |
| `vh_count` | `"1"` (fixed — v1 §3) |
| `vh_ts` | detection time, unix milliseconds, string (already a string in v3; unchanged by (b)) |
| `vh_worker_id` | origin worker id (additive v4) |
| `vh_worker_name` | origin worker display name (additive v4) |
| `vh_session_id` | the notice's sessionID — **empty string** for daemon-level notices (additive v4) |
| `vh_history_id` | the central history id, decimal string (additive v4) |
| `vh_ui_url` | deep link, same construction rules as the history `ui_url`; omitted when none exists (additive v4) |

Golden fixture: `pkg/server/testdata/notify_v4/fcm_message_v4.json`.

`vh_condition` vocabulary:

| `vh_event` | condition | when |
|---|---|---|
| `waiting` | `permission_pending` | a permission request is pending (kind=permission) |
| `waiting` | `question_pending` | a question is pending (kind=question) |
| `finished` | `session_unread` | a root turn completed and settled (v1 §2) |
| `stuck-thinking` | `degraded_thinking` | reasoning streaming beyond threshold |
| `runaway` | `degraded_runaway` | a non-task tool running beyond threshold |
| `stalled` | `degraded_stalled` | busy but silent beyond threshold (session-scoped) |
| `stalled` | `worker_down` | the worker's OpenCode itself died (daemon-level notice: empty sessionID/root, title "OpenCode") |
| `session_started` | `session_started` | a root session started running (v3 §3.7; identity mapping — `vh_event == vh_condition`) |

§9.1's notice-type → condition enumeration is the complete authority for
this vocabulary; this table mirrors it, and any divergence resolves in
§9.1's favor.

Android config: `priority: "HIGH"` for `waiting` (load-bearing: normal
priority is deferred by Android Doze and waiting-for-input must not be),
`"NORMAL"` otherwise; `collapse_key` = the `vh_event` value (collapsing is
by type, so wakes from different workers may collapse together — history
remains authoritative; one phone banner per notice is NOT promised);
`ttl` = `"{configured ttl_sec}s"` **bounded by the event's remaining
freshness** — an old replay never gets a fresh full TTL (§3.4 rung 5).

### 3.4 Gating ladder (v4, central dispatch)

A notice reaches a given token only if ALL rungs pass, in order:

1. **Central channel enabled** — the controller's sender is configured and
   attached.
2. **Active profile type filter** — the **origin worker's** active alerts
   profile wanted the event type **at detection time** (empty list = all
   types). Eligibility is captured in the durable source record; the
   controller does not re-derive it.
3. **Attendance — per token, origin-worker-scoped, measured at detection
   ((h))** — the origin worker's attendance snapshot (taken when detection
   occurred; per-worker isolation) suppresses pushes to
   `when_unattended` tokens (the default); `always`-policy tokens deliver
   **regardless of attendance**. `always` bypasses attendance **only** —
   not disabled tokens, explicit scopes, cooldown, or the stale-event
   policy. Web Push keeps channel-wide worker-side suppression; webhooks
   honor their per-profile `channel_policy`.
4. **Central cooldown ((i))** — a second push of the same
   `(source_id, type, token_hash)` within `detect.cooldown_sec` is
   suppressed; the decision is **persisted** and replays deterministically.
5. **Stale-event policy** — events older than the freshness threshold
   (S0 default: 24h, operator-tunable — §9.8) are **history-only**: never
   pushed, however much TTL remains. History retention itself is not
   bounded by this rung.

### 3.5 Delivery hygiene

- **UNREGISTERED-evidence-gated pruning, with generation binding.** A token
  is deleted from the registry only when FCM answers 400 or 404 with
  explicit UNREGISTERED evidence in the error body: a
  `details[].errorCode == "UNREGISTERED"` entry or a top-level
  `error.status == "UNREGISTERED"`. A generic 404 NOT_FOUND (FCM's answer
  to sender-side misconfiguration) **retains** the token. **Generation
  binding:** a stale UNREGISTERED result from an older token generation
  must not delete a since-re-registered token. Other tokens and history
  are always preserved; diagnostics are masked (label-or-hash).
- **401 → one forced token refresh + one retry**, then give up.
- **Clean 5xx → one cheap retry**, then give up.
- **Ambiguous attempts — no blind resend (v4).** An attempt durably
  claimed before the external call, followed by timeout/crash, is
  ambiguous: record sanitized attempt state and do not blindly resend. A
  possibly-lost push wakeup is the accepted cost; committed history is
  not lost. (Deliberate v4 change from v3's uniform best-effort posture —
  persisting an intent alone does not prevent duplicate sends; a claimed
  attempt persisted before the external call is the fence.)
- **No retry queue, no backoff loop.** Failures never block or break the
  rest of the pipeline.

### 3.6 Config section

- **Controller (v4):** FCM credentials live only in the controller's
  configuration (the existing service-account flag/store anchor). They are
  never copied to workers and never logged.
- **Worker, controller mode (v4):** the local `notify` section
  (`VH_STATE_DIR/alerts.jsonc`, §v3 shape: `credentials_file`,
  `project_id`, `ttl_sec`) is **ignored for sending** — the local sender is
  fenced **before tunnel connect** regardless of the section's presence
  ((j)). Corrupt or missing ownership state in controller mode fails
  closed; a disconnect never restores local authority.
- **Worker, standalone (v3 semantics, verbatim):** the `notify` section
  behaves exactly as v3 — a load failure at init leaves the channel
  silently disabled (`enabled:false`, upserts 503) without affecting
  anything else in alerts; the settings UI does not edit this section and
  a UI save preserves it verbatim.

### 3.7 `session_started` detection semantics (v3 — unchanged by v4)

The sixth notice type, sweep-detected by design (the client accepts sweep
latency); detection remains worker-side under v4:

- **What is a running root.** A session whose OWN activity is `busy`/`retry`
  and which is a root (no tracked parent). A busy child under an idle root is
  the root's ongoing turn (delegation), not a new session start.
- **Detection.** Each engine sweep (20 s tick) compares the current set of
  running roots against the previous sweep's. On an **increase in count**,
  exactly **one** `session_started` notice fires, carrying a representative
  newly-running root (`sessionID`/`root`/`title` from that root,
  human-readable detail). Multiple new roots within one sweep collapse to one
  notice — per-session fires would be collapsed by the 300 s
  per-(type, token)/(type, session) cooldowns anyway, and `vh_count` is fixed
  `"1"` per contract.
- **Latency.** Up to ~one sweep interval (20 s) plus propagation — this is
  the accepted cost of the sweep design (no event-stream hook on session
  start).
- **Baseline rule.** The FIRST sweep after daemon/engine start establishes
  the initial running-root set WITHOUT firing — sessions already running at
  startup never produce `session_started` (the only-events-after-startup
  rule, same as every other detector).
- **Once per increase.** A decrease or unchanged count never fires. A root
  that stops running and later runs again is a new increase and fires again
  (subject to the cooldown rungs). A same-sweep replacement (one stops,
  another starts; count unchanged) does not fire.
- **All-channel visibility.** The notice rides the standard fire path: SSE
  notice events, webhooks, Web Push, and FCM all see it, subject to each
  channel's gating — including the **profile `types` filter** (§3.4 rung 2):
  profiles with an explicit `types` list do **not** receive
  `session_started` until the operator adds it; an empty list (= all types)
  includes it. This is intended filter behavior, not a defect to fight.
- **Priority/collapse.** NORMAL priority (only `waiting` is HIGH — a session
  merely starting is not interrupt-worthy), `collapse_key=session_started`
  (derives from `vh_event` as for every type),
  `vh_condition=session_started` (identity mapping), `vh_count="1"`.

### 3.8 Observability (v3 semantics — the emitter is now the central sender)

The channel emits operator-facing health signals without ever exposing token
material:

- **Per-attempt failure log lines.** Every failed FCM send logs one line
  with the token identified by **label-or-hash** (the 32-hex truncated token
  hash — `hex(sha256(token)[:16])` — when no label is set) — **never the
  token value** — plus the sanitized status and reason. Payloads are never
  logged.
- **Channel-health line (~every 10 min).** A periodic line reports enabled
  state, token counts by policy, and attempted/succeeded/failed/pruned
  counters since the previous line (window counters reset on each line).
- **Probe fields.** `GET /vh/notify/tokens` exposes `last_attempt` /
  `last_error` (§3.1) with **LATEST-COMPLETED-ATTEMPT semantics**: the pair
  describes the most recent send attempt that has *finished* (either
  outcome) across all tokens — `last_attempt` is that attempt's start time,
  `last_error` its outcome, and a later success **clears** `last_error`.
  Both fields are **empty strings** until some attempt has completed, and
  the pair is published together at completion (never one attempt's
  timestamp with another's outcome). They are sanitized (status + reason
  only), never carry token material, and are safe to surface in any
  operator UI.
- **Coverage diagnostics (v4).** Per-worker feed state — enrollment,
  degraded spool, source gaps, watermark H — surfaces in the
  **admin diagnostics** surface, separate from the public probe's
  `enabled` ((g), (d)).

## 4. Confirmed interpretation behaviors (client-confirmed 2026-10-14; v4 deltas noted)

These were ambiguous in v1 and are now settled by the client:

1. **503-before-400 when unconfigured:** the channel-unavailable check runs
   before body validation, so even a malformed body answers 503 while the
   channel is down. (v4: evaluated on the central route.)
2. **`lastId` is a highest-ever-committed head pointer**, not the id of the
   newest returned event — it may exceed the max returned id after prefix
   truncation.
3. **Forward paging is ascending from `since+1`, capped at `limit`** (then
   clamped at 200).
4. **Labels are truncated to 64 runes** (not bytes, not an error).
5. **Negative `since`/`limit` → 400;** `limit=0`/absent → 50.
6. **(v4, negotiated 2026-10-21)** Public history `ts` is a **decimal
   string** of epoch millis ((b)). A JSON number on a public history
   surface is a contract violation; the S0 fixture validator
   (`pkg/server/notify_v4_fixture_test.go`) enforces string-typed `ts` on
   the golden public shapes.

## 5. Client reconciliation algorithm

Stated from the client's intent (so the semantics are documented, not
inferred from either implementation):

- Page forward with `since = <last event id actually received>`, one full
  page at a time, until a page's newest id equals the response's `lastId`.
- Only when fully caught up, persist `cursor = lastId`. A literal
  `since = lastId` after a limit-capped page would skip the capped middle —
  **never do that**.
- **Gap detection:** if a response's first returned id is greater than
  `cursor + 1`, events were truncated before receipt. History gaps are
  unrecoverable by design: drop incremental processing for that window and
  do a full fleet-status refresh instead.

v4 notes:

- `ts` parses as a **decimal string of epoch milliseconds** (int64 range).
  Client-side tolerant parsing + parse-failure reporting is a recommended
  decoupled follow-up in the Pulse repo — not part of this contract.
- **Global-id gaps ≠ source gaps.** Global-id gap semantics are unchanged
  (central prefix truncation only). `coverage.gaps` is additive: Pulse 0.3.0
  safely ignores it; clients that understand it may surface a
  degraded-coverage diagnostic. Never fabricate one into the other.
- **One-time migration ((l)):** at cutover, **Log out → Connect once** —
  this clears the old cursor and the registration skip state. Connect
  alone (or a mere upgrade/reconnect to the same URL) is insufficient, and
  the archived legacy controller history namespace is never treated as the
  new central one.

## 6. Server implementation notes (contract-relevant)

- **Test notices are excluded from history:** test-send (relocated to
  `/vh/admin/notify/*`) fires a synthetic notice at one transport channel,
  bypassing the engine's fire path entirely — it never reaches central
  history, the push channels, or (in v4) per-session dispatch.
- **Pruning protects against wrong-project config** (§3.5): generic/project
  NOT_FOUND retains registrations.
- **Runtime config asymmetry (now the central sender):** *disable* is
  immediate; *initial enable* and *changed credentials/project/TTL*
  require a controller restart — the sender attaches only at startup.
- **Attendance per token for FCM** (§3.4 rung 3): the v3 detail "measured
  at `Send` time" is superseded by (h) — v4 measures attendance at
  **detection** on the origin worker and ships the snapshot in the source
  record; the per-token policy split (`when_unattended` vs `always`) is
  unchanged.
- **Ids are contiguous within the retention window**; prefix truncation
  only removes the oldest end, and the persisted counter never regresses
  (ids are never reused across restarts).
- **Central ledger loss/corruption stops ingestion and dispatch** and
  requires restore/recovery disposition — it never silently resets public
  ids (§9).
- **The fleet-condition watcher no longer delivers aggregate
  notifications** ((m)); fleet status itself is kept.
- **S4 implementation posture (landed):** the central dispatcher
  (`pkg/server/notify_dispatch.go`) is **opt-in** — it starts only with
  `--notify-dispatch` (plus `--notify-store` and
  `--notify-fcm-credentials`), because the legacy fleet watcher keeps
  running until the S5 cutover retires it. **Documented enable order:**
  (1) deploy the S4 controller with dispatch OFF; (2) verify the schema-1
  → schema-2 token migration (admin masked list / probe counts) and let
  Pulse re-register (full-state POSTs set policies without touching
  administrative disable/scopes); (3) enable `--notify-dispatch`,
  accepting the bounded overlap with the legacy watcher until S5.
  Dispatch freshness (`--notify-stale-after`, default 24h per §9.8) and
  the central cooldown (`--notify-dispatch-cooldown`, default 300s) are
   operator-tunable. The interim admin home for the masked list is
   `GET /vh/admin/notify/tokens` (S4) — the management UI (NotifyDialog)
   consumes it since the S4 route swap; PATCH/DELETE/test-send (the
   remaining admin operations) relocate there in S5.

## 7. Network path & controller route ownership (settled 2026-10-14 — **superseded 2026-10-21**)

### 7.1 Historical settlement: V1 direct-to-worker (superseded)

The network path question was settled 2026-10-14 (confirmed by the client
`vh-agent-pulse`):

- **V1 network path: DIRECT-TO-WORKER.** The phone reached the worker
  origin directly — LAN when on-network, plus the operator's existing
  tunnel/VPN to the worker host when off-LAN. Worker-local auth (session
  cookie + `X-VH-CSRF: 1`) as specced in §3.1.
- **No controller-mediated access in V1** — the server-side route-ownership
  / proxy change was explicitly deferred, not abandoned. Rationale: FCM
  delivered independently of daemon reachability (Google → phone); the
  client's on-push flow degraded by design (render from payload;
  reconcile history/fleet when the worker is reachable; staleness-render
  otherwise). Two client-stated conditions attached to any future proxy:
  partition integrity (do not disturb the pre-existing controller
  notification surface) and auth compatibility (cookie + CSRF semantics).
- **Release posture:** untagged release acceptable to the client; they
  targeted integration against a tagged release when it existed.

**This settlement is superseded** by the operator's centralization
requirement (2026-10-20/21): v4 moves public `/vh/notify/*` to the
controller on every host (§3.1). The 2026-10-14 record is retained here as
decision history, not as live contract. The two client-stated proxy
conditions are absorbed into v4: partition integrity via the
`/vh/admin/notify/*` relocation ((k), (m)); auth compatibility via
unchanged cookie + CSRF semantics on the central routes.

### 7.2 Supersession record & the timestamp gate verdict

- **Superseded:** direct-to-worker (2026-10-14) → controller-owned public
  surface (operator directive, 2026-10-20/21; brief
  `docs/architecture/notify-controller-hub-brief.md`; this v4 bump).
- **Timestamp gate (executed after the brief):** the brief flagged
  `ts`-number-vs-string as a **release gate** — Pulse declares
  `ts: String?` while v3 emitted a JSON number; the brief required running
  the fixture through the shipped Pulse parser before declaring
  no-client-change compatibility, and forbade silently changing `ts` to a
  string as "additive". The gate + subsequent debate found the shipped
  Pulse 0.3.0 (kotlinx.serialization 1.11.0 strict mode) **rejects a JSON
  number** for `ts`. **Verdict — Position C (decided 2026-10-21):** public
  history serves `ts` as a **decimal string of Unix epoch milliseconds**
  on **both public surfaces** (controller-served AND standalone-worker
  public history); conversion happens at the public DTO boundary;
  internal storage and the private worker→controller feed stay numeric
  int64. This is an explicit **breaking v3 type change**, negotiated and
  documented — not backward-compatible, not silent. Client-side tolerant
  parsing + parse-failure reporting is a decoupled recommended follow-up
  for the Pulse repo (NOT this contract's scope; not implemented here).

### 7.3 Live route-ownership facts (v4)

The controller intercepts **every** `/vh/notify/*` request — including
requests arriving on per-worker subdomains — and serves **this v4
contract** (registration, probe, merged history). The 2026-09-28 legacy
handlers no longer occupy the public prefix: they relocate to
`/vh/admin/notify/*` ((k)). The private feed lives at
`/vh/internal/notify/feed` and is never exposed on a public path.

## 8. Testing posture

Lane-1 unit tests (`pkg/alerts/notify_test.go`, `pkg/web/notify_feature_test.go`,
`pkg/alerts/engine_test.go` — including the v3 `session_started` detector
cases and the attended/unattended `always`-policy companion pair) plus the
lane-2 integration tests
(`tests/integration/notify_lifecycle_test.go` — real `InitAlerts` wiring →
waiting-question notice through the real engine event path → mock-FCM receipt
+ history entry + probe; and `TestNotifySessionStartedSweepToFCM` — the v3
leg: a root session going running after the first-sweep baseline produces the
`session_started` FCM receipt through the REAL 20 s sweep ticker) cover
everything through mock FCM servers, including the OAuth JWT flow, gating,
cooldown, pruning, and cache boundaries. Real-FCM end-to-end delivery is
**out of scope for CI** — the same posture as Web Push; a configuration
smoke test against real FCM is an operator activity.

v4 additions:

- **S0 (landed):** golden wire fixtures at `pkg/server/testdata/notify_v4/`
  (README + five JSON shapes) and the lane-1 schema-shape validator
  `pkg/server/notify_v4_fixture_test.go` — field presence + TYPES,
  especially **`ts`-as-string on public shapes** (a JSON number there fails
  the test).
- **S3–S5** must pin their served output **byte-shape-identical** to the
  golden fixtures (field names/types; key order insensitive) and meet the
  §9 acceptance bars. Before any delivery-success claim, retain the §9.6
  receipts.

## 9. v4 acceptance criteria (frozen bars — S1–S5 must meet these)

### 9.1 Notice-type → condition mapping (complete enumeration)

| notice type | `kind` / `vh_condition` | FCM priority |
|---|---|---|
| `waiting` (kind=permission) | `permission_pending` | HIGH |
| `waiting` (kind=question) | `question_pending` | HIGH |
| `finished` | `session_unread` | NORMAL |
| `stuck-thinking` | `degraded_thinking` | NORMAL |
| `runaway` | `degraded_runaway` | NORMAL |
| `stalled` (daemon-level: empty sessionID/root, title "OpenCode") | `worker_down` | NORMAL |
| `stalled` (session-scoped) | `degraded_stalled` | NORMAL |
| `session_started` | `session_started` | NORMAL |

No emitted notice type maps to `unknown`; any future notice type gets a
mapping **before** release (never reconstructed from free text).

### 9.2 Durable-source identity

- Identity tuple: **`(source_id, epoch, seq)`** — the dedupe/ingestion key.
- **Epoch-stability rule:** ordinary worker restarts **preserve** epoch and
  sequence; only genuine source-state replacement rotates the epoch, and
  rotation is reported as a discontinuity (coverage gaps / diagnostics) —
  never silently, never per-restart.
- Source records are enriched at detection, before becoming available for
  centralized delivery: subtype, session/root/project/title/detail,
  detection timestamp (numeric int64 internally), origin-worker attendance
  snapshot ((h)), and profile eligibility.

### 9.3 Exactly-once central ingestion

- **Dedupe on the source tuple:** exactly one central event per
  `(source_id, epoch, seq)` under retry, replay, and duplicate delivery. A
  repeated detector emission with a **new** source sequence is not
  transport duplication.
- **Atomic commit:** event append, source cursor, dedupe record, and
  dispatch intent commit **together** (journal/transactional storage
  boundary with explicit error reporting and recovery — never independent
  JSON writes assumed atomic). The cursor never advances before commit.

### 9.4 No-double-delivery fence + ownership watermark H

- Controller-mode workers fence local FCM **before tunnel connect** ((j)).
- A previously-standalone worker quiesces and drains local sends while
  detection continues durably; ownership + H persist before ACK; local
  delivery is permitted only **at/below H**, central dispatch only
  **above H**; pre-H retained events import **history-only**.
- A lost ownership ACK reconciles against persistent state; a disconnect
  **never** restores local authority. Corrupt/missing ownership state in
  controller mode **fails closed** (no local fallback).

### 9.5 UNREGISTERED-evidence-gated pruning (with generation binding)

- Prune only on canonical FCM UNREGISTERED evidence
  (`details[].errorCode == "UNREGISTERED"` or top-level
  `error.status == "UNREGISTERED"`); generic HTTP 404/410 **retains**.
- A stale result from an older token generation must not delete a
  since-re-registered token. Other tokens and history are preserved;
  diagnostics are masked.

### 9.6 Retained receipts

Before any delivery-success claim, retain **revision-bound** evidence of
the full path: **detection → durable feed → tunnel → central history →
fake-FCM request** (command receipts bound to the assessed tree). A
real-device canary (notification receipt + history reconciliation) is a
separate operator activity; deep-link taps, if ever implemented, require
real interaction evidence.

### 9.7 Mixed-version matrix (rollout safety)

| Controller | Worker | Required behavior during rollout |
|---|---|---|
| Old | Old | Existing incompatible controller API / local-worker behavior remains. Not a supported centralized fleet. |
| Old | New (controller mode) | Worker spools; local FCM stays off (fenced). No compatible controller ownership ⇒ no central pushes. The temporary notification outage is **explicit** — no local fallback. |
| New | Old | Mark unsupported; do **not** centrally dispatch that worker's notices (merely disabling its FCM does not supply the durable-feed semantics). |
| New | New | Automatic enrollment, durable fence, pull replay, central-only delivery. |
| Controller rolled back | Already-centralized worker | Preserve fence/spool; **no local fallback**; restore a compatible controller. Legacy worker binaries must not reopen a migrated store blindly. |
| New controller | Worker downgraded to old binary | Unsupported: an old binary may ignore ownership. Remove/revoke worker FCM credentials **before** any rollback-capable rollout; stop central eligibility when capability disappears. No silent dual-delivery fallback. |

### 9.8 Retention & freshness defaults (S0 defaults — operator-tunable bars)

- **Durable worker spool:** bounded at **10,000 events per worker**. On
  overflow or persistence error: raise **visible degraded coverage**
  (admin diagnostics + `coverage.gaps`), never silent ring eviction, and
  never ACK non-durable events or claim completeness. (An arbitrarily long
  outage plus finite disk cannot meet an absolute no-loss guarantee — the
  bar is visible degradation, not silence.)
- **Stale-push suppression:** events older than **24 hours** are
  **history-only** — always retained and reconcilable within retention,
  never pushed (§3.4 rung 5).
- Both values are frozen as the S0 acceptance defaults and flagged
  **operator-tunable** (retention budget, outage horizon, overflow policy)
  — changing them is an operator decision, not an implementation
  discretion.
