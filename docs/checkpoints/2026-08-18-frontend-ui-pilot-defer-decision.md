# 2026-08-18 — Frontend-UI-Pilot Overlay Pack DEFER Decision

## Decision

Operator **ACCEPTED** the `defer-with-trigger` decision for the `frontend-ui-pilot` harness overlay pack.

- **Profile unchanged:** `supervised` profile, overlays `[auto-classifier-pilot, release]`, capabilities `[core/media-perception]`.
- **Status:** DEFERRED. Pack is available in harness v0.26.0 (commit ba2e6b2, doctor HEALTHY) but NOT selected. Pack is skills-only, advisory-only (INFORMS; may DEFER; never blocks/approves), and upstream core promotion is S2-held.

## Adopt Triggers

Any ONE of the following four triggers will fire a bounded pilot:

1. A slice is expected to declare `interaction_touching: true`.
2. A proof depends on a literal `click`/`focus`/`keypress`/`pointer`/`long-press`/`soft-keyboard`/cross-origin gesture reaching its real handler.
3. A reviewer sees API-call, flag-state, or DEV-bridge mechanism evidence offered as proof of a user-visible interaction outcome.
4. Upstream moves past S2-held or publishes falsification-yield evidence.

## Retention Rule

The pilot survives ONLY IF the first triggered use yields:
- A material correction, OR
- An honest `not-demonstrable` downgrade, OR
- A materially more falsifiable receipt.

Otherwise, remove the overlay and return to deferred status.

## Activation Procedure

When a trigger fires:
1. Add `frontend-ui-pilot` under `overlays:` in `.vh-agent-harness/vh-harness-profile.yml`.
2. Run `vh-agent-harness update --dry-run` then `vh-agent-harness update`.
3. Run `vh-agent-harness doctor`.
4. Restart OpenCode (skill discovery is process-cached).
5. Name `interaction-reachability` explicitly in the qualifying task contract/reviewer prompt.

**Rollback:** Remove the overlay line → `update` → `doctor` → restart.

## Evidence Notes

- **Observation Cadence:** 0 of 17 doctor-scanned behavioral-closure artifacts declare `interaction_touching: true`.
- **Doctor #14 Independence:** Doctor #14 already mechanically enforces the six-field interaction-reachability receipt on `interaction_touching: true` closeouts, independent of this pack.
- **Contradiction Flag (Lane-8):** The "document alive" user-visible indicator was removed. Liveness is now observed via DEV bridge (mechanism evidence) — this is exactly the class this pack targets.
- **Selection ≠ Realized Use:** Precedent exists with three existing pilot features where selection did not guarantee realized use.

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Checkpoint created | `ls docs/checkpoints/2026-08-18-frontend-ui-pilot-defer-decision.md` | yes |
| Only checkpoint file modified | `git status --short` | yes |

## Findings

- **defer decision accepted**: source=operator sign-off, confidence=high, type=fact
- **trigger criteria defined**: source=solution-brief, confidence=high, type=fact
- **retention rule established**: source=solution-brief, confidence=high, type=fact
