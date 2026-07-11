# OpenCode direct-SQLite unarchive — implementation spec

> Implementation spec packet. Read-only source study of `sst/opencode` tag
> **v1.17.14** (latest release, Jul 6 2026), cross-checked against current
> `master`. No vh-solara or OpenCode code was executed. Every path/behavior
> claim is cited to upstream source at the exact tag.
>
> Follow-up to `researches/sources/opencode-unarchive-patch-audit.md`
> (which established there is NO HTTP mechanism to unarchive in 1.17.x).
>
> SCOPE: this packet specifies a **direct SQLite write** by the vh-solara Go
> binary (`UPDATE session SET time_archived = NULL WHERE id = ?`). vh-solara is
> currently a pure HTTP client to `opencode serve` with NO existing SQLite
> access; this spec is the foundation for a new dependency boundary. Getting
> the DB path or open flags wrong risks silent wrong-file writes or DB
> corruption.
>
> NOTE: Promoted from `tmp/agent-runs/researcher/` to
> `researches/sources/opencode-sqlite-unarchive-spec.md`.

---

## Mission recap / source policy

- **Primary**: `sst/opencode` GitHub, tag `v1.17.14` (and `master` for drift).
  CODE is authoritative. All quotes carry file path + tag permalink.
- **Reuse** the prior packet's cited files (groups/session.ts, handlers/session.ts,
  session/session.ts) as starting points, then follow into the DB-layer / config /
  path code.
- Did NOT run vh-solara or OpenCode. Scratch only under `tmp/agent-runs/researcher/`.

---

## 1. DB PATH RESOLUTION

### 1a. The rule (authoritative)

OpenCode stores ALL sessions in **ONE global SQLite file**. There is no
per-workspace / per-instance DB. The file is resolved by a single function
`Database.path()`:

`packages/core/src/database/database.ts` (v1.17.14)
https://github.com/sst/opencode/blob/v1.17.14/packages/core/src/database/database.ts

```ts
export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}
```

`Global.Path.data` is set in `packages/core/src/global.ts` (v1.17.14):
https://github.com/sst/opencode/blob/v1.17.14/packages/core/src/global.ts

```ts
import { xdgData } from "xdg-basedir"
const app = "opencode"
const data = path.join(xdgData!, app)
// ...
const paths = { /* ... */ data, /* ... */ }
```

`xdgData` comes from the `xdg-basedir` npm package (sindresorhus/xdg-basedir),
whose source is:
https://github.com/sindresorhus/xdg-basedir/blob/main/index.js

```js
export const xdgData = env.XDG_DATA_HOME ||
	(homeDirectory ? path.join(homeDirectory, '.local', 'share') : undefined);
```

### 1b. Concrete pseudo-formula a Go dev can implement

`xdg-basedir` is **XDG-spec-literal — it does NO platform branching** (no
`~/Library/...` on macOS, no `%APPDATA%` on Windows). Verified from its source.
So `dataDir` resolves identically on every platform:

```
dataDir = (env XDG_DATA_HOME, if set AND absolute-ish, else)  <home>/.local/share
home    = (env OPENCODE_TEST_HOME, if set, else)  os.UserHomeDir()
```

Then (assuming the **normal published-channel** case — see branch notes below):

```
dbPath = <dataDir>/opencode/opencode.db
```

#### Branch / override notes (must each be honored by vh-solara)

1. **`OPENCODE_DB` env var wins over everything.** `packages/core/src/flag/flag.ts`
   (v1.17.14) confirms `OPENCODE_DB: process.env["OPENCODE_DB"]`.
   - If `OPENCODE_DB == ":memory:"` → in-memory DB (not file-backed — a direct
     file write is impossible / meaningless; vh-solara MUST refuse).
   - If `OPENCODE_DB` is an **absolute path** → that exact path is the DB file.
   - If `OPENCODE_DB` is **relative** → `join(dataDir/opencode, OPENCODE_DB)`.
2. **Installation channel** selects the filename when `OPENCODE_DB` is unset.
   `InstallationChannel` (`packages/core/src/installation/version.ts`, v1.17.14)
   is a build-time define (`OPENCODE_CHANNEL`), defaulting to `"local"`:
   ```ts
   export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
   ```
   - channel ∈ {`latest`,`beta`,`prod`} OR `OPENCODE_DISABLE_CHANNEL_DB` ∈
     {`1`,`true`} → **`opencode.db`** (this is the normal published-binary case).
   - any other channel (e.g. `"local"` for dev builds) →
     `opencode-<sanitized-channel>.db` (e.g. `opencode-local.db`).
3. **`OPENCODE_DISABLE_CHANNEL_DB`** forces `opencode.db` regardless of channel
   (`process.env` read directly in `database.ts`, not in the Flag object).

#### What vh-solara knows vs. needs

