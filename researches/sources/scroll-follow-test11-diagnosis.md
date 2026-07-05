---
date: 2026-07-05
head: 0d6164c
artifact_type: sources
research_question: |
  Why does scroll-follow e2e test (11) "the Live pill hides when the turn
  finishes" flake ONLY in the full serial suite (workers:1) but pass 50/50 in
  isolation, and what is the minimum-layer fix?
scope: |
  Read-only diagnosis + test-only fix of web/tests/e2e/scroll-follow.spec.ts
  (test 11 at :654), web/src/components/ChatView.tsx (.chat-live Show gate
  :1693, queue gate :1367, drainQueue :1253-1266, drain effect :1270-1275), and
  pkg/fixtures/opencode.go (FakeOpenCode struct :20, New :42, simulatePrompt
  :788, [[stall]] branch :854-856, appendMessage :896, busy map mirror :754-771,
  new /fixture/reset handler). Probe runs observed pre-fix and post-fix.
---

# Test (11) serial-only flake — diagnosis & Tier 2 fix

## Classification: SERIAL-ONLY, test-infrastructure fix (fixture reset)

Test (11) asserts the `&& working()` half of the `.chat-live` Live-pill Show
gate (`<Show when={following() && working() && !focusMode() && messages().length > 0}>`
at ChatView.tsx:1693): it starts a `[[stall]]` turn (working()=true → pill up),
waits for the turn to finish (working()=false), toggles focus on/off (the focus
half of the gate), and asserts the pill shows/hides accordingly.

- **Isolation:** `npx playwright test scroll-follow.spec.ts -g "Live pill hides
  when the turn finishes" --repeat-each=50 --retries=0` → **50/50 GREEN**.
- **Serial (pre-fix Tier 1):** `--repeat-each=50 --retries=0` → **50 failed**
  including 4× at test 11 (the target), 45× at test 6, 1× at test 8.

The flake is NOT a logic bug in the app or the test's assertions — it is
cross-test fixture-backend contamination with TWO contaminants.

## Mechanism — TWO cross-test contaminants in the shared fixture backend

The e2e suite is **serial** (`web/playwright.config.ts`: `workers:1,
fullyParallel:false`) and shares ONE mutable fixture backend
(`pkg/fixtures/opencode.go`). The `[[stall]]` sentinel drives a busy turn:

- `simulatePrompt` (:788) emits `session.status busy` (:801) then a
  `defer emit session.idle` (:802); the prompt is dispatched as a **goroutine**
  (`go f.simulatePrompt(...)` at :598/:606), so the HTTP send returns at once.
- The `[[stall]]` branch (:854-856) does `time.Sleep(5*time.Second); return` —
  the deferred idle fires AFTER the 5s sleep.
- Crucially, `simulatePrompt` **persists** the user message to the message store
  before the stall (`f.appendMessage(...)` at :806; "Also persists to the
  message store so a reload reflects the turn", :786-787). Non-stall turns also
  stream an assistant message (code/math/lists — UNEVEN heights).

### Contaminant 1 — leaked `[[stall]]` busy goroutine

Tests **(4)** and **(9)** send `[[stall]]`, assert `.working-text` visible, and
END without waiting for the 5s goroutine. That goroutine is still mid-sleep when
the NEXT test loads demo; `busy[demo]` (mirrored from the `session.status busy`
event at :754-771) is still `true`. If the next test's `send()` lands during the
leak window it hits the queue gate at ChatView.tsx:1367 (enqueue instead of
send), and the leaked goroutine's deferred idle then auto-sends the queued item
via `drainQueue` (:1253-1266), RE-BUSYING demo and racing test (11)'s
disappearance assertions.

### Contaminant 2 — transcript accumulation (the dominant cause for test 11)

Across ~50 serial iterations × 5 sending tests (4/9/10b/11/12), hundreds of
messages accumulate in `f.messages["demo"]`. The mix includes test 10b's
code/math assistant content (UNEVEN heights). The DOM snapshot at a test-11
failure shows DUPLICATED message sets (a long uneven transcript). On that long
transcript, the focus-toggle reflow (test 11 toggles focus on then off) shifts
the viewport just off the bottom → `following()` flips false → the chat-live gate
`following() && working() && ...` fails on `following()`, so the post-toggle
re-show assertion (`expect(.chat-live).toBeVisible`) fails. This is why test 11's
4 serial failures are at the FOCUS-gate re-show, NOT at the disappearance
assertions that contaminant 1 alone would predict.

**Why Probe 1 (isolation ×50) is green:** in isolation, test 11 accumulates ~50
identical short `[[stall]] finish gate` user messages — even geometry, so the
focus-toggle reflow stays glued to the bottom. The MIX (test 10b's uneven
assistant content) is what breaks the geometry; with a clean 6-message baseline
the focus-toggle reflow matches the isolation behavior.

## Why Tier 1 (test-only wait-for-idle) was INSUFFICIENT

Tier 1 added a serial-suite-scoped `test.beforeEach` that loads demo and waits
for `.working-text` to be gone (absorbing contaminant 1 — the leaked busy
goroutine) and de-duplicated the per-test preambles. This eliminated the
queue-gate/drainQueue re-busy race but did NOT touch the message store, so
**contaminant 2 persisted**: test 11 dropped from ~16 → 4 serial failures but
did not meet the 50× green bar. Escalation to Tier 2 was therefore required.

## Options re-evaluation (the 4 prior fix-options)

- **(a) magic-timeout for (10b)** — MOOT. (10b) is already fixed (c680b94); the
  (10b)↔(11) coupling is resolved.
- **(b) drain after (9)** — folds into (d) (same fixture-reset layer).
- **(c) ref-count `state.activity`** — **WRONG LAYER, REJECTED.** The
  contamination is not a slot-clobber race; ref-counting the protected
  `sessionWorking`/activity contract would touch app-side invariants for zero
  test benefit (the app behaves correctly — a busy turn IS in flight).
- **(d) fixture reset** — **RIGHT LAYER.** Both contaminants live entirely in
  test-only fixture infrastructure.

The recent slices (P1-WEB-002/003/004) touched only read-cursor/anchor
machinery — none of them are on the (11) path. (8) fixed in 504b8ff, (10b) in
c680b94.

## Tier 2 fix (fixture reset — `pkg/fixtures/opencode.go` + spec `beforeEach`)

A `POST /oc/fixture/reset?session=demo` route restores demo's messages to the
seeded baseline and clears the mirrored busy map, absorbing BOTH contaminants.
The spec's `test.beforeEach` calls it before loading demo. This is test-only
infrastructure — the fixture is never shipped.

### Deviation from the original Tier 2 proposal

The mission's Tier 2 spec proposed a **generation-counter** (stale-goroutine
emits become no-ops) + clear busy. That would fix contaminant 1 but NOT
contaminant 2 (the accumulated messages). The re-diagnosis found message
accumulation is the dominant cause for test 11's residual failures, so the fix
restores the message baseline too. No gen-counter is required: a stale stall
goroutine emits busy ONCE before its sleep (BEFORE the reset clears it) and its
only post-reset action is the deferred `session.idle` (harmless — it idles an
already-idle session; it never re-emits busy). Non-stall goroutines (test 10b)
finish in ~1s and do not leak across tests.

