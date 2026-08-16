# 2026-08-16 Ordering Fix Defer Follow-ups

**Provenance:** researcher session ses_ff93147b4ffeYU4YZV00qXZOzx, read-only, HEAD 0196f51, 2026-08-16.

## Context

Commit `0d39634` (main) landed the `sm.order` chronological-ordering fix (missing-middle repair). Two review passes + a follow-up research pass (researcher, read-only, HEAD `0196f51`) produced four approved follow-up cards. The ID space wrapped on 2026-08-14 18:19:55 +07 (prefix = low-48 of ms*0x1000+counter wraps every 2^36 ms ≈ 795 days; next re-exceed ~Oct 2028). 

## Card A — lastAssistantText pin-test + stale doc fix (effort S, risk none)

- **Gap**: zero tests reference `lastAssistantText` (`pkg/web/sessions.go:344–393`); `TestCloseoutShapes` (`pkg/web/sessions_test.go:210–263`) never executes the equal-created tie (created 1 vs 20). A silent revert of the wrap-safe tiebreak would pass the whole suite.
- **Semantics to pin**: highest `time.created` wins; equal created → later listing index wins (`c >= bestCreated`, `:371`); absent created = 0.0 (keyed beats keyless; all-keyless → later wins); no assistant → `(false, "")`.
- **Test design**: table-driven unit test at the package-private seam in `pkg/web/sessions_test.go`, cases: 
  - (a) equal created + wrap-straddling IDs (`msg_ffff…` listed first, `msg_0001…` later) → later-listed text wins (red on pre-fix code)
  - (b) created out-of-listing-order → highest created wins
  - (c) no assistant → `(false, "")`
  - (d) absent-created edges
- **Doc fix in same slice**: handler doc `pkg/web/sessions.go:146–147` still says ties by "id DESC" — contradicts landed behavior; correct to later-listing-index.
- **Trigger**: before next touch of `pkg/web/sessions.go` or any wrap-aware-ordering completion claim.

## Card B — ordering-writer pin tests + helper tightening (effort S–M, risk low)

- **Gaps**: 
  - (a) `setCreatedKey` keyless→keyed reposition (`pkg/state/hydration.go:225–233`) unpinned — a part-before-info placeholder older than the resident tail would, pre-fix, park at `sm.order` END and be served as newest.
  - (b) `MergeOlderMessages` created-key caching (`pkg/state/message_window.go:682–739`, cache at `:721–727`) unpinned — without it the merge→full-hydrate path re-corrupts ordered inserts (missing-middle class).
- **Tests** (`pkg/state/hydration_order_test.go`, reuse `ordMsg`/`ordList`/`seqIDs`/`ev`/`assertOrderChronological` helpers):
  - `TestPlaceholderPromotionRepositionsOrder`: keyed newest resident → `message.part.updated` (part-before-info) appends keyless placeholder → `message.updated` promotion → assert exact `sm.order == [mOld, m2]` + chronological + window. Variant: promotion via reconcile path (`hydration.go:337`).
  - `TestMergeOlderThenFullHydrateStaysChronological`: `mustNew(withWindowBounds(4,…))`, cold tail newest-4-of-10 → `MergeOlderMessages(keyed older page)` → `Hydrate(full 10)` → live append → full chronological order, true-newest window, idempotent second hydrate; also pin `MergeOlderMessages(…, historyExhausted=true)` flips the flag.
  - Tighten `assertOrderChronological` (currently fails OPEN on mid-order keyless via `continue` at `:85`, contradicting its own "END only" doc): backward scan — keyless entries must form a contiguous trailing suffix.
- **Optional 2-line robustness** (documented-theoretical edge): `OldestResidentCursorTuple` (`:746–766`) could walk past a front keyless entry to the first keyed one. Only reachable if opencode serves a page item lacking time.created (pinned opencode always sets it).
- **Trigger**: before claiming the `sm.order` writer set behaviorally complete, or next touch of `pkg/state/message_window.go` / `hydration.go`.

## Card C — historyExhausted recalibration on full-history warm reconcile (effort S–M, risk low-moderate)