vh-solara sends `x-opencode-directory` to scope HTTP requests, but the **DB path
is NOT derivable from the workspace directory** — it depends only on the *user's
home*, `XDG_DATA_HOME`, `OPENCODE_DB`, and the OpenCode *channel*. vh-solara must
resolve the path from the **same env/process context the `opencode serve` process
runs under**, not from the workspace dir. Inputs vh-solara needs:

- the OS user whose `opencode serve` owns the DB (home dir) — typically the same
  user running the vh-solara worker on that machine;
- `XDG_DATA_HOME`, `OPENCODE_DB`, `OPENCODE_DISABLE_CHANNEL_DB` as seen by that
  `opencode serve` process (pass-through/inheritance); and
- the OpenCode **channel** — vh-solara cannot read the build-time define, so the
  safest resolution is: **prefer `OPENCODE_DB` if set; else default to
  `opencode.db`; only fall back to `opencode-local.db` if the operator/config
  indicates a dev build.** (Recommendation: have the operator/VhSolara config
  name the DB file explicitly, OR have vh-solara shell out to
  `opencode db path` — see §1c.)

### 1c. Authoritative runtime resolver (use it, don't re-derive)

OpenCode ships a CLI that prints the exact resolved path:

`packages/opencode/src/cli/cmd/db.ts` (v1.17.14)
https://github.com/sst/opencode/blob/v1.17.14/packages/opencode/src/cli/cmd/db.ts

```ts
const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})
```

**Strong recommendation for the build agent**: rather than re-implementing
`Database.path()` in Go (and risking a drift bug the moment OpenCode changes the
branch logic), have vh-solara resolve the DB path by running
`opencode db path` (with the same `OPENCODE_DB` / `XDG_DATA_HOME` / channel env
as the live server) and capturing stdout. This makes vh-solara's path resolution
*identical* to OpenCode's by construction. The Go re-implementation in §1b is the
fallback when shelling out is undesirable; if used, it MUST be covered by the
drift test in §6.

---

## 2. TARGET DB + TABLE + COLUMN + UPDATE

### 2a. Which DB holds `time_archived`

The instance `/session` HTTP list (`session.list` → `listByProject`) and
`session.get` both `SELECT ... FROM session` on the **single `Database` instance**
opened at `Database.path()` — i.e. `opencode.db` (the same global file).

`packages/opencode/src/session/session.ts` (v1.17.14)
https://github.com/sst/opencode/blob/v1.17.14/packages/opencode/src/session/session.ts

```ts
const { db } = yield* Database.Service   // the single global DB
// ...
const get = Effect.fn("Session.get")(function* (id: SessionID) {
  const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
  if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
  return fromRow(row)
})
```

So vh-solara must write to **the same `opencode.db` file** (resolved per §1).

### 2b. Table + column

`packages/core/src/session/sql.ts` (v1.17.14)
https://github.com/sst/opencode/blob/v1.17.14/packages/core/src/session/sql.ts

```ts
export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text().$type<ProjectV2.ID>().notNull().references(() => ProjectTable.id, { onDelete: "cascade" }),
    // ...
    ...Timestamps,                 // time_created, time_updated (see below)
    time_compacting: integer(),
    time_archived: integer(),      // <-- nullable INTEGER, no default, no notNull, no index
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)
```

- Table name: **`session`** (literal).
- Column: **`time_archived`**, drizzle `integer()` → SQLite **type affinity
  `INTEGER`**, **nullable** (no `.notNull()`), **no default**, **not indexed**.
- `Timestamps` (`packages/core/src/database/schema.sql.ts`):
  ```ts
  export const Timestamps = {
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$onUpdate(() => Date.now()),
  }
  ```
  `time_updated`'s `$onUpdate` is a **Drizzle ORM-level hook only** — a raw SQL
  UPDATE from vh-solara's Go driver bypasses Drizzle entirely and does NOT bump
  `time_updated` (see §2d note).

### 2c. Semantics (active vs archived)

From the same `session.ts` (v1.17.14), `fromRow`/`toRow`:

```ts
// fromRow (DB -> object):  NULL -> undefined
archived: row.time_archived ?? undefined,
// toRow (object -> DB):    undefined -> SQLite NULL
time_archived: info.time.archived,
```

The global list applies the authoritative filter
(`listGlobal`): `if (!input?.archived) conditions.push(isNull(SessionTable.time_archived))`
→ **"active" = `time_archived IS NULL`** (not `0`). Clearing = `NULL`, matching
the prior packet's finding. A finite timestamp (including `0`) is stored as-is
and counts as archived in OpenCode's own model.

### 2d. The exact UPDATE

The row PK `id` **is** the session id vh-solara uses (the `id` field returned by
`/session`; `SessionID` = `SessionTable.id` PK). Minimal, safe statement:

