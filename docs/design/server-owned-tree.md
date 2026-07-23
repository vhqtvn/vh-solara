# Server-Owned Session Tree — Phase 1 Design

> **PLACEMENT NOTE:** This is the Phase 1 deliverable intended for
> `docs/design/server-owned-tree.md`. The researcher subagent that produced it
> is read-only (edit access limited to `tmp/**`), so it was written here. A
> write-capable agent (e.g. `docs-steward`/`build`) or the operator should move
> it to `docs/design/server-owned-tree.md` (creating the `docs/design/` dir)
> during review.

**Status:** Phase 1 DESIGN DOC ONLY. Read-only research + design. No code.
**Baseline HEAD:** `52a3fd0` (verified `git rev-parse --short HEAD`).
**Working tree note:** at baseline the tree was NOT clean — 9 pre-existing
modified files (`cmd/client-daemon.go`, `cmd/local-server.go`,
`pkg/web/archive.go`, `pkg/web/archive_orphan_test.go`,
`pkg/web/archive_reassert_test.go`, `pkg/web/queue_lifecycle_test.go`,
`pkg/web/queue_test.go`, `pkg/web/server.go`, `pkg/web/verbs_test.go`). These
are unrelated to this design and were not touched by this read-only task.
**Hard keep-out:** `web/src/lib/streamMd.ts` and `web/src/components/Part.tsx`
must NEVER be modified by this effort (WebRender / GPU stability — see
AGENTS.md → "Web frontend performance"). Phase 2/3/4 MUST route around them.

---

## 1. Context & bug cascade

### 1.1 Why this exists

The current "O1 collapsed-frontier projection" gives the client and server
**dual ownership** of tree structure. The server emits a *collapsed frontier*
(`SnapshotProjected`, `pkg/state/projection.go:523`) that materializes active
sessions as full `Session` objects and idle roots as `CollapsedBranchStub`
placeholders (`pkg/state/projection.go:21`); the client then *reconstructs* the
tree from the flattened `sessions[]` + `stubs[]` arrays
(`web/src/lib/reduce.ts:14` `buildChildrenIndex`), *infers* orphans
(`web/src/orphans.ts:34` `orphanSessions`), and *merges* projected snapshots
preserve-absent (`web/src/sync/stream.ts:683` `applyProjectedSnapshot`). Two
parties deriving structure from the same data inevitably drift, and they did.

### 1.2 The bug cascade being killed (with origin citations)

Each bug class below is traced to the specific code path that produces it under
dual ownership. The server-owned model removes the client-side derivation
entirely, so these cannot recur.

1. **False orphans** (including live-rooted sessions shown as orphans).
   Origin: `orphans.ts:34` `orphanSessions()` is a flat client scan — it flags
   any session whose `parentID` is set AND absent from `sessions`/`branchStubs`
   AND not `sessionWorking`. It cannot distinguish a *collapse-hidden* ancestor
   (still live) from a *genuinely orphaned* subsession. Fix: server computes
   orphans (§9) and sets `flags.orphan`; client only displays.

2. **Tree flatten on load.** Origin: `branchStubs` is ephemeral
   (`web/src/sync/store.ts:197`, deliberately not persisted) and the reconnect
   path re-emits a full `SnapshotProjected(...,"reconnect",...)`
   (`pkg/web/server.go:1494`) AFTER replay to rebuild those ephemeral stubs. A
   reload therefore loses the frontier and the full tree re-renders stale until
   the reconnect snapshot lands. Fix: never persist tree structure (§11);
   re-fetch the small frontier on load (§5); no "stub vs materialized" concept
   (§3) so there is nothing ephemeral to lose.

3. **Archived-session resurrection.** Origin: lazy-expand merge churn driven by
   `branchRequestGen` (`stream.ts:2768`/`:2820`) races the ghost/demotion
   reconcile loop (`stream.ts:826` `applyProjectedSnapshot`) and can re-insert a
   node the sweep just removed. Fix: deletes are authoritative `node.remove` ops
   the client applies verbatim (§7); no client-side reconcile/ghost logic.

4. **Subagent shown as root.** Origin: `buildChildrenIndex` orphan-promotes any
   child whose parent is absent to a root (`reduce.ts:21`). When the parent is
   merely collapse-hidden, the child wrongly surfaces at top level. Fix: server
   owns `parentId`; client renders by `parentId` and never promotes.

5. **Stub nodes lose agent chip / pins.** Origin: `CollapsedBranchStub`
   (`projection.go:21`) carries only `id/parentID/title/descendantCount/
   aggregateState/structuralRevision` — no `agent`, no `permissions`, no
   question/pending state — so a collapsed row cannot render its own chip or pin
   eligibility. Fix: every `Node` is self-contained (§3); "collapsed" is only a
   render attribute (`loaded:false`), not a node type, so a collapsed node still
   shows its agent/flags/pins.

6. **Demotion drift.** Origin: the active-closure descent
   (`projection.go:432` `computeActiveClosureLocked` / `:444`
   `descendActiveClosureLocked`) plus the shrink-only demotion sweep
   (`projection.go:259` `RunDemotionSweep` / `:295` `sweepOnce`) asynchronously
   demote/promote which sessions are "active" vs "stub", and the
   per-stream `sweepTicker` (`server.go:1640`) fans a re-projection on each
   advance of `DemotionGen` (`projection.go:210`). The frontier a client sees
   depends on sweep timing. Fix: no demotion/cutoff/closure concept at all
   (§12 Phase 4 delete inventory); the frontier is deterministic (§5).

---

## 2. Current-path reconnaissance

The precise map of what exists today. (Phase 4 delete targets are flagged
**[DELETE-P4]**; Phase 3 client delete targets **[DELETE-P3]**.)

### 2.1 Store + Phase-1 subtree indexes (REUSE — do NOT rebuild)