- **Defect** (note: reviewer's original path was WRONG — real site is NOT `pkg/aggregator/hydration.go:206`): `pkg/state/hydration.go:282` — `exhausted := len(list) < s.windowMaxCount` runs on fresh-`sm` creation only; warm reconcile NEVER recalibrates. After a reconnect/`/vh/reload` full-history hydrate makes the entire history resident, the store still predicts older history → FE "load older" costs one wasted upstream `MessagesBefore` GET (returns nothing), then hides. Self-heals per session per reconnect.
- **Fix shape**: thread `fullHistory bool` into `reconcileMessagesLocked` — `Hydrate` passes true for every sid in its messages map (built exclusively from full `client.Messages` fetches); `SetSessionMessages` passes false. Fresh creation: `exhausted := fullHistory || len(list) < s.windowMaxCount`; warm path: `if fullHistory { sm.historyExhausted = true }` (true-ward only, under `s.mu`).
- **Verified-safe constraints**: (i) Hydrate's set ⊆ LoadedSessions() → always warm → no batch publication → one-batch-before-loaded untouched; (ii) concurrent EnsureOlderMessages merges converge (both writers true-ward; resident skips); (iii) failed per-session fetches absent from map → flag untouched → D-trigger fallback intact; (iv) mid-cold-load sessions excluded (msgLoaded false).
- **Test design**: state seam, `withWindowBounds(4,…)`: cold tail newest-4-of-6 (exhausted=false) → `Hydrate(full 6)` → assert `sm.historyExhausted==true` and `SnapshotMessagesPage(before=oldest).HasOlder==false`; red pre-fix. Optional: aggregator-level `has_older==false` assertion appended to existing `TestReconnectHydrateAfterBoundedColdLoadKeepsTrueNewestWindow`; optional tail-exact self-heal pin (`MergeOlderMessages(sid, [], true)`).
- **Out-of-scope note** (do not fold in): snapshot `WindowMeta.HasOlder` (`projectMessageWindow`, `message_window.go:188`) ignores the flag entirely — initial FE affordance over-reports until first page fetch; cosmetic, pre-existing, separate.
- **Trigger**: next touch of the hydrate/reconcile path; pairs with the missing-middle fix's consumer story.

## Card D — pkg/opencode/id.go post-wrap doc corrections (effort S, risk none)

- **Stale docs** (ID space wrapped 2026-08-14 18:19:55 +07; prefix = low-48 of ms*0x1000+counter wraps every 2^36 ms ≈ 795 days; next re-exceed ~Oct 2028; periodic):
  - header `:14–17`: qualify "interleave correctly" to within the current 2^48 cycle; restate the queue requirement (`queue.go:780` Claim → exact-ID lookup) as exact-ID correlation + same-cycle interleaving (wrap-independent).
  - `MintMessageID` doc `:57–61` and `:73–77`: same qualification ("sorts correctly" holds only within the current cycle).
  - `ParseMessageIDTime` `:147–167`: state decoded value is `unixMilli mod 2^36` (wrong by k·2^36 ms across cycles). Zero non-test callers (verified) → doc note only, NO code guard (ID carries no era bits; a guard could only be heuristic).
- `tests/e2e-docker/mint_msg_id.py` mirrors the layout only; comment-only changes do not require co-updating it.
- **Trigger**: any future `id.go` touch or ordering-design work that might re-trust ID ordering.

## Contradictions Register

1. **Reviewer path wrong on historyExhausted**: Real site is `pkg/state/hydration.go:282`, not `pkg/aggregator/hydration.go:206`.
2. **New stale doc found**: `pkg/web/sessions.go:147` incorrectly claims ties are resolved by "id DESC".
3. **`assertOrderChronological` doc-vs-code fail-open**: Confirmed that the helper fails OPEN on mid-order keyless entries, contradicting its own "END only" doc.
4. **Reviewer test-gap claims confirmed**: `TestCloseoutShapes` never hits the tie, no `lastAssistantText` test exists, and front-keyless is a theoretical edge only.
