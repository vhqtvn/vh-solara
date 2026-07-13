# Skill-design vocabulary

Shared words for skill-design conversations. Each entry below adds a named
concept; where it overlaps a rule already in `SKILL.md`, the entry points there
instead of restating the rule.

## Root virtue: predictability

A good skill reproduces the same **process** every run — not the same output.
Two runs that reach different artifacts through the same investigation shape,
decision points, and checks are both succeeding. Use this to adjudicate every
choice below.

## The two loads

Every skill costs one of two loads:

- **Context-load** — a *model-invoked* skill's `description` is paid in tokens
  on every turn the model considers it, even when it is never picked. This is
  the *why* behind the existing rules to keep `description` tight on trigger
  phrases and to write sharp "When not to use" sections (both in `SKILL.md` →
  Writing rules). Those rules lower context-load.
- **Cognitive-load** — a *user-invoked* skill costs the human remembering it
  exists. The remedy is discoverability (explicit "use this when…" triggers),
  not more tokens.

Keep the framing, drop the mechanism: there is no "disable model invocation"
flag in OpenCode. The load model only explains what a tight description buys.

## Information-hierarchy ladder

Material lives on one of three rungs:

1. **Step** (in-skill, primary) — a numbered action that ends on a **completion
   criterion**: a checkable condition ("the file exists and validates"), not a
   verb ("validate"). A step without a criterion hides where one run can stop
   early and another continue.
2. **Reference** (in-skill, on-demand) — durable detail under `references/`,
   loaded only when a step points at it. This is the existing "push detailed
   material into `references/`" rule (`SKILL.md`, `references/workflows.md`);
   the ladder only names the rung.
3. **External reference** (out-of-skill) — behind a **context pointer**: a
   one-line citation that does not inline the content.

**Branch-licensing.** A branching step inlines what *every* branch needs and
discloses (pushes one rung down) what only *some* branch needs. Licensing detail
to the wrong rung is how steps bloat (all inlined) or go skeletal (all pushed
down, none actionable).

## Co-location

Keep a concept's definition, rules, and caveats under **one heading**, at the
rung it lives at. A step-level concept stays inline in the step; a
reference-rung concept is co-located in its reference file.

This composes with — it does not contradict — the "push to `references/`"
instinct. That rule moves *whole rungs down*; co-location says that once you
pick the rung, all of the concept lives there together. Do not split a concept's
definition from its caveats across files.

## Leading words

A few compact pretrained words — *red*, *seam*, *tracer bullets*, *fog of war*
— recruit a large region of prior behavior in few tokens. Prefer a leading word
with a one-line gloss over a paragraph that rebuilds the concept from scratch.
A word earns its place only if the priors it recruits are the ones the step
needs.

## Six failure modes

Named so revisions can cite what they fix.

- **Sediment** — stale accumulation; the default fate of a skill only ever
  added to and never pruned.
- **Sprawl** — too long, even if every line is unique. (The sizing instinct in
  `SKILL.md` already guards this; the name lets you cite it.)
- **No-op** — a line the model obeys by default. It fails "does this change
  behavior?" Restating obvious general knowledge is the common form.
- **Negation** — a prohibition that backfires ("don't think of an elephant").
  Prompt the positive behavior instead.
- **Duplication** — the same meaning in two places, *including within one
  skill* (a concept in a step and again in a reference). The between-skills case
  is already covered by the "When not to use" / overlap discipline (`SKILL.md`);
  the within-skill case is the additive one.
- **Premature-completion** — a step that ends before its completion criterion is
  genuinely met.

## Pruning test

An active pass, distinct from the strictly-improves-or-reject *acceptance* gate
(`SKILL.md` → Revision discipline, which governs accepting an edit). This
governs *removing* lines. Run it as a sentence-level no-op hunt:

> For each line, ask: *does this change behavior?* If not, cut it.

The six failure modes are the targets: sediment is what you remove; no-op and
duplication are how you find candidates; the pass is how sprawl is reversed.
