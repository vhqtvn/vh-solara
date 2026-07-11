# OpenCode unarchive via PATCH `/session/:id` — contradiction audit

> Source packet. Read-only study of `sst/opencode` tag **v1.17.14** (latest release,
> Jul 6 2026) and current `master`. No vh-solara code or tests were executed.
>
> NOTE: Promoted from `tmp/agent-runs/researcher/` to
> `researches/sources/opencode-unarchive-patch-audit.md`.

## Research question

Does real OpenCode clear `time.archived` when a client sends
`PATCH /session/:id` with body `{"time":{"archived":null}}`?

**Verdict (one line): backend is INCORRECT.** Real OpenCode 1.17.x does NOT clear
the archive on that request — the payload fails the request schema
(`archived` is `Schema.optional(Schema.Finite)`; JSON `null` is not a finite
number) and the server returns **400 BadRequest** before the handler runs. The
session stays archived. There is **no alternative HTTP endpoint** to unarchive;
the instance `/session` list has no `archived` filter either.

Primary-question answer: **option (c) — but worse than "different mechanism":
there is currently NO supported HTTP mechanism to unarchive in 1.17.x.**

---

## 1. VERDICT

**Backend correctness: INCORRECT.**

`PATCH /session/:id {"time":{"archived":null}}` does not unarchive against real
OpenCode 1.17.x. It returns **400 BadRequest** (schema decode failure). The
vh-solara fixture (`pkg/fixtures/opencode.go`) models `null` as "clear", which
diverges from real OpenCode and hid this bug from the e2e suite.

---

## 2. EVIDENCE (upstream code, v1.17.14)

All paths permalinked at tag `v1.17.14`.

### 2a. Request schema — `archived` is NOT nullable

`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
https://github.com/sst/opencode/blob/v1.17.14/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts

```ts
import { Schema, Struct } from "effect"
// ...
export const UpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Session.Metadata),
  permission: Schema.optional(PermissionV1.Ruleset),
  time: Schema.optional(
    Schema.Struct({
      archived: Schema.optional(Session.ArchivedTimestamp),   // <-- plain optional, NOT NullOr
    }),
  ),
})
```

The endpoint is standard (schema-validated, NOT raw):

```ts
HttpApiEndpoint.patch("update", SessionPaths.update, {   // SessionPaths.update = "/session/:sessionID"
  params: { sessionID: SessionID },
  query: WorkspaceRoutingQuery,
  payload: UpdatePayload,
  success: described(Session.Info, "Successfully updated session"),
  error: [HttpApiError.BadRequest, ApiNotFoundError],
})
```

`Session.ArchivedTimestamp` is defined in
`packages/opencode/src/session/session.ts`
https://github.com/sst/opencode/blob/v1.17.14/packages/opencode/src/session/session.ts :

```ts
// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite          // a finite NUMBER — not nullable
```

**Effect schema semantics (definitive):** `Schema.optional(S)` (effect's native
optional) means the *key* may be absent (-> `undefined`); if the key is *present*,
the value is decoded by `S`. It does NOT map present-`null` to `undefined`.
`Schema.Finite` rejects `null`. So `{"time":{"archived":null}}` ->
`Schema.Finite.decode(null)` -> **ParseError**.

Internal corroboration: the *event* schema `SessionV1.Event.UpdatedTime`
separately uses `Schema.optional(Schema.NullOr(ArchivedTimestamp))` (accepts
null). The fact that the event path wraps with `NullOr` while the request path
does not is direct evidence that plain `optional` does not accept null —
otherwise `NullOr` would be redundant.

### 2b. Handler — `null` can never reach `setArchived` via PATCH

`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
https://github.com/sst/opencode/blob/v1.17.14/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts

```ts
const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: typeof UpdatePayload.Type
}) {
  const current = yield* requireSession(ctx.params.sessionID)
  if (ctx.payload.title !== undefined)       { yield* session.setTitle(...) }
  if (ctx.payload.metadata !== undefined)    { yield* session.setMetadata(...) }
  if (ctx.payload.permission !== undefined)  { yield* session.setPermission(...) }
  if (ctx.payload.time?.archived !== undefined) {                            // <-- guard
    yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
  }
  return yield* requireSession(ctx.params.sessionID)
})
```

Registered with standard (schema-decoded) handling — confirming the `UpdatePayload`
decode runs first and a parse failure becomes a 400 before this body executes:

