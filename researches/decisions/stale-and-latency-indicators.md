# Stale-data, updating-indicator, and conn-vs-server-latency diagnostics — design map

## Context
After a vh-solara server restart, the SPA shows stale data for a long time, the agent label is missing in the session list, and session selection is slow. The operator wants (1) a stale indicator, (2) an "updating" indicator that does not spam, and (3) a way to distinguish connection-slow from server-slow. This is a read-only design/decision-shaping packet; it does not implement anything.

## Findings (file:line on `main`)
### A. Stale data persists after restart — two windows + a missing-signal gap
- Window (a) disconnect+backoff: `web/src/sync/stream.ts:~269` sets `status="live"` only on socket open. `web/src/components/ConnectionToast.tsx:9-49` shows "reconnecting" after 1200ms; `web/src/components/Sidebar.tsx:63-64` status dot; `RestartOverlay.tsx:8-39` fires ONLY for admin restart (`vhRestarting` in admin layer), not crash/external.
- Window (b) live-but-server-aggregating with ZERO signal: the Go HTTP server starts serving before `hydrate()` finishes (`cmd/local-server.go:220-241`; `pkg/aggregator/aggregator.go:140-185` hydrate then `seedColdLastAgents` at `:167`). `status` flips "live" on socket open (`stream.ts:~269`) before any snapshot; mid-hydrate snapshots have incomplete `lastAgents`.
- The server ALREADY emits freshness primitives the FE ignores (0 grep hits): `X-VH-Epoch` header (daemon generation, `pkg/web/server.go:516-535`), snapshot `Epoch` (`pkg/state/store.go:1190`), per-session `GateFacts.Hydrated` (`store.go:1210-1225`). `lastSeen` is module-private (`stream.ts:203`), `STALE_MS=45000` (`stream.ts:207`).

### B. Agent label missing
`lastAgents` empty until `seedColdLastAgents` (`aggregator.go:167,198-243`) completes; `applySnapshot` wholesale-replaces the FE cache (`stream.ts:29`) so a mid-hydrate reconnect erases correct labels until the next full snapshot; `SetLastAgents` (`store.go:1558`) is snapshot-only. Chip path: `SessionTree.tsx:138-153` → `sessionLastAgent` (`selectors.ts:56-66`) → `agentDisplay` (`projectSettings.ts:68-77`). Secondary (gap CLOSED): `refreshProjectSettings()` IS re-fired on reconnect via the connecting→`"live"` transition effect (`index.tsx:99-112`, the same effect that re-loads agents/models; fires on initial open AND reconnect after a drop), so this is no longer a contributor to stale agent chips.

### C. Selection slow
Synchronous full `client.Messages` fetch inside `ensureMessages` (`server.go:752-762` → `aggregator.go:63-73` → `opencode/client.go:313-319`, no limit; `ensureMessages` is called by `handleStream` at `:784`/`:846` on a fresh/cursor-too-old client), worst on first open of an unloaded session. No instrumentation for conn-vs-server split. Loading overlay (`ChatView.tsx:1436-1462`, gated on `messagesLoaded`) shows DURING the wait.

## Options
- **Stale:** S1 surface `lastSeen`; S2 add a `stale` ConnStatus (`types.ts:109`); S3 consume `Epoch` + gate `applySnapshot` lastAgents-wipe (`stream.ts:29`); S4 consume per-session `Hydrated`. **Recommendation: S3 + S4 + S1.**
- **Updating (anti-spam):** U1 threshold-on-duration; U2 only-on-snapshot; U3 debounce leading+trailing ~400–800ms at the event-dispatch layer (`stream.ts:243-265`); U4 per-session via `sessionWorking`. **Recommendation: U3**, global `isUpdating` + reuse per-session `sessionWorking`.
- **Conn-vs-server:** L1 FE-only `performance.now()` at EventSource construct → onopen → first snapshot (Stream1 `stream.ts:232/265/237`, Stream2 `stream.ts:311/313`), zero server change; L2 server `/vh/ping` + `aggMs` in snapshot. **Recommendation: ship L1 first.**
- Existing idiom: `<Spinner>` (`web/src/components/Spinner.tsx`) + `.placeholder`/`.chat-loading` CSS; NO Suspense, NO shared wrapper.

## Open forks (need a human/debate call)
1. Does the server need an explicit `rehydrating` status, or is consuming `Epoch` + per-session `Hydrated` enough?
2. Should `applySnapshot` ever wipe `lastAgents` with a server map LESS complete than the FE cache?
3. Is the first-open upstream `Messages` fetch acceptable inside `handleStream`, or should it move to background hydration? (architecture — selection-slowth root cause; HELD pending debate)
4. Should the loading overlay distinguish "connecting" from "fetching history"?
5. Global vs per-session staleness surface.

## Recommendation
Ship S3+S4+S1 (stale), U3 (updating), L1 (latency) — FE-only, reusing already-emitted server data. Forks #1–#3 (esp. #3) may change the picture.
