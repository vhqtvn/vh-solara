---
name: resolve-first
description: "Front-gate classifier for DEFER / follow-up triage at card-creation. Use when deciding a candidate's disposition — resolve-now vs. decline-and-close vs. drive-to-verdict vs. defer-with-trigger — before it enters `.local/coordinator/tasks/`."
compatibility: opencode
---

# Resolve-first DEFER-processing (overlay-only S1 pilot)

This skill is a **front gate at card-creation**: when an agent or coordinator
holds a candidate that would otherwise be parked as a DEFER / follow-up, this
gate forces a disposition that is biased hard toward terminating NOW —
resolving justified work, deciding genuine decisions, or closing unjustified
candidates — and permits parking only under a narrow whitelist. It is a
**classifier**, not a resolver — it emits one of four legal outputs and never
certifies that a resolution is correct. The actual landing, verdict, or card
still passes through the surfaces that own those transitions
(edit-review/ownership, `/debate` / `/solution-brief`, and `/write-task`).

It is **distinct from the back end**: the back end
(`check-defer-triggers.mjs` trigger grammar + the promotion Definition of Ready +
doctor #12 / release-prep liveness) governs how a parked card is *promoted and
released*. This skill governs whether a card is *created at all*. The two
compose — the front gate does NOT replace, lower, or trust away the back end.

**S1 overlay pilot.** This is an experimental overlay skill. Core promotion is
NOT authorized. The skill is instruction-only (no deterministic helper ships);
the two-sided scoreboard it predeclares is read off observers that already exist
(`check-defer-triggers.mjs`, git history) — none are created here. Nothing in this
skill enters `templates/core/`.

## Authority — INFORMS ONLY

> Every output of this gate **INFORMS**. It never certifies a resolution, never
> gates a commit/release/doctor/update, never lowers edit-review or ownership
> classification, and never transitions state on its own.

This applies to the four legal outputs, the whitelist tags, the falsifier
detections, and the scoreboard. Concretely:

- The classifier's chosen output NEVER triggers a stop, a gate, or a transition.
  Landing an edit still passes through edit-review/ownership; producing a brief
  still passes through the read-only research workflow; writing a card still
  passes through `/write-task`.
- The classifier NEVER weakens edit-review or ownership classification "to
  resolve it faster." Lowering a gate to land a resolution is a named falsifier
  (see "Falsifiers"), not a permitted move.
- The back end reads state **directly**. It NEVER trusts this skill's
  self-report: a classifier that claims `landed-this-session` is not believed
  until the commit exists; a classifier that claims `defer-with-trigger` is not
  believed until the draft card exists with a whitelist tag and a real trigger.
  This is the same read-state-directly discipline the back end already enforces
  (see `researches/decisions/2026-07-30-defer-liveness-release-gate.md`).
- The scoreboard is read off deterministic observers that already exist
  (`check-defer-triggers.mjs`, git history), NEVER off the skill's own emitted
  outputs. The skill predeclares what those observers mean; it does not produce
  them.

**Critic's blocker (load-bearing):** the skill MUST NOT be wired into any
commit, release, doctor, or update path. Promoting any classifier output to a
gate is a SEPARATE decision that must identify the protected transition, the
deterministic predicate, ownership of the validator, false-positive and recovery
behavior, and explicit authority to gate. **This skill grants no such
authority.**

## The philosophy — a DEFER is deferred-AND-amplified cost

A DEFER is **not free parking**. It is deferred-AND-amplified cost: the same
work must still be done later, but "later" re-pays for context that is hot NOW —
the file is open, the failure is reproduced, the reviewer is present, the
decision frame is loaded. Parking does not delete cost; it compounds it with a
re-derivation tax. So the **default is RESOLVE NOW**: the pile shrinks by
resolution, not grows by parking.

This is empirically grounded, not aesthetic.
`researches/decisions/2026-07-30-defer-liveness-release-gate.md` §F1-D1 records
the population-scale instance: **16 `draft` DEFER cards had fired `path_touched`
targets in `v0.18.0..HEAD` and would have shipped without a forced verdict**, and
**one erratum card's trigger fired on three consecutive releases and stayed
`draft` through all of them.** Those cards were not parked because their triggers
hadn't fired — they were parked *while their triggers were firing*. The trigger
machinery itself fails mechanically (it is not only severity verdicts that
decay). **Parking decays.** That decay is the failure mode this front gate
exists to reduce — by refusing to create the card when the work could instead
be landed, decided, or legitimately declined this session.

## The mechanism — front gate composes with (does NOT replace) the back end

The existing back end STAYS unchanged: the `check-defer-triggers.mjs` trigger
grammar, the promotion Definition of Ready, and doctor #12 / release-prep
liveness all remain exactly as-is. This skill adds a front gate at
card-creation that emits **exactly four legal outputs**. **"Resolve later" is
STILL NOT a legal output** — no branch parks work under a vague "later" label.
Decline-and-close (output 4) is categorically not that banned branch: like
STEP 0's DROP for a refuted premise, it is a TERMINAL closure — the premise is
valid but the work is not justified, so nothing is parked, nothing remains
owed, and no debt item is created merely to remember it. What stays banned is
parking, not closure.

| # | Legal output | What exists afterward | What enters `.local/` |
|---|---|---|---|
| 1 | **landed-this-session** | a diff / commit this session | nothing |
| 2 | **decided-to-verdict** | a `/debate` or `/solution-brief` artifact | nothing parked |
| 3 | **defer-with-trigger** | one `status:draft` card with a whitelist tag + a real `owner_notes[]` trigger | exactly one draft card |
| 4 | **declined-and-closed** | the inline disposition, with its reason, in the response/thread where the finding arose | nothing — no card, no future obligation |

Outputs 1, 2, and 4 leave nothing parked; only output 3 creates a card, and
only under a whitelist tag. Outputs 1 and 2 are for work that is **justified**
(necessary or worthwhile); output 4 is for a candidate that is **valid but not
justified** — a valid finding is not automatically an authorized or worthwhile
engineering action. Mandatory correctness, security, safety, or acceptance
requirements are NEVER declinable, however costly implementation appears (see
NON-reasons).

Every disposition that lands, decides, or defers MUST emit a machine-checkable
trace: a resolve emits a commit ref from THIS session; a decide emits a
brief/debate artifact; a defer emits a draft card carrying one of the four
whitelist tags and a real trigger. A disposition with no trace is not a
disposition — it is an unbounded parking attempt and is forbidden (see
falsifier "Rationalization engine"). A legitimate decline-and-close is the
exception by construction: its record IS the inline disposition where the
finding arose. It must NOT create a commit, brief, or task card solely to
justify the no-work decision — manufacturing an artifact to justify no-work is
an anti-pattern, not compliance. The trace requirement exists to stop silent
parking; a decline parks nothing.

## When to use

- Deciding the disposition of a DEFER finding raised by `/commit-review`.
- Deciding the disposition of a p2 follow-up surfaced during a slice.
- Deciding whether a candidate belongs in `.local/coordinator/tasks/` at all, or
  should be resolved/declined/driven-to-verdict instead.
- Reviewing an existing draft card whose trigger has now fired: re-running the
  gate to decide resolve-now vs. drive-to-verdict vs. decline-and-close vs.
  keep-deferred.

## When NOT to use

- As a resolution **certificate** — landing an edit still needs edit-review and
  ownership; the classifier's "landed" output is a claim, not a proof.
- As a way to weaken edit-review or ownership classification "to resolve it
  faster" — that is a named falsifier, never permitted.
- As a substitute for the back end — promotion and release-liveness are still
  governed by `check-defer-triggers.mjs`, the DoR, and doctor #12.
- To re-label parking as "resolve later" with no this-session landing — there is
  no such output.

## Decision procedure (per defer / candidate)

### STEP 0 — VERIFY THE PREMISE FIRST

Before classifying, re-derive the candidate against current repo state (grep,
git, a read of the cited file). Roughly a third of DEFER candidates evaporate
here: the work is already done, the cited defect is obsolete, or the diagnosis
was wrong. If the premise is refuted → **DROP** and `rm` the card (do NOT
re-implement settled or mis-diagnosed work). Premise verification is mandatory;
skipping it parks ghost work.

### STEP 1 — the resolve-first disposition, biased HARD toward (1) and (2)

First ask whether the candidate is **justified** — necessary or worthwhile
given the actual requirement, risk, or expected value. Analysis depth is
proportional to consequence: a small, obviously justified fix needs NO
value-analysis ceremony. Do not demand a reliable implementation-cost estimate
before solution exploration — cost often becomes understandable only after
investigating alternative approaches; for uncertain but potentially
consequential work, a **bounded investigation** MAY be the smallest justified
next action, before any implementation commitment.

- **justified-and-executable-now** — the work is necessary or worthwhile AND
  the fix is small, or the scope + approach are clear → **JUST DO IT** this
  session. Land the edit (output 1). The edit still passes through
  edit-review/ownership; this gate does not lower them.
- **needs-a-decision / genuine reframe** — a real decision is genuinely
  unresolved (the approach turns on an unstated contract or consistency
  question, or a stakeholder reframe just landed) → **drive to verdict NOW**
  via `/debate` or `/solution-brief` (output 2). The decision gets RESOLVED,
  not deferred. "Unclear approach" is NOT a defer reason (see NON-reasons); it
  is a brief-it-now signal — but it means a decision gap, not merely unclear
  implementation COST on a possible improvement. Do not invoke a brief as a
  reflex for unclear cost; a bounded investigation, then land / decline /
  brief on what it found, is the coherent route there.
- **genuinely-blocked** — one of the four whitelist reasons holds → defer as a
  `status:draft` card with the blocking condition recorded as the trigger
  (output 3).
- **valid-but-not-justified** — the premise survived STEP 0, but the work is an
  optional improvement the actual requirement, risk, or expected value does
  not call for → **decline and close** (output 4): state the decline inline
  where the finding arose, deliberately, with its reason. Declining is not
  deferring — no DEFER card, no future obligation, no debt item created
  merely to remember it. NEVER declinable: mandatory correctness, security,
  safety, or acceptance requirements, however costly implementation appears.
  Decline is also not a softer substitute for justified substantial
  engineering — when approved requirements genuinely justify the work, pursue
  it.

The bias is structural: branches (1) and (2) leave nothing parked; only branch
(3) creates a card, and only under a whitelist tag; branch (4) closes with no
card at all. When in doubt between (1) and (3), pick (1); when in doubt between
(2) and (3), pick (2). The bias toward resolving justified work is unchanged —
decline-and-close exists for candidates that are genuinely not justified, not
as an escape hatch from justified work.

## The valid-defer whitelist (narrow — exactly four tags)

These are the **only** reasons a defer may be created. Every defer card MUST
carry exactly one of these tags in `owner_notes[]`, plus a real trigger, plus
`source`/`studied` provenance.

### Trigger grammar (what the back end actually parses)

The back end (`check-defer-triggers.mjs`) is a deliberately tiny predicate
engine. It parses **exactly two** trigger predicates, both requiring an
argument:

- `path_touched(<exact-repo-relative-path>)` — true when that exact path appears
  in the release diff (exact match; no glob, no directory prefix).
- `after_tag(<tag>)` — true when `<tag>` exists.

Any other trigger expression is `unknown-predicate` in promoter mode (the
trigger evaluates false and the card can never be mechanically promoted) and an
**evaluator-error in release mode (fail-closed)**. The back end's own contract
is explicit: a card whose trigger can never fire is malformed and must be
visibly flagged, not parked. So a defer card that claims a whitelist tag MUST
carry one of these two legal predicates where the tag is mechanically
observable; where it is not (an operator-only action), the card MUST say so
explicitly — it has NO mechanical trigger and its re-derivation is
operator-driven, never silently parked under a fake expression. **Do not invent
trigger vocabulary the checker cannot parse** (no bare `after_tag`, no `event`,
no "sibling lands", no "operator review" as a `trigger:` value).

### The four tags (each mapped to a real trigger, or honestly none)

- **blocked-on-absent-evidence** — external evidence does not yet exist (e.g.
  upstream behavior observable only after a release lands). Trigger:
  `after_tag(<specific-tag>)` when the absent evidence is tag-correlated (the
  tag MUST be supplied). If the evidence is an external event with NO tag
  correlation, there is no legal predicate — the card MUST state it has no
  mechanical trigger and that its re-derivation is operator-driven.
- **blocked-on-sibling-slice** — depends on an in-flight sibling slice; resolving
  now equals guaranteed rework. Trigger: `path_touched(<path-the-sibling-will-
  produce>)` — when the sibling lands it writes concrete paths, and the trigger
  fires on those exact paths. A bare "sibling lands" label is not a trigger.
- **pure-future-watch** — a true future-conditional watch with ZERO
  actionable-now component. The **no-now-work property MUST be asserted
  explicitly** in the card (if any now-work exists, this tag does not apply).
  Trigger: `path_touched(<exact-repo-relative-path>)` on the path whose
  appearance is the future condition.
- **operator-reserved-signoff** — an operator-only decision or authority; the
  enabling brief MUST be DONE and attached, and only the sign-off is deferred.
  This tag has **no mechanical trigger**: the sign-off is an operator action,
  not path- or tag-observable. The card MUST state this explicitly and rely on
  operator-driven re-derivation (the attached brief is the artifact the operator
  acts on).

### NON-reasons (must NOT trigger a defer)

- **"marginal value" / "low value"** → not a defer. Value/justification sizing
  is not a PARKING criterion — but it IS a decline criterion. If the work is
  justified (necessary or worthwhile) and in scope, DO IT now; if it is valid
  but not justified by the actual requirement, risk, or expected value →
  decline-and-close (output 4), deliberately, with no debt item; if it is out
  of scope, DROP it. Mandatory correctness, security, safety, or acceptance
  requirements are exempt from decline — they are must-fix, never value-priced.
- **"some review cost" / "safety-contract edit cost"** → DO IT. The
  edit-review/ownership gate stays; cost is not a defer reason.
- **"it's a bit big"** → drive to verdict (branch 2) or split into a real slice.
  Size is not a defer reason.
- **bare capacity / batching** → NOT a standalone reason. Allowed ONLY as a
  rider on `blocked-on-sibling-slice` or `pure-future-watch`, never on its own.
- **"unclear approach"** → brief it now (branch 2). This is the explicit signal
  for `/debate` or `/solution-brief`, not a parking criterion. The signal is a
  genuine decision gap — not merely unclear implementation cost on a possible
  improvement (see STEP 1: bounded investigation, not an automatic brief).

## Routing

- **justified-and-executable-now → `build`** (the edit lands this session,
  through edit-review/ownership).
- **needs-a-decision → `/debate` or `/solution-brief`** now (the decision is
  resolved, producing an artifact; nothing is parked).
- **genuinely-blocked → coordinator** writes ONE `status:draft` card in
  `.local/coordinator/tasks/` via `/write-task status:draft`, carrying the
  whitelist tag + a real `owner_notes[]` trigger + `source` / `studied`
  provenance.
- **valid-but-not-justified → decline-and-close** — state the decline inline in
  the response/thread where the finding arose, with its reason. No card, no
  brief, no commit is created to justify it.

**Prose-only defers MUST be logged (draft + trigger).** A defer that exists only
in chat or in a checkpoint, with no `.local/` card, is the #1 loss failure mode:
it is invisible to the back end and will not be re-derived. If you cannot make
the defer fit a whitelist tag with a real trigger, that is the signal that it is
not a defer — go back to branch (1) or (2), or decline-and-close it (branch 4)
when the candidate is valid but not justified. A legitimate no-work decision
needs no artifact.

## Falsifiers / anti-patterns (named and forbidden)

- **Rationalization engine** — re-labeling a defer as "resolve later" with no
  this-session landing. BANNED. "Resolve" means LANDS now (a commit ref this
  session). A "resolve later" with no commit is output (3) in disguise and is
  refused. This bans parking, not closure — a decline-and-close (output 4) is
  terminal, parks nothing, and is not this falsifier.
- **Busy-work** — rush-resolving a `pure-future-watch` whose trigger has not
  fired, or forcing a `blocked-on-sibling-slice` to land before the sibling.
  Respect the block. The bias toward (1)/(2) is not a license to ignore a real
  whitelist tag.
- **Loophole via operator-reserved-signoff with no attached brief** — the
  `operator-reserved-signoff` tag requires the enabling brief to be DONE and
  attached. A sign-off deferred with no brief is invalid.
- **Gate-weakening** — lowering edit-review or ownership classification "to
  resolve it." BANNED. The gate stays; the resolution routes around it
  legitimately (a real edit still reviewed) or drives to verdict, never through
  a weakened gate.
- **Re-defer churn** — re-parking the same card across releases. This is decay
  in motion: it is flagged (see scoreboard) as evidence the gate is not biting,
  not accepted as routine.
- **Decline-as-dismissal** — using decline-and-close to wave off mandatory
  correctness, security, safety, or acceptance work as "low-value" or "too
  costly", or re-labeling a must-fix defect as an "optional improvement" to
  make it declinable. BANNED. Mandatory requirements are never declinable; a
  finding being costly to implement does not make it optional.
- **Ceremony-for-closure** — manufacturing a task card, brief, or commit solely
  to justify a legitimate decline-and-close. BANNED as compliance theater: the
  decline's record is the inline disposition where the finding arose. The
  trace requirement protects landed/decided/deferred work from silent parking;
  a decline parks nothing and needs no artifact.

## Two-sided health scoreboard (predeclared — read off deterministic observers, NEVER self-report)

The skill predeclares what a healthy front gate looks like. Health is read off
**deterministic observers that already exist** — `check-defer-triggers.mjs` (the
card pile and its trigger states) and git history (whether resolve-now edits
stuck) — **never off the skill's own emitted outputs.** The skill does not
score itself.

| Side | Healthy signal | Decay signal |
|---|---|---|
| **Card-pile side** | the `.local/coordinator/tasks/` pile SHRINKS over time (gate is biting: candidates are being resolved/declined/driven-to-verdict rather than parked) | pile FLAT or GROWING → rationalization engine; re-defer churn across releases |
| **Resolve-now side** | resolve-now edits STICK (low revert rate; the work landed was real) | revert SPIKE → busy-work (rush-resolved pure-future or forced sibling) |

A healthy pilot shows BOTH: the pile shrinks AND resolve-now edits stick. One
side without the other is a falsifier firing: a shrinking pile paired with a
revert spike is busy-work; a flat pile paired with sticking edits is
rationalization (edits land but parking does not shrink because candidates are
still being parked instead of resolved).

These are the pilot's success metrics. They are advisory: a flat or growing pile
does not block a release (the back end still governs release), but it is the
signal that the front gate is not changing behavior and the pilot should be
reshaped or retired.

## S2 record (core promotion NOT authorized)

S2 / core promotion is NOT authorized by this skill. The eight S2 evidence
classes remain unmet until a real pilot runs and records positive evidence:
real repeated trigger, classification precision, whitelist-tag fidelity
(cards actually carry the tag they claim), falsifier detection, resolve-stick
rate, pile-shrink rate, false-positive and recovery behavior, and authority
containment. This skill only AUTHORS the pilot; it does NOT run a full pilot and
does NOT score S2.

## References

- `references/runbook.md` — worked examples of each of the four legal outputs,
  each of the four whitelist tags, and each falsifier.
- `researches/decisions/2026-11-02-post-review-decision-quality-disposition.md`
  — the successor decision memo: corrects the disposition contract to four
  legal outputs (adds decline-and-close) and records the accepted canon drift.
- `researches/decisions/2026-08-02-resolve-first-defer-processing.md` — the
  HISTORICAL design spec and decision memo of the original three-output design;
  its disposition-contract section is superseded by the 2026-11-02 memo on
  exactly that point.
- `researches/decisions/2026-07-30-defer-liveness-release-gate.md` §F1-D1 — the
  empirical decay evidence the philosophy cites.
- `researches/decisions/2026-07-24-behavioral-closure-pilot.md` — the
  decision-memo shape precedent.
- `.opencode/skills/contract-invariant-audit/SKILL.md` — the instruction-only /
  INFORMS-only skill-shape precedent.
