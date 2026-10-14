# vh-solara × vh-agent-pulse: /vh/notify/* FCM channel contract — v2 (2026-10-14)

**Status.** Settled client-side (vh-agent-pulse `PROJECT.md` §5/§8/§9 + checkpoint
`2026-10-14-push-transport-decision`). Server-side implemented at commits
`70607590` (slice 1: history ring + token registry + routes), `26cd6add`
(slice 2: FCM HTTP v1 sender), and the closeout slice (integration test through
the real `InitAlerts` wiring, deferred unit tests, and this document).

This document is the **canonical server copy** of the contract; the client's
`PROJECT.md` §9 mapping + checkpoint addendum point here. **Drift rule:** any
divergence between the two repos' behavior and this document must be flagged
cross-repo and reconciled here — never silently deviated from in either
implementation.

Scope: the **worker daemon's** `/vh/notify/*` routes and its FCM (Firebase
Cloud Messaging) HTTP v1 sender — the channel that reaches the vh-agent-pulse
Android app when it is closed or backgrounded. It complements (and mirrors the
gating of) the existing Web Push channel; it does not replace it. See §7 for
the settled network-path decision (direct-to-worker in V1; controller proxy deferred).

## 1. v1 → v2 changelog

Three contract points were open in v1 and are now confirmed:

1. **`Notice.Kind` added** — waiting notices carry a true
   `permission | question` sub-kind, recorded at the engine emission site
   (`permission.asked`/`permission.updated` → `permission`;
   `question.asked` → `question`). The authorized `input_pending` fallback
   (an ambiguous blended condition) was **not** needed. The distinction
   surfaces downstream as `vh_condition: permission_pending |
   question_pending` in the FCM data (§3.4). Note: the *history* events
   (§3.3) do **not** carry the kind — the distinction exists only in the push
   data and the wire `notice` event payload.
2. **`finished` → `vh_condition=session_unread`** (a client-side naming
   decision): a root-turn-finished push arrives with
   `vh_event=finished`, `vh_condition=session_unread`. Review counts on the
   client derive from `session_unread` only.
3. **`vh_count` fixed `"1"`** in v1: counts are never aggregated into push
   payloads. The client derives counts from fleet status + history
   reconciliation (§5), never from `vh_count`.

## 2. Overview

The server (vh-solara worker daemon) detects noteworthy session states — a
turn finished, a session waiting on human input (permission or question), a
session degraded (stuck thinking, runaway command, stalled) — and delivers
them as:

- **in-app notice events** on the project store bus (existing surface, not
  this contract);
- **Web Push** to subscribed browsers (existing channel);
- **FCM data-only messages** to registered device tokens (this contract);
- retained **notice history** at `GET /vh/notify/history` (this contract),
  recorded BEFORE any delivery gating, so suppressed notices are retained too.

FCM messages are **data-only** (no `notification` block): the client app owns
presentation entirely and renders from the `vh_*` data fields.

## 3. The contract

### 3.1 Routes

All routes live on the worker daemon's `/vh/*` surface and ride its shared
middleware stack: session auth on every route, `X-VH-CSRF: 1` on mutating
POSTs.

#### `POST /vh/notify/tokens` — register / refresh a device token

Request: `{"token": "<fcm-device-token>", "label": "<optional device label>"}`

Responses:

| Status | Body | When |
|---|---|---|
| 200 | `{"ok":true}` | registered (idempotent by token) |
| 400 | `{"ok":false,"error":"token required"}` | empty token |
| 400 | `{"ok":false,"error":"token limit reached"}` | registry full (32) and token new |
| 500 | `{"ok":false,"error":"…"}` | persistence failure |
| 503 | `{"ok":false,"error":"notify unavailable"}` | channel unconfigured (checked BEFORE body validation — 503 wins over 400) |

Semantics: idempotent by token value — re-registering an existing token
refreshes its label and keeps its first-seen timestamp. Labels are optional
and truncated to 64 **runes**.