```ts
return handlers
  // ...
  .handle("update", update)      // NOT .handleRaw — payload is schema-validated
```

### 2c. Service layer — clearing requires `time: undefined`, which PATCH cannot deliver

`packages/opencode/src/session/session.ts`:

```ts
const setArchived = Effect.fn("Session.setArchived")(function*(input: { sessionID, time?: number }) {
  yield* patch(input.sessionID, { time: { archived: input.time } }).pipe(Effect.orDie)
})

const patch = (sessionID, info: Patch) => Effect.gen(function* () {
  const current = yield* get(sessionID)
  const next = { ...current, ...info,
    time: info.time ? { ...current.time, ...info.time } : current.time, /* ... */ }
  yield* events.publish(SessionV1.Event.Updated, { sessionID, info: next })   // -> projector -> DB
})
```

- `setArchived({ time: V })` sets `next.time.archived = V`. To CLEAR (DB
  `time_archived = NULL`), `V` must be `undefined`.
- But the HTTP handler only calls `setArchived` when
  `ctx.payload.time.archived !== undefined`. So `undefined` can never be
  delivered through PATCH. The guard and the clear-condition are mutually
  exclusive on this code path.
- Conclusion: **only an internal caller of `Session.setArchived({ time: undefined })`
  can clear the archive.** No HTTP request to `PATCH /session/:id` can.

### 2d. DB serialization (secondary)

`packages/opencode/src/session/session.ts`:

```ts
// fromRow (DB -> object):  NULL -> undefined -> omitted in JSON by `optional`
archived: row.time_archived ?? undefined
// toRow (object -> DB):    undefined -> SQLite NULL
time_archived: info.time.archived
```

So "not archived" is internally `time.archived === undefined` <-> SQLite
`time_archived IS NULL`. A finite timestamp (incl. `0`) is stored as-is.

### 2e. No dedicated archive/unarchive endpoint

`SessionPaths` in the same route-group file enumerates every session route:
`list, status, get, children, todo, diff, messages, message, create, remove,
update, fork, abort, share, init, summarize, prompt, promptAsync, command,
shell, revert, unrevert, permissions, deleteMessage, deletePart, updatePart`.
There is **no** `archive`/`unarchive`/`restore` path. `PATCH /session/:id`
(`update`) is the only field-mutation route, and it cannot clear (see 2c).

### 2f. Corroboration: generated SDK does not expose `archived` on session update

- v1 SDK `SessionUpdateData.body` = `{ title?: string }` only (no `time`).
  `packages/sdk/js/src/gen/types.gen.ts`.
- v2 SDK `packages/sdk/js/src/v2/gen/sdk.gen.ts` contains **zero** occurrences of
  `archived` in its session method surface.

This is consistent with archive/unarchive not being a supported typed-client
operation; the server route exists, but the public SDK does not surface it.

---

## 3. FIX SHAPE (concrete options for a build agent)

There is **no clean, semantically-correct HTTP fix** against OpenCode 1.17.x,
because the upstream API has no unarchive path. The options, in order of
pragmatism:

### Option A (recommended workaround) — send `{"time":{"archived":0}}`

`0` is a valid `Schema.Finite` (passes decode), `0 !== undefined` (enters the
handler guard), and `setArchived({ time: 0 })` stores `time_archived = 0`.
vh-solara **already** treats `0` as "not archived" per
`docs/architecture/coordination-api.md` (`time.archived == null || 0` = active),
so the session un-archives in vh-solara's view.

- Change: vh-solara's unarchive request body from
  `{"time":{"archived":null}}` -> `{"time":{"archived":0}}`.
- **Caveat (must document):** `0 != NULL`, so OpenCode's *own* global-list filter
  `isNull(time_archived)` would still consider the session archived, and
  OpenCode's own app would still hide it. This works for vh-solara's display
  only because (i) vh-solara defines `0` as active and (ii) the instance
  `/session` list does not filter on archived at all (see section 5). It is a
  display-level unarchive, not a true one. Flag as a known semantic compromise.

### Option B (frontend hardening — required regardless)

The unarchive call must check `res.ok` and surface errors instead of mapping
any failure to `affected: []`. Without this, the 400 (current bug) and any
future failure are invisible. (Settled assumption: the frontend currently
swallows the error.)

