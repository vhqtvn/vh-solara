# 2026-08-23 — i3 host-shell lane closure

This is the durable closeout checkpoint for the completed i3 host-shell lane in vh-solara's multi-server UI transformation.

## Arc summary

The i3 host-shell transformation of vh-solara's multi-server UI, ~Aug 2026, in sequence:

- **i3 Phase 1** `ff74f36`: workspace tabstrip restored; per-pane headers REMOVED (chromeless iframeRenderer + outline focus border); i3 layout modes (split-h/split-v/tabbed/stacked via `setLayoutMode`); split-orientation persistence fix (`pruneGridNode` no longer collapses single-child branches — was flipping orientation on reload); `+`-popover clip fix. Survival gates proven: orientation-flip (`api.component.gridview.orientation`) + header-position-flip both preserve iframe identity → mode-switches are live-tree ops.
- **Interaction revision Slice 1** `b599407`: SPA gesture recognizers (double bare-Ctrl desktop; triple-tap mobile) forwarding ONE closed postMessage `{type:"host-gesture",gesture:"layout-overlay-request"}` (origin-checked tier, source-guard, captured-origin, never `'*'`); host-side `LayoutOverlay.tsx` (cardinal split arrows, capture layer scoped to `<main>` so tabstrip stays clickable); strong focus indicator (3px accent outline + 5px top edge + ACTIVE badge while overlay open); `setLayoutMode` split-target fix (anchored on source panel, was `group.panels[0]`). Dead Alt-hotkeys deleted.
- **Activation-on-tap** `d621138` + focus reliability `e986834`: `{gesture:"pane-activate"}` forwarded on every window-focus/pointerdown/focusin (capture-phase listeners — element-level `stopPropagation` can no longer block activation; the once-per-focus-session throttle was removed after proving cross-origin blur-suppression made it stick).
- **Triple-tap robustness** `b405485` + `05d7a6d`: sequential triple-tap replaced by 3-finger-tap with lift-distance gating (fires on all-3-up + <15px movement; swipes don't fire).
- **Statusbar removal** `aa244b3`: Statusbar deleted entirely; P3 NEXT hero button moved into the tabstrip next to Add server.
- **Slice 2** `3054a12`: Split/Swap mode toggle + swap-with-direction (`exchangePanes` via two survival-safe `moveTo` ops — geometric order flip, both iframes survive) + Close-pane; ~10 stale statusbar comments swept.
- **Phase 2 auto-transpose** `5dc88b0` + startup normalization `7a84160`: viewport-shape orientation flip (tall↔wide, debounce, 2+-pane guard, localStorage `vh-host:autotranspose` toggle default ON); mount-time normalization (restored layout transposes to match viewport shape; ordered after cold-restore, before layout-saver + FLIP baseline).
- **FLIP animation arc** `dcd6547` → `df28188` → `3c9c854` → `0c486fe`: replaced laggy CSS left/top/width/height transitions with GPU-composited FLIP (invert-transform → play); deferred-reflow (pane content pinned at OLD size during the morph — the iframe never resizes mid-animation; ONE reflow at settle); early-pin + dark blank-frame guard; ResizeObserver baseline-freshness (dockview commits container resizes SILENTLY — the root cause of the "weird animation on project switch" bug; `onDidLayoutChange` fires for activation/params too, so stale baselines detonated).
- **Settings popover** `0196f51` + `b23936b`: gear menu in the tabstrip — Reload page + Auto-rotate toggle (live) + "Layout…" entry (production host-side overlay trigger — the overlay was gesture-only after the statusbar removal).
- **Proportional split sizing** `b837e439`: v3 fractional persistence (`vh-host:layout:v3`, per-child fraction not px; v2 blobs migrate losslessly) + live re-normalizer (`proportions.ts` + `fractionMath.ts` zero-import leaf — an ESM cycle was caught by the committer's tree-bound re-review and fixed via leaf extraction). Fixes flip-then-resize drift (dockview's flipNode rebuilds splitviews without saveProportions).
- **Tail setting per pane** `45c3e7f`: status bridge carries `following: boolean`; host→SPA `{type:"vh-host-tail"}` command; overlay Tail row (Tail: on/off + "Jump to latest"). Force-unfollow deliberately NOT shipped (ChatView self-heal paths re-engage; not durably expressible without SPA-side redesign).
- **Phase 3 SPA skeleton** `8b87aaa` (S1 `isEmbedded()` extraction) → `dd0feff` (S1b embedded terminal overlay-full default) → `0ac9203` (S2a height tiers: short≤520/tiny≤400 visual px, hero hidden, composer capped, kill-switch `vh.prefs.shapeTier.v1`) → `8e7361fd` (S2b width tiers: narrow<560/rail 560-720/wide>720; ~160px sidebar rail with status dots + truncated titles; kill-switch = exact legacy 721px behavior).
- **CI/lane fixes** `2ce133b` (lane-8 re-pointed `/`→`/app` after the fold moved the SPA; probe anchored `src^=` — confirmed GREEN on dispatch run) + `6ffae10` (lane-7 webkit NO-EXCURSION clip-bounded invariant — the test was validated chromium+firefox only; webkit leg's first run was on CI).
- **Docs** `fabdad5` (AGENTS.md lane-8 URL corrected in overlay source + rendered mirror).

## Key invariants
*(The load-bearing rules future work must preserve)*

- **Iframe survival**: `renderer:'always'`; layout ops are geometry/visibility only; proven survival-safe ops: `api.component.gridview.orientation` flip, `setHeaderPosition`, `moveTo`, `resizeChild`; NEVER `removePanel`-to-collapse (except explicit close) and NEVER runtime `fromJSON` (cold-only).
- **The postMessage bridge family** (all mirror the same security model): heartbeat, status (origin-checked tier — carries attention/activity/title/following), route emission (allowlisted {dir,session}), select-command, host-gesture (layout-overlay-request / pane-activate), vh-host-tail, host-mode. Embed gate + source-guard-before-mutation + captured-origin-never-`'*'` + closed payloads.
- **FLIP invariants**: baseline-freshness (ResizeObserver re-seeds; container resizes are silent in dockview); pin-at-old-size during morph (iframe never resizes mid-animation); `.dv-geometry-dragging` drag-skip; `contain: layout` override on `.dv-render-overlay` (paint would scissor pinned old-size children).
- **Tier system**: `shapeTier.ts` — thresholds in VISUAL px (zoom-normalized via `lib/zoom.ts`), ±16px hysteresis, ONE shared RO both axes; kill-switches revert to exact legacy behavior; persisted sidebar width (`vh.sidebar.w.v1`) never mutated by tiers.
- **Layout persistence**: v3 fractional (`vh-host:layout:v3` + URL `#state=`); `pruneGridNode` must NOT collapse single-child branches (orientation flip on reload); v2 migrates in-memory.
- **Lane-8 posture**: panes load the real SPA at `/app` (post-fold); probe anchored `src^="/assets/index-"`.

## Deferred items with triggers
*(The honest open list)*

- Lane-8 real-SPA receipts riding path triggers: tail round-trip, vh-host-select round-trip, embedded terminal default (all mock-seam + unit proven; lane-8 has no assertions for them).
- `defer-persisted-signal-envelope-footgun.json` (draft card; trigger `path_touched(web/src/lib/store.ts)`).
- flushSave clear-all e2e (trigger: next `layoutPersistence.ts` touch); rail search/filter-clear e2e (next `Sidebar.tsx` touch); zoom≠1 real-browser tier e2e (next `shapeTier.ts` touch).
- WebKit 35px dead strip after swaps — cosmetic, webkit-only, explicitly SKIPPED (no WebKit use).
- Known pre-existing oddities: NUL bytes in App.tsx (~line 231 + activeViewKey separators); TerminalDock.tsx non-UTF-8 encoding.
- Unpushed at checkpoint time: `8e7361fd`, `6ffae10`, `b837e439`, `fabdad5`, `45c3e7f` (+ concurrent-session work) — operator pushes.

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Cruxes landed successfully | chromium+firefox e2e (full host-web suite ~309 passed at HEAD `45c3e7f`; web unit 2413; preview 8/8; lane-8 CI GREEN) | yes |
| Deferred items omitted | See honest gaps inline in the deferred items list | yes |
