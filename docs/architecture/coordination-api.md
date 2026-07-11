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
    "last_assistant_empty": false,           // latest assistant turn produced no text/tool/file content (envelope only). tool-only turns are NON-empty (working). finish_reason can't tell empty from non-empty
    "subtree_busy": false,                    // any session in this subtree (incl. self) busy/retry
    "pending_question": false,                // a question awaits a TYPED reply (a plain message won't satisfy it)
    "pending_permission": false,
    "permission_blocked": false,            // OBSERVABLE FACT (not a policy): this session's fail-closed spawn policy auto-rejected a prompt. Sticky past the permission clearing; cleared on session termination. Implies the spawn carried permission_policy=fail_fast
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

### Unix-socket access (no TCP / no port discovery)

A worker can also serve the **same `/vh/*`** on an `AF_UNIX` socket, so a consumer
that can't reach the worker's loopback TCP port — a container with no host
networking, or to avoid auto-assigned `--web-port` discovery — bind-mounts the
socket and calls it with zero network:

- `vh-solara local-server --vh-sock /path/vh.sock`
- `vh-solara client-daemon --web vh --vh-sock /path/vh.sock`

Same handlers, same `X-VH-CSRF` + body verbs, same `X-VH-Epoch`/`X-VH-Seq`
headers; it's an extra listener alongside the TCP one. The socket is created
world-rw (`0666`) so a different-uid bind-mounted container process can reach it —
exposure equals the worker's existing no-auth loopback TCP, but local-machine
(file-system) only. Stale socket files are removed on start.

Clients: `curl --unix-socket /path/vh.sock http://localhost/vh/snapshot`, Python
`httpx` with a UDS transport, or our MCP server: `vh-solara mcp --sock
/path/vh.sock` (implies `--local`; dials `/vh/*` over the socket). No socket-path
convention is imposed — pick a path on a shared/bind-mounted volume and pass
`--vh-sock`.

The cross-worker controller API (`/api/workers/{id}/*`) is **not** affected: it's
host↔host over the tunnel, so loopback TCP is fine there. UDS solves only the
worker-direct / container-isolation case.

> **Bind-mount the socket's DIRECTORY, not the file.** On restart vh recreates the
> socket (new inode); a container that bind-mounted the file keeps the dead inode
> (connection refused until recreate). Mount the parent dir (e.g. `-v
> /run/vh-solara:/run/vh-solara`) and point clients at `<dir>/vh.sock`.

### Multi-project routing (one worker, many project dirs)