```sql
UPDATE session SET time_archived = NULL WHERE id = ?;
```

- No other column needs to be touched. **Do not** also set `time_updated`: (i) a
  raw UPDATE won't trigger Drizzle's `$onUpdate` anyway, (ii) bumping it would
  re-order the session in `ORDER BY time_updated DESC` lists, which is an
  unrelated semantic change. Keep the write minimal; document that
  `time_updated` is intentionally NOT bumped (the unarchived session keeps its
  old list position).
- The UPDATE is **safe w.r.t. foreign keys**: `time_archived` has no FK; it is a
  plain scalar. Enabling `foreign_keys` does not affect it.
- Guard the `WHERE id = ?` against no-row / multi-row: vh-solara should check
  `rowsAffected == 1` (the id is a PK, so at most one row) and surface a clear
  error otherwise (the session id was unknown — already deleted / wrong DB file).

---

## 3. CONCURRENCY / OPEN FLAGS / DRIVER

### 3a. What the running OpenCode uses

`packages/core/src/database/sqlite.node.ts` (v1.17.14) — the native handle:
https://github.com/sst/opencode/blob/v1.17.14/packages/core/src/database/sqlite.node.ts

```ts
const native = new DatabaseSync(config.filename, {
  readOnly: config.readonly,
  timeout: config.timeout,
  allowExtension: config.allowExtension,
  enableForeignKeyConstraints: true,
  open: true,
})
// ...
if (config.disableWAL !== true && config.readonly !== true) native.exec("PRAGMA journal_mode = WAL;")
```

`packages/core/src/database/database.ts` (v1.17.14) — the layer applies pragmas
on every connection:

```ts
yield* db.run("PRAGMA journal_mode = WAL")
yield* db.run("PRAGMA synchronous = NORMAL")
yield* db.run("PRAGMA busy_timeout = 5000")
yield* db.run("PRAGMA cache_size = -64000")
yield* db.run("PRAGMA foreign_keys = ON")
yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
```

So OpenCode runs the DB in **WAL** with **synchronous=NORMAL**,
**busy_timeout=5000ms**, **foreign_keys=ON**, and a passive checkpoint at start.

### 3b. Safe coexistence for a SECOND writer (vh-solara)

SQLite WAL mode is explicitly designed for multi-process access: **many readers +
one writer at a time**, writers serialize on the write lock, and `busy_timeout`
makes a would-be writer **wait** instead of returning `SQLITE_BUSY`. Rules for
vh-solara's connection so it does not fight the running OpenCode process:

1. **Open the SAME file** resolved in §1 (wrong file = silent wrong-file write).
2. **Use WAL too** — opening a file that is already in WAL is fine; setting
   `journal_mode=WAL` again is a harmless no-op. **Never** switch the journal
   mode away from WAL (e.g. to DELETE/TRUNCATE) — that would fight OpenCode and
   can force a checkpoint/stall while writers are active.
