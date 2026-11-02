# Record Lifecycle (card / DEFER)

> **Term contract.** "Agent harness" is a **HANDLE ONLY**. This doc carries the
> **Coordination** layer (routing/tracking/handoff of work).

This is the canonical lifecycle for **transport cards** — work tracked under
`.local/coordinator/tasks/` (implementation, study, research, DEFER,
p2-followup). It codifies six rules so the holding area stays a **drain**, not
a reservoir:

1. **Drain flow.** Work cards directly from transport. No backlog row is
   created before or after by default.
2. **Promotion is exceptional.** A card gets a `docs/planning/backlog.md` row
   ONLY when it crosses a named boundary (below). Backlog is a status ledger,
   not a record store.
3. **Retire timing is landing-gated.** A `completed` card is deleted only AFTER
   the commit-gate confirms the work landed. Never on review approval alone.
4. **Done cards are deleted.** A `completed` card lingering in transport
   corrupts the count signal; the lifecycle retires it, not parks it.
5. **The landing commit is the durable record.** The reachable commit carrying
   the card id is the record. Checkpoints are reserved for campaign closeouts
   or reopenable decisions. No tombstones, no done-rows.
6. **Intake has a bar.** Drain rules do not stop re-growth. A card is filed only
   after admission (resolve-first / admitted-value), not on every surfaced
   finding.

The holding area is **transport, not truth**. Unpromoted and unretired cards
may be lost — that is intentional, because they are not trusted work yet. Do
not create a parallel committed ledger for them.

## The lifecycle

```
intake (admission bar)
   │   resolve-first / admitted-value BEFORE filing
   ▼
transport work   (.local/coordinator/tasks/, status: draft → ready → working)
   │
   ├── boundary? (blocked / owner-change / must-survive-session)
   │     YES → promote ONE backlog row (exceptional side path)
   │     NO  → keep draining in transport
   ▼
review           (commit-reviewer, separate predicate from landing)
   ▼
landing          (commit-gate commits; commit carries `Task-Card: <card-id>`)
   ▼
retirement       (card deleted AFTER landing confirmed reachable)
```

### Intake (admission bar)

A card is filed only when it passes admission. Before filing, answer:

- **Precise question** — the work can be stated as a sharp question now (fog is
  NOT a ticket; see the fog-vs-ticket test below).
- **Concrete area + file/subsystem scope** — names the repo boundary and the
  files it concerns.
- **Validation approach** — how "done" will be checked.
- **An ADMITTED BLOCKER or reason the work cannot be resolved now** — for
  deferred work, the reason it cannot be done in the current session.
- **A ground-truth-derivable trigger** — when deferral is trigger-dependent, a
  predicate the checker can re-derive from repo state
  (`path_touched(<path>)`, `after_tag(<tag>)`, …).
- **Provenance** — where the candidate came from (`source:review-defer`,
  `source:p2-followup`, …).
- **Dedup** — no materially-equivalent open card already exists.

Disposition at intake (apply the `resolve-first` classifier):

- **Resolvable now** → resolve it; do NOT file.
- **Decision-derivable now** → drive to a verdict; do NOT defer.
- **Real deferred work meeting the bar** → file as a `draft` transport card.
- **Duplicate / fog** → collapse into the existing card, or discard.

### Fog vs ticket (triage test)

A finding is **ticket-ready** when you can state the question precisely now —
even if blocked. A finding is **fog** when you cannot yet phrase it that
sharply: in-scope, but not yet specifiable. Fog belongs in transport only while
it sharpens; it is promoted or retired, never left to accumulate as noise.

## Promotion (exceptional side path)

The default is to drain resolved transport directly. A card is promoted into a
`docs/planning/backlog.md` row ONLY when it crosses one of these boundaries:

- **Blocked** — the card cannot progress without an external decision or owner
  input, so its blocked state must outlive the session that discovered it.
- **Owner-change** — responsibility moves to another session/operator, so the
  row is the handoff artifact.
- **Must-survive-session** — the work is longer than one session and the
  durable status ledger (not the transport card) is the right home for its
  state.