#### `GET /vh/notify/tokens` — channel probe

Never an error. Response: `{"enabled": <bool>, "count": <int>}`.
`enabled:true` iff the alerts config carries a loadable `notify` section AND
the sender is attached. Token values and labels are **never** returned by any
read route.

#### `GET /vh/notify/history?since=<id>&limit=<n>` — retained notice ring

Response:

```json
{
  "events": [
    {"id": 4, "type": "waiting", "sessionID": "s_abc", "root": "s_abc",
     "project": "/repo", "title": "Fix login", "detail": "Waiting for your input",
     "ts": 1760000000123}
  ],
  "lastId": 7
}
```

- Every event field is always present (no omitempty). A daemon-level notice
  (e.g. the OpenCode process died) carries `type:"stalled"`, `title:"OpenCode"`,
  and **empty** `sessionID`/`root` by design. There is **no `kind` field**
  (§1.1).
- **`since > 0`:** events with `id > since`, **ascending (oldest-first)**, at
  most `limit` of them — forward paging (§5).
- **`since` omitted/0:** the newest `limit` events, ascending.
- **`limit`:** `0`/absent → 50; values above 200 are clamped to 200;
  `limit` > 200 is therefore not an error.
- **`lastId`:** the highest id **ever allocated** (the client's resume
  cursor). It can exceed the newest returned event after ring overflow —
  `lastId` is a head pointer, not "the id of the last event returned".
- Negative `since` or `limit` (or non-numeric) → `400 {"ok":false,"error":"bad since"|"bad limit"}`.
- Ring capacity ≈ 500 events per daemon; ids are strictly increasing,
  persisted across daemon restarts, and **contiguous within the retention
  window** (gaps mean eviction, never id reuse — §5 gap detection).

### 3.2 Token storage semantics

Tokens persist at `<VH_STATE_DIR>/notify-tokens.json` (JSON array, atomic
tmp+rename, 0600, reloaded on daemon start; a corrupt file starts an empty
registry). Cap: 32 tokens. Token values are secrets-in-transit: never
returned over the wire, never logged; the sender keys its cooldown state by a
truncated hash of the token, not the token itself. Dead-token pruning is
server-driven (§3.6); there is no client-side unregister route in v2.

### 3.3 FCM message shape

Endpoint: FCM HTTP v1 `POST /v1/projects/{project_id}/messages:send`, OAuth2
bearer token from the service-account JWT flow (RS256 assertion,
`scope=https://www.googleapis.com/auth/firebase.messaging` (the full URL —
`firebase.messaging` is shorthand only), exchanged at the credentials file's
`token_uri`, cached and refreshed ~5 min before expiry).

The message is **data-only** (no `notification` block). Data fields — all
values are strings (an FCM data-message requirement):

| Key | Value |
|---|---|
| `vh_kind` | `"notice"` (fixed in v2) |
| `vh_event` | `waiting \| finished \| stuck-thinking \| runaway \| stalled` |
| `vh_condition` | see table below |
| `vh_count` | `"1"` (fixed — §1.3) |
| `vh_ts` | detection time, unix milliseconds, string |

`vh_condition` vocabulary:

| `vh_event` | condition | when |
|---|---|---|
| `waiting` | `permission_pending` | a permission request is pending (kind=permission) |
| `waiting` | `question_pending` | a question is pending (kind=question) |
| `finished` | `session_unread` | a root turn completed and settled (§1.2) |
| `stuck-thinking` | `degraded_thinking` | reasoning streaming beyond threshold |
| `runaway` | `degraded_runaway` | a non-task tool running beyond threshold |
| `stalled` | `degraded_stalled` | busy but silent beyond threshold (session-scoped) |
| `stalled` | `worker_down` | the worker's OpenCode itself died (daemon-level notice: empty sessionID/root, title "OpenCode") |