A worker's `/vh` server multiplexes **one aggregator per project directory** —
each with its **own store, epoch, and seq**. A logical session is owned by exactly
one project: **the `dir` it was created under**. Every `/vh/*` verb (snapshot,
stream, send, spawn, abort, answer-question, reply-permission, archive) resolves
its project from `?dir=<dir>` (or the `x-opencode-directory` header); omitting it
targets the **default** project (`""` = the worker's cwd).

So: **pass the same `?dir=` on every verb for a session.** Mismatched dir is a
silent footgun — spawn under `dir=X` then snapshot/abort with no dir hits the
empty default instance (the spawned session is invisible there, and abort/archive
ack as no-ops against an instance that doesn't own it).

Discover what's bridged (machine-readable, over the socket too):

```
GET /vh/projects → [{ "dir": "", "epoch": "ep-…", "seq": 6, "roots": 3 },
                    { "dir": "/work/alpha", "epoch": "ep-…", "seq": 2, "roots": 1 }, …]
```

Each entry is a live per-dir instance with its own `epoch`/`seq`; `roots` counts **root sessions only** (children + archived excluded), so `roots` minus the matching `GET /vh/running-sessions` workspace count is the idle-root count. Cross-machine
mirror: `GET /api/workers/{id}/projects`. Resolve your project dir → its entry,
then pin the watch loop's `(epoch, seq)` cursor to that instance — snapshot+stream
with that `?dir=` are scoped to that store, and the per-dir `epoch` lets a watcher
detect (and reject) ever flipping to a different project's instance mid-stream.
(To enumerate *all* opencode projects, not just the bridged ones, use the
`/oc/project` passthrough.)

### Read inventory verbs (`GET /vh/sessions`, `GET /vh/sessions/closeout`)

Two **HTTP-only** shaped GETs for a programmatic consumer to enumerate the session
fleet and read closeout text on demand, **without touching opencode's private
SQLite**. They wrap the existing opencode-client paths (`ListSessions` /
`ListArchivedSessions` / `Messages`) and shape the raw JSON into a stable,
vh-solara-owned schema (decoupling consumers from opencode's internal schema).
They are deliberately **not** in the MCP tool surface (V4) — the MCP facade is for
*driving* sessions; these reads are for fleet inventory. `?dir=<dir>` (or the
`x-opencode-directory` header) is required on both (same project pin as every
verb). See `pkg/web/sessions.go`.

**`GET /vh/sessions`** — flat fleet inventory:

```
GET /vh/sessions?dir=<dir>&include_archived=0|1&since=<ms>&roots_only=0|1
→ { "dir": "<dir>",
    "sessions": [
      { "id": "<sid>", "alias": "", "title": "<title>", "dir": "<dir>",
        "active": true, "parentID": null,
        "time": { "updated": 1719…, "created": 1719…, "archived": null } }
    ] }
```

- `include_archived` (default `0`): `1` also pulls archived sessions (merged,
  deduped by id). `active` is true iff `time.archived` is null/0; `parentID` is
  null for roots, string for children. (vh-solara treats both `null` and `0` as
  active for display; **OpenCode's own** authoritative model is strictly
  `time_archived IS NULL` — `0` is still archived in OpenCode. vh-solara
  unarchives by writing `NULL` directly, never `0`. See
  [`opencode-sqlite-unarchive.md`](opencode-sqlite-unarchive.md).)
- `since=<ms-epoch>`: recency cutoff — drops sessions whose latest of
  updated/created is older.
- `roots_only` (default `1`): `0` includes child/sub-sessions.
- Ordered by `time.updated` DESC (→ created → id). `alias` is `""` (no slug
  field is exposed by the pinned opencode version).
- **Empty/absent is never an error:** unknown dir or empty fleet → `200` +
  `sessions:[]`. Only a transport failure (opencode unreachable) → `502`
  (mirrors `/vh/archived`).

**`GET /vh/sessions/closeout`** — last assistant message text, batched:

```
GET /vh/sessions/closeout?dir=<dir>&id=a,b&id=c
→ { "dir": "<dir>",
    "closeouts": {
      "<sid_1>": { "present": true,  "text": "<FULL last assistant text>" },
      "<sid_2>": { "present": true,  "text": "" },
      "<sid_3>": { "present": false, "text": null }
    } }
```

- `id` accepts **repeatable** values AND **comma-lists** (forms may be mixed);
  ids are deduped and **every requested id appears as a key**.
- For each id: fetch messages, find the LAST assistant message (`role ==
  "assistant"`, latest by `time.created`, tie-break id DESC), concatenate its
  text parts (`type == "text"`, in order).
- Semantics: `present:true`+`text:"<…>"` = readable assistant message with text;
  `present:true`+`text:""` = assistant exists but no text parts;
  `present:false`+`text:null` = no readable assistant message / unreadable /
  unknown id. A per-id failure never fails the batch (maps to `present:false`);
  unknown dir → all `present:false`.
- **HR1 — never truncate:** the full last assistant text is returned. If a
  future hard server-side length limit is ever introduced it must surface as an
  explicit `truncated:true` flag + documented max, never a silent cut.

> **`/vh/sessions` vs `/vh/archived`**: both read archived sessions but serve
> different consumers. `/vh/sessions` is a **flat fleet INVENTORY** for
> programmatic consumers (shaped schema, server-side filtering). `/vh/archived`
> is the SPA's **paginated archived-TREE browser** (one level at a time, child
> counts, raw passthrough). Keep both.

## V2 — typed write verbs (worker `/vh/*`)

All POST, JSON body, behind the existing CSRF guard. Optional `idempotency_key`
in the body makes retries safe (the original response is replayed; a concurrent
duplicate gets `409`). TTL 10 min.

| Verb | Route | Body |
|------|-------|------|
| send-message | `POST /vh/send` | `{sessionID, text? \| parts?, agent?, model?, variant?, idempotency_key?}` → `{ok, sessionID, response, outcome}` |
| spawn | `POST /vh/spawn` | `{prompt? \| parts?, agent?, model?, title?, parentID?, idempotency_key?, permission_policy?}` → `{ok, sessionID, outcome}` |
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
- **unarchive is NOT an HTTP operation.** `POST /vh/archive` (archiving, with a
  finite timestamp) is a working HTTP `PATCH` and is unchanged. But OpenCode
  1.17.x **rejects** `PATCH /session/:id {"time":{"archived":null}}` with 400
  (the request schema is `Schema.optional(Schema.Finite)`, which rejects `null`),
  and there is no dedicated unarchive endpoint. vh-solara therefore unarchives
  (restores) by writing `time_archived = NULL` **directly** to OpenCode's SQLite
  DB. See [`opencode-sqlite-unarchive.md`](opencode-sqlite-unarchive.md)
  (validated against `opencode v1.17.14`) for the full coupling contract. The
  direct write emits no `session.updated` event; the worker re-hydrates after it.

### Result `outcome` (caller accounting)

The spawn and send result bodies carry a machine-readable `outcome` field so a
caller parsing the body (not headers) can classify the result for its accounting.
The fresh-vs-replayed distinction was previously available only via the
`X-VH-Idempotent-Replay` header; `outcome` puts it in the body.

Enum (all five defined for forward coherence; the current surface produces
`created`/`reused`/`prompt_retried_to_existing`/`refused`/`failed`):

| outcome | meaning | produced by |
|---------|---------|-------------|
| `created` | spawn minted a new session (counting) | spawn (fresh) |
| `reused` | an idempotency replay of a prior success; the side effect already happened | spawn/send (replay of `created`/`prompt_retried_to_existing`) |
| `prompt_retried_to_existing` | a prompt was delivered into an existing session | send (fresh) |
| `refused` | deterministic rejection BEFORE any side effect (no session minted, nothing widened) | spawn with an unknown/illegal `permission_policy` |
| `failed` | accepted but errored upstream (transient/retryable) | spawn/send (upstream error) |

**Accounting semantics:** ONLY `created` means a new session was minted
(counting). `reused` / `refused` / `failed` are non-counting. A caller
counts `created` and ignores the rest. On an idempotency replay, a success-class
fresh outcome (`created` / `prompt_retried_to_existing`) is rewritten to `reused`
in the cached body; a `failed` replay stays `failed` (the retryable signal is
preserved). The `X-VH-Idempotent-Replay: 1` header is unchanged (backward compat).

Result shapes:

```
spawn  created:                  {"ok":true, "sessionID":"...", "outcome":"created"}
spawn  replay:                   {"ok":true, "sessionID":"...", "outcome":"reused"}
spawn  create-ok-prompt-failed:  {"ok":false,"sessionID":"...","error":"...","outcome":"created"}
spawn  create-failed:            {"ok":false,"error":"...","outcome":"failed"}
spawn  refused-permission-policy:{"ok":false,"error":"unknown permission_policy: ...","outcome":"refused"}

send   fresh-delivered:          {"ok":true, "sessionID":"...","response":{...},"outcome":"prompt_retried_to_existing"}
send   replay:                   {"ok":true, "sessionID":"...","response":{...},"outcome":"reused"}
send   transport error:          {"ok":false,"error":"...","outcome":"failed"}
```

> `ok:false` + `outcome:"created"` = a session was minted but its first turn failed
> (outcome is the accounting/mint signal; ok is operational status). A minted session
> is counting regardless of whether its first turn completed, so this branch is
> `created`, never `failed` (which is reserved for the no-mint case).

In the MCP surface (V4), the outcome is also lifted into the tool result
`_meta.outcome` (alongside `epoch`/`seq`) so a structured client reads it without
parsing the text blob. Note `_meta.outcome` is a success-path structured hint
(mirroring the `_meta.epoch`/`_meta.seq` precedent): on the error path
(`toolError`), `outcome` is carried only in the text body, not in `_meta`.

### Fail-closed permission policy for unattended spawning (V2)

A spawned worker is often **unattended** — no human is watching to click "allow"
on a permission prompt. Without a policy, such a worker hangs on the first
prompt. The optional spawn body param `permission_policy` arms a **fail-closed**
watcher so a prompt can never block the worker:

- **`permission_policy: "fail_fast"`** (alias `"auto_reject"`): after the spawn
  mints, the worker registers the session as fail-closed. When that session
  later raises a permission prompt, the worker auto-issues
  `reply_permission(..., "reject")` **server-side** — never `"always"`, so the
  prompt cannot widen what the unattended worker is allowed to do. The spawn
  outcome **stays `created`** (the mint happened, the session is counted); a
  DISTINCT `permission_blocked` gate fact is raised on that session so the
  caller can observe the auto-reject post-hoc.
- **Absent/empty** = a normal spawn; no binding, no auto-reject.
- **Any other value** (e.g. a typo, or an attempted permissive value) is
  **refused BEFORE mint**: `outcome:"refused"`, `ok:false`,
  `error:"unknown permission_policy: ..."`, and the opencode session is NOT
  created. This is the **fail-closed property**: a spawner that passes garbage
  can, at worst, get a refusal or a more-restrictive session — never a wider
  grant. There is deliberately **no permissive value** (no `auto_allow`/`always`).

This is a **vh-solara concern only**: the param is not forwarded into opencode's
session-create payload (opencode has no equivalent single flag); vh-solara owns
the guarantee. The POLICY (the binding + the reject action) lives in the web
layer; the store only records the observable `permission_blocked` fact (see §1
gate facts), consistent with the store carrying no policy.

The auto-reject is delivered by a **per-directory reconcile sweep**, not a live
event-tail subscriber. The store's event fan-out is lossy on overflow (a slow
subscriber's channel is closed and the subscriber is dropped), so a subscriber-
based watcher could exit silently and never re-arm, defeating the guarantee with
no signal. Instead, a goroutine per project store reads the authoritative
`Snapshot` every `permReconcileInterval` (2s) and rejects any pending permission
for a fail_fast session. This makes fail-closed a **bounded-latency guarantee**
(≤2s) that rests on the deterministic sweep, not on event delivery — it holds
even if every live-tail event is lost. Rejecting a permission that was already
cleared is idempotent (the stale-reject error is swallowed/logged); `reject` is
never widened to `always`.

The binding is **in-memory only**. A worker restart loses it, so a `fail_fast`
session that hits a prompt *after* a restart is NOT auto-rejected. This is
acceptable because (a) such sessions are short-lived relative to worker uptime,
and (b) the caller already has a backstop: `pending_permission` exposes the
pending permission id on the gate, and the caller can reject it explicitly via
`reply_permission`. (Restart also resets the in-memory gate view regardless, so
no `permission_blocked` fact survives a restart.)

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
| GET | `/api/workers/{id}/projects` | `/vh/projects` (bridged per-dir instances) |
| GET | `/api/workers/{id}/skill/emit` | `/vh/skill/emit` (version-stamped client skill) |
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

## Client skill (`vh-solara skill`)

vh-solara owns the agent-facing "how to drive vh-solara" surface and emits it as a
**version-stamped, generated** skill so a consuming repo installs it rather than
hand-maintaining a copy that drifts:

- `vh-solara skill emit` — write the generated `SKILL.md` to stdout (diff / CI check)
- `vh-solara skill install --repo <path> [--out .opencode/skills/vh-solara]`
- `GET /vh/skill/emit` — the **same bytes over HTTP/socket** (no binary needed),
  `text/markdown` + an `X-VH-Skill-Version` header, generated from the **running
  daemon's** surface (so emit-version ≡ `/vh/version`). A consumer with no
  vh-solara binary drift-checks in-container: `curl --unix-socket … /vh/skill/emit`
  → `diff` against the committed `SKILL.md` + compare the header to the pinned
  version. Cross-machine mirror: `GET /api/workers/{id}/skill/emit`. Read-only;
  `install` (writing into a repo) stays a host CLI step.

The verb reference is generated from the **live MCP tool defs** and the gate-field
list is **reflected from `state.GateFacts`**, so neither can silently drift from
the binary; the contract sections (CAS, status buckets, cursors, UDS) are curated
and the header is stamped with the build `Version`. It's an engine-layer artifact
(vh-managed): commit it and re-run `skill install` (or fail CI on `skill emit |
diff`) on upgrade, or gitignore and regenerate. The consumer's policy overlay
stays separate and consumer-owned.

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
