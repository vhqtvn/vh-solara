# Remote-Latency Overnight Arc — Four Independently-Shippable Fixes

**Arc:** 2026-10-12 overnight autonomous run (build agent). Source investigations:
the remote-latency brief (`tmp/remote-latency-brief.md`, probes 2026-10-11) and the
working-animation freeze trace. Four slices, each implemented + tested +
commit-reviewed (tiered cascade) + committed through the gated-commit protocol.
LIVE system untouched all night: zero requests to bason.vc.libvh.dev or the unix
socket, no daemon restarts, no tag pushes, no releases, no ops config changes.
All verification local (build + tests).

## Slices landed (4/4, one commit each)

| Slice | Commit | What | Verification tonight |
|---|---|---|---|
| A — Self-healing animation gate | `ad3856c` | Lost `visibilitychange→visible` (iOS standalone PWA unlock, bfcache) no longer strands a VISIBLE pane paused forever: `resyncDocVisibility()` re-derives from live `document.visibilityState` and fires the real edge (dedupe no longer swallows healing resyncs, incl. the host's ~10s resync ride-along); gate re-derives+re-applies on `pageshow`, window `focus`, and a ~30s periodic resync. CSS mechanism unchanged (`animation-play-state: paused`, resumable). No speculative compositor re-trigger (S2 unconfirmed). | web unit lane (255 files) + typecheck; jsdom-lane heal coverage incl. carried-forward 19f9e81 CSS-contract + idempotency tests |
| B — F1 pipelined raw-proxy request write | `4322d35` | Controller writes the padded header frame + FULL HTTP request bytes BEFORE reading the worker ack (−1 RTT on every proxied request). One-sided safety RESCUED from a broken sketch: the brief's "worker already tolerates it" was wrong — the worker's one-shot `json.Decoder` 512-byte first-Read window swallows coalesced request bytes (race-dependent corruption). Fix: header frame padded to EXACTLY `RawProxyHeaderFrameLen`=512 so the decoder window can never reach request bytes at offset ≥512 (yamux whole-frame recvBuf appends make partial-header reads impossible). Controller ack reads bridge `dec.Buffered()` + consume exactly one terminator byte (`decodeAckWithResidue`). Worker side (`pkg/agent/daemon.go`) deliberately unchanged. | `go test ./pkg/... ./tests/integration/ ./tests/e2e/` incl. 200-round real-yamux old-worker-read-path proof (50×4 timings), 3 new e2e crux tests (GET+query, ~24KB POST, SSE stream), `-race` on pkg/tunnel+pkg/server |
| C — F3 reconnect-storm damping | `b3724db` | Server: SSE hello `retry:` jittered per connection (2000+rand[0,1000)) — de-synchronizes lockstep pane retries (was: 2,254 tunnel-down rejections, 11.3% of opens). Deliberately NOT escalated server-side (tunnel-down storms never reach the worker; documented inline). SPA: CONNECTING-streak takeover in both transports — after 3 consecutive CONNECTING onerrors, close the ES onto the EXISTING bounded manual backoff (1s/1.5s ×2 → 15s cap); the native loop never reaches CLOSED alone. Below-threshold streaks untouched (healthy blips unchanged). | Go unit (bounds + variance + real-handler wire shape) + web unit (6 tests: threshold, takeover timing, escalation boundaries 999/1000 + 2999/3000, streak reset) + full lanes both sides |
| D — F7 project-switch chain overlap | `7317ddb` | `selectProject`/`addProject` fire `/vh/projects` in the SAME synchronous turn as `switchProject`'s Stream-1 open (module activity cache, inflight-coalesced; switcher consumes it). Capability probe verified ALREADY page-cached (`detectCreateSupport`) — no change needed there. | web unit (same-turn concurrency proof, cache reduction, coalescing, failure-degrades-to-empty, addProject overlap, pin invariants) + typecheck. Client-only |

Review history worth keeping: Slice D round 1 was **BLOCKED** by the panel — my edit
had accidentally inverted `addProject`'s pin guard (dropped `!`). Fixed byte-identical
to HEAD + new pin-invariant tests that fail under the inversion; round 2 approved.
The gated-commit protocol caught a real data-integrity regression that a 3318-test
green run missed.

## Behavioral-closure declarations (honest)

- **A**: crux = heal mechanism at the verified web-unit seam — `result: proven`
  (load-bearing: lost-event posture heals via pageshow/focus/periodic; transition
  fires; genuinely-hidden stays paused). Real-device event DELIVERY (iOS PWA/bfcache)
  is `not-demonstrable` from jsdom — no on-device claim is made (review DEFERs
  a-F1/b-F4/c-F1/c-F2 recorded).
- **B**: crux = full raw-proxy path over the real in-process tunnel + one-sided
  safety over real yamux — `result: proven` locally. The remote warm TTFB
  262→≤190ms acceptance is **POST-DEPLOY, NOT CLAIMED**.
- **C**: crux = retry generation + takeover logic at their seams — `result:
  proven` (Go unit incl. real handler wire shape; web unit). The
  `tunnel_down_rejections` drop is **POST-DEPLOY, NOT CLAIMED**. Review D-F1:
  upgrades to a blocking coverage obligation at the next `v*` tag unless the
  post-deploy acceptance lands first.
- **D**: crux = same-turn overlap + cache semantics at the unit seam —
  `result: proven`. The fresh-badge latency OUTCOME needs a real-browser receipt
  (incl. in-flight-refresh case) before any completion claim (review B-F1 defer).

## Verification (commands, all green at the landed trees)

| Command | Result |
|---|---|
| `go build . ./cmd/... ./pkg/... ./tests/...` + `gofmt -l pkg cmd main.go` | clean (`go build ./...` verbatim unavailable: pre-existing untracked scratch .go under tmp/ breaks package resolution) |
| `go test ./pkg/... ./tests/integration/ ./tests/e2e/ -count=1` | all ok (e2e ~117s, incl. 3 new pipelining crux tests) |
| `go test -race ./pkg/tunnel/ ./pkg/server/ -count=1` | ok |
| `npm --prefix web run test:unit` | 257 files, 3319 passed, 1 skipped (final tree; grew across slices) |
| `npm --prefix web run typecheck` | clean |

Playwright lanes: not run (all changes logic-level, unit-covered) — per mission floor.

## Deferred items + reasons

- **F2 multi-lane tunnel** — deferred by mission design (L-effort protocol work,
  needs both ends + handshake negotiation; duplicate-dial `TypeFatalDuplicate`
  hazard). Next candidate after F1's post-deploy numbers confirm the model.
- **F4 tunnel permessage-deflate** — ops config (`VH_TUNNEL_DEFLATE=1k` both ends),
  operator decision; NOT agent-flippable (live system untouched all night).
- **F5 snapshot pre-compression / F6 yamux window fork** — brief recommends not-now;
  unchanged.
- **Slice A on-device verification** — needs the operator's real iOS device
  (jsdom cannot deliver real lock/unlock events). If the freeze recurs after A
  (should not), it's the S2-compositor class → the re-trigger follow-up.
- **FetchWorkerSnapshot pipelined-path e2e + worker dial-failure 502 e2e under the
  new ordering** (review A2/B2/D5) — unit-covered + logically preserved; add before
  claiming pipelining "complete" post-deploy.
- **Real-browser CONNECTING-premise lane-6 test** (review B-F1/D-F1 on Slice C) —
  suggested Playwright `route.abort()` spec; the fail-safe note holds (wrong premise
  ⇒ takeover never fires, jitter-only benefit).
- **Fleet stream `status_stream.go:285` still advertises fixed `retry: 2000`** —
  out of slice, no evidence it fed the measured storm; jitter when next touched.
- Minor advisory drops (math/rand→rand/v2, unreachable catch in
  refreshProjectActivity, stale comment literal in tree_replay_test.go) — recorded,
  non-blocking.

## Morning checklist for the operator

1. **Deploy/release (operator-driven)**: tag push `v*` per the tag-driven release
   flow. Slice B fixes the CONTROLLER proxy path — the worker binary is unchanged
   but ships along; the deployed worker advertises v1.77.1 today, so confirm the
   controller's version at rollout (brief open-question: controller binary version
   unknown).