- `pkg/state/store.go` — the `Store`. Core types:
  - `ClientEvent` `store.go:120-145` (includes `FrontierChanged json:"-"` at
    `:144` — per-event flag stamped at emit, drives the promotion-coalesce arm).
  - `Snapshot` `store.go:148-272` (wire shape; `Projected` `:201`, `Cause`,
    `Stubs`, `CutoffVersion`/`CutoffMs`, `StructuralRevision`).
  - `GateFacts` `store.go:289-341`; `ProjectConstants` `:277-281`;
    `MessageWithParts` `:344`; `WindowMeta` `:349+`; `VerbFacet` `:790`.
- `pkg/state/subtree_indexes.go` — **7 incremental indexes** that already hold
  the full tree + activity the new model needs:
  - `children` map[parentID][]childID + `rootIDs`.
  - `subtreeRetryCount`, `subtreePendingInput` (sums),
    `subtreeNewestActivity` (max), `subtreeDescendantCount` (sum),
    `recentBucket`, prototype `subtreeBusyCount`.
  - Maintenance functions (all reusable as-is):
    `adjustAncestorChainSumLocked` `:70`, `seedSumOnCreateLocked` `:91`,
    `moveSumOnReparentLocked` `:108`,
    `effectiveParentOfLocked` `:267` (orphan-inclusive: parent empty OR absent
    → `""` ⇒ root),
    `childrenAppendLocked` `:276`,
    `maintainChildrenOnSessionUpsertLocked` `:325` (fresh-create reabsorbs
    orphaned children),
    `touchActivityTimeLocked` `:459`, `touchRecentBucketLocked` `:512`,
    `maintainIndexesOnDeleteLocked` `:620` (**non-cascading**: orphans the
    deleted node's children to roots rather than cascading — this is exactly
    where genuine orphans can be created and must be flagged, see §9).

### 2.2 The projection wire builder (O1 collapsed frontier) — **[DELETE-P4]**

`pkg/state/projection.go` (1196 lines):

- `CollapsedBranchStub` `:21-56` — the "materialized vs stub" concept being
  killed.
- `defaultProjectionCutoff` `:89` (10 min); `projectionCutoff()` `:104`;
  `SetProjectionCutoffForTest` `:139`.
- `SweepInterval()` `:183` (cutoff/10); `DemotionGen()` `:210`;
  `RunDemotionSweep` `:259` + `sweepOnce` `:295` — the demotion sweep goroutine
  (shrink-only detection, bumps `demotionGen`).
- `structuralKinds` `:337-345`; `IsStructuralKind` `:349`;
  `defaultBranchExpandLimit=50` `:356`.
- `aggregateStateLocked` `:367`, `subtreeHasActivityLocked` `:389`,
  `selfActiveLocked` `:410`.
- `computeActiveClosureLocked` `:432` + `descendActiveClosureLocked` `:444` —
  the active-closure descent that materializes active sessions + ancestors.
- `buildStubLocked` `:480`.
- **`SnapshotProjected` `:523-834`** — THE projection emitter (active closure →
  full sessions; idle roots → `CollapsedBranchStub`; frontier; carries
  `Projected=true, Cause, Stubs, CutoffVersion/CutoffMs`); hoist/strip helpers
  `:846`.
- **`SnapshotBranch` `:933-1196`** — lazy-expand response builder (materializes
  a parent's child batch + active descendants; pagination via cursor;
  `StaleCursor` signal `:968` for a deleted cursor).

### 2.3 Materialization machinery to DELETE in Phase 4 — precise inventory

**`pkg/state/projection.go` (whole file is delete candidate):** every symbol in
§2.2. In particular the active-closure + cutoff + demotion machinery:
`computeActiveClosureLocked`/`descendActiveClosureLocked`, `buildStubLocked`,
`SnapshotProjected`, the cutoff getters, `SweepInterval`, `DemotionGen`,
`RunDemotionSweep`/`sweepOnce`, `aggregateStateLocked`,
`subtreeHasActivityLocked`, `selfActiveLocked`. (`SnapshotBranch` is replaced by
the new expand emitter, §8.)

**`pkg/state/store.go` Phase-4 delete machinery:**
- `frontierSeq atomic.Uint64` (`:1091` decl; `bumpFrontierSeqLocked` `:1258`;
  read `s.frontierSeq.Load` `:1267`) — DIAGNOSTICS-ONLY today; remove.
- `demotionGen atomic.Uint64` (`:1111`); `lastNotifiedClosure atomic.Pointer`
  (`:1112`); `curFrontierChanged bool`; `structuralRevision` counter
  (`bumpStructuralRevisionLocked` `:1250`).
- `ClientEvent.FrontierChanged` (`:144`) — the per-event flag the
  promotion-coalesce arm keys on; superseded by explicit structural ops.

**`pkg/web/server.go` Phase-4 delete machinery:**
- `promoCoalesce` timer path (`:1564-1742`), `promotionCoalesceInterval=150ms`
  (`:1794`), `flushPromotion` (`:1605-1626`).
- `sweepTicker` (`:1640-1730`) polling `store.DemotionGen()` at `SweepInterval()`.
- `wantsProject` (`:1807-1809`) once all clients are on `tree=2`.

> **Phase 4 does NOT delete:** the store, the subtree indexes, the event kinds,
> or the `Apply` path (`store.go:1742`) — those are the *foundation* the new
> emitter builds on. Phase 4 only removes the *projection/cutoff/demotion/
> coalesce* layer that sits on top of them.

### 2.4 Client reconstruction layer — **[DELETE-P3]**

- `web/src/lib/reduce.ts` — `buildChildrenIndex` `:14-33` (derives parent→child
  from `Session.parentID`; orphan-promote at `:21-26`); `anyDescendantWorking`
  `:39`. Whole file is the client tree-reconstruction to delete.
- `web/src/orphans.ts` — `orphanSessions` `:34-42` (THE client orphan
  predicate); `archiveEligibleOrphans` `:62-68`; `rootInfoFor` `:87`
  (walks `parentID` up to root via `/oc/session` fetch). Whole file deletes.
