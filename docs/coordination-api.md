# vh-solara coordination API (workstream V)

Generic, policy-free mechanism for an external coordinator to
drive opencode sessions across machines. vh-solara reports raw opencode facts and
exposes read/write/subscribe verbs; **all "continue"/disposition/serialization
policy lives in the consumer**, never here.

See the §1 contract (the distributed-state invariants a driver must honor) in the
handoff thread; this doc tracks the implemented surface and decisions.

> **Worker prerequisite:** the coordination API lives on vh-solara's own web
> server, which a worker runs only in `--web vh` mode (`cmd/client-daemon.go`).
> The other modes (`opencode`, `openchamber`) serve a different UI on the proxied
> port and expose no `/vh/*`. No OpenChamber dependency anywhere in this stack.
> The worker's web port is `--web-port` (auto-assigned if unset; pin it for a
> stable local-MCP base-url). The legacy `--chamber-port` flag and the
> OpenChamber-era `ChamberPort`/`HandleChamberDirect` names were renamed to
> `--web-port` / `WebPort` / `HandleWorkerDirect` (a deprecated `--chamber-port`
> alias remains); only the genuine `--web openchamber` mode keeps its name.

## Status

| Item | What | State |
|------|------|-------|
| V1 / A2 | `finish` reason + token usage materialized; per-session `gate{}` on every snapshot | ✅ done |
| V2 / A1 | Typed write verbs (send/spawn/abort/answer-question/reply-permission) + idempotency + If-Idle-Seq CAS | ✅ done |
| V3 / A3 | `/api/workers/{id}/*` cross-worker API through registry+tunnel; epoch+seq; bearer auth | ✅ done |
| V4 / A4 | MCP facade over the read+write verbs | ✅ done |
| V5 / B  | `Feature`/`Services` module mechanism; coordination verbs as the first module | ✅ done |
| V6 / C  | two-layer kit provisioning (engine + overlay layers) | ✅ done |

## V1 — gate facts (worker `/vh/*`)

`GET /vh/snapshot` and the `snapshot` event on `GET /vh/stream` now carry a
per-session `gate` map (keyed by sessionID):

```jsonc
"gate": {
  "<sessionID>": {
    "activity": "idle|busy|retry|error",
    "hydrated": true,                        // message state loaded (live OR history); see note
    "last_assistant_completed": true,        // latest assistant turn has time.completed (authoritative iff hydrated)
    "finish_reason": "stop|length|tool-calls", // raw opencode `finish` (authoritative iff hydrated); omitted if none/in-flight
    "subtree_busy": false,                    // any session in this subtree (incl. self) busy/retry
    "pending_question": false,                // a question awaits a TYPED reply (a plain message won't satisfy it)
    "pending_permission": false,
    "tokens": { "input": 0, "output": 0, "total": 0, "cache": {"read":0,"write":0} } // raw usage; omitted if none
  }
}
```

- The opencode field is **`finish`** (not `finish_reason`/`finishReason`); values
  `stop|length|tool-calls`, present iff `time.completed` is set. We pass the value
  through raw under the gate key `finish_reason`.
- It's denormalized onto the session so it rides the **tree-only** list snapshot —
  no message-history hydration, no N+1 detail fetch.
- `subtree_busy` mirrors the frontend's `sessionWorking`/`descendantWorking`
  definition of a live session.
- **`hydrated`**: after a daemon restart (new `epoch`), an idle, never-opened
  session has no message state yet, so `last_assistant_completed=false` /
  `finish_reason=""` mean **"not yet known", not "in-flight"**. `hydrated=false`
  flags exactly that case — force-hydrate (open) the session, or trust
  `activity`, before relying on the message-derived fields (§1.7).

The §1.1 send gate = `activity == idle && !subtree_busy && last_assistant_completed
&& !pending_question && !pending_permission` — all readable from one snapshot.

## V2 — typed write verbs (worker `/vh/*`)

All POST, JSON body, behind the existing CSRF guard. Optional `idempotency_key`
in the body makes retries safe (the original response is replayed; a concurrent
duplicate gets `409`). TTL 10 min.

| Verb | Route | Body |
|------|-------|------|
| send-message | `POST /vh/send` | `{sessionID, text? \| parts?, agent?, model?, variant?, idempotency_key?}` |
| spawn | `POST /vh/spawn` | `{prompt? \| parts?, agent?, model?, title?, parentID?, idempotency_key?}` → `{ok, sessionID}` |
| abort | `POST /vh/abort` | `{sessionID, idempotency_key?}` |
| answer-question | `POST /vh/answer-question` | `{questionID, answers, idempotency_key?}` |
| reply-permission | `POST /vh/reply-permission` | `{permissionID, sessionID?, reply: once\|always\|reject, idempotency_key?}` |
| archive | `POST /vh/archive` (pre-existing) | `{sessionID}` |

