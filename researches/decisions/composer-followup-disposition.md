# Decision: Composer Follow-up Disposition

**Date:** 2026-08-31
**Assessed Tree:** `5629678`
**Status:** Lane CLOSED; nothing active; reopen conditions only (lastAgents measurements; cross-browser claim).

## Lane Context
The composer agent silent-flip bug class necessitated a robust follow-up queue to solidify the evidence-ladder and send-gate architecture in `web/src/agents.ts` and `web/src/components/chat/createSend.ts`. This document captures the disposition of the identified follow-up and DEFER items to ensure a deterministic and evidence-backed resolution without unnecessary fixture coupling.

## Follow-Up Queue Adjudication
- **P0 Policy Evidence:** Resolved (established sticky-until-removal persistence).
- **P1 Model-Pick Persistence:** Resolved (unsent intent persistence implemented).
- **P2 Lane-6 Interaction-Reachability Proof:** Resolved (deterministic fixture and lifecycle proofs).
- **P3 Micro-Cleanup:** Resolved (agent correctness micro-fixes).
- **Parked:** Server `lastAgents` completeness is tolerated. It reopens only on measured pending-window materiality.
- **Retired Items (with rationale):**
  - *Cross-browser claim trigger:* Requires evidence/incident; no standalone work.
  - *Mock-fidelity:* Addressed on-next-touch.
  - *`agentForSession` removal:* Never-standalone; hygiene-only.

## DEFER Disposition
- **Do-Now Bundles:** 
  - **F1/F2 + A2/B1** executed as two test-only bundles. F1/F2 pinned unloaded draft/empty parity and pre-abort outranking fast resolution. A2/B1 covered draft-to-live model-pick e2e and failed-send retention via page-local interception.
- **Rejected:** 
  - *Trigger-cards:* Rejected because doing the work retires the triggers; filing them creates unnecessary coordination debt.
  - *Global failure-mode fixture endpoint:* Rejected because page-local interception suffices for the client-visible non-2xx contract.

## Landed Commit Map
- `055c10f`: Agent-pick fix + gate + ownership.
- `1ccd8fc`: Model-pick persistence + snapshot-prune b-F1.
- `d9f4436`: fix(state): oversized resident floor no longer hides remote older history (OF1) (its body discloses carrying the agent-hold fixture implementation as a shared-file tangle).
- `5cda703`: test: agent-hydration e2e proof + fixture-semantics tests (agent-hold) (this contains the tests and lane-6 crux spec for the fixture carried in the previous commit).
- `ad6c138`: Provably-empty validation + pre-aborted gate settle.
- `5629678`: Resolver-ordering pins + failure-retry e2e.
