# 2026-09-18 — Multi-project tunnel contention: measurement verdict & decision record

Date: 2026-09-18 · Scope: worker tunnel transport / multi-project contention ·
Commits: `aed5e3c`, `e88ee2c` (A1), `aa1a29c` (A1b), `1369e16` (shaper-floor
DEFER burn) + this document's commit.

## Situation

Operator report: 7 projects × browser tabs against 1 worker is very slow. Two
findings were supplied with the report and re-verified on 2026-09-18:

1. **Single shared yamux tunnel per worker — CONFIRMED.** The worker agent
   creates exactly one yamux session over its controller WebSocket
   (`pkg/agent/daemon.go:189-219`), which the controller accepts
   (`pkg/server/daemon.go:279-358`); every tab, stream, and heartbeat of every
   project multiplexes over that one TCP connection. yamux is the unpatched
   dependency `github.com/hashicorp/yamux v0.1.2` (go.mod) — single FIFO
   `sendCh` (cap 64) serializing all streams — and the WebSocket writer under
   it is mutex-guarded (`pkg/tunnel/websocket.go:90-146`), so one slow bulk
   stream can head-of-line-block small frames for ALL projects.
2. **O(n²) part-streaming — ALREADY FIXED; the supplied snapshot was stale.**
   The part-append-streaming slices 1–6 landed `part.append` suffix streaming
   (client opt-in default-on: `web/src/sync/session-stream.ts:76`
   `partDeltaEnabled = true`), with the O(L²)→O(L) proof at `90dfd40`
   (see [`2026-08-12-part-stream-redesign-closure.md`](./2026-08-12-part-stream-redesign-closure.md)).

## Method (measure first)

The solution-brief pass recommended measure-first before picking between
recovery-fix / browser-fix / tunnel-knob / tunnel-fairness options:

- **A1 loopback baseline** (`aed5e3c` + fixes `e88ee2c`): `SeedMultiProject`
  fixture (`pkg/fixtures/opencode.go`) + lane-3 e2e
  (`tests/e2e/multiproject_latency_test.go`) measuring direct vs tunnel, 1/3/7
  projects, bulk-vs-small, and sever recovery.
- **A1b shaped link** (`aa1a29c`): a pure-Go user-space shaper (shared
  per-direction token bucket + 16 KiB interleave slices + burst-gated 20 ms
  one-way delay; `tests/e2e/shapedlink_test.go`) placed discriminatingly — on
  the worker↔controller WS leg (tunnel-throttled: the whole mux crosses ONE
  shaped pipe) vs the client→worker leg (direct control: same cap, separate
  TCP connections). Caps 20 Mbps and 5 Mbps. The cap-rate floor
  (`mpAssertShaperFloor`, `1369e16`) now structurally proves the shaper
  actually shaped (a bypassed shaper fails the test).

## Measured results

Raw receipts: `tmp/agent-runs/multiproject-contention-20260918/baseline-a1{,b}.{log,json}`
(not committed). Bulk stream ≈ 604 KB poorly-compressible part.

**Loopback (A1):** no super-linear degradation at 7 projects (absolute
tunnel/direct medians stay in low-ms); bulk does not delay smalls (tunnel
small idle 0.22 ms → during 0.22 ms; direct 0.09 → 0.15 ms); sever recovery
is cheap — re-snapshot burst medians tree 1.40 ms / session 1.81 ms, and
sever→online ≈ 1.0 s dominated by the reconnect backoff floor, not the storm.

**Shaped link (A1b):** medians are fair on BOTH routes — during/idle
slowdown factors ≈ 1.0–1.7× (cap20 small: direct 8.6×/+1.10 ms vs tunnel
0.5×; cap20 treeopen tunnel 1.7×/+1.13 ms; cap5 small: direct 4.7× vs tunnel
1.2×/+1.15 ms) — but the **worst-case tail is the tunnel's alone**:

| Tail (worst-case added vs idle) | @20 Mbps | @5 Mbps |
|---|---|---|
| tunnel small | +43.96 ms | +318.15 ms |
| tunnel treeopen | +77.11 ms | +468.44 ms |
| direct small / treeopen | +0.84 / +3.18 ms | +5.06 / −0.24 ms |