3. **Set `busy_timeout >= 5000`** (match or exceed OpenCode's 5000ms) so
   vh-solara waits for OpenCode's write lock rather than erroring `SQLITE_BUSY`.
4. **`synchronous=NORMAL`** is safe and standard with WAL; match it.
5. **`foreign_keys` is irrelevant** to a single `time_archived` UPDATE (no FK
   involved). Enable it for safety parity, or leave default — does not matter.
6. **Do NOT run** `PRAGMA wal_checkpoint(TRUNCATE/RESTART)` or `VACUUM` while
   OpenCode holds the DB — let OpenCode own checkpointing. (OpenCode already
   does `wal_checkpoint(PASSIVE)` on startup.) A passive checkpoint from
   vh-solara is harmless but unnecessary; simplest is to not checkpoint at all.
7. **Connection pool: keep it tiny.** For a single best-effort UPDATE,
   `SetMaxOpenConns(1)` avoids multiple goroutines each contending for the write
   lock and reduces `SQLITE_BUSY` surface area. (Each open connection in WAL also
   holds the `-wal`/`-shm` alive; a single short-lived connection is cleanest.)
8. **Short-lived connection per unarchive** is preferable to a long-lived second
   handle: open → pragma → UPDATE → verify `rowsAffected==1` → close. This
   minimizes the window during which two processes hold the DB.

### 3c. Go driver recommendation: **`modernc.org/sqlite` (pure Go)**

vh-solara ships as a **single static Go binary** (per AGENTS.mission.md) and is
tag-driven-released via cross-compiling GitHub Actions. Driver decision:

- **`modernc.org/sqlite`** — pure Go (SQLite C transpiled to Go via ccgo). **No
  CGO.** Cross-compiles cleanly to every GOOS/GOARCH the release workflow
  targets; `go build ./...` and `go test ./...` work on a bare toolchain; trivial
  `FROM scratch`/distroless story. Registers driver name **`sqlite`**. Supports
  WAL, `busy_timeout`, `foreign_keys`, `?_pragma=...` DSN params. Slower than cgo
  on some workloads (per the cvilsmeider / modernc sqlite-bench results) but the
  unarchive workload is a single point UPDATE — performance is a non-issue.
- **`mattn/go-sqlite3`** — wraps the official SQLite C lib, requires **CGO + a C
  toolchain at build**. Breaks `CGO_ENABLED=0` static builds, complicates
  cross-compilation (per-target `CGO_*/CC`), and adds a runtime libc dependency.
  Marginally faster and the "widest adoption" option, but it is the wrong fit for
  vh-solara's distribution model.
- (Honorable mention `github.com/ncruces/go-sqlite3` — pure-Go via wasm2go; also
  CGO-free. modernc is the more mainstream pure-Go choice and has the strongest
  ecosystem precedent for WAL multi-process.)

**Recommendation: `modernc.org/sqlite`.** The pure-Go property preserves the
single-binary / cross-compile release model; the workload does not need cgo's
speed. (If the operator later has a hard reason for cgo — custom SQLite
extensions — revisit; unlikely for this feature.)

#### Example DSN shape (modernc, via `_pragma` query params)

```
file:<dbPath>?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)
```

Equivalently, open then `db.Exec("PRAGMA ...")` for each. Either is fine; set
`SetMaxOpenConns(1)`.

---

## 4. CACHE / INVALIDATION VERDICT

**Question**: after vh-solara writes `time_archived = NULL` directly, will
OpenCode's *running* process reflect it on its next `/session` HTTP read?

**Answer: YES.** The instance list and get re-read from the DB on every call —
there is **no in-memory session cache** to invalidate.

`packages/opencode/src/session/session.ts` (v1.17.14):

```ts
// list -> listByProject (fresh SELECT every call)
const list = Effect.fn("Session.list")(function* (input?: ListInput) {
  const ctx = yield* InstanceState.context
  return yield* listByProject(db, { projectID: ctx.project.id, ...input })
})
// listByProject body:
return db.select().from(SessionTable).where(and(...conditions)).orderBy(desc(SessionTable.time_updated)).limit(limit).all()

// get (fresh SELECT every call)
const get = Effect.fn("Session.get")(function* (id: SessionID) {
  const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
  if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
  return fromRow(row)
})
```

The instance `/session` list handler calls `session.list` → `listByProject`
(prior packet: `ListQuery` has no `archived` filter, so it returns all rows for
the project including archived ones). Both it and `get` do a fresh `SELECT FROM
session` against the live SQLite file. A second writer's committed UPDATE is
immediately visible to SQLite readers in the same process (WAL readers see
committed writer transactions).

**Does vh-solara need to ALSO mutate its own in-memory store directly?**

- For correctness of the *next read*: **No.** If vh-solara's Rehydrate re-reads
  via `/session`, it will see `time_archived = NULL` (i.e. an absent/omitted
  `archived` field, since `fromRow` maps NULL→undefined and `optional` omits it
  in JSON) with no extra action.
- For *immediate UI consistency without a round-trip*: vh-solara MAY optimistically
  flip its own cached `archived` flag at the moment it issues the UPDATE, but it
  is not required for correctness — a subsequent `/session` fetch will reconcile.
  (Recommendation: optimistic local flip + a follow-up Rehydrate, because the
  direct DB write does NOT emit an OpenCode `session.updated` event — see the
  clobber section — so vh-solara will NOT receive a push that would otherwise
  refresh it.)

---

## 5. CLOBBER RISK (write-through cache overwriting our edit)

**Question**: will OpenCode's in-memory state overwrite `time_archived` back to
the stale archived value on a later event?

**Assessment: LOW risk. There is no persistent in-memory cache; only a narrow
read-modify-write race.**

The event projector for `session.updated` writes **all** columns, including
`time_archived`, from the event payload:

`packages/core/src/session/projector.ts` (v1.17.14)
https://github.com/sst/opencode/blob/v1.17.14/packages/core/src/session/projector.ts

```ts
yield* events.project(SessionV1.Event.Updated, (event) =>
  db
    .update(SessionTable)
    .set(sessionRow(event.data.info))   // <-- sets ALL columns incl. time_archived
    .where(eq(SessionTable.id, event.data.sessionID))
    .run()
    .pipe(Effect.orDie),
)
```

`sessionRow()` includes `time_archived: info.time.archived`. So **any**
`session.updated` event rewrites `time_archived` from the event's `info.time.archived`.

The decisive mitigating fact is how that event is produced. Every field-mutating
op goes through `patch`, which **re-reads the current DB row first**:

`packages/opencode/src/session/session.ts` (v1.17.14):

```ts
const patch = (sessionID: SessionID, info: Patch) =>
  Effect.gen(function* () {
    const current = yield* get(sessionID)              // <-- fresh DB read (no cache)
    const next = {
      ...current, ...info,
      time: info.time ? { ...current.time, ...info.time } : current.time,
      // ...
    } as Info
    yield* events.publish(SessionV1.Event.Updated, { sessionID, info: next })
  })
```

Consequences:

- **If a `patch`-based op (setTitle / setMetadata / touch / setPermission /
  setShare / setRevert / setWorkspace / setSummary / setAgentModel / setArchived)
  runs AFTER our NULL write has committed**, its `get(sessionID)` reads the new
  NULL → `current.time.archived === undefined` → the merge keeps it undefined →
  the published event carries `archived: undefined` → the projector writes
  `time_archived = NULL`. **Our edit is preserved.**
- **The only clobber window**: a `patch` op that calls `get(sessionID)`
  *before* our UPDATE commits, then publishes `session.updated` *after* our
  UPDATE commits. That event carries the **stale** archived timestamp and the
  projector writes it back, nullifying our edit. This is a classic
  read-modify-write race; it requires a concurrent mutation of that exact
  session during the unarchive.
- **Likelihood in practice: low.** An archived session is by definition idle
  (no active run). `touch` (which bumps `time.updated`) is driven by activity,
  and an archived session has none. The realistic trigger is the *user* editing
  metadata/title on the archived session from the OpenCode app at the same
  instant vh-solara unarchives — rare, and self-correcting if vh-solara re-issues
  or the user simply re-clicks unarchive.

**Auto-clobber from background events: not present.** No scheduled/automatic
process in source re-publishes `session.updated` for idle archived sessions.
(Message/part events go through separate projectors that do NOT touch the
`session` row's `time_archived`; `applyUsage` only updates cost/token columns
and explicitly pins `time_updated: sql\`${SessionTable.time_updated}\`` — i.e.
it does not even change `time_updated`, and never touches `time_archived`.)

**Mitigations for vh-solara (optional, in priority order):**
1. Perform the unarchive when the session is known idle (no active run) — the
   common case, makes the race near-impossible.
2. After the UPDATE, immediately re-read `time_archived` from the DB to confirm
   it is NULL; if not (lost a race), retry once or surface "session was modified
   concurrently".
3. (Heavier) do the unarchive as a single transaction that also re-checks, e.g.
   `UPDATE session SET time_archived = NULL WHERE id = ? AND time_archived IS NOT NULL`
   and inspect `rowsAffected`. (Doesn't prevent a race but makes the intent
   explicit and idempotent.)

---

## 6. DRIFT-DETECTION TEST DESIGN

Goal: if a future OpenCode renames `time_archived`, moves/renames the DB, or
retypes the column, a vh-solara test **fails loudly with a message pointing at
the coupling doc** — not a silent field bug. Two complementary layers:

### 6a. Runtime self-check (the cheap, always-on guard)

Before issuing the unarchive UPDATE, vh-solara queries the schema and asserts the
contract, refusing the write on violation:

```sql
-- must return a row with: name='time_archived', type starts with 'INTEGER', notnull=0, dflt_value=NULL
PRAGMA table_info(session);
```

Assert: a table literally named `session` exists, and it has a column literally
named `time_archived` with type affinity INTEGER (`type` containing `INTEGER`)
and `notnull = 0` (nullable). On mismatch, **abort the unarchive**, log an error
referencing the coupling doc + the validated OpenCode version (v1.17.14), and
surface a user-visible "OpenCode schema changed; unarchive disabled" state. This
turns silent corruption into a loud, localized failure.

(Why `PRAGMA table_info` and not parsing `sqlite_master.sql`: it is stable across
SQLite versions, returns parsed column metadata, and avoids brittle DDL string
matching. It is also exactly the kind of introspection OpenCode's own migration
bootstrapper relies on — `SELECT name FROM sqlite_master WHERE type='table'` in
`packages/core/src/database/migration.ts` — so the approach is consistent with
upstream conventions.)

### 6b. Captured schema contract (what to embed)

Embed a tiny, version-keyed constant in vh-solara describing the v1.17.14
contract the code depends on. Minimal shape:

```go
// validatedAgainst = "opencode v1.17.14"
// source: packages/core/src/session/sql.ts @ v1.17.14  (SessionTable)
const (
    opencodeSessionTable   = "session"
    opencodeArchivedColumn = "time_archived"
    opencodeArchivedType   = "INTEGER" // drizzle integer() -> SQLite affinity INTEGER
    opencodeArchivedNullable = true
)
```

The runtime self-check (6a) compares live `PRAGMA table_info(session)` against
these constants. The coupling doc (§7) records where each constant came from.

### 6c. CI test (deterministic, no real OpenCode needed)

A unit test that builds a throwaway SQLite DB mimicking the v1.17.14 `session`
schema **as captured**, then exercises vh-solara's unarchive function end-to-end:

- Create temp DB; `CREATE TABLE session (id TEXT PRIMARY KEY, ..., time_archived INTEGER, time_updated INTEGER NOT NULL, ...)`
  (only the columns the code path reads/writes need to be real).
- Insert a row with `time_archived = 1700000000000`.
- Run vh-solara's unarchive(id).
- Assert: `SELECT time_archived FROM session WHERE id=?` → NULL; `rowsAffected == 1`;
  `time_updated` unchanged (documents the "we don't bump time_updated" decision).
- Assert the self-check (6a) passes against this fixture.
- **Negative test**: mutate the fixture (rename `time_archived` → `archived_at`,
  or retype to TEXT) and assert the self-check FAILS with the expected loud
  message (proves the guard actually catches drift, not just passes on happy path).

This test guards vh-solara's *own* logic and the *self-check's sensitivity*, but
it cannot by itself detect upstream drift (it uses vh-solara's captured schema,
not OpenCode's real one). Upstream drift is caught by the **runtime self-check
(6a) against the real DB** + the **manual re-validation step (6d)**.

### 6d. Manual / research re-validation step (keyed to v1.17.14)

A documented, repeatable procedure recorded in the coupling doc, to run on every
supported-OpenCode-version bump:

1. Re-read `packages/core/src/session/sql.ts` (`SessionTable`) at the new tag —
   confirm table still named `session`, column still `time_archived`,
   `integer()`, nullable, no new NOT NULL / CHECK / index that the UPDATE would
   violate.
2. Re-read `packages/core/src/database/database.ts` (`path()` + pragma block) —
   confirm the path-resolution rule and pragmas are unchanged; if `path()` logic
   changed, update the Go resolver (or the `opencode db path` call) and §1.
3. Re-read `packages/opencode/src/session/session.ts` (`get`/`list`/`patch`) and
   `packages/core/src/session/projector.ts` (`SessionV1.Event.Updated` handler) —
   re-confirm §4 (no cache) and §5 (clobber window) still hold.
4. Update the `validatedAgainst` constant (6b) to the new tag; re-run 6c.
5. Bump the version pin in the coupling doc.

This is the durable boundary: a human re-check on version bumps, backed by an
automated self-check that catches anything missed.

### 6e. Secondary: migrations / schema_version

`packages/core/src/database/migration.ts` (v1.17.14):
https://github.com/sst/opencode/blob/v1.17.14/packages/core/src/database/migration.ts

- OpenCode applies **TypeScript migrations** on DB open (`DatabaseMigration.apply`)
  tracked by a `migration(id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`
  table (plus a legacy `__drizzle_migrations` journal seed). Migrations alter
  **schema DDL**, not row content. **A direct `UPDATE session SET time_archived =
  NULL` is a plain data write — no migration intercepts or rejects it.**
- The migration bootstrapper itself gates on the existence of the `session`
  table (`tables.some(t => t.name === "session")`), so asserting the `session`
  table + `time_archived` column presence (6a) implicitly asserts migrations have
  run.
- Optionally, vh-solara may read `SELECT id FROM migration` and compare against a
  captured snapshot of migration ids at v1.17.14 as an *extra* drift signal —
  but this is higher-noise (the id set grows with every release) and is NOT
  required for the write to be safe. The column-presence check (6a) is the
  recommended primary signal.

---

## 7. DOC CONTRACT OUTLINE (for the build agent → `docs/`)

The coupling doc (suggested path: `docs/architecture/opencode-sqlite-unarchive.md`,
cross-linked from `docs/architecture/coordination-api.md`) MUST contain:

- **Why direct DB.** OpenCode 1.17.x has NO HTTP mechanism to unarchive a
  session — `PATCH /session/:id {"time":{"archived":null}}` returns 400 (request
  schema `Schema.optional(Schema.Finite)` rejects null; handler guard makes a
  true clear unreachable). Cite the prior audit packet
  (`researches/sources/opencode-unarchive-patch-audit.md`). The only
  semantically-correct clear is `time_archived = NULL`, matching OpenCode's own
  "active = `IS NULL`" model. So vh-solara writes it directly.
- **What we depend on (the coupling surface), validated against OpenCode
  v1.17.14:**
  1. DB file path resolution = `Database.path()` (§1), data dir =
     `$XDG_DATA_HOME/opencode` else `~/.local/share/opencode`; default file
     `opencode.db` (channel/`OPENCODE_DB`/`OPENCODE_DISABLE_CHANNEL_DB` branches
     in §1b). Resolution method = `opencode db path` (preferred) or Go
     re-implementation.
  2. Table `session`, column `time_archived` (INTEGER, nullable), row PK `id` =
     the session id (§2).
  3. The exact UPDATE: `UPDATE session SET time_archived = NULL WHERE id = ?`
     (§2d), single-row, `time_updated` intentionally NOT bumped.
- **Concurrency contract (§3).** OpenCode runs WAL + `synchronous=NORMAL` +
  `busy_timeout=5000` + `foreign_keys=ON`. vh-solara is a second WAL writer using
  `modernc.org/sqlite` (pure Go, chosen for the single-binary release model),
  `busy_timeout>=5000`, `SetMaxOpenConns(1)`, no `wal_checkpoint(TRUNCATE)`/`VACUUM`.
- **Cache/invalidation (§4).** OpenCode's running process re-reads `session`
  from the DB on every `/session` list/get (no in-memory cache), so the direct
  write is immediately visible. vh-solara MAY optimistically flip its own cached
  flag but need not for correctness (and will NOT receive a push event for the
  direct write).
- **Clobber caveat (§5).** No persistent in-memory cache to clobber us. A
  concurrent `patch`-based op that straddles our write (reads before, publishes
  after) can re-write the stale archived timestamp. Low-likelihood for idle
  archived sessions; mitigated by idempotent `WHERE ... AND time_archived IS NOT
  NULL` and/or a post-write re-verify.
- **Drift handling (§6).** Runtime `PRAGMA table_info(session)` self-check
  against the captured contract (table `session`, column `time_archived` INTEGER
  nullable); on mismatch, refuse the write and surface a loud "OpenCode schema
  changed" error. CI unit + negative tests. Manual re-validation procedure on
  every supported-version bump (the 4-step checklist in §6d), keyed to v1.17.14.
- **Explicit non-goals.** vh-solara does NOT read/write any other OpenCode table
  (message/part/project/...); does NOT run migrations or checkpoints; does NOT
  keep a long-lived second DB handle; does NOT attempt to reconcile
  `time_updated`. Future OpenCode versions may add a proper unarchive HTTP path
  (track issues #24153/#13964/#32355/#26078/#26552/#16000) — when shipped,
  retire this direct-write path in favor of it.

---

## 8. CONFIDENCE + GAPS

| # | Finding | Confidence | Type | Basis |
|---|---|---|---|---|
| 1 | DB = single global file; path = `Database.path()` over `$XDG_DATA_HOME/opencode` \|\| `~/.local/share/opencode`, file `opencode.db` (channel/`OPENCODE_DB` branches) | **high** | fact | `database.ts` + `global.ts` + `xdg-basedir` source, all read at v1.17.14 |
| 2 | `xdg-basedir` does NO platform branching (macOS uses `~/.local/share`, not `~/Library/...`) | **high** | fact | sindresorhus/xdg-basedir `index.js` source |
| 3 | target = `session.time_archived` (INTEGER, nullable, unindexed); UPDATE = `SET time_archived = NULL WHERE id = ?`; row id == session id | **high** | fact | `session/sql.ts` SessionTable + `session.ts` fromRow/toRow at v1.17.14 |
| 4 | "active" = `time_archived IS NULL`; clearing must be NULL (not 0) | **high** | fact | `listGlobal` `isNull(...)` + `fromRow` `?? undefined` at v1.17.14 |
| 5 | OpenCode pragmas: WAL / synchronous=NORMAL / busy_timeout=5000 / foreign_keys=ON / passive checkpoint at start | **high** | fact | `database.ts` layer + `sqlite.node.ts` nativeLayer at v1.17.14 |
| 6 | Recommended driver `modernc.org/sqlite` (pure Go) for single-binary distribution | **high** | inference (strong) | vh-solara release model (AGENTS.mission.md) + driver landscape; cgo would break cross-compile/static build |
| 7 | Running OpenCode sees the direct write on next `/session` read (no in-memory cache) | **high** | fact | `session.ts` `get`/`list`/`listByProject` are fresh `SELECT` each call at v1.17.14 |
| 8 | No persistent in-memory cache clobber; only narrow read-modify-write race via concurrent `patch` | **high** | inference (strong) | `projector.ts` Updated-handler writes all cols from event; `patch` re-reads current from DB before publishing (v1.17.14) |
| 9 | No auto-clobber of archived sessions from background events | **medium-high** | inference | no scheduler/loop in source republishes session.updated for idle archived sessions; usage projectors don't touch time_archived |
| 10 | Migrations alter DDL only; a direct UPDATE is not intercepted/rejected | **high** | fact | `migration.ts` apply/applyOnly run TS up() on open; no row-content gate |
| 11 | Runtime `PRAGMA table_info(session)` self-check is the right drift signal | **medium** | recommendation | consistent with upstream migration bootstrapper introspection; stable across SQLite versions; false-positive rate low |
| 12 | Path NOT derivable from workspace directory alone; needs home + env + channel (or `opencode db path`) | **high** | fact | `Database.path()` references none of the workspace dir inputs |

### Gaps / not verified
- Did not execute any path (read-only source study). The "running process sees
  the write" claim (§4) rests on source showing fresh-SELECT semantics + SQLite
  WAL read visibility rules, not a live repro. WAL reader-visibility of a *second
  process's* committed write is standard SQLite behavior (documented), so
  confidence is high but unexercised in this study.
- The exact set of migration ids at v1.17.14 was not enumerated (not needed for
  the write's correctness; offered only as an optional extra drift signal in §6e).
- Did not benchmark modernc vs cgo for the unarchive workload (single point
  UPDATE — performance is a non-issue; choice rests on distribution model).
- vh-solara's current process/env inheritance from `opencode serve` (whether
  vh-solara can reliably read the same `XDG_DATA_HOME` / `OPENCODE_DB` the server
  sees) was NOT studied here — that is a vh-solara-side architecture question for
  the build agent. If vh-solara cannot inherit that context, the `opencode db
  path` shell-out (§1c) or an operator-config DB path is required.

---

## Findings

- **(finding)**: source=sst/opencode v1.17.14 database.ts `path()` + global.ts + xdg-basedir, confidence=high, type=fact — DB is one global file; `dataDir = $XDG_DATA_HOME ?? ~/.local/share` (NO platform branching); file `opencode.db` (or `OPENCODE_DB` / channel-override branches).
- **(finding)**: source=sst/opencode v1.17.14 session/sql.ts SessionTable, confidence=high, type=fact — table `session`, column `time_archived` `integer()` nullable unindexed; row PK `id` = session id.
- **(finding)**: source=sst/opencode v1.17.14 session.ts fromRow/toRow + listGlobal, confidence=high, type=fact — active = `time_archived IS NULL`; clear = NULL; the minimal safe UPDATE is `UPDATE session SET time_archived = NULL WHERE id = ?`.
- **(finding)**: source=sst/opencode v1.17.14 database.ts layer + sqlite.node.ts, confidence=high, type=fact — OpenCode opens WAL with synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON, passive checkpoint; a second WAL writer with busy_timeout>=5000 coexists safely.
- **(finding)**: source=sst/opencode v1.17.14 session.ts get/list/listByProject, confidence=high, type=fact — the running process re-reads `session` from DB on every call (no in-memory cache); the direct write is immediately visible to `/session`.
- **(finding)**: source=sst/opencode v1.17.14 projector.ts Updated-handler + session.ts patch, confidence=high, type=inference — no persistent in-memory clobber; only a narrow concurrent-patch read-modify-write race.
- **(finding)**: source=sst/opencode v1.17.14 cli/cmd/db.ts, confidence=high, type=fact — `opencode db path` prints the exact resolved DB path; vh-solara should prefer it over re-implementing the resolution to avoid drift.
- **(finding)**: source=AGENTS.mission.md (vh-solara single-binary release model) + Go-driver landscape, confidence=high, type=inference — `modernc.org/sqlite` (pure Go) is the correct driver; cgo (`mattn/go-sqlite3`) would break the cross-compile/static distribution.
- **(finding)**: source=sst/opencode v1.17.14 migration.ts, confidence=high, type=fact — migrations alter DDL only; no migration intercepts/rejects a direct UPDATE; `migration` table + `session`-table existence are usable drift signals.

## Contradictions
- **"macOS uses `~/Library/Application Support`" vs OpenCode reality**: conventional wisdom says macOS apps use `~/Library/Application Support`; OpenCode uses `xdg-basedir` which is XDG-spec-literal and resolves to `~/.local/share/opencode` on macOS unless `XDG_DATA_HOME` is set. **Resolved — OpenCode source wins.** Flag in the coupling doc: do NOT assume `~/Library/...` on macOS.
- **None detected** between v1.17.14 and master on any of: `Database.path()`, pragmas, `session` table, `time_archived` column, get/list cache-free behavior, projector Updated handler. (Minor refactor differences in layer wiring — `node`/`makeGlobalNode` vs `defaultLayer` — are irrelevant to path/pragma/SQL behavior.)

---

## Recommended next specialist / command

`planner` → `build` to implement the unarchive against this spec, in this order:
1. resolve DB path (prefer `opencode db path` shell-out; Go fallback per §1b);
2. add `modernc.org/sqlite` dependency + open helper with the §3b pragmas;
3. implement the §6a runtime `PRAGMA table_info(session)` self-check + the §2d
   UPDATE with `rowsAffected==1` verification;
4. add the §6c CI tests (positive + negative/drift) and the §7 coupling doc;
5. wire the unarchive call site that currently sends the broken PATCH.

This packet is the evidence base for that slice; it is **not** active repo policy.
The live promotion targets are `docs/architecture/opencode-sqlite-unarchive.md`
(new) and a version pin in `docs/architecture/coordination-api.md`.
