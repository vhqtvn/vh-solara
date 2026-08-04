# Pilot runbook — contract/invariant audit (overlay-only S1)

This is a procedural runbook for running a bounded pilot slice and the
distinctness A/B test. It produces **advisory evidence only** — no gate, no
commit/release/doctor/update effect. See `SKILL.md` for the full procedure and
authority line, and the decision brief for column schemas.

The helper is at `scripts/manifest-helper.js` (rendered under
`.opencode/skills/contract-invariant-audit/scripts/manifest-helper.js`). Run it
via `vh-agent-harness exec node <path> ...`. It is discovery/accounting only.

## 0. Sanity-check the helper

```bash
vh-agent-harness exec node .opencode/skills/contract-invariant-audit/scripts/manifest-helper.js --self-test
```

Expect `SELF-TEST: PASS`. This proves determinism (identical inputs →
byte-identical manifests) and completeness accounting before you rely on either.

## 1. Declare a bounded slice

Record, before running anything (state every field explicitly — use `none` /
`unsharded` where it does not apply, so the run ledger has no silent gaps):

- **anchor** — a git ref (default `HEAD`). The manifest pins to this snapshot.
- **roots / sources** — inclusion globs for the declared surface.
- **unit model (granularity)** — the unit the audit examines (e.g. `file` for the
  fallback; an adapter may declare another). State it explicitly.
- **discovery adapter + version** — the adapter command (or `none` for the file
  fallback). If an adapter is used, record its id/version and the wire contract
  it honors (it receives the anchored scope on stdin; see `--help`).
- **non-file units** — any units the adapter declares that are not files (or
  `none`). The helper records them verbatim; it never infers semantic units.
- **exclusions** — exclusion globs, each with a one-line reason.
- **coverage tier** — `declared-inventory` for the file fallback; only an adapter
  that enumerates every supported unit may claim `adapter-complete`; a sampled
  run claims `sample` and is explicitly weaker.
- **shard strategy** — `unsharded`, or how the manifest is split for parallel
  review (each shard reconciled only when all its units are disposed).
- **time / cost budget** — a wall-clock or step ceiling for the run (e.g. `60 min`
  or `n units`). Budget exhaustion is a stop/reshape trigger (see §7).
- **completion / stop conditions** — what marks the run done (every manifest unit
  reaches a terminal disposition AND the rigor-check is performed) and what stops
  it early (a stop/reshape condition firing; see §7).

Keep the first slice narrow — narrow enough to test the hypothesis, not to claim
repository-wide coverage.

## 2. Generate the manifest

```bash
vh-agent-harness exec node .opencode/skills/contract-invariant-audit/scripts/manifest-helper.js manifest \
  --roots '<root-globs>' \
  --exclude '<exclude-globs>' \
  --anchor HEAD \
  --granularity file \
  --out tmp/cia-manifest.json
```

Notes:

- No `--adapter` → the deterministic fallback enumerates the anchor snapshot
  (`git ls-tree -r --name-only <anchor>`) so the inventory matches the recorded
  `source_anchor`; the manifest claims `declared-inventory` (NOT
  `adapter-complete`). This is the fallback limit: a file inventory is not a
  semantic-unit enumeration. An unresolvable anchor is rejected.
- To use a discovery adapter, pass `--adapter '<cmd>'` (the command is split on
  whitespace into executable + args; use a wrapper script for complex quoting).
  The helper FORWARDS the resolved anchor + roots/exclude/granularity to the
  adapter as JSON on STDIN; a conformant adapter reads stdin, enumerates at
  `snapshot_anchor.resolved`, and emits the adapter JSON shape (see `--help`) on
  stdout. The manifest records `anchor_basis=adapter-via-stdin` so the
  `source_anchor` is trustworthy (the adapter received it), not decorative. The
  helper performs no semantic work — it only forwards the scope and assigns IDs.
- To merge operator/adapter-supplied cross-unit units verbatim (never inferred),
  pass `--units <file>` with a `{ "units": [ { "locator": "...", ... } ] }` doc.

