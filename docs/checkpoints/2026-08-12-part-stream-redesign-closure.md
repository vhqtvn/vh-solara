# 2026-08-12 — Part-stream redesign CLOSURE (slice 7, final)

## Summary

This is the **closure slice** (slice 7) of the part-append suffix-streaming
redesign. It ties off the accumulated non-blocking DEFERs from slices 1–6 + 4A,
binds the persistent B1 caveat (full canonical verification bound to the final
tree) with a complete exec receipt, and records what is deliberately deferred.
The only runtime change is a **metric-only** fix (the `Stream2ReplayFallback`
double-count on the §4.3 fallback path); the remainder is test hardening,
comment/editorial repoints, and a brief promotion. No wire protocol, FE apply
semantics, snapshot/cold-load format, or compaxis O1 decision changed.

### What shipped (the redesign, end to end)

| Slice | Commit | What |
|-------|--------|------|
| 1 | `1af062c` | part-append suffix-streaming **contract** + delta-path `probes.part_delta_fields` telemetry (no live wire change) |
| 2 | `d61ed44` | negotiated suffix **source + ring representation**: `part.append {sessionID,messageID,partID,field,start,text}` behind `part_delta=1`; `emitPartAppend`; legacy synthesized full upsert at same seq |
| 3 | `d49b4eb` | **FE suffix application + repair**: UTF-8 byte-offset validation, frame-batch, mismatch → re-snapshot, post-drain gen-recheck |
| 4 | `90dfd40` | **O(L²)→O(L) linearity proof** + slow-reader recovery (deterministic disconnect + cursorless snapshot repair) |
| 4A | `cb1f826` | compaction-burst upsert-path telemetry (`probes.part_upsert_burst`) + incident-shaped fixture (sibling axis) |
| 6 | `f65db77` | compaxis O1 decision record + brief promotion + docs |
| 7 | (this slice) | closure: B1 exec receipt + metric double-count fix + test hardening + brief promotion + docs repoints |

### Demonstrated crux — O(L²)→O(L) wire cost (proven at `90dfd40`)

The load-bearing proof is `TestPartAppend_Linearity_OptedInLinearLegacyQuadratic`
(`pkg/state/part_append_linearity_test.go`). Re-verified this slice against the
final tree:

```
L= 8192B ( 8KiB) nDeltas= 64: opted-in=  13878B (1.69xL)  legacy=  270784B (33.05xL)  ratio=19.5x
L=16384B (16KiB) nDeltas=128: opted-in=  27815B (1.70xL)  legacy= 1065856B (65.05xL)  ratio=38.3x
L=32768B (32KiB) nDeltas=256: opted-in=  55719B (1.70xL)  legacy= 4228864B (129.05xL)  ratio=75.9x
```

Opted-in scales ~linearly (≈ 1.70×L, < 6× growth over the 4× length range);
legacy scales ~quadratically (33→65→129×L, ≥ 3× per doubling); the
legacy/opted-in ratio widens monotonically to **75.9× at 32 KiB**. Source
suffixing was necessary AND sufficient: the daemon never saw SSE backpressure
(`slow_writes=null`, max 653µs), so neither relay batching nor FE rendering
could substitute.

### Compaxis O1 decision (gate-forced, sibling axis)

