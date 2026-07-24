# Server-Owned Session Tree — Phase 1 Design (rev. 1 — post-review)

> **STATUS: SHIPPED.** Phases 1–4 are complete (HEAD `a0e825c`); `tree=2` is the
> sole client+server path. The `proj=1` projection described in this document is
> **DELETED** — server side in Phase 4 commit `a0e825c`, client side in Phase 3
> Step C commit `4b04999`. This spec is retained as the **historical design
> record** for the server-owned-tree model; the `proj=1`/projection machinery
> described in §2 and the per-phase delete inventories (§10.3, §12) describe code
> that no longer exists, not live code. The design reasoning is kept intact as
> the record.

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

> **Revision 1 (post-review) — what changed.** v1 (commit `4e06e16`) was
> approved in direction; this revision closes the 4 gaps the reviewer found
> before Phase 2 may start:
> - **R1 (§5 reworked):** TRUE lazy frontier. Cold load is now
>   `O(roots + active-path depth + direct-children-of-loaded)`, NOT
>   `O(total sessions)`. Deep idle subtrees are no longer pre-shipped.
> - **R2 (§5.4 new):** per-stream loaded-set — the server-tracked
>   expanded-set that makes true-lazy drift-proof.
> - **R3 (§5.5 new):** reconnect / op-replay — monotonic `seq` on the delta
>   envelope, bounded-ring replay on stream drop, snapshot fallback on a
>   ring-gap.
> - **R4 (§6.2 new):** server reconcile vs OpenCode's authoritative `/session`
>   list — corrective `node.remove`/`node.upsert`/archive re-assert that
>   absorbs OpenCode's flakiness in one server-side place; folds the existing
>   archive re-assert + resurrection tombstone into one loop.
> - **Node schema:** `descendantCount?` added (D1 refined); the one allowed
>   subtree-aggregate badge `flags.subtreeNeedsInput` added (Q2 resolved).
> - **R3 (§6.1, elevated):** parent-before-child op ordering is now a HARD
>   emitter invariant, not a Phase-2 detail.
> - **Open questions:** Q1–Q5 resolved; O1 resolved and removed (verified
>   citation `aggregator.go:773`/`:848`).
>
> Two reviewer code citations were verified against the tree before being
> baked in; one (the "no children endpoint" claim) was corrected — see §6.2
> and the closeout summary.

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

