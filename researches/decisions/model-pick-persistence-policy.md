# Research Packet: Model-Pick Persistence Policy

**Date:** 2026-08-31
**Assessed Tree:** `5629678`

## Research Question
Identify repository precedent for the four policy questions of per-session model-pick persistence:
1. Consumption and clearing events
2. Failed-send retention
3. Malformed/stale restore behavior
4. Same-session cross-tab conflicts

## Code Evidence (Verified at `5629678`)
- **Consumption:** Agent picks are never consumed during a session's lifetime. The only caller to `clearSessionAgentPick` is the session removal path in `web/src/sync/reconcile.ts` (approx line 66, 84). The DRAFT model pick, however, *is* consumed at first-send admission via `migrateModelPick` (in `web/src/models.ts` approx line 338, invoked from `web/src/components/chat/createSend.ts` at the draft-only gate where `fromID === ""`). (source=web/src/sync/reconcile.ts, confidence=high, type=fact)
- **Failure Behavior:** No failure, abort, or timeout send path touches pick state. (source=web/src/components/chat/createSend.ts, confidence=high, type=fact)
- **Restore Behavior:** The `sanitizePicks`-family (`web/src/sync/store.ts`, approx line 85) applies unconditional malformed-entry drops, resulting in a fail-closed restore. (source=web/src/sync/store.ts, confidence=high, type=fact)
- **Cross-tab Conflicts:** The ONLY storage-event listener in `web/src` is `persistedSignal` (`web/src/lib/store.ts`, approx line 70) for scalar preferences. All per-directory map stores use whole-map last-writer-wins (LWW) with no convergence mechanisms. (source=web/src/lib/store.ts, confidence=high, type=fact)
- **Server State & Local Evidence:** Opencode persists `session.model` server-side and stamps messages with the model. Matching message evidence is locally well-defined through the `selectionFor` ladder (`web/src/models.ts` approx line 197; `web/src/sync/selectors.ts` approx line 46). (source=web/src/models.ts, confidence=high, type=fact)

## Contradictions
None detected. (Historical contradiction: the solution brief's consume-on-dispatch preference vs repo precedent sticky — resolved by the tie-break trace in favor of sticky).

## Debate Verdicts
- **Cross-tab:** Whole-map LWW. (Confidence: Medium. Scenario is bounded to same-browser-profile tabs; forward-compatible to add explicit timestamps later.)
- **Consumption:** Tie broken by the tie-break trace. The in-memory `sessionSel` survives sends within a session. The only deletion path is the draft-to-live migration (which is a no-op for live sends), and reloading is the only loss path. Sticky persistence is therefore the only behavior-preserving choice.

## Settled Contract (Landed in `1ccd8fc`)
- **Sticky-until-removal:** The sole clear path is the session-removed reconcile effect plus wholesale-snapshot pruning.
- **Failed-send retention:** The selection is explicitly retained on failed sends.
- **Restore:** Sanitize and fail-closed.
- **Cross-tab:** Whole-map LWW.

## Disclaimer
This artifact is the evidence base, not active repo policy. Evidence is code-reading at `5629678`; line numbers drift, symbols are canonical.