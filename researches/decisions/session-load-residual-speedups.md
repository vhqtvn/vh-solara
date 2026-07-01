# Session-load residual speedups — restudy after P1-AGG-001 / P1-WEB-014

*Date: 2026-07-01.* Read-only restudy decision memo; two slices (#1a, #2)
implemented from it on 2026-07-01.

## Summary

After P1-AGG-001 (async message hydration on first-open) and P1-WEB-014
(cold-seed off the hydrate path), the **first-open path for the active session
is near-optimal**. Residual latency migrated to the **reconnect / away-back /
multi-session path**. The FE render layer is clean (bounded by `Deferred`; no
GPU-trap wins available). Two slices implemented from this memo on 2026-07-01
(#1a and #2).

## Ranked opportunities (gain-per-risk)

### #1 — `refreshOpenSessions` serial N× `/vh/snapshot` on every tree reconnect — CLEAR WIN — IMPLEMENTED (variant a)
- **Location:** `web/src/sync/stream.ts:303-315` (serial `await` loop) →
  `fetchSessionMessages` → `GET /vh/snapshot` → `pkg/web/server.go:741-762`
  `handleSnapshot` (sync `ensureMessages` → `store.Snapshot` → JSON encode).
  `state.messages` grows per opened session (`web/src/sync/actions.ts:72-80`),
  pruned only on project switch.
- **Why on critical path:** reconnect / away-back / tab-switch-back. Every fresh
  tree-stream connection loops `Object.keys(state.messages)` (every session ever
  opened this run) and `await fetchSessionMessages(id)` serially; on a cold
  daemon each blocks on upstream `client.Messages`. Fire-and-forget (doesn't
  block active-session first paint) but contends for the server event loop and
  serializes the cold-daemon fetch.
- **Fix (variant a, IMPLEMENTED 2026-07-01):** swap the serial loop for
  `Promise.all(...)` with per-session try/catch (one failed fetch keeps stale,
  doesn't starve the batch). FE-only, no server contract change. Tests:
  `web/tests/unit/refreshOpenSessions.test.ts` (concurrency latch + error
  isolation). typecheck clean; vitest 139/139.
- **Variant (b)** — fold open non-active sessions into the reconnect tree
  `/vh/stream` snapshot filter — NOT implemented; bigger server change, defer
  until (a) measured.

### #2 — `hydrate` trailing serial upstream calls gate first snapshot (cold/reconnect) — SMALL-MED, LOW-MED risk — IMPLEMENTED (pending error-semantics decision)
- **Location:** `pkg/aggregator/aggregator.go:313-325` — after `Hydrate`,
  `SessionStatuses`/`ListQuestions`/`ListPermissions` run serially before the
  first snapshot.
- **Prior behavior:** the three calls used `err == nil` guards that **silently
  swallowed** errors (hydrate always returned `nil` regardless). They are
  best-effort enrichment (activity status, pending questions, pending
  permissions).
- **Why on critical path:** cold daemon start / reconnect (epoch change). Adds
  summed latency of 3 sequential upstream GETs to first-snapshot time.
- **Fix (IMPLEMENTED 2026-07-01):** 3-way concurrent fan-out (stdlib
  `sync.WaitGroup`); errors swallowed + `log.Printf` per decision (a), ctx-bound, panic-safe `defer wg.Done()`.
  GATE confirmed `opencode.Client` goroutine-safe (immutable fields;
  `http.Client.Do` safe; existing 8-wide use in `seedColdLastAgents`; store
  mutators locked). Tests:
  `TestHydrateFansOutStatusQuestionsPermissionsConcurrently` + error-aggregation
  test; `go test -race` clean.
- **Gain:** SMALL-MEDIUM (3 serial round-trips → ~1 max).
- **RESOLVED (2026-07-01, decision (a)):** the current implementation SURFACES
  errors (non-nil if any fail), which changes `/vh/reload` error propagation
  where prior code swallowed. Coordinator recommendation applied: reverted to
  swallow (best-effort) + per-error `log.Printf` for observability, keeping the
  concurrent fan-out. This makes #2 a pure perf slice — zero hydrate behavior
  change (POST /vh/reload semantics preserved).

### #3 — `sendable` full `json.Unmarshal` per live event to read sessionID — SMALL, LOW risk — NOT IMPLEMENTED
- **Location:** `pkg/web/server.go:838-850`. Invoked on every live-tail event for
  `message.*`/`part.*`/`messages.*`. Gain: SMALL (CPU-only, busy-session live
  tail). Risk: LOW.
- **Fix:** attach `sessionID` to the event envelope at emit time so `sendable`
  reads the envelope field instead of unmarshalling the body.

### #4 — FE `MarkdownHtml` synchronous client-fallback parse — NOT WORTH IT
- **Location:** `web/src/components/Part.tsx:179-227`. Bounded by `EAGER_TAIL=30`
  + on-screen `Deferred`. Deliberate trade-off; removing the fallback shows
  nothing until the server round-trip. Don't touch unless profiled hot.

### #5 — `computeSubtreeBusyLocked` O(n) per Snapshot — RULE OUT
- **Location:** `pkg/state/store.go:1373-1406`. Negligible at typical session
  counts; only at hundreds+. Defer.

## Ruled out / already fixed (do NOT re-propose)
- Sync `client.Messages` on first-open of active session — fixed P1-AGG-001
  (`EnsureMessagesAsync` + single-flight, `messages.loaded`/`messages.error`,
  FE `messagesLoaded` gate).
- Cold-seed storm on hydrate path — fixed P1-WEB-014 (`seedColdLastAgents`
  backgrounded + once-per-lifetime memo).
- Subsession N+1 — ruled out by `researches/sources/subsession-nplus1-audit.md`
  (`opencode.Client.Children` never called; tree built client-side from
  `parentID`).
- `handleSnapshot` sync `ensureMessages` — correct by design for the active
  session (memo `stale-and-latency-indicators.md`). It amplifies #1 on the
  reconnect path for non-active sessions, but the fix belongs on the FE caller
  side (#1), not by changing `handleSnapshot`.
- FE GPU traps (`mask-image`, `backdrop-filter:blur`, per-element
  `contain`/`content-visibility`) — off-limits per AGENTS.md (known WORSE on
  Firefox/WebRender).
- Streaming markdown reparse — already solved by `lib/streamMd.ts` + `Part.tsx`
  5fps coalescing.

## Open questions
1. No profile measurement — all reasoning-from-code.
2. (RESOLVED) `opencode.Client` goroutine-safety — confirmed safe (see #2).
3. Realistic `state.messages` size per operator run sizes #1's gain.
4. Should `state.messages` be pruned (LRU) on session switch? Separate
   memory/correctness trade-off, not implemented.
5. Variant (b) of #1 needs a server-side design pass; defer until (a) measured.