Verdict: **p50-fair, p100-blocking** — genuine head-of-line blocking through
the single multiplexed tunnel, not a bandwidth story. Queue scale ≈ in-flight
bytes ÷ cap rate (604 KB @5 Mbps ≈ 0.97 s of drain; the measured +318…+468 ms
tails are the probes' share of that queue behind the 604 KB bulk stream).
Bulk completions track the caps (244–267 ms @20 Mbps, ~985 ms @5 Mbps vs the
ideal 240/966 ms), now gated by the shaper floor at 0.7× (measured margin
1.44–1.58×; a bypassed shaper completes in ~24–43 ms and FAILS).

## Decision / recommendation (evidence-ranked)

1. **Demand reduction first.** (a) Cursor-replay preservation in the FE
   recovery path — the watchdog currently forces cursorless full-snapshot
   reconnects (`web/src/sync/health.ts`, `openSessionStream(id, true)` /
   `connect(true)` in `web/src/sync/tree-transport.ts:803`), so every stall
   re-pays a full snapshot through the tunnel; (b) suppress the fresh tree
   projection after a successful replay; (c) evaluate negotiated WS
   permessage-deflate on tunnel legs. Helps p50 AND tail by shrinking queued
   bytes. Medium complexity, no wire-compat break — opt-in negotiation
   patterns already exist (`part_delta=1`, `z=1`).
2. **Tunnel fairness — only if the tail remains unacceptable after (1).**
   yamux fork with per-stream round-robin, or negotiated multi-tunnel
   (controller-first deploy; the duplicate-connection rejection at
   `pkg/server/daemon.go:333-345` must be negotiated around). Acceptance
   target: worst-case small-request tail during bulk ≈ the direct-route tail.
   Measurement rail for any such fix:
   `go test ./tests/e2e/ -run TestMultiProjectContention` (both tests are the
   regression gate).
3. **Frozen decisions NOT reopened:** compaction O1 and allowlist v1 — no new
   evidence bears on them.

## Exonerated

- Per-project Store lock (project-scoped `s.mu`) — no cross-project contention.
- Loopback compute/serialization — ms-scale absolute costs at 7 projects.
- Heartbeat churn (per-worker, not per-project).
- Reconnect re-snapshot storm cost — recovery burst is ~2-3 ms; the ~1 s is
  backoff.

## Open questions

- Production link class (bandwidth/RTT/loss) — the shaper models queuing
  only; §7 capture procedure
  (`docs/ai/wire-protocols/part-append-streaming.md:334-389`) on a real 7-tab
  repro would pin the real numbers.
- Browser-side apply/render attribution (Phase A2, parked).
- Whether production bulk traffic is dominated by non-allowlisted
  full-upsert paths — the deployed `PartUpsertBurst` probe can answer on the
  real instance.

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Fixture determinism (SeedMultiProject) | `go test ./pkg/fixtures/ -run MultiProject -count=1 -v` → 4/4 PASS (Determinism, DirectoryScoping, SizeControl, IdSchemeStability) | yes |
| Loopback baseline (A1) reproducible | `go test ./tests/e2e/ -run TestMultiProjectContentionBaseline -count=1` → PASS (8.9s, 40 rows) | yes |
| Shaped-link measurement + shaper floor (A1b + DEFER burn) | `go test ./tests/e2e/ -run TestMultiProjectContentionShapedLink -count=1` → PASS; 4/4 `[shaper-floor …] bulk completion ≥ floor` lines (1.44–1.58× margins) | yes |
| Floor actually gates (bypassed shaper fails) | negative control: token bucket bypassed → all 4 floor checks FAIL (`23.5–42.5 ms < 169/677 ms floors`); experiment reverted pre-commit | yes |
| Full lane green with the floor active | `go test ./tests/e2e/ -count=1` → ok 36.0s | yes |
| A1/A1b infrastructure landed | commits `aed5e3c`, `e88ee2c`, `aa1a29c` on `main` | yes |
| Shaper-floor DEFER burned | commit `1369e16` (commit-reviewer: approve, high confidence, no blockers) | yes |
| Measured numbers restated faithfully | read from `tmp/agent-runs/multiproject-contention-20260918/baseline-a1b.log` (2026-09-18 dump; VH_MP_SHAPED_OUT rows in `baseline-a1b.json`) | yes |
| Single-tunnel / mutex-writer / duplicate-rejection cites | code inspection 2026-09-18: `pkg/agent/daemon.go:189-219`, `pkg/server/daemon.go:279-358` + `:333-345`, `pkg/tunnel/websocket.go:90-146`, go.mod yamux v0.1.2 | yes |

## Contradictions

None detected between the measurements and the supplied findings. One
operator-supplied premise was **stale**: the O(n²) part-streaming snapshot
(F2) predates the part-append-streaming fix (default-on since those slices);
it was corrected before measurement rather than re-investigated.

## Next steps

1. If the 7-tab slowness recurs: run the §7 capture procedure on the real
   repro to pin the production link class and the actual bulk-traffic mix
   (`PartUpsertBurst` probe).
2. Implement demand-reduction item (a) (cursor-replay preservation) first;
   re-measure with the A1b rail before considering tunnel fairness.
3. Keep the A1b tests as the regression gate for any tunnel-transport change:
   `go test ./tests/e2e/ -run TestMultiProjectContention`.
