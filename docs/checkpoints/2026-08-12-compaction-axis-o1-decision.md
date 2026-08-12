# 2026-08-12 — Compaction-axis O1 (no-change) decision record

## Summary

The compaction-burst axis of the part-streaming redesign is closed at **O1
(no-change)**: retain authoritative FIFO delivery of `part.upsert`; implement
neither O2 (ingress no-op suppression, slice 4C) nor the slice-5 egress
optimization. This is a **gate-forced** outcome, not a judgment call — the
leading conditional mechanism (O2) cannot be honestly selected because its
load-bearing evidence gate is unsatisfied.

This checkpoint records the decision, the reasoning, what was measured, what
remains unknown, and the track status so a future session can reopen the
question correctly only if new evidence lands.

## The decision

**O1 (no-change).** The compaction burst remains a TRIGGER CANDIDATE, not a
reducible duplicate burst.

## Gate-forced reasoning

1. **a-F2 hard gate (independently flagged by round-1 review, round-2 review,
   committer review, AND the compaction brief):** O2 (ingress no-op
   suppression) requires real production telemetry of the identical-vs-changed
   split. None exists — slice 4A's fixture is synthetic, and the real duplicate
   composition of the observed incident is unknown. → O2 cannot be honestly
   implemented now.
2. **Slice 4A characterization:** a single incident-sized ~226KB compaction
   burst has NO measurable healthy-link impact (completed-message settle
   15–30µs; subscriber high-water 13–16 ≪ the 256-event buffer). Overflow
   requires ~7× the incident volume (343 events) + a blocked writer. → the
   egress-optimization gate (slice 5) is NOT triggered.

## What was measured (slice 4A)

- A synthetic incident-shaped fixture (~30 historical messages, 49 TOOL-part
  updates, ~226KB total, ~28KB max) plus controlled variants (byte-identical vs
  materially changed; healthy vs delayed vs slow writer). See
  `pkg/state/part_upsert_burst_fixture_test.go`.
- Healthy-link settle: completed-message emit-to-SSE-write latency 15–30µs;
  no subscriber disconnect; subscriber high-water 13–16 events (well under the
  256-event channel and the 4096-event ring).
- Overflow requires ~7× the incident volume (343 events) AND a blocked writer.

## What remains unknown

- **Real duplicate composition** (byte-identical vs metadata-different vs
  materially changed) — the load-bearing fact for any O2 decision. CANNOT be
  resolved by a synthetic fixture; needs real production capture.
- Actual queue residence (completed-frame wait between store emit and SSE write).
- Browser arrival timing (daemon write success ≠ browser receipt) and the FE
  contribution share of the >60s failure — these belong to the relay/browser
  track (§7), not the compaction axis.

## Future-O2 conditional

O2 stays **CONDITIONAL**. Reopen via the slice-4B decision-gate procedure only
if a real incident shows (a) a material identical-fraction in the deployed
`part_upsert_burst` probe AND (b) a measured settle/latency regression that
suppression would fix. Until then, O1 is the standing decision.

## Track status

- **Compaction axis (this record):** CLOSED at O1. Deployed measurement vehicle:
  `/vh/diag/latency` `probes.part_upsert_burst` (bounded upsert-path burst
  characterization, `pkg/diagnostics/part_upsert_burst.go`).
- **Relay/browser attribution (the actual Report-2 wedge fix):** PARKED. Capture
  procedure lives in `docs/ai/wire-protocols/part-append-streaming.md` §7.
  Successful compaction handling must NOT be reported as proof this wedge is
  cured.
- **O(L²) suffix axis:** settled separately; contract in
  `docs/ai/wire-protocols/part-append-streaming.md`.

## Where the decision is recorded durably

- This checkpoint.
- `docs/ai/wire-protocols/compaction-burst-axis.md` — promoted brief + "Decision
  outcome (2026-08-12)" header.
- `docs/ai/wire-protocols/part-append-streaming.md` §8 — compaxis decision
  cross-reference + summary.

## Findings

- **Compaction-egress is NOT the Report-2 wedge cure:** source=slice-4A brief +
  measurements, confidence=high, type=fact. It is a secondary trigger-reduction
  lever; the primary wedge fix is the parked relay/browser attribution.
- **O2 is gate-blocked, not judgment-rejected:** source=a-F2 (review consensus)
  + 4A characterization, confidence=high, type=fact. The mechanism is sound but
  its evidence gate (real duplicate composition) is unsatisfied.
- **Single incident burst has no measurable healthy-link impact:** source=slice-4A
  fixture measurements, confidence=high, type=fact (for the synthetic
  incident-sized shape; real composition remains unknown).
- **Future O2 is conditional on production evidence:** source=decision outcome,
  confidence=medium, type=inference (depends on a future incident exhibiting the
  gating conditions).

## Contradictions

None detected. The O1 path is consistent with the settled suffix design
(preserves `part.append` for text/reasoning only; TOOL rewrites on authoritative
upsert; monotonic sequence + ring order). The rejected O2-alternatives WOULD
conflict with the ordering contract, but O2 itself (not selected) does not.

## Verification

| Claim | Verifying slice / artifact | Verified |
|-------|---------------------------|----------|
| O1 is the standing decision (no ingress suppression, no egress optimization) | This checkpoint + `compaction-burst-axis.md` header + `part-append-streaming.md` §8 | yes |
| a-F2 gate: no real duplicate-composition telemetry exists | slice 4A fixture is synthetic (`pkg/state/part_upsert_burst_fixture_test.go`); real composition unknown | yes |
| 4A: ~226KB burst has no measurable healthy-link impact (settle 15–30µs, HWM 13–16) | slice 4A fixture measurements | yes |
| 4A: overflow needs ~7× incident + blocked writer | slice 4A fixture (slow-writer variant) | yes |
| `part_upsert_burst` probe is deployed as the measurement vehicle | `pkg/diagnostics/part_upsert_burst.go` + `/vh/diag/latency` wiring (`pkg/diagnostics/handler.go`, `registry.go`) | yes |
| Relay/browser attribution track is parked (§7 capture procedure) | `part-append-streaming.md` §7 (unchanged by this slice) | yes |
| No runtime behavior changed by this docs/comment-only slice | `go test ./pkg/state/... ./pkg/diagnostics/...`, `go build ./...`, `go vet` (this slice's required commands) | yes |
