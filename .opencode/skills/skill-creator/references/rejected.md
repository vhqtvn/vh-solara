# Rejected approaches

Records approaches that were considered or tried for this skill and dropped, so future revisions don't re-propose them.

## How to use this file

Append a new entry whenever a revision or creation attempt is dropped. Keep entries short: approach, why rejected, date, and a pointer to any detail memo.

## Automated skill optimization loop (SkillOpt-style)

- **Approach:** Run an automated optimizer that treats `SKILL.md` as trainable state, proposing and scoring edits across a task suite.
- **Why rejected:** No scorer/verifier exists for our judgment-shaped skills, no scored task suite or held-out selection split, and no headless batch runner. Also conflicts with the advisory/read-when-relevant philosophy (AGENTS.md, `vh-agent-harness docs opencode-skills`). The borrowable discipline ideas (bounded edits, strictly-improves-or-reject gate, rejected-approaches record) are encoded as the manual "Revision discipline" section in `SKILL.md` instead.
- **Date:** 2026-06-22
- **Pointer:** `researches/decisions/2026-06-22-skillopt-applicability-skill-harness.md` (section 5)
