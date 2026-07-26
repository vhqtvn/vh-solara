# 2026-07-26 — Warm-Resync Absence-Deletion Transcript-Loss Fix

## TL;DR
**Complaint:** intermittently, when an agent sent message A → called a subagent
(the task-tool Part on A_assistant) → subagent returned → sent message B, the
whole of A + the subagent activity view vanished from the chat and only B
remained. **Reloading the page restored the full transcript.** Repro was random
and impractical to capture.

**Fix shipped (1 commit):** `a36dcddf` `fix(state): stop warm-resync
absence-inference from deleting live messages/parts`. Removed the two warm
absence-deletion loops in `pkg/state/store.go::reconcileMessagesLocked`, so
absence from a fetched snapshot can never delete a stored message or part.
Deletions now come only from explicit `message.removed` /
`message.part.removed` / `session.deleted` events.

**Key constraint discovered:** OpenCode exposes **no causal freshness signal**
on any surface the daemon parses (no seq/etag/cursor on the GET, none on live
events, SSE `id:`/`event:` discarded, "no replay"). So a *provably-correct*
fence is impossible in-repo; the shipped fix is the best practical mitigation
("Option A"), and the provably-correct fix is an **upstream follow-up** (tracked
as backlog `P1-AGG-001`).

## Root cause (decisive)
- On the `Run`-loop event-stream reconnect (`pkg/aggregator/aggregator.go:709-758`),
  the daemon calls `hydrate` → re-GETs `/session/<id>/message`
  (`pkg/opencode/client.go:338-344`) for already-loaded sessions.
- `reconcileMessagesLocked` ran a **warm absence-deletion** loop (gated
  `!coldLoad`): any message/part in the store but absent from the fetched list
  was deleted and a `KindMessageDelete`/`KindPartDelete` emitted
  (`store.go` ~L4068-4076 parts, ~L4085-4093 messages).
- If the GET **lagged OpenCode's event stream** and omitted a just-live message
  or part, the daemon spuriously deleted it. The client dropped the
  `MessageView` → the task-tool Part died with it.
- **Reload recovers** because the store re-acquires the entry after the lag
  window (a subsequent live event or a later consistent GET re-ingests it) —
  i.e. the bad state is transient and **self-healing**. This property is the
  reason a "ride out the transient" fix (do nothing on absence) is sufficient.

