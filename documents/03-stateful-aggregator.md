# Stateful Aggregator & Sync Protocol

## Why

OpenCode's HTTP API is the source of truth, but its event stream (`GET /event`) is a
**live tail with no replay**. A phone client constantly backgrounds, sleeps, and drops
its socket; on reconnect a naive client either shows stale state forever or nukes and
refetches from scratch (losing scroll position and the in-flight streaming session).
Both `opencode web` and OpenChamber fall into the second trap — one drops the rendering
session, the other drops the session tree.

The fix: move authoritative UI state into the **daemon**, which holds a persistent
OpenCode subscription independent of any client, and expose a **client-agnostic
snapshot/resume protocol** that web and a future native app both consume. The daemon
does the heavy lifting once; clients stay thin and resume instantly.

## Roles

```
opencode serve (API, source of truth)
        ▲  persistent /event SSE + REST hydration (daemon owns this, never per-client)
        │
   vh daemon  ──  materialized view + monotonic event log (ring buffer)
        ▲  snapshot + resumable stream over the existing yamux tunnel
        │
   controller (dumb router, unchanged)
        ▲
   clients (web now, native later) — thin, hydrate from disk then resync the delta
```

The controller and tunnel are unchanged: the daemon serves HTTP on `chamberPort`, which
the controller raw-proxies as today.

## Daemon-side: schema-light materialized view

The daemon tracks **ids and structure**, not OpenCode's full schema. Message, part, and
session payloads are stored as opaque `json.RawMessage`; only envelope fields needed for
structure are parsed. The client (which has the SDK types) interprets payloads. This keeps
the daemon resilient to OpenCode schema drift.

View contents:

- **Sessions**: `map[sessionID] -> { info: raw, parentID, title, updatedAt, status }`.
  The tree is derived from `parentID` (subsessions are first-class via
  `GET /session/:id/children`, not scraped from the message stream).
- **Messages** (per session): ordered `[]{ messageID, info: raw, parts: ordered raw }`.
- **Per-session extras**: latest `todo`, pending `permissions`, last `diff` summary,
  status (idle/working/error).

## The event log

Every change the daemon applies produces a client-facing event stamped with a **monotonic
`seq`** (uint64, per daemon process lifetime). Events are kept in a bounded ring buffer
(last N events / few minutes). Each client-facing event:

```json
{ "seq": 1234, "kind": "session.upsert|session.delete|message.upsert|message.delete|
                         part.upsert|part.delete|todo|permission|status|...",
  "payload": { ... raw OpenCode payload, untouched ... } }
```

`seq` is the daemon's own counter — OpenCode's event ids are ignored for resumption,
because OpenCode itself is not resumable.

## Protocol

### `GET /vh/snapshot`
Returns the full current view plus the current head `seq`:
```json
{ "seq": 1234, "sessions": [...], "messages": { "<sessionID>": [...] }, ... }
```
A fresh client (or one whose cursor is too old) starts here.

### `GET /vh/stream?cursor=<seq>`
Resumable SSE. Emits `id: <seq>` on every event so a client can track its cursor.

- **cursor present and within the buffer** → replay `cursor+1 .. head`, then live-tail.
  No flicker, nothing lost.
- **cursor missing or older than the buffer's oldest seq** → emit one `snapshot` event
  (full view + head seq), then live-tail. Client **reconciles** against local state
  rather than discarding it.

The transport is a fetch-based SSE reader on the client (not raw `EventSource`) so it can
set auth headers and control reconnect/backoff itself.

### Writes
Write operations (prompt, abort, create, fork, command, permission reply, …) are
reverse-proxied straight through to local `opencode serve`. The daemon does not model
them; their effects come back through the event stream like everything else.

## Daemon re-hydration (its own reconnect to OpenCode)

Because OpenCode's stream has no replay, when the daemon's `/event` connection drops:

1. Reconnect with backoff.
2. Re-fetch full state: `GET /session`, then `children` + `message` for sessions clients
   care about.
3. Diff against the existing view; emit upsert/delete events (with new seqs) for what
   changed.
4. Resume the live tail.

Clients never see this churn beyond normal events — their resume logic is identical
whether the daemon stayed up or re-hydrated.

## Client responsibilities (web + native)

1. Persist the last view + cursor to local storage (IndexedDB on web).
2. On open: hydrate UI instantly from disk (no blank screen), then connect
   `/vh/stream?cursor=<saved>` and reconcile the delta.
3. Reconnect proactively on `visibilitychange → visible` and `online` (mandatory on iOS,
   which suspends background sockets) rather than waiting for a dead socket to time out.
4. Reconcile, never nuke: apply upserts/deletes onto existing state by id.

## Scope notes

- **Single workspace for v1.** `opencode serve` resolves directory from its cwd; the
  daemon runs one workspace. Multi-project (querying `?directory=` per project) is later.
- **Rendering** (markdown/highlight/diff → HTML) is a separate server-side concern layered
  on top of the view; see the rendering pipeline doc. The view stores raw payloads; the
  render layer can cache rendered HTML keyed by part id + content hash.
</content>
</invoke>
