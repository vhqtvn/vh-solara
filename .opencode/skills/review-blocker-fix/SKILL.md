---
name: review-blocker-fix
description: Bounded procedure for fixing an isolated commit-review BLOCKER — use this when a commit-reviewer response returns blocked or split with named findings (e.g. "fix exactly finding F1, then hold for re-review"), when you are dispatched a "fix the review findings on slice X" bug-fix slice, or when re-reviewing a previously blocked change. Not for open-ended refactors, new features, or disagreements about review verdicts.
compatibility: opencode
---

# Review-Blocker Fix

Bounded loop for the stereotyped "review said BLOCK, fix exactly the named
findings, hold for re-review" dispatch (~8% of build work in the 2026-08-15
adoption audit). The virtue is SCOPE DISCIPLINE, not speed.

## Authority boundary

This skill is **advisory workflow only**. It grants no transition authority:
no gate approvals, no git mutations (all git writes stay with the `committer`
agent through the commit gate), no permission changes. A re-review pass is
always requested through the normal commit-review flow, never self-granted.

## When not to use

- The finding alleges a design/ownership problem, not a code defect — route
  back to the coordinator instead of patching around it.
- Findings from TWO different slices are tangled in one working tree — split
  first (coordinate with the dispatching session); do not fix across slices.
- You disagree with a finding — record the disagreement and STOP; never
  silently skip a named finding.

## Procedure

1. **Restate the findings as a checklist.** Copy each named finding verbatim
   into a local checklist with its file/scope. *Done when every finding from
   the reviewer response has a checklist entry.*
2. **Establish the red signal FIRST** (debugging-loop discipline). For each
   finding, name the command or observation that currently demonstrates the
   defect (a failing check, a reviewer-cited invariant, a repro). If no
   observable signal exists for a finding, flag it to the dispatcher as
   "not-demonstrable" instead of guessing a fix. *Done when each finding has
   either a red signal or a recorded not-demonstrable flag.*
3. **Fix exactly the named findings — nothing else.** No drive-by refactors,
   no scope expansion, no "while I'm here" edits. If a correct fix requires
   touching files outside the reviewed slice, STOP and report the scope
   expansion to the dispatcher for a re-scope decision. *Done when the diff
   maps 1:1 onto the checklist.*
4. **Add or update the regression verification** each finding implies
   (narrowest verified seam for the touched surface — follow the repo's
   testing-seam localization, e.g. AGENTS.md "The eight lanes" in this repo).
   *Done when each fixed finding has a verification that fails on the
   pre-fix state.*
5. **Re-verify the slice** with the same commands the original review used,
   plus the new regression checks. *Done when all commands pass (or a failure
   is escalated with its receipt).*
6. **Hold for re-review.** Report back: findings checklist with per-finding
   disposition (fixed + receipt | not-demonstrable + reason | scope-expansion
   STOP), files touched, verification commands + outcomes. Do NOT commit,
   merge, or mark the slice completed yourself. *Done when the report is
   returned and the slice is parked awaiting the reviewer.*

## Output shape

Return the checklist table (finding → disposition → receipt), the exact file
list, and the verification command/outcome pairs. Keep it short; the reviewer
re-reads the diff, not your prose.
