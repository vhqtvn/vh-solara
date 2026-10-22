# Controller live state — `GET /vh/fleet/stream` (SSE)

The controller publishes the fleet-status rollup as a live Server-Sent
Events stream, so a foreground client (the companion phone app, a watch
bridge, a browser tab) holds ONE connection and receives each new rollup
generation as it is published — no polling loop, sub-second display after
the server's own detection cadence, and the plain
[`GET /vh/fleet/status`](#relationship-to-get-vhfleetstatus) stays available
as the conditional (ETag) fallback.

This guide also carries the companion **notification and history state**
contracts ([below](#notification-and-history-live-state-controller-hub-v4)) —
covering both the central v4 public notification routes (`/vh/notify/*`),
the legacy delivery history archive with its shared read cursor
(`/vh/admin/notify/*`), and the controller's dispatch enablement posture.

Everything in the stream section is the frozen Slice-1 contract (2026-09).
Authentication, cookies, CSRF, and error conventions are exactly those of
the rest of the `/vh/*` family: session-cookie auth (clean `401` when
unauthenticated), plain-text `http.Error` bodies, `X-VH-CSRF` only needed
on mutations (this is a GET — nothing to send).

## Wire contract

One held `GET https://$host/vh/fleet/stream` (also served when the request's
host is a per-worker subdomain — the stream is controller-owned). The
response is `200` with:

- `Content-Type: text/event-stream`
- `Cache-Control: private, no-cache, no-transform`
- `X-Accel-Buffering: no` (asks reverse proxies not to buffer)
- NO `ETag` — the held response is a stream, not a cacheable
  representation; the GET's ETag remains the conditional validator.

Frames (blank-line separated blocks):

```text
retry: 2000

event: fleet.status
data: <the EXACT compact fleet-status JSON body of one published generation>

event: ping
data: {}

```

- `retry: 2000` — sent once at connect; arms the client's native
  EventSource reconnect backoff (2s).
- `event: fleet.status` — the FULL current rollup JSON body, byte-for-byte
  the same body `GET /vh/fleet/status` serves for that generation. No
  deltas, no client-side reconciliation: replace your view with each frame.
- `event: ping` with `data: {}` — a keepalive sent roughly every 15s when
  nothing else flowed. Pings are NOT generations; ignore them for state.
- NO `id:` lines. Generated timestamps are not replay cursors; `Last-Event-ID`
  is ignored if sent.

## Latest-state semantics (what to render)

This is a **current-state stream, not a transition log**:

- The FIRST `fleet.status` frame is an unconditional validated snapshot of
  the current generation — the stream bootstraps itself; no prior GET
  needed.
- Intermediate generations may be SKIPPED. The server coalesces bursts: a
  client that reads slowly is never sent a backlog — it is woken once and
  served the newest validated generation. Always render the newest frame.
- Every delivered frame is a complete, self-consistent rollup. Replacing
  your entire view per frame is the intended (and simplest correct)
  consumption model.
- On reconnect you simply receive the current generation again. There is no
  replay buffer and no missed-event recovery — anything that happened while
  disconnected is reflected in the next full snapshot you receive.

Observation cadence: while any stream client is connected, the controller
refreshes the rollup on its own roughly every 15s via its subscriber-demand
loop (its generation TTL is 5s, so plain GET traffic refreshes it sooner;
the legacy fleet-condition watcher is retired). Expect on the order of
one frame per ~15s in a quiet fleet — each carries a new `generated_at` —
plus the 15s ping in gaps. Battery and radio behavior cannot be inferred
from byte counts; the intended client pattern is ONE connection per
foreground app instance, reconnect with backoff+jitter, and plain GET (or
nothing) while backgrounded. Do not promise indefinite Android background
SSE.

## Failure postures

| Condition | Behavior |
|---|---|
| Unauthenticated | clean `401` (plain text), no redirect — re-login, retry |
| Non-GET (`POST`, …) | `405` (`HEAD` is allowed and answers headers-only) |
| Stream at capacity (>16 concurrent subscribers daemon-wide) | plain-text `503` + `Retry-After: 5` BEFORE any stream headers — back off and retry |
| Bootstrap rollup cannot settle | plain-text `503` before headers; retry later |
| Write deadlines cannot be enforced through the deployment's middleware | refused (`503`) rather than streaming unbounded — fix the proxy/middleware, don't ignore this |
| Any failure AFTER the stream is committed | the connection simply CLOSES (no error text inside the stream). Reconnect per `retry:`; you get the current snapshot. Never parse trailing non-SSE bytes |

The server closes a connection whose writes stall (~10s budget) or whose
refresh machinery breaks; treat connection loss as "reconnect soon", not as
an error surface.

## Relationship to `GET /vh/fleet/status`

The GET endpoint is unchanged and remains the conditional fallback: same
generation cache, same ETag/`If-None-Match`/304 semantics, same body the
stream carries per frame. Suggested use: SSE while foregrounded; plain GET
with `If-None-Match` for one-shot bootstrap, backgrounded refresh, or
whenever SSE is impractical. If you switch from SSE back to GET, use the
last GET validator you hold or send none — never fabricate an ETag from a
stream frame's `generated_at`.

## Operator reverse-proxy notes

The stream is a long-lived, server-flushed response. In front of the
controller (nginx or similar):

- **Disable proxy buffering** for this location — `proxy_buffering off;`
  (the response's `X-Accel-Buffering: no` asks nginx politely, but an
  explicit location rule is the reliable form). A buffering proxy delays
  every frame until its buffer fills and can defeat sub-second updates
  entirely.
- **Set a read timeout comfortably above the heartbeat** — e.g.
  `proxy_read_timeout 60s;` — and do not enable anything that kills idle
  connections below ~30s. Note the server's own worst case: a pathological
  refresh can stall frames for up to ~30s while still healthy; 60s is the
  safe floor.
- **Check compression/CDN layers** do not buffer or transform event streams
  (`no-transform` is requested; `text/event-stream` should be excluded from
  gzip/br dynamic compression in the proxy).
- Header presence is not proof a deployed proxy honors flushing — after any
  proxy change, verify end-to-end frame latency from a real client.

WebSocket upgrade is NOT involved: the stream is plain HTTP/1.1 chunked
responses (and works over HTTP/2); no special upgrade headers are needed.

## Notification and history live state (controller-hub v4)

<a id="shared-history-read-cursor-slice-2"></a>

During the controller-hub notification cutover (S0–S5, commits
`56c7ccbf..565f5bbf`), Firebase Cloud Messaging (FCM) delivery and
notification history were centralized in the controller daemon. Workers
remain the sole detection authority (spooling notices durably with monotonic
`(epoch, seq)` coordinates), while the controller pulls private worker feeds,
commits events into a central transactional JSONL ledger, and delivers
FCM pushes.

For full architectural depth and design rationale, see:
- Canonical server contract: [`docs/architecture/notify-fcm.md`](../architecture/notify-fcm.md) (v4)
- Program execution record: [`docs/checkpoints/2026-10-22-notify-controller-hub.md`](../checkpoints/2026-10-22-notify-controller-hub.md)

### Route summary

All notification routes are controller-owned. The `/vh/notify/` prefix and
`/vh/admin/notify/` family prefix are carved out of the worker-subdomain reverse
proxy (`pkg/server/daemon.go`), so they answer consistently on every host
(controller root host and per-worker subdomains).

| Route | Method | Auth & CSRF | Purpose |
|---|---|---|---|
| `/vh/notify/history` | `GET` | Session cookie (CSRF-exempt) | Central public history from the transactional ledger (v4 shape) |
| `/vh/notify/tokens` | `POST` | Session cookie + `X-VH-CSRF: 1` | Register or refresh companion app FCM device token |
| `/vh/notify/tokens` | `GET` | Session cookie (CSRF-exempt) | Public channel probe (controller readiness & policy counts) |
| `/vh/admin/notify/tokens` | `GET` | Session cookie (CSRF-exempt) | Admin masked token list for management UI (`NotifyDialog`) |
| `/vh/admin/notify/tokens/{id}` | `PATCH` | Session cookie + `X-VH-CSRF: 1` | Update token label, push policy, or scope |
| `/vh/admin/notify/tokens/{id}` | `DELETE` | Session cookie + `X-VH-CSRF: 1` | Revoke a registered token (204 on success; 404 if already deleted) |
| `/vh/admin/notify/test` | `POST` | Session cookie + `X-VH-CSRF: 1` | Test-send an FCM push (`token` or `id`); 10s rate limit |
| `/vh/admin/notify/legacy-history` | `GET` | Session cookie (CSRF-exempt) | Read-only archive of pre-S5 watcher fleet-condition events |
| `/vh/admin/notify/legacy-history/read` | `POST` | Session cookie + `X-VH-CSRF: 1` | Advance global read cursor over the legacy archive ID namespace |

The worker→controller ingest feed (`GET /vh/internal/notify/feed` and `POST /vh/internal/notify/ack`) is **private**: guarded by per-process crypto-random bearer tokens negotiated over the yamux tunnel during registration, and denied on all public interfaces.

### Central public history — `GET /vh/notify/history`

`GET /vh/notify/history` serves committed notification events directly from
the controller's central transactional ledger (`<notify-store>.ledger`) in the
v4 public shape. It replaces the legacy watcher file previously served at this
URL.

Goldens: `pkg/server/testdata/notify_v4/history_response_v4.json` (complete
coverage) and `history_response_gaps.json` (source gaps).

```json
{
  "events": [
    {
      "id": 41,
      "type": "waiting",
      "sessionID": "ses_bason_1",
      "root": "ses_bason_1",
      "project": "/home/op/repo-alpha",
      "title": "Review requested",
      "detail": "Question pending",
      "ts": "1792454330000",
      "kind": "question_pending",
      "count": 1,
      "label": "bason — Review requested",
      "worker": { "id": "bason", "name": "bason" },
      "source": { "epoch": "bason-epoch-0007", "seq": 125 },
      "ui_url": "https://bason.example/app?session=ses_bason_1&dir=%2Fhome%2Fop%2Frepo-alpha"
    }
  ],
  "lastId": 41,
  "coverage": { "complete": true, "gaps": [] }
}
```

#### Event fields

- **Base fields (always present, never omitted):**
  - `id` (integer) — central ledger sequence ID (`1..head`), strictly contiguous in append order.
  - `type` (string) — high-level event type (`waiting`, `finished`, `session_started`, `stalled`). Daemon-level notices (e.g. OpenCode process exits) carry `type: "stalled"`, `title: "OpenCode"`, and empty strings for `sessionID`, `root`, and `project`.
  - `sessionID`, `root`, `project`, `title`, `detail` (strings).
- **V4 additive fields:**
  - `ts` (**decimal string of Unix epoch milliseconds**) — breaking type change from v3 (Position C) required by strict-typing in upstream client deserializers (e.g. `vh-agent-pulse` Kotlinx serialization).
  - `kind` (string) — condition vocabulary (`question_pending`, `permission_pending`, `session_unread`, `session_started`, `worker_down`, etc.).
  - `count` (integer) — collapsed notice count (`1` today).
  - `label` (string) — pre-rendered display label (`"<worker name> — <title>"`).
  - `worker` (`{"id": string, "name": string}`) — origin worker identity.
  - `source` (`{"epoch": string, "seq": integer}`) — origin worker durable spool coordinates.
  - `ui_url` (string) — deep link to origin worker's `/app` with `session` and `dir` query params. **The only field that may be absent**: omitted when no usable worker host pattern is configured on the controller.

#### Top-level response fields & paging

- `lastId` (integer) — committed global head pointer in the central ledger. Note that after prefix retention compaction, `lastId` can exceed the newest event returned in the page.
- `coverage` (`{"complete": bool, "gaps": [...]}`) — reports worker spool continuity. When source gaps occur (e.g. spool overflow or unreadable files), gaps are rendered as `{"source_id": string, "epoch": string, "from_seq": int, "to_seq": int}`. Holes are never fabricated into central ledger IDs.
- **Paging:**
  - `since > 0`: events with `id > since`, ascending (oldest-first), at most `limit` entries.
  - `since` omitted or `0`: the newest `limit` events, ascending.
  - `limit`: default `50`; values above `200` are clamped to `200`. Non-numeric or negative values return `400 {"ok":false,"error":"bad since"|"bad limit"}`.
- **Unread state is client-derived:** Unlike the legacy archive, the central v4 public history maintains **no server-side read cursor** (`read_id` and `unread_count` do not exist on this endpoint). The companion client stores the highest event ID it has rendered and compares it against `lastId` to compute local badge and unread counts.
- **Disabled posture:** When `--notify-store` is unset, answers `409` naming the flag.

### Public token registration & channel probe

#### `POST /vh/notify/tokens` — register / refresh device token

Enrolls or refreshes an FCM device token in the central registry (`<notify-store>`).

```json
{
  "token": "fcm-registration-token-string",
  "label": "Pixel 9 Pro",
  "push_policy": "when_unattended"
}
```

- `push_policy`: optional, either `"when_unattended"` (default) or `"always"`.
- **Full-state POST rule:** The request body represents the token's desired state. Re-submitting a token without `push_policy` **resets** it to `"when_unattended"`. Clients must send `push_policy` on every refresh.
- **Payload limit:** Request body strictly capped at 4 KiB (`DisallowUnknownFields`).
- **Response:** On success, returns `200 {"ok":true}`. Never echoes the token.
- **Refusals:**
  - `--notify-store` unset: `503 {"ok":false,"error":"notify unavailable"}` evaluated **before** body validation (honest channel-unavailable posture).
  - Empty token: `400 {"ok":false,"error":"token required"}`.
  - Invalid policy: `400 {"ok":false,"error":"invalid push_policy"}`.
  - Registry full (32 tokens): `400 {"ok":false,"error":"token limit reached"}`.
  - Missing CSRF: `403` plain text.

#### `GET /vh/notify/tokens` — channel probe

Public channel health probe. Never returns an error status (always `200 OK`).

Golden: `pkg/server/testdata/notify_v4/probe_response_v4.json`.

```json
{
  "enabled": true,
  "count": 1,
  "policies": {
    "when_unattended": 0,
    "always": 1
  },
  "last_attempt": "2026-10-22T14:30:00Z",
  "last_error": ""
}
```

- `enabled`: `true` iff the controller's central FCM sender is configured and ready (`--notify-store`, `--notify-fcm-credentials`, and `--notify-dispatch` all active). If `--notify-dispatch` is omitted or credentials are missing, returns `enabled: false`.
- `count`: total enrolled device tokens.
- `policies`: breakdown of token counts by policy (`when_unattended` vs `always`).
- `last_attempt` / `last_error`: timestamp and sanitized error from the central sender's latest completed dispatch attempt (success clears `last_error`).
- Token values and labels are never returned by any read endpoint.
- If `--notify-store` is unset, answers `200 OK` with `enabled: false, count: 0`.

### Legacy delivery history archive & read cursor

The pre-cutover push notification history (which recorded fleet-condition transitions emitted by the retired watcher) was relocated to the `/vh/admin/notify/*` namespace in S5. It remains preserved for operator inspection with its **own independent ID namespace**, completely separate from the central ledger.

#### `GET /vh/admin/notify/legacy-history`

Returns retained legacy events from `<notify-store>.history`. This file is **read-only** in production: no new entries are appended.

```json
{
  "schema": 1,
  "events": [
    {
      "id": 123,
      "ts": "2026-09-28T12:00:00Z",
      "kind": "permission_pending",
      "action": "appeared",
      "count": 2,
      "title": "vh-solara",
      "body": "2 permissions pending",
      "deliveries": [{ "token_id": "0011223344556677", "ok": true }]
    }
  ],
  "first_id": 118,
  "last_id": 123,
  "read_id": 100,
  "unread_count": 7
}
```

- `since` (default 0) and `limit` (default 50, max 200) query parameters supported.
- `read_id`: the operator's global read cursor over the legacy ID namespace.
- `unread_count`: retained events with `id > read_id` in the legacy 500-event window.
- Returns `409` naming `--notify-store` if unconfigured.

#### `POST /vh/admin/notify/legacy-history/read` — advance legacy read cursor

Advances the global read cursor for the legacy history archive. This was previously located at `POST /vh/notify/history/read` (now retired).

Body (strict JSON, exactly one field):

```json
{"id": 123}
```

- Requires session-cookie auth and `X-VH-CSRF: 1`.
- `id` must be a non-negative integer representing the highest legacy history ID seen.
- **Behaviors:**
  - `id` ≤ current cursor: `200` no-op echoing current state without disk write.
  - `id` > newest assigned legacy event ID: `400` naming the newest ID. Central ledger IDs cannot be used here.
  - Malformed body, unknown fields, or duplicate keys: `400`.
  - Case variants of `"id"` (e.g. `"ID"`, `"Id"`): `400` naming the key (strict decoded key match prevents `encoding/json` case-insensitive matching).
  - Success: returns `{"schema":1,"read_id":123,"unread_count":7}` after atomic persistence to `<notify-store>.history`.
  - Unconfigured: `409` naming `--notify-store`.

Key matching is on the **decoded** key, not the raw wire bytes: an
escape-encoded spelling that decodes to exactly `id` (e.g.
`{"\u0069d":123}`) is accepted as the same field, while any two members
decoding to `id` — including an escaped+exact mix like
`{"\u0069d":1,"id":2}` — count as duplicate keys (`400`).

The advance is forward-only and monotonic. Trimmed historical ids stay
valid watermarks — acknowledging an id that has already been trimmed
out of the 500-event window is fine.

### Admin token management & test send

All admin endpoints live under `/vh/admin/notify/*` and are protected by session-cookie auth. Mutations require `X-VH-CSRF: 1`.

- `GET /vh/admin/notify/tokens`: Returns masked token list for the operator `NotifyDialog`. Tokens display an ID, label, preview (first/last characters masked), creation/last seen timestamps, push policy, and scope (`{"schema":1,"tokens":[...]}`). Returns `409` if `--notify-store` is unset.
- `PATCH /vh/admin/notify/tokens/{id}`: Updates a token's label, push policy, or scope. Strict JSON decode. Returns `404` if the token ID is unknown, `409` if unconfigured.
- `DELETE /vh/admin/notify/tokens/{id}`: Revokes and removes the token from the central store (204 No Content on success; 404 if already deleted, not idempotent). Returns `409` if unconfigured.
- `POST /vh/admin/notify/test`: Dispatches a live test push through the controller's FCM transport. Accepts exactly one of `{"token":"..."}` or `{"id":"..."}`. Enforces a 10-second minimum interval between test sends daemon-wide (`429` if too frequent). Refusals: `409` naming `--notify-fcm-credentials` if credentials are not configured; when sending by id: `409` naming `--notify-store` if the registry is unconfigured, or `404` if the id is unknown.

### Rollout, enablement, and operator flags

Three controller daemon flags govern the notification subsystem:

```bash
# 1. Token registry and ledger base path (required for notify features)
--notify-store=/var/lib/vh-solara/notify.json

# 2. Google Firebase service account credentials (required for FCM dispatch)
--notify-fcm-credentials=/etc/vh-solara/fcm-creds.json

# 3. Central FCM dispatcher enablement (opt-in)
--notify-dispatch
```

#### Dispatcher is the sole delivery writer

With the retirement of the legacy fleet-condition watcher in S5, **the central dispatcher is the ONLY notification delivery writer**. A controller running without `--notify-dispatch`:
- Records ingested worker events into the central ledger and serves them via `GET /vh/notify/history`.
- Enrolls and manages companion app tokens via `POST /vh/notify/tokens` and `/vh/admin/notify/tokens`.
- Serves `GET /vh/notify/tokens` with `enabled: false`.
- **Delivers NO FCM push notifications**.

#### Safe rollout sequence

To avoid delivering pushes to stale or un-migrated device tokens:
1. **Deploy controller with `--notify-dispatch` OFF:** The controller starts ingesting notices and recording history. The token registry automatically performs backup-first migration to schema 2.
2. **Companion app reconnect:** Companion app (`vh-agent-pulse`) users perform a one-time **Log out → Connect** cycle. This re-registers the FCM token directly with the controller and resets the client-side history cursor to the new central ledger namespace.
3. **Enable `--notify-dispatch`:** Once tokens are enrolled, restart the controller with `--notify-dispatch` to begin active FCM push delivery.

#### Worker local FCM fencing

Workers running in controller mode (the default when `--controller` is non-empty) **automatically fence and disable worker-local FCM at boot**. Workers detect notices and write them to their local `SourceSpool`, waiting for the controller's pull loop. Standalone workers (started with `--controller ""`) retain worker-local FCM delivery.