A promoted row carries the card's stable ID in its Notes so the join is
auditable. Promotion does NOT retire the transport card — the card is retired
on landing (below), not on promotion. Conflict discipline for promoted rows
(re-read + re-apply + retry on `could_not_land`, never blind-revert) lives in
the `backlog` skill and the `PROMOTER_RUNBOOK`.

Backlog is a **status ledger**, not a record store: a promoted row tracks live
status, not a durable history of completed work. The durable record is the
landing commit.

## Review approval and landing are DISTINCT predicates

- **Review approval** — `commit-reviewer` returned `approve` for the slice.
  This means the change is acceptable to commit. It does NOT mean the change
  landed.
- **Landing** — the commit-gate committed the slice and the resulting commit is
  reachable from a branch (any local branch tip — see the landing-proof
  contract below).

A card is retired as `done` only on **landing**, never on review approval
alone. The 2026-08-07 lesson: a card was deleted on review approval alone and
the commit later failed to land, so the work was lost from the record while the
gate reported failure. Review approval is necessary but not sufficient.

## The landing-proof contract

A `completed` card may be retired as done ONLY when a commit carrying the exact
`Task-Card: <card-id>` trailer line is reachable from a branch. The verifier is
a **reachability** check (per the closure-verifier reachability rule — never
object existence):

```
git log --branches --fixed-strings --grep=Task-Card: <card-id>
```

The `--grep` is a substring pre-filter; the verifier then post-filters each
candidate commit's body to a line EXACTLY equal to `Task-Card: <card-id>` (a
`Task-Card: alpha-next` line does NOT satisfy card `alpha`). ≥1 exact, reachable
match means the work landed and the card may be retired. 0 matches means the
work has NOT landed; the card MUST NOT be retired (it stays `completed`, and if
the commit failed it is re-driven).

- **Branch scope.** `--branches` walks ALL local branch tips (`refs/heads/*`)
  — branch-GENERIC with no hardcoded `main` (mirrors doctor #24's
  `git rev-list --branches`); a match proves BOTH landing AND reachability in
  one query. The choice is deliberately broader than a single integration
  branch: it avoids bricking retirement on a stale/wrong gate-reported branch
  name, and a card is local transport (gitignored), so a premature retire is a
  local self-footgun, not a system-integrity breach. The singular `<branch>`
  notation used in earlier drafts is realized branch-generically by `--branches`.
- **Exact trailer line.** A commit body carries one `Task-Card: <card-id>`
  line per card the commit satisfies. The verifier matches the line exactly
  (trimmed equality), not as a substring — prefix collisions (`alpha` vs
  `alpha-next`) do not authorize the shorter id.
- **Committer is pass-through.** The committer agent does not rewrite the
  commit message, so the trailer MUST originate in the `commit-message` draft
  — it cannot be gate-appended today.
- **Future hardening (NOT v1).** A gate-appended trailer and a gate-ledger
  card-id→commit join are documented future-hardening, not the v1 contract.

## Retention preservation (decision records)

Landing proof says the work LANDED; it says nothing about whether
**decision-class knowledge** — owner authorizations, materially-rejected
alternatives, non-approve review verdicts, measured outcomes — SURVIVES
retirement. Retiring a completed card deletes the card AND its report
directory, the last local copy of that knowledge. The retention-preservation
gate (owner-approved 2026-10-25; v2 coverage 2026-10-26; **v3
item-enumerated replacement owner-approved 2026-10-27**) makes ordinary
retirement conditional on that knowledge being verifiably preserved in
committed git state.

### The decision_record (v3: one slot per decision item)

Every closeout saved under the current gate declares ONE fenced
```decision-record` JSON block (see CLOSEOUT_TEMPLATE.md). The record is an
**item-enumerated inventory**: the gate mechanically enumerates the card's
decision ITEMS — every non-empty owner note, every non-empty
`open_questions` entry, `measured_outcome`, and every NON-PROCESS review signal
(`last_review` / `task_reviewed` whose status is not `completed`;
scanned per event) — and the record declares **one slot per item**:

