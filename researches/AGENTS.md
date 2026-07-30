# researches/ — durable research material convention

> This file is the convention doc for the `researches/` tree referenced from
> `AGENTS.md` ("Read when relevant"). It is a **descriptive observed-practice
> guide**, derived from the materials already in this tree — not a newly invented
> policy. When the corpus changes shape, update this file to match reality rather
> than forcing the corpus to match the doc.

## What lives here

Two sub-trees, each with a distinct purpose and a slightly different house style.
Both are **durable, read-only study artifacts** (no code is executed to produce
them; claims are cited to source, not run). Neither is active repo policy on its
own — they are the evidence base that *informs* a later build/fix.

- **`researches/sources/`** — source packets. Study of an **upstream or external**
  subject (e.g. `sst/opencode` at a pinned tag, a wire shape, a provider
  behavior). The output is a citable evidence trail backing a vh-solara
  implementation or contract. Examples:
  `opencode-unarchive-patch-audit.md`, `opencode-sqlite-unarchive-spec.md`,
  `opencode-v1.17.18-messageid-exact-lookup.md`, `opencode-toks-source-packet.md`,
  plus session/scroll/UI studies.
- **`researches/decisions/`** — decision-shaping memos. Study of a **vh-solara
  internal** design question (stale-data indicators, regression causes, build
  distribution). The output is a options map + recommendation that a later
  debate/planner/build consumes. Examples:
  `stale-and-latency-indicators.md`, `server-slow-regression-seedColdLastAgents.md`,
  `session-load-residual-speedups.md`, `dist-build-hybrid-findings-93dfcd1.md`.

## Shared backbone (both sub-trees)

Regardless of sub-tree, a good packet/memo carries:

- A **research question or mission** stated up front (one or two sentences), so a
  reader knows what the artifact is answering before reading the body.
- An explicit **source policy / scope**: read-only study, no repo or upstream code
  executed, scratch kept under `tmp/agent-runs/`. Every path/behavior claim is
  cited to its source at the exact tag/commit.
- **`file:line` citations** to *both* the upstream source (permalinked to the tag)
  *and* the vh-solara consumer code that already implements or depends on the
  fact — so the packet doubles as a coupling trail (upstream fact → vh-solara
  consumer). Example: `pkg/opencode/id.go` + the upstream `packages/opencode/src/id/id.ts`.
- A **Findings** section, with each finding tagged
  `source=…, confidence=high|medium|low, type=fact|assumption|inference`.
- A **Contradictions** section — explicit, never silently omitted. Write
  "None detected." when there are none; otherwise name each contradiction and its
  resolution. (Existing packets model this; e.g. the unarchive packets record
  fixture-vs-real and issue-claim-vs-source contradictions.)
- A closing disclaimer that the artifact **is the evidence base, not active repo
  policy**, plus a "recommended next specialist / command" pointer
  (`planner` → `build`, or a `/solution-brief`) for whoever consumes it.

## `sources/` house style (observed)

Two header forms are both in use — pick whichever the neighboring packets use, or
whichever fits the artifact:

1. **Blockquote header** — a `>` blockquote right under the `# Title` carrying:
   "Source packet. Read-only source study of `<repo>` tag **<tag>** …", the
   no-code-executed statement, a SCOPE line, and a
   `NOTE: Promoted from tmp/agent-runs/<researcher>/ to researches/sources/<file>.md`
   line. See `opencode-unarchive-patch-audit.md`, `opencode-sqlite-unarchive-spec.md`,
   `opencode-v1.17.18-messageid-exact-lookup.md`.
2. **YAML frontmatter** — a `---` block with `research_question`, `scope`,
   `confidence`, `date`, `time_sensitive`, `source_policy`, `artifact_type`.
   See `opencode-toks-source-packet.md`.

The body is then sectioned (## 1. …, ## 2. …) and typically includes:

- A **CONFIDENCE + GAPS** table (Finding / Confidence / Type / Basis), with an
  explicit "Gaps / not verified" subsection naming what was NOT checked.
- A **Promotion targets** list naming the *live* docs/code to update once a fix
  lands (this packet is NOT those updates — it is the evidence that justifies
  them). Example: `docs/architecture/coordination-api.md`, `pkg/fixtures/opencode.go`.

## `decisions/` house style (observed)

- `# Title` → `## Context` (the triggering problem, with `file:line` on `main`) →
  `## Findings (file:line on main)` → `## Options` (each option lettered, with a
  bolded **Recommendation**) → `## Open forks (need a human/debate call)`.
- Cite `file:line` against the current `main` branch (these are internal studies,
  so they reference vh-solara code directly, not an upstream tag).

## When to create vs update

- **Create** a new packet/memo when a build/fix needs an evidence trail or a
  design decision that will outlive a single session (re-validation on a version
  bump, a contradiction audit, an options comparison). Promote it from
  `tmp/agent-runs/<researcher>/` once it is durable.
- **Update** an existing packet when its cited upstream tag is re-validated, a
  contradiction is resolved, or a promotion target has landed (record the
  resolution; do not silently delete the contradiction).
- This doc itself is descriptive: if the corpus adopts a new convention, edit
  this file to reflect it rather than treating this file as a gate.