Inspect the manifest: confirm `coverage_tier`, the anchor, the root/exclude
config, and that every unit has a stable `unit_id`. Re-running with identical
inputs must produce a byte-identical file.

## 3. Per-unit disposition + adversarial verify/refute

For each manifest unit, assign exactly one terminal disposition
(`clean` / `candidate_violation` / `not_applicable` /
`blocked_by_missing_evidence` / `excluded_by_contract`) into a dispositions doc:

```json
{
  "schema": "contract-invariant-audit/dispositions@1",
  "dispositions": [
    { "unit_id": "<id>", "disposition": "clean" },
    { "unit_id": "<id>", "disposition": "candidate_violation",
      "violation_class": "C2", "reason": "...", "locator": "..." }
  ]
}
```

Rules: a `candidate_violation` must name at least one of C1–C5 with a precise
claim and locator; `blocked_by_missing_evidence` is terminal for accounting but
never counted clean; bulk-defaulting without unit-level evidence is prohibited.

Every candidate intended for the final ledger then undergoes the adversarial
verify/refute pass (SKILL.md → Phase 4), assigning `verified`, `refuted`, or
`indeterminate`. Refuted candidates stay in the rigor record only.

## 4. Completeness accounting

```bash
vh-agent-harness exec node .opencode/skills/contract-invariant-audit/scripts/manifest-helper.js complete \
  --manifest tmp/cia-manifest.json \
  --dispositions tmp/cia-dispositions.json
```

Exit 0 = accounting well-formed (every manifest unit has exactly one terminal
disposition, no duplicates/unknown/missing/non-terminal/shard/anchor problems).
Exit 2 = malformed accounting. A `candidate_violation` disposition is NOT a
failure here — the helper does not care about violations, only accounting.

If the anchor drifted since the manifest was generated, supply
`"anchor_reconciliation": "<reason>"` in the dispositions doc or regenerate the
manifest at the current anchor.

## 5. Distinctness A/B test (the pilot success criterion)

Run this audit AND commit-review on the SAME slice, then classify each surviving
finding:

- `duplicate-of-commit-review` — commit-review would naturally have found it.
- `net-new-in-untouched-code` — in code NOT touched by recent commits; the
  structural blind spot per-commit review cannot see.
- `indeterminate` — cannot be confidently classified.

Record the rates. **Falsifier:** if the audit only restates commit-review
findings (no meaningful net-new-in-untouched-code), the differentiation
hypothesis FAILS → STOP/reshape the capability. Candidate volume is not success.

To get the recent-commit changed-file set for the A/B baseline:

```bash
vh-agent-harness exec bash -c 'git --no-pager diff --name-only <base-ref>..HEAD'
```

(or run `/commit-review` on the same slice and reuse its changed-file list).

## 6. Rigor-check (independent second opinion)

- Sample a set of downgraded/refuted/killed candidates (record method and size).
- Reconstruct each rejected claim; agree or disagree with the original
  disposition; restore any wrongly killed candidate for verification.
- Probe ONE latent violation class that may have been under-sampled.
- The rigor-check does not guarantee absence of unsampled defects — it measures
  whether the primary pass disposed of candidates responsibly.

## 7. Stop/reshape decision

Apply the stop/reshape conditions (SKILL.md): high candidate volume with low
survivor yield; rigor-check repeatedly restoring wrongly killed candidates;
survivors duplicating commit-review; undisclosed semantic assumptions in the
fallback; unstable unit IDs; exclusions growing without reason; cost dominating
evidence; silently treating unknown units as clean. If the A/B falsifier fires,
STOP and reshape rather than continue.

## 8. Record for the S2 evidence file

Capture (this is advisory evidence for a future, separate S2 decision — NOT an
S2 score):

- slice declaration: roots, exclusions (+ reasons), granularity, anchor;
- coverage tier and enumeration evidence;
- units manifested / examined / blocked;
- explicit exclusions;
- candidate / verified / refuted / indeterminate counts;
- duplicate-of-commit-review vs net-new-in-untouched-code vs indeterminate rates;
- wall time and operator effort;
- rigor-check reversal rate.

This runbook produces no gate. Any standing check it motivates is report or
doctor-WARN-shaped only.
