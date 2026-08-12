# Part-Stream Suffix Axis — durable spec & decision record

> **This is the durable, committed home** for the O(L²)→O(L) suffix-streaming
> axis of the part-streaming redesign. It was promoted verbatim from the working
> scratch brief at `tmp/agent-runs/part-stream-redesign-brief/brief.md`, which
> produced it 2026-08-12 via a `/solution-brief` (researcher → debate → planner
> chain, read-only; medium confidence). The wire-protocol CONTRACT that
> implemented this decision lives in
> [`part-append-streaming.md`](./part-append-streaming.md). See "Decision
> outcome" below.

## Decision outcome (2026-08-12)

**The suffix-axis decision SHIPPED.** Negotiated seq-stamped `part.append`
suffix frames for the `text`/`reasoning` allowlist (behind the `part_delta=1`
capability) were implemented across slices 2–4, with the load-bearing
O(L²)→O(L) wire-cost crux demonstrated at commit `90dfd40`
(`pkg/state/part_append_linearity_test.go` — opted-in ≈ 1.70×L vs legacy
33→65→129×L; legacy/opted-in ratio 75.9× at 32 KiB). Source suffixing was
necessary AND sufficient to remove O(L²): the daemon never saw SSE backpressure
(`slow_writes=null`, max 653µs), so neither relay batching nor FE rendering
could substitute.

- Slice 1 (`1af062c`): protocol contract + delta-path telemetry.
- Slice 2 (`d61ed44`): negotiated suffix source + ring representation.
- Slice 3 (`d49b4eb`): FE suffix application + repair.
- Slice 4 (`90dfd40`): linearity proof + slow-reader recovery + FE post-drain
  gen-recheck.
- Slice 4A (`cb1f826`): compaction-burst telemetry + incident fixture — sibling
  axis; see [`compaction-burst-axis.md`](./compaction-burst-axis.md).
- Slice 6 (`f65db77`): compaxis O1 decision record + docs.

The compaction-burst sibling axis is closed separately at O1 (no-change); see
[`compaction-burst-axis.md`](./compaction-burst-axis.md).

The remainder of this document is the promoted brief content (question, verified
facts, decision, Q1–Q4 resolutions, phased plan, remaining uncertainties,
provenance) — preserved so the reasoning behind the suffix-axis design remains
auditable.

---

# Part-Stream Delivery Redesign — Solution Brief

**Produced:** 2026-08-12 via `/solution-brief` (researcher → debate → planner chain, read-only).
**Question:** Live token streaming to the SPA degrades under load — text arrives in large slow lumps and can appear stuck for over a minute with no self-heal until a manual reload — and the delivery path has a structural O(L²) wire cost. What is the best redesign of the part-streaming delivery path (and its failure-recovery story), considering the whole chain: store egress → SSE → controller tunnel relay → browser apply/render?
**Confidence:** medium.
**Draft task card:** `.local/coordinator/tasks/task-2026-08-11t16-56-14-linear-part-delta-frames-kill-o-n2-streaming-wire-cost.json` (status `draft` — NOT ready; not promoted by this brief).

## Verified facts (from live incident investigation 2026-08-11 — trust; re-verify if something looks off)

- The store accumulates `message.part.delta` server-side and each throttled flush (`deltaFlushInterval=30ms`, `pkg/state/store.go:1633`) emits `KindPartUpsert` carrying the ENTIRE accumulated part text (`flushPartDeltasLocked`, `pkg/state/reducers.go:~1350-1417`). Wire bytes per part are O(L²) over its lifetime; `partTextCap=1MiB`; live frames are raw JSON (only snapshots are gzip64).
- Incident session `ses_00fb2defcffed6hfrLInqG6oCL` streamed in large lumps, then looked stuck >60s; manual reload was instantly current. Largest part ~41KB (390 parts / 1.3MB total) — so the failure needs no monster part.
- Daemon exonerated: `/vh/diag/latency` showed `slow_writes=null` (no SSE write ever blocked, max 653µs), `subscriber_drops=6` lifetime, daemon journal silent. Backlog formed DOWNSTREAM.
- No existing self-heal covers a late-but-flowing stream: 60s status-reconcile fixes stuck-idle only; `STALE_MS=45s` needs pings absent; `CONTENT_STALE_MS=120s` needs zero content and lumps keep resetting it.
- Reconnects rarely resume: 715 of 727 `selected_session` opens took the full-snapshot path (~170KB avg), only 12 cursor replays. (Qualifier: includes intentional first-opens/session-switches; does not by itself prove retry replay is broken.)