Mapped to opencode: send→`/session/:id/prompt_async` (returns immediately),
spawn→`POST /session` then prompt, abort→`/session/:id/abort`,
answer→`/question/:id/reply`, permission→`/permission/:id/reply` (legacy
`/session/:sid/permissions/:id` fallback when `sessionID` is given).

### CAS — `If-Idle-Seq` (send only)

Header `If-Idle-Seq: <seq>` on `/vh/send`. The send is accepted **only if** the
session is still sendable (§1.1 gate) **and** its activity hasn't changed since
the given snapshot seq; else `409`. Without the header, no CAS — the caller owns
send-when-idle discipline (§1.8); CAS is the opt-in safety net against the
double-write race.

**Contract:** the consumer passes the **global snapshot `seq`** it last observed
the session sendable at. The server compares it to that session's
**`activitySeq`** — the seq at which the session's activity last changed — and
rejects (`409`) if `activitySeq > provided` (a turn started/finished in the gap)
or the session isn't currently sendable. So a stale-but-still-idle session (a new
turn completed since you looked) is correctly rejected, not double-driven.

### Verb status mapping (request-id CAS, §5)

A non-2xx from opencode is **propagated**, not masked as `502`: a `4xx` becomes
that client status, and for `answer-question`/`reply-permission` a `404` (the
request is no longer pending) maps to **`410 Gone`** — so a coordinator
distinguishes "already handled" from a real gateway failure. Only transport
errors and upstream `5xx` are `502`. `reply-permission`'s legacy-route fallback
fires **only** when the canonical route looks absent (transport error / `404` /
`405`); a meaningful canonical `4xx` (e.g. `400` bad reply) is returned as-is.
Reply verbs are naturally CAS-on-request-id, so they take no `If-Idle-Seq`.

### Caveats baked into the contract

- **abort is async** — the resulting idle arrives on the event stream later; do
  not send-after-abort synchronously (use CAS or wait for the idle transition).
- **archive removes the session from the live view** — archive only a
  confirmed-done session.

## V3 — cross-worker API (controller `/api/workers/{id}/*`)

Path-addressed, proxied through the existing registry+tunnel to the worker's
local `/vh/*` (V1/V2). Bearer-gated (`--api-token` / `VH_API_TOKEN`), **outside**
the session-auth edge — the coordinator is headless.

| Method | Route | → worker |
|--------|-------|----------|
| GET | `/api/workers/{id}/sessions` | `/vh/snapshot` (carry `?sessions=`) |
| GET | `/api/workers/{id}/sessions/{sid}` | `/vh/snapshot?sessions={sid}` |
| POST | `/api/workers/{id}/sessions` | `/vh/spawn` |
| POST | `/api/workers/{id}/sessions/{sid}/message` | `/vh/send` (+`If-Idle-Seq` passthrough) |
| DELETE | `/api/workers/{id}/sessions/{sid}` | `/vh/abort` |
| POST | `/api/workers/{id}/sessions/{sid}/archive` | `/vh/archive` |
| POST | `/api/workers/{id}/sessions/{sid}/questions/{qid}` | `/vh/answer-question` |
| POST | `/api/workers/{id}/sessions/{sid}/permissions/{pid}` | `/vh/reply-permission` |
| GET | `/api/workers/{id}/events` | `/vh/stream` (SSE; `?cursor=`/`Last-Event-ID`) |

- **epoch + seq**: the worker stamps `X-VH-Epoch` / `X-VH-Seq` on every `/vh/*`
  response (and `epoch` is in the snapshot JSON); the controller passes them
  through. Cursor tuple = `(worker_id, epoch, seq)`; re-snapshot on epoch change.
- `?dir=` selects a project on the worker (carried through).
- Unknown worker → `404`; offline → `502` (fail fast).
- Auth: `Authorization: Bearer <token>`; empty token = open (only safe on a
  protected edge).

## V4 — MCP facade (`vh-solara mcp`)

A stdio MCP server (newline-delimited JSON-RPC 2.0) that an opencode agent
launches as a `type: local` MCP server. **Two modes:**