Android config: `priority: "HIGH"` for `waiting` (load-bearing: normal
priority is deferred by Android Doze and waiting-for-input must not be),
`"NORMAL"` otherwise; `collapse_key` = the `vh_event` value; `ttl` =
`"{notify.ttl_sec}s"`, default `86400s`.

### 3.4 Gating ladder

A notice reaches a given token only if ALL rungs pass, in order:

1. **Channel enabled** — config carries a loadable `notify` section AND the
   sender attached at daemon start.
2. **Active profile type filter** — the alerts profile's `types` list must
   include the event type (empty list = all types).
3. **Attendance** — if ANY device sent a presence heartbeat within
   `detect.idle_sec`, ALL pushes to ALL devices are suppressed (one attending
   device means the open app handles delivery; FCM is the away path).
4. **Per-(type, token) cooldown** — a second push of the same type to the
   same token within `detect.cooldown_sec` (shared knob with Web Push and
   webhook dispatch; separate map, keyed `type|tokenHash`) is suppressed.

### 3.5 Delivery hygiene

- **UNREGISTERED-evidence-gated pruning.** A token is deleted from the
  registry only when FCM answers 400 or 404 with explicit UNREGISTERED
  evidence in the error body: a `details[].errorCode == "UNREGISTERED"` entry
  or a top-level `error.status == "UNREGISTERED"`. A generic 404 NOT_FOUND
  (FCM's answer to sender-side misconfiguration, e.g. a wrong or deleted
  project ID) **retains** the token — pruning on it would mass-erase every
  valid registration.
- **401 → one forced token refresh + one retry**, then give up.
- **5xx → one cheap retry**, then give up.
- **No retry queue, no backoff loop.** All sends are best-effort per-token
  goroutines; a failure never blocks or breaks the rest of alerts.

### 3.6 Config section

`VH_STATE_DIR/alerts.jsonc`, top-level `notify` object (absent by default —
the channel is disabled and the probe reports `enabled:false`):

```jsonc
{
  "notify": {
    "credentials_file": "/path/to/service-account.json",
    "project_id": "my-fcm-project",   // optional; falls back to the credentials file's project_id
    "ttl_sec": 3600                   // optional; <=0 → 86400
  }
}
```

The credentials file is a Google service-account JSON (needs `project_id`,
`private_key` RSA PEM, `client_email`, `token_uri`). A load failure at init
leaves the channel silently disabled (`enabled:false`, upserts 503) without
affecting anything else in alerts. The alerts settings UI does not edit this
section; a UI save preserves it verbatim.

## 4. Confirmed interpretation behaviors (client-confirmed 2026-10-14)

These were ambiguous in v1 and are now settled by the client:

1. **503-before-400 when unconfigured:** the channel-unavailable check runs
   before body validation, so even a malformed body answers 503 while the
   channel is down.
2. **`lastId` is a highest-ever-allocated head pointer**, not the id of the
   newest returned event — it may exceed the max returned id after ring
   overflow.
3. **Forward paging is ascending from `since+1`, capped at `limit`** (then
   clamped at 200).
4. **Labels are truncated to 64 runes** (not bytes, not an error).
5. **Negative `since`/`limit` → 400;** `limit=0`/absent → 50.

## 5. Client reconciliation algorithm

Stated from the client's intent (so the semantics are documented, not
inferred from either implementation):

- Page forward with `since = <last event id actually received>`, one full
  page at a time, until a page's newest id equals the response's `lastId`.
- Only when fully caught up, persist `cursor = lastId`. A literal
  `since = lastId` after a limit-capped page would skip the capped middle —
  **never do that**.
- **Gap detection:** if a response's first returned id is greater than
  `cursor + 1`, events were evicted before receipt. History gaps are
  unrecoverable by design: drop incremental processing for that window and
  do a full fleet-status refresh instead.

## 6. Server implementation notes (contract-relevant)

- **Test notices are excluded from history:** `SendTest`
  (`POST /vh/alerts/test`) fires a synthetic notice at one webhook channel,
  bypassing the engine's fire path entirely — it never reaches history, the
  push channels, or the FCM sender.
