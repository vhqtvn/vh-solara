# Compaction-Burst Axis — durable spec & decision record

> **This is the durable, committed home** for the compaction-burst axis of the
> part-streaming redesign. It was promoted verbatim (lightly cleaned) from the
> working scratch brief at `tmp/agent-runs/compaction-burst-brief/brief.md`,
> which produced it 2026-08-12 via a focused read-only `/solution-brief`
> (researcher → debate → planner). The O(L²) suffix axis is settled separately
> — see `docs/ai/wire-protocols/part-append-streaming.md` §1–§2 (the O(L²)
> suffix-axis contract) and the promoted decision record
> `docs/ai/wire-protocols/part-stream-suffix-axis.md`. The decision recorded
> here is **O1 (no-change)**; see "Decision outcome" below.

## Decision outcome (2026-08-12)

**The compaction-axis decision is O1 (no-change), gate-forced — NOT a judgment
call.** The leading conditional mechanism (O2, exact no-op suppression at
authoritative ingress) cannot be honestly selected now because its load-bearing
gate is unsatisfied.

- **a-F2 hard gate (independently flagged by round-1 review, round-2 review,
  committer review, AND the brief):** O2 (ingress no-op suppression) requires
  real production telemetry of the identical-vs-changed split. None exists
  (slice 4A's fixture is synthetic; the real duplicate composition is unknown).
  → O2 cannot be honestly implemented now.
- **Slice 4A characterization:** a single incident-sized ~226KB compaction
  burst has NO measurable healthy-link impact (completed-message settle
  15–30µs; subscriber high-water 13–16 ≪ 256-event buffer). Overflow requires
  ~7× the incident volume (343 events) + a blocked writer. → the egress-
  optimization gate (slice 5) is NOT triggered.
- **Conclusion:** retain authoritative FIFO delivery; no ingress suppression
  (4C), no egress optimization (5). The compaction burst remains a **TRIGGER
  CANDIDATE**, not a reducible duplicate burst. The 4A telemetry
  (`/vh/diag/latency` `probes.part_upsert_burst`) is deployed to capture real
  composition on the next incident.
- **Future O2 stays CONDITIONAL** on production evidence of material duplicates
  + measured improvement. Until that evidence lands, O1 is the standing
  decision; reopen via the slice-4B decision-gate procedure only if a real
  incident shows a material identical-fraction AND a measured settle/latency
  regression that suppression would fix.
- **The actual Report-2 wedge fix remains the PARKED relay/browser attribution**
  (capture procedure in `part-append-streaming.md` §7). Successful compaction
  handling must NOT be reported as proof the relay/browser wedge is cured.

The remainder of this document is the promoted brief content (decision context,
mechanism analysis, sequencing, measurement plan, remaining uncertainties,
contradiction audit, provenance) — preserved so the reasoning behind the O1
outcome and the future-O2 conditional remains auditable.

---

# Compaction-Burst Axis — Solution Brief

**Produced:** 2026-08-12 via focused `/solution-brief` (researcher → debate → planner, read-only), scoped to the compaction-burst axis only. The O(L²) suffix axis is settled — see `docs/ai/wire-protocols/part-stream-suffix-axis.md`.
**Question:** How should the part-streaming redesign handle compaction-sweep bursts (many historical TOOL parts re-upserted in a short window) on the selected-session stream — and is egress handling even the right lever, given the observed burst should not have wedged a healthy link?
**Decision:** `need_evidence` (medium confidence).
**User context:** User chose (c) to broaden the task into one cohesive effort. This brief honors that but honestly finds the compaction axis is measurement-gated, not committed implementation.

## Headline finding (honest)
**Compaction-egress handling is NOT the Report 2 wedge cure.** It is a secondary trigger-reduction lever. The primary wedge fix remains the PARKED relay/browser attribution. Evidence: the ~80-event burst was well below the 256-event subscriber channel (no mechanical overflow), far below the 4096-event ring, no daemon-side write stall, and 226KB should not wedge a healthy link >60s. Successful compaction handling must NOT be reported as proof the relay/browser wedge is cured.

## Q1 — Is compaction-egress the right lever?
Secondary trigger-reduction, NOT the wedge cure. Primary track = relay/browser delivery attribution + repair (parked; capture procedure in slice-1 spec `docs/ai/wire-protocols/part-append-streaming.md` §7). Compaction work is justified only if it cheaply eliminates demonstrably redundant authoritative traffic. Decision must rest on the synthetic fixture + duplicate measurements, not temporal correlation.

## Q2 — Mechanism
**No behavior selected yet.** Leading CONDITIONAL mechanism = **O2: exact no-op suppression at authoritative ingress** — suppress byte-identical unchanged TOOL-part re-upserts BEFORE sequence assignment. Safer than egress reordering: preserves monotonic sequence/ring/cursor/replay semantics; no client capability needed (no observable transition removed).

**REJECTED mechanisms** (all break the ordering contract or don't fit the many-distinct-part sweep):
- Generic per-key egress conflation (many distinct keys; complicates cursor/replay).
- Burst smoothing / rate-limit (prolongs backlog; worsens settle latency; ordering redesign with priority).
- Priority / deprioritize historical vs live (advancing past deferred authoritative events incompatible with monotonic sequence).
- Snapshot-window collapse (no compaction marker; comparable size; disrupts live-tail; protocol/client changes).
- Defer-until-idle (completion IS the post-rewrite transition; breaks ordering).
- Byte/age overload disconnect (later containment study only).

## Q3 — Sequencing (one cohesive plan)
Insert compaction work as Slice 4A/4B/4C between existing Slice 4 and Slice 5. Does NOT delay the O(L²) fix (slices 2-4 ship first):
1. Slice 1 — DONE (protocol + delta-path telemetry).
2. Slice 2 — suffix source generation.
3. Slice 3 — FE suffix application + batching.
4. Slice 4 — slow-reader proof + egress gate.
5. **Slice 4A — compaction telemetry + incident-shaped fixture.**
6. **Slice 4B — MANDATORY decision gate** (rerun researcher→debate with 4A measurements).
7. **Slice 4C — conditional**: implement O2 ONLY if gate passes; else retain O1 (no change).
8. Slice 5 — gated egress optimization (informed by measured residual traffic).
9. Slice 6 — rollout, compatibility, docs, closure.

## Slice 4A detail — Upsert observability + burst proof
Telemetry to add (separate from slice 1's delta-path probe): rolling-window authoritative `part.upsert` event count; serialized bytes; TOOL subset count/bytes; distinct part count; exact post-cap identical count/bytes; changed count/bytes; selected-stream queue high-water (events + estimated bytes); queue residence / emit-to-write duration by event class; completed assistant `message.upsert` emit-to-SSE-write latency; live `part.append` max inter-write gap during burst; subscriber closure/recovery reason. (No transcript content / part IDs / session IDs in diagnostics.)

Incident-shaped fixture: ~30 historical messages; 49 TOOL-part updates; ~226KB total; ~28KB max; ~30 interleaved `message.updated`; concurrent first + continued live suffix frames; final completed assistant message. Variants: (1) mostly byte-identical TOOL updates; (2) materially changed; (3) healthy writer; (4) modestly delayed; (5) slow writer exercising overflow/recovery.

Primary settle marker = the **completed assistant message frame's emit-to-SSE-write latency**, NOT generic tree activity-idle (different stream path).

## Q4 — Measurement (distinct from O(L²) linearity)
- **Healthy-link proof:** bounded completed-message emit-to-SSE-write latency; no subscriber disconnect; live suffix max inter-write gap within baseline; first suffix not delayed; all changed TOOL updates in source order.
- **Slow-reader/recovery proof:** overload → documented close/replay/snapshot; reconnect reaches authoritative current state without manual reload; no silent omission of changed updates.
- **O2-specific proof (before selecting O2):** exact-identical count/bytes material; suppression measurably reduces completion-write latency / suffix gap / queue residence / burst bytes; comparison cost doesn't regress changed-case; first-token latency unchanged.
- Establish repository baseline first; use predeclared baseline-relative acceptance threshold (not arbitrary ms; not "statistically significant" unless enough reps).

## Remaining uncertainties
1. Duplicate composition (byte-identical vs metadata-different vs materially changed) — UNKNOWN, the load-bearing fact for O2.
2. Actual queue residence (completed-frame wait between store emit and SSE write).
3. Browser arrival timing (daemon write success ≠ browser receipt).
4. FE contribution share of the >60s failure.
5. Settle-signal semantics (completed-message delivery vs tree activity-idle use DIFFERENT stream paths — don't collapse them).
6. O2 comparison cost for the changed-update case.
7. No reliable protocol-level compaction marker (policies depending on a complete "sweep window" are unsupported).

## Contradiction audit
No contradiction with the settled suffix design in the recommended path (preserves `part.append` for text/reasoning only; TOOL rewrites on authoritative upsert; monotonic sequence + ring order; cursorless snapshot repair; unchanged FE merge semantics + cold-load/snapshot formats + legacy behavior). Rejected alternatives WOULD conflict with the ordering contract.

## Provenance
- Source: focused `/solution-brief` (researcher→debate→planner), dispatched 2026-08-12.
- Evidence: user-verified opencode.db reconstruction (addendum `tmp/part-stream-linear-delta-brief.md` lines 59-87).
- Settled context: `docs/ai/wire-protocols/part-stream-suffix-axis.md` (O(L²) axis).
