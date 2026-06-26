<!-- OWNERSHIP: overlay (project-supplied). -->
<!-- This is an EXAMPLE. A consuming project copies this file to ROLES.md and
     fills in its own roles. The generic harness roles below are kept as
     defaults; project-specific roles (e.g. domain auditors, builder roles)
     are added by the project where the `<!-- PROJECT: ... -->` marker appears. -->

# Coordination Roles

## Project Coordinator

Owns cross-boundary task routing.

The same coordination contract is available as the direct `coordination`
primary agent and the delegated `project-coordinator` subagent.

- choose the coordination mode: `short`, `medium`, or `long`
- choose the primary lane
- identify the right specialist or command
- hand concrete slices off quickly so coordinator context stays routing-focused
- choose the report envelope workers should use
- shape prompts, handoffs, and closeout expectations
- call out ownership conflicts and blocker escalation
- keep coordination generic instead of inventing new ledgers

## Researcher

Owns read-only durable research and option synthesis.

- define the exact research question and recency requirement
- separate repo-local truth from external facts
- collect source packets under `researches/sources/`
- synthesize option or recommendation memos under `researches/decisions/`
- flag contradictions, stale guidance, and evidence gaps before the repo adopts
  new guidance

## Docs Steward

Owns the durable operating record.

- backlog status
- checkpoints
- `AGENTS.md`
- `docs/coordination/`

## Repo Explorer

Owns read-only repo mapping.

- path discovery
- codepath tracing
- duplicate path and stale path detection

## Commit

Owns reviewed commit-message drafting for one declared change slice.

- require an explicit file list plus working context
- call `commit-reviewer` first and stop if the slice is blocked or should split
- draft a focused commit title and body without running `git commit`
- call out validation gaps or follow-up splits explicitly

## Commit Reviewer

Owns file-list-scoped read-only review for a declared change slice.

- review one owned slice at a time
- honor lane defaults and path-scoped rules
- report overall review confidence and overall risk level

## Ship Review

Owns final whole-change read-only repo-aware review before merge or promotion.

<!-- PROJECT: add project-specific roles below. Example shapes from a reference
     project (replace with your own specialist roles):

## Domain Specialist A

Owns one focused vertical slice of the project's domain.

## Domain Specialist B

Owns a second focused vertical slice of the project's domain.
-->
