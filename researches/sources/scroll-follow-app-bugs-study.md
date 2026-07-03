---
research_question: |
  Two production-reachable app bugs in vh-solara's scroll-follow system that
  surfaced after the self-heal/intent-latch fix (a4a7f7c / 750562c). (8)
  viewport-shrink → permanent Live loss (mechanism pinned). (10b)
  userScrolledUp latch defeated during turn start (mechanism NOT fully pinned).
  Produce a transition table, ranked fix options for (8), ranked root-cause
  hypotheses + runtime-probe spec for (10b), and verdicts on D2/D3/D4.
scope: |
  Static read-only study of the scroll-follow surface in
  web/src/components/ChatView.tsx, web/src/lib/scroll.ts,
  web/src/sync/selectors.ts, web/src/sync/stream.ts, web/src/styles.css,
  pkg/fixtures/opencode.go, and web/tests/e2e/scroll-follow.spec.ts.
  No files modified, no e2e runs. Bug (8) mechanism confirmed at runtime by
  build ses_0d94a4bc5ffe1UeR0hLqVfC2iG (P1-WEB-026). Bug (10b) mechanism
  needs a follow-up diagnosis slice (probe spec below).
confidence: HIGH for (8) mechanism + fix locus; HIGH for (10b) leading hypothesis H1 (static); MED for the "+100ms" timing interpretation (needs probe).
date: 2026-07-04
head: 93dfcd1
time_sensitive: STABLE — pure app logic, no external API or version drift. Recency requirement: none.
source_policy: |
  Repo canon first (AGENTS.md, ChatView.tsx, scroll.ts, selectors.ts,
  stream.ts, styles.css, fixture, e2e spec, docs/planning/backlog.md
  P1-WEB-026). No external sources required. Prior packet
  researches/sources/live-autofollow-lost-on-resize.md (HEAD 7ce1629,
  2026-06-30) is the PRE-implementation study that proposed the self-heal
  fix; it is superseded by this packet for line numbers and mechanism, but
  its design rationale (intent latch + busy-edge re-engage) is still the
  governing contract.
artifact_type: sources
promotion_targets: |
  Once a fix lands and passes, update docs/planning/backlog.md P1-WEB-026
  and the scroll-follow section of any durable ai/ playbook. Do NOT treat
  this researches/ packet as canonical behavior.
---

# Scroll-follow app bugs — study packet (bugs 8 and 10b)

Researcher read-only study. HEAD `93dfcd1`. This packet documents facts +
ranked options/hypotheses; it does NOT lock a single verdict for (8) (D1 left
to operator) and does NOT propose a final fix for (10b) without the runtime
probe (D2). All `file:line` citations are at HEAD `93dfcd1`.

A prior packet (`researches/sources/live-autofollow-lost-on-resize.md`,
HEAD `7ce1629`) proposed the self-heal + intent-latch design that was then
implemented (commits `a4a7f7c` maybeRestore defer-until-anchor, `750562c`
composer rAF guard). Its `following()` lifecycle map line numbers are STALE
(it cites e.g. onScrolled `:751`, scrollEl RO `:731`, pill gate `:1448`;
at HEAD `93dfcd1` these are `:878`, `:860`, `:1630`). The authoritative
lifecycle at HEAD is the transition table in this packet.

## Protected invariants (must honor; flag any fix that touches them)

- **`a4a7f7c` maybeRestore defer-until-anchor**: `maybeRestore()` early-returns
  `false` at `ChatView.tsx:667` when `!order.includes(anchor) && !delivered()`.
  Any fix that changes anchor/delivered handling must preserve this.
- **`750562c` composer rAF guard on `following()`**: session-switch effect at
  `ChatView.tsx:1115-1117` wraps the re-pin in
  `requestAnimationFrame(() => { if (following()) pin(); })`.
- **`4fa8255` reveal gate (`revealed()` opacity-only)**: unrelated to
  scroll-follow directly but shares the rendering path; do not couple.
- **`Deferred` never-unmount** and **`messagesError` lifecycle**: out of path
  but call out if a fix option ripples into them.
- **No GPU-expensive CSS**: `mask-image`/`-webkit-mask` on scroll containers,
  `backdrop-filter`, `content-visibility:auto`, `contain:paint` are all
  FORBIDDEN (WebRender heat — see AGENTS.md "Firefox/WebRender GPU gotchas").
  None of the fix options below propose any of these.

