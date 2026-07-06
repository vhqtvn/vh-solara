# Two-slice web session-load perf fix + v1.36.0

**Status:** Shipped. `P1-AGG-007` closed `done` @ `2079e86`; tag `v1.36.0` →
`2079e86` on `main`. This checkpoint exists to make the design decisions and the
forward look durable — they currently live only in session context and would be
lost on archive.

## What shipped

A two-slice fix for vh-solara web session-open latency on large projects
(~190 sessions observed in the field), plus the v1.36.0 release cut on top of it.

### Slice 1 — `b92ca02` perf(state): add PendingPermissions()

`runPermissionReconcile` runs a per-project-dir `2s` ticker for process lifetime
and previously called `store.Snapshot(nil)` — building the entire materialized
view (~48 MB on a busy project: all messages/parts, full delta-flush, O(n) tree
walk) **under the store WRITE lock** — while reading only `snap.Permissions`. On
a busy project that stalls incoming OpenCode events and client session-opens.

- **Added** `Store.PendingPermissions()` (`pkg/state/store.go:958`, doc comment
  `944-957`) — copies the pending-permission set under `RLock`, with no message
  build, no flush, no tree walk.
- **Internal** `s.perms` is `map[string]map[string]json.RawMessage`; **public**
  return is `map[string][]json.RawMessage`, the slice shape matching
  `Snapshot.Permissions` exactly (outer map + each per-session slice are fresh
  allocations; the underlying `json.RawMessage` byte arrays are shared read-only).
- Includes `if len(m) == 0 { continue }` for exact byte-identical parity with
  `Snapshot.Permissions` (empty-inner-map sessions omitted).
- **Consumer** switched: `reconcileFailFastPerms` (`pkg/web/server.go:406`) now
  calls `store.PendingPermissions()`. The reject/fail-fast logic is
  byte-identical; only the data source changed.
- Snapshot itself intentionally unchanged in this slice (scoped in Slice 2).

### Slice 2 — `0e3c9dc` perf(state): scope Snapshot structural maps + delta flush

`Store.Snapshot(messagesFor)` (`pkg/state/store.go:1450`, doc comment `1433-1449`)
now scopes per-session structural maps AND the delta flush to **selected**
sessions:

- `scopeSelected := messagesFor != nil && len(messagesFor) > 0` (`store.go:1454`)
  gates every per-session structural map — Sessions / Gate / Questions / Activity
  / LastAgents / CurrentVerbs / Permissions / Todos / Statuses / Unread — via the
  `inScope(sid)` closure (`store.go:1458`).
- The `flushPartDeltasLocked` loop is gated to selected session IDs
  (`store.go:1481`) when `scopeSelected`.