The compaction-burst axis is closed at **O1 (no-change)**. O2 (ingress no-op
suppression) is gate-blocked by the a-F2 hard gate (no real production
duplicate-composition telemetry; slice 4A's fixture is synthetic). Slice 4A
showed a single incident-sized ~226KB burst has no measurable healthy-link
impact (settle 15–30µs; subscriber high-water 13–16 ≪ 256), so the slice-5
egress gate is not triggered. Full decision record:
[`docs/checkpoints/2026-08-12-compaction-axis-o1-decision.md`](./2026-08-12-compaction-axis-o1-decision.md)
and [`docs/ai/wire-protocols/compaction-burst-axis.md`](../ai/wire-protocols/compaction-burst-axis.md).

---

## Exec receipts — B1 closure (full canonical set, bound to the final working tree)

Run after all slice-7 edits, on the working tree that will be committed (HEAD =
`f65db77` + uncommitted slice-7 edits; the only untracked non-slice file is
`package-lock.json`, concurrent dirt, excluded).

### 1. `go test ./pkg/...` (full Go tree)

```
ok  	github.com/vhqtvn/vh-solara/pkg/agent	6.026s
ok  	github.com/vhqtvn/vh-solara/pkg/aggregator	16.652s
ok  	github.com/vhqtvn/vh-solara/pkg/alerts	1.417s
ok  	github.com/vhqtvn/vh-solara/pkg/auth	(cached)
ok  	github.com/vhqtvn/vh-solara/pkg/diagnostics	(cached)
ok  	github.com/vhqtvn/vh-solara/pkg/fixtures	(cached)
ok  	github.com/vhqtvn/vh-solara/pkg/kit	(cached)
ok  	github.com/vhqtvn/vh-solara/pkg/mcp	(cached)
ok  	github.com/vhqtvn/vh-solara/pkg/oclife	(cached)
ok  	github.com/vhqtvn/vh-solara/pkg/opencode	0.647s
ok  	github.com/vhqtvn/vh-solara/pkg/procmgr	(cached)
ok  	github.com/vhqtvn/vh-solara/pkg/projectcfg	(cached)
ok  	github.com/vhqtvn/vh-solara/pkg/quota	(cached)
ok  	github.com/vhqtvn/vh-solara/pkg/render	(cached)
?   	github.com/vhqtvn/vh-solara/pkg/ringlog	[no test files]
ok  	github.com/vhqtvn/vh-solara/pkg/server	4.144s
ok  	github.com/vhqtvn/vh-solara/pkg/skill	0.006s
ok  	github.com/vhqtvn/vh-solara/pkg/state	2.938s
ok  	github.com/vhqtvn/vh-solara/pkg/tunnel	0.004s
?   	github.com/vhqtvn/vh-solara/pkg/vhlog	[no test files]
ok  	github.com/vhqtvn/vh-solara/pkg/web	98.586s
```

All `ok`. (Some packages show `(cached)` because their tests were unaffected
and the go test cache held; the cache is content-addressed by source + build
inputs, so a cached `ok` is bound to the assessed source.)

### 2. `go test -race ./pkg/state/...` (concurrency-sensitive package)

```
ok  	github.com/vhqtvn/vh-solara/pkg/state	9.678s
```

### 3. `npm --prefix web run test:unit` (web unit)

```
 Test Files  1 failed | 176 passed (177)
      Tests  1 failed | 2146 passed | 1 skipped (2148)
   Duration  8.70s
```

The single failure is the **known pre-existing flake**
`sesSnapshotOwnership.test.ts > "survives a cross-switch burst"` (line 284,
`expected undefined to be defined`). It is a snapshot-decode ownership timing
test exercising `web/src/sync/stream.ts` + store decode-gen gating — **unrelated
to part-streaming** (this slice touched zero `web/` source files; only Go files
+ markdown). The test's own header documents a real-timer limitation that makes
the end-to-end gen-ownership burst sensitive to full-suite microtask load.

Isolation re-runs (the task's verify-it-still-passes-alone step):

```
=== sesSnapshotOwnership in ISOLATION (run 1) ===
 ✓ tests/unit/sesSnapshotOwnership.test.ts (3 tests) 224ms
 Test Files  1 passed (1)
      Tests  3 passed (3)

=== sesSnapshotOwnership in ISOLATION (run 2) ===
 ✓ tests/unit/sesSnapshotOwnership.test.ts (3 tests) 210ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Passes deterministically (3/3) in isolation, twice. It is a full-suite-only
timing flake, not a regression introduced or worsened by this slice. Recorded
as a deferred follow-up (below).

### 4. `npm --prefix web run typecheck`

```
> typecheck
> tsc --noEmit
```

Clean (no diagnostics emitted; `tsc --noEmit` exits 0 with no output on success).

### 5. `gofmt -l pkg cmd main.go`

```
(gofmt clean — nothing listed)
```

### 6. `go build ./...`

```
build exit=0
```

---

## Slice-7 deliverables

1. **Metric double-count fix** (the only runtime change) —
   `pkg/web/server.go`: removed the redundant `diag.IncStream2ReplayFallback()`
   at the §4.3 detection site. The unified PROBE 8 site (`hasCursor &&
   !replayOK`, the snapshot-fallback branch) records the fallback ONCE for both
   the ring-gap/cursor-too-old case AND the §4.3 suffix-in-legacy-replay case.
   Metric-only: `replayOK` still flips, so the connection still takes the
   snapshot path exactly as before. Test:
   `TestPartAppend_LegacyReplayFallbackToSnapshot` now asserts
   `Stream2ReplayFallback` delta == exactly 1 for one §4.3 fallback.
2. **Test hardening (slice-4 F1 + F2)** —
   `pkg/state/part_append_slowreader_test.go`: F1 loosened the exact
   `nBuffered == 256` assertion to a capacity bound `(0, 256]` (exact count
   depends on the flush interval); F2 asserts the drained buffered frames are
   `KindPartAppend`, mechanically attributing coverage to `emitPartAppend`'s
   overflow branch.
3. **Comment/editorial repoints + brief promotion** —
   `pkg/state/reducers.go:1465` stale `§9.2` → `§10`; circular `§8` self-ref in
   `compaction-burst-axis.md:8` → the O(L²) suffix-axis contract; promoted the
   O(L²) brief to NEW `docs/ai/wire-protocols/part-stream-suffix-axis.md`;
   repointed every tracked `tmp/agent-runs/part-stream-redesign-brief` citation
   (5 sites) to the durable doc.

---

## Findings

- **The full canonical set is green bound to the final tree (B1 satisfied):**
  source=fresh exec receipts above, confidence=high, type=fact. The one web-unit
  failure is the pre-existing `sesSnapshotOwnership` flake (passes in
  isolation); it is not a part-streaming regression.
- **The metric fix is the only runtime change and is test-observed:**
  source=`TestPartAppend_LegacyReplayFallbackToSnapshot` (delta==1 assertion,
  PASS), confidence=high, type=fact. Before the fix, the §4.3 path incremented
  `Stream2ReplayFallback` twice (detection site + unified fallback site); after,
  exactly once.
- **O(L²)→O(L) crux still holds on the final tree:** source=linearity test
  receipt (1.70×L vs 129×L at 32 KiB; ratio 75.9×), confidence=high, type=fact.
- **Test hardening (F1/F2) does not change observed behavior:**
  source=slow-reader test PASS with the loosened bound + Kind assertion,
  confidence=high, type=fact. F1 widened an over-precise assertion; F2 added a
  kind attribution check. Neither altered the behavior under test.
- **Brief promotion + citation repoints are docs-only:** source=`git grep
  'tmp/agent-runs/part-stream-redesign-brief'` returns nothing over tracked
  files, confidence=high, type=fact.

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Full Go tree green (B1) | `go test ./pkg/...` → all `ok` (receipt §1) | yes |
| pkg/state race-clean | `go test -race ./pkg/state/...` → `ok 9.678s` (receipt §2) | yes |
| Web unit: only the pre-existing flake fails | `npm --prefix web run test:unit` → 1 failed (sesSnapshotOwnership), 2146 passed, 1 skipped (receipt §3) | yes |
| sesSnapshotOwnership flake is full-suite-only (passes alone) | isolation runs → 3/3 PASS, twice (receipt §3) | yes |
| Web typecheck clean | `npm --prefix web run typecheck` → no diagnostics (receipt §4) | yes |
| gofmt clean on touched files | `gofmt -l pkg cmd main.go` → nothing listed (receipt §5) | yes |
| `go build ./...` succeeds | build exit=0 (receipt §6) | yes |
| Metric double-count fixed (== 1 per §4.3 fallback) | `TestPartAppend_LegacyReplayFallbackToSnapshot` PASS (delta==1 assertion) | yes |
| Slow-reader F1/F2 hardening holds | `TestPartAppend_SlowReaderDropThenReconnectSnapshot` PASS (capacity bound + KindPartAppend attribution) | yes |
| O(L²)→O(L) crux holds on final tree | linearity test → 1.70×L vs 129×L, ratio 75.9× at 32 KiB | yes |
| No tracked tmp/agent-runs/part-stream-redesign-brief refs remain | `git grep 'tmp/agent-runs/part-stream-redesign-brief'` → (none) | yes |
| No runtime behavior changed except the metric increment count | slice diff is: 1 metric line removed (server.go), 2 test assertions loosened/added, comments + docs | yes |

## Contradictions

None detected. The metric fix is consistent with the §4.3 spec (the fallback
decision — `replayOK=false` — is unchanged; only the redundant counter increment
was removed). The test hardening widens an over-precise assertion to a bound
that holds under the same behavior. The compaxis O1 decision and the suffix-axis
contract are restated, not changed.

---

## Explicitly DEFERRED (recorded follow-ups, NOT done this slice)

These are non-blocking for closure and are recorded here so a future session can
pick them up deliberately:

- **(a) F3/F4 browser/Playwright e2e of the negotiated live SSE→apply path
  (lane 8 real-embed).** The linearity + slow-reader proofs are in-process
  (Go) and the FE apply is covered by web unit; the real-embed lane proves the
  full live SSE→yamux→controller→browser→apply chain on the REAL production
  SPA. It is heavy (builds web → materializes → builds go → Playwright) and is
  scheduled/dispatchable-only by design (not PR-blocking). Deferred until lane 8
  is run or the relay/browser attribution incident recurs.
- **(b) Subscriber-channel high-water end-to-end assertion (slice-4A committer
  DEFER).** Slice 4A's fixture measured subscriber high-water 13–16 events
  (≪ 256) on the synthetic incident shape; a real-traffic end-to-end high-water
  assertion is deferred until the deployed `part_upsert_burst` probe captures a
  real incident.
- **(c) The pre-existing `sesSnapshotOwnership.test.ts` "survives a cross-switch
  burst" full-suite flake.** Snapshot-decode ownership timing (real-timer
  limitation documented in the test header); unrelated to part-streaming. Passes
  deterministically in isolation. Deferred to a web-test stability follow-up.

### Future-O2 conditional (compaxis)

Re-open the compaxis decision gate ONLY if production `part_upsert_burst`
telemetry shows (a) a material identical-fraction AND (b) a measured
settle/latency regression that suppression would fix. Until then O1 stands: no
ingress suppression (4C), no egress optimization (5). The compaction burst
remains a TRIGGER CANDIDATE, not a reducible duplicate burst.

## Provenance

- Slice-7 execution: build session 2026-08-12, working against HEAD `f65db77`.
- Receipts captured fresh this slice against the final working tree (the tree
  that will be committed, before commit).
- Concurrent dirt `package-lock.json` (untracked) is NOT this slice's and is
  excluded from the closeout (B2: exact-slice, concurrent dirt excluded).
