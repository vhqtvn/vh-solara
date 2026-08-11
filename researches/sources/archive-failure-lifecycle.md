# Archive failure-record lifecycle — 7-question evidence packet

**Scope:** failure-record lifecycle for the archive-defect-chain arc (committed
`2cefbcd`→`cfbe254`→`933ebaa`→`0ef2c06`). Feeds a `debate` rerun on the
`ArchiveFailureBanner` build.

**Evidence tier:** static code read (file:line throughout). No runtime
verification. Where a question requires runtime behavior, it is marked
`build-validate`.

**Recency:** stable — read against the current tree (no external sources).

---

## Q1 — Success hook (the clear signal)

**Answer:** There IS a single chokepoint for the clear: the success block at
`pkg/web/archive.go:309` (`if s.archiveOneID(...) {`). All three success
branches inside `archiveOneID` funnel through it — 200-ok (archive.go:377-378),
404/410 ghost (archive.go:383-386), 409-already-archived (archive.go:391-394).
The cleanup (`RemoveSessionIfPresent` + `CleanupSession`) and
`succeededSet[id]=true` run inside that block (archive.go:320-326). A
failure-record clear for `id` should fire at the TOP of that block (after
`archiveOneID` returned true). "200 accepted" by the HTTP handler
(archive.go:251) is NOT a clear signal — the cascade is async.

**Evidence:**
- `pkg/web/archive.go:309` — `if s.archiveOneID(bgCtx, agg, id, ...) {` (single success chokepoint)
- `pkg/web/archive.go:377-378` — `err == nil { return true }` (200-ok success)
- `pkg/web/archive.go:383-386` — 404/410 ghost → `return true`
- `pkg/web/archive.go:391-394` — 409 + `idArchivedInOpenCode` → `return true`
- `pkg/web/archive.go:320-326` — success-side cleanup + `succeededSet[id]=true`
- `pkg/web/archive.go:251` — `writeJSONResp(... "affected": affected)` (the 200-accepted response; NOT a clear signal)
- Success branches inside `archiveOneID` converge to ONE return-true → ONE success block. No multi-siting required.

**Confidence:** high.
**Type:** fact (read).
**Test-gap:** no existing test exercises a clear of a prior failure record on
retry-success (the registry is append-only today — see Q2). A build must add a
test: (fail root → record present) → (retry succeeds) → (record cleared). No
test pins the "200-accepted is not a clear signal" invariant either.

---

## Q2 — Registry map-key + cross-project collision

**Answer:** The registry is a **SLICE**, not a map. `archiveFailures` is
`[]archiveJobFailure` (`pkg/web/server.go:322`), and `recordArchiveFailure`
APPENDS (`pkg/web/archive.go:478`). There is NO map key, NO dedup, NO upsert.
The brief's phrase "archiveFailures map" is imprecise. The registry is
SERVER-GLOBAL — one slice on the `Server` struct for ALL projects. The record
struct (`pkg/web/archive.go:71-76`: `ID`, `Reason`, `RootSrc`, `At`) has NO
project-dir field. Consequences: (1) a root that fails, is retried, and fails
again produces TWO records with the same `ID`. (2) `ses_abc` failing in two
project-dirs produces two records that cannot be disambiguated by project. (3)
Cross-MACHINE collision is impossible — each machine runs its own `vh-solara`
binary with its own `Server`; but one operator UI driving N workers sees N
independent registries.

**Evidence:**
- `pkg/web/server.go:321-322` — `archiveFailuresMu sync.Mutex` / `archiveFailures []archiveJobFailure` (SLICE, server-global, single mutex)
- `pkg/web/archive.go:71-76` — `archiveJobFailure{ID, Reason, RootSrc, At}` (NO project-dir field)
- `pkg/web/archive.go:476-482` — `recordArchiveFailure`: `s.archiveFailures = append(...)` (the SINGLE append site; no dedup)
- `pkg/web/archive.go:488-494` — `ArchiveFailures()`: snapshot copy (the SINGLE read site)
- Confirmed by grep: the ONLY mutation of `s.archiveFailures` anywhere in `pkg/web/` is the `append` at archive.go:478. No `delete(s.archiveFailures, …)`, no `= nil`, no clear, no evict. **Strictly append-only.**