- `nil` (firehose) and `{}` (Stream-1 tree owner) semantics **unchanged**.
- `computeSubtreeBusyLocked()` (`store.go:1515`) is **intentionally always
  global** even when `scopeSelected` (see Design Decision #2).

### Backlog

- `P1-AGG-007` (area `AGG`) filed `done` @ `2079e86`
  (`docs(backlog): file P1-AGG-007 (two-slice web session-load perf fix)`).

### Release — `v1.36.0`

- **Tag:** `v1.36.0` → `2079e86` (confirmed on remote).
- **Semver:** minor bump over `v1.35.3` @ `5ffad39`. 26 commits in
  `v1.35.3..v1.36.0`. The bump is driven by 2 `feat(projectcfg):` commits
  (`c5a481a` agentStyles split into gitignored preferences overlay; `3991a18`
  auto-migrate agentStyles to preferences.local.jsonc), web UX changes, and the 2
  perf slices. **No breaking changes.**
- **Release model:** tag-driven. Pushing `v*` triggers
  `.github/workflows/release.yml`, which stamps `cmd.Version` from the tag via
  ldflags. `release.yml` is **build-only — it runs no tests**.

## Key design decisions (durable rationale)

These are the point of this checkpoint. They currently live only in session
context.

### 1. Delta-flush scoping invariant (Slice 2) — safe by accumulator ownership

Scoping the `flushPartDeltasLocked` flush to selected sessions does **not** drop
unselected sessions' buffered deltas. `flushPartDeltasLocked`
(`store.go:1357-1387`) **KEEPS accumulators across a flush** (doc `1357-1365`):
it rebuilds `me.parts` from `deltaBuf` and `SET`s the field from the full
accumulated text, never deleting the buffer. Only `discardPartDeltaLocked`
(`store.go:1393`) deletes delta buffers, and it is **not** called on a Snapshot
flush (only on authoritative overwrite or part deletion). Therefore unselected
buffered deltas survive a scoped Snapshot and converge on the next
`Snapshot(nil)` / `Snapshot({})`.

Pinned by `TestSnapshotScopedFlushConverges` (`pkg/state/store_test.go:1124`),
which is **non-vacuous**: it stretches the throttle window to `time.Hour` so all
deltas after the first stay buffered (2 deltas/session: `A1`/`A2`, `B1`/`B2`),
asserts the scoped flush materializes `"a"` (`A1A2`) AND a later `Snapshot(nil)`
converges `"b"` (`B1B2`) — proving no data loss.

### 2. `computeSubtreeBusyLocked()` intentionally stays GLOBAL

A selected session's `subtree_busy` depends on its **descendants**, which may be
**unselected**. Scoping the subtree-busy walk for more perf would compute
`subtree_busy` over an incomplete tree — a **correctness bug**, not a perf win.
Only the per-session Gate *read* into `snap.Gate` is gated by `inScope`
(`store.go:1517`); the walk itself (`store.go:1515`) runs over the full session
forest every time.

**Do NOT attempt to scope this walk without redesigning `subtree_busy` semantics.**

### 3. `Unread` is now scoped on selected snapshots (Slice 2) — quiet behavior change

Before Slice 2, a selected (`len > 0`) Snapshot shipped the full `Unread` set;
after, only the selected sessions' `Unread` entries ship. This is **safe today**
because no scoped-snapshot consumer reads the full `Unread` set:

- `applySessionSnapshot` / `fetchSessionMessages` in `web/src/sync/stream.ts`
  read only `messages[id]` + `gate[id].messagesLoaded` (verified: `stream.ts:528`
  reads `snap.gate?.[id]?.messagesLoaded`); they never touch `snap.Unread`.
- The tree consumer (`applySnapshot` in the session-list view) only ever receives
  `nil` / `{}` — never a scoped snapshot.
- `pkg/alerts/engine.go:143` calls `w.store.Snapshot(map[string]bool{})` — the
  `{}` tree-owner path, **unaffected** by Slice 2 scoping, so alerts always
  observe the full `Unread` set regardless.

**Caveat for future work:** a consumer expecting the full `Unread` set from a
scoped (`len > 0`) snapshot would silently break. Revisit this contract if such a
consumer is ever added.

### 4. Filter semantics preserved (the three load-bearing shapes)

- `messagesFor == nil` → **firehose** (every session's messages AND structural
  rows). Used by `?sessions=all`. Unchanged.
- `messagesFor != nil && len == 0` (`{}`) → **Stream-1 tree owner**: the FULL
  structural tree for ALL sessions but NO messages. The session-list view.
  Unchanged.
- `messagesFor != nil && len > 0` → **Stream-2 "open one session"**: SCOPE. Only
  the selected sessions' structural rows AND messages ship.

Live-stream `Interest` / `sendable` filtering is untouched.
`/vh/snapshot` synchronous hydration semantics are untouched.

## Validation state at checkpoint time

- **Go:** freshly green — `go build ./...`, `go test ./...` (all packages `ok`),
  `gofmt -l pkg cmd main.go` clean. (Verified at the Slice 2 closeout; the two
  perf slices land `pkg/state/store.go` + `pkg/web/server.go` + 2 test files only.)
- **vitest (SPA unit):** 160/160 green per the prior backlog closeout. **Not
  re-run** for this fix (no SPA source changed in either slice).
- **Playwright e2e:** **not freshly verified.** Known pre-existing flakes:
  `P1-WEB-032` (a deterministic test-6 hard-bug — **test-only, NOT a shipped-code
  defect**) and stochastic scroll-follow flakes. Both are **immaterial to
  v1.36.0** because `release.yml` runs no tests.

## Forward look (conditional — NOT backlog-ready)

These notes intentionally live here and **not** in `docs/planning/backlog.md`.
They fail the backlog Definition of Ready (no concrete slice / file scope /
validation plan yet) until their promotion predicate fires.

### Next latency lever: transcript pagination / incremental hydration

Even after scoping, a large selected transcript (~3.86 MB observed on a big
session) still drives a large phone-side `JSON.parse` on open. **Transcript
pagination or incremental hydration is the next latency lever** if phone-side
open-session latency is still unacceptable after these slices.

This is a **design question** (pagination cursor vs incremental hydration), **not
lock sharding**.

- **Promotion predicate:** promote to a `backlog.md` row when post-fix validation
  on a large project (e.g. ~189 sessions) shows phone-side open-session latency
  is still unacceptable. Until that trigger fires, this stays a forward-look note.
- **Explicitly deferred (out of scope for this fix):** lock sharding, per-session
  locks, copy-on-write store architecture, and a pprof endpoint.

### Optional test polish (non-blocking)

`TestSnapshotScopedOmitsUnselected` (`pkg/state/store_test.go:1053`) currently
asserts scoping for Sessions / Gate / Permissions / Questions / LastAgents /
Activity only — it does **not** explicitly assert `Unread`, `CurrentVerbs`, or
`Statuses` scoping. Those are covered only transitively via the shared
`inScope`-gated loop. A non-blocking follow-up would add explicit assertions for
the three maps the test does not name.
