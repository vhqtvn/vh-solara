# Backlog Archive: 2026 Q2

This file stores older `done` and `cancelled` rows moved out of `docs/planning/backlog.md` by `.opencode/scripts/normalize-backlog.js` so the main backlog can stay focused on active work.

## Done

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |
| P1-WEB-005 | done | WEB | Clear the finished-unread dot when opening a finished session already at the bottom. Root cause: `maybeRestore()`'s no-anchor branch pins to the bottom programmatically (no scroll event → `onScrolled`/`ackSession` never runs; even a synthetic scroll is skipped by the self-pin sentinel). Second facet: a session finishing while the user is already glued to the bottom also sticks the dot until a manual scroll. Fix: (a) explicit `ackSession` in the no-anchor bottom-pin branch of `maybeRestore`; (b) a reactive `createEffect` that acks when unread is set + following + at-bottom + ready (keys off signals, samples `nearBottom()` non-reactively). |  | 2026-06-28. Changed: web/src/components/ChatView.tsx — (a) explicit `ackSession(props.sessionId)` after `pin()` in the no-anchor else branch of maybeRestore (~:549-561, guarded by `!props.draft`); (b) new reactive ack createEffect (~:616-631) that acks when `state.unread[sid]` + `following()` + `nearBottom()` + `ready()` + `!props.draft`. Does NOT touch the self-pin sentinel (line ~678), the anchor-restore branch, or the Go /vh/ack backend. Verified: `npm run typecheck` clean; `npx vitest run` 87/87 unit pass; `npx playwright test tests/e2e/scroll-follow.spec.ts` 5/5 pass (scroll/follow regression guard). Could not manually repro the live "finish-while-watching" case (no live OpenCode backend in this env); the two code paths are covered by the e2e suite's existing scroll-follow coverage + typecheck. |  |

## Cancelled

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |
