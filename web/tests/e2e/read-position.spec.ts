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

const VP = { width: 400, height: 320 };

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
  // 400×320 (scrollHeight ~1450 vs clientHeight ~70), so scrolling up is
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

  // Build an overflowing transcript: 3 prompt_async turns (each appends a user
  // + assistant message → 6 messages total). At 400×320 the ~70px chat
  // clientHeight is comfortably overflowed. Serial turns (settle between each)
  // avoid concurrent simulatePrompt goroutines interleaving on one session.
  // (Across repeat-each iterations the shared fixture backend accumulates
  // more messages on `other`; that's fine — we read runtime ids and pick
  // mid-history by index regardless of total count.)
  for (let i = 0; i < 3; i++) {
    await promptSession(
      page,
      "other",
      `read-position anchor seed turn ${i + 1}.\nSecond line.\nThird line.\nFourth line.\nFifth line.`,
    );
    await waitForTurnSettled(page);
  }

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
