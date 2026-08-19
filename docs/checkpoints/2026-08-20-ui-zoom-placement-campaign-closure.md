# 2026-08-20 — UI-zoom placement campaign closure

## Context & Defect Class

Under CSS `zoom` + inline `--ui-zoom` on `:root` (applied by `web/src/prefs.ts`), `clientX` and `getBoundingClientRect()` report viewport/visual px, while style lengths resolve in layout px. This mismatch forces all pointer-driven placement math off by the zoom factor.

**Fix convention:** Keep geometry natively in viewport-px, and convert ONCE at the style/event boundary via `layoutPx()` (`web/src/lib/zoom.ts`); this conversion is identity at z=1. Terminal seams normalize events at the capture phase (`web/src/lib/termPointer.ts` + `TerminalPane.tsx`) because the coordinate mixing occurs inside vendored xterm v6.

## Commit Inventory

All commits are on `main`, fully commit-gated, and commit-reviewed (4/4-leaf cascades). **None were pushed by agents** (push is operator-only).

*(Inventory verified against `git log` and `git show --stat`. The provided SHAs and commit contents match the tree.)*

1. `fc2ef59d` — `fix(web): convert viewport-px pointer math to layout px under UI zoom` (12 files: `zoom.ts` + 8 surfaces + 3 test files)
2. `f9a8bbd4` — `fix(web): zoom-convert terminal dock drag height and path-selection action` (TerminalDock drag height + PathSelectionAction + 7 zoom unit-test files / 21 tests)
3. `a191148d` — `fix(web): zoom-convert chat autocomplete popup placement` (Composer.tsx acStyle autocomplete popup conversion + 3 tests)
4. `041ad0b8` — `test(web): e2e placement tracking of zoom-converted surfaces at 125%/80%` (`web/tests/e2e/zoom-placement.spec.ts` created, 10 tests, chromium; live premise asserts per test)
5. `f35dc82f` — `fix(web): zoom-convert tab overflow measure and chat scroll anchors` (cousins: TabBar overflow measure + ChatView anchor restore/correction, +9 tests)
6. `76dfaeb2` — `fix(web): zoom-normalize terminal pointer coords and add cell cursor` (terminal pointer→cell zoom normalization (xterm Mouse.ts mixing) + `.term-cell-cursor` indicator, +19 tests)
7. `5572db88` — `fix(web): divide pixel wheel deltas by uiZoom at terminal seam` (wheel-delta division at terminal seam, +9 unit, +1 live parity e2e; discharged `76dfaeb2`'s live-seam DEFER)
8. `cb741157` — `fix(web): close zoom-campaign residue — hygiene plus excluded-surface e2e` (residue closure: hygiene (comments, TerminalDock.tsx NUL escape, Select flip pins, `assertZoomPremise` helper) + 6 previously-excluded surfaces e2e → 23 tests; exclusion list now empty)
9. `a5b51fa3` — `fix(web): normalize terminal drag events that escape the host under UI zoom` (document-capture seam + `documentRewriteApplies` guard; red→green e2e with horizontal-escape gesture; discharges review defer B-F2 from `76dfaeb2`)
10. `12c046f2` — `test(web): run the wheel-parity outcome on Firefox via firefox-zoom project` (firefox-zoom Playwright project: exactly 1 test: real-PTY wheel parity on Firefox 150.0.2, non-legacy deltaY path; 3 consecutive identical greens — O1 branch of the solution brief)

## Solution-Brief Dispositions

Dispositions of the items recorded in `tmp/agent-runs/ui-zoom-residue-solution-brief/brief.md`:

1. **Terminal drag escape at z<1** — **DONE** (`a5b51fa3`): red receipt (selection end ~2 rows above anchor, reversed 3-row composition, ~133px short @0.8) → green ([anchor → grid edge]); vertical escapes structurally masked by xterm drag-scroll column-zeroing — horizontal gesture is the discriminating case.
2. **Firefox wheel parity** — **O1: kept** (`12c046f2`): stable pass, 3 runs, parity 0.25 rows ≤ 1.5 tol.
3. **App.tsx raw NUL** — **dropped** (already escaped in `cb741157`).
4. **Test-hardening nits** — **dropped** (tooltip clamp independently covered; TOL tightening adds fragility; sidebar assert redundant).
5. **Durable record** — **this checkpoint**.
6. **Push** — **operator, after this checkpoint**; at last measurement `git rev-list --count origin/main..main` = 7 (5 pre-existing incl. `cb741157` + the 2 new). Post-push verification must use branch reachability (`git merge-base --is-ancestor <sha> origin/main` or fetch + log), NOT `git show`.
7. **Closure claim** — After push + CI, the honest form is: "Local UI-zoom campaign work is disposition-complete and verified on the recorded tree for the stated targeted interaction paths. Remote landing and CI remain pending observation." (Behavioral closure beyond the targeted paths is not claimed).

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Drag-escape crux reached grid edge at z=0.8 | `vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && npm --prefix web run test:e2e -- tests/e2e/zoom-placement.spec.ts --grep "escaping the host"'` (plus 25/25 full-file passing) | yes |
| Firefox wheel parity identical at 100%/125% zoom | `npm --prefix web run test:e2e -- --project=firefox-zoom` (3 consecutive passes, parity gap 0.25 rows ≤ 1.5 tol) | yes |
| Static validation (typecheck, unit, targeted e2e) pass | `npm run test:unit`, `npm run typecheck`, targeted e2e (chromium) | yes |
| Full serial e2e lane passes | Full CI run / CI's job | no (pending push) |

## Interaction Receipts

**Drag-escape crux**
- **gesture:** real mouse press on known terminal text → held horizontal sweep past the host and window right edge → release outside
- **target:** selection endpoint reaches grid edge
- **environment:** Chrome for Testing 148.0.7778.96 (Playwright 1.60 bundled), real PTY, real xterm v6 DOM
- **verifier:** `vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && npm --prefix web run test:e2e -- tests/e2e/zoom-placement.spec.ts --grep "escaping the host"'` (plus full-file 25/25)
- **outcome:** single full-height selection div [anchorX → screen.right] at z=0.8 (was reversed 3-row, ~133px short)
- **tree binding:** red @ `bcc578c0`+tests (no fix) / green @ `8b54f898`+fix → landed `a5b51fa3`
- **classification:** **outcome** (user-visible rendered selection)
- **scope:** targeted grep + full-file

**Firefox wheel parity**
- **gesture:** 8 real pixel-mode wheel notches (−300px) at screen center
- **target:** identical visual scroll advance at 100%/125% zoom
- **environment:** Firefox 150.0.2 (Playwright 1.60 bundled firefox-1522), real PTY
- **verifier:** `npm --prefix web run test:e2e -- --project=firefox-zoom`
- **outcome:** parity gap 0.25 rows ≤ 1.5 tolerance, non-vacuity floor exceeded 22×, three consecutive runs with identical numbers
- **tree binding:** working tree @ `8b54f898` → landed `12c046f2`
- **classification:** **outcome**
- **scope:** targeted (1 test)

**Static verification state**
Typecheck clean; FULL unit suite at final tree: 196 files / 2369 passed / 1 skipped (NOTE: includes ~25 tests from a concurrent session's `orphanTailSettle.test.tsx` + related; campaign-only contribution ≈ 2344); chromium targeted e2e `zoom-placement.spec.ts` 25/25 (24.8s); firefox-zoom 1/1 ×3. Full serial e2e lane NOT run locally — CI's job (pending push).

## Findings

- **(finding)**: The CSS `zoom` + inline `--ui-zoom` property disconnects visual dimensions from layout logic across all boundary APIs (`clientX`, `getBoundingClientRect`). `layoutPx()` translation correctly preserves coordinate math identity at `z=1` without over-complicating individual component math. source=campaign-implementation, confidence=high, type=fact
- **(finding)**: Terminal horizontal escapes represent the true discriminating case for document-capture event bounds; vertical escapes are structurally masked by xterm's drag-scroll column zeroing. source=terminal-escape-investigation, confidence=high, type=inference
- **(finding)**: Synthetic `contextmenu` events in Playwright map incorrectly in nested zoomed iframes; hit tests mis-map without manual compensation. source=e2e-observations, confidence=high, type=fact

## Surviving Triggers / Open Defers

1. **Multi-pane exactly-once guard (review F1 of a5b51fa3):** `documentRewriteApplies` is per-host containment; cross-host double-division impossible today (TerminalDock mounts ONE TerminalPane via keyed Show). **Trigger**: `path_touched` `TerminalDock.tsx`/`TerminalPane.tsx` introducing simultaneous multi-host rendering.
2. **Lost-mouseup lifecycle (F2/F4/F5):** alt-tab/blur/contextmenu-suppressed mouseup strands the document capture pair until next in-document mouseup — bounded, xterm-consistent, self-healing. **Trigger**: `always_before` any "complete drag-listener lifecycle coverage" claim; suggested hardening = blur/contextmenu teardown.
3. **Mouse-reporting non-primary-button normalization (F3):** incidentally covered, untested inference. **Trigger**: `path_touched` `TerminalPane.tsx` mouse-reporting area.
4. **`.vh-select-pop` CSS max-width:** unit mix `max-width: min(92vw, 360px)` — bounded by the 360px cap; open product-side nicety, no trigger.
5. **Firefox live coverage:** wheel parity ONLY; the 23 placement tests remain chromium-only (by design — Firefox/WebRender zoom rendering differences; not a defect).
6. **ctxm e2e:** uses synthetic contextmenu (Playwright hit-test mis-maps zoomed-nested iframes) — documented in-test.
7. **CI:** has never run the new `firefox-zoom` project or the drag-escape tests — first exercise is post-push.

## Explicit Exclusions

- `web/src/ui.ts` dirt observed mid-campaign belonged to a concurrent session (since committed by it); never touched by campaign slices.
- Concurrent dirt at closeout (NOT in any campaign commit): `web/src/components/Part.tsx`, `web/src/sync/reducers.ts`, `web/src/session-stream.ts` (`web/src/sync/session-stream.ts`), `web/tests/unit/crossStreamCompletion.test.ts`, untracked `web/tests/unit/orphanTailSettle.test.tsx`.
- `docs/ai/shell-execution.md` was another session's work, landed by it as `426d757` ("docs: close shell-execution review findings F-A/F-B") — this also resolves the older "missing docs/ai files" residue note for that file.
- No `.local/coordinator` cards, no backlog entries were created by this campaign; this checkpoint is the durable record.
