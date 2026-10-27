# Send now / Queue: upstream dispatch-terminal witness and barrier research (annex 3)

**Date:** 2026-10-27  
**Status:** COMPLETE (evidence base; informs release rule)  
**Origin:** Task card `queue-idle-gate-send-now` (slice S3)  

> Promoted-from: tmp/agent-runs/queue-upstream-witness-20261027/packet.md  
> Original date: 2026-10-27  
> Provenance: researcher pass task ses_e824319b8ffe7yx8TZp8HKhcOp, 2026-10-27, static tag-pinned source study  
> Relationship: supersedes annex-2 on upstream-source facts only (see §5); release-rule logic unchanged.  

---

## Research Question and Scope

Does upstream OpenCode expose — in **v1.18.14** (this repository's pinned validation tag, `pkg/opencode/db.go:50`) or in any later release up to current (**2026-10-27**) — a mechanism satisfying the dispatch-terminal witness contract, or an equivalent ordered-registration / drain-barrier contract (the G1 gate for the Send now / Queue feature, slice S4)?

- **Scope:** Read-only static source study of upstream repositories at tag-pinned revisions; NO repo code executed, NO upstream code executed. Scratch kept under `tmp/agent-runs/queue-upstream-witness-20261027/`.
- **Time-sensitive:** YES — upstream moves quickly; OpenCode 2.0 shipped GA ~2026-10-12/14. All findings are pinned to tags fetched on 2026-10-27.

## Source Policy and Release Landscape

- **Canonical upstream:** `github.com/sst/opencode`. Observed during retrieval: `sst/opencode` URLs redirect to `anomalyco/opencode` (organization transfer / rename). Both URL families serve identical tag content; the repository links cited in annex-2 were canonical content, not a divergent fork.
- **Retrieval method:** Live web retrieval for releases (atom feed), press corroboration, and raw source at tags `v1.18.14` and `v2.0.32`. Line numbers were unavailable via web-extracted text; citations use canonical file+symbol@tag references.
- **Release landscape (as of 2026-10-27):**
  - **Latest release:** `v2.0.32` (2026-10-16) per live `releases.atom` (feed updated header `2026-10-16T22:16:52Z`; no subsequent entries). Industry press confirms OpenCode 2.0 GA occurred ~Oct 12–14, 2026 (The New Stack, daily.dev, opencode.ai).
  - **1.x maintenance line:** Concludes at `v1.19.3` (2026-10-16). Release notes inspected: `v1.19.1` (share discontinuation), `v1.19.2` (update channel pinning: "OpenCode 1 stays on 1.x, 2.x is explicit"), and `v1.19.3` (reasoning variants). No witness- or barrier-relevant mechanisms were introduced in 1.x.
  - **Stale cache correction:** A zai-cached GitHub releases HTML page showing stale December 2025 data (`v1.0.207` as "Latest") was contradicted and overridden by the live atom feed, press coverage, and successful source inspection at tag `v2.0.32`.

---

## 1. Verdict

**`BARRIER_AVAILABLE`** — in the OpenCode v2 line only (verified READ at `v2.0.32`, latest release 2026-10-16).  
**`NOT_AVAILABLE_AT_v1.19.3`** — for the entire 1.x maintenance line, including this repository's pinned validation tag `v1.18.14` (`pkg/opencode/db.go:50`).

### Basis

The OpenCode 2 event-sourced engine (verified READ at tag `v2.0.32`) provides a durable ordered-registration + drain-barrier contract:
1. **Caller-ID'd prompt admission:** Persisted as `session.inbox.enqueued` with per-session sequencing (`seq`), a transactional pending-row projection in SQLite (`SessionInboxTable`), and HTTP 409 Conflict on durable-ID conflict.
2. **Run-coordinator doorbell:** Prevents an active execution from settling while admitted work remains undrained ("the doorbell closes the gap between a drain's last eligibility check and the idle transition").
3. **Durable terminal observation:** Exactly one durable terminal per busy period (`session.execution.succeeded`, `session.execution.failed`, or `session.execution.interrupted`), code-documented as "covering every coalesced drain".
4. **Crash recovery as a database property:** Durable write-ahead claims committed atomically with `execution.started`; shutdown interruptions preserve the claim so that the next server startup resumes the turn ("recovery is a property of the database, never of a shutdown hook").

The 1.x line (`v1.18.14` through `v1.19.3`) provides none of this barrier infrastructure. Its strongest candidates (the synchronous `prompt` endpoint and the durable V1 message-event log) fail during observation outages, connection drops, and daemon restarts.

The v2 barrier also yields witness-grade terminal evidence per execution: per-dispatch linkage is established by ordered position (`seq`) plus the doorbell barrier invariant, rather than by a dedicated `run-id` field on the terminal event.

---

## 2. Candidate Inventory and the v2 Barrier Contract

### 2.1 Upstream 1.x Inventory at v1.18.14 (Pinned Validation Tag)

| # | Candidate | Contract Offered | Citation (file@tag, symbol) | Verdict |
|---|---|---|---|---|
| C1 | Session Idle event | Run-completion signal per session | `packages/opencode/src/session/status.ts` (`set` → publishes `Event.Status` then `Event.Idle`, deletes map entry); `session/run-state.ts` (`runner`: onIdle → status.set idle); `effect/runner.ts` (`finishRun` → onIdle) | **Insufficient:** Session-scoped payload `{sessionID}` only, in-memory (`InstanceState` map), no dispatch correlation, no replay. Spurious idle exists (calling `cancel` on a runner-less session emits Idle). Concurs with annex-2. |
| C2 | `/event` SSE endpoint | Live event stream | `packages/opencode/src/httpapi/handlers/event.ts` | **Partial:** Eager listener registration, but **no replay or Last-Event-ID** support (`id: undefined`, starts at `server.connected`). Misses any events occurring during a disconnect. |
| C3 | Sync `prompt` endpoint | Per-dispatch terminal receipt (HTTP response = run termination) | `packages/opencode/src/httpapi/handlers/session.ts` (`prompt`: `yield* promptSvc.prompt(...)` awaits full run, returns message JSON; failure yields HTTP 400; `promptAsync` forks, returns 204 before persistence) | **Near-miss:** Response is terminal for that dispatch (including folded work; failure returns 400), but: (a) holds connection open for duration of run (tunnel/proxy fragility), (b) receipt is lost on connection drop, and (c) produces no durable record on restart. Fails outage and restart scenarios. |
| C4 | Durable V1 event log + sync/history catch-up | Ordered per-session persisted events | `packages/core/src/event.ts` (`EventTable`, `EventSequenceTable`, per-aggregate `seq`, `durable(aggregateID, after)`, `readAggregate` cursor paging); `packages/schema/src/durable-event-manifest.ts`; `packages/schema/src/v1/session.ts` (durable: `session.created/updated/deleted`, `message.updated` full info incl. `time.completed`/`finish`/`error`/`parentID`, `message.removed`, `message.part.updated`, `message.part.removed`; non-durable: `message.part.delta`, `session.diff`, `session.error`); `packages/opencode/src/httpapi/handlers/sync.ts` (`history`: `EventTable` select ordered by `seq` with per-aggregate cursors) | **Substantial ordering/durability substrate missed by annex-2**, but lacks execution/turn boundary events, lacks admission barriers, folding-by-`lastUser` persists (`prompt.ts` `handleSubtask` assistants have `parentID: lastUser.id`), and terminal failure before assistant message creation leaves NO durable trace (`session.error` is live-only). |
| C5 | `prompt_async` + messageID (current vh-solara surface) | Delivery acknowledgment only | `pkg/opencode/client.go:326–347`; `pkg/opencode/id.go`; upstream `packages/opencode/src/httpapi/handlers/session.ts` `promptAsync` (204, `startImmediately: true` fork) | **Insufficient:** Delivery acknowledgment is not completion evidence. Settled in annex-2; unchanged. |

*Wiring Note (v1.18.14):* HTTP API routes to the `SessionPrompt` V1 engine (`packages/opencode/src/session/prompt.ts`, using `SessionRunState`/`Runner`). While `session.next.*` definitions exist in `packages/schema/src/session-event.ts` at `v1.18.14`, they are NOT published by this execution path; they represent v2 engine schemas landed early in the schema package.

### 2.2 The v2 Barrier Contract at v2.0.32

| Component | Contract | Citation (file@v2.0.32, symbol) |
|---|---|---|
| **Durable inbox** (ordered registration) | Admission = durable `session.inbox.enqueued {sessionID, inboxID=messageID, item{delivery: steer\|queue}}`; projector inserts pending row in the same event transaction; `SessionInboxTable` (SQLite, `enqueued_seq`, pending-only); FIFO promotion (`nextPromotable`); `InboxDelivered` deletes pending row transactionally; `InboxCancelled`, `InboxDeliveryChanged` supported. | `packages/core/src/session/inbox.ts` (`admit`, `nextPromotable`, `projectAdmitted`, `projectDelivered`, `serialized` keyed mutex); `packages/schema/src/session-event.ts` (`Inbox*`, all durable, aggregate `sessionID`). |
| **Run coordinator** (drain barrier) | Per-key execution coordinator: `wake` rings doorbell — "an active [execution] drains again before settling"; "the doorbell closes the gap between a drain's last eligibility check and the idle transition"; `settled` hook "runs … for every exit, including interruption, after the final drain and **before the execution settles (waiters resolve after it completes)**"; `run` joins active execution; `awaitIdle`. | `packages/core/src/session/run-coordinator.ts` (`Coordinator`, `Execution`, `make`, `wake`, `settle`). |
| **Execution lifecycle** (durable terminal) | `started` emits `session.execution.started` (+ write-ahead claim in same transaction); `settled` emits exactly ONE of `session.execution.succeeded`, `session.execution.failed {error}`, or `session.execution.interrupted {reason: user\|shutdown\|superseded\|inactivity}`; comment: "**One terminal observation per busy period, covering every coalesced drain**"; claim released on terminal except shutdown interruption, which preserves claim so next server start resumes turn; "recovery is a property of the database, never of a shutdown hook". | `packages/core/src/session/execution.ts` (`terminal`, `claimOnCommit`, `releaseOnCommit`, coordinator wiring). |
| **Prompt API** (client surface) | `POST session.prompt {id (caller messageID), text, files, agents, skills, metadata, delivery: steer\|queue, resume}` → durable admission; **409 Conflict on ID conflicting with an existing durable record** (idempotent caller-ID gating); helper endpoints: `session.wait` (await idle), `session.inbox.list/cancel/update`, `session.interrupt`, `session.active`. | `packages/server/src/handlers/session.ts` (`session.prompt`, `session.wait`, `session.inbox.*`); `packages/core/src/session/prompt.ts` (`Input.delivery`, default "steer"). |
| **Event replay surface** | `session.log?after=<seq>&follow` — per-session durable log as stream with cursor and live follow; global SSE (`event.subscribe`) remains live-only (dropping queue, no Last-Event-ID). | `packages/server/src/handlers/session.ts` (`session.log`); `packages/server/src/event-feed.ts`; `packages/server/src/handlers/event.ts`. |
| **Step settlements** (context) | Durable `session.step.started/streamed/ended/failed`, `session.tool.success/failed`, text/reasoning ended, `retry.scheduled`; deltas ephemeral. | `packages/schema/src/session-event.ts`. |

*Earliest version providing the barrier:* NOT pinned. Verified READ at `v2.0.32` (latest release, 2026-10-16). OpenCode 2.0 GA occurred ~2026-10-12/14. Pinning the earliest 2.x tag with the full contract requires an explicit tag-walk follow-up.

---

## 3. Scenario-Matrix Evaluations

The following matrix evaluates upstream mechanisms against the 8 required failure and concurrency scenarios identified in annex-2.

### 3.1 Candidate A: v2 Durable Inbox + Execution Lifecycle + Drain Barrier (v2.0.32)

| # | Scenario | Verdict | Why |
|---|---|---|---|
| 1 | Concurrent Send-now prompts sharing a runner | **covered** | Both admitted durably (`inbox.enqueued` with distinct `inboxID`s); run-coordinator doorbell coalesces them into the busy period; exactly one terminal "covers every coalesced drain" (`execution.ts` settled hook). Correlation is established by `seq` order, not a per-dispatch field. |
| 2 | Changed `lastUser` mid-run | **covered** | No folding-by-`lastUser` in v2: explicit inbox ordering replaces the V1 `parentID` mechanism; each dispatch is tracked by its durable `inboxID` through `inbox.delivered`. |
| 3 | Terminal failure BEFORE any assistant message | **covered** | `settled` publishes `session.execution.failed {error}` for every exit including pre-step failures; fully durable. Closes the 1.x gap. |
| 4 | Busy interval entirely missed by observer | **covered** | Terminal event is persisted in the durable per-session log; client catches up via `session.log?after=<seq>`. Observation outages cannot erase the terminal witness. |
| 5 | Reconnect after connection loss | **covered** | Replayable via cursor stream (`after` = last seen sequence number per session). |
| 6 | Daemon restart (evidence recoverable after restart) | **covered** *(with disclosed caveat)* | Write-ahead claim, inbox rows, and event log are SQLite-durable. A surviving claim without a terminal indicates an in-flight turn during crash; next OpenCode start resumes the turn (shutdown-interruption preserves claim); resumed turn's terminal covers the dispatch. On vh-solara daemon restart alone: replay from cursor. *Caveat:* If OpenCode is SIGKILLed and never restarted, state remains visibly "claimed, unterminated" — an honest indefinite hold, not a false release. |
| 7 | Multi-step runs (steps complete, run continues) | **covered** | Terminal observation is per-busy-period, not per-step; intermediate `session.step.ended` events do not prematurely terminate execution. |
| 8 | Descendants running when root's step ends | **partial** *(per-session scope by design)* | Executions are per-session aggregates; subagents own distinct sessions and event streams (`subagent-job.ts`, `subagent-completion.ts`). Root session terminal does not equal tree terminal; whole-tree release requires composing durable per-session terminals over the session tree topology. This remains the vh-solara daemon's job (which already models subtree busy), now backed by durable per-node evidence. Upstream does not provide a single tree-wide terminal event. |

- **Restarts:** Durable via SQLite `EventTable` successor, `SessionInboxTable`, and claim table. A restarted vh-solara daemon reconstructs "dispatch X terminated" from cursor log replay; a restarted OpenCode resumes claimed turns.
- **Client surface:** `POST session.prompt {id, delivery}` (durable admission ack; HTTP 409 on ID conflict) → consume `session.log?after&follow` (or global SSE with log catch-up on reconnect) → discharge obligation when the first execution terminal lands at `seq > inbox.delivered.seq` AND no pending inbox item with `seq <= mine` remains. `session.wait` is available as an explicit await-idle barrier.

### 3.2 Candidate B: v1.18.14 Sync `prompt` Endpoint + Durable Message-Event Log (Best 1.x Composite)

| # | Scenario | Verdict | Why |
|---|---|---|---|
| 1 | Concurrent Send-now sharing a runner | **covered** | `prompt` handler awaits `prompt()`; `ensureRunning` awaits shared runner `done` (`runner.ts`); HTTP reply returns after the shared run completes. |
| 2 | Changed `lastUser` mid-run | **covered** *(via sync reply)* | Awaited reply does not rely on `parentID` attribution — runner unblocks all joiners on run completion. (Durable log alone would fail due to `lastUser` folding.) |
| 3 | Pre-assistant terminal failure | **covered** *(via sync reply)* | `prompt()` failure routes to HTTP 400; error response is terminal. Durable log records nothing (terminal evidence lost if response dropped). |
| 4 | Busy interval missed by observer | **not-covered** | Receipt exists only as the active HTTP response; nothing durable marks the run boundary. Durable log contains registration and step completions, but no run-end event. |
| 5 | Reconnect after connection loss | **not-covered** | Dropped connection loses the receipt; no replayable terminal exists. |
| 6 | Daemon restart | **not-covered** | No durable terminal or claim; user message is durable, but run outcome is not recoverable. |
| 7 | Multi-step runs | **covered** *(via sync reply)* | Synchronous reply waits for complete execution loop. |
| 8 | Descendants outlive root step | **partial** | Synchronous reply covers the root session run only; descendant turns are unobservable in the reply; whole-tree composition from status/idle events remains heuristic. |

---

## 4. Adoption Implication

Adopting the v2 barrier contract is a **major version migration**, not an incremental upgrade:

1. **Surface mismatch:** The existing vh-solara integration is built entirely against OpenCode 1.x conventions: asynchronous prompt dispatch (`prompt_async`), `message.updated` SSE events, and the 1.x SQLite schema (`pkg/opencode/db.go`).
2. **Upstream changes in v2:** OpenCode 2 replaces the protocol API (new `@opencode/protocol`), event taxonomy (`session.execution.*`, `session.inbox.*`), prompt invocation semantics (`session.prompt` with caller IDs and `delivery: steer|queue`; `prompt_async` removed), and SQLite database layout.
3. **Internal coupling:** Migrating requires rewriting or updating:
   - Client and proxy dispatch logic (`pkg/opencode/client.go`).
   - Reducers and event consumers (`pkg/state/reducers.go`, `pkg/aggregator/`).
   - The test fixture backend (`pkg/fixtures/opencode.go`).
   - The unarchive database patch (`pkg/opencode/unarchive*`).
4. **Tag pinning:** The earliest 2.x tag providing the complete barrier contract is not yet pinned (2.0 GA occurred ~Oct 12–14, 2026; `v2.0.32` verified).

**Disposition:** Evaluating and executing an OpenCode 2 migration is an operator product decision that is explicitly **out of scope** for task card `queue-idle-gate-send-now`.

---

## 5. Corrections to Annex-2

Annex-3 supersedes annex-2 **strictly on upstream-source facts**. The release-rule logic and decision frame established in annex-2 and the parent decision memo remain unchanged.

1. **Completeness of v1.18.14 event-sourcing record:**
   - *Annex-2 statement:* Annex-2 §1 concluded that OpenCode v1.18.14 had "no durable per-dispatch terminal watermark" based on inspecting `status.ts` and `session-status-event.ts`.
   - *Correction:* While that negative conclusion stands for the inspected status surfaces, annex-2 missed the underlying durable event-sourcing layer present at `v1.18.14`: `packages/core/src/event.ts` (`EventTable`, `EventSequenceTable` with per-aggregate `seq` and cursor replay), `packages/opencode/src/httpapi/handlers/sync.ts` (history catch-up), and durable `message.updated`/`part.updated` definitions in `packages/schema/src/v1/session.ts`.
   - *Impact:* The outcome for the 1.x line remains **`NOT_AVAILABLE`** (no execution boundary events, no admission barrier, non-durable `session.error`, `lastUser` folding persists), but the upstream evidence record is now complete and corrected.
2. **Canonical upstream repository identity (Advisory F3 resolution):**
   - *Annex-2 context:* Annex-2 cited source files under `github.com/anomalyco/opencode`. During review, advisory finding F3 questioned whether `anomalyco` represented an unvetted fork rather than canonical upstream `sst/opencode`.
   - *Correction:* Direct inspection confirmed that `github.com/sst/opencode` redirects to `github.com/anomalyco/opencode` following an upstream organization transfer. Both URLs resolve to the exact same git commits and tags. Annex-2's links cited canonical upstream content. Advisory F3 is formally resolved.

---

## 6. Decision Consequence for Task Card `queue-idle-gate-send-now`

1. **Slice S4 Remains Gated OFF:**
   - Under the authorized slice order (`researches/decisions/2026-10-27-queue-dispatch-release-rule.md` §Authorized slice order) and the O3 debate gate, slice S4 (frontend schema-2, U5 composer controls, and `dispatchPolicy: now|queue`) remains dormant.
   - Because a validated terminal witness exists only behind an OpenCode 2 major-version migration, the repository cannot satisfy the O3 gate within its current 1.x deployment posture.
2. **Operator Follow-up Options:**
   - **Option A (v2 migration track):** Author a dedicated task card to evaluate and map the OpenCode 2 migration (earliest 2.x tag-walk, protocol mapping, SQLite schema changes, fixture rewrite).
   - **Option B (product memo amendment):** Operator issues an explicit decision memo amendment authorizing U5 composer controls and `dispatchPolicy` on the behavior-grade interim gate (EX) without obligation machinery. *Note:* This path was rejected by the O3 debate pass and requires an explicit operator directive.
   - **Current card posture:** Task card `queue-idle-gate-send-now` takes neither option; it completes slice S3 and retains the O3 gate for S4.

---

## 7. Findings, Contradictions, and Evidence Tier

### Structured Findings

- **(finding)**: source=sst/opencode v2.0.32 `packages/core/src/session/execution.ts` (`settled` wiring, `claimOnCommit`), confidence=high, type=fact — exactly one durable terminal per busy period (`session.execution.succeeded|failed|interrupted`) covering every coalesced drain; write-ahead claim committed atomically with `execution.started`; shutdown-interruption preserves the claim for turn resume at next server start.
- **(finding)**: source=v2.0.32 `run-coordinator.ts`, confidence=high, type=fact — doorbell/drain barrier: admitted work rung during an execution forces another drain before settle; `settled` completes before waiters resolve.
- **(finding)**: source=v2.0.32 `inbox.ts` + `schema/session-event.ts`, confidence=high, type=fact — durable FIFO inbox with caller-supplied inboxID (= messageID), transactional pending-row projection, `inbox.delivered` removal in the same transaction.
- **(finding)**: source=v2.0.32 `server/src/handlers/session.ts`, confidence=high, type=fact — `session.prompt` accepts caller `id` + `delivery`, 409s on durable-ID conflict; `session.log` supports `after` cursor + `follow`; `session.wait` exists.
- **(finding)**: source=v1.18.14 `packages/core/src/event.ts` + `schema/src/v1/session.ts` + `handlers/sync.ts`, confidence=high, type=fact — a durable per-session event log (per-aggregate seq, replay streams, HTTP history catch-up) ALREADY exists at the pinned tag; durable: `message.updated` (user+assistant full info), `message.part.updated`, session lifecycle; `session.error` and `session.idle`/`status` are NOT durable.
- **(finding)**: source=v1.18.14 `handlers/session.ts` + `effect/runner.ts`, confidence=high, type=fact — sync `prompt` awaits the full run (joiner semantics); `prompt_async` returns 204 before persistence; V1 folding is by `lastUser` (no inbox).
- **(inference)**: source=v2.0.32 `runner/prompt/` NOT read, confidence=medium-high — the drain loop continues across queued items within a busy period until no promotable input remains (coordinator contract + `execution.ts` comment imply it; exact continuation check unread). Even if each queued item got its own execution, the ordered log still supports the composite discharge rule.
- **(inference)**: source=release notes + press + package diffs, confidence=medium — the 1.x line (through v1.19.3) does not receive the v2 engine; feature work is 2.x-only.
- **(assumption)**: vh-solara adoption of v2 is a major migration (protocol/DB/fixtures/events) — grounded in this repo's current v1-shaped surfaces, not an upstream claim.

### Contradictions

1. **Annex-2 §1 vs. upstream event log (material, verdict-preserving at 1.x):** Annex-2 reported "no durable per-dispatch terminal watermark" based on status interfaces. It missed the durable event log at `v1.18.14` (`core/event.ts`). The 1.x outcome (`NOT_AVAILABLE`) stands, but the evidentiary basis is corrected.
2. **Task framing vs. observed repository identity:** The instruction assumed `anomalyco/opencode` might be a fork mirror; direct inspection proved it is the post-transfer canonical repository (`sst/opencode` redirects to it).
3. **Stale release cache vs. live feed:** Cached HTML showed `v1.0.207` as latest; live atom feed and tag inspection confirmed `v2.0.32`.
4. **Orientation docs vs. pinned source:** External helper documentation describes the v2 dev tree; all load-bearing claims were verified against pinned tag reads.

### Evidence Tier and Disclosure

- **READ (13 files at v1.18.14):**
  - `packages/opencode/src/session/status.ts`
  - `packages/opencode/src/session/run-state.ts`
  - `packages/opencode/src/effect/runner.ts`
  - `packages/opencode/src/httpapi/handlers/session.ts`
  - `packages/opencode/src/httpapi/handlers/event.ts`
  - `packages/opencode/src/httpapi/handlers/sync.ts`
  - `packages/opencode/src/session/event-v2-bridge.ts`
  - `packages/core/src/event.ts` (first ~60%)
  - `packages/schema/src/v1/session.ts` (full)
  - `packages/schema/src/session-event.ts` (full)
  - `packages/schema/src/durable-event-manifest.ts`
  - `packages/opencode/src/session/prompt.ts` (first ~45%)
  - `packages/opencode/src/session/processor.ts` (majority)
- **READ (9 files at v2.0.32):**
  - `packages/core/src/session/run-coordinator.ts` (full)
  - `packages/core/src/session/inbox.ts` (~85%)
  - `packages/core/src/session/execution.ts` (full)
  - `packages/schema/src/session-event.ts` (full)
  - `packages/core/src/session/prompt.ts` (full)
  - `packages/server/src/handlers/session.ts` (full)
  - `packages/server/src/handlers/event.ts`
  - `packages/server/src/event-feed.ts`
  - `packages/server/src/runner/index.ts` (interface)
- **NOT Read / Inferred (Disclosed Gaps):**
  - v2 `runner/prompt/` drain internals.
  - `session.prompt` service return shape.
  - `session.log` wire framing.
  - `store.claim` / `store.release` implementation details.
  - v1.18.14 `prompt()` / `runLoop` function bodies (truncated read; corroborated by route handlers and prior v1.17.18 packet).
  - Individual release notes for `v1.18.15` through `v1.19.0`.
  - Earliest 2.x tag containing the full barrier contract.
- **Verification tier:** Static tag-pinned source study only; no runtime execution verification performed.
