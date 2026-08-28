# Warm-reconcile `historyExhausted` policy — defer-and-pin (a+)

Date: 2026-08-28
Status: DECIDED — (a+) defer-and-pin landed (docs + characterization test; zero behavior change)
Debate session: `ses_fb715017effeodKqQ5TF9G49uQ` (unanimous ranking, no dissent on the winner)
Research session: `ses_fb8b76849ffeH3tyKyVTeGqlck`
Assessed at: `c1b833998b4f509b57c0c35808810b70b7643ed8` (line citations are function-anchored;
line numbers are as of this slice)

> Evidence base, not active enforcement: this memo records why the CURRENT
> behavior is deliberate. The policy itself lives in the code comments and the
> characterization test cited below.

## 1. Problem statement

The per-session `historyExhausted` flag has two writers with opposite shapes:

- `MergeOlderMessages` (`pkg/state/message_window.go`) is **set-only**: within
  that function a `true` verdict sets the flag and a `false` verdict never
  clears it.
- The warm-reconcile branch of `reconcileMessagesLocked`
  (`pkg/state/hydration.go`, the `else if exhaustedKnown` branch) **overwrites**
  the flag with the latest fetch evidence — including clearing a learned `true`
  when a bounded tail re-fetch still sees a next cursor.

Before this slice the two doc comments flatly contradicted each other: the
`MergeOlderMessages` comment claimed "once true it stays true" (a permanence
claim about the STORE flag that the warm-reconcile writer disproves), while the
hydration comment described last-evidence-wins. No test pinned the warm
overwrite, so the conflict could not be adjudicated from the outside: was the
clear a defect or a policy?

## 2. Exact trigger path

- `EnsureMessages` / `EnsureMessagesAsync` (`pkg/aggregator/messages.go:237-248`)
  gate on `IsMessagesLoaded` (single-flight); on a cache miss they call
  `client.MessagesTail(ctx, sessionID, state.WindowMaxCount)` and
  `store.SetSessionMessagesExhausted(sessionID, items, nextCursor == "")`.
- **The warm overwrite fires when an already-loaded session is re-entered**
  (session reselect / re-fetch winner): the tail GET returns the resident
  newest messages and — because the response is bounded by `WindowMaxCount` —
  may carry a non-empty `X-Next-Cursor`. That cursor is truthful (E3): it
  proves history exists beyond the tail page — history which may already be
  resident from an earlier floor walk — so it is not evidence that the
  resident lacks the session's oldest message. The store nevertheless
  reconciles with `exhaustedKnown=true, exhausted=false` and clears a
  previously learned exhaustion.
- Upstream cursor semantics (cited in-repo at `pkg/aggregator/messages.go:231-236`):
  `refs/opencode` `message-v2.ts:457-465` + `handlers/session.ts:130-144` —
  the cursor is set iff more history exists beyond the returned window.
- **The reconnect full-list path never flips the flag false**: `Hydrate`
  (`pkg/state/hydration.go:65`, reconcile at `:146-153`) passes
  `(exhaustedKnown=true, exhausted=true)` — a full-list re-fetch also proves
  exhaustion.

## 3. Ordering ground truth

- Upstream orders messages by `(time_created, id)`.
- The resident window orders by `(createdMs, arrival)` (chronological key +
  arrival for ties/missing keys).
- `OldestResidentCursorTuple` (`pkg/state/message_window.go:784-809`) returns
  `ok=false` when there are no resident messages or the oldest lacks a
  parseable `(id, time.created)` — keyless entries cannot seed an older-page
  cursor.
- This divergence is ORTHOGONAL to the exhaustion flag (no comparator is
  involved in either writer) — which is why option (d) is parked, not adopted.

## 4. Backfill reality

- Upstream import (`import.ts` existing-session-id path) can append older
  history to a session AFTER vh-solara already learned exhaustion.
- Clock skew across import sources can reorder `time_created` relative to
  resident arrival order.
- Removals cannot be backfilled (an absent message produces no upstream
  event), so vh-solara can never learn "history shrank" — only "history grew".

Consequence: any policy that makes exhaustion PERMANENT (monotonic-true)
creates a permanent inverse lie under backfill (`has_older=false` forever
while older history now exists). The current reversible policy's failure mode
is the opposite and milder: a spurious `has_older=true` that one
boundary-demand fetch self-corrects.

## 5. Contract inventory

- **No upstream contract** governs `history_exhausted` / `has_older`; the only
  upstream contract in play is `X-Next-Cursor` semantics (E3).
- **Two conflicting in-repo comments** (pre-slice): the `MergeOlderMessages`
  permanence claim vs the hydration last-evidence-wins description — both now
  rewritten truthfully (each about its own writer, cross-referencing the
  other).
- **No prior test pins** the warm overwrite. Existing pins cover the cold
  cursor-evidence entry (`pkg/state/window_test.go:539-569`) and the
  merge-path exhaustion (`pkg/state/page_test.go:1146-1189`); the warm
  overwrite had zero coverage until this slice's test.

## 6. Candidate scoring

Scores reproduced verbatim from the debate verdict
(`ses_fb715017effeodKqQ5TF9G49uQ`, unanimous ranking). **The criteria labels
are this memo's rendering of the debate rubric — the debate transcript is not
retained in this repo; the labels were chosen to fit the recorded scores, not
independently verified against them.**