### Option C (most semantically correct, if vh-solara has co-located DB access)

If the Go binary can reach OpenCode's SQLite DB, clear directly:
`UPDATE session SET time_archived = NULL WHERE id = ?`. This matches
OpenCode's internal null-means-active model exactly, but couples vh-solara to
OpenCode's DB schema (fragile across versions).

### Option D (wait for upstream)

OpenCode issues **#24153**, **#13964**, **#32355**, **#26078**, **#26552**,
**#16000** all request unarchive/restore UI. The correct upstream fix is:
change `UpdatePayload.time.archived` to
`Schema.optional(Schema.NullOr(Session.ArchivedTimestamp))` AND add a handler
branch `if (ctx.payload.time.archived === null) setArchived({ time: undefined })`.
Track these; revisit when shipped. Note: issue #24153's claim "backend already
supports `archived: null`" is **incorrect** — it conflates the *event* schema
`UpdatedTime` (which uses `NullOr`) with the *request* schema `UpdatePayload`
(which does not).

### Likely regression cause (context)

The Effect HttpApi migration landed in **v1.14.42** (May 2026, per Kit
Langhton). Before that (Hono-based routes) the PATCH handler likely decoded the
body loosely and a present `null` may have been written through. vh-solara's
unarchive was probably written/tested against the pre-Effect behavior and broke
silently at v1.14.42+. All 1.17.x is Effect-based, so the bug is present across
the entire current series.

---

## 4. FIXTURE FIDELITY

**Yes — `pkg/fixtures/opencode.go` (~line 587) must change.** The fixture models
the PATCH as `f.archived[id] = body.Time.Archived != nil && *body.Time.Archived != 0`
(null clears it), which directly encodes the **wrong** behavior: it accepts
`null` as a valid clear and returns success. Real OpenCode returns **400** for
`{"time":{"archived":null}}` and never mutates state. The fixture should instead
(1) reject a present JSON `null` for `archived` with a 400 (mirroring
`Schema.Finite`), and (2) only treat a present finite number as "set archived",
with **no** value — including `0`, `null`, or an absent `archived` key — able to
clear an already-archived session through PATCH. Without this change the e2e
suite will keep asserting the buggy "null clears" contract and will never catch
the real-world failure.

---

## 5. SECONDARY FINDINGS

### 5a. `?archived=true` is ignored on the instance `/session` list — CONFIRMED for 1.17.x

`ListQuery` in the route-group file declares these query params **only**:
`directory, workspace, scope, path, roots, start, search, limit`. There is **no
`archived` parameter**. The `list` handler passes only `{ directory, scope, path,
roots, start, search, limit }` to `session.list`; no archived filtering occurs.

```ts
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
```

So vh-solara's code comment "OpenCode 1.17.x ignores `?archived=true` and
returns ALL sessions" is **correct and current** (not version-stale within the
1.17.x series). An unrecognized `archived` query param is dropped by the schema
decode; the instance list returns every session including archived ones.

### 5b. Global list DOES filter — different endpoint

Only the **global** list (`listGlobal`) applies an archived filter:
`if (!input?.archived) conditions.push(isNull(SessionTable.time_archived))`
-> active = `time_archived IS NULL`; `archived:true` returns only archived. This
is a separate endpoint from the instance `/session` list vh-solara consumes, so
it does not rescue the unarchive bug, but it documents OpenCode's authoritative
definition of "active" = `IS NULL` (not `0`) — which is why Option A's `0`
workaround is a display-only hack.

### 5c. Internal representation

- Go-side equivalent: `time.archived` is an optional `*int64`-style timestamp;
  absent/`nil`/`undefined` <-> SQLite `NULL` = active.
- JSON serialization via `Schema.optional`: an active session **omits** the
  `archived` key entirely (absent, not `null`).

---

## 6. CONFIDENCE + GAPS