### Researcher findings (re-verified against source)
- Append accumulation is internally linear, but every eligible flush reconstructs and emits the complete accumulated field as `part.upsert` → O(L²) bytes across source, ring, and live SSE.
- Immediate first-delta flushing, then 30ms throttle — confirmed.
- Global 4096-event sequence ring; stale-cursor snapshot fallback; 256-event per-stream subscriber channel; no existing semantic per-connection conflation queue.
- Controller/worker tunnel uses raw `io.Copy`; backpressure eventually exists, but layered TCP/yamux/WebSocket buffers can hide it from daemon SSE timing.
- Markdown painting already coalesced ~5fps, but JSON parse and reactive full-field assignment still run per frame before that optimization.
- Delta translator supports arbitrary top-level fields; no evidence that nested tool output (e.g. `state.output`) is delivered through the same append-delta path — needs confirmation before extending.
- Existing `z=1` negotiation establishes query parameters as the appropriate capability surface.
- `/vh/diag/latency` already exposes part-class byte counts and relevant SSE/yamux/copy observations.
- Candidate sketch `tmp/part-stream-linear-delta-brief.md` is MISSING. `docs/ai/codebase-operational-primitives.md` is MISSING (doc gap). `.local/cleared-assumptions.yaml` is MISSING.

### Contradictions / qualifications vs the prompt
- Current code has a 120s no-content recovery path, but late lumps reset it and can still evade recovery indefinitely.
- Relay backpressure is delayed, not literally absent.
- The 715/727 snapshot count includes intentional first opens/session switches and does not by itself prove retry replay is broken.

## Constraints (hard)
- FE merge semantics (merge-if-absent, upgrade-on-completed) must survive unchanged; snapshot/cold-load formats (`messages.batch`, gzip64) are OUT OF SCOPE.
- Old/non-SPA clients must keep working (negotiation; one encoding per connection, not dual-emit).
- First-token latency must stay instant (the first delta of a burst flushes immediately today).

## Candidate (NOT pre-decided — adjudicated)
Linear accumulable state per (part, field): suffix frames `{part, field, start, text}` (appends are always at-end so `(part,field,len)` is complete state; add `start,len` ranges only if non-append writes appear), per-connection egress conflation by concatenation (backlog == unsent suffix), offset mismatch → fall back to existing full `part.upsert` repair.

## Decision (medium confidence)

Adopt a **negotiated end-to-end suffix protocol**: seq-stamped `part.append {sessionID, messageID, partID, field, start, text}` frames for proven append-only top-level fields, frame-batched frontend application, authoritative `part.upsert` repair. **Source suffixing is necessary and sufficient to remove O(L²)** — neither relay backpressure nor FE batching can substitute for it, since the daemon never saw backpressure and the cost is generated upstream of any queue. Bounded failure reuses the existing subscriber-close + cursorless snapshot repair; suffix-aware egress conflation is **gated behind a slow-reader test**, not built upfront. Relay stays protocol-agnostic unless instrumentation proves its buffering prevents timely failure propagation.

## Resolution of the four load-bearing questions

### Q1 — Decomposition (necessity vs sufficiency)
| Lever | Verdict |
|---|---|
| Bytes-at-source suffix frames | **Necessary + primary.** Only lever that removes O(L²). |
| Per-connection egress conflation | **Conditional.** Existing 256-event subscriber channel already closes slow readers → snapshot. Add conflation only if slow-reader test shows drop-and-repair causes unacceptable lag/churn. |
| Relay backpressure propagation | **Separate follow-up; cannot fix O(L²).** Raw `io.Copy`; TCP/yamux/WS buffers hide backpressure from daemon timing. |
| FE apply/render batching | **Complementary.** Reduces render cost (per-frame JSON parse + reactive SET before the ~5fps paint coalesce), not wire cost. |

