---
research_question: Why does the `chat-live` auto-follow ("Live" pill) get lost, and is composer/viewport resize the cause?
scope: Concept B only — the `chat-live` auto-follow pill in `web/src/components/ChatView.tsx` (predicate `following()`). NOT Concept A (`reasoning-time.live` per-part thinking-timer accent in `web/src/components/Part.tsx`), which is out of scope.
confidence: HIGH (mechanism + fix locus); MED (observed-loss trigger, needs capture)
date: 2026-06-30
---

# Live auto-follow lost on resize — source packet

Researcher re-study of concept B (`chat-live` auto-follow).

## Findings (HIGH confidence)

Composer-height-growth resize is a **RED HERRING** — `.chat-scroll` is
`flex:1;min-height:0` (`styles.css:1038`), `.composer-wrap` is in-flow (`:2607`),
so composer auto-grow shrinks `.chat-scroll`'s box → fires the `scrollEl`
ResizeObserver re-pin at `ChatView.tsx:731` → `pin()` re-glues, `following`
unchanged. The viewport-shrink path is covered (proven by the existing
viewport-shrink e2e).

## Real gaps

1. `following()` has **NO engage site on turn-start/resume** — only
   open/switch/Latest/scroll-back/`maybeRestore` engage it, so any Live loss is
   permanent until manual scroll-back.
2. The pill gate `:1448` has **no finished/idle gate** — it shows the Live pill
   whenever following, even on an idle/finished turn.

## Likely real trigger of observed loss (MED confidence, needs capture)

A coincident content/streaming event tripping the `contentEl` ResizeObserver
guard `:695-699` (`scrollTop < pinnedTop && !shrank → setFollowing(false)`) or
`onScrolled` `:751` — these cluster around reasoning/tool-block settling
(collapse / raw→rendered-HTML swap), looping back to the original "thinking
block" report.

## Fix locus (JS-only; no CSS, no Go)

- **Self-heal on the `working()` busy edge (false→true)** → `setFollowing(true) +
  pin()` UNLESS an intent latch (`userScrolledUp`) says the user deliberately
  scrolled up (intent-latch decision: re-engage on new turn/resume, but do NOT
  yank a deliberate reader).
- **Add `&& working()` to the pill gate** `:1448` so the Live pill hides on
  finished/idle turns.
- **Add e2e tests**: composer-grow keeps following (9); deliberate-scroll-up
  reader is not yanked on a new turn (10b); pill hides when finished (11).
  (10a — spurious-loss re-engage — is documented as a skipped test needing a
  fixture hook, since under the fix content-shrinks no longer drop `following`.)

## Full `following()` lifecycle map (line numbers at HEAD 7ce1629)

- **engage** (set true): `:468` (jumpToLatest), `:570`/`:575` (maybeRestore
  stale-anchor / no-anchor bottom branches), `:751` (onScrolled scroll-back-to-
  bottom), `:956` (session-switch effect).
- **disengage** (set false): `:565` (maybeRestore anchor branch), `:697`
  (contentEl RO guard `scrollTop < pinnedTop && !shrank`), `:751` (onScrolled
  scroll-away).
- **reads**: `:657` (reactive ack effect), `:673` (contentEl RO `if (following())`
  gate), `:731` (scrollEl RO re-pin), `:749` (onScrolled own-pin bail),
  `:1448` (Live pill Show), `:1455` (Latest button Show).
