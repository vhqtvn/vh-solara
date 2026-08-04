# Paseo — streaming & timeline-sync
Pin: 9e5accee (base, verified). Cross-checked against HEAD 5d15e40 (backpressure threshold resolved at both pins — see README § "Backpressure threshold — RESOLVED").
Source access: local clone refs/paseo @ 9e5accee.

## Model
- **Timeline = append-only, per-agent monotonic-seq log** in an in-memory store (`InMemoryAgentTimelineStore`, `packages/server/src/server/agent/agent-timeline-store.ts`); `seq = state.nextSeq++` at append; `epoch = randomUUID()` per timeline seed.
- **Live delivery** = synchronous fan-out of `agent_stream` frames to in-process subscribers (`agent-manager.ts:dispatch`); carries `{seq, epoch, timestamp}` ONLY for committed items. `emitLiveTimelineItem` carries none (ephemeral hint, always superseded by a later fetch).
- **Authoritative fetch** = `fetch_agent_timeline_request` → `InMemoryAgentTimelineStore.fetch` → projected via `timeline-projection.ts` (`projectTimelineRows`/`selectProjectedTimelinePage`), collapsing tool-lifecycle + merging assistant/reasoning chunks; each projected entry carries `seqStart/seqEnd/sourceSeqRanges/collapsed`.
- **Default page** = 200 (server); client page size 40 projected items (`packages/app/src/timeline/timeline-fetch-policy.ts`).
- **Client dedup** = strict contiguous cursor `{epoch, startSeq, endSeq}` in `session-stream-reducers.ts:classifySessionTimelineSeq`: `init`/`accept`(seq===endSeq+1)/`drop_stale`(dedup)/`gap`(seq>endSeq+1 → emit `catch_up`)/`drop_epoch`. **No reorder buffer** — ahead-of-contiguous triggers a fetch catch-up, not buffering.
- **Coalescing** = server 60ms (`agent-stream-coalescer.ts`); NO "48ms client coalescer" (that figure is a terminal fit-retry delay; terminal output coalesces on 5ms).
- **Terminal binary frames** (`packages/protocol/src/binary-frames/terminal.ts`): `[opcode:1][slot:1][payload]`; opcodes Output 0x01/Input 0x02/Resize 0x03/Snapshot 0x04/**Restore 0x05** (Restore is defined/demuxed but `handleBinaryFrame` ignores it — reserved).

## Backpressure — DEFINITIVE (at 9e5accee)
- The agent-manager fan-out is an **unbounded synchronous loop** (no per-subscriber buffer/queue).
- BUT the WS send layer enforces a hard high-water → **terminate socket**: `packages/server/src/server/websocket/physical-socket.ts:MAX_PHYSICAL_SOCKET_BUFFERED_BYTES`. `sendBoundedPhysicalFrame` checks `bufferedAmount + frameBytes <= cap`; over → invokes a **caller-supplied `onHighWater: () => void` callback** (the `ws.terminate()` action lives in the caller, not a named export in `physical-socket.ts`). `sendMessageToSockets` pre-filters sockets by capacity and **silently drops** when none writable.
- **RESOLVED (read at `9e5accee` + `5d15e40`):** the cap is **64 MiB** at BOTH commits, byte-identical (`MAX_PHYSICAL_SOCKET_BUFFERED_BYTES = 64*1024*1024`). Paseo's `docs/architecture.md` "8 MiB hard" is a **paseo doc-error** (same layer, wrong number). The **4 MiB terminal-soft** is also confirmed in code (`terminal-restore.ts:MAX_CLIENT_BUFFERED_BYTES = 4*1024*1024`). The relay-adapter queue the doc folds into "8 MiB" is a different queue and scoped out (vh-solara doesn't use paseo's relay topology). Mechanism (terminate-not-throttle, no producer feedback) confirmed; threshold = 64 MiB hard + 4 MiB soft.

## Durable / retention — DEFINITIVE
- **OSS daemon wires NO durable timeline store** (`bootstrap.ts:new AgentManager` omits `durableTimelineStore`; repo has zero concrete `AgentTimelineStore` impls — only the interface + injection point). Timeline rows live ONLY in process memory → **all lost on crash**.
- **Restart recovery** = `agent-loading.ts:hydrateTimelineFromProvider` re-streams from the **provider's own history**, best-effort (failures swallowed). Agent *metadata* IS durable (atomic JSON via `agent-storage.ts`).
- **Retention is UNBOUNDED** in OSS — `rows[]` has no eviction/compaction; the `gap` signal (`cursor.seq < minSeq-1`) is **dead code** (only fires if rows trimmed, which never happens). Forward-compatible plumbing for a future store.

## Other
- **64 KiB "slicer"** = per-field truncator (`agent-timeline-content.ts:limitAgentTimelineItemContent`, `TOOL_CALL_CONTENT_MAX_LENGTH`), NOT a chunker; each item is one row.
- **PTY "last-interacting-client-wins" is UNENFORCED** — `terminal-session-controller.ts` has no ownership arbitration; concurrent clients fight over resize; last frame wins accidentally. Only an unchanged-size dedup suppresses same-client redundancy.
- Projection/rows→wire mapper is `timeline-projection.ts` (NOT `agent-projections.ts`, which is agent-metadata only).
- Client catch-up state machine: `packages/app/src/timeline/timeline-sync-plan.ts` + `timeline-fetch-policy.ts`.

## Strengths / sharp edges
- Robust: clean committed-vs-live separation (seq presence = committed); projection refuses to split merged chunks; daemon-owned timestamps/seq; selective timeline delivery (`selectiveAgentTimeline` capability) drops unviewed agents.
- Sharp: timeline NOT crash-durable in OSS (fidelity at provider's mercy); backpressure = disconnection not throttle (slow mobile client killed at cap); unbounded in-memory growth; terminal resize unenforced; fan-out has no per-subscriber try/catch (a throwing subscriber breaks the loop for the rest).