- **Pruning protects against wrong-project config** (§3.5): generic/project
  NOT_FOUND retains registrations.
- **Runtime config asymmetry:** *disable* is immediate — dropping the
  `notify` section silences the sender mid-run and flips the probe to
  `enabled:false` on the next request. *Initial enable* and *changed
  credentials/project/TTL* require a daemon restart — the sender attaches
  only at `InitAlerts`, loading credentials/project/TTL at that moment.
  *Re-enable* is the exception: restoring the `notify` section while the
  original sender (attached at startup with its startup-loaded credentials)
  is still attached resumes the channel immediately — the per-notice gate
  and the probe re-read the live config — but with the startup-loaded
  values; a changed section still needs the restart. Section removal also
  reverts on the next restart.
- **Attendance suppression is channel-wide** (§3.4 rung 3): one attending
  device suppresses all pushes to all devices — identical to Web Push.
- **Ids are contiguous within the retention window**; eviction only removes
  the oldest end, and the persisted counter never regresses (ids are never
  reused across restarts).

## 7. Network path & controller route ownership (settled 2026-10-14)

### 7.1 Settled decision: V1 network path is direct-to-worker

The network path question is **settled** (confirmed by the client
`vh-agent-pulse`, 2026-10-14):

- **V1 network path: DIRECT-TO-WORKER.** The phone reaches the worker origin
  directly — LAN when on-network, plus the operator's existing tunnel/VPN to the
  worker host when off-LAN. Worker-local auth (session cookie + `X-VH-CSRF: 1`)
  as specced in §3.1.
- **No controller-mediated access in V1** → the server-side route-ownership /
  proxy change is **explicitly deferred**, not abandoned.
  - **Rationale:** FCM delivers independently of daemon reachability
    (Google → phone); the client's on-push flow degrades by design (render from
    payload; reconcile history/fleet when the worker is reachable;
    staleness-render otherwise) — a controller proxy buys nothing critical today.
- **Release posture confirmed:** Client confirmed untagged release is fine;
  they target integration against a tagged release when it exists. The contract
  is settled on both sides.

### 7.2 Controller route-ownership facts & future proxy conditions

`pkg/server/daemon.go` (`hostInterceptor`, ~lines 434–469 — the controller)
intercepts **every** `/vh/notify/*` request — including requests arriving on
a per-worker subdomain — and serves the controller's own pre-existing
notification handlers (the 2026-09-28 controller notify program: token CRUD
with masked ids, `/vh/notify/test`, controller-side history). Those handlers
are **NOT this contract**: a different surface, vocabulary, and storage.

Because V1 is direct-to-worker (LAN/VPN), this interception is a non-issue for
V1: worker daemon routes are accessed directly on the worker daemon origin,
which is how the integration test drives them.

**Future proxy conditions (if no-VPN off-LAN reconciliation is ever requested):**
If no-VPN off-LAN reconciliation is ever requested by the client, that will be
the scope, subject to two client-stated conditions:
1. **Partition integrity:** the proxy must not disturb the pre-existing
   controller notification surface (clean route-ownership partition;
   `pkg/server/daemon.go:434-469` stays intact).
2. **Auth compatibility:** auth must remain worker-compatible (cookie + CSRF
   semantics), else a client auth-mode extension is required.

**Rule:** Size and design the controller proxy **only when the client asks**.

## 8. Testing posture

Lane-1 unit tests (`pkg/alerts/notify_test.go`, `pkg/web/notify_feature_test.go`)
plus the lane-2 integration test
(`tests/integration/notify_lifecycle_test.go` — real `InitAlerts` wiring →
waiting-question notice through the real engine event path → mock-FCM receipt
+ history entry + probe) cover everything through mock FCM servers, including
the OAuth JWT flow, gating, cooldown, pruning, and cache boundaries. Real-FCM
end-to-end delivery is **out of scope for CI** — the same posture as Web
Push; a configuration smoke test against real FCM is an operator activity.