- `web/src/sync/stream.ts` (2912 lines) — the reconstruction layer. Delete
  targets within it:
  - `applySnapshot` `:498` (AUTHORITY_COMPLETE wholesale-replace) — replaced by
    op-apply on the flat map.
  - `applyProjectedSnapshot` `:683-881` (THE merge path: preserve-absent
    `:702`, facet reconcile `:755-761`, full-rebuild stub replace `:773-843`,
    ghost/demotion reconcile `:790-843`).
  - `applySessionEvent` `:884` (session.upsert/delete merge +
    `pruneSessionDeleted` `:934`).
  - `applyLazyExpandMerge` `:2668-2718`; `lazyExpandBranch` `:2750-2865`
    (fetch `/vh/sessions/branch`, `branchRequestGen` anti-resurrection `:2768`/
    `:2820`, `staleCursor` restart `:2797`); `collapseBranch` `:2893+`
    (removes materialized descendants — false-orphan root-cause comment
    `:2870-2879`).
  - Generation/revision counters: `branchRequestGen` `:1474`,
    `bumpBranchStructuralGen` `:1476`, `lastAppliedStructuralRevision` `:1482`.
- `web/src/sync/store.ts` — `expandedBranches` `:191` (ephemeral, OK to keep as
  UI state), `branchStubs` `:197` (ephemeral, **delete**: no stub concept),
  `projectConstants` `:205` (keep). Persisted loaders `loadSessions`/
  `loadActivity`/`loadAgents` `:256-263` persist sessions/activity/lastAgents —
  §11 says tree structure is NOT persisted; sessions cache may remain for the
  chat-view fast path but the *tree* is re-fetched.
- `web/src/types.ts` — `CollapsedBranchStub` `:150-162` **delete**;
  `Snapshot.projected/cause/stubs/cutoffVersion/cutoffMs/structuralRevision/
  staleCursor` `:103-139` **delete** (the projection envelope fields).
  `Session`/`GateFacts`/`VerbFacet`/`Activity` (`:4-42`, `:170-177`, `:212`)
  stay and inform the new `Node` schema (§3).

### 2.5 The `proj=1` capability-flag wiring (the migration seam)

`tree=2` MUST mirror this exactly on both sides.

- **Server gate:** `wantsProject(r)` `pkg/web/server.go:1807-1809` =
  `r.URL.Query().Get("proj")=="1"`. Read sites: `:1494` (reconnect branch),
  `:1532` (initial snapshot branch), `:1696` (promotion arm gate),
  `:1724` (sweep arm gate).
- **Client send:** `web/src/sync/stream.ts:1701` —
  `es = new EventSource(\`/vh/stream?${cursorParam}sessions=&dir=${...}&z=1&proj=1&hoist=1\`)`.
- **Envelope dual-negotiation:** the `?proj=1` query is *additionally* guarded
  by the `projected:true` field on the `Snapshot` envelope (`store.go:201`),
  protecting both directions. `stream.ts:549-550` documents this
  dual-negotiation. `tree=2` mirrors it: a `?tree=2` query **plus** a new
  envelope marker (see §10) so an old client never mis-reads a tree=2 stream
  and vice-versa.

### 2.6 Events that trigger promotions today (→ drive the new structural-delta emitter)

The store already emits structured events; the new emitter subscribes to the
same set. Event kinds (`store.go:29-89`) and their emit sites:

| Event kind | Constant | Emit site |
|---|---|---|
| session upsert | `KindSessionUpsert` `:29` | `:1989` (+ reconcile `:3815`) |
| session delete | `KindSessionDelete` `:30` | `:2050` |
| permission set | `KindPermissionSet` `:77` | `:1849` |
| permission clear | `KindPermissionClear` `:78` | `:1870` |
| activity | `KindActivity` `:80` | `:1467` |
| question set | `KindQuestionSet` `:88` | `:1886` |
| question clear | `KindQuestionClear` `:89` | `:1899` |

All applied through `Store.Apply` (`store.go:1742`). Archive/un-archive and
prune ride `KindSessionUpsert` (archived flag) / `KindSessionDelete` (prune) —
see `pkg/web/archive.go` (modified at baseline; the archive flag is a session
facet, not a distinct event kind). These are the exact events the new
structural-delta emitter (§6) translates into ops.

---

## 3. Node JSON schema

Every node is **self-contained**: it carries its own display data regardless of
whether its children are loaded. There is no "stub" node type — a node with
`loaded:false` simply has not had its children fetched yet, but still renders
its own row, agent chip, flags, and pin eligibility.

```jsonc
{
  "id": "S_a91f",
  "parentId": null,                 // null = root. Always server-assigned.
  "title": "fix: parser edge case", // may be empty for a brand-new session
  "agent": "build",                 // OPTIONAL; absent = no chip yet.
                                    //   source: lastAgents[id] (store.go snapshot facet).
  "activity": "busy",               // "idle" | "busy" | "retry" | "error".
                                    //   Mirrors web/src/types.ts:212 Activity.
                                    //   SELF activity (not subtree aggregate).
  "verb": {                         // OPTIONAL; absent = no active tool facet.
    "tool": "read",                 //   source: currentVerbs[id] (types.ts:170 VerbFacet).
    "state": {                      //   Lets an unopened task-tool subagent show
      "status": "in_progress",      //   "Reading parser.go" without Tier-B load.
      "input": { "path": "parser.go" },
      "time": { "start": 1721700000000 }
    }
  },
  "childCount": 3,                  // DIRECT children count (len(children[id])).
                                    //   NOT total descendants. 0 = leaf.
  "loaded": false,                  // SERVER sets true ONLY in an initial
                                    //   snapshot for nodes whose children are
                                    //   also shipped (active path) or in a
                                    //   node.children op. Client may flip
                                    //   false on collapse (§8).
  "flags": {
    "pendingInput": false,          // question set and unanswered (subtreePendingInput-aware).
    "permission":   false,          // permissions[id] non-empty.
    "archived":     false,          // session archived facet (pkg/web/archive.go).
    "orphan":       false           // SERVER-COMPUTED ONLY (§9). Client never sets.
  },
  "updatedMs": 1721700123000        // Session.time.updated (types.ts:14). unix ms.
}
```