### Q2 — Ring / Last-Event-ID resume
Seq-stamp `part.append` frames **into** the existing 4096-event ring. Resume incrementally when `currentFieldLen == start`. On offset mismatch / overload / excessive event age → **cursorless authoritative snapshot**. A legacy connection whose replay range is suffix-only takes a snapshot rather than mixed replay (legacy must never interpret a frame it cannot decode).

### Q3 — Non-text / tool-output
**Start text + reasoning top-level fields only.** Tool status, nested `state.output`, completion, non-append mutation, and all repair stay full `part.upsert`. Open: confirm whether nested tool output (`state.output`) flows through the append-delta path today (no evidence found).

### Q4 — Rollout & measurement
Query capability `part_delta=1` (mirrors `z=1`). **Legacy = full upsert, NOT dual-emit on one connection.** Server canary + client kill switch (drop capability → force snapshot/full-upsert). Start text/reasoning fields only.
- **Success metric:** `/vh/diag/latency` part-class bytes scale linearly with final text length.
- **Slow-reader test:** bounded queue state, bounded lag or deterministic disconnect on overload, automatic snapshot repair, no manual reload.

## Phased plan (planner)

1. **Instrumentation + protocol contract** — append-offset semantics, `part_delta=1` capability, event-age/repair rules, `(part.type,field)` telemetry, part-class byte baselines, 10-min incident capture procedure.
2. **Negotiated source + ring representation** — emit seq-stamped suffix for allowlisted append-only fields; keep immediate first flush; keep legacy full-upsert encoding.
3. **FE application + repair** — validate UTF-8 byte offsets, one reactive update per frame, preserve object identity + merge/completion ordering, cursorless reconnect on mismatch/age.
4. **Slow-reader recovery proof** — linear part bytes, bounded queue, bounded lag or deterministic disconnect, auto snapshot repair, no manual reload.
5. **Gated egress conflation** — only if Slice 4 proves drop-and-snapshot inadequate.
6. **Relay policy follow-up** — only if tunnel evidence identifies relay buffering as a continuing wedge source.

## Acceptance evidence
`/vh/diag/latency` must show part-class bytes scaling linearly with final text length. Tests must cover: immediate first suffix, contiguous resume, offset mismatch, unsupported legacy replay, slow-reader overload, cursorless repair, unchanged merge semantics, and existing `pkg/state`, `pkg/web`, web unit, and relevant web e2e suites green.

## Remaining uncertainty (explicit)
1. Whether the incident backlog was predominantly in tunnel/controller buffering or browser parsing/reactive application. **Instrumentation procedure for next occurrence:** DevTools `/vh/stream` frame arrival times/sizes/gaps + in-app diagnostics + `/vh/diag/latency` within ~10 min; inspect controller/yamux/WebSocket queued bytes, blocked writes, copy progress. Frames arriving promptly but applying late → browser; delayed DevTools arrival with advancing relay queues → relay.
2. Actual `(part.type, field)` combinations emitted as deltas, especially tool-related output.
3. Whether subscriber-close + snapshot repair is operationally sufficient, or suffix-aware conflation is needed.
4. Appropriate byte-, age-, and reconnect-rate bounds; no evidence supports an arbitrary threshold yet.
5. Ring retention duration after replacing fewer large upserts with potentially more small suffix events.
6. Exact controller/yamux/WebSocket buffering limits and where blocked-write observability is currently available.

## Provenance
- Source: `/solution-brief` chain (researcher → debate → planner), dispatched by coordination session 2026-08-12.
- Incident evidence: `/vh/diag/latency` (slow_writes=null, subscriber_drops=6, 715/727 snapshot vs 12 replay); incident session parts max ~41KB, 1.3MB total.
- Candidate origin: operator sketch (explicitly NOT pre-decided).
- Draft card: `.local/coordinator/tasks/task-2026-08-11t16-56-14-linear-part-delta-frames-kill-o-n2-streaming-wire-cost.json`.

---