> **HISTORICAL — describes the baseline (`52a3fd0`) state.** The projection,
> demotion, and `proj=1` machinery mapped here was deleted in Phases 3–4
> (commits `4b04999` / `a0e825c`); none of it exists in the shipped `tree=2`
> code. This section is the as-written recon of the pre-rewrite tree, kept as
> the record that motivated the delete.

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
                                    //   STRUCTURAL — what an expand fetches.
                                    //   NOT total descendants. 0 = leaf.
  "descendantCount": 533,           // OPTIONAL. TOTAL descendants (the whole
                                    //   subtree below this node). Populated by
                                    //   the server for COLLAPSED/unloaded nodes
                                    //   so a collapsed root can render "▸ 533"
                                    //   without loading its subtree. Absent (or
                                    //   equal to childCount-derived) once the
                                    //   subtree is loaded/expanded — the client
                                    //   then derives the badge from the loaded
                                    //   flat map. Source: subtreeDescendantCount
                                    //   index (subtree_indexes.go). See D1.
  "loaded": false,                  // SERVER sets true ONLY in an initial
                                    //   snapshot for nodes whose children are
                                    //   also shipped (active path) or in a
                                    //   node.children op. Client may flip
                                    //   false on collapse (§8).
  "flags": {
    "pendingInput": false,          // SELF: question set and unanswered for THIS node.
    "subtreeNeedsInput": false,     // SUBTREE aggregate (the ONE allowed — Q2).
                                    //   SERVER-COMPUTED from subtreePendingInput
                                    //   index (subtree_indexes.go): true iff THIS
                                    //   node OR any descendant has pendingInput.
                                    //   Propagated up the ancestor chain so an
                                    //   ancestor shows a single "needs-input" dot
                                    //   without the client walking the tree.
                                    //   Client never sets; only displays the dot.
    "permission":   false,          // SELF: permissions[id] non-empty.
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
- **`descendantCount`** (optional). The true-lazy frontier (R1/§5) ships a
  collapsed root WITHOUT its subtree; the row still needs a "▸ 533 sessions"
  affordance so the user knows the subtree is large. `childCount` alone (direct
  children) would show "▸ 4" for a root that has 4 direct children but 533
  descendants — a UX regression. `descendantCount` is the total-descendants
  badge, sourced from the already-maintained `subtreeDescendantCount` index
  (`subtree_indexes.go`). It is populated for collapsed/unloaded nodes and may
  be omitted once the subtree is loaded. See decision D1.
- **`flags.pendingInput` / `flags.permission` / `flags.archived`** as discrete
  booleans rather than a free map. These are the exact facets the current
  branch-stub `aggregateState:"needs-input"` encoded opaquely
  (`projection.go:21`). Making them explicit booleans is what lets a collapsed
  node render its own pins/badges (kills bug #5).
- **`flags.subtreeNeedsInput`** (Q2 resolved). The ONE subtree-aggregate badge
  retained. It lets a collapsed ancestor show a "needs-input" dot (the user's
  most actionable subtree signal) without the client walking a subtree it has
  not loaded. All other subtree aggregation is dropped — the client never
  classifies; the server surfaces this single flag up the ancestor chain.

### 3.2 Fields deliberately NOT on the Node

- **`model`** — constant per project; stays in the hoisted `projectConstants`
  (`types.ts:54`), resolved via `selectors.sessionModel`. Not tree display data.
- **`aggregateState`** — the opaque `CollapsedBranchStub` field
  (`projection.go:21`) is dropped. It is replaced by the explicit discrete
  `flags.*` booleans + `activity` + the single `flags.subtreeNeedsInput`
  subtree dot (Q2). No free-form subtree "state": the client does not classify.
- **`structuralRevision` / `cutoffVersion`** — projection-layer bookkeeping
  (`types.ts:113`/`:124`), deleted with the projection.

> **Decision D1 (revised — supersedes the v1 "drop descendantCount" stance).**
> The Node carries BOTH `childCount` (DIRECT children — structural, drives the
> expand) AND `descendantCount` (TOTAL descendants — the "▸ N" badge, populated
> for collapsed/unloaded nodes). v1 dropped `descendantCount` in favor of
> `childCount` alone; review found that a collapsed root showing "4 direct
> children" instead of "533 sessions" is a UX regression that undersells a
> large idle subtree. `childCount` stays exact-direct; `descendantCount` is the
> separate badge field sourced from `subtreeDescendantCount`. (Q2's "drop all
> subtree aggregation" is likewise refined: exactly ONE aggregate —
> `subtreeNeedsInput` — is kept; `descendantCount` is a count, not a state.)

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
  "seq": 1042,              // monotonic per-stream op sequence (R3/§5.5).
                            //   Strictly increasing within one (epoch). The
                            //   client persists the last applied seq as its
                            //   resume cursor; on reconnect the server replays
                            //   ops with seq > cursor from a bounded ring.
                            //   Mirrors the existing ClientEvent.Seq +
                            //   ringBuffer mechanism (store.go:121, ring.go).
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

### 4.7 Emitter invariants (HARD — enforced at emit, not "Phase 2 detail")

The emitter MUST guarantee both invariants below on every flush. They are the
linchpin of the core-principle-1 promise ("the client never guesses / the
server owns structure"). A violation is a bug, not a tuning choice.

- **INV-A — monotonic `seq`.** Every op carries a `seq` strictly greater than
  the previous op on the same stream. `seq` is assigned at emit time, under
  the same lock that produces the op, so concurrent producers cannot interleave
  out of order. (R3/§5.5 relies on this for replay.)
- **INV-B — parent-before-child, within a flush.** Within any single flush, a
  parent's `node.upsert`/`node.children` MUST precede any child op that
  references that parent (`node.upsert`/`node.move`/`node.children` whose
  `parentId`/`newParentId` is the just-introduced parent). Rationale: a child
  arriving before its parent would force the client to either **guess** a
  placeholder parent or **drop** the child until the parent appears — and both
  are exactly the dual-ownership derivation the rewrite exists to kill. The
  client apply logic (§7.2) is written assuming this holds: a `node.upsert`/
  `node.move` whose parent is absent is a programming error on the server side,
  not a recoverable client state. This elevates v1's §6.1-R3 risk note ("state
  explicitly in Phase 2") to a hard, testable emit-time invariant. Phase 2
  implements an emitter unit test that asserts INV-B across every event in the
  §6 table (driven through `Apply`) and every §6.2 reconcile flush.

  The one permitted relaxation: a parent may be shipped as a collapsed
  placeholder (`loaded:false`, carrying `descendantCount`) in the same flush
  that ships its children — the placeholder IS the parent, so the child's
  `parentId` resolves. What is forbidden is the child preceding the *first*
  appearance of its parent on that client.

---

## 5. Initial snapshot composition (TRUE LAZY FRONTIER — R1)

> **R1 rework (post-review).** v1's §5 shipped a self-contained placeholder for
> EVERY known node, so cold load was still `O(total sessions)` (~1047 nodes for
> the `deep-fake-detection` project; ~1 MB). That missed the entire motivation
> of the rewrite: idle sessions accumulate without bound, and a cold load that
> touches every one of them re-introduces the "ship the whole tree" cost the
> server-owned model was meant to kill. This section is reworked so cold load is
> `O(visible frontier)`, independent of total session count.

On cold load (a new `tree=2` stream connection), the server emits a snapshot
consisting of **exactly three categories** of nodes — and NOTHING else:

1. **All roots** — every node with `effectiveParentOfLocked == ""`
   (`subtree_indexes.go:267`), emitted as collapsed placeholders (`loaded:false`)
   carrying their `childCount` and `descendantCount` (the "▸ N" affordance, D1).
   A root is shipped because the user always sees the top level; its deep
   subtree is NOT.
2. **The active path(s) to running sessions, fully loaded.** For every session
   `S` on an active path (§5.1), the server emits `S` **and every ancestor up to
   its root**, each as a full Node with `loaded:true`. This replaces the
   active-closure descent (`projection.go:432`/`:444`) with a deterministic,
   fully-loaded path rather than a stub frontier.
3. **ONLY the DIRECT children of every loaded node, as collapsed placeholders.**
   For each node shipped in categories 1–2 that is `loaded:true`, the server
   emits its DIRECT children (one level down) as collapsed placeholders
   (`loaded:false`, carrying their own `childCount`/`descendantCount`). This is
   what lets the user expand any visible row one level without a round-trip for
   the immediate next layer. The direct children's OWN subtrees are NOT shipped.

**Deep idle subtrees are NOT shipped on cold load.** A collapsed root with 533
descendants ships as ONE node rendering "▸ 533" (via `descendantCount`); its
entire subtree is fetched on expand (§8), not on cold load. This is the
contrast with v1, which shipped all 533 as placeholders.

### 5.0 Cold-load complexity (explicit)

The cold-load snapshot size is:

```
O( roots + (active-path nodes) + (direct children of every loaded node) )
```

It is **NOT** `O(total sessions)`. Concretely it is bounded by
`roots + Σ(depth of each active path) + Σ(childCount of each loaded node)`. The
two sums depend on how many sessions are *currently live* and how wide the
loaded nodes are — NOT on how many idle sessions have accumulated historically.
A project with 10 live sessions and 50 000 archived/idle ancestors pays for
~10 active paths + their direct children, NOT 50 000 nodes. Idle-session growth
does NOT make cold load larger, slower, or heavier — which is the whole point.

> **UX tradeoff vs v1 (acknowledged, accepted).** Under v1 every node was
> pre-shipped, so opening an old, idle subagent result was instant. Under
> true-lazy, expanding a collapsed idle subtree costs one round-trip (§8). This
> is the correct tradeoff: the user rarely opens old subagent results, and
> paying one expand round-trip on the rare open is far cheaper than paying
> `O(total sessions)` on EVERY cold load/reload/reconnect. The always-visible
> surfaces (roots, live work, one level of expand affordance) remain instant.

### 5.1 "Active path" — precise definition (Q1 resolved)

A session `S` is on an active path iff `S.activity ∈ {busy,retry,error}` OR
`S.flags.permission` OR `S.flags.pendingInput`. The active path *of* `S` is
`[S, parent(S), parent(parent(S)), … root]`. **An archived session NEVER seeds
an active path** (Q1) — even if it is nominally busy in `/session/status`, an
archived root is stale-by-definition and must not pull its subtree into the
loaded frontier. The union of all (non-archived) active paths, plus all roots
(category 1), plus the direct-children placeholders (category 3), is the cold
snapshot. Everything else is absent until expanded.

### 5.2 `loaded` in the initial set (re-derived for true-lazy)

- `loaded:true` for every node in category 2 **whose own direct children are
  also shipped** — i.e. an active-path node whose children are themselves on an
  active path (category 2) OR are shipped as the direct-children placeholders
  (category 3). A root on an active path whose children are shipped as category
  3 is therefore `loaded:true`.
- `loaded:false` for: every root placeholder (category 1, unless it is also on
  an active path and has shipped children); every category-3 direct-child
  placeholder; and any active-path leaf whose children are NOT shipped.
- The `loaded` bit is exactly "does this client currently hold this node's
  direct children?" — and the server's per-stream record of that answer is the
  subject of §5.4.

### 5.3 Composition rule + no-flatten guarantee

**Composition rule:** the snapshot is the minimal set that makes the
always-visible surfaces (top level + live work + one expand level) render
without a round-trip, and NOTHING more. Because there are no ephemeral
`branchStubs` (§11), no "materialized vs stub" concept (§3), and every shipped
node is self-contained, a reload simply re-fetches this small snapshot. The
flatten-on-load bug (#2) is structurally impossible: there is no large
materialized tree to lose and re-derive.

### 5.4 Per-stream loaded set — true-lazy bookkeeping (R2, NEW)

> True lazy forces the server to know, per connection, which nodes that client
> has expanded — because that is exactly what decides "push the real child ops"
> vs. "just bump the parent's aggregate counts." This per-stream state is
> PRECISELY where new drift could re-creep (the thing this rewrite kills), so it
> gets a dedicated, drift-proof specification.

**Model chosen — Option A (server-tracked expanded-set; client never echoes
structure).** The server maintains, per `tree=2` stream connection, an
**expanded-set** `E_c ⊆ ids` — the set of nodes that connection has loaded the
direct children of. It is populated in exactly two ways:

1. **Initial snapshot (§5):** `E_c` is seeded to the set of nodes shipped
   `loaded:true` (category-2 active-path nodes whose children are present).
2. **Explicit expand (§8):** when connection `c` completes a `node.children`
   terminal batch (`hasMore:false`) for parent `P`, the server adds `P` to
   `E_c`. A collapse (client-only, §8.4) is reported back as a `loaded:false`
   hint but the server may keep `P ∈ E_c` briefly; the correctness does NOT
   depend on the client echoing collapse.

Given `E_c`, the emit rule on ANY structural change to a parent `P` is
deterministic and has NO client-guess surface:

- **If `P ∈ E_c` (loaded on this connection):** emit the REAL child op —
  `node.children` (for a new-child batch) or `node.upsert`/`node.move`/
  `node.remove` for the individual child — so the client's loaded subtree stays
  exact. Also bump `P`'s `childCount`/`descendantCount` via `node.facet`/`
  node.upsert` if they changed.
- **If `P ∉ E_c` (collapsed on this connection):** emit ONLY a `node.facet` (or
  the count fields of a `node.upsert`) on `P` — i.e. `childCount` and
  `descendantCount` adjust, and `flags.subtreeNeedsInput` (Q2) propagates — but
  NO child `node.upsert`/`node.children`/`node.move` for `P`'s children is sent.
  The client's collapsed row simply re-renders "▸ N±1".

**Why this cannot diverge (justification against core principle 1).** The
client NEVER decides whether a child op applies; it NEVER echoes its loaded-set
as structural authority (Option B was rejected precisely because a client-echoed
set is a second source of structure truth). Structure authority flows one way:
the server's `E_c` decides what is pushed, and `E_c` itself is built only from
server-observed events (the §5 seed and the §8 expand requests the server
received). The client's only inputs are: apply every op verbatim (§7), and send
expand requests (§8). There is no code path by which the client can observe a
structure the server did not intend: a child op is sent iff the server believes
this connection has the parent loaded, and that belief is set by the server's
own record of what it shipped / what expand it served.

**Reconnect interaction (R3/§5.5).** `E_c` is per-CONNECTION, not persisted
across reconnects. On a stream drop+resume, the resume cursor (§5.5) replays
missed ops, and the reconnect baseline is re-established from the §5 snapshot
seed (which re-derives `E_c`) on a ring-gap. So a reconnect can never leave
`E_c` stale relative to what the client actually holds: either the ring replay
covers the gap (and `E_c` is unchanged, matching the client's unchanged loaded
set), or a fresh snapshot re-seeds both the flat map AND `E_c` together. The two
never disagree.

**Phase 2 implementation note.** `E_c` lives in the per-connection stream state
beside the existing subscriber channel (`server.go` `handleStream` per-conn
state). It is updated under the same emit lock that enforces INV-A/INV-B (§4.7),
so "add P to E_c" and "emit the children batch" are atomic w.r.t. concurrent
structural events. Phase 2 adds an emitter unit test that, for each event in the
§6 table, asserts the correct branch (real child op vs. count-only facet) was
taken for both `P ∈ E_c` and `P ∉ E_c`.

### 5.5 Reconnect / op-replay (R3, NEW)

> §5.0–5.4 cover cold load. NOTHING in v1 covered the stream DROPPING and
> reopening — which is frequent (tunnel blip, browser sleep, EventSource
> auto-reconnect) and which silently clobbered a model selection in production.
> This section makes resume a first-class part of the protocol. It mirrors the
> existing Stream1 cursor/replay semantics already in the tree (cited below) so
> Phase 2 reuses rather than reinvents.

**Protocol.**

1. **Monotonic `seq` (INV-A, §4.7).** Every tree=2 op envelope carries a `seq`
   strictly increasing within one daemon epoch. The client persists the last
   APPLIED `seq` as its resume `cursor` (alongside the existing Stream1
   `state.cursor`, `web/src/sync/stream.ts:106`). On a tree=2 stream the
   `cursor` is the tree-op cursor specifically.
2. **Resume from cursor.** When the `tree=2` EventSource reconnects, the client
   sends its last tree `cursor` (query param, mirroring the existing
   `?cursor=`/`Last-Event-ID` resume in `pkg/web/server.go:1404-1417`). The
   server **replays missed ops with `seq > cursor` from a bounded ring** —
   exactly the existing `ringBuffer.since(cursor, head)` mechanism
   (`pkg/state/ring.go:55`, used today via `store.Replay(cursor)` at
   `pkg/web/server.go:1467`). The tree=2 op stream gets its own ring (or a
   filtered view of the existing one); the semantics are identical: returns the
   ops strictly after `cursor` in insertion order, plus the current `head`, plus
   an `ok` flag.
3. **Ring-gap fallback.** If `cursor` is too old (older than the oldest retained
   op — `ring.since` returns `ok=false`, `ring.go:63-65`), the server falls back
   to a FRESH §5 snapshot (cause `"reconnect"`) and the client re-seeds its flat
   map + `E_c` from scratch. This mirrors today's `hasCursor && !replayOK`
   silent-snapshot fallback (`pkg/web/server.go:1513-1518`). A reconnect MUST
   NOT re-ship the whole tree by default — only on a ring-gap, which is rare
   (ring is sized for the blip/sleep window).
4. **Subscribe-before-baseline.** The server subscribes the new connection to
   the live tail BEFORE resolving the replay baseline, so no op slips through
   the gap between replay and live (mirrors `pkg/web/server.go:1448-1449`).
5. **Corrective ops flow through replay too.** The §6.2 server-reconcile
   corrective ops carry `seq` like any other op, so a reconnect that spans a
   reconcile tick replays them — no special-case reconnect handling for
   reconcile.

**What is reused (cite-back for Phase 2).** The entire cursor/replay
substructure already exists for Stream1 and the message layer: the bounded
`ringBuffer` (`pkg/state/ring.go:10-76`), `ClientEvent.Seq`
(`pkg/state/store.go:121`), the `(epoch, seq)` resume-key semantics
(`Snapshot.Epoch`/`Seq` `pkg/state/store.go:153-154` — seq resets per daemon
restart, so a cursor is valid only within one epoch), `store.Replay(cursor)`
(call site `pkg/web/server.go:1467`), the cursor/`Last-Event-ID` resume wiring
(`pkg/web/server.go:1404-1417`), the ring-gap snapshot fallback
(`pkg/web/server.go:1513-1518`), and the client cursor advance on snapshot +
event (`web/src/sync/stream.ts:623`/`:857` snapshot, `:910`/`:1128` event, with
the `trackCursor` discipline at `:954-961`). Phase 2's tree=2 work is to route
tree ops through the SAME ring + cursor plumbing with a `tree=2`-scoped
subscriber interest, NOT to build a new replay system.

---

## 6. Server event → delta mapping table

The new emitter subscribes to the same store events that drive promotions today
(§2.6) and translates each into one or more delta ops. The client never
re-derives structure.

| Store / internal event | Emitted delta op(s) | Notes |
|---|---|---|
| Session created (`KindSessionUpsert`, new id) | `node.upsert{node}` for the new session; **plus**, per-connection per §5.4: if the parent `P ∈ E_c` (loaded on this connection), a `node.children` push carrying the new child AND a `node.facet{childCount:+1}` (and `descendantCount:+1` up the ancestor chain) on `P`; if `P ∉ E_c`, ONLY a `node.facet{childCount:+1, descendantCount:+1}` on `P` and its ancestors (no child op — the client's collapsed row just re-renders "▸ N±1"). | `maintainChildrenOnSessionUpsertLocked` (`subtree_indexes.go:325`) already reabsorbs orphaned children — if the new session re-parents existing orphans, emit `node.move` for each reabsorbed child. |
| Session title/agent/activity/verb updated (`KindActivity`, or `KindSessionUpsert` with changed fields) | `node.facet{id, activity?, verb?}` (high-frequency path) OR `node.upsert{node}` if title/agent changed. | Stop stamping `activity=now` on hydrate/status-reconcile (see §note A) — seed recency from the session's real `Session.time.updated`. |
| Session gains `pendingInput` (`KindQuestionSet`) | `node.facet{id, flags:{pendingInput:true}}` on the session; **plus** Q2 — when `subtreeNeedsInput` flips on an ancestor, `node.facet{id, flags:{subtreeNeedsInput:true}}` for each ancestor whose flag changes (the ONE retained subtree-aggregate badge; propagates up to root). | The ancestor dot is cheap (a partial facet, no subtree walk on the client). |
| Session loses `pendingInput` (`KindQuestionClear`) | `node.facet{id, flags:{pendingInput:false}}`; plus, for each ancestor whose subtree now has no needs-input descendant, `node.facet{id, flags:{subtreeNeedsInput:false}}`. | Computed from `subtreePendingInput` index (subtree_indexes.go); the flip is exact. |
| Permission requested (`KindPermissionSet`) | `node.facet{id, flags:{permission:true}}`. | |
| Permission resolved (`KindPermissionClear`) | `node.facet{id, flags:{permission:false}}`. | |
| Session archived (archive flag set on upsert) | `node.upsert{node, flags:{archived:true}}`. | If archiving the root of subsessions makes them orphans, also emit `node.facet{flags:{orphan:true}}` for each (§9). |
| Session un-archived (archive flag cleared) | `node.upsert{node, flags:{archived:false}}`. | Clear `orphan` on any descendants that were orphaned solely due to this root (§9). |
| Session deleted / pruned (`KindSessionDelete`) | `node.remove{id}`. | `maintainIndexesOnDeleteLocked` (`:620`) orphans the deleted node's children to roots — emit `node.move{id, newParentId:null}` for each orphaned child, then run the orphan check (§9) on them. |
| Parent reparented (effective parent changed via create/delete cascade) | `node.move{id, newParentId}`. | See "Session created" + "Session deleted" rows — `move` is the carrier whenever `effectiveParentOfLocked` flips. |
| Subtree loaded on expand (client `GET /vh/tree/children`) | HTTP response is a `node.children` payload (not an SSE op); same shape. | §8. Pagination via `cursor`/`hasMore`. |

**§note A — stop stamping `activity=now` on hydrate/reconcile (O1 RESOLVED):**
today the hydrate / status-reconcile path stamps `activity=now`, which forces a
full load after restart and seeds the demotion churn. The new model seeds a
node's `activity`/`updatedMs` from the session's real last-activity
(`Session.time.updated` / `subtreeNewestActivity`). The stamping site is now
verified: `pkg/aggregator/aggregator.go:773`
(`runStatusReconcile` periodic tick → `a.store.SetActivityFromStatuses`) and
`:848` (the `hydrate` path → `a.store.SetActivityFromStatuses`, inside the
`run("SessionStatuses", ...)` goroutine at `:843`). That call descends to
`store.SetActivityFromStatuses` (`pkg/state/store.go:1703`) → per-session
`setActivityLocked` (`pkg/state/store.go:1421`), which captures
`now := time.Now()` (`store.go:1446`) and writes `lastActivityAt[sessionID]=now`
via `touchActivityTimeLocked` (the comment at `store.go:1443` notes the
override-to-now). Note this is the activity TIME stamp, not the busy/idle
*state* (state comes from `status.type`); the now-time-stamp is the churn seed.
There is also a tombstone guard at `setActivityLocked` (`store.go:1429`,
`isRecentlyArchivedLocked`) that suppresses the stamp for recently-archived ids.
Phase 2 removes the now-stamp in favor of real `Session.time.updated` recency.
O1 is therefore resolved and removed from the open-questions section (§14).

### 6.1 Non-obvious mappings (the riskiest — flagged for review)

- **R1 — Ancestor `childCount`/badge propagation on create/delete.** When a
  child is added/removed, the parent's `childCount` changes and the ancestor's
  `descendantCount` changes (D1). The table emits a parent
  `node.upsert`/`facet`. *Risk:* if the server forgets an ancestor, the client
  shows a stale `▸ N`. Mitigation: derive `childCount` directly from
  `len(children[id])` and `descendantCount` from `subtreeDescendantCount` at emit
  time so both are always exact. Whether the real child op OR only the count
  facet is emitted is decided per-connection by §5.4 (`P ∈ E_c`).
- **R2 — Orphan-on-delete cascade vs. orphan-on-archive.** Delete reparents
  children to root (`maintainIndexesOnDeleteLocked`); archive does NOT delete.
  A subsession whose *root* is archived becomes an orphan only if the cascade
  missed it (§9). *Risk:* emitting `orphan:true` for a live-rooted session
  (the original false-orphan bug). Mitigation: the orphan rule in §9 explicitly
  excludes any session whose root is live.
- **R3 — `move`/`upsert` ordering vs. `parent-before-child` (NOW A HARD
  INVARIANT).** If a parent is re-created
  (`maintainChildrenOnSessionUpsertLocked` reabsorbs), the server emits the
  parent `upsert` BEFORE the children's `move`. This is no longer a "state
  explicitly in Phase 2" risk note — it is enforced emit-time invariant INV-B
  (§4.7). The client apply logic (§7.2) assumes it holds; a violation is a
  server bug, not a recoverable client state. Phase 2 adds an emitter unit test
  that asserts INV-B across every event in this table and every §6.2 reconcile
  flush.

### 6.2 Server reconcile vs OpenCode's authoritative list (R4, NEW)

> §6 (reactive) maps OpenCode's `/event` stream → ops. But `/event` is
> **unreliable in the exact ways that caused our bugs**: it can MISS deletes
> (→ resurrection/ghosts) and CLOBBER-revert archives on busy sessions. A
> dropped delete means the server never emits `node.remove` and the client ghosts
> — the same dual-ownership bug, one layer down. This section adds a first-class
> SERVER RECONCILE that absorbs OpenCode's flakiness in ONE server-side place,
> leaving the client a dumb applier. It also FOLDS the existing archive
> re-assert + resurrection tombstone INTO the same loop so Phase 2 merges rather
> than duplicates them.

**(a) The daemon holds ALL sessions in memory; "lazy" is client-facing ONLY.**

OpenCode's API is FLAT. `pkg/opencode/client.go` exposes only `GET /session`
(flat list, `ListSessions` at `client.go:86` → `listSessionsAdaptive` at `:94`,
which starts at `limit=2000` and doubles while the page is full up to a 1M
bound; the comment at `:80-85` notes 1.17.x has no backward pagination, so this
effectively returns ALL non-archived sessions), `GET /session/status`
(`SessionStatuses` at `:319`), and `GET /event` SSE (`SubscribeEvents` at
`:411`, no replay — the caller owns reconnect). Native archive is
`PATCH /session/:id` `time.archived` (`SetArchived` at `:149`). There is no
hierarchy, no children endpoint that the daemon uses, and no subtree
pagination.

Consequently the daemon builds the tree ENTIRELY from the flat `/session` list +
`parentID`: the aggregator's `hydrate` (`pkg/aggregator/aggregator.go:779-798`)
calls `store.Hydrate(sessions, messages)`, which builds the
`children[parentID]` map from each session's `env.ParentID` via
`maintainChildrenOnSessionUpsertLocked` (`subtree_indexes.go:325`; call sites
`store.go:1967`, `:3799`). So:

- **"Lazy" is client-facing ONLY.** The server always answers an expand (§8)
  from its OWN in-memory store INSTANTLY — it does NOT call OpenCode per-expand.
- **Nobody should try to lazy-load from OpenCode per-node — it is impossible.**
  There is no `/session/:id/children` endpoint the daemon consumes.

> **Citation correction (verified).** The review brief described OpenCode as
> having "no children endpoint." There IS a `Children` method
> (`pkg/opencode/client.go:327-334` → `GET /session/:id/children`), but `grep`
> for `\.Children\(` across all `.go` files returns ZERO callers — it is dead
> code, never invoked. The daemon never uses it; the tree is built from the flat
> list + parentID as described above. The reviewer's FUNCTIONAL claim is correct;
> this doc states it precisely and notes Phase 2 MUST NOT rely on the dead
> `Children` method (OpenCode 1.17.x semantics for it are unverified and it is
> unmaintained in this codebase).

**(b) The reconcile loop.** The server runs a periodic reconcile tick that
DIFFS its in-memory store against OpenCode's authoritative `/session` list
(`ListSessions`) and emits CORRECTIVE ops for any drift. The client never
re-derives anything; it just applies these ops like any other. The corrective
ops are:

- **`node.remove`** for any session the server has in its store but that is GONE
  from the authoritative `/session` list. This is what kills ghosts/resurrection:
  if `/event` dropped a delete, the store still holds a stale node, and this
  reconcile `node.remove` evicts it deterministically rather than waiting for a
  reload.
- **`node.upsert`** (with refreshed `flags.archived`, and any other drifted
  facet) for sessions whose archive STATE in `/session` disagrees with the
  store. This handles the clobber-revert-archive case (a busy session whose
  archive was reverted by a late `/event`) by re-asserting the authoritative
  state.
- **Re-assert `PATCH time.archived`** for archives the server owns but that
  OpenCode's list shows as un-archived (the clobber case) — i.e. the server
  re-applies the archive to OpenCode to restore its intended state, then emits
  the matching `node.upsert{flags:{archived:true}}`.

**Cadence.** The tick runs on the same kind of periodic-ticker as
`runStatusReconcile` (`pkg/aggregator/aggregator.go:755`; the existing
`/session/status` reconcile at `:773`). A conservative default cadence (e.g.
a few seconds) bounds the worst-case ghost/window visibility; the tick is cheap
(a flat-list diff against an in-memory map), so it can run frequently. Every
corrective op carries a `seq` (§4.1/INV-A) and therefore flows through the
reconnect/replay ring (§5.5) — a client that drops and resumes across a
reconcile tick replays the corrections, no special-case reconnect handling.

**Fold existing mechanisms INTO this loop (do not duplicate).** Two
already-shipped server-side corrections must merge into the reconcile tick
rather than live as separate code paths:

- **Archive re-assert** — `pkg/web/archive.go`: `reassertArchive` (func at
  `:197`, "Server-owned post-archive re-assert / Issue A"), the launching
  goroutine `go s.reassertArchive(...)` at `:181`, `defaultReassertDelay=1s`
  (`:27`), and the server seams `reassertDelay` (`pkg/web/server.go:190`),
  `reassertReadyCh`/`reassertBlockCh` (`:198-199`), `SetReassertDelay` (`:351`).
  This is the SAME class of correction (re-assert an archive OpenCode lost);
  Phase 2 moves it under the reconcile tick's archive branch.
- **Resurrection tombstone** — `pkg/state/store.go`: `RemoveSessions` (`:2112`,
  sets the `recentlyArchived` tombstone at `:1142`), `ClearArchiveTombstones`
  (`:2132`), `isRecentlyArchivedLocked` (`:2089`), `recentArchiveTTL=30s`
  (`:2624`). The tombstone suppresses resurrection (the guard in
  `upsertSessionLocked` at `:1935`, and in `setActivityLocked` at `:1429`). The
  reconcile's `node.upsert`-refresh branch must respect the SAME tombstone (a
  recently-archived id is not blindly re-revived by a stale `/session` entry),
  so the tombstone logic is reused, not re-implemented.

**Net effect.** OpenCode's `/event` flakiness is absorbed in exactly ONE
server-side place (the reconcile tick). The client remains a dumb op-applier
that never has to detect or repair ghosts/archives itself — which preserves the
core principle ("the server owns structure; the client never guesses") even in
the face of an unreliable event source.

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

> **Q5 RESOLVED:** the delete-time orphan check re-checks ONLY the newly-rooted
> children. It does NOT re-check the deleted node's *siblings*. Sibling orphan
> status is unaffected by a delete (a sibling's root chain is unchanged), so a
> sibling sweep would be dead work. Any sibling drift is caught by the §6.2
> reconcile tick instead.

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

> **DONE — executed in Phase 4 (commit `a0e825c`).** `tree=2` is now the sole
> path; the `proj=1`/projection machinery targeted below was deleted. The items
> below are the historical delete plan as executed, not a pending TODO.

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
- `pkg/state/tree_reconcile.go` — the periodic §6.2 reconcile tick (diffs the
  store vs OpenCode's authoritative `/session` list, emits corrective
  `node.remove`/`node.upsert`/archive re-assert; folds `archive.go`
  `reassertArchive` + the store resurrection tombstone under one loop).
- `pkg/web/tree_children.go` — the `GET /vh/tree/children` handler (§8),
  beside `handleBranch`.
- `pkg/state/tree_node.go` — the `Node`/delta-op Go types (§3, §4) + JSON tags.

**MODIFY:**
- `pkg/web/server.go` — add `wantsTree2`, branch in `handleStream`
  (`:1360`); register `/vh/tree/children` route; route tree=2 ops through the
  existing ring + cursor/replay plumbing (`:1404-1518`) with a tree=2-scoped
  subscriber interest (§5.5); add per-connection expanded-set `E_c` state beside
  the subscriber channel (§5.4).
- `pkg/web/archive.go` — invoke the orphan check (§9) on archive/un-archive;
  MOVE `reassertArchive` (`:197`, launch `:181`) under the §6.2 reconcile tick's
  archive branch (merge, not duplicate).
- `pkg/state/subtree_indexes.go` — add an orphan-flagging hook in
  `maintainIndexesOnDeleteLocked` (`:620`) (additive; no index shape change).
- `pkg/state/store.go` — the resurrect-tombstone guard (`isRecentlyArchivedLocked`
  `:2089`/`upsertSessionLocked` `:1935`/`setActivityLocked` `:1429`) is REUSED by
  the §6.2 reconcile `node.upsert`-refresh branch (do not re-implement).
- (O1 RESOLVED — was "Open O1") `pkg/aggregator/aggregator.go:773` (status
  reconcile tick) and `:848` (hydrate) → `pkg/state/store.go:1703`
  `SetActivityFromStatuses` → `:1421` `setActivityLocked` captures
  `now := time.Now()` (`:1446`) and writes `lastActivityAt[id]=now`
  (`touchActivityTimeLocked`). Remove the now-stamp in favor of real
  `Session.time.updated` recency.

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

> **DONE — executed in Phase 4 (commit `a0e825c`).** Every deletion listed below
> was carried out; the files/symbols named no longer exist in the tree. Retained
> as the executed delete inventory (the historical record), not a pending TODO.

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
  - **R1 cold-load size invariant:** assert the cold snapshot node count equals
    `roots + active-path nodes + direct-children-of-loaded`, and is INDEPENDENT
    of total idle-session count (add 1000 idle ancestors → snapshot unchanged).
  - **R2 per-stream loaded-set:** for a structural child event on parent `P`,
    assert a connection with `P ∈ E_c` gets the real child op, and a connection
    with `P ∉ E_c` gets ONLY a count facet (no child op). Assert `E_c` is seeded
    from the §5 snapshot and grown on a terminal `node.children` expand.
  - **R3 reconnect/replay:** drop+resume with a recent cursor → assert the
    missed ops replay from the ring in seq order; resume with a stale cursor
    past the ring → assert the fresh-snapshot fallback re-seeds the flat map +
    `E_c`. Assert corrective ops (§6.2) replay too.
  - **INV-B (parent-before-child) emission:** for every event in the §6 table
    (incl. parent-re-creates-orphan-absorption) and every §6.2 reconcile flush,
    assert no child op precedes its parent in the same flush.
  - Per-event delta: drive each event in the §6 table through `Apply`, assert
    the emitted op(s) match the table exactly.
  - Orphan rule (§9): archive a root with subsessions → assert `flags.orphan`
    on descendants; un-archive → cleared; live-rooted → never orphaned.
- **Reconcile unit tests** (`pkg/state/tree_reconcile_test.go`): a session
  present in the store but GONE from the authoritative `/session` list →
  corrective `node.remove` (ghost kill); an archive state disagreement →
  corrective `node.upsert{flags:{archived}}` + archive re-assert; assert the
  resurrect tombstone suppresses re-revival of a recently-archived id; assert
  every corrective op carries a `seq`.
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

> **Revision 1:** all open questions from v1 are now RESOLVED and baked into the
> doc above. They are retained here (as resolutions) for review traceability.
> O1 is removed (resolved + cited).

- **Q1 — RESOLVED (§5.1).** Active path = `activity ∈ {busy,retry,error}` OR
  `flags.permission` OR `flags.pendingInput`. **An archived session NEVER seeds
  an active path**, even if nominally busy in `/session/status`. A non-archived
  active session pulls its full ancestor chain to root as loaded nodes.
- **Q2 — RESOLVED (§3, §6).** Keep exactly ONE subtree-aggregate badge: an
  ancestor **"needs-input" dot** (`flags.subtreeNeedsInput`), propagated up the
  ancestor chain when a subtree `pendingInput` flips. ALL other subtree
  aggregation is dropped. (This refines any earlier "drop all subtree
  aggregation" stance — exactly one flag survives.)
- **Q3 — RESOLVED (§4.2/§4.6).** Keep the `node.facet` / `node.upsert` split:
  `node.facet` for high-frequency activity/verb/flag updates (partial merge,
  bandwidth-friendly); `node.upsert` for full-Node replaces (structural/title/
  agent changes).
- **Q4 — RESOLVED (§8.3).** Keep the stale-cursor restart behavior (mirrors
  today's `lazyExpandBranch` `stream.ts:2797`).
- **Q5 — RESOLVED (§9.2).** No sibling re-check on delete. The delete-time
  orphan check re-checks ONLY the newly-rooted children; sibling orphan status
  is unaffected by a delete, and any drift is caught by the §6.2 reconcile tick.
- **O1 — RESOLVED & REMOVED (§6 §note A).** The `activity=now` stamp site is
  verified: `pkg/aggregator/aggregator.go:773` (`runStatusReconcile`) and
  `:848` (`hydrate`) → `pkg/state/store.go:1703` `SetActivityFromStatuses` →
  `:1421` `setActivityLocked` captures `now := time.Now()` (`:1446`) and writes
  `lastActivityAt[id]=now` via `touchActivityTimeLocked`. Phase 2 replaces the
  now-stamp with real `Session.time.updated` recency. (The reviewer's "stamps
  activity=now" refers to the activity TIME stamp, not the busy/idle state.)

---

**End of Phase 1 design (rev. 1 — post-review). No code written. Awaiting
human re-review before Phase 2.**
