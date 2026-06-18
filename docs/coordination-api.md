# vh-solara coordination API (workstream V)

Generic, policy-free mechanism for an external coordinator (e.g. controlplane) to
drive opencode sessions across machines. vh-solara reports raw opencode facts and
exposes read/write/subscribe verbs; **all "continue"/disposition/serialization
policy lives in the consumer**, never here.

See the §1 contract (the distributed-state invariants a driver must honor) in the
handoff thread; this doc tracks the implemented surface and decisions.

## Status

| Item | What | State |
|------|------|-------|
| V1 / A2 | `finish` reason + token usage materialized; per-session `gate{}` on every snapshot | ✅ done |
| V2 / A1 | Typed write verbs (send/spawn/abort/answer-question/reply-permission) + idempotency + If-Idle-Seq CAS | ✅ done |
| V3 / A3 | `/api/workers/{id}/*` cross-worker API through registry+tunnel; epoch+seq; bearer auth | ✅ done |
| V4 / A4 | MCP facade over the read+write verbs | ✅ done |
| V5 / B  | `Feature`/`Services` module mechanism; refactor V1–V4 into the first module | ⏳ |
| V6 / C  | two-layer kit provisioning (`controlplane-core` + `controlplane-policy`) | ⏳ |

## V1 — gate facts (worker `/vh/*`)

`GET /vh/snapshot` and the `snapshot` event on `GET /vh/stream` now carry a
per-session `gate` map (keyed by sessionID):

```jsonc
"gate": {
  "<sessionID>": {
    "activity": "idle|busy|retry|error",
    "last_assistant_completed": true,        // latest assistant turn has time.completed
    "finish_reason": "stop|length|tool-calls", // raw opencode `finish`; omitted if none/in-flight
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
double-write race. Reply verbs are naturally CAS-on-request-id (a cleared
question/permission errors upstream), so they take no `If-Idle-Seq`.

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

A stdio MCP server (newline-delimited JSON-RPC 2.0) that an opencode agent can
launch as a `type: local` MCP server. It is an **HTTP client of the coordination
API** (`--base-url` / `VH_CONTROLLER_URL`, `--token` / `VH_API_TOKEN`,
`--worker` default), so one MCP server drives any worker. Tools mirror the verbs:

`list_workers`, `list_sessions`, `get_session`, `send_message` (with
`if_idle_seq` CAS), `spawn_session`, `abort_session`, `answer_question`,
`reply_permission`, `archive_session`.

- Non-2xx upstream → an MCP tool error (`isError`) carrying the message, not a
  transport failure.
- Successful results attach `_meta.{epoch,seq}` from the worker's response
  headers, so an agent can track the cursor.
- Events stay on SSE (`/api/workers/{id}/events`); MCP is request/response, so
  the reflex loop owns the stream.

Example opencode `opencode.json`:
```jsonc
{ "mcp": { "vh-solara": {
  "type": "local",
  "command": ["vh-solara", "mcp", "--base-url", "https://ctrl.example", "--worker", "w1"],
  "environment": { "VH_API_TOKEN": "..." }
} } }
```

## Decisions (generic-mechanism-only)

- Verbs are body-addressed under `/vh/*` for consistency with `/vh/archive`; the
  cross-worker API (V3) maps REST paths onto them.
- Idempotency is an in-memory TTL cache + in-flight guard. Not durable across a
  daemon restart (matches the per-worker-lifetime epoch model — V3).
- `finish_reason` is raw passthrough (no normalized enum), per the agreed line.
