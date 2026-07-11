# OpenCode direct-SQLite unarchive — coupling contract

> **validatedAgainst:** `opencode v1.17.18` (sst/opencode tag v1.17.18, Jul 6 2026)
>
> Evidence base: [`researches/sources/opencode-unarchive-patch-audit.md`](../../researches/sources/opencode-unarchive-patch-audit.md) (why HTTP unarchive is impossible) and [`researches/sources/opencode-sqlite-unarchive-spec.md`](../../researches/sources/opencode-sqlite-unarchive-spec.md) (the full DB-path/driver/SQL/concurrency/drift spec this code implements). Every path/schema/pragma claim below is cited to those packets.

## Why this boundary exists

OpenCode 1.17.x has **no HTTP mechanism to unarchive a session**.

`PATCH /session/:id {"time":{"archived":null}}` returns **400 BadRequest**: the
request payload schema (`UpdatePayload.time.archived`) is
`Schema.optional(Schema.Finite)`. Effect's `Schema.optional` means the *key* may
be absent (→ `undefined`); a *present* value must decode under `Schema.Finite`,
which **rejects `null`**. The decode failure short-circuits before the handler
runs, so no state change occurs and the session stays archived. There is no
dedicated archive/unarchive/restore endpoint either — `SessionPaths` lists
`list, status, get, children, todo, diff, messages, message, create, remove,
update, fork, abort, share, init, summarize, prompt, promptAsync, command, shell,
revert, unrevert, permissions, deleteMessage, deletePart, updatePart` and nothing
else.

Even if the payload decoded, the handler only calls `session.setArchived` when
`ctx.payload.time.archived !== undefined`, and the service layer only clears the
archive when `setArchived({ time: undefined })`. The guard and the clear-condition
are mutually exclusive on the HTTP path: **only an internal caller can clear.**

The only semantically-correct clear is `time_archived = NULL`, which matches
OpenCode's own authoritative definition of active (`listGlobal`:
`isNull(time_archived)`). So vh-solara writes that value **directly** to
OpenCode's SQLite DB.

**Archiving (setting a timestamp) is unchanged** — `POST /vh/archive` still issues
a working HTTP `PATCH` with a finite timestamp value, which decodes and stores
fine. Only the *clear* goes through the direct-DB path.

## The coupling surface (validated @ v1.17.18)

`pkg/opencode/db.go` depends on exactly three things:

1. **DB file path** = `Database.path()`:
   - data dir = `$XDG_DATA_HOME/opencode` else `~/.local/share/opencode`
     (`xdg-basedir` is XDG-spec-literal — **no platform branching**; macOS uses
     `~/.local/share/opencode`, *not* `~/Library/Application Support`).
   - default file `opencode.db`; `OPENCODE_DB` (absolute / relative / `:memory:`)
     and the installation channel (`opencode-<channel>.db` for non-published
     channels) / `OPENCODE_DISABLE_CHANNEL_DB` select the filename.
   - Resolution method: `opencode db path` shell-out (preferred —
     identical-by-construction, drift-free), Go re-implementation (fallback), or
     `VH_OPENCODE_DB_PATH` (operator override).
   - **Topology scope:** the path-convergence guarantee — that all three
     resolvers land on the SAME file the running instance uses — holds ONLY for
     the **spawned/co-located topology** (the default). vh-solara inherits the
     same env the `opencode serve` process it spawns sees
     (`cmd.Env = os.Environ()`), so the resolver and the instance agree. In the
     **external topology** (`--opencode-url`), the session ids come from a REMOTE
     OpenCode instance but `ResolveDBPath` resolves a PROCESS-LOCAL file that is
     NOT guaranteed to be the remote instance's DB. The operator MUST set
     `VH_OPENCODE_DB_PATH` explicitly to bind the file (taking responsibility for
     the choice), or unarchive refuses fast — see `UnarchiveGuard` in
     `pkg/opencode/db.go` and the handler guard in `pkg/web/archive.go`.