2. **F1 acceptance (post-deploy)**: re-run
   `vh-agent-harness exec bash tmp/remote-latency/batteryC_warm.sh` — expect warm
   `/vh/healthz` + descendants TTFB p50 **262ms → ≤190ms** (theoretical ~175ms +
   front-proxy ε). Also sanity-check `/vh/diag/latency`: `ack_dur` histogram still
   healthy, no new `close_reason` churn. (Scratch batteries in `tmp/remote-latency/`
   were NOT touched tonight.)
3. **F3 acceptance (post-deploy, around a planned restart window)**:
   `curl -sS -H 'vh-mdebug: chill-simple' https://bason.vc.libvh.dev/vh/diag/latency | jq '.controller.probes.yamux.tunnel_down_rejections'`
   before/after the window — expect the per-minute rejection rate during downtime to
   drop sharply (was ~2,254 over the 18:38 UTC reinstall window). Taking this
   measurement ALSO discharges review D-F1's upgrade trigger at the next tag.
4. **F7 spot-check**: project switch then reopen the switcher — badges render warm
   without a fetch wait; `__vhSyncDiag` connect/snap shows the overlap (−1 serial
   round ≈ −175ms post-F1).
5. **Animation freeze discriminator (only if it recurs — should not)**: capture the
   DevTools checklist per the freeze trace; a post-A recurrence is the S2-compositor
   class → take the re-trigger follow-up.

## Findings
- **(worker decoder swallow hazard)**: source=Slice B investigation (vendored yamux
  v0.1.2 stream.go + Go encoding/json read-path analysis), confidence=high,
  type=fact. The brief's F1 one-sided-safety claim was wrong as sketched; the
  512-padded header frame restores timing-independent one-sided safety (pinned by
  `TestOldWorkerReadPathNeverSwallowsPipelinedRequest`, which also fails if a future
  Go grows json.Decoder's initial buffer past 512).
- **(storm shape)**: source=brief + Slice C analysis, confidence=high, type=fact.
  Tunnel-down storms die at the CONTROLLER (worker's stream handler unreached), so
  server-side escalation state would be dead weight; the SPA takeover is the real
  damper for that storm class.
- **(gated-commit value)**: source=Slice D round-1 BLOCK, confidence=high,
  type=fact. One-character pin-guard inversion passed a 3318-green suite; the
  reviewer panel caught it 4/4 with diff-verifiable evidence.

## Contradictions
- Brief §F1 "the worker side already tolerates request bytes arriving before its
  ack send (its copy loop drains whatever arrives)" — REFUTED by source analysis
  (decoder private-buffer residue is dropped, not drained). Resolved within Slice B
  via the padded-header design; no open contradiction remains.
- None other detected.