---

## Transition table — following() / userScrolledUp() / pinnedTop / pinnedScrollHeight

Verified by reading `ChatView.tsx` @ HEAD `93dfcd1` and confirming with repo
grep. `scroll.ts` holds NO following/latch state (it is a pure read-anchor
store + `bottommostRead()`).

### `following()` — the "glued to tail" signal

| Site | Line | Direction | Condition / trigger |
|------|------|-----------|---------------------|
| self-heal (busy edge) | `:416` | `true` | `working()` false→true edge AND `!userScrolledUp()` |
| resume on visibility | `:441` | `true` | `visibilitychange`→visible AND `ready()` AND `!userScrolledUp()` |
| `jumpToLatest()` | `:558` | `true` | **UNCONDITIONAL** inside `jumpToLatest()` |
| `maybeRestore()` no-anchor bottom | `:689` | `true` | reopen at bottom |
| `maybeRestore()` stale-anchor bottom | `:695` | `true` | reopen with stale anchor resolved to bottom |
| session-switch effect | `:1101` | `true` | `props.sessionId` change |
| `maybeRestore()` anchor (mid-history) | `:677` | `false` | reopen at a mid-history anchor |
| contentEl RO guard | `:823` | `false` | `scrollTop < pinnedTop && !shrank` |
| `onScrolled()` | `:891` | `atBottom` | `setFollowing(atBottom)` where `atBottom = nearBottom()` (`<24`) |

**Readers of `following()`:** `:415` (self-heal — actually reads
`userScrolledUp`), `:440` (resume gate), `:782` (ack effect gate), `:798`
(contentEl RO `if (following())`), `:860` (scrollEl RO re-pin gate),
`:878` (onScrolled self-pin bail), `:1116` (switch rAF re-pin), `:1630`
(`.chat-live` Live pill Show — also `&& working()`), `:1637` (`button.jump`
Show — `!following()`).

### `userScrolledUp()` — the intent latch

| Site | Line | Direction | Condition / trigger |
|------|------|-----------|---------------------|
| `jumpToLatest()` | `:559` | `false` | **UNCONDITIONAL** — clears latch at send / Latest click |
| `maybeRestore()` no-anchor bottom | `:690` | `false` | reopen at bottom |
| `maybeRestore()` stale-anchor bottom | `:696` | `false` | reopen stale→bottom |
| `onScrolled()` at-bottom | `:893` | `false` | `atBottom` true |
| session-switch effect | `:1102` | `false` | `props.sessionId` change |
| `maybeRestore()` anchor | `:684` | `true` | reopen at mid-history anchor |
| contentEl RO guard | `:824` | `true` | `scrollTop < pinnedTop && !shrank` |
| `onScrolled()` scroll-away | `:895` | `true` | `!atBottom && !shrank` |

**Readers of `userScrolledUp()`:** `:415` (self-heal gate — the ONLY thing
that suppresses busy-edge re-engage), `:440` (resume gate).

**Critical asymmetry:** `onScrolled()` and BOTH ResizeObservers do NOT read
`userScrolledUp()`. The latch is WRITTEN by `onScrolled`/ROs but only READ by
the self-heal and resume paths. This asymmetry is why a stray scroll event
(bug 8) arms the latch and then nothing downstream consults it before the RO
corrector is gated out.

### `pinnedTop` — "our own pin" sentinel (`let`, module-instance scope)

| Site | Line | Direction | Notes |
|------|------|-----------|-------|
| `pin()` | `:554` | write `scrollEl.scrollTop` | set to current `scrollTop` after pin |
| session-switch reset | `:737` | write `-1` | reset on session change |

### `pinnedScrollHeight` — pin-time scrollHeight (`let`)

| Site | Line | Direction | Notes |
|------|------|-----------|-------|
| `pin()` | `:555` | write `scrollEl.scrollHeight` | the ONLY writer |
| — | — | (never reset) | **NOT reset on session switch** — note this. Lives until next `pin()`. Only meaningful while `pinnedTop !== -1`. |

### `jumpToLatest()` callers (relevant to 10b)

