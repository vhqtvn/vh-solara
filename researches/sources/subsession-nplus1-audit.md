# Subsession N+1 Audit — Source Packet

**Scope:** Read-only investigation of whether subsession/parentage/tree handling
is a separate synchronous N+1 + per-session JSON-parse cost on the
session-selection / tree slowness hot path (distinct from the already-fixed
message-fetch paths).
**Repo:** vh-solara @ HEAD `ddd208a` (working tree = Slice C uncommitted).
**Date:** 2026-07-01.
**Artifact type:** `sources` (fact packet; verdict register, not a decision).
**Time-sensitivity:** STABLE — grounded in current code; not recency-dependent.

## Verdict register

| Hypothesis component | Verdict | Confidence |
|---|---|---|
| Per-session upstream call to fetch subsession/parentage (N+1 select) | **RULED OUT** | high |
| Parentage derived via separate per-session fetch | **RULED OUT** (inline in flat list) | high |
| Per-session JSON parse of subsession payloads on the snapshot hot path | **RULED OUT** | high |
| Any subsession-specific synchronous cost on tree-stream / selection | **RULED OUT** | high |

**Bottom line:** There is NO subsession N+1. `opencode.Client.Children`
(`/session/:id/children`) is the only subsession-specific upstream method and it
is **never called anywhere in the codebase**. Parent-child relationships are
carried INLINE on every session object in the single `GET /session` list response
and parsed once from `sessionEnvelope.ParentID`. The server emits a flat session
list; the client builds the tree from `parentID`. The only per-session upstream
loop in the aggregator (`seedColdLastAgents`) fetches the message TAIL for
lastAgent chips — already backgrounded+memoized at `ddd208a` — and is unrelated
to subsession/parentage.

## Findings

- **(finding)** `opencode.Client.Children` — the only subsession-specific upstream
  method — is DEFINED but NEVER CALLED. Repo-wide grep for `.Children(` returns
  exactly one match: its own definition.
  source=`pkg/opencode/client.go:302-309`, confidence=high, type=fact.
  Mechanism: `getJSON(ctx, "/session/"+sessionID+"/children", &out)`. Dead code
  w.r.t. the hot path.

- **(finding)** Parentage is INLINE in the flat `ListSessions` (`GET /session`)
  response, parsed from `sessionEnvelope.ParentID` (id + parentID + time.archived
  only — envelope-light, schema-resilient).
  source=`pkg/state/store.go:253-259` (envelope), `pkg/state/store.go:760`
  (entry stores `parentID: env.ParentID`), `pkg/state/store.go:1510` (hydrate
  sets it), confidence=high, type=fact.

- **(finding)** The session TREE is built CLIENT-SIDE from inline `parentID`; the
  server never constructs a tree. `buildChildrenIndex` groups by `parentID`
  (`""` = roots); the docstring states "The subsession tree derives entirely from
  Session.parentID."
  source=`web/src/lib/reduce.ts:7-8,14-33`, confidence=high, type=fact.
  Corroborated by frontend `parentID` walks: `web/src/orphans.ts:40-47`,
  `web/src/sync/selectors.ts:10-14,229`.

- **(finding)** `Snapshot` emits a FLAT session list (raw `se.info` bytes
  appended as-is, no re-marshal, no per-session JSON), plus in-memory gate facts.
  No tree construction server-side; no per-session network.
  source=`pkg/state/store.go:1334-1336` (`snap.Sessions = append(..., se.info)`),
  confidence=high, type=fact.

