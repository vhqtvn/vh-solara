import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// P1-WEB-003: Playwright e2e coverage for the scroll read-position feature.
// Two sub-tasks that the existing browser-smoke suite did NOT exercise:
//
// (a) LIVE STREAM + mid-stream scroll-up + ".jump" button — the streaming-
//     distinctive path. scroll-follow test (4) covers the [[stall]] path
//     (busy with NO content streaming), so the contentEl ResizeObserver's
//     re-pin loop (ChatView.tsx :820-852) never competes and there is no
//     stream-completion edge. This test fires a REAL prompt (4 streamed
//     chunks over ~720ms), scrolls up MID-STREAM, and asserts the "↓ Latest"
//     button appears AND SURVIVES stream completion — proving the intent
//     latch (userScrolledUp, armed at onScrolled's `!atBottom && !shrank`
//     site) keeps the reader put despite the active pin loop re-gluing each
//     frame while following was true, and through the busy→idle transition.
//
// (b) RELOAD lands on the anchored [data-mid] row — the maybeRestore restore-
//     target path. unread-dot tests (3)/(4) + scroll-follow test (12) cover
//     reload→restore but assert ONLY geometry ("not at bottom") or seed the
//     anchor synthetically via addInitScript. This test writes the anchor via
//     the REAL scroll-up→debounced flushReadCursor path, reads the DYNAMIC
//     anchor id back from localStorage, reloads, and asserts the viewport
//     lands SPECIFICALLY on that anchored [data-mid] row (not just "somewhere
//     off the tail"). This is the exact restore target maybeRestore positions.
//
// (c) POST-RELOAD WHEEL-DOWN — restore lands, then a real wheel-down must
//     ADVANCE the viewport and keep it there: the restore drift servo may not
//     revert the reader's own scrolling (provenance review: wheel-down was
//     unstamped, so the servo yanked every tick back to the anchor).
//
// (d) POST-RELOAD NAVIGATOR-DOT JUMP — restore lands, then clicking a turn-
//     navigator dot (rendered OUTSIDE .chat-scroll, inside .chat-main) must
//     LAND the jump, not have it aborted by the drift servo reverting the
//     smooth-scroll frames (which also cancels the animation outright).
//
// (e) POST-RELOAD KEYBOARD SCROLL — restore lands, then PageDown pressed
//     while a tabindex=0 transcript element (.msg-perf) INSIDE .chat-scroll
//     holds focus must ADVANCE the viewport and keep it: the keydown bubbles
//     to .chat-main's sensor (SCROLL_NAV_KEYS) and stamps the input marker,
//     so the browser's default container scroll is reader intent, not
//     "trusted drift" to be corrected back to the anchor.
//
// (f) POST-RELOAD POINTER DRAG — restore lands, then an extended pointer
//     drag whose scroll events extend BEYOND the initiating pointerdown
//     (>300ms) must be FOLLOWED, not reverted: the pointermove listener
//     (buttons≠0) restamps the input marker through the whole gesture,
//     keeping every scroll event of ONE drag fresh. Executed as a CDP touch
//     pan — the mouse scrollbar-thumb drag is inert under headless CDP
//     (see the test body for the probe).
//
// HOME: a new focused spec (not unread-dot.spec.ts or scroll-follow.spec.ts).
// The read-position machinery spans BOTH files' concerns (anchors + the jump
// button live in unread-dot; streaming + reload-restore live in scroll-
// follow), and both are already large (422L / 934L). A focused spec keeps the
// read-position feature coverage cohesive and discoverable without bloating
// either existing spec past its theme. The file sorts alphabetically BEFORE
// scroll-follow.spec.ts and unread-dot.spec.ts, so demo/other are in their
// pristine fixture state when this spec starts.
//
// Serial suite (workers:1, fullyParallel:false, one mutable fixture backend).
// Each test reloads to reset client state, matching the suite convention.