| Caller | Line | Notes |
|--------|------|-------|
| `sendParts()` | `:1187` | **UNCONDITIONAL** — runs before dispatch on every non-queued send |
| `runShell()` | `:1306` | **UNCONDITIONAL** — same, shell sends |
| `button.jump` onClick | `:1638` | user-initiated (correct) |

`send()` `:1310-1347` queue path `:1326`: when `queueMode() && !draft &&
sessionId && working() && !text.startsWith("!") && text!=="/undo" &&
text!=="/redo"` → `enqueue(...); return;` — **skips `sendParts` entirely, so
`jumpToLatest` does NOT run on a queued send.** This is the differential that
makes (10b) pass in-suite (inheriting leaked busy) but fail from clean idle.

---

## Bug (8) — viewport-shrink → permanent Live loss

### Mechanism (CONFIRMED at runtime, build P1-WEB-026)

1. Session glued to tail: `following()=true`, `pinnedTop≈1066`,
   `pinnedScrollHeight≈1134` (clientHeight 348).
2. Viewport shrinks (mobile keyboard appears): `clientHeight 348→68`. New
   scrollable region is ~280px taller; `scrollHeight` ~unchanged but
   `scrollHeight - clientHeight` jumps so the bottom edge moves "down".
3. Browser layout-rounding emits a **stray `scroll` event** with
   `scrollTop = 1067` (off-by-1 vs `pinnedTop = 1066`).
4. `onScrolled()` `:868`: self-pin bail `:878`
   `scrollEl.scrollTop === pinnedTop && following()` → `1067 === 1066` is
   **false** → bail FAILS → body runs.
5. `:879 atBottom = nearBottom()` = `(scrollHeight - 1067 - 68) < 24` → the
   ~279px gap is `>> 24` → `atBottom = false`.
6. `:890 shrank = pinnedScrollHeight>0 && scrollEl.scrollHeight < pinnedScrollHeight`
   → content did NOT shrink → `shrank = false`.
7. `:891 setFollowing(atBottom)` → `setFollowing(false)`.
8. `:895 !atBottom && !shrank` → `setUserScrolledUp(true)` — **latch ARMED**.
9. scrollEl RO `:846-864` fires on the resize; `:860 if (following() && ready()) pin();`
   → `following()` now `false` → **re-pin SKIPPED**.
10. Result: stuck ~279px above the new bottom, `button.jump` visible,
    `.chat-live` hidden, for the full turn (~5s in the fixture; indefinitely
    in production until the user taps Latest).

**Flake rate:** ~6/50 locally (the stray scroll event depends on exact
sub-pixel rounding, so it is non-deterministic but production-reachable on
every mobile keyboard open).

### What the `:851-860` comment INTENDED, and why the assumption breaks

The comment block at `ChatView.tsx:851-860` asserts (paraphrased): on a
viewport shrink the new max scroll position is LARGER than the old
`scrollTop`, so the browser does NOT clamp `scrollTop` and therefore **no
`scroll` event fires** — which means `onScrolled` cannot "correct" the
situation, and the scrollEl RO re-pin at `:860` is the ONLY corrector. The
design then gates that corrector on `following()` (which is still true under
the assumed no-event world).

**Why it breaks:** the assumption "no clamp → no scroll event" is wrong under
sub-pixel / layout-rounding resize. The browser recomputes layout, and even
without clamping it can re-emit a `scroll` event whose `scrollTop` differs
from `pinnedTop` by ≤1px (observed 1066→1067). That stray event reaches
`onScrolled`, fails the strict `===` self-pin bail, and is mis-classified as
a deliberate user scroll-away — which both drops `following` AND arms the
`userScrolledUp` latch, gating out the very RO corrector the comment was
counting on. So the comment's conclusion ("RO is the only corrector") is
still true, but its premise ("so onScrolled can't interfere") is false, and
onScrolled's interference is exactly what defeats the corrector.

### Fix options for (8) — ranked minimal-risk-then-correctness

Leave D1 (which option) to the operator. Rankings and tradeoffs:

#### (8a) Tolerate ≤N px drift in the self-pin bail  — RANK 1 (minimal risk)

**Change:** `ChatView.tsx:878`
`if (scrollEl && scrollEl.scrollTop === pinnedTop && following()) return;`
→
`if (scrollEl && following() && Math.abs(scrollEl.scrollTop - pinnedTop) <= N) return;`
with `N = 1` (or a small constant).