### 3.1 Field justification (beyond the contract sketch)

The task sketch was `{id, parentId, title, agent?, activity, childCount,
loaded, flags, updatedMs}`. Fields added here, each grounded in existing data:

- **`verb`** (optional). The design principle says "every node always carries
  its own display data." An unopened task-tool subagent's row must show rich
  activity ("Reading parser.go") without loading Tier-B messages. The data
  already exists (`currentVerbs` snapshot field, `types.ts:102`/`:170`, and the
  live `activity.verb` event). Omitting it would regress the current
  subagent-activity UX, so it is a first-class Node field.
- **`flags.pendingInput` / `flags.permission` / `flags.archived`** as discrete
  booleans rather than a free map. These are the exact facets the current
  branch-stub `aggregateState:"needs-input"` encoded opaquely
  (`projection.go:21`). Making them explicit booleans is what lets a collapsed
  node render its own pins/badges (kills bug #5).

### 3.2 Fields deliberately NOT on the Node

- **`model`** — constant per project; stays in the hoisted `projectConstants`
  (`types.ts:54`), resolved via `selectors.sessionModel`. Not tree display data.
- **`aggregateState` / `descendantCount`** — these were `CollapsedBranchStub`
  fields (`projection.go:21`). `descendantCount` (total) is dropped in favor of
  `childCount` (direct), which is what an expander needs. No subtree aggregate
  state: the client does not classify; the server surfaces the meaningful
  facets via the discrete `flags.*` booleans + `activity`.
- **`structuralRevision` / `cutoffVersion`** — projection-layer bookkeeping
  (`types.ts:113`/`:124`), deleted with the projection.

### 3.3 Consistency guarantee

The **initial snapshot is self-consistent**: every `parentId` in the set either
resolves to another node in the set or is `null` (root). Live ops preserve
this: a `node.upsert` for a child whose parent is not yet on the client is
preceded by a `node.upsert`/`node.children` carrying the parent (or the parent
is already a root/placeholder). The client never has to guess.

---

## 4. Delta op JSON schemas

Live updates are **explicit, named structural ops** the client applies verbatim.
There is no "ship a fresh projection, client diffs it." Every change is one op.
All ops are wrapped in a single envelope that carries scope.

### 4.1 Envelope

```jsonc
{
  "dir": "/home/op/repo",   // project directory scope (reqDir). Optional on a
                            //   stream already scoped to one dir.
  "sessionId": null,        // OPTIONAL: the session this op is most relevant to
                            //   (e.g. the child for node.upsert). UI hint only;
                            //   structural authority is the op fields below.
  "op": "node.upsert",      // "node.upsert" | "node.remove" | "node.move" |
                            //   "node.children" | "node.facet"
  "data": { /* op-specific, see below */ }
}
```

### 4.2 `node.upsert` — add or update a node's OWN data (never its children)

```jsonc
{ "op": "node.upsert", "data": {
    "node": { /* full Node object per §3 */ }
} }
```
Emitted on: session create, title/agent/activity/verb change, any flag change,
archive/un-archive, orphan detection (with `flags.orphan`). The server emits the
**full** Node each time (no JSON-patch) — nodes are small and this is
idempotent.

### 4.3 `node.remove` — authoritative delete

```jsonc
{ "op": "node.remove", "data": {
    "id": "S_a91f"
} }
```
The client drops the node AND every loaded descendant rooted at it (§7). No
inference from absence: only this op removes a node.

### 4.4 `node.move` — reparent

```jsonc
{ "op": "node.move", "data": {
    "id": "S_b22",
    "newParentId": "S_a91f"      // null = moved to root
} }
```
Emitted when `effectiveParentOfLocked` (`subtree_indexes.go:267`) would change
for a node because its parent appeared/disappeared (e.g. a parent session is
re-created and `maintainChildrenOnSessionUpsertLocked` `:325` reabsorbs
orphaned children). The client updates `parentId` and re-renders; loaded
descendants travel with the node.

### 4.5 `node.children` — expand result / server push of a subtree batch

```jsonc
{ "op": "node.children", "data": {
    "parentId": "S_a91f",
    "nodes": [ { /* Node */ }, { /* Node */ } ],   // the direct children batch
    "hasMore": false,                              // pagination: more children exist
    "cursor": "S_c33"                              // opaque; pass back to fetch next page
                                                   //   (null/absent when hasMore=false)
} }
```
Two uses: (a) the response to `GET /vh/tree/children` (§8); (b) a proactive
server push when a subtree's children become relevant (e.g. the active path
grows). The client merges these nodes into the flat map and sets
`loaded:true` on `parentId` once a terminal batch (`hasMore:false`) arrives.

### 4.6 `node.facet` — lightweight facet-only update (activity/flags/verb)

```jsonc
{ "op": "node.facet", "data": {
    "id": "S_a91f",
    "activity": "retry",
    "verb": null,                  // null clears the active tool facet
    "flags": { "pendingInput": true }   // partial: only listed flags change;
                                        //   omitted flags are untouched
} }
```
A bandwidth-friendly variant of `node.upsert` for the high-frequency facets
(activity ticks, verb transitions, permission/question state). Every
`node.facet` is expressible as a `node.upsert`; the client treats `facet` as a
partial merge and `upsert` as a full replace of the Node. All fields in `data`
except `id` are optional.

---

## 5. Initial snapshot composition

On cold load (a new `tree=2` stream connection), the server emits a single
snapshot consisting of **three categories** of nodes:

1. **All roots** — every node with `effectiveParentOfLocked == ""`
   (`subtree_indexes.go:267`): `parentId:null`, `loaded` per category 3 below.
2. **The active path(s) to running sessions** — for every session whose SELF
   activity is non-idle (`activity != "idle"`, i.e. `busy`/`retry`/`error`) OR
   that has an open permission/question (`flags.permission`/`pendingInput`),
   the server emits that session **and every ancestor up to its root**, each as
   a full Node with `loaded:true`. This replaces the active-closure descent
   (`projection.go:432`/`:444`) with a deterministic, *fully-loaded* path rather
   than a stub frontier.
