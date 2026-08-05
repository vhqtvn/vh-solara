---
description: Create, list, open, accept, reject, or retire a model-originated skill-authoring proposal card under .local/coordinator/skill-proposals/
agent: build
subtask: false
---

Capture or act on a model-originated skill-authoring proposal. A proposal is a
structured DRAFT CARD — local, gitignored CANDIDATE TRANSPORT, never authority.
It cannot install a skill, write a canonical `SKILL.md`, or bypass the S2
overlay-pilot-then-promote gate. Acceptance only marks a proposal
human-approved for SEPARATELY AUTHORIZED overlay authoring.

Proposal action and details:
$ARGUMENTS

Route on the first argument (the subcommand):

- `create` (default when no subcommand is recognized) — capture a new draft
  proposal, or update an existing draft's content. Required fields: `skill_slug`,
  `skill_name`, `description`, `trigger` (when to use the skill). Optional:
  `proposed_pack` (target overlay pack slug), `rationale`, `evidence_refs`
  (array of provenance-bearing locators — fabricated evidence is prohibited),
  `proposed_skill_content` (a draft `SKILL.md` outline or body — this is a
  RECORD, never an installed skill), and `proposal_id` (to update an existing
  draft). Do NOT set `created_by` or `metadata.proposal-origin` — provenance is
  enforced at the write layer and stamped from the real session; a top-level
  `created_by` is REFUSED.
- `list` — enumerate proposals. Optional status filter, e.g. `list draft`.
- `open <proposal_id>` — read one proposal card in full.
- `accept <proposal_id>` — the human gate: move a `draft` proposal to
  `accepted`. This creates NO skill; it only records human approval to proceed
  with SEPARATELY AUTHORIZED overlay authoring under
  `.vh-agent-harness/overlays/<pack>/skills/<name>/SKILL.md`, followed by the
  S2 hold → overlay pilot → external evidence → human-approved core promotion
  path (unchanged by this intake). This gate is DOCUMENTATION-ENFORCED, not
  code-enforced — a model must not accept its own proposal (same pattern as
  task-card promotion). The mechanical gates that hold regardless of who calls
  it are downstream: overlay authoring → S2 → pilot → evidence → core promotion.
- `reject <proposal_id>` — the human gate: move a `draft` proposal to
  `rejected` (terminal). Optional reason after the id. Documentation-enforced
  like `accept` — a model must not reject its own proposal.
- `delete <proposal_id>` — retire a single unpromoted transport card. This is
  NOT a lifecycle status and NOT a decision; it removes disposable gitignored
  transport. It must NOT be used to bypass the accept/reject gate.

Workflow:
- consult `docs/ai/codebase-operational-primitives.md` for canonical paths and
  conventions before acting.
- this command is the sanctioned intake surface. The `/init` direct-write path
  (a model writing `SKILL.md` directly into `.opencode/skills/`) is REJECTED —
  do not propose by installing; propose by capturing a card here.
- the coordinator is read-only. The proposing specialist or build session
  writes the card via this tool; it never edits the proposal files directly.
- for `create`:
  - call `plan_state` with `operation: current_session` so the result records
    the proposing session alias (provenance is stamped from it).
  - call `plan_state` with:
    - `operation: save_skill_proposal`
    - `proposal_payload`: a JSON object with the proposal-card fields
  - if `save_skill_proposal` returns a `created: false` update, surface that it
    updated an existing draft rather than creating a new card.
- for `list`: call `plan_state` with:
  - `operation: list_skill_proposals`
  - optional `proposal_statuses_csv` (`draft`, `accepted`, `rejected`)
- for `open`: call `plan_state` with:
  - `operation: read_skill_proposal`
  - `proposal_id`
- for `accept` / `reject`: call `plan_state` with:
  - `operation: set_skill_proposal_status`
  - `proposal_id`
  - `next_status`: `accepted` or `rejected`
  - optional `rejection_reason` (for `reject`)
- for `delete`: call `plan_state` with:
  - `operation: delete_skill_proposal`
  - `proposal_id`
- keep the return compact. For `create` on a `short` flow, stop at one concrete
  next command instead of continuing with overlay-authoring planning in the same
  response (overlay authoring is a separately authorized step).

Return:
- proposal id and local path
- status (`draft` / `accepted` / `rejected`) and the action taken
- for `create`: the proposed skill slug/name/description/trigger
- for `accept`/`reject`: an explicit reminder that NO skill was created and the
  next authorized step (overlay authoring, separately authorized) — or, for
  `reject`, the recorded reason
- next recommended command

For git operations, follow `.opencode/docs/git-execution-routing.md`.