The cold path was already guarded against this by the `liveTouchedBody` /
`liveTouchedParts` mechanism (the codebase's own C-F2 fix), because the
developers know "the fetched list can be stale relative to live events." The
warm path was deliberately left authoritative — same lag risk, no guard.

## Investigation trail (7 read-only dispatches)
1. `repo-explorer` — mapped the streaming chat pipeline; prime suspect was
   `messages.batch` wholesale-replace (`stream.ts:727`).
2. `researcher` — **ruled out** `messages.batch` (daemon emits it once per
   cold-hydrate; `msgLoaded` resets only via `deleteSessionLocked`; the
   "fires once" comment holds). Proposed warm-resync absence-deletion and
   stale-snapshot as candidates.
3. `researcher` — **ruled out** the stale-snapshot per-part merge path
   (`prependMessagesIfAbsent` at `reduce.ts:94` skips existing messages
   entirely; 379d172 fully closed it). Pinned warm-resync absence-deletion
   (`store.go:3956-3964`) as the prime suspect; surfaced `refreshOpenSessions`
   (`stream.ts:956`) as a second unhardened wholesale-replace (Defect B).
4. `solution-brief` — blocked on a protocol fact: the four invariants
   (no spurious drops + no permanent phantoms + safe-without-repro +
   testable) cannot all hold using fetch-absence alone.
5. `researcher` — protocol-fact lookup: **CONFIRMED ABSENT**. No causal
   signal from OpenCode anywhere. Daemon's `msgRev`/`nextMsgRev` is internal
   (fences daemon concurrency, not OpenCode lag). Parts mutate independently
   (per-part events + `liveTouchedParts`).
6. `solution-brief` (re-framed) — evaluated the full practical option space
   (A–H); recommended **A** (disable warm absence-inference), **B** (two-strike)
   as fallback, with explicit rejections for C recency / D client-guard /
   E delayed-re-GET / F reconnect-epoch / G hybrids / H emit-suppression.
   Decided Defect B **defers** (it propagates Defect A's bad state; once the
   server stops spuriously deleting, the client fetches correct data and the
   wholesale-replace is harmless).
7. `build` — implemented A via TDD; self-verifying check passed (no existing
   warm-resync test broke → the daemon does not rely on absence-inference →
   A is viable, no fallback to B needed).

## What shipped
| Hash | Slice | Key files |
|---|---|---|
| `a36dcddf` | Remove warm absence-deletion (messages + parts) + dead `seenMsg`/`seenPart` maps + stale-comment fixes; 4 deterministic integration tests | `pkg/state/store.go`, `tests/integration/warm_resync_omission_test.go` |

**Tests (TDD, red→green):** (1) warm omission retains a message; (2) warm
omission retains a part independently (the visible symptom); (3) explicit
`message.removed` still deletes; (4) explicit `message.part.removed` deletes
only the intended part. Tests 1 & 2 went RED before the fix (reproducing the
exact symptom — delete emitted + live entry vanished), GREEN after.

**commit-reviewer:** unanimous APPROVE (0 BLOCK / 0 DEFER, advisory drops only).

## Why each alternative was rejected
- **Two-strike suspect** — weaker than A for this bug (two stale cycles can
  still drop live data) + needs per-message AND per-part strike state.
- **Recency / grace window** — arbitrary time has no causal link to GET
  freshness; lag can outlive the window.
- **Reconnect-epoch** — counts reconnects, not freshness; persistent lag across
  epochs still deletes.
- **Delayed re-GET** — 2nd GET can still be stale; adds scheduling/cancellation
  complexity for no correctness bound.
- **Client-side delete-guard** — masks the symptom while leaving the server
  store wrong; adds hidden-retained client state + a second reconcile policy.
- **A removes the destructive producer with zero new metadata** and exploits
  the self-healing property directly: on a stale warm GET the daemon simply
  does nothing, the entry stays, a later live event re-asserts it.

## Accepted tradeoff (documented)
With absence-deletion removed, a message/part whose explicit `*.removed` event
is **lost** (network glitch, aggregator restart between events) now lingers in
the store until `session.deleted`, instead of being pruned by the next warm
reconcile (which carried the live-data-loss risk this fix removes). This is the
intentional, asymmetric trade: favor never-dropping-live over
always-propagating-deletes, because the reported symptom was silent data *loss*
(strictly worse than visible phantoms-until-reload). Worst case (extended
OpenCode outage): retains the last-known transcript instead of destructively
emptying it — the preferred failure mode.

## Verification
| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Warm omission cannot delete a stored message | `TestWarmReconcile_OmittingMessage_RetainsMessage` (red before fix, green after) | yes |
| Warm omission cannot delete a stored part (the visible symptom) | `TestWarmReconcile_OmittingPart_RetainsPart` (red before, green after) | yes |
| Neither omission emits an inferred delete event | `hasKind` assertions on subscriber channel in tests 1 & 2 | yes |
| Explicit `message.removed` still deletes | `TestExplicitMessageRemoved_StillDeletes` | yes |
| Explicit `message.part.removed` deletes only the intended part | `TestExplicitMessagePartRemoved_DeletesOnlyIntendedPart` | yes |
| Full integration lane green | `go test ./tests/integration/` → ok 0.171s | yes |
| Full pkg lane green (no regressions, no reliance on absence-inference) | `go test ./pkg/...` → all ok | yes |
| gofmt clean | `gofmt -l pkg/state/store.go` → no output | yes |
| Scope fence: client / cold path / 379d172 snapshot path untouched | commit-reviewer F5 (scope_violation) — clean; diff verified | yes |

**Behavioral-closure scope:** `result: proven` is honest **only at the
store-contract scope** (warm `SetSessionMessages` omission must not delete),
which the two omission tests demonstrate. The full e2e "Run-loop reconnect +
lagging OpenCode GET never drops transcript" outcome is **not-demonstrable**
from this slice (no daemon reconnect/lag harness) and was never claimed. The
production symptom is not reproduced-then-fixed; success is observational
post-ship (transcript disappearance should stop without a rise in phantom
reports).

## Findings
- **(fact)**: `messages.batch` cannot cause the symptom — emitted once per cold-hydrate; `msgLoaded` resets only via `deleteSessionLocked`. confidence=high.
- **(fact)**: stale `snapshot` per-part merge cannot drop parts — `prependMessagesIfAbsent` skips existing message IDs entirely (379d172). confidence=high.
- **(fact)**: warm-resync absence-deletion (`store.go` warm loop) is unguarded while the cold path is guarded by C-F2's `liveTouchedBody`/`liveTouchedParts`. confidence=high.
- **(fact)**: OpenCode exposes no causal freshness signal on any parsed surface. confidence=high.
- **(fact)**: the daemon does not rely on absence-inference for deletion propagation (no existing warm-resync test broke when it was removed). confidence=high.
- **(inference)**: the reported production symptom matches warm-resync absence-deletion triggered by a reconnect GET lagging OpenCode's event stream. confidence=medium (mechanism proven structurally; the runtime GET-lag trigger is external to this repo and not empirically captured).

## Contradictions
- **Candidate-1 vs reload-recovery:** warm-resync deletes from the store, so
  reload should also miss the entry — yet reload recovers. Resolved: the store
  re-acquires the entry after the lag window (self-healing), so the deletion is
  transient. This is the property the fix exploits.
- None other detected across the investigation.

## Deferred follow-ups (not shipped)
- **`P1-AGG-001` — provably-correct causal fence (upstream).** OpenCode must
  add a monotonic `seq` to every event envelope AND echo the current event-log
  `seq` on the GET `/session/<id>/message` response (one counter, two
  surfaces). Then the daemon fences: `fetched.seq <= highestAppliedEventSeq`
  ⇒ discard fetched list as stale. Blocked on upstream OpenCode support.
- **Defect B — `refreshOpenSessions` wholesale-replace (`stream.ts:956`).**
  Deferred: once the server stops spuriously deleting (this fix), the client's
  fetch gets correct data and the wholesale-replace is harmless. Reopen **only
  with deterministic evidence** that non-active session snapshots stay
  incomplete post-ship. Test seam to port: `web/tests/e2e/session-completion.spec.ts:689-820` (Test D, `installCaptureWithLatency`).
- **Doc-drift (non-blocking, commit-reviewer F2).** Several comments elsewhere
  in `store.go` still describe the warm fetch as "authoritative" / mention
  "upsert/delete" from reconcile. After Option A, warm fetch is authoritative
  only for present message/part bodies (overwrite), not for absence. Docs-only
  follow-up.

## Key anchors
- `pkg/state/store.go` — `reconcileMessagesLocked` (the removed warm
  absence-deletion loops were ~L4068-4076 parts / ~L4085-4093 messages);
  `liveTouchedBody`/`liveTouchedParts` (cold-path guard, unchanged);
  `deleteMessageLocked`/`deletePartLocked` (explicit-removal emit sites,
  unchanged); `msgRev`/`nextMsgRev` (daemon-internal, not a causal signal).
- `pkg/aggregator/aggregator.go:709-758` — `Run`-loop reconnect → `hydrate`.
- `pkg/opencode/client.go:338-344` — `Messages` GET (no causal field parsed;
  no headers read; no freshness param).
- `tests/integration/warm_resync_omission_test.go` — the 4 deterministic tests.
- `web/src/sync/stream.ts:950-967` — `refreshOpenSessions` (Defect B, deferred).
- `web/src/lib/reduce.ts:94` — `prependMessagesIfAbsent` (379d172 snapshot path,
  unchanged).
- Commit `379d172` — the sibling fix that hardened the snapshot path (reference
  for the fix class).
