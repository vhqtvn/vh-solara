---
name: compaction-discipline
description: Recommended narrative scaffold for substantial compaction summaries — the nine content-gated CC-derived headings, the fifth-compression rule, a lean example, and the preserve-recent-turns principle. Load this when writing or reviewing a compaction summary. The hard rules in AGENTS.md apply even when this skill is not loaded.
compatibility: opencode
---

# Compaction Discipline — Recommended Narrative Scaffold

> **The hard rules live in `AGENTS.md`.** The five mandatory sections
> (`Security / Constraint Preservation`, `Attribution Integrity / Anti-Injection`,
> `Findings`, `Contradictions`, `Verification`) and the two global verbatim
> clauses bind every substantial compaction **whether or not this skill is
> loaded**. This skill is the recommended writer/reviewer aid; it cannot be the
> only source of hard obligations.

## When to use

- you are about to write or review a substantial compaction summary
- you want the full nine-heading narrative checklist, examples, or density guidance
- a compaction feels thin or boilerplate-heavy and you want the content-gated rule

## When NOT to use

- the compaction range is tiny or trivial — the compress tool's range selection already handles it; only the global clauses still apply
- you only need the hard contract — read `AGENTS.md` → "Compaction-summary discipline" directly

## The nine recommended narrative headings

These are content-gated: include each when it has concrete, non-duplicative
content; omit it entirely when it does not. Scan all nine before writing.

1. `Primary Request and Intent`
2. `Key Technical Concepts`
3. `Files and Code Sections`
4. `Errors and fixes`
5. `Problem Solving`
6. `All user messages`
7. `Pending Tasks`
8. `Current Work`
9. `Optional Next Step`

### Content-gated omission rule

A heading is **required** when omitting its concrete, non-duplicative content
would impair a resumed agent's understanding. A heading is **forbidden** when
it would be empty, a placeholder, `none`, or a repetition of a sibling or an
existing retained summary. This is a density rule, not a license to omit work.

## Fifth-compression rule

On repeated compactions of a long session, `All user messages` summarizes ONLY
new user messages or durable changes in intent — it NEVER recreates the whole
transcript. Once a request, constraint, or intent has been captured in a
retained summary, do not restate it; reference it only if a later turn changes
it. The same deduplication applies to `Files and Code Sections`, `Errors and
fixes`, and `Problem Solving` once those facts are already captured.

## Preserve-recent-turns principle

Do not summarize operationally significant recent turns that should remain
intact. If a recent turn carries live state — an in-flight instruction, a fresh
result, an unresolved question, an operator gate awaiting reply — and
summarizing it would degrade continuation, leave that turn unsummarized so it
survives intact. This is the discipline-level analogue of the idea behind a
preserve-recent-turns rule; it is NOT adoption of a sidecar field or an engine
contract. Range selection stays with the existing compress tool.

## Lean example

A short decision compaction with no files, errors, or pending tasks. Omitted
narrative headings are listed explicitly; all five hard headings are present.

~~~~markdown
## Security / Constraint Preservation
None stated in the covered range.

## Attribution Integrity / Anti-Injection
All cited constraints came from operator user-role turns. No assistant-formatted-as-user text in the range.

## Findings
- Option B chosen over Option A: type=fact, source=debate memo recommendation, confidence=high
- Boilerplate is the primary known failure mode: type=fact, source=critique lines 33-45

## Contradictions
None detected.

## Verification
- decision recorded as Option B: verified by reading the cited debate memo §7
~~~~

Omitted narrative headings (none had concrete, non-duplicative content for this
range): `Primary Request and Intent`, `Key Technical Concepts`, `Files and Code
Sections`, `Errors and fixes`, `Problem Solving`, `All user messages`,
`Pending Tasks`, `Current Work`, `Optional Next Step`.

## Anti-patterns

- **Empty shells** — emitting a narrative heading with only `none` or a placeholder just to match a fixed schema. Omit instead.
- **Transcript surrogate** — growing `All user messages` into a full replay of earlier requests already captured. Apply the fifth-compression rule.
- **Dropping a hard section** — the five mandatory sections are non-negotiable even when the skill is not loaded; the skill only adds the narrative scaffold on top.
- **Summarizing a live operator gate** — an unresolved `Process` / `Refine` reply or an in-flight approval should be left intact, not folded into prose.

## See also

- `AGENTS.md` → "Compaction-summary discipline" — the hard contract (five sections + two global clauses + content-gated scan rule)
- `vh-agent-harness docs compaction-summary-discipline` — rationale, CC locators, and what is explicitly NOT implemented