| Finding | Confidence | Type | Basis |
|---|---|---|---|
| `{"time":{"archived":null}}` -> 400, does not clear | **high** | fact | `UpdatePayload` = `optional(Finite)`; effect `optional` doesn't accept null; `Finite` rejects null; `.handle` (not `handleRaw`) means decode->400 |
| No HTTP path can clear archive in 1.17.x | **high** | inference (strong) | handler guard `!== undefined` is mutually exclusive with `setArchived({time:undefined})`; no dedicated endpoint in `SessionPaths` |
| `0` stores as `time_archived=0` (Option A) | **high** | fact | `0` is valid `Finite`; flows through guard + `setArchived` + `patch` + `toRow` |
| `0` is a display-only unarchive (still archived in opencode's own model) | **medium-high** | inference | opencode global list uses `isNull(time_archived)`; opencode app event-reducer splices on any present `archived` (issue #26078); vh-solara defines `0` as active |
| `?archived=true` ignored on instance list in 1.17.x | **high** | fact | `ListQuery` has no `archived` field; handler forwards no archived filter |
| Pre-1.14.42 (Hono) accepted null and cleared | **medium** | inference | plausible regression cause; not verified against Hono-era source (out of scope, pre-current series) |
| v2 SDK omits `archived` from typed session.update | **high** | fact | zero `archived` occurrences in `v2/gen/sdk.gen.ts`; v1 `SessionUpdateData.body` = `{title?}` only |

### Gaps / unverified
- Did not read the Hono-era (pre-v1.14.42) PATCH handler to confirm the
  pre-regression behavior; claimed as the likely regression cause only.
- Did not execute any request (read-only source study); the 400 claim rests on
  schema/handler source + Effect `Schema.optional`/`Schema.Finite` documented
  semantics, not a live repro.
- The custom `optional`/`optionalOmitUndefined` helper in `@opencode-ai/schema`
  was not byte-read, but the route-group file under audit imports
  `Schema.optional` from `effect` directly (not the custom helper), so the
  custom helper's semantics are irrelevant to this specific schema.
- Option C (direct SQLite write) assumes vh-solara has co-located DB write
  access — **not verified** against vh-solara's architecture; the operator
  should confirm whether vh-solara proxies to OpenCode HTTP only or also holds
  a DB handle.

---

## Findings
- **(finding)**: source=sst/opencode v1.17.14 groups/session.ts UpdatePayload, confidence=high, type=fact — `time.archived` is `Schema.optional(Schema.Finite)`; present `null` fails decode.
- **(finding)**: source=sst/opencode v1.17.14 handlers/session.ts update + `.handle("update")`, confidence=high, type=fact — payload is schema-validated before handler; guard `archived !== undefined` never delivers `undefined` to `setArchived`.
- **(finding)**: source=sst/opencode v1.17.14 session.ts setArchived/patch, confidence=high, type=inference — only `setArchived({time:undefined})` clears (DB NULL); unreachable via HTTP PATCH.
- **(finding)**: source=sst/opencode v1.17.14 groups/session.ts SessionPaths + ListQuery, confidence=high, type=fact — no archive/unarchive endpoint; instance list has no `archived` query param.
- **(finding)**: source=opencode issues #24153/#13964/#26078, confidence=medium, type=fact — opencode app has no unarchive UI; #24153's "archived:null works" claim misreads the event schema vs request schema.

## Contradictions
- **vh-solara fixture vs real opencode**: `pkg/fixtures/opencode.go` models `null` as a successful clear; real opencode 1.17.x returns 400 for present `null`. Fixture is unfaithful and hides the bug. (Resolved — fixture is wrong.)
- **opencode issue #24153 claim vs source**: issue asserts "backend already supports `archived: null`"; the request schema `UpdatePayload` does not accept null (only the event schema `UpdatedTime` does). (Resolved — issue is mistaken.)
- **vh-solara comment "`?archived=true` ignored in 1.17.x" vs possible staleness**: confirmed still true in v1.17.14 (`ListQuery` has no `archived` field). (Resolved — comment is accurate.)

---

## Promotion targets (live docs to update after a fix lands — NOT this packet)

- `researches/sources/opencode-unarchive-patch-audit.md` — promote THIS tmp packet first.
- `docs/architecture/coordination-api.md` — correct the archive-clear contract
  (currently implies `null` clears; real OpenCode 1.17.x rejects `null`).
- `pkg/fixtures/opencode.go` — fixture fidelity fix (section 4).
- vh-solara frontend unarchive call — error-surface fix (Option B).
- vh-solara code comments citing "1.17.x ignores `?archived=true`" — still
  accurate; keep, optionally cite this packet.

## Recommended next specialist

`debate` (if Option A vs C vs D needs multi-perspective tradeoff) or `planner`
-> `build` to implement the chosen fix shape. This packet is the evidence base;
it is **not** active repo policy.
