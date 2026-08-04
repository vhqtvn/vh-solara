# Paseo — agent lifecycle, persistence & orchestration
Pin: 9e5accee (base, verified). Source access: local clone refs/paseo @ 9e5accee.
NOTE: the cross-provider lifecycle switch is UNTOUCHED by later deltas; the OpenCode-provider-specific turn/stop boundary moved at d9b72e1 — see `04-opencode-adapter.md`.

## Lifecycle state machine
- Statuses (`packages/protocol/src/agent-lifecycle.ts`): `initializing → idle ⇄ running`, plus `error`, terminal `closed`. `ManagedAgent` is a discriminated union over `lifecycle` on `ManagedAgentBase`.
- **Transition switch = `dispatchStreamEventByType`** (`agent-manager.ts:~3425-3493`). ONLY `turn_started/turn_completed/turn_failed/turn_canceled` mutate `agent.lifecycle`, each gated on `!isForegroundEvent`. `turn_started`→running; `turn_completed`→idle; `turn_failed`→error(sets lastError); `turn_canceled`→idle.
- **`attention_required` is NOT a switch case** — it is an OUTBOUND edge-triggered notification, produced from the attention flag by `checkAndSetAttention` (called from `emitState`): running→idle⇒"finished", →error⇒"error", permission⇒"permission". Suppressed for internal + delegated agents.
- **Foreground turns do NOT mutate agent-level lifecycle** (by design) — a foreground `turn_failed` won't set lifecycle=error; that's the foreground-run machinery's job. Background/autonomous turns own agent-level lifecycle.

## AgentManager — single source of truth + fan-out
- `this.agents: Map<id,ManagedAgent>` (sole truth) + `this.subscribers: Set<SubscriptionRecord>`. `subscribe(cb,{agentId?,replayState?})`. `registerSession` is the SOLE insertion path; `subscribeToSession` the sole stream wiring. Create + resume converge on `registerSession`.

## Persistence (file-backed JSON, no DB, no migrations)
- Layout: `$PASEO_HOME/agents/{sanitized-cwd}/{id}.json`. Atomic writes (`atomic-file.ts:writeJsonFileAtomic` = temp file + `fs.rename`). `StoredAgentRecord` (Zod); `pendingWrites` chain per-agent. Forward-compat via optional fields + small inline normalization; one-shot cwd→workspaceId backfill is the only migration.
- Resume is **provider-gated and lazy** (`agent-loading.ts:ensureAgentLoaded`): if a resumable `PersistenceHandle` exists → `resumeAgentFromPersistence` (continuity); else `createAgent` from stored config (fresh). Unreferenced agents stay as cheap JSON.

## Archive normalization
- In **`agent-archive.ts`** (`buildArchivedAgentRecord`/`normalizeArchivedStatus`), NOT `provider-subagents/store.ts` (a doc citation pointed at the wrong file). running/initializing→idle; clears `requiresAttention`/`attentionReason`/`attentionTimestamp`.

## Subagents, permissions, MCP, loops, schedules, chats
- Two subagent models: (i) provider subagent (in-memory only, `ProviderSubagentStore`); (ii) MCP `create_agent` first-class ManagedAgent, parent-linked by LABEL `paseo.parent-agent-id` (`create.ts:mergeLabels`). No per-agent trust boundary (inherits parent fs reach unless worktree-isolated).
- Permission flow: `permission_requested`{request,actions:allow/deny} → client/user → `respondTo_permission` → `respondToPermission` (`agent-manager.ts:~2226-2259`, drains `bufferedPermissionResolutions` in `finally`; `inFlightPermissionResponses` dedupes).
- MCP server exposes the `PaseoToolCatalog` natively AND to external clients (`createAgentMcpServer`, name "agent-mcp" v2.0.0).
- Loops (`loop-service.ts`): worker/verifier until exit condition; **DO NOT auto-resume on restart** (interrupted→stopped). Schedules (`schedule/`): cron/every; cadence **catches up**; interrupted runs→failed. Chats (`chat-service.ts`): mention-routed rooms, no human identity (human-as-agent bus).

## Doc/code drift (CONFIRMED, doc wrong on main)
- `docs/data-model.md` §loops says writes are "direct (not atomic)"; code uses `writeJsonFileAtomic`. **Code authoritative: atomic.** Still wrong at HEAD.

## Strengths / sharp edges
- Robust: single-source-of-truth Map + synchronous fan-out; atomic writes everywhere; discriminated-union lifecycle; lazy provider-gated resume.
- Sharp: no DB/no transactions (cross-store consistency is orchestrated/eventual, mitigated by startup sweeps); loops die on restart; cwd sanitization is lossy; no parent→subagent trust boundary; provider subagents in-memory only; 137KB `agent-manager.ts` is a god-class.
