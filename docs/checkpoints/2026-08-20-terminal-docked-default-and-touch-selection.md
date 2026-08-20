# 2026-08-20 — Terminal Docked-Default and Touch Selection Fixes (Archive)

This record covers the lane-archive checkpoint for today's two terminal-fix slices (committed on `main` and pushed). Both fixes address bounded UI behavior: dock sizing and mobile text selection.

## Slice 1 — Terminal docked-first default (`3ac0b01`)

- **What:** Reversed the "S1b embedded default" that forced the terminal full-screen on first open when the SPA runs embedded in the host shell iframe. The dock now opens small (300px persisted height via `vh.term.height.v1`) in all contexts. The explicit Full-screen toggle still wins for the session (`termFull` is deliberately non-persisted).
- **Files:** `web/src/ui.ts` (removed embedded default + `termPresentationSet` bookkeeping), `web/tests/unit/termEmbeddedDefault.test.ts` (repinned: embedded first open → docked), `web/src/embedded.ts` (stale comment consumer-list fix).

## Slice 2 — Mobile long-press text selection fix (`3a437eb`, parent `6645bb5`)

- **Root cause:** Two stacked defects prevented long-press selection on mobile.
  1. *(M1)* xterm.js v6's unguarded non-macOS `contextmenu` listener teleports its hidden 20×20 `z-index:1000` helper textarea under a touch long-press and focuses it, summoning the native "Paste" bubble.
  2. *(M2)* xterm.css `.xterm { user-select: none }` kept DOM-rendered rows natively unselectable, so a long-press could never start selection.
- **Fix (coarse-pointer only, desktop untouched):**
  - Capture-phase `contextmenu` guard on the terminal host in `web/src/components/TerminalPane.tsx` (`stopPropagation`, never `preventDefault` — browser default IS the selection UI; `matchMedia "(pointer: coarse)"`; cleanup in `onCleanup`).
  - `@media (pointer: coarse)` rule in `web/src/components/TerminalDock.css` (`.term .xterm` `user-select: text`, `-webkit-touch-callout: default`; specificity `(0,2,0)` beats xterm.css `(0,1,0)`).
- **Files:** `web/src/components/TerminalPane.tsx`, `web/src/components/TerminalDock.css`, `web/tests/e2e/terminal.spec.ts` (3 new specs: forced coarse pointer via matchMedia patch, teleport fingerprint probe, CSSOM rule pin, desktop control), `web/tests/unit/termLongpressSelect.test.ts` (source-pin).
- **Context:** Not caused by the UI-zoom pointer campaign (`a5b51fa`/`76dfaeb`/`5572db8`/`cb74115` — getters-only seams) nor by `3ac0b01`; predates both (xterm pinned 6.0.0 since v1.0.0). Commit-gate refused the first attempt fail-closed due to a concurrent mid-flight `6645bb5` landing (disjoint paths); retry re-acquired/re-reviewed and landed clean.

## Verification

| Claim | Verifying command/output / Evidence | Verified |
|-------|-------------------------------------|----------|
| **Slice 1 (Docked Default) green** | web unit 2341 passed/1 skipped, typecheck clean (pre-fix-baseline); reviewer approve (Commit `3ac0b01`) | yes |
| **Slice 2 (Mobile Selection) green** | web unit 2370 passed/1 skipped; typecheck clean; Chromium e2e 234 passed/0 failed (Commit `3a437eb`) | yes |
| **Slice 2 device interaction outcome** | **CLOSED 2026-08-20**: Operator confirmed on physical phone. Action: physical long-press on terminal text. Environment: operator phone. Outcome: selection handles + Copy menu, no Paste bubble. Tree: `3a437eb`. | yes |

*(Note: The interaction-reachability receipt for Slice 2 was honestly declared inconclusive/not-demonstrable headless at commit time; the physical device check above satisfies the outcome evidence).*

## Standing obligations / residual notes

1. **(trigger obligation, upgrade-to-blocking on fire)** On ANY `@xterm/xterm` version change: re-derive both the `contextmenu`-listener registration assumption (bubble-phase on `.xterm` root, non-macOS unguarded branch) and the e2e teleport fingerprint (20px / zIndex 1000 / centered −10 offsets) — this relies on vendored-source-derived assumptions, not a documented API.
2. **(advisory, non-blocking)** e2e M1 test asserts a delta (`after == before`); could pass vacuously if the textarea were pre-teleported — tightening with absolute parked-state asserts (`zIndex !== '1000'`, `width !== '20px'`, `focused === false`) is optional hardening.
3. **(advisory, non-blocking)** M2 could additionally assert `getComputedStyle(.xterm-rows).userSelect === 'text'` under forced coarse pointer (reviewer verified rows carry no explicit override, so current rule suffices).
4. **(known limitation)** `pointer: coarse` keys on the primary pointer — fine-primary touchscreen laptops (Surface-style) keep the bug class; `any-pointer` was rejected (would eat desktop right-click there). Revisit only on hybrid-device reports.
5. **(residual lever)** If a Paste bubble ever reappears on iOS specifically: suspect connect-time textarea focus (`ws.onopen` → `term.focus()`); deliberately untouched to protect keyboard summoning.
6. **(cosmetic, dropped)** `termEmbeddedDefault.test.ts` filename/title still say "embedded default" though the default is now uniform — rename only if the file is next touched (`ui.ts` references the filename).