- **`--local` (recommended for an agent on the worker machine):** drive the local
  `--web vh` server's `/vh/*` directly — loopback, no controller, no bearer, no
  tunnel. This is the common case (an agent driving its *own* sessions) and works
  identically in both deployments: `local-server` (vh at e.g. `:7700`) and
  `client-daemon --web vh` (the worker's local `--web-port`). It is **immune to
  the tunnel-proxy smuggling path** — there is no hijacking proxy in front of a
  direct `/vh/*` server. Default base-url `http://127.0.0.1:7700`.
- **controller (default):** HTTP client of the coordination API (`--base-url` /
  `VH_CONTROLLER_URL`, `--token` / `VH_API_TOKEN`, `--worker`), so one MCP server
  drives *any* machine's worker — the cross-machine coordinator case.

Tools mirror the verbs (same names in both modes; in `--local`, `worker` is
ignored and verbs are body-addressed to `/vh/*` with the CSRF header):

`list_workers`, `list_sessions`, `get_session`, `send_message` (with
`if_idle_seq` CAS), `spawn_session`, `abort_session`, `answer_question`,
`reply_permission`, `archive_session`.

- Non-2xx upstream → an MCP tool error (`isError`) carrying the message, not a
  transport failure.
- Successful results attach `_meta.{epoch,seq}` from the worker's response
  headers, so an agent can track the cursor.
- Events stay on SSE (`/api/workers/{id}/events`); MCP is request/response, so
  the event-stream subscriber owns the stream.

Example opencode `opencode.json`:
```jsonc
{ "mcp": { "vh-solara": {
  "type": "local",
  "command": ["vh-solara", "mcp", "--base-url", "https://ctrl.example", "--worker", "w1"],
  "environment": { "VH_API_TOKEN": "..." }
} } }
```

## V5 — Feature/Services module mechanism

A `Feature` registers HTTP routes on the worker server without core knowing about
it; the server walks its registry at startup (`mountFeatures`). The coordination
verbs (V2) are refactored into `coordinationFeature` — the first module (dogfood).

```go
type Feature interface {
    Name() string
    Routes(Services) map[string]http.HandlerFunc
}
```

`Services` is the narrow boundary a module gets: `Agg(dir)` (→ store read +
opencode write client), `ReqDir(r)`, and `WithIdempotency(...)`. **No** tunnel,
auth internals, or other features' state. Add a module with
`server.RegisterFeature(f)` before `Handler()`.

**Scope decision:** V1 (gate facts) stays in core — it's the store's data model,
not a route surface. V3 (controller proxy) and V4 (MCP) live in their own
packages/process; the module system is the worker server's route-composition
mechanism, which is where "add a capability without editing core" actually
applies. In-process modules call shared helpers directly; the `Services` surface
is what an out-of-package module needs.

## V6 — kit provisioning (`vh-solara kit`)

vh-solara provisions a versioned template kit into a repo; it ships **zero kit
content** (kits are authored by the consumer).

- `vh-solara kit install <kit-dir> --repo <path> --param k=v ...`
- `vh-solara kit status --repo <path>`

A kit = a directory with `manifest.json` + per-layer source dirs. Two layer types:

| type | semantics on (re)install |
|------|---------------------------|
| `engine` (e.g. `<kit>-core`) | vh-managed: **overwritten** on update, unless the existing file carries a `vh:keep` marker |
| `overlay` (e.g. `<kit>-policy`) | consumer-owned: **never clobbered** — an existing overlay file is preserved |

- Parameters are declared in the manifest and injected into template files via
  `{{vh:name}}` placeholders. Required params are enforced; an undeclared param or
  an undeclared placeholder is an error. `"secret": true` params are used but not
  recorded in the lockfile.
- A `.vh-kit.json` lockfile in the repo records kit/version/installed-files/
  non-secret params for idempotent re-install and `status`.

Manifest:
```jsonc
{
  "name": "example-kit", "version": "1.0.0",
  "parameters": [
    {"name": "controller_url", "required": true},
    {"name": "worker_id", "default": "w1"},
    {"name": "api_token", "secret": true}
  ],
  "layers": [
    {"name": "engine-core",   "type": "engine",  "source": "core"},
    {"name": "engine-policy", "type": "overlay", "source": "policy"}
  ]
}
```

## Testing

Each feature has package unit tests (state/web/server/mcp/kit). The cross-machine
path is proven end-to-end by a **reusable Go harness** at `tests/e2e/` that stands
up a real controller + a real worker over an actual **yamux tunnel** + a fake
OpenCode (`pkg/fixtures`) — no docker, no opencode binary, no LLM:

```
go test ./tests/e2e/
```

`e2e.StartCluster()` is importable so other components can drive the same real
stack. It covers, over the tunnel: V1 gate facts + epoch header, V3 bearer/auth +
worker resolution, V2 spawn/send/abort + idempotency, V4 MCP tool calls, and a
connection-smuggling regression. UI coverage stays in the Playwright lane
(`web/tests/e2e`); the docker lane (`tests/e2e-docker`) runs a real opencode.

> **Proxy note (fixed):** the controller raw-proxy hijacks the inbound
> connection, so coordination requests are forwarded with `Connection: close` —
> otherwise a keep-alive client pools the still-hijacked connection and smuggles
> its next request straight down the tunnel, bypassing the router. Caught by the
> e2e MCP test.

## Decisions (generic-mechanism-only)

- Verbs are body-addressed under `/vh/*` for consistency with `/vh/archive`; the
  cross-worker API (V3) maps REST paths onto them.
- Idempotency is an in-memory TTL cache + in-flight guard. Not durable across a
  daemon restart (matches the per-worker-lifetime epoch model — V3).
- `finish_reason` is raw passthrough (no normalized enum), per the agreed line.