// Height 600, not the historical 320: since S2a (height-tier responsiveness,
// web/src/shapeTier.ts) 400×320 classifies as the `tiny` height tier, whose
// CSS defenses hide the `.working` pill — breaking waitForTurnSettled's
// turn-settle signal (`.working-text` visibility). Width 400 (narrow intent)
// is preserved; 600 is safely normal-tier (short is <=520, hysteresis leaves
// at >=536), and the demo transcript still overflows `.chat-scroll`
// (clientHeight ~370-406 depending on the composer's resolving-agent bar)
// so the scroll math below stays meaningful. Test (b) additionally GATES its
// transcript size on measured mid-row scroll margin (see midRowMargin there)
// rather than trusting the fixed viewport arithmetic.
const VP = { width: 400, height: 600 };

type Page = import("@playwright/test").Page;

// Prompt a session through the composer's route (POST /oc/session/<id>/
// prompt_async), run in-page so the request is same-origin and carries the
// X-VH-CSRF header the state-changing-request guard requires. A plain prompt
// (no [[perm]]/[[ask]]/[[stall]]) streams 4 chunks over ~720ms and completes —
// driving a real busy→idle turn (the same route the composer's send uses).
async function promptSession(page: Page, id: string, text: string) {
  await page.evaluate(
    async ({ id, text }) => {
      const res = await fetch(`/oc/session/${id}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      });
      // 204 is the expected immediate ack (the reply streams over SSE).
      if (!res.ok && res.status !== 204) {
        throw new Error(`prompt_async ${id} -> ${res.status}`);
      }
    },
    { id, text },
  );
}

// Wait for one full busy→idle turn: the busy shimmer appears, then vanishes.
// Awaiting each turn fully prevents concurrent simulatePrompt goroutines on
// the same session (which would interleave session.status/session.idle events
// and corrupt the aggregator's busyCount).
async function waitForTurnSettled(page: Page) {
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 12000 });
}

// Read a session's persisted read anchor directly from localStorage (key
// "vh.scroll.v2", envelope {v:1,data:{[sid]:msgId}} via lib/store.ts
// saveVersioned). The most direct proof the debounced flushReadCursor
// persisted the anchor — independent of the reopen/restore path.
async function readAnchor(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((sid) => {
    try {
      const raw = localStorage.getItem("vh.scroll.v2");
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 1 && parsed.data && typeof parsed.data === "object") {
        return (parsed.data as Record<string, string>)[sid] ?? undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }, id);
}

// Programmatic scroll — sets scrollTop synchronously, triggering the app's
// onScroll handler the same way a user wheel/drag would.
async function setScrollTop(page: Page, value: number) {
  await page.locator(".chat-scroll").evaluate((el: HTMLElement, v) => {
    el.scrollTop = v;
  }, value);
}

// Position a [data-mid] row's top edge at the scroll container's top edge —
// the exact geometry maybeRestore's anchor branch produces (delta =
// el.top - scrollEl.top; scrollTop += delta). Used to write a mid-history
// read anchor via the real scroll path: after this, bottommostReadFromDom
// returns the target row (the bottommost row whose top <= 0).
async function scrollRowToTop(page: Page, mid: string) {
  await page.locator(".chat-scroll").evaluate(
    (el: HTMLElement, mid) => {
      const row = el.querySelector(`[data-mid="${mid}"]`) as HTMLElement | null;
      if (!row) throw new Error(`row ${mid} not found`);
      const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop += delta;
    },
    mid,
  );
}

// Geometry snapshot for restore-target assertions: returns the anchored row's
// top relative to the scroll container's top edge (null if the row isn't
// mounted yet — lazy hydration), plus scrollTop / maxScroll for the
// mid-history + not-at-origin discrimators.
async function rowGeometry(page: Page, mid: string) {
  return page.locator(".chat-scroll").evaluate(
    (el: HTMLElement, mid) => {
      const row = el.querySelector(`[data-mid="${mid}"]`) as HTMLElement | null;
      const rowTopRel = row
        ? row.getBoundingClientRect().top - el.getBoundingClientRect().top
        : null;
      return {
        rowTopRel,
        scrollTop: el.scrollTop,
        maxScroll: el.scrollHeight - el.clientHeight,
      };
    },
    mid,
  );
}

// (a) LIVE STREAM + mid-stream scroll-up + ".jump" appears AND survives
//     stream completion. The streaming-distinctive path.
//
// A real prompt streams 4 chunks over ~720ms (the contentEl ResizeObserver
// re-pins on each chunk while following=true). We scroll up MID-STREAM and
// assert the "↓ Latest" button appears (following dropped despite the active
// pin loop) AND stays visible after the stream completes (intent latch held —
// the reader is NOT yanked back when working() goes true→false at idle).
//
// Distinct from scroll-follow test (4): test (4) uses [[stall]] (busy with NO
// content streaming — 5s server sleep, no assistant message, no message.part.
// delta events), so the contentEl RO pin loop never runs and there is no
// stream-completion edge to survive. This test exercises the real streaming
// pin loop (content growing each frame while following) AND the post-
// completion latch retention — the precise gap C-F1 flagged.
test("mid-stream scroll up surfaces the Latest button through stream completion", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Glue to the tail (following=true). The demo transcript overflows at
  // 400×600 (scrollHeight ~1450 vs clientHeight ~348), so scrolling up is
  // meaningful. Scroll-to-bottom glue (not a button.click) — the documented
  // deterministic pattern (avoids the detach-prone click path openDemo uses).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator("button.jump")).toHaveCount(0, { timeout: 3000 });

  // Fire a REAL prompt via the composer — streams 4 chunks over ~720ms.
  // (Not [[stall]]: we need real message.part.delta streaming + a normal
  // busy→idle completion, the path scroll-follow test (4) deliberately avoids.)
  await page.getByPlaceholder("Message…").fill("read-position stream probe");
  await page.keyboard.press("Enter");
  // Busy shimmer appears (session.status busy is emitted immediately on the
  // SSE, before the user message even appends).
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 5000 });

  // Scroll up MID-STREAM. onScrolled fires → following=false, userScrolledUp
  // armed (genuine scroll-away, !shrank — content is GROWING not shrinking),
  // scheduleReadCursor queued. Subsequent stream chunks fire the contentEl RO,
  // but following() is now false → the RO's re-pin block is skipped entirely
  // (it only re-pins while following) → the viewport stays scrolled up.
  await setScrollTop(page, 0);

  // MID-STREAM proof: the busy shimmer is STILL visible (the ~720ms stream
  // window has not elapsed) AND the "↓ Latest" button is visible despite the
  // active contentEl RO pin loop that was re-gluing each frame while following
  // was true. This is the streaming-distinctive assertion: following dropped
  // and STAYED dropped through competing content-growth RO callbacks.
  await expect(page.locator(".working-text")).toBeVisible();
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });

  // Wait for the stream to complete (session.idle → working()=false → shimmer
  // vanishes). The busy-edge self-heal effect fires on working() false→true
  // (already fired at stream start, while we were at the tail); the true→false
  // edge at idle does NOT re-engage following. (Generous timeout: the fixture
  // streams 4 chunks × 180ms + bookkeeping.)
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 12000 });

  // INTENT LATCH proof: the "↓ Latest" button is STILL visible after the
  // stream completed — the reader was NOT yanked back to the tail by the
  // idle transition or any post-stream geometry correction. The viewport is
  // provably off the tail (not at the bottom).
  await expect(page.locator("button.jump")).toBeVisible();
  const atBottom = await page.locator(".chat-scroll").evaluate(
    (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 24,
  );
  expect(atBottom).toBe(false);
});

// (b) RELOAD lands on the anchored [data-mid] row. The maybeRestore restore-
//     target path.
//
// Establishes a stored read anchor via the REAL scroll-up→debounced
// flushReadCursor path (NOT synthetic addInitScript seeding), reloads, and
// asserts the viewport lands SPECIFICALLY on the anchored row — the exact
// restore target maybeRestore's anchor branch positions.
//
// Distinct from scroll-follow test (12) + unread-dot tests (3)/(4): those
// assert ONLY geometry ("not at bottom", i.e. scrollTop < max - 24) or seed
// the anchor synthetically via addInitScript. This test reads the DYNAMIC
// anchor id from localStorage and asserts THAT EXACT row is positioned at the
// viewport top after reload — the precise restore target. The anchor id is
// dynamic (from the fixture's shared counter), so reading it back from
// localStorage is what makes the post-reload row assertion unambiguous and
// sub-pixel-position-robust (we assert the row the app ACTUALLY restored to,
// not the row we intended).
test("reload lands on the stored read-anchor [data-mid] row", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto(projectUrl("/?session=other"));
  // `other` starts EMPTY in the fixture (no seed messages, unlike `demo`). Wait
  // for the chat view to mount (not for messages — there are none yet), then
  // build the transcript before asserting/gluing.
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10000 });

  // Build an overflowing transcript: prompt turns (each appends a user +
  // assistant message) UNTIL the mid-history row has real scroll margin.
  // GEOMETRY-GATED, not a fixed count: at 400×600 a 6-message transcript
  // (3 turns) barely overflows and floor(len/2) lands within ~9px of the
  // max-scroll boundary — inside the composer-height swing (clientHeight
  // toggles ~370↔406 with the "Resolving agent…" bar), so the deliberate
  // scroll-up can clamp to a no-op (no scroll event → following never drops
  // → no jump button) and the post-reload restore clamps to rowTopRel > 8
  // (the flake this gate removes). 200px margin covers the bar swing, the
  // placeholder→real height settling drift, and keeps the anchor a genuine
  // mid-history position at any accumulated message count (serial suite +
  // repeat-each share the fixture backend; leftover `other` messages from
  // part-delta make the starting count vary). Serial turns (settle between
  // each) avoid concurrent simulatePrompt goroutines interleaving on one
  // session.
  const midRowMargin = () =>
    page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
      const rows = Array.from(el.querySelectorAll(".msg[data-mid]")) as HTMLElement[];
      const elTop = el.getBoundingClientRect().top;
      const mid = rows[Math.floor(rows.length / 2)];
      if (!mid) return -1;
      const midOffset = mid.getBoundingClientRect().top - elTop + el.scrollTop;
      return el.scrollHeight - el.clientHeight - midOffset;
    });
  let turns = 0;
  while (turns < 8) {
    await promptSession(
      page,
      "other",
      `read-position anchor seed turn ${turns + 1}.\nSecond line.\nThird line.\nFourth line.\nFifth line.`,
    );
    await waitForTurnSettled(page);
    turns++;
    if ((await midRowMargin()) >= 200) break;
  }
  // Hard precondition: the anchor region is decisively scrollable. If a
  // future layout change tightens the viewport, fail HERE with a clear
  // signal instead of knife-edging into the clamp flake below.
  expect(await midRowMargin()).toBeGreaterThanOrEqual(200);

  // Now messages exist. Glue to the tail: scroll to bottom → onScrolled
  // atBottom branch → clearReadAnchor (clears any stale anchor; defensive,
  // matches the unread-dot convention) + following=true. This is the known
  // bottom-pinned start state before the deliberate mid-history scroll-up.
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator("button.jump")).toHaveCount(0, { timeout: 3000 });

  // Read the runtime [data-mid] ids and pick a MID-HISTORY row (a genuine
  // middle position, not the first or last). floor(len/2) on 6 messages =
  // index 3. These ids are dynamic (u#/a# from the fixture's shared counter).
  const msgIds = await page
    .locator(".msg[data-mid]")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.mid ?? ""));
  expect(msgIds.length).toBeGreaterThanOrEqual(4); // 6 expected; >=4 for safety
  const midIdx = Math.floor(msgIds.length / 2);
  const anchorTarget = msgIds[midIdx];
  expect(anchorTarget).toBeTruthy();

  // Position the mid-history row's top at the scroll container's top. This is
  // a genuine mid-history scroll-up (not the extreme top). onScrolled fires →
  // following=false, userScrolledUp armed (intent latch), scheduleReadCursor
  // queued (leading-edge capture + 400ms debounce). The "↓ Latest" button
  // appears (following=false) — proves the scroll-up was processed.
  await scrollRowToTop(page, anchorTarget);
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });

  // Wait out the 400ms debounce so flushReadCursor persists the anchor before
  // reload. bottommostReadFromDom returns the bottommost row whose top <= 0 —
  // after scrollRowToTop that is anchorTarget itself (rows above have top < 0,
  // rows below have top > 0; sub-pixel may make it the row immediately above,
  // still mid-history — either way the persisted id is what we assert below).
  await page.waitForTimeout(600);

  // DIRECT verification: the anchor was persisted to localStorage via the real
  // debounced flush path (NOT synthetic seeding). This is the synchronous
  // proof, independent of the reopen path. The id is dynamic — reading it
  // back here is what makes the post-reload row assertion target the row the
  // app ACTUALLY stored, not the row we intended.
  const anchor = await readAnchor(page, "other");
  expect(anchor).toBeDefined();
  expect(msgIds).toContain(anchor);

  // RELOAD → fresh ChatView mount. Per GOTCHA #2 (the openSession timing
  // vuln): a fresh page load starts with following=true, pinnedTop=-1, so the
  // self-pin bail in onScrolled (following() && |scrollTop - pinnedTop| <= 1)
  // protects the anchor through the empty-content window (openSession pre-
  // initializes messages empty → browser clamps scrollTop to 0 → onScrolled
  // runs → bail fires → anchor NOT cleared before maybeRestore reads it).
  await page.reload();
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });

  // maybeRestore defers until the anchor lands in the snapshot order (or
  // delivery completes), then positions the anchored row's top at the scroll
  // container's top (delta = el.top - scrollEl.top; scrollTop += delta). Poll
  // for the restore to complete — lazy hydration streams messages one at a
  // time, so the anchor row may not exist immediately on reload.
  //
  // Three conditions, all required to pin the EXACT restore behaviour:
  //  - atTop: the anchored row is at the viewport top (|rowTopRel| <= 8px, the
  //    EXACT restore target — the gap vs existing tests that assert only "not
  //    at bottom"). 8px tolerates sub-pixel + Deferred lazy-mount scroll-
  //    anchoring drift; a WRONG row would be off by ~a full row height.
  //  - notAtBottom: scrollTop < max - 24 (mid-history, not a tail pin).
  //  - notAtOrigin: scrollTop > 24 (distinguishes a real mid-history restore
  //    from the empty-content scrollTop=0 clamp window — the timing-vuln sign
  //    that would mean the anchor was read too early or lost).
  await expect
    .poll(
      async () => {
        const g = await rowGeometry(page, anchor!);
        if (g.rowTopRel === null) return 0; // row not mounted yet (lazy hydration)
        const atTop = Math.abs(g.rowTopRel) <= 8;
        const notAtBottom = g.scrollTop < g.maxScroll - 24;
        const notAtOrigin = g.scrollTop > 24;
        return atTop && notAtBottom && notAtOrigin ? 1 : 0;
      },
      { timeout: 8000 },
    )
    .toBe(1);

  // Following=false at the restored anchor → "↓ Latest" offered (the reader
  // is NOT glued to the tail), Live pill hidden (following false so the
  // `following() && working()` Show is false regardless of working()).
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  await expect(page.locator(".chat-live")).toHaveCount(0);
});

// Shared prologue for the post-restore INTERACTION tests (c)/(d): drives the
// same REAL flow as test (b) — build an overflowing transcript on `other`
// (geometry-gated on mid-row scroll margin), glue to the tail, write the read
// anchor via the real scroll-up → debounced flushReadCursor path, reload, and
// resolve only once maybeRestore has verifiably parked the viewport on the
// stored anchor (same three-condition poll: atTop / notAtBottom / notAtOrigin).
// Returns the persisted anchor id. Parameterized on the viewport so (c) keeps
// the narrow-intent VP while (d) uses a desktop-width VP (>=721px) to render
// the right-edge turn navigator.
async function establishRestoredAnchor(
  page: Page,
  viewport: { width: number; height: number },
  minMargin: number,
): Promise<string> {
  await page.setViewportSize(viewport);
  await page.goto(projectUrl("/?session=other"));
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10000 });

  // Build an overflowing transcript (same geometry-gated loop as test (b);
  // serial turns avoid concurrent simulatePrompt goroutines).
  const midRowMargin = () =>
    page.locator(".chat-scroll").evaluate((el) => {
      const rows = Array.from(el.querySelectorAll(".msg[data-mid]")) as HTMLElement[];
      const elTop = el.getBoundingClientRect().top;
      const mid = rows[Math.floor(rows.length / 2)];
      if (!mid) return -1;
      const midOffset = mid.getBoundingClientRect().top - elTop + el.scrollTop;
      return el.scrollHeight - el.clientHeight - midOffset;
    });
  let turns = 0;
  while (turns < 8) {
    await promptSession(
      page,
      "other",
      `read-position interaction seed turn ${turns + 1}.\nSecond line.\nThird line.\nFourth line.\nFifth line.`,
    );
    await waitForTurnSettled(page);
    turns++;
    if ((await midRowMargin()) >= minMargin) break;
  }
  expect(await midRowMargin()).toBeGreaterThanOrEqual(minMargin);

  // Glue to the tail (known bottom-pinned start state), then anchor a genuine
  // mid-history row via the real scroll path.
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator("button.jump")).toHaveCount(0, { timeout: 3000 });

  const msgIds = await page
    .locator(".msg[data-mid]")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.mid ?? ""));
  expect(msgIds.length).toBeGreaterThanOrEqual(4);
  const anchorTarget = msgIds[Math.floor(msgIds.length / 2)];
  expect(anchorTarget).toBeTruthy();

  await scrollRowToTop(page, anchorTarget);
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(600); // 400ms debounce → anchor persisted

  const anchor = await readAnchor(page, "other");
  expect(anchor).toBeDefined();
  expect(msgIds).toContain(anchor!);

  // RELOAD → fresh ChatView mount → poll until the restore lands on the
  // anchored row (identical three-condition poll to test (b)).
  await page.reload();
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  await expect
    .poll(
      async () => {
        const g = await rowGeometry(page, anchor!);
        if (g.rowTopRel === null) return 0;
        const atTop = Math.abs(g.rowTopRel) <= 8;
        const notAtBottom = g.scrollTop < g.maxScroll - 24;
        const notAtOrigin = g.scrollTop > 24;
        return atTop && notAtBottom && notAtOrigin ? 1 : 0;
      },
      { timeout: 8000 },
    )
    .toBe(1);
  return anchor!;
}

// (c) POST-RELOAD WHEEL-DOWN — the restore drift servo must NOT revert the
//     reader's own scroll. The natural "continue reading" gesture after a
//     restore is scrolling DOWN; the servo's provenance sensor (wheel stamped
//     only for deltaY < 0) missed it, so every wheel-down tick was classified
//     as untrusted browser drift and corrected back to the anchor — the reader
//     could not advance past the restored position at all.
test("wheel down after restore advances the viewport instead of reverting", async ({ page }) => {
  const anchor = await establishRestoredAnchor(page, VP, 300);
  void anchor;

  const scrollTopNow = () =>
    page.locator(".chat-scroll").evaluate((el: HTMLElement) => el.scrollTop);
  const before = await scrollTopNow();

  // A REAL wheel-down over the chat viewport (position the mouse first —
  // page.mouse.wheel dispatches at the current position).
  const box = await page.locator(".chat-scroll").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(500);

  // The viewport STAYS scrolled down (advanced by roughly the wheel delta;
  // >100 leaves headroom for clamp/sub-pixel). Under the defect the servo
  // reverted the tick within the same scroll event, so this read ≈ before.
  const after = await scrollTopNow();
  expect(after).toBeGreaterThan(before + 100);

  // ...and it REMAINS advanced after the input-freshness window (300ms) has
  // fully elapsed — no deferred servo creep-back.
  await page.waitForTimeout(600);
  expect(await scrollTopNow()).toBeGreaterThan(before + 100);
});

// (d) POST-RELOAD NAVIGATOR-DOT JUMP — a jump initiated from OUTSIDE the scroll
//     container must LAND, not be aborted. ChatNavigator renders as a sibling
//     of .chat-scroll (inside .chat-main), so its dots were invisible to the
//     servo's pointerdown sensor (scoped to .chat-scroll). The smooth
//     scrollIntoView frames arrived with no stamped input → the trusted drift
//     servo reverted them tick-by-tick, and each corrective scrollTop write
//     also CANCELS the browser's smooth-scroll animation — the jump died at
//     its first frame and the reader stayed stuck on the restore anchor.
test("navigator dot jump after restore lands on the target turn", async ({ page }) => {
  // Desktop-width VP (isDesktop = matchMedia(min-width: 721px)) so the
  // right-edge turn navigator renders; the seeded turns give >= 2 user turns.
  const anchor = await establishRestoredAnchor(page, { width: 1000, height: 600 }, 200);

  const dots = page.locator(".chat-nav-dot");
  await expect(dots.first()).toBeVisible({ timeout: 5000 });
  expect(await dots.count()).toBeGreaterThanOrEqual(2);

  // The first dot jumps to the FIRST user turn — a large upward jump from the
  // mid-history anchor (block:"start" aligns that row's top to the scrollport
  // top; ~16px container padding keeps it within the tolerance below).
  const target = await page
    .locator(".msg.user[data-mid]")
    .first()
    .evaluate((el) => (el as HTMLElement).dataset.mid ?? "");
  expect(target).toBeTruthy();
  expect(target).not.toBe(anchor);

  await dots.first().click();
  // The jump LANDS: the target turn's row reaches the viewport top region.
  // Under the defect the aborted animation leaves it a full transcript away
  // and this poll times out.
  await expect
    .poll(
      async () => {
        const g = await rowGeometry(page, target);
        return g.rowTopRel !== null && Math.abs(g.rowTopRel) <= 48 ? 1 : 0;
      },
      { timeout: 5000 },
    )
    .toBe(1);

  // ...and it STAYS landed well past the click's 300ms input-freshness window
  // (no servo creep-back toward the abandoned restore anchor).
  await page.waitForTimeout(700);
  const g = await rowGeometry(page, target);
  expect(g.rowTopRel).not.toBeNull();
  expect(Math.abs(g.rowTopRel!)).toBeLessThanOrEqual(48);
});

// (e) POST-RELOAD KEYBOARD SCROLL — the drift servo must not revert the
//     reader's KEYBOARD scrolling either. The transcript contains tabindex=0
//     elements (MessageRow's .msg-perf — the `other` transcript has no
//     ToolPart panes, but every SETTLED assistant turn renders .msg-perf:
//     simulatePrompt's streamed turns carry time.{created,completed}, part
//     time.{start,end}, and tokens.output, so turnStats is non-empty). A
//     PageDown pressed while one of those holds focus scrolls .chat-scroll
//     (the nearest scrollable ancestor) — the keydown bubbles up to
//     .chat-main's sensor and stamps pendingInputAt (SCROLL_NAV_KEYS).
//     Pre-fix, keyboard scrolling was unstamped: every key-driven scroll
//     event was "trusted drift" and the servo snapped the reader back to the
//     restore anchor on the next frame.
test("keyboard PageDown after restore advances the viewport instead of reverting", async ({ page }) => {
  // minMargin 500: one PageDown advances ~0.9×clientHeight (~330px), so the
  // landing stays decisively OFF the tail — the assertions below then
  // measure the servo's no-revert, not the atBottom re-engage branch.
  await establishRestoredAnchor(page, VP, 500);

  const scrollTopNow = () =>
    page.locator(".chat-scroll").evaluate((el: HTMLElement) => el.scrollTop);
  const before = await scrollTopNow();

  // Focus a tabindex=0 transcript element that is ALREADY inside the
  // viewport — focusing an off-screen row would first scroll it into view
  // (an UNSTAMPED, servo-correctable move) and muddy the baseline. The
  // composer is OUTSIDE .chat-main (typing never stamps), so focusing a
  // TRANSCRIPT element is the point of this test.
  const focusedMid = await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    const top = el.getBoundingClientRect().top;
    const bottom = top + el.clientHeight;
    for (const perf of Array.from(el.querySelectorAll(".msg-perf")) as HTMLElement[]) {
      const r = perf.getBoundingClientRect();
      if (r.height > 0 && r.top >= top + 4 && r.bottom <= bottom - 4) {
        perf.focus();
        return perf.closest("[data-mid]")?.getAttribute("data-mid") ?? null;
      }
    }
    return null;
  });
  expect(focusedMid, "a viewport-visible tabindex=0 .msg-perf row to focus").toBeTruthy();

  // One REAL PageDown: the browser's default action scrolls the focused
  // element's scroll container down ~a page.
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(500);

  // The viewport ADVANCED (roughly one client-height; >100 leaves headroom
  // for engine page-overlap variance). Under the defect the servo reverted
  // the keydown-driven scroll back to the anchor within the same tick.
  const after = await scrollTopNow();
  expect(after).toBeGreaterThan(before + 100);

  // ...and it REMAINS advanced once the input-freshness window (300ms) has
  // fully elapsed — no deferred servo creep-back to the restore anchor.
  await page.waitForTimeout(600);
  expect(await scrollTopNow()).toBeGreaterThan(before + 100);
});

// (f) POST-RELOAD POINTER DRAG — a drag whose scroll events extend BEYOND the
//     initiating pointerdown. Executed as a TOUCH PAN (CDP touchStart/
//     touchMove/touchEnd spanning ~1s): the compositor-driven pan scrolls
//     .chat-scroll with real scroll events while contact-pointermove events
//     (pointerType "touch", buttons=1 — the exact `pointermove w/ buttons≠0`
//     restamp the fix claims) bubble to .chat-main's sensor, keeping every
//     scroll event of ONE gesture fresh past the 300ms INPUT_FRESHNESS window
//     of the pointerdown. (A MOUSE scrollbar-thumb drag is the other drag
//     surface, but it is NOT drivable here: under headless-Chromium CDP input
//     the press/moves dispatch DOM events yet the native scrollbar widget
//     never engages — probed live: pd:1, pm:7, scroll:0, delta 0, while wheel
//     scrolls fine. The touch pan is the honest executable form of the same
//     reader gesture.) Pre-fix, the marker went stale mid-drag and the servo
//     fought the reader tick-by-tick, reverting each dragged scroll event
//     back toward the anchor.
// (f) body — see the (f) header entry above for the gesture rationale.
test("touch drag after restore follows the gesture instead of reverting", async ({ page }) => {
  // minMargin 500: the pan (+ any residual fling momentum) stays decisively
  // off the tail, keeping the atBottom re-engage branch out of this test's
  // measurement.
  await establishRestoredAnchor(page, VP, 500);

  const scrollTopNow = () =>
    page.locator(".chat-scroll").evaluate((el: HTMLElement) => el.scrollTop);
  const before = await scrollTopNow();

  // Pan start: the centre of .chat-scroll's visible box. The finger then
  // travels UPWARD (a reader continuing DOWN the transcript); touch-action is
  // auto on .chat-scroll (probed), so the compositor pans the scroller.
  const start = await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + el.clientHeight / 2 };
  });
  const TRAVEL = 144; // total finger px, in 12 upward moves × 80ms (~960ms)

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: start.x, y: start.y }],
  });
  for (let i = 1; i <= 12; i++) {
    await page.waitForTimeout(80);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: start.x, y: start.y - (TRAVEL * i) / 12 }],
    });
    if (i === 6) {
      // MID-GESTURE, ~480ms in — past the freshness window of the
      // touchStart's pointerdown: the viewport is already following (only
      // the contact pointermove restamp keeps these scroll events trusted).
      // Under the defect this reads ≈ before and the test stops here.
      expect(
        await scrollTopNow(),
        "mid-drag (past the pointerdown's freshness window) the viewport already follows",
      ).toBeGreaterThan(before + 25);
    }
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(150); // let the (slow-drag) momentum settle

  // The gesture's net effect survives: the pan advances the viewport by
  // roughly the finger travel (probed ~0.85 px/px; 144px → ~120px), so >60
  // leaves headroom for slop/fling variance.
  const after = await scrollTopNow();
  expect(after, "the viewport follows the drag").toBeGreaterThan(before + 60);

  // ...and it STAYS put once the freshness window has fully elapsed after
  // the release — no deferred servo creep-back to the restore anchor.
  await page.waitForTimeout(600);
  expect(await scrollTopNow(), "no servo creep-back after the drag ends").toBeGreaterThan(before + 60);
});