3. **Collapsed placeholders for every other known node** — every node not in
   categories 1–2 is emitted as a full Node (self-contained, §3) with
   `loaded:false` and an accurate `childCount`. The client renders it as a row
   with a `▸ N` expander; expanding triggers §8.

### 5.1 "Active path" — precise definition

A session `S` is on an active path iff `S.activity ∈ {busy,retry,error}` OR
`S.flags.permission` OR `S.flags.pendingInput`. The active path *of* `S` is
`[S, parent(S), parent(parent(S)), … root]`. The union of all active paths,
plus all roots, plus all other nodes as collapsed placeholders, is the initial
snapshot.

### 5.2 `loaded` in the initial set

- `loaded:true` for every node in categories 1–2 **whose own children are also
  in the snapshot** — i.e. roots and active-path nodes whose children sit on an
  active path. (A root with active children has those children present, so the
  root is `loaded:true`.)
- `loaded:false` for every placeholder in category 3, and for any category-1/2
  node whose children are NOT in the snapshot (a leaf active session with
  unloaded siblings).

> **Design decision for review (Q1):** is "active path = non-idle OR
> permission OR pendingInput" the right frontier? It is broader than today's
> `computeActiveClosureLocked` (which uses the cutoff), which is the point —
> we want the live-interest frontier fully loaded with no stubs. Reviewer
> should confirm the activity predicate and whether `archived` sessions should
> ever seed an active path (default: no).

### 5.3 No flatten risk

Because there are no ephemeral `branchStubs` (§11) and every node is
self-contained, a reload simply re-fetches this snapshot. The flatten-on-load
bug (#2) is structurally impossible.

---

## 6. Server event → delta mapping table

The new emitter subscribes to the same store events that drive promotions today
(§2.6) and translates each into one or more delta ops. The client never
re-derives structure.

| Store / internal event | Emitted delta op(s) | Notes |
|---|---|---|
| Session created (`KindSessionUpsert`, new id) | `node.upsert{node}` for the new session; **plus** `node.children` push to its parent if the parent is `loaded:true` on a connected client (server tracks per-stream loaded set); **plus** a `node.facet{childCount:+1}` or `node.upsert` on the parent to bump its `childCount`. | `maintainChildrenOnSessionUpsertLocked` (`subtree_indexes.go:325`) already reabsorbs orphaned children — if the new session re-parents existing orphans, emit `node.move` for each reabsorbed child. |
| Session title/agent/activity/verb updated (`KindActivity`, or `KindSessionUpsert` with changed fields) | `node.facet{id, activity?, verb?}` (high-frequency path) OR `node.upsert{node}` if title/agent changed. | Stop stamping `activity=now` on hydrate/status-reconcile (see §note A) — seed recency from the session's real `Session.time.updated`. |
| Session gains `pendingInput` (`KindQuestionSet`) | `node.facet{id, flags:{pendingInput:true}}`. | Also bumps ancestor `subtreePendingInput`; ancestors do NOT need an op unless the client displays a subtree badge (decision Q2). |
| Session loses `pendingInput` (`KindQuestionClear`) | `node.facet{id, flags:{pendingInput:false}}`. | |
| Permission requested (`KindPermissionSet`) | `node.facet{id, flags:{permission:true}}`. | |
| Permission resolved (`KindPermissionClear`) | `node.facet{id, flags:{permission:false}}`. | |
| Session archived (archive flag set on upsert) | `node.upsert{node, flags:{archived:true}}`. | If archiving the root of subsessions makes them orphans, also emit `node.facet{flags:{orphan:true}}` for each (§9). |
| Session un-archived (archive flag cleared) | `node.upsert{node, flags:{archived:false}}`. | Clear `orphan` on any descendants that were orphaned solely due to this root (§9). |
| Session deleted / pruned (`KindSessionDelete`) | `node.remove{id}`. | `maintainIndexesOnDeleteLocked` (`:620`) orphans the deleted node's children to roots — emit `node.move{id, newParentId:null}` for each orphaned child, then run the orphan check (§9) on them. |
| Parent reparented (effective parent changed via create/delete cascade) | `node.move{id, newParentId}`. | See "Session created" + "Session deleted" rows — `move` is the carrier whenever `effectiveParentOfLocked` flips. |
| Subtree loaded on expand (client `GET /vh/tree/children`) | HTTP response is a `node.children` payload (not an SSE op); same shape. | §8. Pagination via `cursor`/`hasMore`. |

**§note A — stop stamping `activity=now` on hydrate/reconcile:** today the
hydrate / status-reconcile path stamps `activity=now`, which forces a full load
after restart and seeds the demotion churn. The new model seeds a node's
`activity`/`updatedMs` from the session's real last-activity
(`Session.time.updated` / `subtreeNewestActivity`). Locate the stamping site in
the hydrate path during Phase 2 and remove it; cite it here when found (open
item O1).

### 6.1 Non-obvious mappings (the riskiest — flagged for review)

- **R1 — Ancestor `childCount`/badge propagation on create/delete.** When a
  child is added/removed, the parent's `childCount` changes and (if the client
  shows subtree badges) ancestor sum change. The table emits a parent
  `node.upsert`/`facet`. *Risk:* if the server forgets an ancestor, the client
  shows a stale `▸ N`. Mitigation: derive `childCount` directly from
  `len(children[id])` at emit time so it is always exact.
- **R2 — Orphan-on-delete cascade vs. orphan-on-archive.** Delete reparents
  children to root (`maintainIndexesOnDeleteLocked`); archive does NOT delete.
  A subsession whose *root* is archived becomes an orphan only if the cascade
  missed it (§9). *Risk:* emitting `orphan:true` for a live-rooted session
  (the original false-orphan bug). Mitigation: the orphan rule in §9 explicitly
  excludes any session whose root is live.
