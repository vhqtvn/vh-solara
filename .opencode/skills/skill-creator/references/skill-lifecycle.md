# Skill lifecycle rules

Three rules governing how craft skills are structured across the core/overlay
boundary, how overlay pilots reach every consumer by default, and how new core
skills reach `templates/core/`. These are distinct from skill-design craft
(`references/skill-design-vocabulary.md`), which governs content quality within
a skill.

## S1 — Localization split as a first-class pattern

When a craft skill carries repo-specific examples (a debug-loop recipe, a TDD
seam list, an e2e chain template), standardize on:

> **core discipline skeleton + contracted overlay localization file**

The core skill holds the discipline (steps, checks, failure modes) domain-free.
It references a **named localization artifact** for the repo-specific material
(e.g. `<repo>-debugging-loops.md`), and the **absence of that artifact is step 1
of the workflow**: "no localization file found → construct one with the user
before proceeding."

This is the repo's "stub with a contract over premature implementation" default
(AGENTS.md → repo-level engineering defaults), generalized to skills. The core
never hardcodes a repo's hotpaths; the overlay never reimplements the
discipline. A consumer that lacks the localization file gets a clear, actionable
gap instead of a skill that silently assumes the wrong repo.

### Placement — overlay dir mirroring the core skill name

The localization file's recommended home is an **overlay directory mirroring the
core skill name** — `.vh-agent-harness/overlays/<consumer>/skills/<skill-name>/<repo>-<localization>.md`,
holding only the localization file (no `SKILL.md`). Per the overlay merge model
documented in `.opencode/commands/harness.md` (→ Overlay anatomy / Shadowing
rule: overlays ADD new units and render 1:1 into `.opencode/skills/`; they do
not shadow-and-replace a core builtin), the core's `SKILL.md` and `references/`
survive byte-identical and the localization file lands as a sibling — no shadow,
no drop. This placement has been validated in practice via
`vh-agent-harness update --dry-run` and a real `update`.

## S2 — Overlay-pilot-then-promote

A new core skill MUST pilot in at least one overlay against a real repo before
promotion to `templates/core/`.

Rationale: `templates/core/` ships into every consumer's baseline context-load
(see `references/skill-design-vocabulary.md` → The two loads). A half-baked skill
promoted too early taxes every consumer's context whether they use it or not.
Piloting first proves the trigger surface, completion criteria, and failure-mode
coverage against a real workload. This dovetails with the existing `--dry-run`
preview discipline and the domain-free-core rule (AGENTS.md): pilot, observe,
then promote only what survived.

### Stable hold-ID + evidence-record contract (release-relevant state)

S2's "held for pilot" state is release-relevant: a release-readiness gate must
be able to discover, from canonical records alone, whether a held skill's pilot
has landed. Rather than redesigning S2, pin a two-surface contract that any
release gate can cross-check by a stable join key:

- **Canonical backlog row (the hold).** When a skill/design is held under S2,
  create a tagged row in the project's canonical backlog carrying a STABLE HOLD
  ID of the form `s2-hold: S2-<skill>-001` — the `s2-hold:` token prefix is what
  a release gate enumerates rows by. This row is authoritative for "a strict S2
  hold exists." The row's **Links column** carries the evidence-packet path
  (repo-relative `researches/sources/<file>.md`) so the gate can follow the
  reference without scanning every packet by prose.
