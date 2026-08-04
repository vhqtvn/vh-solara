# Paseo — client/SDK + mobile real-time
Pin: 9e5accee (base, verified). Source access: local clone refs/paseo @ 9e5accee.

## React-Query vs Zustand (DEFINITIVE)
- **The live agent timeline/chat path BYPASSES React Query and writes straight to Zustand** (`packages/app/src/contexts/session-context.tsx` is the single WS message hub; one large `useEffect` subscribes via `client.on(...)` and dispatches each message type to `useSessionStore`). This is deliberate — RQ is too slow for the latency-critical timeline.
- **React-Query is used only for "server data"** (providers snapshot, daemon config, checkout diff, terminals), bridged from WS by `packages/app/src/data/push-router.ts:mountServerDataPushRouter` (per-server): `setQueryData` + targeted `invalidateQueries`; it also reconciles desired vs active WS subscriptions via the RQ cache `meta.serverData` routes.
- **There is NO RQ cache key for the agent timeline/chat** — that state lives in Zustand maps keyed by `serverId` then `agentId`.
- RQ cache-key shapes: checkoutDiff `["checkoutDiff", serverId, cwd, compare.mode, baseRef, ignoreWhitespace]`; terminals `["terminals", serverId, cwd, workspaceId?]`.

## SessionContext — correction
- **There is NO `useSessionContext` hook and NO React Context.** `SessionProvider` returns `children` directly — a pure side-effect provider wiring `client.on(...)`. Consumers read Zustand selectors. The `_`-prefixed actions (`_createAgent`/`_respondToPermission`/…) are NOT returned → unreachable/vestigial at this pin.

## Low-level WS driver (`packages/client/src/daemon-client.ts:DaemonClient`)
- Hello handshake (outbound): `{type:"hello", clientId, clientType, protocolVersion:1, capabilities:{...}, appVersion?}`. Reconnect: exponential `min(baseDelay*2**attempt, maxDelay)`, base 1500ms, max 30000ms, connect timeout 15000ms. Liveness: 10s heartbeat, 5s timeout, reconnect after 2 failures. `sseMaxRetryAttempts:0`-style explicit lifecycle management. Cross-runtime seam (Node/browser/RN) via `bindWsHandler` + `globalThis.WebSocket`.

## Multi-host (`packages/app/src/runtime/host-runtime.ts`)
- `HostConnection` union: `directTcp`/`directSocket`/`directPipe`/`relay`. A `HostProfile` carries `connections[]` + `preferredConnectionId`. `HostRuntimeController` (one per host) runs a probe cycle (`PROBE_TICK_MS=2000`) that adaptively switches to the best connection; `clientGeneration` increments per reconnect to invalidate stale refs.

## Composer submit
- `handleSubmit`→`sendMessageWithContent`→`submitAgentInput`(`packages/app/src/composer/submit.ts`)→`submitMessage`→`dispatchComposerAgentMessage`(`composer/actions.ts`)→`client.sendAgentMessage`. Optimistic user message + rollback on throw. `forceSend` bypasses queue-when-running. Attachments: image/base64, file/upload, github_pr/issue (COMPAT v0.1.106).

## Audio — DEFINITIVE (refutes earlier brief assertions)
- **The client runs NO STT/TTS/VAD models.** Both engines are pure PCM I/O. Native: `@getpaseo/expo-two-way-audio` (scoped fork) — 16kHz PCM16 uplink. Web: Web Audio API (`getUserMedia` + deprecated `ScriptProcessorNode`), 16kHz PCM16 uplink, plays PCM/MP3.
- **VAD is RMS volume-threshold** (`realtime-voice-config.ts`: volumeThreshold 0.12, silenceDurationMs 2000), **NOT Silero.** sherpa-onnx parakeet STT / kokoro TTS run **daemon-side**, not in `packages/app` (inferred; daemon voice code not read).
- Dictation (one-way STT→composer) via `dictation/dictation-stream-sender.ts`; voice-agent (bidirectional) via `voice-runtime.ts` phases disabled|starting|listening|submitting|waiting|playing|stopping.

## Platform gating + routing
- Gates (`constants/platform.ts`): `isWeb`, `isNative`, `isDev`, `getIsElectron()` (via `window.paseoDesktop` preload bridge, NOT userAgent). Layout uses `useIsCompactFormFactor()` (`constants/layout.ts`), not isWeb/isNative. Metro extension dispatch `.web.ts`/`.native.ts`/`.electron.tsx` preferred over runtime `if`.
- Expo Router at `packages/app/src/app/`: host-scoped `h/[serverId]/{sessions,agent/[agentId],workspace/[workspaceId],...}`; param-driven; `HostRouteServerIdContext`.

## Strengths / sharp edges
- Robust: clean Zustand/RQ split (latency vs queryability); optimistic-send-with-rollback; Electron via preload bridge.
- Sharp: 1345-line god-provider with one ~16-subscription `useEffect` (re-subscription risk); `_`-prefixed actions are dead code; deprecated `ScriptProcessorNode` for web mic; daemon-side voice models unconfirmed.
