# F2 rendering family — durable persistence + salient rendering

The F2 family is the durable persistence and rendering layer for F1
synthesis output. It takes F1's validated emit (`ValidatedF1Emit`) and:

1. Persists it as an **immutable canonical sidecar** (JSON) — lossless, the
   durable "what F1 said" record.
2. Renders a **deterministic Markdown projection** — a human/agent-readable
   derived view of the canonical sidecar.

**F2 never produces synthesis.** It only persists + renders F1's
already-produced output. F2 is strictly INFORM-only.

## The F2 "must NOT" fence (load-bearing)

F2 MUST NOT:

- Join evidence, merge or split properties, generate alternatives or
  counter-evidence, add conclusions, or infer gaps.
- Reinterpret bounded absence as global absence.
- Reconstruct missing F1 from prose.
- Treat unverified media as evidence.
- Emit partial as complete.
- Normalize, repair, or silently update a digest mismatch.

If any implementation pressure pushes F2 toward transition authority, cut
that part, note it, and continue.

## Artifact pair

Each synthesis cycle produces a pair at:

```
docs/checkpoints/f2/<synthesis_cycle_id>.canonical.json   (immutable, digest-bound)
docs/checkpoints/f2/<synthesis_cycle_id>.md               (derived projection)
```

- The **canonical JSON** is the lossless "what F1 said" record. It carries
  the full F1 synthesis envelope + F2 view metadata (cycle, entries, source
  digest, canonical/schema/projection/renderer versions, reciprocal locator,
  write timestamp).
- The **Markdown projection** is the derived "how F2 displays it" view. It
  is deterministically rendered from the canonical sidecar ONLY — no
  free-form model summarization. It self-identifies as:

  > Derived, informational, and non-authoritative. Canonical meaning
  > remains in the digest-bound F1 emit.

- The pair is **reciprocal**: the canonical's `ReciprocalLocator` points at
  the `.md`, and the MD's metadata block points back at the `.canonical.json`.
- The pair is **immutable**: collision handling refuses to overwrite an
  existing pair that differs. A new cycle is required for changed content.

### Detecting stale projections

The Markdown projection is a deterministic function of the canonical sidecar
+ the renderer version. The doctor check (#18 `f2-pairs`) detects stale
projections (stored MD bytes != deterministic re-render from the stored
canonical sidecar) and reports them as structural failures. The doctor is
read-only — it audits pair consistency but does not itself re-render.

The recovery for a stale projection is to re-render the MD from the canonical
sidecar. Because the canonical JSON is immutable and digest-bound, the
canonical content is never lost — only the derived MD needs regeneration.

```
vh-agent-harness doctor
```

## Structural consistency, not semantic truth

The F2 pair is **structurally consistent**, not **semantically true**. A
pair that passes the doctor check is internally consistent (the MD matches
the canonical sidecar, the digest binds the content, the pair points at
itself). It is NOT thereby proven to describe conclusions, media, or
evidence that are actually true.

This caveat applies to every F2 surface:

- The P-c headline carries the canonical disposition VERBATIM (pending stays
  pending, never upgraded), but does not prove the disposition is correct.
- The P-a table renders probe results EXACTLY (including
  `not_found_in_checked_scope`, which NEVER renders as "none exists"), but
  does not prove the probes were run correctly.
- The R5 binding carries the operator-source entry ID + digest binding, but
  does not prove the source is authoritative.
- The P-b media provenance slot carries declared provenance metadata, but
  does NOT verify media content truth. A `captured` evidence-grade
  attachment means the provenance metadata is structurally present — not
  that the numbers, charts, or observations are real or accurate.

## Per-cycle rendered surfaces

The Markdown projection renders these surfaces in order:

1. **Standing notice** — self-identifies as derived/informational/non-authoritative.
2. **F2 view metadata** — cycle, entries, source digest, versions, reciprocal locator, timestamp.
3. **P-c headline** (first disclosure layer) — decision frame, canonical disposition, counter-evidence, weakest claim, unresolved gaps, canonical binding metadata. Required BEFORE the detailed sections.
4. **P-a decision-request table** — per-option matrix: Option | Costs | Evidence-against | Weakest-claim | Reversal-cost. All values trace to canonical R3 option records + P-a probes.
5. **R5 operator-synthesis binding** — if present, the operator-source entry ID + cycle/digest binding.
6. **P-b media provenance** — if present, each evidence-grade media attachment with its provenance.
7. **Canonical envelope** — full F1 envelope projection (entries, R1 conclusions, R3 options, P-a probes).
8. **Entry details** — per-entry deep-dive.

## Derived view: R1 chronological streak

The streak scanner (`ScanF2R1Streak`) reads all `docs/checkpoints/f2/*.canonical.json`
sidecars and produces a chronological view of R1 conclusions across cycles.
It orders by `synthesis_cycle_id` (stable, lexicographic) — NEVER by file
mtime. It shows agreements, contradictions, gaps, ancestry, and hazard-links
EXACTLY as they appear in the canonical sidecars. It creates no new
relationships, infers no streak, and authors no conclusion.

## Doctor check: #18 f2-pairs

`vh-agent-harness doctor` runs check #18 (`f2-pairs`) which audits every pair
at `docs/checkpoints/f2/` for structural consistency:

- Pair presence (both files exist)
- Envelope cycle == filename base (two-faced-sidecar guard)
- Digest recompute + comparison
- F2 view metadata cycle == envelope cycle
- Reciprocal binding (canonical locator → MD, MD locator → canonical)
- Pair metadata agreement (cycle/digest/schema/projection/renderer + entry IDs)
- Deterministic projection equivalence (re-rendered MD == stored MD bytes)
- P-c required structure (markers present + R3 entry with non-nil payload + P-a weakest claim)
- P-b provenance gate (each media attachment validates)
- P-a enum validity (every probe Result is a known enum)
- R5 binding consistency (if present, validates)

SKIPs when no `docs/checkpoints/f2/` directory or no pairs present. A PASS
states "structural consistency is not semantic truth; content/media truth is
not verified."

## This is not a claims database

The F2 pair is an artifact-level rendering of a single synthesis cycle. It
is NOT a claims database, a knowledge graph, or a queryable store. The pair
carries what F1 said for that cycle, rendered saliently. Cross-cycle
relationships (the R1 streak) are a derived read-only view that scans the
pairs on demand — there is no shared mutable index, no materialized join
table, and no inference layer.