- **Evidence packet slot (the verdict).** In the project's evidence/research
  packet, create a slot joined to that SAME stable hold ID, carrying a verdict
  of `PENDING`, `SATISFIED`, or `WITHDRAWN`. This slot is authoritative for
  "the pilot succeeded" (or, for `WITHDRAWN`, "the hold was explicitly
  withdrawn").

#### Machine-parseable record grammar

The evidence slot is a machine-parseable record so the deterministic gate can
read it without prose heuristics. ONE record per hold, anchored by a heading
the parser discovers, with delimited fields:

```
### S2 hold: S2-<skill>-001
- Verdict: PENDING | SATISFIED | WITHDRAWN
- Skill: <skill-slug>
- Pilot: <repo> (retrospective)
```

- `### S2 hold: S2-<skill>-001` heading — the parser discovery anchor
  (heading-level; the stable hold ID is case-sensitive `S2-<slug>-NNN`).
- `- Verdict:` line — the delimited verdict field. The closed enum is
  `PENDING | SATISFIED | WITHDRAWN` (the `|` here is metavariable OR-notation;
  exactly one value is recorded).
- `- Skill: <skill-slug>` — the held skill. Required for every record (the held
  skill is known at hold-creation), and MUST equal the `<skill>` encoded in the
  hold ID (`S2-<skill>-NNN` → the slug between `S2-` and the final `-NNN`). A
  mismatch is an evaluator-error: the evidence is about a different skill than
  the held one.
- `- Pilot: <repo> (retrospective)` — the pilot provenance, where the
  parenthetical is either `(retrospective)` or `(forward)` (a literal value,
  not a pipe expression). Required for `SATISFIED` (the pilot landed, so it must
  be identified). Optional for `PENDING`/`WITHDRAWN`.

The backlog row side is the `s2-hold: S2-<skill>-001` token in the **Notes**
column plus the evidence-packet path in the **Links** column. The two surfaces
join by the STABLE HOLD ID — never narrative prose.

#### Applicability universe

The gate enumerates BOTH the active backlog and the archive, joined by stable
hold ID over the UNION, with a single-record / single-verdict invariant:

- **Active:** `docs/planning/backlog.md` (all task sections — Now/Next/Later/
  Done/Cancelled).
- **Archive:** `docs/planning/archive/backlog-archive-*.md` (files matching
  `backlog-archive-(YYYY-q[1-4]|undated).md`).
- A stable hold ID MUST appear exactly once across the union on each surface
  (exactly one backlog row, exactly one evidence record). Duplicates, a missing
  join, or a zero/>1 match are structural failures the gate refuses.

#### cancelled / WITHDRAWN fail-closed semantics

A `cancelled` backlog row carrying `s2-hold:` is ambiguous (did the hold get
withdrawn, or was the row cancelled for an unrelated reason while the token
lingered?). The gate fail-closes on this: a cancelled row with an `s2-hold:`
token BLOCKS until resolved by EITHER

- (a) removing the token (explicit withdrawal — the row no longer claims a
  hold), OR
- (b) a matching evidence record with `Verdict: WITHDRAWN`.

`cancelled` + `WITHDRAWN` is the one clear disposition for a cancelled hold;
`cancelled` + any other verdict (or a missing record) is a structural
(evaluator-error) refusal.

#### Deterministic enforcement

A deterministic evaluator (`check-s2-holds.mjs`) ships from `templates/core/`,
so every consumer receives the evaluator AND this machine-parseable contract.
This repository's release-tag wrapper invokes it authoritatively at tag time
as the G6 gate; a consumer that wires its OWN release wrapper to the same
evaluator gets the same enforcement. The readiness agent consumes the same
contract ADVISORY; the wrapper re-derives G6 AUTHORITATIVELY from the committed
state bound to the exact commit being tagged (HEAD_SHA, never the moving HEAD
ref and never the worktree). A release refuses while any hold is `PENDING`,
while the two surfaces disagree on resolution state, or while the inputs are
structurally invalid — and no override cures an S2-hold block.

Lifecycle of the hold:

1. **On hold:** create the tagged backlog row (token in Notes, packet path in
   Links) + a `PENDING` evidence record, both carrying the same stable hold ID.
2. **On pilot landing:** add real pilot provenance (which repo, which workload,
   what was observed) + positive evidence to the record, then set its verdict
   to `SATISFIED` (with the required `- Pilot:` field).
3. **On resolution:** only AFTER the record is `SATISFIED`, resolve (close) the
   backlog row. To WITHDRAW a hold instead, set the record to `WITHDRAWN` and
   cancel the backlog row (the gate treats `cancelled` + `WITHDRAWN` as clear).

## S3 — Shipped default-on overlay pilot

A skill may ship as an embedded overlay pack (`templates/overlays/<pack>/`)
that is **default-enabled for every consumer** and **consumer-disable-able via
`features: <feature-key>: false`** in the profile. This is a middle tier
between a project-local overlay pilot (no distribution beyond the authoring
repo) and an S2 core skill (promoted to `templates/core/`).

### Why this tier exists

The S1/S2 vocabulary previously had no middle tier: a skill was either a core
skill (`templates/core/`, loaded into every consumer's baseline context-load)
or an overlay pilot (opt-in via explicit `overlays:` selection). There was no
term for a skill that is embedded in the binary, enabled for all consumers by
default, yet consumer-disable-able and still owned by `overlay_extension`
rather than `platform_managed`. That vocabulary gap is why three pilots
(formal-verification, resolve-first, contract-invariant-audit) landed
project-local by accident — the placement fell out of the missing vocabulary
rather than being a chosen destination. S3 names that destination so the next
pilot's placement is a decision, not an accident. See
`researches/decisions/2026-08-04-opt-out-pilot-distribution.md`.

### Properties

- **Embedded**: the pack source lives in `templates/overlays/` and ships in
  the binary via `go:embed`.
- **Default-enabled**: the platform-default profile sets the feature key to
  `true`; a consumer with no explicit `overlays:` entry still receives the
  skill.
- **Consumer-disable-able**: setting `features: <feature-key>: false` stops
  future staging/management of that pack. An explicit `overlays:` entry
  intentionally re-adds it (the `false` disables the default, it is not a
  global veto).
- **`overlay_extension`-owned**: rendered output is `overlay_extension`, not
  `platform_managed`. Doctor's managed-drift check does not cover it; a
  deselected-but-previously-rendered skill is an advisory orphan, never a
  health failure.
- **Strictly INFORMS-only**: the skill carries instructions only. It wires NO
  permission, NO agent, NO command, NO gate. Default-on distribution changes
  REACH, not authority.

### What S3 is NOT

S3 is NOT S2 promotion. A shipped default-on overlay pilot remains under the
S2-hold:

- no move into `templates/core/`;
- no removal of the pilot maturity signal (the `-pilot` pack suffix is
  retained);
- no transition or gating authority;
- no claim of validated consumer effectiveness;
- positive real-consumer evidence remains required for core graduation.

Default-on distribution widens the audience that can provide that evidence; it
does not constitute the evidence itself.