- **R3 — `move` ordering vs. `upsert`.** If a parent is re-created
  (`maintainChildrenOnSessionUpsertLocked` reabsorbs), the server must emit the
  parent `upsert` BEFORE the children's `move`, else the client briefly sees
  children parented to a missing node. *Risk:* a transient render glitch.
  Mitigation: per-stream op ordering guarantee (parent-before-child on the same
  flush) — state explicitly in Phase 2.

---

## 7. Client apply-op logic

The client holds a **flat `Map<id, Node>`** plus a small set of UI-state maps
(expand/selection/pins/search). The tree is *rendered directly* by grouping on
`parentId`; the server guarantees consistency (§3.3). There is no
`buildChildrenIndex`, no orphan predicate, no reconcile sweep.

### 7.1 Seed from initial snapshot

```
on initial snapshot:
  flatMap.clear()
  for node in snapshot.nodes:
    flatMap.set(node.id, node)        // full Node, loaded per §5.2
  uiState.expanded = {}               // start collapsed; expand roots by default
  uiState.selection = snapshot.focusedSessionId ?? firstRoot
```

### 7.2 Per-op mutation pseudocode

```
on op:
  switch op.op:

  case "node.upsert":
    flatMap.set(op.data.node.id, op.data.node)   // FULL replace (idempotent)

  case "node.remove":
    id = op.data.id
    // drop the node + every LOADED descendant rooted at it
    for desc in loadedDescendants(flatMap, id):   // BFS by parentId within loaded set
      flatMap.delete(desc)
    flatMap.delete(id)
    // NOTE: a collapsed placeholder whose parent was removed is itself
    // removed only if it was a loaded descendant. Unloaded siblings of id
    // are untouched — the server will move/remove them via their own ops.

  case "node.move":
    n = flatMap.get(op.data.id)
    if n: flatMap.set(op.data.id, { ...n, parentId: op.data.newParentId })
    // loaded descendants travel with n implicitly (they point at n).
    // re-render re-groups by parentId automatically.

  case "node.children":
    for child in op.data.nodes:
      flatMap.set(child.id, child)               // merge/replace each child
    parent = flatMap.get(op.data.parentId)
    if parent && !op.data.hasMore:
      flatMap.set(op.data.parentId, { ...parent, loaded: true })
    // stash op.data.cursor for next page (§8)

  case "node.facet":
    n = flatMap.get(op.data.id)
    if !n: break                                  // facet for unknown node: ignore
    merged = { ...n }
    if "activity" in op.data: merged.activity = op.data.activity
    if "verb"    in op.data: merged.verb    = op.data.verb
    if "flags"   in op.data: merged.flags   = { ...merged.flags, ...op.data.flags }
    flatMap.set(op.data.id, merged)
```

### 7.3 What the client NEVER does

- **Never infers a delete from absence.** Only `node.remove` deletes.
- **Never classifies orphans.** Only displays `flags.orphan` set by the server.
- **Never derives parent→child itself.** It groups the flat map by `parentId`
  for rendering; the server is the sole authority for `parentId`.
- **Never reconciles ghosts / demotes / coalesces.** Those concepts are deleted
  (§2.3, §2.4).

---

## 8. Expand protocol

### 8.1 Request

```
GET /vh/tree/children?dir=<projectDir>&id=<parentId>&cursor=<opaque>
```

- `dir` — project directory scope, mirrors `reqDir(r)` (`server.go:1305`)
  `projectScopedFilter`. Required for multi-project daemons.
- `id` — the node whose direct children to load.
- `cursor` — opaque pagination token returned by the previous page (absent on
  first page). Mirrors the `X-VH-Branch-Cursor` header pattern of `handleBranch`
  (`server.go:1292`) but moved into the query for simplicity.
- `limit` — optional; server default `defaultBranchExpandLimit=50`
  (`projection.go:356`).

GET ⇒ no CSRF required (mirrors `handleBranch` `server.go:1264`, a pure read).

### 8.2 Response

A `node.children` payload (§4.5):

```jsonc
{ "parentId": "S_a91f", "nodes": [ /* Node[] */ ], "hasMore": false, "cursor": null }
```

### 8.3 Pagination semantics

- `hasMore:true` ⇒ more direct-children pages exist; client fetches again with
  `cursor` from this response.
- `hasMore:false` ⇒ terminal page; client sets `loaded:true` on `parentId`.
- **Stale cursor:** if `cursor` references a child that was deleted/reparented
  between pages, the server returns an empty batch with `hasMore:false` AND a
  `staleCursor:true` marker (mirrors `SnapshotBranch` `projection.go:968`). The
  client restarts the expand ONCE from page 0 (mirrors `lazyExpandBranch`
  `stream.ts:2797`), rather than treating empty as terminal and permanently
  omitting later siblings.

### 8.4 Client collapse behavior

Collapse is **client-only** and does NOT round-trip:

```
on collapse(id):
  for desc in loadedDescendants(flatMap, id):
    flatMap.delete(desc)            // drop loaded children from VIEW
  parent = flatMap.get(id)
  flatMap.set(id, { ...parent, loaded: false })   // keep the placeholder node
                                                  // (its own row + ▸ N stays)
```

The placeholder node remains (self-contained, §3), so collapsing never loses
the node's own display data — only its loaded subtree. Re-expanding hits §8.1
again.

---

## 9. Orphan computation (server-side)

### 9.1 Rule

A node `N` is a **genuine orphan** iff **all** hold:

1. `N.parentId` (effective parent via `effectiveParentOfLocked`,
   `subtree_indexes.go:267`) is non-empty, AND
2. the **root** of `N`'s tree (walk `effectiveParentOfLocked` to the top) is
   `flags.archived:true`, AND
3. the cascade that archived the root did not prune `N` (i.e. `N` is still
   resident).

A **live-rooted session is NEVER an orphan**: if the root is not archived,
condition 2 fails. This is the direct fix for bug #1.

### 9.2 Where the check runs

The orphan check is invoked from two places in the server (Phase 2 implements
both behind `tree=2`):

1. **On archive/un-archive** (`pkg/web/archive.go` path, `KindSessionUpsert`
   with archived flag): after setting/clearing `archived` on the root, walk the
   root's subtree (via the `children` index) and set/clear `flags.orphan` on
   each descendant, emitting `node.facet{id, flags:{orphan}}` per descendant.