2. **Table + column:** `session.time_archived` — drizzle `integer()` → SQLite
   type affinity `INTEGER`, **nullable** (`notnull = 0`), no default, unindexed.
   Row PK `id` = the session id vh-solara uses (`SessionTable.id` = `SessionID`).

3. **The UPDATE:**
   ```sql
   UPDATE session SET time_archived = NULL WHERE id = ?
   ```
   single-row (id is the PK → at most one match). `time_updated` is **intentionally
   NOT bumped** — a raw UPDATE bypasses Drizzle's `$onUpdate` hook, and re-ordering
   the session in `ORDER BY time_updated DESC` lists would be an unrelated semantic
   change (an unarchived session keeps its old list position).

## Runtime self-check (drift guard)

Before every UPDATE, `assertSessionSchema` introspects the live DB:

```sql
PRAGMA table_info(session)
```

and asserts the `session` table exists and has a column `time_archived` whose type
contains `INTEGER` and whose `notnull = 0`. On **any** mismatch it returns a loud
`*SchemaError` (naming this doc + `validatedAgainst = opencode v1.17.18`) and the
caller **refuses the write**. A future OpenCode that renames the column, retypes
it, or drops the table turns into a visible, localized refusal — never a silent
wrong-file or wrong-column write. `PRAGMA table_info` is used (not `sqlite_master`
DDL parsing) because it returns stable, parsed column metadata and matches how
OpenCode's own migration bootstrapper introspects tables.

## Concurrency contract

OpenCode runs the DB in **WAL** with `synchronous = NORMAL`,
`busy_timeout = 5000ms`, `foreign_keys = ON`, and a passive checkpoint at start.
vh-solara is a **second WAL writer** that coexists by matching those settings:

- Driver: `modernc.org/sqlite` (pure Go, driver name `sqlite`). Chosen over cgo
  `mattn/go-sqlite3` because vh-solara ships as a single static binary with
  tag-driven cross-compile releases — cgo would break `CGO_ENABLED=0` static
  builds and per-target cross-compilation.
- DSN: `file:<path>?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)`
- `db.SetMaxOpenConns(1)` — avoids self-contention for the write lock and keeps a
  single short-lived connection (open → self-check → UPDATE → close).
- **No** `wal_checkpoint(TRUNCATE/RESTART)` and **no** `VACUUM` — OpenCode owns
  checkpointing; a forced checkpoint while OpenCode holds the DB can stall.

## Batch semantics (partial-on-failure)

A multi-id unarchive (a session plus its archived subtree) issues one `UPDATE`
per id — **NOT** a single multi-row transaction. Wrapping the batch in one
transaction would hold the SQLite write lock across every id and risk a
deadlock/contention stall with the running OpenCode process; per-statement
autocommit keeps each write short. The tradeoff: a mid-batch error returns 502
with the earlier ids already committed.

**Recovery is idempotent and reaches the whole subtree on retry.** Re-clicking
Restore (unarchive) on a root re-computes its unarchive set by walking the FULL
session tree (parent links from all sessions the aggregator knows about, not
just the archived set) and collecting the root itself plus every member that is
still archived. So after a partial failure — e.g. the root unarchived but a
child errored mid-batch and stayed archived — the retry traverses through the
now-active root and still reaches that child, re-issuing its `UPDATE` (a no-op
re-write still reports `rowsAffected == 1` as long as the row exists), so the
batch completes. A non-archived descendant is never folded into a retry set (it
is already active); only genuinely archived members are collected. This is
**not** transactional atomicity — it is per-statement autocommit plus a
re-walkable, idempotent recovery path (see `archivedDescendants` in
`pkg/web/archive.go`).

## Cache / visibility

