# Runbook — resolve-first DEFER-processing (overlay-only S1 pilot)

This is a procedural companion to `SKILL.md`. It gives **one worked example**
for each of the three legal outputs, each of the four whitelist tags, and each
of the five named falsifiers — enough to calibrate judgment, not an exhaustive
case law. Every example is advisory: the outputs still pass through their own
transitions (edit-review/ownership, the read-only research workflow,
`/write-task`).

The classifier never certifies a resolution. The traces below (commit refs,
brief artifacts, draft cards) are what the **back end** re-derives from state —
it does not trust the classifier's self-report.

## The three legal outputs

### Output 1 — landed-this-session

A `/commit-review` DEFER flags a doc that references a renamed CLI flag. STEP 0
verifies the rename is real (grep the new flag in `cmd/`), so the premise holds.
STEP 1: the fix is a one-line doc edit, scope and approach are clear →
**executable-now** → route to `build`, land the edit this session. The edit goes
through edit-review/ownership as usual.

- **Trace the back end re-derives:** the commit ref from this session touching
  the doc.
- **What enters `.local/`:** nothing.

### Output 2 — decided-to-verdict

A p2 follow-up proposes "add a cache here for performance," but whether the
cache is even correct depends on an unstated consistency contract elsewhere.
STEP 0 verifies the call site exists. STEP 1: the approach is genuinely unclear
and a reframe may be needed → **needs-a-decision** → drive to verdict NOW via
`/solution-brief` (or `/debate` if the reframe is contested). The decision is
RESOLVED into an artifact; the cache question does not get parked under "think
about it later."

- **Trace the back end re-derives:** the brief/debate artifact path.
- **What enters `.local/`:** nothing parked.
- **Why not a defer:** "unclear approach" is a NON-reason (brief it now), not a
  whitelist tag.

### Output 3 — defer-with-trigger

A `/commit-review` DEFER flags that a release-time migration note will need a
manual verification step that can only be done AFTER the next tag is cut (the
evidence — the actual released artifacts — does not exist yet). STEP 0 verifies
the release flow genuinely requires a post-tag step. STEP 1: the work is
**blocked-on-absent-evidence** → defer as ONE `status:draft` card.

- **Trace the back end re-derives:** the draft card carrying
  `blocked-on-absent-evidence` + trigger `after_tag(<next-release-tag>)` +
  `source:review-defer` + `studied:YYYY-MM-DD`.
- **What enters `.local/`:** exactly one draft card.

## The four whitelist tags (each as a valid defer)

### blocked-on-absent-evidence

A finding requires observing upstream registry behavior that does not exist
until the upstream publishes a release. The verification cannot be done now
because the evidence does not exist. Defer with trigger
`after_tag(<specific-upstream-tag>)` when the absent evidence is tag-correlated
(the tag MUST be supplied — bare `after_tag` is unknown-predicate and the card
can never fire). If the evidence is an external event with NO tag correlation,
there is no legal predicate: the card MUST state it has no mechanical trigger
and that its re-derivation is operator-driven (never a fake `event` expression,
which the checker rejects). The card asserts what evidence, once present,
unblocks it.

### blocked-on-sibling-slice

A refactor depends on a sibling slice that is in-flight (another session is
landing the interface this finding targets). Resolving now equals guaranteed
rework — the code would be written against the pre-sibling shape and rewritten
after. Defer with trigger `path_touched(<path-the-sibling-will-produce>)` —
when the sibling lands it writes concrete paths, and the trigger fires on those
exact paths. A bare "sibling lands" label is not a trigger (unknown-predicate);
attach a pointer to the sibling slice so the output path is identifiable.

### pure-future-watch

A guard extension is worth adding only IF a currently-absent code path becomes
real (e.g. a v2 widening that does not exist yet). There is ZERO actionable-now
component — the card MUST assert the no-now-work property explicitly ("no work
is correct to do until path P exists"). Defer with trigger
`path_touched(<exact-repo-relative-path>)` on P. If any now-work is
identifiable, this tag does not apply — go to branch (1) or (2).

### operator-reserved-signoff

A disposition requires an operator-only authority call (e.g. whether to promote
an overlay to core, which is an operator decision). The enabling brief is DONE
and attached — the analysis is complete, only the sign-off is deferred. This
tag has **no mechanical trigger**: the sign-off is an operator action, not path-
or tag-observable, so no legal `path_touched`/`after_tag` predicate applies.
The card MUST state this explicitly and rely on operator-driven re-derivation
(the attached brief is the artifact the operator acts on). A sign-off deferred
with no attached brief is invalid (see falsifier "Loophole"); a sign-off
deferred under a fabricated mechanical trigger is equally invalid.

## The five falsifiers (each as a forbidden move)

### Rationalization engine

An agent classifies a finding as "resolve later — I'll get to it next session"
and writes nothing this session, no commit, no brief, no card. This is output
(3) in disguise with no whitelist tag and no trigger. BANNED. "Resolve" means a
commit ref THIS session. Re-route: if the work is executable → branch (1); if
the approach is unclear → branch (2); if it is genuinely blocked → write the
card with a real tag.

### Busy-work

An agent, biased toward resolve-now, rush-resolves a `pure-future-watch` whose
trigger has not fired — implementing a guard for a code path that does not exist
yet. This creates revert-prone work and ignores a legitimate block. Respect the
whitelist tag. The bias toward (1)/(2) is not a license to dissolve a real
defer; it is a bias against *unjustified* parking.

### Loophole via operator-reserved-signoff with no attached brief

An agent defers a decision under `operator-reserved-signoff` but the enabling
analysis is not done — the brief is missing. This smuggles an unresolved
decision under a sign-off tag. Invalid: the `operator-reserved-signoff` tag
requires the brief to be DONE and attached. Re-route: if the analysis is not
done → branch (2) (drive to verdict now); only once the brief exists may the
sign-off alone be deferred.

### Gate-weakening

An agent, trying to land a resolution quickly, lowers edit-review scrutiny or
reclassifies an ownership-protected file as overwritable "to resolve it
faster." BANNED. The edit-review and ownership gates stay exactly as they are.
A resolution routes around the gate legitimately (a real edit that is actually
reviewed) or drives to verdict — never through a weakened gate. Lowering a gate
to resolve is not a resolution; it is a safety-contract violation.

### Re-defer churn

The same draft card is re-parked across three consecutive releases — its trigger
fires each time, and each time it stays `draft`. This is §F1-D1 decay in motion.
It is flagged (the scoreboard's resolve-now / card-pile sides both read decay)
as evidence the gate is not biting, not accepted as routine maintenance. When
re-defer churn is observed, the correct response is to re-run STEP 0 + STEP 1 on
the card: either it should have been resolved (branches 1/2) or the whitelist
tag is wrong.

## Reading the scoreboard (advisory, off deterministic observers)

The scoreboard is read off observers that already exist, never off the skill's
self-report:

- **Card-pile side:** run `check-defer-triggers.mjs` over `.local/coordinator/tasks/`.
  Is the pile shrinking over releases (candidates being resolved/driven-to-verdict)
  or flat/growing (rationalization + re-defer churn)? A flat or growing pile is
  the falsifier signal that the front gate is not changing behavior.
- **Resolve-now side:** read git history for resolve-now edits. Did they stick
  (low revert) or revert (busy-work)? A revert spike paired with a shrinking
  pile is busy-work, not health.

Health is BOTH sides: pile shrinks AND edits stick. Either side alone is a
falsifier firing. These metrics are advisory — a flat pile does not block a
release (the back end governs release) — but a pilot whose scoreboard never
moves toward health should be reshaped or retired rather than reported as
working.
