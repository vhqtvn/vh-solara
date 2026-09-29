# Controller live state — `GET /vh/fleet/stream` (SSE)

The controller publishes the fleet-status rollup as a live Server-Sent
Events stream, so a foreground client (the companion phone app, a watch
bridge, a browser tab) holds ONE connection and receives each new rollup
generation as it is published — no polling loop, sub-second display after
the server's own detection cadence, and the plain
[`GET /vh/fleet/status`](#relationship-to-get-vhfleetstatus) stays available
as the conditional (ETag) fallback.

Everything below is the frozen Slice-1 contract (2026-09). Authentication,
cookies, CSRF, and error conventions are exactly those of the rest of the
`/vh/*` family: session-cookie auth (clean `401` when unauthenticated),
plain-text `http.Error` bodies, `X-VH-CSRF` only needed on mutations (this
is a GET — nothing to send).

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
refreshes the rollup on its own roughly every 15s (its generation TTL is
5s, so plain GET traffic or the notification watcher's sampling refreshes
it sooner). Expect on the order of one frame per ~15s in a quiet fleet —
each carries a new `generated_at` — plus the 15s ping in gaps. Battery and
radio behavior cannot be inferred from byte counts; the intended client
pattern is ONE connection per foreground app instance, reconnect with
backoff+jitter, and plain GET (or nothing) while backgrounded. Do not
promise indefinite Android background SSE.

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