The running OpenCode process re-reads `session` rows **fresh from the DB on every
`/session` list and `get` call** (`session.list`/`listByProject`/`get` are plain
`SELECT ... FROM session` each time — no in-memory session cache). So a committed
`time_archived = NULL` write is visible to the next `/session` read immediately
(WAL readers see committed writes). The existing `Rehydrate` after the write is
sufficient; vh-solara does not need to mutate its own store for correctness (an
optimistic local flip is optional).

**The direct write emits NO `session.updated` event.** This is expected and fine —
the next re-hydration reconciles. Callers must not wait for a push that will never
arrive.

## Clobber caveat (read-modify-write race)

There is **no persistent in-memory cache** in OpenCode that could overwrite our
edit. The only clobber window is a classic read-modify-write race: a `patch`-based
op (e.g. `setTitle`/`touch`) that calls `get(sessionID)` *before* our UPDATE
commits, then publishes `session.updated` *after* — that event carries the stale
archived timestamp and the projector writes it back. **Likelihood is low:** an
archived session is by definition idle (no active run), so `touch` (which is
activity-driven) does not fire, and the realistic trigger is a user editing the
archived session's metadata from the OpenCode app at the exact instant vh-solara
unarchives. No background scheduler re-publishes `session.updated` for idle
archived sessions. If it happens, re-clicking unarchive self-corrects.

## Drift handling

Two layers, complementary:

1. **Runtime self-check** (above) — catches any schema mismatch at unarchive time
   and refuses loudly. This is what protects a real deployment.
2. **CI unit + negative tests** (`pkg/opencode/db_test.go`) — exercise the positive
   path (archive a row, unarchive, assert `time_archived IS NULL`,
   `rowsAffected == 1`, `time_updated` unchanged) and the negative/drift paths
   (rename the column, retype to TEXT, make it NOT NULL, drop the table — each
   must refuse with a `*SchemaError` that references this doc and the version).

### Re-validation procedure (run on every supported-OpenCode-version bump)

1. Re-read `packages/core/src/session/sql.ts` (`SessionTable`) at the new tag —
   confirm table still named `session`, column still `time_archived`, `integer()`,
   nullable, no new NOT NULL/CHECK/index the UPDATE would violate.
2. Re-read `packages/core/src/database/database.ts` (`path()` + pragma block) —
   confirm path resolution + pragmas unchanged; if `path()` logic changed, update
   the Go resolver / re-verify `opencode db path`.
3. Re-read `packages/opencode/src/session/session.ts` (`get`/`list`/`patch`) and
   `packages/core/src/session/projector.ts` (`Updated` handler) — re-confirm the
   cache-free read and the clobber window analysis still hold.
4. Bump the `validatedAgainst` / `opencodeValidatedTag` constant to the new tag
   and re-run `go test ./pkg/opencode/`.

## Non-goals

vh-solara does **not**:

- read or write any other OpenCode table (message / part / project / migration /
  usage / ...);
- run migrations or checkpoints;
- keep a long-lived second DB handle (the connection is short-lived per unarchive
  batch);
- reconcile or bump `time_updated`;
- attempt to clear the archive over HTTP (it cannot, against 1.17.x).

## Upstream tracking — retire this path when an HTTP unarchive ships

Track these OpenCode issues requesting unarchive/restore UI/behavior:
**#24153, #13964, #32355, #26078, #26552, #16000.**

The correct upstream fix is: change `UpdatePayload.time.archived` to
`Schema.optional(Schema.NullOr(Session.ArchivedTimestamp))` **and** add a handler
branch `if (ctx.payload.time.archived === null) setArchived({ time: undefined })`.
(Note: issue #24153's claim that "the backend already supports `archived: null`"
is **incorrect** — it conflates the *event* schema `UpdatedTime`, which wraps with
`NullOr`, with the *request* schema `UpdatePayload`, which does not.)

When that ships, retire `pkg/opencode/db.go`'s direct-write path in favor of a
plain HTTP PATCH, delete this coupling doc, and remove the `modernc.org/sqlite`
dependency.