2. **On delete/prune** (`maintainIndexesOnDeleteLocked` `subtree_indexes.go:620`):
   when a deleted node's children are reparented to root, run the orphan check
   on each newly-rooted child (its new root is itself → condition 2 is its own
   archived state; if it was a subsession whose chain root was just deleted, it
   is now a root and not an orphan).

### 9.3 What is emitted

A `node.facet{id, flags:{orphan:true|false}}` for each affected node. The
client only *displays* the orphan badge (and may group orphans visually); it
never computes orphan status (§7.3).

---

## 10. `tree=2` capability flag

### 10.1 Wiring plan (mirrors `proj=1`, §2.5)

- **Server gate:** add `wantsTree2(r)` in `pkg/web/server.go` beside
  `wantsProject` (`:1807`):
  `r.URL.Query().Get("tree")=="2"`. In `handleStream` (`:1360`), branch on
  `wantsTree2(r)`: if true, use the **new** frontier+delta emitter (Phase 2)
  for both the initial snapshot and live ops; else fall through to the existing
  `wantsProject`/`Snapshot` path unchanged.
- **Client send:** in `web/src/sync/stream.ts` at the EventSource construction
  (`:1701`), the new client appends `&tree=2` (and may drop `proj=1`/`hoist=1`
  since tree=2 supersedes them).
- **Envelope dual-negotiation:** the new stream carries a distinct envelope
  marker (e.g. `tree:2` on the snapshot envelope, analogous to `projected:true`
  `store.go:201`) so an old client never mis-applies a tree=2 stream. The
  envelope carries the initial `Node[]` plus subsequent ops.

### 10.2 Coexistence during transition

- Old client (`proj=1`, no `tree=2`) → existing path, unchanged. New server
  still serves it via `wantsProject`.
- New client (`tree=2`) → new path. Server maintains **both** emitters off the
  same store events (§2.6); the new emitter is additive and reads the same
  subtree indexes (§2.1), so there is no store divergence.
- The two client versions must NOT be mixed on the same browser session; the
  client capability is determined at connect time and held for the connection.

### 10.3 Phase 4 cutover / delete plan

Once all deployed clients send `tree=2`:

1. Remove `wantsProject` and the `SnapshotProjected`/`SnapshotBranch` call sites
   from `handleStream` (server.go `:1494`,`:1532`,`:1696`,`:1724`) and the
   `promoCoalesce`/`sweepTicker` arms (`:1564-1742`).
2. Delete `pkg/state/projection.go` entirely (§2.2).
3. Delete the store.go Phase-4 machinery (§2.3): `frontierSeq`, `demotionGen`,
   `lastNotifiedClosure`, `curFrontierChanged`, `structuralRevision`,
   `ClientEvent.FrontierChanged`.
4. Delete the client reconstruction layer (§2.4): `reduce.ts`, `orphans.ts`,
   the `applyProjectedSnapshot`/reconcile/lazy-expand paths in `stream.ts`,
   `CollapsedBranchStub` and projection envelope fields in `types.ts`.

---

## 11. localStorage / persistence rule

**Tree structure is NEVER persisted to localStorage.** Only UI state
(expand toggles, selection, pins, search query/filters) may be persisted.

