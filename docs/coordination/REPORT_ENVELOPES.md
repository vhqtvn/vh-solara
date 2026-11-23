# Coordination Report Envelopes

Use structured report envelopes so parallel sessions can be gathered and
compared without rereading chat transcripts.

This document is also the semantic owner of the optional **evidence coverage
and read-accounting convention** (last section) — shared field meanings for
coverage receipts, read ledgers, and evidence reuse that other docs and
skills reference instead of redefining.

## Principles

1. Reports are artifacts, not chat blobs.
2. Subagent reports should be factual and scoped.
3. Synthesis reports resolve conflicts and decide what gets promoted.
4. Only promoted conclusions belong in backlog rows, checkpoints, or other
   durable repo docs.

## Minimal Report

Use for `short` tasks or narrow follow-up slices.

```text
Return:
1. Task slice owned
2. Files in scope
3. Validation results
4. Blockers or none
5. Recommended next prompt
```

Prefer this when one session can still hold the whole story.

## Standard Report

Use for subagent reports in `medium` or `long` tasks.

```text
Return:
1. Task slice owned
2. Files touched
3. Decisions made
4. Validation results
5. Blockers
6. Downstream dependencies
7. Durable updates needed
8. Recommended next slice
```

This is the default subagent envelope once handoffs matter.

## Synthesis Report

Use when a coordinator or synthesizer gathers several subagent reports.

```text
Return:
1. Sessions consulted
2. Conflicting findings
3. Resolved view
4. Open risks
5. Durable updates required
6. Recommended next fan-out
```

The synthesis report is the only report shape that should directly drive backlog
or checkpoint promotions for a fan-in cycle.

## Machine-Readable Schemas

These schemas exist so a future local coordinator runtime can validate report
artifacts without becoming a second source of truth.

- `schemas/minimal-report.schema.json`
- `schemas/standard-report.schema.json`
- `schemas/synthesis-report.schema.json`
- `schemas/runtime-task-envelope.schema.json`

## Storage Guidance

- session-local closeout may remain in `.opencode/state/sessions/<alias>/`
- cross-session runtime copies may live under `.local/coordinator/reports/`
- promoted durable conclusions belong in `docs/planning/backlog.md` and
  `docs/checkpoints/`

## Evidence Coverage and Read Accounting (optional convention)

Substantive evidence gathering — research runs, audits, multi-session studies
— may carry three optional record types so that coverage, reads, and reuse
keep shared meanings across sessions and reports: **coverage receipts**, a
**read ledger**, and **freshness-aware reuse bindings**. This section is
their single semantic owner; other documents and skills reference it rather
than redefining the fields.

**When it applies.** Only when a session records evidence for later reuse or
reports examination coverage per question. Ordinary reads, edits, and routine
inspection need none of this — do not keep a ledger for every small read.

**Authority honesty.** These records are declarations that inform review.
They never authorize completion, permit or prohibit reads, or trigger
transitions (see `AUTHORITY_CLASSES.md` — advisory output reports; it does
not gate).

### Coverage receipts

One receipt per question (or per examined slot), recorded where the findings
are reported:

```text
slot_id:  stable question/slot identifier
status:   examined | partial | unexamined
scope:    what was actually examined (sources, sections, ranges, dates)
anchors:  evidence locators grounding the examination
gaps:     what remains unexamined, and why
```

- Slot status describes **examination only**. Record answer support, gaps,
  and confidence separately: a fully examined source may still be
  insufficient for the answer, and a partial examination may fully answer a
  narrow question.
- **Coverage is not sufficiency.** A receipt is a declaration by its author,
  never completion authority; confidence is a summary for reviewers, not a
  score that authorizes completion.

### Read ledger (a record, not a budget)

One entry per read attempt:

```text
episode_id:     gathering episode this attempt belongs to
attempt_id:     stable identifier for this attempt
source:         locator + anchor (path or URL, section or line range)
source_version: the source's own version/date when it exposes one, else unknown
outcome:        read | partial | failed | skipped — with reason
retry_of:       prior attempt_id when this is a retry, else empty
payload:        amount actually read, with unit, only when observable
payload_basis:  measured | estimated | unknown
```

- Every quantity carries its unit and its measurement basis. `unknown` is
  not zero — an unmeasured read still happened. Characters, bytes, lines, and
  tokens are distinct units; never sum or convert across them silently.
- **Cumulative exposure counts repeats; unique coverage does not.** Every
  attempt — including repeats and retries — adds to cumulative exposure,
  while unique coverage counts distinct sources/anchors once. Track the two
  separately; never let one stand in for the other.
- Carry `episode_id` / `attempt_id`, and when inheriting a packet from an
  earlier session, its lineage — inherited totals are carried forward once,
  never re-added on each resume.
- **An incomplete log is a partial ledger, never a bound.** Missing entries
  mean the record is incomplete, not that the reads did not happen; a
  partial ledger must never be read as "nothing more was read".

### Cross-session freshness-aware reuse

Reusing recorded evidence instead of re-reading is allowed only while its
binding holds:

```text
objective:       the question the evidence was gathered to answer
source_version:  as recorded in the ledger entry
anchor:          locator + section/line anchoring
depth:           examination depth actually performed
```

- Carry each binding as a premise-recheck 4-tuple
  (`value`, `source`, `re_derivation_command`, `observed_at`) — see
  `vh-agent-harness docs opencode-session-workflow` → "Premise-recheck
  protocol".
- Missing or expired evidence earns **no reuse credit**: revalidate, re-read,
  or report the gap. An unavailable source is a gap, never invented
  continuity.
- **Dedup is a suggestion, never a prohibition.** Re-reading is legitimate
  whenever the source version changed, the question is new or materially
  broader, the recorded depth is insufficient, verification is required, or
  the record is missing.

### Advisory readiness assessment

A readiness note lists the remaining evidence work — open slots, stale reuse
bindings, unresolved gaps — and may rank it by consequence. It is advisory:
it identifies what could still be done and never authorizes completion,
prohibits reads, or triggers a transition.

### Worked example: handoff, resume, freshness override, targeted reread

1. Session A examines Q1 (two files at version v2, both fully read) and Q2
   partially. Its handoff packet carries the coverage receipts, ledger
   entries A1–A5, and one reuse binding per examined source, each with a
   premise tuple.
2. Session B resumes and re-derives every premise tuple before trusting it.
   Q1's tuple re-derives cleanly (same contents at the same anchor) — the
   binding holds, reuse stands, no re-read.
3. Q2's tuple fails re-derivation: the source advanced v2 → v3. The binding
   is expired and earns no reuse credit.
4. B performs one targeted re-read of the changed section only (entry B1,
   new `episode_id`, `retry_of` empty, reason "source version changed"),
   records the new anchor and version, and marks Q2 examined with the delta
   noted. Cumulative exposure now counts A's and B's reads; unique coverage
   still counts the shared source once; and B's packet carries A's lineage
   so a later resume does not re-add A's totals.