**Confidence:** high.
**Type:** fact (read + grep).
**Test-gap:** no test exercises (a) duplicate-id records from a retry, (b)
cross-project recording, or (c) any clear. All existing tests
(`archive_job_test.go`, `archive_orphan_test.go`) only assert presence/absence
of an id in `ArchiveFailures()` after a single failure.

---

## Q3 — project_dir availability at the recording site

**Answer:** Project identity is available at the recording site WITHOUT adding a
new parameter. `handleArchive` computes `dir := reqDir(r)` (archive.go:99) and
passes `dir` into `runArchiveCascade` (archive.go:249). `runArchiveCascade`
receives `dir string` in its signature (archive.go:285) and passes it down to
the per-id loop. `classifyArchiveFailure` (archive.go:438) →
`recordArchiveFailure` (archive.go:449,476) is the call chain; threading `dir`
into `recordArchiveFailure` is a one-line change because `dir` is already in
scope at every call site. Additionally `agg.Directory()` (aggregator.go:253)
returns the project dir from the aggregator itself.

**Evidence:**
- `pkg/web/archive.go:99` — `dir := reqDir(r)`
- `pkg/web/archive.go:249` — `go s.runArchiveCascade(bgCtx, agg, affected, body.SessionID, dir, delay, cfg)` (dir threaded)
- `pkg/web/archive.go:285` — `func (s *Server) runArchiveCascade(bgCtx, agg, affected, srcID, dir string, ...)` (dir in scope)
- `pkg/web/archive.go:438` — `classifyArchiveFailure(agg, id, srcID, reason, …)` (called from archiveOneID which is called from runArchiveCascade; dir in the caller's scope)
- `pkg/web/archive.go:449` — `s.recordArchiveFailure(id, srcID, reason)` (the call to extend; dir NOT currently passed)
- `pkg/web/archive.go:476` — `func (s *Server) recordArchiveFailure(id, srcID, reason string)` (signature to extend)
- `pkg/aggregator/aggregator.go:253` — `func (a *Aggregator) Directory() string { return a.client.Directory }` (alternative source of dir)
- `pkg/web/server.go:1407-1412` — `reqDir` resolves dir from `?dir=` query or `x-opencode-directory` header

**Confidence:** high.
**Type:** fact (read).
**Test-gap:** none — this is a structural availability claim, not a behavior.

---

## Q4 — Out-of-band resolution (stale-record invalidation)

**Answer:** Two candidate clear-hooks exist for OOB resolution, BOTH carrying
race risk against a concurrent bg retry. (1) **Delete handler**:
`pkg/web/delete.go:115` calls `agg.Store().RemoveSessions(affected)`, which
calls `deleteSessionLocked` (`pkg/state/reducers.go:592`) → emits
`KindSessionDelete` (`pkg/state/store.go:25`). A clear-hook here would fire for
each deleted id. (2) **Tree-reconcile ghost detection**:
`pkg/state/tree_reconcile.go:84-86` — a session in our store but GONE from
OpenCode's `/session` list (and not tombstoned) is `deleteSessionLocked`'d →
emits `KindSessionDelete`. A stuck root later deleted directly in OpenCode
WOULD be caught here on the next 5s tick. BUT: the registry lives on the
`Server` struct (`pkg/web`), while the ghost-detection emit happens in
`pkg/state` (deeper layer with no handle on the registry) — a clear-hook there
needs a callback or a downstream listener. The re-PATCH clobber path
(`pkg/aggregator/reconciliation.go:131-135`) is NOT relevant — it only
re-PATCHes tombstoned ids, and a stuck root is NOT tombstoned (archive failed,
so `RemoveSessionIfPresent`/`RemoveSessions` never ran for it). **Race risk:**
both candidate hooks can fire WHILE a bg cascade job is mid-retry for the same
id (the bg job runs under `bgCtx`, independent of the request that triggered
the OOB delete/reconcile). The RACE-FREE clear-hook is INSIDE the success path
of `runArchiveCascade` (Q1, archive.go:309) — same goroutine, no race.

**Evidence:**
- `pkg/web/delete.go:115` — `agg.Store().RemoveSessions(affected)` (delete-handler clear-hook candidate)
- `pkg/state/store.go:1313-1323` — `RemoveSessions` → `deleteSessionLocked` (fires KindSessionDelete)
- `pkg/state/reducers.go:592` — `deleteSessionLocked` (emits the delete event)
- `pkg/state/tree_reconcile.go:84-86` — ghost detection: `deleteSessionLocked(id)` for store-present/OpenCode-gone/non-tombstoned ids (reconcile clear-hook candidate; but lives in pkg/state, no registry handle)
- `pkg/aggregator/reconciliation.go:131-135` — re-PATCH clobbered archives (NOT relevant: tombstoned-only; a stuck root is not tombstoned)
- `pkg/web/archive.go:238-249` — bg job launched under `bgCtx` (independent of request ctx; the source of the race against OOB hooks)
- `pkg/state/store.go:1572-1581` — `RemoveSessionIfPresent` (the CAS archive removal; tombstones ALWAYS, even for an absent id — so a tombstone is NOT proof of archive success for a stuck root)

**Confidence:** high (for the candidate identification and the race); medium (for the "reconcile catches a directly-deleted root" claim — that is an inference from tree_reconcile.go:77-87 + the /session list semantics, not a tested path).
**Type:** fact (read) for delete-handler + race; inference for reconcile-catches-OOB-delete.
**Test-gap:** no test exercises (a) OOB-delete of a stuck root, (b) reconcile
ghost-detection of a stuck root that was deleted in OpenCode, or (c) the race
between a clear-hook and a concurrent bg retry. A build must add tests for
all three.

---

## Q5 — Eager-prune + tree re-entry

**Answer:** The eager prune is at `web/src/archive.ts:96`
(`pruneSessionDeleted(id)` per affected id on the 200 response). It routes
through `projectSessionRemoval` (`web/src/sync/reducers.ts:181`), which does
`delete s.sessions[id]` (`reducers.ts:190`). A later `session.upsert` for the
SAME id RE-INSERTS unconditionally (`reducers.ts:209-211`:
`s.sessions[payload.id] = payload`) — there is NO guard checking "was this
pruned by archive." So a retained-but-failed root CAN re-enter the client tree.
BUT the server does NOT proactively re-emit for retained-but-failed roots: the
tree-reconcile (`pkg/state/tree_reconcile.go`) emits `node.remove` only for
ghosts (store-present/OpenCode-gone) and re-PATCHs only clobbered-archives — a
retained-but-failed root is NEITHER (it's store-present AND OpenCode-present,
and not tombstoned). So re-entry happens ONLY via (a) a fresh snapshot on
client reconnect/resync (the server snapshot includes it because it's still in
the server store) or (b) an OpenCode-originating `session.updated` for that id
(e.g. an activity change). Between the eager-prune and such an event, the
client tree does NOT contain the retained root. **CONCLUSION:** the banner
CANNOT reliably anchor to the tree node — the tree may or may not contain the
retained root depending on timing/reconnect. The banner MUST render from the
failure DTO independently of the tree.

**Evidence:**
- `web/src/archive.ts:84-97` — eager prune: `clearReadAnchors`, `clearQueueCache`, `markRead`, `pruneSessionDeleted(id)`
- `web/src/sync/reconcile.ts:289-294` — `pruneSessionDeleted` → `projectSessionRemoval` (no cursor bump, no updating indicator)
- `web/src/sync/reducers.ts:181-199` — `projectSessionRemoval`: `delete s.sessions[id]` + per-session metadata prune + `session-removed` effect
- `web/src/sync/reducers.ts:209-211` — `projectSessionEvent` "session.upsert": `s.sessions[payload.id] = payload` (UNCONDITIONAL re-insert; no archive-prune guard)
- `pkg/state/tree_reconcile.go:77-87` — ghost detection (emits KindSessionDelete for store-present/OpenCode-gone only; NOT for retained-and-present)
- `pkg/state/tree_reconcile.go:94-98` — clobber detection (tombstoned-only; a retained-but-failed root is not tombstoned)
- `pkg/web/archive.go:320` — `RemoveSessionIfPresent(id)` (the retained root is NEVER RemoveSessionIfPresent'd on failure → stays in server store → can re-enter client via snapshot)

**Confidence:** high.
**Type:** fact (read) for the eager-prune + unconditional-upsert; inference for "no proactive re-emit" (from reconcile's documented scope).
**Test-gap:** no web test exercises (a) eager-prune followed by a snapshot
re-inserting the retained root, or (b) eager-prune followed by a
session.updated re-inserting it. A build must add a web unit test for both
re-entry paths to pin the "banner must be tree-independent" decision.

---

## Q6 — SSE stream project-scoping + snapshot extension points

**Answer:** The `/vh/stream` connection IS project-scoped: the subscribe channel
`ch` comes from `agg.Store()` (one `state.Store` per project —
`NewForDirectory` at aggregator.go:238-249 creates a fresh `state.New()` per
aggregator). An `EmitTransient` on store X reaches only X's subscribers
(`pkg/state/subscriptions.go:227-257`). TWO fan-out precedents exist: **pins**
are worker-wide → `FanOutPinsUpdate` (`pkg/web/pins_http.go:329-353`) iterates
ALL `s.aggs` and calls `EmitTransient(kindPinsUpdated, raw)` on every store;
the bootstrap `pins.snapshot` (`pkg/web/server.go:2535-2536`) reads from
`s.pins.Snapshot()` (worker-wide). **labels** are per-project →
`fanOutLabelsUpdate(dir, cur)` (`pkg/web/server.go:1087+`) fans out to ONE
store; the bootstrap `labels.snapshot` (`server.go:2556-2564`) reads from
`s.labelsForDir(reqDir(r))`. The extension point for an
`archive-failures.snapshot` is right after the labels.snapshot block
(`server.go:2564`), before `flusher.Flush()` (`server.go:2565`). The update
extension is a new `kind` const + an `EmitTransient` call at the record/clear
sites (archive.go:478 + Q1 clear site). Client-side:
`web/src/sync/tree-transport.ts:1287-1352` `registerAuxiliaryListeners` is the
listener-registration point — add `archive-failures.snapshot` +
`archive-failures.updated` listeners mirroring the pins/labels pattern. **The
extension is CLEAN and mechanical** (snapshot-block + EmitTransient + listener
triplet) IF the scoping decision is made: worker-wide (like pins — simpler,
registry already worker-wide) or per-project (like labels — requires dir on the
record per Q2/Q3 and a filter at fan-out).

**Evidence:**
- `pkg/state/subscriptions.go:227-257` — `EmitTransient` (per-store fan-out; reaches only that store's subscribers)
- `pkg/state/subscriptions.go:339-366` — `Subscribe`/`SubscribeWith` (subscriber registration on a single store)
- `pkg/aggregator/aggregator.go:238-249` — `NewForDirectory`: one `state.New(ringCapacity)` per aggregator (per-project store)
- `pkg/web/server.go:2535-2536` — `pins.snapshot` bootstrap (worker-wide payload: `s.pins.Snapshot()`)
- `pkg/web/server.go:2556-2564` — `labels.snapshot` bootstrap (per-project payload: `s.labelsForDir(reqDir(r))`)
- `pkg/web/server.go:2565` — `flusher.Flush()` (the snapshot-bootstrap boundary; new snapshot goes before this)
- `pkg/web/server.go:2580-2594` — live-tail forwarding: `KindNotice`/`kindPinsUpdated`/`kindLabelsUpdated` forwarded with no id line, no baseline guard
- `pkg/web/pins_http.go:329-353` — `FanOutPinsUpdate` (worker-wide: iterates `s.aggs`, `EmitTransient` on every store)
- `pkg/web/pins_http.go:58` — `const kindPinsUpdated = "pins.updated"` (the precedent for a new kind const)
- `pkg/web/labels_http.go:51` — `const kindLabelsUpdated = "labels.updated"`
- `pkg/web/server.go:1087-1099` — `fanOutLabelsUpdate` doc (per-project fan-out to ONE store via `aggForExisting(dir)`)
- `pkg/web/server.go:1462,1468` — `mux.HandleFunc("/vh/pins", …)`, `mux.HandleFunc("/vh/labels", …)` (the HTTP read/write endpoints; an archive-failures banner may not need a PUT endpoint — snapshot+update only)
- `web/src/sync/tree-transport.ts:1298-1320` — `pins.snapshot` + `pins.updated` listeners
- `web/src/sync/tree-transport.ts:1329-1352` — `labels.snapshot` + `labels.updated` listeners

**Confidence:** high.
**Type:** fact (read) for the precedents and extension points; inference for "clean/mechanical" (based on the identical structure of the two existing domains).
**Test-gap:** no test pins the snapshot/bootstrap ordering for a THIRD domain,
or the fan-out scoping choice. A build must add (a) a Go test that an
archive-failures.snapshot fires on connect and an archive-failures.updated
fires on record/clear, and (b) a web test that the listeners apply both frames.

---

## Q7 — Failure-reason safety for operator display

**Answer:** The registry stores a **CLASSIFIED** reason, NOT the raw error.
`recordArchiveFailure` is called with one of three classified strings:
`fmt.Sprintf("permanent:%d", ocErr.Status)` (archive.go:398),
`"cancelled:shutdown"` (archive.go:411), or `fmt.Sprintf("exhausted:%d",
cfg.budget)` (archive.go:416). The raw `opencode.Error` (client.go:197-208:
`Status`, `Op`, `Body`) is NEVER stored in the registry — `Body` is the raw
OpenCode HTTP response body (2KB-capped at client.go:164-165). The raw error
appears ONLY in server-side `log.Printf` calls (archive.go:385, 588, 624) —
never in the registry, never on the wire. The raw `Body` does NOT contain: the
request body (vh-solara's PATCH body is a generated timestamp, no sensitive
data, client.go:152) or auth headers (request-side only). It COULD contain:
absolute repo paths IF OpenCode echoes them in error text (OpenCode-dependent,
not vh-solara-controlled), and the session id (in the `Op` string, but `Op` is
not stored in the registry either). There is NO existing
classification/redaction step — none is needed for the registry `Reason`. **RECOMMENDATION:**
display the classified `Reason` as-is (it's already safe: a short token like
`permanent:403` or `exhausted:5`). Do NOT pipe `opencode.Error.Body` into the
SPA. If richer detail is wanted, extend the classification (e.g. map 403 →
"forbidden", 400 → "bad request") but keep the raw body server-side-only.

**Evidence:**
- `pkg/web/archive.go:71-76` — `archiveJobFailure{ID, Reason, RootSrc, At}` (`Reason` is the classified string)
- `pkg/web/archive.go:396-399` — permanent case: `classifyArchiveFailure(..., fmt.Sprintf("permanent:%d", ocErr.Status), …)` (status only, body discarded)
- `pkg/web/archive.go:411` — shutdown case: `"cancelled:shutdown"` (literal)
- `pkg/web/archive.go:416` — exhausted case: `fmt.Sprintf("exhausted:%d", cfg.budget)` (budget only)
- `pkg/web/archive.go:449-450` — `recordArchiveFailure(id, srcID, reason)` + log of the classified `reason` (NOT the raw err)
- `pkg/web/archive.go:385` — `log.Printf("[archive] SetArchived(%s): %v …", id, err)` (raw err ONLY in log; this is the ghost-404 success-log path, not a failure record)
- `pkg/opencode/client.go:197-208` — `Error{Status, Op, Body}` + `statusErr` (Body = raw response, 2KB-capped)
- `pkg/opencode/client.go:151-167` — `SetArchived` request body: `{"time":{"archived":ts}}` (generated timestamp; no sensitive data)
- `pkg/opencode/client.go:164-165` — `io.ReadAll(io.LimitReader(resp.Body, 2048))` (Body size cap)

**Confidence:** high.
**Type:** fact (read).
**Test-gap:** no test asserts the registry `Reason` is a classified token (not
the raw body). A build should add a unit test that a 403 failure records
`Reason == "permanent:403"` (and never contains the raw OpenCode body), as a
regression guard against accidentally piping `opencode.Error.Body` into the
record.

---

## Consolidated test-gaps

A build of the `ArchiveFailureBanner` + clear-lifecycle must add tests for:

1. **Clear-on-success (Q1):** (fail root → record) → (retry succeeds) → record cleared. No existing test covers a clear at all (registry is append-only today).
2. **Registry data model (Q2):** (a) duplicate-id records from a retry (today produces 2; the build should decide: dedup-on-upsert or replace). (b) cross-project recording (today: 2 records, no project disambiguation). (c) clear-eviction (no site exists).
3. **OOB resolution (Q4):** (a) delete-handler clears a stuck root's record. (b) reconcile ghost-detection clears a stuck root's record (or explicitly does NOT, if the build scopes it out). (c) the race: a clear-hook firing while a bg job is mid-retry for the same id (the race-free contract is "clear only inside the bg job's success path").
4. **Tree re-entry (Q5):** (a) eager-prune → snapshot re-inserts the retained root. (b) eager-prune → session.updated re-inserts it. Pins the "banner must be tree-independent" decision.
5. **SSE extension (Q6):** (a) Go: archive-failures.snapshot on connect + archive-failures.updated on record/clear. (b) web: listeners apply both frames. (c) scoping decision pinned (worker-wide vs per-project).
6. **Reason safety (Q7):** registry `Reason` is the classified token, never the raw `opencode.Error.Body`.

## Contradictions

- **Brief's "archiveFailures map" vs actual slice.** The brief (and the task
  context) describes the registry as "an in-memory `ArchiveFailures()` registry
  (backed by `archiveFailures map` …)." It is actually a `[]archiveJobFailure`
  SLICE (`pkg/web/server.go:322`), append-only (`pkg/web/archive.go:478`). This
  matters for the build: a "clear" is not a `delete(map, key)` — it is a
  slice-filter/compaction under `archiveFailuresMu`. A retry that fails again
  does NOT overwrite; it appends a second record. The build must decide
  dedup-on-record vs dedup-on-read vs clear-on-success.

- **No other contradictions detected.** The brief's other settled assumptions
  (async cascade, retain-on-failure, never-orphan-flag-a-root,
  pins/labels-stream reuse) are all accurate against the current code.

## Build-blockers

- **Q1 does NOT block (single chokepoint confirmed).** The success block at
  `archive.go:309` is the clear site. No multi-siting required.
- **Q2 partially blocks the data-model design.** The slice-vs-map + missing
  project-dir + append-only-without-dedup means the build must FIRST decide:
  (a) add a project-dir field + composite identity, (b) switch to a map keyed
  by (dir,id) or keep the slice + filter, (c) dedup-on-record or
  clear-on-success. This is a design decision for the debate rerun, not a
  code-trace gap.
- **Q3 does NOT block.** `dir` is available at every recording site without a
  new parameter.
- **Q4 partially blocks the OOB-clear design.** The race-free clear is inside
  the bg job (Q1 site). An OOB clear (delete handler / reconcile) is racy
  against a concurrent retry — the build must decide whether to (a) accept the
  race (a stale record may be cleared then re-recorded), (b) scope OOB-clear to
  post-bg-job-completion only, or (c) omit OOB-clear entirely and rely on
  retry-success + TTL. This is a design decision.
- **Q5 does NOT block but FORCES a design choice.** The banner MUST render from
  the failure DTO independently of the tree (the tree is unreliable for a
  retained-but-failed root). The build cannot anchor the banner to a tree node.
- **Q6 does NOT block (clean extension point confirmed).** The
  snapshot-block + EmitTransient + listener triplet is mechanical once the
  scoping decision (worker-wide vs per-project) is made. Scoping is coupled to
  Q2's data-model decision.
- **Q7 does NOT block.** The classified `Reason` is already safe for display.

**Net:** the two design decisions the debate rerun must settle are (1) the
registry data model (Q2: slice+filter vs map, dedup strategy, project-dir
field) and (2) the OOB-clear policy (Q4: race-accept vs post-job-only vs
omit). Everything else is mechanical.
