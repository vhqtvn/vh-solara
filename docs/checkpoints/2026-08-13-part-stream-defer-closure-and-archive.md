# 2026-08-13 — Part-stream redesign: post-closure DEFER work + FINAL lane state (archive record)

The slice-7 closure checkpoint
([`2026-08-12-part-stream-redesign-closure.md`](./2026-08-12-part-stream-redesign-closure.md))
shipped the core part-append suffix-streaming redesign at slice 7 (8 commits on
`main`). This record covers the subsequent DEFER-closure work that brought the
lane to its **final state (14 commits)** and records what survives as
incident-triggered or conditional follow-ups. It supersedes the "Explicitly
DEFERRED" section of the slice-7 closure checkpoint, which was written as-of
slice 7 and is now historical.

## Final commit chain (14 commits on `main`)

| # | Commit | What |
|---|--------|------|
| 1 | `1af062c` | part-append suffix-streaming **contract** + delta-path `probes.part_delta_fields` telemetry |
| 2 | `d61ed44` | negotiated suffix **source + ring** representation; `emitPartAppend`; legacy full-upsert at same seq |
| 3 | `d49b4eb` | **FE apply** — UTF-8 byte-offset validation, frame-batch, mismatch → re-snapshot |
| 4 | `90dfd40` | **linearity + slow-reader crux** — O(L²)→O(L) proof, disconnect recovery, post-drain gen-recheck |
| 5 | `cb1f826` | **compaction** telemetry (`probes.part_upsert_burst`) + incident fixture (sibling axis) |
| 6 | `f65db77` | **docs / O1 decision** — compaxis O1 (no-change) record + brief promotion |
| 7 | `5ed75c5` | **closure (slice 7)** — §4.3 metric double-count fix + exec receipts + test/docs hardening |
| 8 | `e9437fd` | cheap-resolve DEFERs — #7/#8/#10 wording + #3 recovery-convergence test |
| 9 | `08baadc` | **#1 browser crux** (lane-6 e2e) — live SSE→SPA→apply via `part.append` |
| 10 | `978b167` | **#4/#5 coverage** — cold-batch ABA concurrency + SnapshotWithTree/Partial coherence |
| 11 | `693433e` | **#2 frame-batch measurement** — ledger [1,1,1,1] → NOT engaging under native EventSource |
| 12 | `3fbc255` | **comment-accuracy** — 8 frame-batch overclaim sites qualified to measured result |
| 13 | `73f047f` | **minors** — guarded debug-log + byte-offset comment + framing |
| 14 | `060c739` | **#10 sesSnapshotOwnership flake fixed** — controlled `DecompressionStream` |

All 14 hashes verified against `git log --oneline main`; subjects match the
labels above.

## Demonstrated crux — proven at BOTH seams

- **Go seam (O(L²)→O(L)):** `TestPartAppend_Linearity_OptedInLinearLegacyQuadratic`
  (`pkg/state/part_append_linearity_test.go`, `90dfd40`). Opted-in scales ~linearly
  at a **1.70×L** constant vs legacy's quadratic **33→65→129×L** across the 4×
  length range; the legacy/opted-in ratio widens monotonically to **75.9× at
  32 KiB**. Source suffixing was necessary AND sufficient (daemon saw no SSE
  backpressure: `slow_writes=null`, max 653µs).
- **Browser seam (live apply):** `web/tests/e2e/part-delta.spec.ts` (`08baadc`).
  Real `EventSource` against the live SPA; `part.append` frames start at the
  measured byte offsets **[0,16,32,44]** (not the char starts [0,14,31,43]);
  incremental prefix→suffix apply is exercised before the final-update repair.
- **Compaxis:** O1 (no-change), gate-forced. **Frame-batch:** measured
  **NOT-engaging** under native `EventSource` (`693433e`, ledger [1,1,1,1]) — so
  no native-EventSource flush coalescence is relied upon.

## Status of the slice-7 "deferred follow-ups" (updated)

- **(a) browser/Playwright e2e of the live SSE→apply path** → **DONE**
  (`08baadc`, **lane-6** — not lane-8). The #1 solution-brief corrected the seam:
  the live `part.append` crux is provable in lane-6 (web e2e) against the real
  SPA; the heavy lane-8 real-embed lane is not required to close it.
- **(b) subscriber-channel high-water end-to-end assertion (slice-4A committer
  DEFER)** → **persisted as draft card** `task-2026-08-13t09-06-00-compaction-highwater-real-incident`
  (incident-triggered, passive).
- **(c) the pre-existing `sesSnapshotOwnership` full-suite flake** → **DONE**
  (`060c739`, deterministic controlled-`DecompressionStream` fix; snapshot-decode
  ownership coverage strengthened).

### Future-O2 conditional (compaxis)

Re-open the compaxis O1 decision gate ONLY if production `part_upsert_burst`
telemetry shows (a) a material identical-fraction AND (b) a measured
settle/latency regression suppression would fix. O2 ≠ wedge cure (see honesty
note on its card below). Persisted as draft card `task-2026-08-13t09-07-00-compaxis-future-o2-watch`.

## Persisted DEFER cards (`.local/coordinator/tasks/`, `draft` status — survive this session)

| Card | Trigger / decision rule |
|------|-------------------------|
| `task-2026-08-13t09-05-00-report2-relay-browser-attribution` | The real outstanding **user-facing bug**. Operator §7 capture on next >60s wedge. Decision rule: prompt-arrival-late-apply → **browser**; delayed-arrival-growing-queues → **relay**. |
| `task-2026-08-13t09-06-00-compaction-highwater-real-incident` | Passive probe read on next real incident sweep; records the identical/changed split. |
| `task-2026-08-13t09-07-00-compaxis-future-o2-watch` | Conditional O2 re-adjudication. Trigger = material duplicates AND measured regression. **Honesty:** O2 ≠ wedge cure. |

## Latent (deliberately NOT carded)

`tier1_c/F1`: `sesSnapshotOwnership` subtests 1–2 retain the `tick(2)` oracle
class fixed in subtest 3 (`060c739`); subtest 2 could flake by the identical
mechanism. Trigger `path_touched(web/tests/unit/sesSnapshotOwnership.test.ts)`;
block a candidate only if subtests 1–2 flake. Lives in the #10 review record.

## B1 status

The persistent B1 caveat (review/committer environments are read-only;
verification rests on the implementer's green runs bound to the final tree) is
bound to the final 14-commit tree. The slice-7 "modulo the sesSnapshotOwnership
flake" qualifier is **RESOLVED** — the flake is fixed deterministically
(`060c739`). The redesign's load-bearing crux (O(L²)→O(L)) is proven at **both**
the Go seam (linearity test) and the browser seam (live `part.append` apply
e2e).

## Provenance + archival note

Part-stream DEFER-closure study, 2026-08-13. Supersedes the "Explicitly
DEFERRED" section of
[`2026-08-12-part-stream-redesign-closure.md`](./2026-08-12-part-stream-redesign-closure.md)
(now historical as-of slice 7). Lane actionable work is **complete**; remaining
items are incident-triggered or conditional.

The original implementation task card
`task-2026-08-11t16-56-14-linear-part-delta-frames-kill-o-n2-streaming-wire-cost`
was formally closeout'd (**status `completed`**) at archival (transitioned
2026-08-14T07:01:43Z), with closeout report at
`.local/coordinator/reports/task-2026-08-11t16-56-14-linear-part-delta-frames-kill-o-n2-streaming-wire-cost/2026-08-14T07-01-43-closeout.md`
carrying a behavioral-closure `result: proven` token (its actionable work is
complete and is superseded by this durable record).
