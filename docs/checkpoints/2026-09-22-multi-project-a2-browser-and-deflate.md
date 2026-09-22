# 2026-09-22 — Multi-project A2 browser attribution & deflate: decision record

Date: 2026-09-22 · Scope: worker tunnel transport / multi-project contention ·
Commits: `a3794411` (A2 browser), `07d3c8fd` / tree `8afca362` (Q4c deflate) + this document's commit.

## Situation

Following the prior measurement pass ([2026-09-18-multi-project-tunnel-contention.md](./2026-09-18-multi-project-tunnel-contention.md)), this effort implements and measures Phase A2 (browser attribution) and Q4c (negotiated permessage-deflate) to quantify exact DOM/render costs and tunnel wire savings for the multi-project contention issue.

## What Landed

**Slice 1 — Phase A2 browser attribution (Q2), commit `a3794411`:**
- `pkg/fixtures/mpworkload.go` (sustained-workload controls: start/release/status/stop/reset + mp-seed; deterministic byte-exact chunks, barriers, overflow accounting, sha256 digests).
- `pkg/fixtures/opencode.go` (+ emit-dropped counter, routes).
- `pkg/fixtures/multiproject_test.go` (5 lane-1 tests).
- `web/tests/e2e/multiproject-latency.spec.ts` (serial lane-6: 7 pages in ONE context; S1 cold / S2 warm streaming / S3 bulk 48KiB+six smalls / S4 clean reconnect / S5 stale-ring repair; metrics: cb→decode→apply(flush ledger)→DOM(MutationObserver addedNodes)/rAF/longtask; dump via `VH_MP_A2_OUT`).

**Slice 2 — Q4c negotiated permessage-deflate (commit `07d3c8fd`, tree `8afca362`):**
- `VH_TUNNEL_DEFLATE=off|all|1k|4k` (default `off`, byte-identical handshake/frames), parsed in worker `agent.Start()` + controller `server.NewDaemon`.
- Policy enforced per-message in `wsRWC.Write` under the existing mutex (`pkg/tunnel/websocket.go` — DeflatePolicy, OfferCompression, CompressMessage; `…WithDeflate` transport variants).
- `pkg/tunnel/websocket_compression_test.go` (8 tests: 4-combo negotiation matrix, thresholds, payload classes incl. gzip64/incompressible, race).
- `tests/e2e/shapedlink_test.go` additive true-wire-byte counter.

## Measured Results (shaped-rail/loopback-browser)

**Phase A2 (Browser):**
- **Store-apply:** ≈ free (≤0.1ms med) — cost is render/paint.
- **Warm streams:** ride ~50ms med cb→DOM (83ms rAF ceiling).
- **Bulk page:** 2.4–2.5s total longtasks, 1.2s rAF blackout, isolated to the bulk page via per-page origins; six small pages unaffected (0.4ms render med).
- **Reconnect:** reopen 1502ms = exactly the 1.5s CLOSED backoff floor; catch-up complete ~4.2s.

**Phase Q4c (Deflate - A1b rail, shaper-counted wire bytes):**
- **off→all:** 977.6→623.4 KB (−36%).
- **bulk completion:** −24…−26% (both caps).
- **small-request tail @5 Mbps:** 326→222 ms (−32%) — tail shrinks ~proportionally to bytes at the cap that matters.
- **small-request tail @20 Mbps:** tail +10ms (jitter-scale).
- **CPU:** invisible (unshaped rail identical wall-time; shaped rail faster forced-on).
- **Sweet spot:** `1k` (wire 65.2%, latency ≈ `all`).
- *Direct-leg control constant. Old↔new peer mixed deploys stay uncompressed (4-combo proven) — safe rolling deploy.*

*Caveats: browser metrics derived from loopback (no network latency). Deflate metrics derived from simulated shaped-rail bounds.*

## The New HTTP/1.1 Connection Cap Lead

**Major new lead:** 7 pages × ~3 SSE = 21 connections on ONE origin starve pages 3–7 under the browser's HTTP/1.1 6-connections-per-origin cap. The A2 spec had to shard per-page `*.localhost` origins to pass. 

**Production implication:** `cmd/local-server.go:387` and `pkg/server` use plain `ListenAndServe()` (in-process HTTP/1.1 only, no TLS/http2 config). Whether the operator's browser negotiates h2/h3 depends entirely on the fronting TLS proxy. If production is h1 to the browser, THIS could dominate the 7-tab symptom, independent of the tunnel.

**Operator check (zero code):** Record negotiated protocol per the Q1 runbook row (DevTools → Protocol column), and if h1 → enable h2 at the TLS terminator.

## Decision State

- **Deflate Availability:** Available TODAY via env (`VH_TUNNEL_DEFLATE`) on both sides, default `off` (no code change/default flip needed for operator opt-in).
- **Default-flip gates (before `off` -> `1k` default):**
  1. Reviewer DEFER A-F2 daemon env→handshake wiring test.
  2. Compression-oracle/mixed-content security review.
  3. `mpAssertShaperFloor` margin rethink under compression (floor uses post-decompression bytes; measured 184.6ms vs ~170ms floor = ~8% margin).
  4. Docs for the knob.
- **Q4a:** Deferred pending Q1/Q3 evidence. Feeds forward: SPA proactively reopens session streams cursorlessly under churn. 
- **Product decision open:** >1MiB streamed parts seal + silently drop deltas.
- **Frozen decisions:** Remain frozen as established in the 2026-09-18 record.

## Open Questions

- Does the operator's production environment negotiate HTTP/2 to the browser, or is it starved by HTTP/1.1 connection limits?
- How should >1MiB streamed parts that seal + silently drop deltas be handled at the product level?

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| A2 Browser Attribution Landed | commit `a3794411` | yes |
| A2 Metrics / Sharded Origins | `npm --prefix web run test:e2e -- multiproject-latency.spec.ts` (Spec alone 43.6s, full suite green) | yes |
| Q4c Deflate Landed | commit `07d3c8fd` (tree `8afca362`) | yes |
| Q4c Wire/Latency Reductions | `go test ./tests/e2e/ -run TestMultiProjectContention` (A1b rail commands, shapedlink_test.go counter) | yes |
| Q4c 4-combo negotiation matrix | `go test ./pkg/tunnel/ -run TestWebsocketCompression` | yes |

## Contradictions

- **None detected** in the load-bearing paths. Note: The 2 pre-existing zoom-placement failures in the full web e2e suite are unrelated to this effort.

## Next Steps

**Operator:**
- h1/h2 protocol check + Q1/Q3 capture in DevTools.
- Optional env-enable `VH_TUNNEL_DEFLATE=1k` on both controller and worker.

**Repo:**
- A-F2 daemon env→handshake wiring test.
- Compression-oracle/mixed-content security review.
- Floor-margin rethink before any default flip.