**What the bail currently guards:** the self-pin bail prevents `onScrolled`
from re-evaluating `atBottom`/`following`/`userScrolledUp` immediately after
OUR OWN `pin()` writes `scrollTop` (which always emits a `scroll` event).
Without it, every `pin()` would self-trigger a scroll-away classification
whenever the pinned position was not pixel-exact at the bottom (it usually is
exactly at bottom, but the bail is the safety net). It ALSO guards against
double-processing a no-op scroll.

**What a tolerance threshold lets through:** a real user scroll of ≤1px. But a
1px scroll is well inside the `nearBottom()` `<24` band, so `atBottom` stays
`true`, `setFollowing(true)` is a no-op write, and
`setUserScrolledUp(false)` is also a no-op (already false when following).
Net behavior change for a real 1px user scroll: NONE. For a real scroll of
2..23px the bail still trips normally (those are real scrolls but still
classified at-bottom). The only edge case is `N` chosen too large (e.g. `N≥24`)
which would absorb a genuine small scroll-away — so keep `N` ∈ {1,2}.

**Invariant impact:** NONE. Does not touch `a4a7f7c` (`maybeRestore`
defer/delivered), `750562c` (rAF guard — different call site), `4fa8255`
(reveal), `Deferred`, or `messagesError`. No CSS. No fixture change. Smallest
possible diff (one line, one constant).

**Risk:** LOW. The only regression surface is the self-pin bail itself, and
the analysis above shows the threshold does not change classification for any
real scroll inside the nearBottom band.

#### (8b) Classify clientHeight-change-induced scroll event as non-user — RANK 2

**Change:** track `lastClientHeight` (the scrollEl RO at `:846-864` already
fires on viewport resize and can record it). When `onScrolled` runs, if
`scrollEl.clientHeight !== lastClientHeight` (or within a short debounce
window since the last RO fire) AND the `scrollTop` delta is small (≤1px),
classify the event as resize-induced and bail without dropping `following`
or arming the latch.

**What it lets through / regression surface:** scroll events carry NO "cause"
field, so payload-alone classification is impossible — this option REQUIRES
the `lastClientHeight`/debounce bookkeeping to be correct. The regression
window is: a genuine user scroll that happens to land within the debounce
window after a resize could be mis-classified as resize-induced and ignored.
This is a real but narrow risk (user scrolls immediately after keyboard
appears).

**Invariant impact:** NONE directly, but adds new state (`lastClientHeight`,
debounce timer) to the same surface. More complex than (8a). Still no CSS,
no protected-invariant touch.

**Risk:** MEDIUM. More correct in principle (distinguishes cause) but more
moving parts and a real mis-classification window. Strictly more code than
(8a) for a benefit that only matters if (8a)'s tolerance proves insufficient
in practice.

#### (8c-i) Gate the scrollEl RO re-pin on `!userScrolledUp()` instead of `following()` — RANK 3

**Change:** `ChatView.tsx:860` `if (following() && ready()) pin();`
→ `if (!userScrolledUp() && ready()) pin();`.

**Why it is strictly more work / less correct alone:** under bug (8), the
stray scroll event ARMS the latch (`:895`), so by the time the RO fires
`userScrolledUp()` is already `true` and the re-pin is still skipped. So
(8c-i) ALONE does not fix (8); it requires (8b)'s resize-classification to
prevent the latch from arming in the first place. It is a layering change
that makes the corrector consult the intent latch — defensible as a
defense-in-depth follow-up, but not a standalone fix.