| Slot field | Meaning |
|------------|---------|
| `id` | the CONTENT-BOUND item identity: `owner_notes[fnv1a:<hash>]`, `open_questions[fnv1a:<hash>]`, `measured_outcome[fnv1a:<hash>]`, `last_review[fnv1a:<hash>]`, `task_reviewed[fnv1a:<hash>]` — `<hash>` is an FNV-1a digest of the item's own text; duplicate identical items carry a per-content occurrence suffix (`.2`, `.3`, …; never array position). Reordering items changes no id; replacing an item's text in place mints a new id and refuses at retirement until declared |
| `disposition` | `verbatim` \| `curated` \| `sanitized` — how the item is represented in its carrier |
| `carrier` | `{kind:"commit",revision?}` or `{kind:"artifact",path,revision?}` — where the representation lives. There is deliberately **no inline carrier**: content only in the local closeout report is not durable |
| `handle` | the per-item representation: for `verbatim`, a verbatim single line drawn from THAT item's own content (≥ 24 chars, whitespace-normalized containment — the retained excerpt core); for `curated`/`sanitized`, EXACTLY the canonical label `decision-item: <task-id>#<item-id> (<disposition>)` |
| `provenance` | required for owner-decision items and sanitized items: who, when, where recorded. For curated/sanitized it must be a **cited reference**, never an invented or AI-paraphrased owner statement |

An **empty `items` array is the routine attestation** — valid exactly when
the card carries no decision items (routine work, clean review): zero
ceremony. `revision` omitted on a carrier means *search mode* (reachable
commit messages / reachable revisions of the path); a declared `revision` is
verified precisely.

### Item-to-carrier binding (content, never presence)

A carrier satisfies an item ONLY if the SAME committed, branch-reachable
carrier contains BOTH:

1. the **card-id anchor** — so a fresh session knowing only the card id can
   find the carrier after the card is destroyed; and
2. **that item's handle** — the verbatim line (verbatim slots) or the
   canonical item label (curated/sanitized slots).

A commit whose body contains only the card id (the landing trailer)
satisfies **nothing**. A handle floating in an un-anchored carrier satisfies
nothing. Each slot names its own carrier; several slots may share one.

**Mechanical vs semantic — what the gate proves:**

| Disposition | Mechanical guarantee (gate) | Semantic ceiling (author + reviewer) |
|-------------|-----------------------------|--------------------------------------|
| `verbatim` | a length-floored line drawn from the item's own text is present, with the card-id anchor, in a committed, branch-reachable carrier | whether that line carries the SUBSTANCE of the item (the authoring pattern — full decision text in the landing commit body — closes the gap in practice) |
| `curated` | the canonical item label is present, with the anchor, in a committed carrier — labeled content sits there | whether the labeled content is a USEFUL, faithful curation (what was decided/rejected, why it mattered, key constraints, where authority came from, deliberate omissions) |
| `sanitized` | same label-scoped check as curated | same — plus whether the sanitization honestly withheld only what it had to (provenance must name what was omitted and the authority for it) |

A mechanically valid representation is **never** proof the meaning was
preserved. If no safe, meaningful representation can be produced for an
item, do NOT fake one — leave it undeclared: closeout/retirement refuses and
surfaces the item, and the documented operator force path is the emergency
exit.

### Inventory baseline across the lifecycle

The **stored record is the baseline item inventory**:

- At **closeout**: every decision item on the card must have a declared slot
  (no missing slots — the primary concern-1 fix: two owner notes cannot be
  covered by one excerpt); no surplus slots; verbatim handles must bind to
  their OWN item's text.
- **Sanctioned amendment is ADD-ONLY**: a re-closeout (an existing,
  history-logged lifecycle op) may declare the stored slots **verbatim** plus
  fresh slots for NEW items (e.g. a post-closeout blocked review). Dropping
  or rewriting a stored slot is refused at closeout — there is no free JSON
  editing of the inventory. Routine tasks with clean reviews hit **zero
  ceremony** (empty inventory, retire normally).
