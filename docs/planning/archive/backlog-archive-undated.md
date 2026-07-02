# Backlog Archive: Undated

This file stores older `done` and `cancelled` rows moved out of `docs/planning/backlog.md` by `.opencode/scripts/normalize-backlog.js` so the main backlog can stay focused on active work.

## Done

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |
| P1-WEB-024 | done | WEB | Fix the flaky/determ-failing e2e `scroll-follow.spec.ts:713` "reopen of a busy session at a stored anchor is not yanked to the tail". **Root cause (M-second-yank, CONFIRMED):** the composer session-switch effect (`ChatView.tsx` `createEffect(on(() => props.sessionId, ...))` ~1096-1107) scheduled an **UNGUARDED** `requestAnimationFrame(pin)`. On open with a seeded mid-history anchor, two session-switch effects race: (a) chat-scroll's restore runs `maybeRestore`'s anchor branch (sets `following=false`, `userScrolledUp=true`, positions viewport at the anchor); (b) the composer's rAF then fires `pin()` — which sets `scrollTop=scrollHeight` with NO guard — yanking the reader off the anchor to the live tail; that programmatic scroll then clears the seed via `onScrolled@atBottom`, and the contentEl RO re-pins. This was the ONLY unguarded `pin()` caller — self-heal (417), resume (442), both ROs (838/872) all gate on `following()`. Probe evidence: the culprit pin had an EMPTY stack (pin passed directly as the rAF callback = `requestAnimationFrame(pin)` at the only such call site) with `following=false/userScrolledUp=true/ready=true`. **Eliminated:** C-contamination (fails in fresh single run too), T-test-fragility (real DOM yank, anchor genuinely cleared), O-anchor-drift (precise pin-to-scrollHeight, not drift), D-placeholder-height (no evidence). **Fix:** gate the composer's rAF pin on `following()` → `requestAnimationFrame(() => { if (following()) pin(); })`, so it no-ops when maybeRestore's anchor branch has taken over and proceeds unchanged for no-anchor/stale/not-yet-restored cases. a4a7f7c maybeRestore semantics + Deferred never-unmount invariant + reveal gate all untouched. **Verification:** isolation `--repeat-each=10 --retries=0` = 10/10 pass; 3-spec bundle ×3 = :713 green every run; `:476`/`:628` failures are pre-existing flakiness (`:476` confirmed failing on clean HEAD baseline, not this change); `npm run typecheck` clean; `npx vitest run` 142/142. | build | web/src/components/ChatView.tsx (~1104). |  |

## Cancelled

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |
