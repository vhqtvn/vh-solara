# Paseo — OpenCode provider adapter
Pin: base 9e5accee; **turn/stop boundary RE-PINNED to d9b72e1** (commits #2662 + #2696). Source: local clone @ 9e5accee + raw @ d9b72e1.

## Transport & server management (9e5accee)
- `OpenCodeServerManager` (`providers/opencode/server-manager.ts`) is a process singleton that spawns `opencode serve --port <auto>` on **127.0.0.1** (loopback only). Binary via `findExecutable("opencode")`. Args `[...prefix, "serve", "--port", <port>]`.
- **Neutral cwd** = `resolveOpenCodeHomeDir()` = `$PASEO_HOME/opencode-home` (NOT `~/.opencode`) — launching from the real home makes OpenCode index the whole home tree. Readiness = stdout `"listening on"` within 30s.
- Four `acquire*` variants: `acquireCurrent` (shared, lazy), `acquireNew` (rotate), `acquireDedicated(env)` (private env overlay; the ONLY path injecting arbitrary env), `acquireExisting(url)` (reattach, never spawns). Ref-counted; retired servers linger until last release.
- **Auth answer:** spawned server INHERITS the FULL daemon `process.env` (API keys pass through unchanged); only Paseo runtime-control keys + Claude parent-session markers are stripped. Per-session isolated keys only via `acquireDedicated(launchContext.env)`. Paseo stores NO keys; `getDiagnostic` runs `opencode auth list` only to render a diagnostic string.
- HTTP/SSE client via `@opencode-ai/sdk/v2/client` (`createOpencodeClient({baseUrl, directory:cwd})`).

## Turn execution (9e5accee)
- **Fire-and-forget `session.promptAsync`** + ONE global SSE stream (`client.global.event`, `sseMaxRetryAttempts:0`). `startTurn` returns `{turnId}` immediately. The turn is RECONSTRUCTED by translating opencode events → normalized `AgentStreamEvent`. **Terminal = `session.idle`/`session.error` — NEVER the prompt ack** (`command()`/`promptAsync()` are dispatch acks only). Stream EOF before a terminal → `turn_failed`.
- `translateOpenCodeEvent` master switch: session.{created,updated,deleted,idle,error,status,compacted}, message.updated, message.part.{updated,delta}, permission.asked, question.asked, todo.updated.
- Persistence = deliberately thin handle `{sessionId, cwd, modeId, model}`; conversation lives in opencode's store; resume = reattach to same sessionId + replay history (fingerprint dedup). Rewind = `client.session.revert` (v1 exposes revert only).

## Tool calls & permissions
- `OPENCODE_CAPABILITIES` lacks `supportsNativePaseoTools` → Paseo tools injected via MCP (`client.mcp.add`). Tool-part parsing = defensive Zod UNION over `callID`/`id`/neither (**`callID` wins**, order significant) — schema unstable across opencode versions.
- Per-tool `ToolCallDetail` (`providers/opencode/tool-call-detail-parser.ts`): task→sub_agent, shell/bash→shell, read→read, write→write, edit/apply_patch→edit (V4A apply_patch→unified-diff conversion), search/grep/glob/web_search→search, skill→plain_text, else→unknown. `callId` required (else dropped). `mapOpencodeToolCall` does NOT synthesize ids.

## d9b72e1 RE-PIN — turn/stop boundary (#2662 + #2696), line-verified
> SUPERSEDES any "stop is a flag/idle-deferred" or "autonomous turn starts on user message.updated" reading from the 9e5accee study.

- `OpenCodeTurnState = idle | running | stopping` (`opencode-agent.ts:2760-2765`); `OpenCodeRunnerStatus = idle | busy | retry` (`retry` is ACTIVE) (`:2818-2840`).
- **`OpenCodeStop` (the `stopping` payload, `:2764-2782`) carries ONLY `{pendingCancellationTurnId, readonly terminal: Deferred<void>}`.**
- **SELF-CORRECTION:** the session-scoped abort is DELIBERATELY NOT on the stop — it lives on the SESSION as `abortSettlement` (`:2952-2956`), because OpenCode's abort is session-scoped and outlives the stop that issued it. `issueOwnedAbort` (`~3883-3890`) chains `abortSettlement = Promise.all([stillInFlight, abort])`; only the newest abort may hold the fail-closed gate; `awaitRunnerQuiescence` (`:3115-3127`, called at top of `startTurn` `:3212`) drains it. `issueStop` (`:3845-3873`) routes Stop-again-during-stop to the same stop.
- **`shouldStartAutonomousTurn` (`:3792-3800`) returns true ONLY when `getOpenCodeRunnerStatusFromEvent(...) !== null && isOpenCodeRunnerActive(status)` (busy|retry).** The `message.updated`-user-role path and foreground-events path are DELETED. Reason (code comment): message records are mutable and can be patched after the runner stops; only execution status is authoritative. (Root cause #2696 fixed: OpenCode stamps its filesystem-snapshot diff onto the user message AFTER the turn goes idle, falsely reopening turns.)
- On-subscribe adoption: `subscribe` (`:3411`) → `startExternalStatusReconciliation` (only for `externallyDriven`) → `reconcileExternalRunnerStatus` probes provider status and adopts an already-busy session via `startAutonomousTurn`. Race guard = `runnerStatusRevision` (bumped in `observeRunnerStatusEvent`); one-shot guard = `externalStatusReconciliationStarted`.
- `finishStoppingTurn` (`:3919-3931`): acknowledge → reset turn tracking → `turnState={status:"idle"}` → `stop.terminal.resolve()`. `discardEventWhileStopping` (`:3757-3779`).
- Live `COMPAT(opencodeSlowAbort)` tag in `interrupt()` (`~3046-3066`) — OpenCode 1.14.42+ blocks session.abort until the running tool stops.

## #1925 recalibration (IMPORTANT)
- `opencode-go` is a model PROVIDER ROUTE (e.g. `opencode-go/glm-5.1`), NOT a Go rewrite of OpenCode. #1925 is a client-side model-resolution bug: `parseModel` (`:4064-4073` @ 9e5accee) hardcodes `providerID:"opencode"` for prefix-less model strings, breaking models owned by another provider. PR #1928 (`buildOpenCodeModelProviderLookup`, resolve from server catalog) is **NOT merged** at 9e5accee or d9b72e1 — bug live on main.
- **Durable lesson:** resolve external identifiers against the external system's authoritative catalog, NEVER a client-side hardcoded default.

## Normalized contract to mirror (`agent-sdk-types.ts`)
`AgentClient`/`AgentSession`/`AgentStreamEvent`/`ToolCallDetail`/`AgentPersistenceHandle`/`AgentCapabilityFlags`. OpenCode capabilities: all supported EXCEPT `supportsRewindConversation`/`supportsRewindFiles` (only `supportsRewindBoth:true`).

## vh-solara lessons
- Copy: fire-and-forget + global SSE; thin handle; own stream lifecycle (`sseMaxRetryAttempts:0` + EOF→failed); defensive untrusted parsing (callID/id union); auth in opencode process; neutral cwd; catalog-based model resolution (#1925 guard); single narrow versioned translation interface.
- Avoid: coupling to drift-prone field names; trusting prompt ack as completion; per-session SSE streams; hardcoding providerID.