- At **retirement**: any decision item present on the card but NOT in the
  record is a **new-item mismatch** → refusal naming the item (the remedy is
  the add-only re-closeout). Items **removed** from card fields do NOT
  remove their slots — the baseline still verifies every declared slot's
  carrier, so deletion cannot launder preservation. Because identity is
  content-bound, an in-place content REPLACEMENT (e.g. `/task-update`
  rewriting an owner note after closeout) is exactly this shape: the
  replacement item is undeclared (refused), and the replaced item's slot is
  a kept slot whose carrier still verifies — a sanctioned rewrite cannot
  recycle a stored slot onto different content (the B-F1 laundering chain).
  A benign REORDER of items changes no id (nothing is lost by reordering)
  and passes.
- Review classification (process vs decision) survives from v2: a review
  that resolved the card to `completed` is a **process record** — routine
  tasks retire after a normal review with zero promotion burden; any other
  verdict changed the card's trajectory and is decision-class, scanned per
  history event so a later clean approve cannot launder an earlier blocked
  review. Owner decisions recorded at review time belong in `owner_notes`.

### Retrievability (what a fresh session can find after retirement)

Retirement destroys the card and its decision_record; the surviving anchor
is git itself. A fresh session knowing ONLY the card id recovers per item
with bounded queries:

1. `git log --branches --fixed-strings --format=%H --grep='Task-Card: <id>'`
   → the trailer-bearing carrier commit(s); read each hit's body — verbatim
   slots carry their item text there;
2. for file-carried content: `git log --branches -S'<id>' --format=%H` (the
   pickaxe finds the carrier commit) → `git diff-tree --name-only -r <sha>`
   → `git show <sha>:<path>` — the committed blob carries the anchor plus
   each item's handle: verbatim text, or the honest
   `decision-item: <id>#<item> (curated|sanitized)` label distinguishing
   curated from verbatim in the recovered record.

The card-id **anchor rule** on every carrier is what makes this chain work:
no index, no archive, no tombstone — the anchored commits are the record.

### Refusals at retirement

The retirement path (`delete_coordination_task`, completed branch, after
landing proof) refuses — naming each item — with:

- `decision_content_unpromoted` — a decision item on the card has no slot
  (a post-closeout addition, a routine/empty inventory with items present, a
  legacy card with no decision_record, or a decision-bearing legacy version-1
  record); `refusal.items` names them. Remedy: the add-only re-closeout
  amendment (or promotion of the content), never a hollow declaration.
- `decision_record_unresolved` — a declared slot's carrier does not resolve
  against committed, branch-reachable state (`revision_not_resolvable`,
  `revision_not_reachable`, `path_never_committed`,
  `path_not_tracked_at_revision`, `path_is_directory_not_file_blob`,
  `anchor_missing`, `handle_not_in_carrier`, `anchor_handle_scattered`,
  `verifier_unavailable`), or the stored record is structurally degraded.
  `anchor_handle_scattered` is the split-evidence refusal: the card-id anchor
  and the item's handle each exist somewhere in the carrier path's reachable
  history, but never together in ONE committed revision — a fresh session
  recovering from the anchor-bearing revision would find no representation
  there, so split evidence never verifies.

### Compatibility (legacy + in-flight cards)

- New closeouts (post-v3) require the version-3 block — including
  `blocked`/`reported` closeouts; an empty `items` array is the whole burden
  for routine work.
- In-flight cards (working/reported/blocked) at upgrade are unaffected until
  they close out; the closeout then runs the v3 gate.
- **Stored version-1 records (v1 marker/bare, v2 carries) are honored as
  legacy under the same rule as a card with no decision_record**: retire
  routinely when the card carries no decision items; refuse — with
  re-closeout under v3 as the remedy — when decision items are present. The
  v2 excerpt-coverage machinery is retired and does not run for legacy
  records; this refuses more than v2 did, never less (fail-closed
  migration, one re-closeout of burden for decision-bearing legacy cards).