- **(finding)** `hydrate()` issues exactly these upstream calls: 1×
  `ListSessions` + 1× `SessionStatuses` + 1× `ListQuestions` + 1×
  `ListPermissions` + `client.Messages` **only for already-loaded sessions**
  (reconnect re-hydration of opened sessions, bounded by #opened not #total). NO
  per-session subsession/children call.
  source=`pkg/aggregator/aggregator.go:277-327`, confidence=high, type=fact.

- **(finding)** The ONLY per-session upstream loop in the aggregator is
  `seedColdLastAgents`, and it fetches the message TAIL
  (`client.MessagesTail`, `coldTailLimit=10`), NOT subsession info. It seeds
  `lastAgent` chips for cold/un-opened sessions. Already BACKGROUNDED off the
  hydrate hot path + memoized (fire-once-per-session via `store.seeded`).
  source=`pkg/aggregator/aggregator.go:309` (`startColdSeed` non-blocking),
  `400-464` (the loop, 8-wide sem), `329-332` (tail limit),
  `pkg/state/store.go:1664-1687` (`ColdSeedNeeded`/`MarkColdSeeded` memo).
  confidence=high, type=fact. This is the ddd208a fix — correctly attributed to
  message-tail/lastAgent, NOT subsession.

- **(finding)** The only per-snapshot O(sessions) CPU is
  `computeSubtreeBusyLocked` (builds children map from all sessions + memoized
  post-order DFS) — pure in-memory maps, no network, no JSON, called once per
  `Snapshot`. Bounded O(n); not an N+1; not subsession-fetch.
  source=`pkg/state/store.go:1286` (call site), `1369-1406` (impl).
  confidence=high, type=fact. (Also paid by `SendableNow` at `store.go:1426`, the
  per-send gate check — not the tree/stream hot path.)

- **(finding)** Per-session JSON unmarshal exists but is BOUNDED and NOT on the
  snapshot/stream hot path, and NOT subsession-specific: (a) `store.Hydrate`
  does one envelope-only unmarshal per session on hydrate-reconcile
  (`store.go:1500-1513`); (b) `shapeSessions` (/vh/sessions INVENTORY endpoint,
  separate from the live tree) does one envelope unmarshal per session
  (`pkg/web/sessions.go:245-298`). The snapshot path does zero per-session JSON.

## Path separation

### (a) Tree-stream path — all sessions (Stream 1)
`web/src/sync/stream.ts:417` → `EventSource("/vh/stream?sessions=&dir=...")`
(empty filter = tree-only) → `handleStream` fresh-client branch
(`pkg/web/server.go:866-878`): `triggerMessageLoad` is a **no-op for empty
filter's message scope** (no selected session) → `store.Snapshot(filter)`
builds the tree-only snapshot purely in-memory. **Zero per-session upstream
calls; zero per-session JSON.** Synchronous cost = one in-memory `Snapshot`
(O(sessions) for gate facts + `computeSubtreeBusyLocked`) + one
`json.Marshal(snap)` (`server.go:875`).

### (b) Single-session selection path (Stream 2)
`web/src/sync/stream.ts:525` → `EventSource("/vh/stream?sessions=${id}&dir=...")`
→ `handleStream` fresh-client branch: `triggerMessageLoad(agg, filter)`
(`server.go:873`) kicks ONE `EnsureMessagesAsync` for the selected session
(non-blocking; per-session single-flight) → `store.Snapshot(filter)` includes
that one session's messages. **Zero subsession calls.** The async message fetch
is the Slice C fix — correctly attributed to single-session message history,
NOT subsession.

### Off-hot-path (not the slowness, noted for completeness)
- `/vh/sessions` INVENTORY endpoint (`handleSessions`, `sessions.go:95-136`):
  separate browser endpoint, not the live tree. One `ListSessions` (+ optional
  `ListArchivedSessions`) + `shapeSessions` envelope unmarshal per session.
  Roots-only filter is a per-record `ParentID != ""` check (`sessions.go:263`),
  not a tree walk.
- `/vh/sessions/closeout` (`sessions.go:160`): an EXPLICIT N+1 — per-id
  `client.Messages` in a loop (`sessions.go:171-176`, comment acknowledges it).
  This is a batch closeout-text endpoint, NOT the tree/stream path; unrelated to
  subsession parentage.

## N+1 detection (explicit)

There is **no subsession N+1**. For completeness, the per-session upstream
loops that DO exist:

| Loop | Per-session call | Sync/blocking? | Scales with | Subsession-related? |
|---|---|---|---|---|
| `seedColdLastAgents` (aggregator.go:437-459) | `MessagesTail` (msg tail) | **NO** — backgrounded (ddd208a) | #un-seeded sessions | NO (messages/lastAgent) |
| `hydrate` loaded re-fetch (aggregator.go:288-295) | `Messages` | yes (on reconnect) | #already-OPENED sessions | NO (messages) |
| `handleSessionsCloseout` (sessions.go:171-176) | `Messages` | yes (request-scoped) | #requested ids | NO (messages) |
| **(subsession/children)** | **none** | — | — | **N/A — RULED OUT** |

`client.Children` call count on every code path: **0**.

## Contradiction audit

- **Cold-seed (ddd208a) — NOT mis-attributed, but likely the perceptual source.**
  The cold-seed fired a `MessagesTail` per cold session (including every cold
  subsession) SYNCHRONOUSLY on the hydrate hot path before ddd208a. Because it
  touched every session including subsessions, an operator profiling "tree is
  slow, lots of subsessions" could reasonably perceive it as a "subsession N+1."
  It was real per-session upstream cost, but the unit of work was
  message-tail/lastAgent seeding, not subsession/parentage resolution. Now
  backgrounded + memoized. **If the operator's "N+1" intuition came from anywhere,
  it came from here — and it is already fixed.**
- **EnsureMessagesAsync (Slice C) — correctly attributed** to single-session
  message history on selection. No subsession involvement.
- **No hidden subsession cost behind either fix.** The subsession/parentage data
  flows through the same single `ListSessions` call as root sessions; there is no
  separate subsession codepath to hide.

## Stale-guidance / dead-code flags

- `opencode.Client.Children` (`pkg/opencode/client.go:302-309`) is unused dead
  code. If a future change is tempted to "use the children endpoint," note the
  architecture deliberately derives the tree from inline `parentID` (no N+1).
  Candidate for deletion or an explicit "kept for future use" comment — not a
  fix target.

## Confidence

HIGH. Every claim is a direct file:line read of current code; the architecture
is unambiguous (flat list + inline parentID + client-side tree). No inference
load on the core verdict.

## Recommended next-step framing

**No fix needed** — the hypothesis is ruled out. The two prior fixes (ddd208a
cold-seed backgrounding, Slice C async message selection) already covered the
real per-session upstream costs. There is no third, subsession-specific N+1 to
address.

If residual tree slowness is STILL observed after Slice C lands, the remaining
suspects are NOT subsession N+1 and should be re-scoped to a new researcher pass:
- **Frontend O(n²) tree work**: `anyDescendantWorking` (`web/src/lib/reduce.ts:39-59`)
  scans `Object.values(sessions)` inside a per-node walk — O(n × descendants) per
  render. A frontend-performance researcher pass, not a backend N+1.
- **`computeSubtreeBusyLocked` per-snapshot CPU** (`pkg/state/store.go:1373-1406`):
  O(sessions) in-memory on every `Snapshot`. Bounded, no network; only relevant
  at very high session counts. A Go-side CPU-profile pass if session counts are
  extreme.
- **`/vh/sessions/closeout` explicit N+1** (`sessions.go:171-176`): real per-id
  `Messages` loop, but a separate batch endpoint — only relevant if the closeout
  view is itself slow.

**Specialist routing if pursued:** none of the above is a `debate`-grade
decision (no option tradeoff); a `researcher` → `planner` handoff for whichever
residual suspect a profile points at. **No file paths to touch for a "subsession
N+1 fix" — there is nothing to fix.**

## Promotion targets
None. This packet exists to PREVENT a speculative subsession-refactor slice. No
live doc (AGENTS.md, backlog, checkpoints) should be updated to describe a
subsession N+1 — that would record a non-existent bug as canon.