### Implementation

`pkg/fixtures/opencode.go` (~15 lines of test infra):

- New `baseline map[string][]messageWithParts` field on `FakeOpenCode`.
- At the end of `New()` (after all seeding, before `return f`): snapshot-copy
  `f.messages` per session into `f.baseline` (a shallow slice copy —
  `append([]messageWithParts(nil), msgs...)`; safe because every mutation path
  appends NEW `messageWithParts` and nothing mutates a seeded message's inner
  maps in place, so the baseline backing array is never written through).
- New `mux.HandleFunc("/fixture/reset", f.handleFixtureReset)` route.
- `handleFixtureReset`: parse `?session=`; under the lock restore
  `f.messages[session]` from `f.baseline[session]` (or delete if not seeded) and
  `delete(f.busy, session)`; then `f.emit("session.idle", ...)`; respond
  `200 {"reset": session}`.

`web/tests/e2e/scroll-follow.spec.ts` `test.beforeEach`:

```ts
test.beforeEach(async ({ page, request }) => {
  // Restore the fixture backend baseline (messages + busy) for demo. The
  // `request` fixture resolves the relative URL against the configured baseURL
  // (page.request would resolve against about:blank before any goto).
  const reset = await request.post("/oc/fixture/reset?session=demo", {
    headers: { "X-VH-CSRF": "1" },
  });
  expect(reset.ok()).toBe(true);
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Safety net: confirm demo is idle after the reset.
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 8000 });
});
```

The POST routes through the real web server's `/oc/*` passthrough
(`pkg/web/server.go` `handlePassthrough` strips `/oc` and reverse-proxies to
OpenCode); the `X-VH-CSRF` header satisfies the shared CSRF guard on `/oc/*`
POSTs.

The Tier 1 de-duplication (demo-based tests omit their own
VP/goto/msg.first preamble; tests 8 and 12 keep their own goto for their
different loads) is retained.

## Probe results

### Pre-fix
- **Probe 1** (isolation, test 11 ×50, `--retries=0`): **50/50 GREEN (5.2m)** —
  confirms the serial-only classification.
- **Probe 2** (full serial spec ×50, `--retries=0`, Tier 1 only):
  **66 failed / 50 skipped / 634 passed (17.8m)** — failures at `:628`
  (test 11) and `:267` (test 6, a co-observed serial flake of the same class).

### Post Tier 1 (serial ×50, `--retries=0`)
- **50 failed / 50 skipped / 650 passed (27.2m)** — test 11 dropped to 4
  failures (`:645`), test 6 at 45 (`:292`), test 8 at 1 (`:497`). Tier 1
  insufficient → Tier 2 escalation.

### Post Tier 2 (serial ×50, `--retries=0`)
- **649 passed / 50 skipped / 51 failed (15.1m)** — test 11 (`:658`) is **50/50
  GREEN** (zero failures). The 51 failures are: 50× test 6 (`:305`, pre-existing
  hard bug — fails deterministically in isolation on unmodified HEAD) and 1× test
  12 (`:744`, a stochastic stall-busy-emit vs reload timing race at ~2%). Neither
  is caused by the fix; both are out of scope for P1-WEB-029 (target = test 11).
  Test 6 is a candidate for a new task.

## Files

- `pkg/fixtures/opencode.go` — `baseline` field + snapshot in `New()`; new
  `/fixture/reset` route + `handleFixtureReset`.
- `web/tests/e2e/scroll-follow.spec.ts` — `test.beforeEach` calls the reset;
  demo-based test preambles de-duplicated (Tier 1, retained).