**Why:** the flatten-on-load bug (#2) was caused precisely by ephemeral
`branchStubs` (`store.ts:197`, not persisted) being lost on reload, after which
the reconnect snapshot (`server.go:1494`) had to rebuild the frontier. In the
new model there is no frontier/stub state to lose: the small initial snapshot
(§5) is cheap to re-fetch on every load, and every node is self-contained.

**Concretely for Phase 3:** `loadSessions`/`loadActivity`/`loadLastAgents`
(`store.ts:256-263`) may continue to cache *opened-session* message data for
the chat-view fast path, but the **tree flat map must not be persisted** — it
is seeded entirely from the §5 snapshot on connect. `expandedBranches`
(`store.ts:191`) MAY persist as UI state; `branchStubs` (`:197`) is deleted.

---

## 12. Phase 2/3/4 file inventories

Built from recon (§2). Counts are headline-level; the doc body has the
per-symbol detail.

### 12.1 Phase 2 — server (add/modify behind `tree=2`)

**ADD (new files):**
- `pkg/state/tree_emitter.go` — the frontier+placeholders snapshot composer
  (§5) and the structural-delta emitter (§6).
- `pkg/web/tree_children.go` — the `GET /vh/tree/children` handler (§8),
  beside `handleBranch`.
- `pkg/state/tree_node.go` — the `Node`/delta-op Go types (§3, §4) + JSON tags.

**MODIFY:**
- `pkg/web/server.go` — add `wantsTree2`, branch in `handleStream`
  (`:1360`); register `/vh/tree/children` route.
- `pkg/web/archive.go` — invoke the orphan check (§9) on archive/un-archive.
- `pkg/state/subtree_indexes.go` — add an orphan-flagging hook in
  `maintainIndexesOnDeleteLocked` (`:620`) (additive; no index shape change).
- (Open O1) the hydrate/status-reconcile path that stamps `activity=now` —
  remove the stamp.

**REUSE (no change):** `pkg/state/store.go` Store/indexes/event kinds/`Apply`
(§2.1, §2.6).

### 12.2 Phase 3 — client (add/modify + delete reconstruction)

**ADD:**
- `web/src/sync/treeMap.ts` — the flat `Map<id,Node>` + op-apply logic (§7).
- `web/src/sync/treeOps.ts` — op envelope/op decoders + §8 expand fetch.
- `web/src/components/TreeRow.tsx` (+ `.module.css`) — renders a self-contained
  Node row (agent chip, flags, `▸ N` expander).

**MODIFY:**
- `web/src/sync/stream.ts` — at `:1701` add `tree=2`; replace the
  `applySnapshot`/`applyProjectedSnapshot`/`applySessionEvent`/lazy-expand call
  sites with op dispatch to `treeMap`.
- `web/src/sync/store.ts` — drop `branchStubs` (`:197`); keep `expandedBranches`
  as UI state.
- `web/src/types.ts` — add `Node`/op types; delete projection envelope fields.

**DELETE [DELETE-P3]:**
- `web/src/lib/reduce.ts` (whole file).
- `web/src/orphans.ts` (whole file).
- In `web/src/sync/stream.ts`: `applySnapshot` (`:498`),
  `applyProjectedSnapshot` (`:683-881`), `applySessionEvent`/`pruneSessionDeleted`
  (`:884`/`:934`), `applyLazyExpandMerge` (`:2668`), `lazyExpandBranch`
  (`:2750`), `collapseBranch` (`:2893`), the gen/revision counters
  (`:1474`/`:1476`/`:1482`).
- In `web/src/types.ts`: `CollapsedBranchStub` (`:150`), projection envelope
  fields (`:103-139`).

**KEEP (UI state + chat layer):** ChatView/Stream2 message layer, the
reveal-gate fix, pins/selection/search, `web/src/lib/streamMd.ts` and
`web/src/components/Part.tsx` (**permanent keep-out**, §top).

### 12.3 Phase 4 — delete old projection/materialization

**DELETE [DELETE-P4]:**
- `pkg/state/projection.go` (whole file — §2.2).
- In `pkg/state/store.go`: `frontierSeq` (`:1091`/`:1258`/`:1267`),
  `demotionGen` (`:1111`), `lastNotifiedClosure` (`:1112`),
  `curFrontierChanged`, `structuralRevision`/`bumpStructuralRevisionLocked`
  (`:1250`), `ClientEvent.FrontierChanged` (`:144`).
- In `pkg/web/server.go`: `wantsProject` (`:1807`), the `promoCoalesce`/
  `flushPromotion` arm (`:1564-1742`), `sweepTicker` (`:1640-1730`), the
  `SnapshotProjected`/`SnapshotBranch` call sites (`:1494`/`:1532`/`:1696`/
  `:1724`), `handleBranch` (`:1264`) once `/vh/tree/children` replaces it.

---

## 13. Test plan (per phase, test-first)

Repo test lanes (AGENTS.md): Go co-located unit in `pkg/`, Go integration in
`tests/integration/`, Go e2e in `tests/e2e/`, Go docker gold in
`tests/e2e-docker/`, web unit in `web/tests/unit/`, web e2e in `web/tests/e2e/`.

### 13.1 Phase 2 (server) — Go co-located unit in `pkg/state/`

- **Emitter unit tests** (`pkg/state/tree_emitter_test.go`):
  - Initial snapshot composition: given a synthetic store with roots + active
    + idle subtrees, assert the §5 three categories and `loaded` flags.
  - Per-event delta: drive each event in the §6 table through `Apply`, assert
    the emitted op(s) match the table exactly.
  - Orphan rule (§9): archive a root with subsessions → assert `flags.orphan`
    on descendants; un-archive → cleared; live-rooted → never orphaned.
- **Expand handler test** (`pkg/web/tree_children_test.go`): pagination
  `hasMore`/`cursor`, stale-cursor restart.
- Lane: `vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./pkg/state/ ./pkg/web/'`.

### 13.2 Phase 3 (client) — web unit in `web/tests/unit/`

- **Op-apply unit tests** (`web/tests/unit/treeMap.test.ts`): seed the flat map
  from a snapshot; apply each op (upsert/remove/move/children/facet) and assert
  the exact `Map` mutation per §7.2, including loaded-descendant drop on
  `remove`, parent-before-child ordering, and `loaded` flip on terminal
  `children`.
- Lane: `vh-agent-harness exec npm --prefix web run test:unit` (jsdom opt-in
  for any component render test).

### 13.3 All phases — live verification (e2e)

- **Go e2e (`tests/e2e/`, `StartCluster()`):** cold-load the tree over a real
  yamux tunnel + fake OpenCode; assert the frontier matches §5; expand a node
  and assert the round-trip; spawn a subagent live and assert correct nesting
  (bug #4); archive→prune a session and assert no resurrection (bug #3); assert
  no false orphans on a live-rooted subsession (bug #1).
- **Web e2e (`web/tests/e2e/`, serial, shared fixture backend):** reload
  mid-session and assert the tree does NOT flatten (bug #2); assert a collapsed
  node still shows its agent chip/pins (bug #5).
- Lanes: `vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/e2e/'` and
  `vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && npm --prefix web run test:e2e'`.

---

## 14. Open questions for review

- **Q1 (§5.2):** Is the active-path predicate "non-idle OR permission OR
  pendingInput" the right frontier? Should `archived` sessions ever seed an
  active path (default: no)?
- **Q2 (§6):** Does the client display subtree-aggregate badges (e.g. ancestor
  "needs input")? If yes, ancestor ops must propagate; if no, only the leaf
  `node.facet` is needed (simpler, less traffic). Current stubs encoded
  `aggregateState`; the new Node drops it — confirm the UX regression is
  acceptable or specify which subtree badges to keep.
- **Q3 (§4.6 vs §4.2):** Confirm the split between `node.facet` (partial merge)
  and `node.upsert` (full replace) is worth the complexity, vs. always emitting
  full `node.upsert`. Nodes are small; `facet` is a bandwidth optimization.
- **Q4 (§8.3):** Stale-cursor restart — keep it (mirrors today's
  `lazyExpandBranch` `stream.ts:2797`), or simplify and accept a one-shot
  re-expand from page 0 unconditionally on any empty batch?
- **Q5 (§9.2):** Orphan check on delete currently only re-checks newly-rooted
  children. Should it also re-check the deleted node's *siblings*? (Probably
  no — they keep their root — but confirm.)
- **O1 (§6 §note A):** The hydrate/status-reconcile path that stamps
  `activity=now` was identified as a root cause but its exact file:line was not
  pinned in this recon pass. Phase 2 must locate and remove it; cite back here.

---

**End of Phase 1 design. No code written. Awaiting human review before Phase 2.**