- Legacy completed-but-unretired cards without a decision_record follow the
  identical rule (refused iff decision items are present).

### Force path and private content

The operator force path keeps its semantics but the destructive warning
NAMES the content about to be destroyed — current decision items and
declared slots (id + disposition per slot). Force still bypasses both the
landing check and the preservation check — it is the explicit emergency
route, and it is the sanctioned path for content that genuinely cannot be
safely represented anywhere durable.

**Privacy rule:** never commit sensitive owner notes merely to satisfy the
gate. Prefer a `sanitized` slot whose provenance cites the authority for
withholding; if no safe, meaningful representation exists at all, leave the
item undeclared — retirement refuses and surfaces it — and use the
documented operator force.

### Honest limits (what this gate does NOT prove)

- **Item enumeration is mechanical** — the classifier sees `owner_notes`,
  `measured_outcome`, `open_questions`, and review signals; decision content
  left in an unlisted home can still be lost, and no gate defends against a
  hostile editor of the gitignored card JSON — the goal is sanctioned-path
  honesty.
- **Representation quality is author honesty** — the gate proves the handle
  (a verbatim, length-floored line of the item's own text, or the canonical
  item label) survived in an anchored, committed carrier; whether the
  recovered content carries the SUBSTANCE of the item is author + reviewer
  judgment. The label-scoped check for curated/sanitized slots proves
  presence of a label, never the fidelity of the content beside it.
- **Local reachability only** — the gate proves LOCAL-repository
  reachability (`git log --branches` / committed blobs). Cross-machine
  availability comes from the normal push/release flow; the gate performs no
  network operations and claims nothing about remotes.

### Legacy

The landing-proof requirement applies to **new cards filed after codification**.
Pre-existing cards in transport at codification time were grandfathered (retired
under the prior convention); since the Slice-2 retirement code landed (commit
`00b5add`), all `completed` retirements are landing-gated regardless of filing
date. The retention-preservation gate follows the same shape: it binds at
closeout-time for new closeouts and at retirement-time (legacy rule above) for
legacy completed cards.

## Records

The **landing commit** (carrying the card id via the `Task-Card:` trailer) is
the durable record of completed work. There are:

- **No tombstones** — retiring a transport card leaves no marker card behind;
  the reachable commit is the record.
- **No done-rows by default** — a drained card is not transcribed into a
  backlog `Done` row. Only cards that crossed the promotion boundary have a
  backlog history row (and the normalizer archives those).
- **Checkpoints only for campaign closeouts / reopenable decisions** — a single
  card's completion is recorded by its landing commit, not a checkpoint. A
  checkpoint is written when a decision, blocker, or campaign closeout is worth
  reopening later.

## What this does NOT change

- `docs/planning/backlog.md` remains the canonical task-status ledger; its
  format, normalizer, and split-commit discipline are unchanged.
- `commit-reviewer` DEFER findings remain non-blocking; the intake bar governs
  whether a DEFER finding becomes a transport card, not whether it blocks.
- The operator escape hatch and the gated-commit protocol are unchanged.
- `/task-delete <id>` remains the sanctioned single-card retire wrapper for
  `draft`/`ready`/`cancelled` cards. For `completed` cards, retirement is
  landing-gated: the sanctioned op enforces the reachability check, so a direct
  `rm` of a `completed` card is NOT equivalent — it bypasses the landing check.

## Reference

- [PROMOTER_RUNBOOK.md](PROMOTER_RUNBOOK.md) — drain-first promoter procedure
  + boundary promotion + backlog conflict discipline.
- [README.md](README.md) — Canonical State Map (transport vs truth).
- [RUNTIME_MODEL.md](RUNTIME_MODEL.md) — transport-versus-truth and promotion.
- `.opencode/skills/backlog/SKILL.md` — backlog edit discipline + intake /
  boundary / drain routing quick-reference.
- `.opencode/agents/commit-message.md` — the `Task-Card:` trailer convention
  for card-driven commits.
- `.opencode/agents/commit-reviewer.md` — DEFER as an intake predicate routed
  through the admission bar.