**Invariant impact:** touches the RO gating semantics (the `:851-860` comment
block's contract). Does not touch `a4a7f7c`/`750562c`/`4fa8255`/`Deferred`/
`messagesError`. No CSS.

**Risk:** MEDIUM-HIGH as a standalone (doesn't fix the bug), LOW as a paired
follow-up to (8b). Not recommended alone.

#### (8c-ii) Debounce / coalesce the stray scroll event  — RANK 4 (not recommended)

A generic scroll-event debounce would suppress the stray event but would
also delay legitimate scroll-away classification, hurting responsiveness of
the `button.jump` appearance. Worse tradeoff than (8a). Mentioned for
completeness; do not pursue.

### (8) ranking summary

`(8a)` > `(8b)` > `(8c-i)` > `(8c-ii)`. (8a) is one line, no invariant touch,
no CSS, and provably does not change classification for any real scroll.
Operator decides D1.

---

## Bug (10b) — `userScrolledUp` latch vs busy-edge self-heal

### Observed behavior

Test (10b) (`scroll-follow.spec.ts:582-614`): glue tail → `setScrollTop(0)`
(arms `userScrolledUp`) → fill + Enter "a new turn while reading history" →
expect `.working-text` visible → assert NOT yanked (`.chat-live` count 0,
`button.jump` visible, `atBottom` false). **Fails 18/20 from clean idle
(repeat 1).** Passes IN-SUITE only by inheriting test (9)'s leaked BUSY state
(no idle→busy edge → self-heal never fires → vacuous pass).

### Full lifecycle of `userScrolledUp` during a turn

- **Armed** by: `maybeRestore` anchor (`:684`), contentEl RO guard (`:824`),
  `onScrolled` scroll-away (`:895`). In (10b)'s setup it is armed by the
  `setScrollTop(0)` triggering `onScrolled` `:895` (`!atBottom && !shrank`).
- **Cleared** by: `jumpToLatest` (`:559`), `maybeRestore` bottom
  (`:690`/`:696`), `onScrolled` at-bottom (`:893`), session switch (`:1102`).
- **Read** by: self-heal (`:415`), resume (`:440`). **Not read by onScrolled,
  not read by either RO** (the asymmetry noted above).

### Every site that can flip `following` TRUE during a turn start

During (10b)'s Enter→send→turn, the candidate re-engage sites are:

1. **`jumpToLatest()` at `sendParts` `:1187`** — UNCONDITIONAL,
   synchronous-at-send. Sets `following=true` AND clears the latch. (Leading
   suspect — see H1.)
2. **self-heal busy edge `:416`** — fires on `working()` false→true ~SSE
   latency after send, GATED on `!userScrolledUp()`. Correct by design.
3. **resume `:441`** — only on `visibilitychange`; not in (10b)'s path.
4. **`onScrolled` `:891` at-bottom** — only if a scroll event lands the
   viewport at bottom (requires a `pin()` or user scroll first).
5. **contentEl RO `:820-828`** — only fires on contentEl resize; the `else`
   branch calls `pin()` which re-glues, but only reached when
   `scrollTop >= pinnedTop || shrank`. After `setScrollTop(0)`,
   `scrollTop(0) < pinnedTop(1066)` and `!shrank`, so the guard branch runs
   (sets following=false), NOT the else/pin branch. Not a re-engage here.
6. **scrollEl RO `:860`** — gated on `following()`; following is true only if
   (1)/(2)/(4) already re-engaged it. Downstream.

### Ranked static root-cause hypotheses

#### H1 (LEADING, HIGH static confidence) — `jumpToLatest`-at-send clears the latch synchronously

`sendParts()` `:1187` calls `jumpToLatest()` UNCONDITIONALLY before
dispatching the send. `jumpToLatest` (`:557-561`) does
`setFollowing(true); setUserScrolledUp(false); pin()`. So pressing Enter from
a scroll-up reading position CLEARS THE LATCH AND YANKS TO TAIL synchronously
at send time — defeating the intent latch the test armed at `setScrollTop(0)`.

**This perfectly explains the in-suite-vs-clean-idle differential:**
- **Clean idle:** `working()=false` at Enter → `send()` `:1326` does NOT
  queue → `sendText`→`sendParts`→**`jumpToLatest` yanks** → `following=true`,
  latch `false` → test FAILS 18/20.
- **In-suite (inheriting (9)'s leaked busy):** `working()=true` at Enter →
  `send()` takes the QUEUE path (`:1326`, enqueue, return) →
  **`jumpToLatest` is NOT called** → latch stays armed → no idle→busy edge
  (`prevWorking` already `true` at `ready()`) → self-heal doesn't fire →
  `following` stays `false` → test PASSES vacuously.

The build session's note "following re-engages ~100ms into the turn" is
likely a MISATTRIBUTION: the visible re-engage is the self-heal firing
redundantly after `jumpToLatest` ALREADY set `following=true` synchronously.
The "+100ms" is SSE latency for `session.status busy` (fixture
`pkg/fixtures/opencode.go:801` emits busy at the start of `simulatePrompt`,
which runs in a goroutine after `prompt_async` returns 204 at `:601-608`).
Probe B (below) resolves this.

#### H2 — self-heal mis-fires despite latch

The build session's stated hypothesis. The self-heal `:410-419` is correctly
gated on `!userScrolledUp()`, so for it to mis-fire the latch must already be
`false`. That can only happen if H1 (`jumpToLatest`) cleared it, OR an
`onScrolled` at-bottom event (`:893`) cleared it after a re-pin. So H2 is
**DOWNSTREAM of H1 or of a re-pin event**, not an independent primary cause.
LOW standalone likelihood given H1's clean explanation of the differential.

#### H3 — RO / onScrolled re-entrancy

Both ROs and `onScrolled` only re-engage `following` when it is already true
or when the viewport is at bottom. After `setScrollTop(0)` the viewport is
NOT at bottom, so `onScrolled` would set `following=false` (already false
after the scroll-up) and the ROs no-op on `following()=false`. Re-entrancy
cannot re-engage `following` from this state without an intervening
`jumpToLatest`/self-heal/at-bottom event. LOW likelihood as a primary cause.

#### H4 — `maybeRestore` `restoredFor` one-shot

`maybeRestore` only runs on open/switch (`:797` in the contentEl RO calls it
on resize, but the `restoredFor` one-shot is keyed to session open). During
(10b)'s send there is no open/switch, so `maybeRestore` is not in the path.
VERY LOW likelihood.

#### H5 — `onScrolled` at-bottom clearing the latch

Requires a scroll event that lands the viewport at bottom. That needs a
prior `pin()` (which `jumpToLatest` does — so this is a sub-mechanism of H1:
`jumpToLatest`'s `pin()` writes `scrollTop=max`, emits a scroll event,
`onScrolled` sees `atBottom=true`, `:893 setUserScrolledUp(false)`). So H5 is
a CONFIRMATION PATH for H1, not an alternative. LOW standalone.

**Static ranking: H1 ≫ H2 > H5 > H3 > H4.**

### Runtime probe spec (mandatory before fix — see D2)

Goal: confirm H1 vs H2 and resolve the "+100ms" timing. Prefer Playwright-side
probes over app-source instrumentation (the `userScrolledUp` signal is NOT in
the DOM, so at least one probe needs app-source read — see Probe C).

#### Probe A — differential send path (NO app change, RECOMMENDED PRIMARY)

Run (10b)'s scenario twice from clean idle, `--repeat-each=20`, two variants:

- **Variant 1 (normal):** the existing Enter-to-send path (exercises
  `send()` → `sendParts` → `jumpToLatest` `:1187`).
- **Variant 2 (bypass):** after arming the latch with `setScrollTop(0)`,
  POST `prompt_async` DIRECTLY via `page.evaluate` `fetch`:
  ```js
  await page.evaluate(async (text) => {
    await fetch('/vh/sessions/<sid>/prompt_async', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VH-CSRF': '1' },
      body: JSON.stringify({ text }),
    });
  }, 'a new turn while reading history');
  ```
  (Confirm the exact route + body shape against `pkg/fixtures/opencode.go`
  and the SPA's send path before running.) In Variant 2, `sendParts`/
  `jumpToLatest` do NOT run, so the latch stays armed unless the self-heal
  (H2) or another site re-engages.

**Decision rule:**
- `following` re-engages in BOTH V1 and V2 → H2 (self-heal) is primary.
- `following` re-engages in V1 but NOT V2 → **H1 (`jumpToLatest`) CONFIRMED.**
- `following` re-engages in neither → re-examine H3/H5 with Probe C.

`--repeat-each=20` matches the observed 18/20 flake rate. Clean idle between
variants (the (9) busy-leak is the confounder — see Contradictions).

#### Probe B — timing, Playwright-side (resolves the "+100ms")

Attach a `MutationObserver` to `.chat-live` and `button.jump` before Enter;
record timestamps for: Enter-press, `.working-text` appearance, and the first
`.chat-live` show / `button.jump` hide (i.e. `following` going true).

- Re-engage timestamp `≈0ms` after Enter (before/synchronous with
  `.working-text`) → H1 (`jumpToLatest` at send, synchronous).
- Re-engage timestamp `+≈100ms` after `.working-text` (i.e. after SSE busy) →
  H2 (self-heal on the busy edge).
- Both → H1 primary, self-heal redundant (the expected H1 outcome).

#### Probe C — app-source instrumentation (ONLY if A/B ambiguous)

The `userScrolledUp()` signal is not in the DOM, so reading it requires
temporary app-source logging. Add (TEMPORARILY, diagnosis slice only):
- `:557` `jumpToLatest` entry — log `userScrolledUp()` before clear.
- `:415` self-heal — log `userScrolledUp()` and `edge` pre-`if`.
- `:891` `onScrolled` post-`setFollowing` — log `atBottom`, `scrollTop`,
  `userScrolledUp()`.
- `:1187` `sendParts` pre-`jumpToLatest` — log `userScrolledUp()`.

Read the log from the Playwright `console` event. This is the UNAVOIDABLE
app-source path if A and B disagree.

### D2 verdict — runtime-mandatory but NARROW

Static analysis gives HIGH-confidence H1 (it alone explains the clean-idle
vs in-suite differential with no hand-waving). BUT the build session's
"+100ms" observation is inconsistent with a purely-synchronous
`jumpToLatest`, and resolving that inconsistency is cheap. **Run Probe A
first (no app change, one Playwright script).** Probe A alone almost
certainly confirms H1. Only if A is ambiguous, add Probe B; only if B is
ambiguous, add Probe C. So: **D2 = runtime-mandatory (Probe A minimum), but
the runtime work is one small Playwright variant, not a broad
instrumentation campaign.** Do NOT propose a (10b) fix on static alone —
the "+100ms" must be explained first.

---

## D3 — one combined slice or two? → TWO slices

- **(8)** lives in `onScrolled` `:878` (self-pin bail) and the scrollEl RO
  `:860` corrector. Mechanism is PINNED. Fix locus is one line (8a). Can fix
  NOW with a tiny, invariant-safe diff.
- **(10b)** lives in `sendParts` `:1187` / `runShell` `:1306`
  (`jumpToLatest`-at-send) and possibly the self-heal `:415`. Mechanism needs
  Probe A first, and the fix is a behavioral change to send-time yank
  semantics (do NOT yank when the user deliberately scrolled up — i.e. gate
  `jumpToLatest` at `:1187`/`:1306` on `!userScrolledUp()`, or move the yank
  to a latch-respecting site). Different regression surface (send-time UX)
  than (8).

The two share ONLY the `following()`/`userScrolledUp()` CONTRACT, not a code
path. Splitting them keeps each diff small, each regression test focused,
and lets (8) land immediately while (10b) waits on Probe A. **D3 = two
separate slices.**

## D4 — does fixing (10b) uncouple (11)? → NO

(11)'s cross-test clobber is (9)'s `[[stall]]` (`pkg/fixtures/opencode.go:854-857`,
`time.Sleep(5*time.Second); return`) leaking BUSY into later tests via the
non-ref-counted `state.activity` slot (`stream.ts:220-225`). Fixing (10b)'s
`jumpToLatest`-at-send makes (10b) PASS from clean idle, but does NOTHING to
stop (9)'s busy from leaking into (11)/(12)/etc. The coupling is one-way:
**fixing (11) (drain-at-source: abort/reset between tests, or ref-count the
activity slot) would EXPOSE (10b) by removing the vacuous-pass mask; fixing
(10b) does NOT fix (11).** So (11) needs its own drain-at-source work
regardless. **D4 = NO; (10b) and (11) remain independently necessary.** (The
(11) test-isolation fix itself is out of scope here — downstream of D4.)

---

## Findings

- **(finding)**: source=ChatView.tsx:878, confidence=high, type=fact — The (8) culprit is the strict `scrollTop === pinnedTop` self-pin bail; a stray ≤1px scroll event from sub-pixel viewport resize defeats it.
- **(finding)**: source=ChatView.tsx:851-860 comment, confidence=high, type=fact — The "no scroll event fires on a shrink" assumption is empirically false under layout rounding; this is the contradiction the build session flagged.
- **(finding)**: source=ChatView.tsx:1187 + :557-561, confidence=high, type=fact — `sendParts` calls `jumpToLatest()` UNCONDITIONALLY, which clears `userScrolledUp` and yanks to tail synchronously at send time.
- **(finding)**: source=ChatView.tsx:1326, confidence=high, type=fact — The `send()` queue path (taken when `working()`) skips `sendParts` entirely, so `jumpToLatest` does not run on a queued send — this is the differential that makes (10b) pass in-suite (inheriting leaked busy) and fail from clean idle.
- **(finding)**: source=ChatView.tsx:415 + selectors.ts:84-95, confidence=high, type=fact — The self-heal is correctly gated on `!userScrolledUp()`; it is NOT buggy in isolation. H1 bypasses it by clearing the latch before the busy edge fires.
- **(finding)**: source=ChatView.tsx:415/440 vs :878/:860/:798, confidence=high, type=inference — `userScrolledUp()` is WRITTEN by onScrolled and both ROs but READ only by self-heal and resume. This asymmetry is why a stray scroll event (8) arms a latch that nothing downstream consults before the RO corrector is gated out.
- **(finding)**: source=ChatView.tsx:555 + (no reset site), confidence=high, type=fact — `pinnedScrollHeight` is NEVER reset (not even on session switch); only meaningful while `pinnedTop !== -1`. Latent footgun, not currently exploitable.
- **(finding)**: source=pkg/fixtures/opencode.go:854-857, confidence=high, type=fact — The `[[stall]]` fixture sleeps 5s with no idle emit, leaking BUSY across serial tests; this is the (11) clobber source, independent of (10b).
- **(assumption)**: confidence=medium, type=assumption — The "+100ms" re-engage timing observed in the build session is SSE latency for `session.status busy`, not a synchronous yank. Needs Probe B to confirm.
- **(prediction)**: confidence=high, type=prediction — Probe A Variant 2 (direct `prompt_async`) will show `following` staying FALSE, confirming H1.

## Contradictions

- **The `:851-860` comment vs observed behavior.** The comment asserts no
  `scroll` event fires on a viewport shrink (so `onScrolled` cannot
  interfere and the RO re-pin is the sole corrector). Runtime observation
  (build P1-WEB-026) shows a stray ≤1px scroll event DOES fire under
  layout rounding, and it is exactly that event that defeats the RO
  corrector. Resolution: the comment's CONCLUSION (RO is the corrector)
  stands; its PREMISE (no event) is false. Any fix should also update the
  comment.
- **The build session's "+100ms self-heal" attribution vs H1's synchronous
  `jumpToLatest`.** The build session attributed the re-engage to the
  self-heal firing ~100ms in. H1 says the re-engage is synchronous at send
  (`jumpToLatest` `:1187`) and the "+100ms" is redundant self-heal after
  `following` is already true. These are NOT mutually exclusive (both can
  fire), but the PRIMARY cause differs. Resolution: Probe A/B decides. Flag
  as UNRESOLVED until the probe runs.
- **(10b) in-suite vs clean-idle pass rate.** The test passes in-suite
  (inheriting (9)'s leaked busy) and fails 18/20 from clean idle. This is
  not a contradiction in the app; it is a test-isolation artifact — but it
  means the suite is currently VACUOUS for (10b). Resolution path is the
  (11) drain-at-source work (D4), independent of the (10b) app fix.

## Recommended durable artifact path

- This packet: `researches/sources/scroll-follow-app-bugs-study.md` (written).
- Companion (older, line-stale): `researches/sources/live-autofollow-lost-on-resize.md`
  — keep for design rationale, do NOT trust its line numbers.

## Recommended next specialist / command

1. **(8):** hand to `build` as a one-line slice (option 8a preferred) with an
   e2e guard that does NOT mask the real bug (the existing test (8) already
   catches via geometry; keep it). No researcher/debate needed — mechanism
   pinned, fix trivial.
2. **(10b):** hand a small Playwright-only diagnosis slice to `build` to run
   Probe A (Variant 1 vs Variant 2, `--repeat-each=20`). Once Probe A
   confirms H1, the fix is "gate `jumpToLatest` at `:1187`/`:1306` on
   `!userScrolledUp()` (or move the send-time yank behind the latch)" — a
   focused behavioral change, then a normal build slice.
3. **(11):** separate slice (drain-at-source), out of scope here.

## Progress summary / next checkpoint

Static study COMPLETE. Deliverable written. No runtime work done (by design —
read-only). Next checkpoint is the Probe A result for (10b) and the (8) fix
landing.