| Criteria | (a) keep silently | (a+) defer-and-pin | (b)/(c) monotonic store | (d) comparator work |
|---|---|---|---|---|
| C1 — verdict truthfulness (flag matches latest fetch evidence) | 5 | 5 | 1 | 2 |
| C2 — failure-mode safety (reversible vs permanent lie) | 5 | 5 | 5 | 2 |
| C3 — pinning discipline (policy held by a characterization test) | 1 | 5 | 3 | 5 |
| C4 — documentation/contract fidelity (comments truthful, non-conflicting) | 1 | 5 | 4 | 4 |
| C5 — cost/simplicity (less change = higher) | 5 | 5 | 5 | 4 |

Evidence register:

- **E1** — warm-reconcile overwrite branch, `pkg/state/hydration.go`
  (`reconcileMessagesLocked`, `else if exhaustedKnown` →
  `sm.historyExhausted = exhausted`).
- **E2** — `MergeOlderMessages` set-only flag handling, `pkg/state/message_window.go:727-741`
  (`if historyExhausted && !sm.historyExhausted { … }` — never clears).
- **E3** — aggregator trigger path + upstream cursor semantics,
  `pkg/aggregator/messages.go:231-248`.
- **E4** — reconnect full-list path passes `(true, true)`,
  `pkg/state/hydration.go:65,146-153` — never flips false.
- **E5** — pre-slice pin coverage gap: `pkg/state/window_test.go:539-569` and
  `pkg/state/page_test.go:1146-1189` pin cold/merge evidence only; no warm
  overwrite pin existed.

## 7. Decision — **(a+) defer-and-pin** (2026-08-28)

KEEP the current reversible last-evidence-wins behavior exactly as is; pin it
with a characterization test; make both comments truthful about their own
writer. Zero production behavior change.

- **(a)** rejected as insufficient: leaves the permanence lie in the docs and
  the policy unpinned (C3/C4 = 1).
- **(b)/(c)** REJECTED: a monotonic store flag produces a permanent inverse
  lie under backfill (§4) — strictly worse failure direction than the current
  reversible one.
- **(d)** PARKED, not rejected-forever. Re-open triggers (any one suffices):
  1. Telemetry or incident reports showing import-into-open-session is a
     NORMAL workflow (backfill-while-watched becomes common enough that the
     spurious `has_older=true` churn matters to users).
  2. Keyless-entry evidence: real sessions whose oldest resident lacks a
     parseable `(id, time.created)` so `OldestResidentCursorTuple` returns
     `ok=false` on the boundary-demand path.
  3. A comparator test matrix landing (ordering divergence becomes testable
     end-to-end), at which point (d)'s C1/C2 scores can be re-measured.

**Recorded dissent (pro-(d))**: one debate position held that only (d)
addresses the root `(time_created, id)` vs `(createdMs, arrival)` divergence —
everything else documents around it. **Response**: the exhaustion-flag defect
does not route through any comparator (§3); (d) adds machinery and a test
matrix with no user-visible defect today, and the debate ranked it last on
failure-mode safety and second-to-last on truthfulness. Parked with explicit
re-open triggers rather than adopted or rejected outright.

## 8. What landed (this slice) + flip triggers

Landed 2026-08-28 (comment-only in production files; one new test; this memo):

- `pkg/state/hydration.go` — warm-reconcile branch comment + doc block
  rewritten: reversible fetch evidence, truthful-cursor rationale (a
  non-empty cursor proves history beyond the tail page — possibly already
  resident — never spurious), benign self-correcting defect direction,
  cross-reference to `MergeOlderMessages`.
- `pkg/state/message_window.go` — `MergeOlderMessages` doc rewritten: set-only
  within the function; the STORE flag as a whole is reversible via warm
  reconcile (owned by hydration.go); deliberate writer split.
- `pkg/state/window_test.go` —
  `TestWarmReconcileHistoryExhaustedIsReversibleFromTailEvidence`: pins the
  full cycle — (i) floor-learned `true` → (ii) warm cursor-present reconcile
  of already-resident items flips `false` (G-F2 shape) → (iii)
  `MergeOlderMessages(sid, [], true)` restores `true` → (iv) resident count
  unchanged across (ii). Red-proofed: removing the warm-branch assignment
  fails the test.
- This memo.

Flip-uncertainty table:

| Uncertainty | If resolved this way | Consequence |
|---|---|---|
| Import-into-open-session becomes a normal workflow | telemetry/incidents confirm | re-open (d); reconsider (b)/(c) shape for monotonic growth only |
| Keyless oldest resident observed in production | keyless-entry evidence | re-open (d) at least for cursor seeding |
| Comparator test matrix lands | divergence measurable | re-score (d); possibly adopt |
| Upstream documents an exhaustion/has-older contract | contract emerges | re-derive this memo against it |
| Spurious `has_older=true` churn surfaces as a user complaint | incident | the self-correction fetch cost may no longer be acceptable → re-open |

## Contradictions

None detected. (The two pre-slice comments contradicted each other; that is
the subject of this memo and both were rewritten in-slice.)

## Open forks

- (d) comparator/total-order work — parked, see re-open triggers in §7.
