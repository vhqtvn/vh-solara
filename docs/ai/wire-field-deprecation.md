# Wire-field deprecation — alias-during-transition (audit L-03 / L-09 / L-10)

> **Posture B (alias-during-transition).** The daemon DUAL-EMITS old + new JSON
> field names with the **same value** in responses. The SPA migrates to read the
> new (exact) names. The old names are **retained** during a deprecation window.
> Removal of the old names is a **future slice gated on an operator-approved
> cutoff**.

This doc is the standing reference for the three wire fields renamed in the
state-layer contract audit's naming batch (wire-facing half). The
internal-only renames (L-02 / M11) shipped separately in `87784ab` and are not
covered here.

## Why dual-emit (not a hard rename)

A hard rename on the wire breaks a **stale un-reloaded tab**: the browser holds
a previously-served SPA bundle that reads the old field names. A long-lived tab
can span releases, so "remove the old name after one release" is **not provably
safe** — a tab opened before the release and never reloaded would still be
reading the old name after the release that removed it.

The dual-emit is the compatibility mechanism: both names carry the same value,
so:

- a **new (reloaded) SPA** reads the new exact names;
- a **stale (un-reloaded) SPA** keeps working via the retained old names;
- **non-SPA consumers** (coordapi / MCP / headless scripts) that read the old
  names keep working unchanged.

There is **no enforced version negotiation** — the dual-emit *is* the compat
mechanism, not a schema-negotiation protocol.

## The three aliased fields

### L-03 / M3 — `hydrated` → `hasMessages` (snapshot.gate response)

| | |
|---|---|
| **Old wire field** | `hydrated` (json tag) on `GateFacts` |
| **New wire field** | `hasMessages` (json tag) on `GateFacts` |
| **Semantics** | "some message state exists" — a live tail OR a history hydrate |

`hydrated` over-promises "loaded", but the value it actually carries is "this
session has *some* message state" (it is true once either a live event OR a
history hydrate has landed). `hasMessages` is the exact name for that fact.

This is **distinct from** `messagesLoaded` (the strict "full history fetched AND
resident" predicate), which is a separate existing field and is **unchanged**
(L-02 handled the client-side collision with it; the wire spelling stays).

- **Go:** `pkg/state/store.go` (`GateFacts.Hydrated` + `GateFacts.HasMessages`);
  populated in `pkg/state/snapshots.go` from one computed value
  (`sc.msgLoaded || sc.hasMessages` — note `sc.hasMessages` here is the internal
  `snapshotCapture` tracking field, not the wire `hasMessages` field) assigned to
  both, so the two wire fields provably carry the same value.
- **SPA:** reads `hasMessages` (`web/src/sync/reducers.ts`, the resync-window
  check). The old `hydrated` access was migrated; no `g.hydrated` read survives
  in `web/src`.

### L-09 / M12 — `permission_blocked` → `permissionWasBlocked` (snapshot.gate response)

| | |
|---|---|
| **Old wire field** | `permission_blocked` (json tag) on `GateFacts` |
| **New wire field** | `permissionWasBlocked` (json tag) on `GateFacts` |
| **Semantics** | sticky historical fact — "permission blocking occurred historically" |

`permission_blocked` reads like a bare current auto-reject state. The value is
actually the sticky historical "permission blocking occurred" fact.
`permissionWasBlocked` is the exact (past-tense) name.

- **Go:** `pkg/state/store.go` (`GateFacts.PermissionBlocked` +
  `GateFacts.PermissionWasBlocked`); populated in `pkg/state/snapshots.go` from
  `sc.permBlocked` into both.
- **SPA:** does **not** currently read either name. Declared in
  `web/src/types.ts` (`GateFacts`) so future reads adopt the exact name.
  Non-SPA consumers (coordapi / MCP / headless) may read either.

### L-10 / M13 — `running` → `runningRoots` (/vh/projects response)

| | |
|---|---|
| **Old wire field** | `running` (json tag) on `projectInfo` |
| **New wire field** | `runningRoots` (json tag) on `projectInfo` |
| **Semantics** | the count of running ROOTS (a cardinality + topology correction) |

`running` alone is ambiguous with a session count or a process count.
`runningRoots` names exactly what the value is: the number of root sessions
whose subtree has ≥1 busy/retry session.

- **Go:** `pkg/web/server.go` (`projectInfo.Running` +
  `projectInfo.RunningRoots`); populated from one computed value
  (`st.RunningRoots()`) assigned to both.
- **SPA:** reads `runningRoots` (`web/src/projects.ts`, `buildActivityMaps`).
  The old `p.running` wire read was migrated. (Internal `ActivityMaps.running`
  map and `ProjectActivityRow.running` are *not* wire reads and keep their
  names.)

## Compat-window policy

- **Old names are retained** until an operator-approved cutoff. "After one
  release" is **not** a safe cutoff — a long-lived un-reloaded tab can span
  releases, so the removal must be gated on an explicit operator decision that
  no in-flight stale consumer remains (or that breaking them is acceptable).
- **During the window:** both names are present and carry the same value on
  every response. A new SPA reads the new names; a stale SPA reads the old
  names; both are populated.
- **Removal is a future slice**, not this one. The standing-check tests
  (`TestGateDualEmitsHydratedAndHasMessages`,
  `TestGateDualEmitsPermissionBlocked`, `TestProjectsDualEmitsRunningAndRunningRoots`
  in Go; `wire-field-aliases.test.ts` in TS) currently assert **both-present**
  (alias phase). When the old names are removed, those checks flip to
  **old-absent**.

## Value identity during transition

The correction is the **name**, not a value change. During the alias phase the
new field carries the **same value** as the old field. The Go population sites
compute the value once into a local and assign it to both struct fields, which
guarantees identity by construction (verified by the dual-emit standing-checks:
they assert the two names carry the same value in the serialized JSON).

If a future change ever needs the new name to carry a *different* value than the
old, that is a design decision — the dual-emit (same value) is no longer the
right model and this doc must be updated.
