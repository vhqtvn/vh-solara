# 2026-07-08 — Warm-Open Stale-Paint & ~5s Latency Investigation

## TL;DR
**Complaint:** under many running sessions, a warm session open paints stale cached data, then silently swaps to fresh data ~5s later with no indicator (reported as `conn 429ms · server 5206ms · hydrate warm`).

**Two-layer fix shipped (6 commits, all local/unpushed at closeout):**
1. **Indicator (Part A):** a new `.dot.refreshing` signals when a warm session shows cached data while its fresh snapshot is in flight (no more silent swap).
2. **Root cause (slice a):** the ~5s is **tunnel transport**, not server compute. Capped `refreshOpenSessions()` fan-out from unbounded `Promise.all` to bounded concurrency (`REFRESH_CONCURRENCY = 3`, tunable).

**Store-lock hypothesis REFUTED** by live measurement. The store is very likely fine; only the warm path was measured (a heavy token storm was not).

## Diagnosis (decisive)
- **Store-lock hypothesis refuted.** Non-disruptive measurement against the live worker socket (~297 sessions across 3 dirs, 3 actively streaming): warm session message-snapshots (40–290 KB) = 4.7–17.5 ms; 20 concurrent snapshots busiest dir = 11 ms wall total (1–4 ms each); tree snapshots 0.5–1.0 ms. Server compute is sub-20 ms. `store.Snapshot()` under the exclusive `s.mu` lock (`pkg/state/store.go:1486-1487`) is NOT the wait.
- **Root cause = tunnel transport.** The FE `server Yms` metric was MISNAMED: it measured `onopen → first snapshot event` (`web/src/sync/stream.ts:423`), and the snapshot body traverses browser → controller → yamux/WebSocket → worker. So "server" structurally **included tunnel transit**. `refreshOpenSessions()` fired `Promise.all` of N concurrent multi-hundred-KB full-transcript `GET /vh/snapshot?sessions=<id>` on every tree snapshot (`stream.ts:517-527`) → all through the single yamux-over-WebSocket tunnel → head-of-line / bandwidth contention → seconds.
- **Residual gap:** a heavy token storm (many concurrent `Apply` writers on `s.mu`) was NOT measured. The store is very likely fine but not formally retired under token-storm load.

## What shipped from this investigation (6 commits, local/unpushed at closeout)
| Hash | Slice | Key files |
|---|---|---|
| `4c49994` | Part A — warm-snapshot indicator (logic + tests) | `store.ts` (`refreshing`), `stream.ts` (arm/clear), `SessionTree.tsx` (`.dot.refreshing` Show), `applySnapshot.test.ts` |
| `61d11ec` | Part A — `.dot.refreshing` CSS | `styles.css` |
| `5de7460` | `GET /vh/snapshot` `dur_ms` logging (VH_DEBUG-gated) — diagnostic | `pkg/web/server.go` (`logRequests`) |
| `7c6e2ab` | (c) relabel `server`→`snap` metric (honest end-to-end labeling) | `ServersPanel.tsx`, `stream.ts`, `store.ts` |
| `5f996f0` | `make build-debug` target (forced debug logging via ldflags `debugForced`) | `Makefile`, `pkg/vhlog/vhlog.go` |
| `82575a5` | (a) bound `refreshOpenSessions` fan-out to `REFRESH_CONCURRENCY=3` (tunable) + `runWithConcurrency` helper | `stream.ts`, `refreshOpenSessions.test.ts` |

Other commits on the branch (`ecf6bef`, `9cb1360`, `79d9405`, `d17838d`, `8aa6c49`, `72ba91d`) are from concurrent/sibling sessions or harness updates — NOT this investigation.

## "Is the latency from us?" — diagnostic checklist for a future perf agent
1. **Read the now-honest `snap` ms** in ServersPanel (end-to-end: server compute + serialize + tunnel transit; transit dominates under fan-out).
   - `snap` multi-second → still tunnel/compute. Our cap (`REFRESH_CONCURRENCY=3`, `stream.ts`) may need tuning (try raising it), or the real lever is slice (b) (payload shrink). We REDUCED tunnel pressure, we did not add it — not a regression from us.
   - `snap` low but UI feels slow → NOT us (our changes add no latency).
2. **Measure server compute directly.** Run the debug binary (`make build-debug` or `VH_DEBUG=1 ./vh-solara`) and grep the `GET /vh/snapshot dur_ms` log (instrumented in `5de7460`).
   - `dur_ms` sub-100 ms even under a token storm → store is NOT the cause (consistent with the 2026-07-08 measurement).
   - `dur_ms` climbing under heavy `Apply` token-stream load → the store hypothesis (retired for the warm path) may deserve re-examination for the token-storm path. This is the one unmeasured case.
3. **Check the indicator dots.** `.dot.refreshing` (Part A) shows when a warm session paints cached data + a snapshot is in flight; `.dot.hydrating` on a cold open. If a dot misbehaves (stuck, wrong state), that's Part A (us) — check the arm/clear sites in `stream.ts`.
4. **Bounded-refresh freshness.** With `REFRESH_CONCURRENCY=3`, backgrounded/off-screen opened sessions refresh their full transcript on a turn (total wall-time grows ~N/3). If the complaint is "a backgrounded session's transcript is slow to update," that's the cap — raise it, or pursue slice (b)/lazy-on-reveal. Previews (last-message/agent/activity) still arrive via the tree snapshot regardless, so list freshness is unaffected.

## Deferred follow-ups (not shipped)
- **Slice (b) — warm-open payload shrink** (compress on wire / trim what a warm reopen re-ships). Biggest tunnel win; distinct from the separate ~48 MB `Snapshot(nil)` permission-sweep path. Protocol/wire change → needs its own research+design. *Trigger:* slice (a)'s cap underdelivers (snap-ms still high under load), or operator reports residual warm-open latency.
- **Option D — trigger debounce** for `refreshOpenSessions`. Deferred: the measured ~5 s is a single reconnect fanning out N pulls, not a burst; bursts re-firing could not be confirmed. *Trigger:* reconnect-burst re-firing confirmed.
- **Formally retire the store hypothesis under token-storm load.** Deploy the debug binary, grep `dur_ms` during a real multi-session token storm (prediction: sub-100 ms). *Trigger:* store needs formal retirement, or a perf complaint points at write contention.

## Key anchors
- `web/src/sync/stream.ts` — `refreshOpenSessions()` (~L330-344, now bounded), `REFRESH_CONCURRENCY` constant, `runWithConcurrency` helper, trigger site (~L517-527), `refreshing` arm/clear.
- `web/src/components/SessionTree.tsx` — `.dot.refreshing` Show predicate.
- `web/src/components/ServersPanel.tsx` — `snap` ms label (was `server`).
- `pkg/web/server.go` — `logRequests` GET `/vh/snapshot` `dur_ms` (VH_DEBUG-gated).
- `pkg/state/store.go` — `Snapshot()` / `s.mu` (the refuted hypothesis; UNCHANGED by this investigation).
