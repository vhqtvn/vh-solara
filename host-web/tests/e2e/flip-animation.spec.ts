import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

/**
 * FLIP layout animation gate (host-web/src/layoutAnimation.ts) — the
 * DEFERRED-REFLOW (pinned-content) variant.
 *
 * The FLIP animates layout-to-layout transitions with a single GPU-composited
 * `transform` on the PINNED `.pane` child of each `.dv-render-overlay` — the
 * iframe content does NOT reflow during the morph (the old bitmap is scaled;
 * the one real reflow fires on settle). These tests assert the MECHANISM is
 * observable + cleans up, NOT the GPU smoothness (headless does not
 * GPU-rasterize; on-device is the final smoothness gate).
 *
 * Crux signals:
 *   1. DEFERRED REFLOW — DURING the animation the pinned `.pane` (and its
 *      iframe) keep their OLD pixel size while the overlay already has the
 *      NEW size; AFTER settle the pane matches the new size exactly. This is
 *      the deterministic proof the iframe resize (the in-SPA reflow +
 *      scroll-anchor) is deferred past the motion.
 *   2. CLEANUP — after a discrete op + settle, NO residual inline
 *      width/height/transform/transition remains on any `.pane` (or overlay).
 *   3. RUNS — a discrete split DOES create a transient transform transition
 *      (now on the `.pane` children; sampled via getAnimations() during the
 *      play window). This is what would regress to zero if the FLIP install
 *      silently no-op'd.
 *   4. REDUCED-MOTION — under prefers-reduced-motion, NO transform transition
 *      is ever created and NO pin is applied (content jumps directly to the
 *      new size; `.pane` rect == new size immediately).
 *   5. SURVIVAL — applying a transform to the `.pane` (an ANCESTOR of the
 *      iframe, never the iframe itself) does NOT reload the iframe. This is
 *      the architecture-A / renderer:'always' invariant; a transform that
 *      triggered a reload would fail the mission's STOP condition.
 *   6. EARLY PIN — the pin (inline width/height on the `.pane`) is present
 *      at the FIRST post-op observation — one microtask after the op, BEFORE
 *      any rAF/geometry commit/paint (dockview buffers onDidLayoutChange
 *      through AsapEvent = queueMicrotask; the handler pins in that same
 *      microtask). This closes the un-pinned-paint window (the residual
 *      single-flash hardening): no rAF-ordering slip can ever lay the iframe
 *      out at the new size before the pin.
 *   7. DARK BACKGROUNDS — `.pane`, `.pane-body`, and the iframe element
 *      compute a DARK opaque background-color (the settle blank-frame guard:
 *      engines can paint a blank — often white — frame inside a resizing
 *      iframe before the embedded document repaints; dark-on-dark makes it
 *      nearly invisible).
 *   8. BASELINE-FRESHNESS — a SILENT container resize (viewport/URL-bar —
 *      dockview commits overlay geometry without firing onDidLayoutChange)
 *      must not arm a stale baseline: the next layout EVENT (route change /
 *      activation) animates NOTHING and panes never grow back to the
 *      pre-resize size (the on-device "random weird animation" regression).
 *
 * Chromium only (the interaction spec's convention; Firefox/WebKit survival is
 * covered by survival.spec.ts). Serial with the rest of the suite
 * (playwright.config.ts: workers:1, shared fixture state).
 */

/** Max number of running CSS animations across all `.dv-render-overlay`
 *  elements AND their `.pane` children, sampled every ~20ms for `durationMs`.
 *  Used to detect a transient FLIP transition (normal motion: ≥1 during the
 *  play window) vs none (reduced-motion or a no-op'd install: always 0). The
 *  transform transition lives on the `.pane` CHILD (deferred-reflow
 *  technique), so both selectors are polled. Runs the sampling loop IN the
 *  browser so it does not race the animation window. */
async function maxFlipAnimations(page: Page, durationMs = 350): Promise<number> {
  return page.evaluate(async (durationMs) => {
    let max = 0;
    const deadline = performance.now() + durationMs;
    while (performance.now() < deadline) {
      let n = 0;
      for (const el of document.querySelectorAll(
        ".dv-render-overlay, .dv-render-overlay .pane",
      )) {
        n += el.getAnimations().length;
      }
      if (n > max) max = n;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    return max;
  }, durationMs);
}

/** Count elements with a residual INLINE FLIP style left by the animation.
 *  Must be 0 once the layout has settled.
 *
 *  - `.pane` children: transform / transition (the morph) AND width / height
 *    (the deferred-reflow PIN) — the FLIP owns all four on the child.
 *  - `.dv-render-overlay`: transform / transition ONLY. The FLIP never
 *    touches the overlay, but Dockview itself writes inline
 *    left/top/width/height geometry on overlays (overlayRenderContainer), so
 *    checking width/height there would count every overlay forever.
 *
 *  INLINE-ONLY by design: the FLIP only ever sets inline styles, and the
 *  COMPUTED transform on an overlay can never be a FLIP residual —
 *  dockview's base stylesheet pins a constant `transform: translate3d(0,0,0)`
 *  (+ `will-change: transform`) on `.dv-render-overlay` (dockview-core dist
 *  styles, the "GPU optimizations" block), so the computed value is the
 *  identity matrix even at rest. Comparing it against the string "none"
 *  would flag every overlay forever. */
async function residualStyleCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    let count = 0;
    for (const el of document.querySelectorAll<HTMLElement>(".dv-render-overlay")) {
      if (el.style.transform || el.style.transition) count++;
    }
    for (const el of document.querySelectorAll<HTMLElement>(".dv-render-overlay .pane")) {
      if (
        el.style.transform ||
        el.style.transition ||
        el.style.width ||
        el.style.height
      ) {
        count++;
      }
    }
    return count;
  });
}

/** Assert no residual FLIP style remains after a discrete layout op.
 *
 *  A bare zero-poll can FALSE-EARLY in the ~1-frame window right after the
 *  op: the FLIP transition is created synchronously on onDidLayoutChange but
 *  only "starts" (becomes visible to getAnimations) at the next style
 *  recalc. This helper waits past that pre-start window so the transition is
 *  running, THEN polls residual to 0 (cleared by transitionend, or the
 *  FLIP_DURATION_MS+slack fallback at ~210ms). Robust across multi-burst ops
 *  (split/swap emit several onDidLayoutChange bursts): residual stays
 *  non-zero while any burst's transition runs and only reaches 0 once the
 *  last one's transitionend (or fallback) fires. */
async function assertNoResidual(page: Page): Promise<void> {
  await page.waitForTimeout(60);
  await expect
    .poll(() => residualStyleCount(page), { timeout: 5000 })
    .toBe(0);
}

/** Live geometry of one pane's chain: overlay rect (getBoundingClientRect),
 *  pinned `.pane` layout box (offsetWidth/Height — transform-INDEPENDENT, so
 *  it reads the PIN size mid-morph, not the interpolated visual size), the
 *  iframe layout box, and the pane's inline FLIP styles. */
async function paneGeometry(page: Page, id: string): Promise<{
  overlay: { w: number; h: number };
  pane: { w: number; h: number };
  iframe: { w: number; h: number };
  inline: { width: string; height: string; transform: string; transition: string };
}> {
  return page.evaluate((id) => {
    const pane = document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`);
    const overlay = pane?.closest<HTMLElement>(".dv-render-overlay") ?? null;
    const iframe = pane?.querySelector<HTMLIFrameElement>("iframe") ?? null;
    const ov = overlay?.getBoundingClientRect();
    return {
      overlay: { w: ov?.width ?? 0, h: ov?.height ?? 0 },
      pane: { w: pane?.offsetWidth ?? 0, h: pane?.offsetHeight ?? 0 },
      iframe: { w: iframe?.offsetWidth ?? 0, h: iframe?.offsetHeight ?? 0 },
      inline: {
        width: pane?.style.width ?? "",
        height: pane?.style.height ?? "",
        transform: pane?.style.transform ?? "",
        transition: pane?.style.transition ?? "",
      },
    };
  }, id);
}

test.describe("FLIP layout animation (deferred reflow)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("DEFERRED-REFLOW: during an animated split the pinned .pane + iframe keep the OLD size while the overlay takes the NEW size; after settle the pane matches the new size", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];

    // Deterministic geometry: close every pane but `a`, so `a` is the lone
    // root group — a right-split of a lone group MUST halve its overlay
    // (proportional split), independent of the seeded grid's tree balancing
    // (splitting a pane in the seeded layout can rebalance SIBLING branches
    // without resizing the source pane at all).
    for (const id of ids.slice(1)) await H.closePane(page, id);
    await H.waitForLayoutSettled(page);
    await assertNoResidual(page);
    await expect.poll(async () => H.panes(page)).toEqual([a]);

    const before = (await H.survival(page, a))!;

    // All in ONE browser task: capture pre geometry, fire the split, then
    // sample the play window. offsetWidth/Height are LAYOUT reads —
    // independent of the interpolating transform — so the pinned size reads
    // EXACTLY as the pin value for the whole window.
    const r = await page.evaluate(async (a) => {
      const pane = document.querySelector<HTMLElement>(`.pane[data-pane-id="${a}"]`)!;
      const overlay = pane.closest<HTMLElement>(".dv-render-overlay")!;
      const iframe = pane.querySelector<HTMLIFrameElement>("iframe")!;
      const ovPre = overlay.getBoundingClientRect();
      const pre = {
        paneW: pane.offsetWidth,
        paneH: pane.offsetHeight,
        iframeW: iframe.offsetWidth,
        iframeH: iframe.offsetHeight,
        overlayW: ovPre.width,
      };
      const h = (window as unknown as { __host?: { split(i: string, d: "right" | "down"): string | null } }).__host;
      const created = h ? h.split(a, "right") : null;
      // Let the FLIP run: dockview commits overlay geometry first, and the
      // FLIP handler runs in a later-queued rAF of the SAME frame (see
      // layoutAnimation.ts TIMING GUARANTEE). Wait two frames so the pin +
      // invert + play are set before sampling.
      await new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
      // Sample INSIDE the play window (FLIP_DURATION_MS=150ms; the settle
      // clears the pin only at/after the transition end).
      const samples: Array<{
        paneW: number; paneH: number;
        iframeW: number; iframeH: number;
        overlayW: number;
        pinned: boolean;
      }> = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 90) {
        const ov = overlay.getBoundingClientRect();
        samples.push({
          paneW: pane.offsetWidth,
          paneH: pane.offsetHeight,
          iframeW: iframe.offsetWidth,
          iframeH: iframe.offsetHeight,
          overlayW: ov.width,
          pinned: pane.style.width !== "",
        });
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 15));
      }
      return { pre, created, samples };
    }, a);

    expect(r.created, "split created a new pane").toBeTruthy();
    expect(r.pre.overlayW, "precondition: lone pane spans most of the grid").toBeGreaterThan(200);

    // CRUX 1 — the morph ran PINNED: some sample inside the play window had
    // the pin applied.
    const pinnedSamples = r.samples.filter((s) => s.pinned);
    expect(
      pinnedSamples.length,
      "the .pane was PINNED (inline width) during the morph window",
    ).toBeGreaterThan(0);

    // CRUX 2 — deferred reflow: while pinned, the pane layout box AND the
    // iframe layout box kept the OLD size exactly (±1px engine rounding of
    // the same fractional box) — the iframe NEVER resized mid-morph.
    for (const s of pinnedSamples) {
      expect(Math.abs(s.paneW - r.pre.paneW), "pinned pane width == old width").toBeLessThanOrEqual(1);
      expect(Math.abs(s.paneH - r.pre.paneH), "pinned pane height == old height").toBeLessThanOrEqual(1);
      expect(Math.abs(s.iframeW - r.pre.iframeW), "iframe width == old width (reflow deferred)").toBeLessThanOrEqual(1);
      expect(Math.abs(s.iframeH - r.pre.iframeH), "iframe height == old height (reflow deferred)").toBeLessThanOrEqual(1);
      // The overlay, meanwhile, already held the NEW geometry (Dockview
      // committed it; a lone-pane right-split halves the overlay).
      expect(
        s.overlayW,
        "overlay width shrunk well below the old width (new geometry committed while content pinned)",
      ).toBeLessThan(r.pre.overlayW * 0.75);
    }

    // The source iframe survived the animated split (transform on the .pane
    // ancestor did not reload it).
    await H.assertSurvived(page, a, before, "source pane across animated split");

    // CRUX 3 — after settle: the pin is gone and the pane refills its
    // (new-size) overlay — the ONE deferred reflow landed.
    await H.waitForLayoutSettled(page);
    await assertNoResidual(page);
    const g = await paneGeometry(page, a);
    expect(g.inline.width, "no residual pin width after settle").toBe("");
    expect(g.inline.transform, "no residual transform after settle").toBe("");
    expect(
      Math.abs(g.pane.w - g.overlay.w),
      "settled pane width == overlay width (pin released)",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(g.pane.h - g.overlay.h),
      "settled pane height == overlay height (pin released)",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(g.iframe.w - g.overlay.w),
      "settled iframe width == overlay width (the deferred reflow fired)",
    ).toBeLessThanOrEqual(1);
  });

  test("EARLY-PIN: the pin is present at the FIRST post-op observation (microtask, pre-rAF) and the iframe never takes the new size before settle", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];

    // Deterministic geometry (mirror the DEFERRED-REFLOW test): close every
    // pane but `a` so a right-split MUST halve its overlay.
    for (const id of ids.slice(1)) await H.closePane(page, id);
    await H.waitForLayoutSettled(page);
    await assertNoResidual(page);
    await expect.poll(async () => H.panes(page)).toEqual([a]);

    const r = await page.evaluate(async (a) => {
      const pane = document.querySelector<HTMLElement>(`.pane[data-pane-id="${a}"]`)!;
      const overlay = pane.closest<HTMLElement>(".dv-render-overlay")!;
      const iframe = pane.querySelector<HTMLIFrameElement>("iframe")!;
      const pre = {
        paneW: pane.offsetWidth,
        paneH: pane.offsetHeight,
        iframeW: iframe.offsetWidth,
        iframeH: iframe.offsetHeight,
        overlayW: overlay.getBoundingClientRect().width,
      };
      const h = (window as unknown as { __host?: { split(i: string, d: "right" | "down"): string | null } }).__host;
      const created = h ? h.split(a, "right") : null;

      // FIRST observation — exactly ONE microtask yield. Dockview buffers
      // onDidLayoutChange through AsapEvent (a queueMicrotask enqueued
      // synchronously inside the op, verified in dockview-core dist), so
      // this continuation runs AFTER the handler's microtask: the EARLY PIN
      // must already be set. Still pre-rAF / pre-paint — no geometry commit
      // has happened (asserted below via the unchanged overlay width).
      await Promise.resolve();
      const first = {
        pinW: pane.style.width,
        pinH: pane.style.height,
        iframeW: iframe.offsetWidth,
        iframeH: iframe.offsetHeight,
        overlayW: overlay.getBoundingClientRect().width,
      };

      // Two rAFs: dockview commits the overlay geometry and the FLIP handler
      // runs its choreography (invert / hold-until-stable / play).
      await new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
      const committed = {
        overlayW: overlay.getBoundingClientRect().width,
        pinW: pane.style.width,
        iframeW: iframe.offsetWidth,
        iframeH: iframe.offsetHeight,
      };

      // Sample the pre-settle window: while the pin is present the iframe
      // must keep the OLD size (the deferred reflow has not fired).
      const during: Array<{ pinned: boolean; iframeW: number; iframeH: number }> = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 120) {
        during.push({
          pinned: pane.style.width !== "",
          iframeW: iframe.offsetWidth,
          iframeH: iframe.offsetHeight,
        });
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 12));
      }
      return { pre, created, first, committed, during };
    }, a);

    expect(r.created, "split created a new pane").toBeTruthy();
    expect(r.pre.overlayW, "precondition: lone pane spans most of the grid").toBeGreaterThan(200);

    // CRUX 1 — EARLY PIN: present at the very first post-op observation
    // (microtask time — BEFORE any rAF, geometry commit, or paint), at
    // exactly the OLD pixel size.
    expect(r.first.pinW, "pin width set at first observation (microtask, pre-rAF)").toMatch(/px$/);
    expect(r.first.pinH, "pin height set at first observation (microtask, pre-rAF)").toMatch(/px$/);
    expect(Math.abs(parseFloat(r.first.pinW) - r.pre.paneW), "early pin width == old pane width").toBeLessThanOrEqual(1);
    expect(Math.abs(parseFloat(r.first.pinH) - r.pre.paneH), "early pin height == old pane height").toBeLessThanOrEqual(1);
    // The observation was genuinely pre-commit: the overlay was still at the
    // OLD geometry, and the iframe had not resized.
    expect(Math.abs(r.first.overlayW - r.pre.overlayW), "first observation: overlay still OLD (pre-commit)").toBeLessThanOrEqual(1);
    expect(Math.abs(r.first.iframeW - r.pre.iframeW), "first observation: iframe still OLD").toBeLessThanOrEqual(1);
    expect(Math.abs(r.first.iframeH - r.pre.iframeH), "first observation: iframe still OLD (height)").toBeLessThanOrEqual(1);

    // CRUX 2 — geometry committed UNDER the pin: the overlay took the NEW
    // (~halved) size while the pane stayed pinned and the iframe stayed OLD.
    expect(r.committed.overlayW, "overlay committed the new (halved) geometry").toBeLessThan(r.pre.overlayW * 0.75);
    expect(r.committed.pinW, "pin still present after the geometry commit").not.toBe("");
    expect(Math.abs(r.committed.iframeW - r.pre.iframeW), "iframe still OLD after commit (never the new size before settle)").toBeLessThanOrEqual(1);
    expect(Math.abs(r.committed.iframeH - r.pre.iframeH), "iframe still OLD after commit (height)").toBeLessThanOrEqual(1);

    // CRUX 3 — pre-settle samples: every PINNED sample keeps the OLD iframe
    // size (a perfect every-frame assertion is impossible from Playwright;
    // the first-observation + committed + pinned-sample chain brackets the
    // whole window).
    const pinnedSamples = r.during.filter((s) => s.pinned);
    expect(pinnedSamples.length, "samples with the pin present in the pre-settle window").toBeGreaterThan(0);
    for (const s of pinnedSamples) {
      expect(Math.abs(s.iframeW - r.pre.iframeW), "pinned: iframe width == old width").toBeLessThanOrEqual(1);
      expect(Math.abs(s.iframeH - r.pre.iframeH), "pinned: iframe height == old height").toBeLessThanOrEqual(1);
    }

    // After settle: pin released, iframe == the NEW overlay size (the ONE
    // deferred reflow landed exactly once, after the motion).
    await H.waitForLayoutSettled(page);
    await assertNoResidual(page);
    const g = await paneGeometry(page, a);
    expect(g.inline.width, "no residual pin width after settle").toBe("");
    expect(g.inline.transform, "no residual transform after settle").toBe("");
    expect(Math.abs(g.iframe.w - g.overlay.w), "settled iframe == new overlay width").toBeLessThanOrEqual(1);
  });

  test("CLEANUP: after a discrete split + settle, no residual width/height/transform/transition on panes or overlays", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];

    const created = await H.split(page, a, "right");
    expect(created, "split created a new pane").toBeTruthy();
    // Wait for the FLIP play window to fully finish + clear its transient styles.
    await assertNoResidual(page);

    // Every pane sits exactly on its overlay (no lingering pin).
    const mismatched = await page.evaluate(() => {
      let n = 0;
      for (const pane of document.querySelectorAll<HTMLElement>(".dv-render-overlay .pane")) {
        const ov = pane.closest<HTMLElement>(".dv-render-overlay")!;
        if (Math.abs(pane.offsetWidth - ov.offsetWidth) > 1) n++;
        if (Math.abs(pane.offsetHeight - ov.offsetHeight) > 1) n++;
      }
      return n;
    });
    expect(mismatched, "every .pane refills its overlay after settle").toBe(0);
  });

  test("RUNS: a discrete split creates a transient transform transition on the pinned .pane children (FLIP is live)", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    // Start sampling FIRST (the loop runs in-browser), then trigger the split so
    // the ~150ms FLIP play window is captured regardless of bridge round-trip
    // latency. The split is fired via a microtask inside the same evaluate so it
    // lands within the sampling window.
    const promise = maxFlipAnimations(page, 350);
    // Tiny yield so the sampling loop begins before the split's layout change.
    await page.waitForTimeout(0);
    const created = await H.split(page, a, "right");
    expect(created, "split created a new pane").toBeTruthy();
    const maxN = await promise;

    expect(maxN, "FLIP transition ran on at least one pane").toBeGreaterThan(0);
    // And it still cleans up afterwards.
    await assertNoResidual(page);
  });

  test("REDUCED-MOTION: no transition is ever created and no pin is applied — content jumps directly to the new size", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const ids = await H.panes(page);
    const a = ids[0];

    const promise = maxFlipAnimations(page, 350);
    await page.waitForTimeout(0);
    const created = await H.split(page, a, "right");
    expect(created, "split created a new pane").toBeTruthy();
    const maxN = await promise;

    expect(maxN, "no FLIP transition under reduced-motion").toBe(0);

    // No pin either: the pane is ALREADY at the new size (== its overlay),
    // with zero inline FLIP styles. Allow the microtask queue to drain first.
    await page.waitForTimeout(80);
    const g = await paneGeometry(page, a);
    expect(g.inline.width, "reduced-motion: no pin width").toBe("");
    expect(g.inline.height, "reduced-motion: no pin height").toBe("");
    expect(g.inline.transform, "reduced-motion: no transform").toBe("");
    expect(g.inline.transition, "reduced-motion: no transition").toBe("");
    expect(
      Math.abs(g.pane.w - g.overlay.w),
      "reduced-motion: pane jumped directly to the new overlay width",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(g.pane.h - g.overlay.h),
      "reduced-motion: pane jumped directly to the new overlay height",
    ).toBeLessThanOrEqual(1);
    // Baseline-refresh-only also leaves no inline styles anywhere.
    await assertNoResidual(page);
  });

  test("SWAP: both panes survive an animated swap and no residual style remains", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;

    await H.swap(page, a, b);
    await assertNoResidual(page);

    await H.assertSurvived(page, a, ba, "swap pane A across animated swap");
    await H.assertSurvived(page, b, bb, "swap pane B across animated swap");
  });

  test("BASELINE-FRESHNESS: a silent container resize (viewport/URL-bar shrink) followed by a layout EVENT (route change) animates nothing — panes never grow back to the stale pre-resize size", async ({ page }) => {
    // ROOT-CAUSE REGRESSION (the "random weird animation" report): Dockview
    // commits container-driven overlay resizes (window resize, mobile
    // URL-bar collapse/expand, keyboard shrink) WITHOUT firing
    // onDidLayoutChange — only the pixel geometry changes, not the gridview
    // model. The FLIP baseline (lastRects, updated only inside the handler)
    // therefore goes STALE. The next layout EVENT (panel activation and
    // add/remove both fire it — upstream BaseGrid wires
    // Event.any(onDidAdd, onDidRemove, onDidActiveChange) into the buffered
    // onDidLayoutChange; a route change or a tap inside a pane is enough)
    // would early-pin panes at the pre-resize size: the pane child AND its
    // iframe visibly resize UP to the stale size (a real iframe reflow),
    // then morph back down — the reported bogus animation. "Random" because
    // it needs a silent persistent resize since the last genuine layout
    // event (URL-bar state change), which the operator cannot see.
    //
    // The fix: a ResizeObserver on the container marks the baseline suspect
    // and re-seeds it after dockview's overlay-rewrite rAFs commit; while
    // suspect, no pin is taken and no animation runs off the stale baseline.
    // This test reproduces the exact on-device sequence headlessly.
    await H.waitForLayoutSettled(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await H.waitForLayoutSettled(page);
    await assertNoResidual(page);

    // The TALL pane (its height tracks the viewport; the wide pane's width
    // does not change on a height-only shrink).
    const pre = await page.evaluate(() => {
      const panes = [...document.querySelectorAll<HTMLElement>(".dv-render-overlay .pane")];
      const tall = panes.sort((a, b) => b.offsetHeight - a.offsetHeight)[0];
      const ov = tall.closest<HTMLElement>(".dv-render-overlay")!;
      const iframe = tall.querySelector<HTMLIFrameElement>("iframe")!;
      return {
        id: tall.dataset.paneId!,
        overlayH: ov.getBoundingClientRect().height,
        iframeH: iframe.offsetHeight,
      };
    });
    expect(pre.overlayH, "precondition: tall pane occupies real height").toBeGreaterThan(300);

    // SILENT resize: shrink the viewport 60px (the URL-bar-expand analog).
    // Wait PAST the ~150ms commit propagation so the overlays hold the NEW
    // size while (pre-fix) lastRects still records the OLD one.
    await page.setViewportSize({ width: 1280, height: 660 });
    await page.waitForTimeout(400);

    // The resize itself was committed WITHOUT any FLIP involvement: the
    // iframe already sits at the NEW (smaller) height, with no residual
    // styles from any animation.
    const postResize = await page.evaluate((id) => {
      const pane = document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`)!;
      const ov = pane.closest<HTMLElement>(".dv-render-overlay")!;
      const iframe = pane.querySelector<HTMLIFrameElement>("iframe")!;
      return { overlayH: ov.getBoundingClientRect().height, iframeH: iframe.offsetHeight };
    }, pre.id);
    expect(
      postResize.overlayH,
      "viewport shrink committed: overlay height dropped ~60px",
    ).toBeLessThan(pre.overlayH - 30);
    expect(
      Math.abs(postResize.iframeH - postResize.overlayH),
      "post-resize: iframe already at the NEW natural height (no pin held)",
    ).toBeLessThanOrEqual(2);
    await assertNoResidual(page);

    // Now the reported operator action on the stale-baseline window: a
    // route change (selectTarget round-trip — fires the buffered
    // onDidLayoutChange via panel activation). Sample in-browser through
    // the whole window: NO transition may start, and the tall pane's
    // iframe must NEVER grow back toward the stale (pre-resize) height.
    const sampling = page.evaluate(async () => {
      let max = 0;
      let maxIframeH: number | null = null;
      const deadline = performance.now() + 400;
      while (performance.now() < deadline) {
        let n = 0;
        for (const el of document.querySelectorAll(".dv-render-overlay, .dv-render-overlay .pane")) {
          n += el.getAnimations().length;
        }
        if (n > max) max = n;
        const panes = [...document.querySelectorAll<HTMLElement>(".dv-render-overlay .pane")];
        const tall = panes.sort((a, b) => b.offsetHeight - a.offsetHeight)[0];
        if (tall) {
          const h = tall.querySelector("iframe")!.offsetHeight;
          if (maxIframeH === null || h > maxIframeH) maxIframeH = h;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 15));
      }
      return { max, maxIframeH };
    });
    await H.selectTarget(page, pre.id, "/repo/x", "sess-1");
    const anim = await sampling;

    expect(anim.max, "no FLIP transition after route change on a resized baseline").toBe(0);
    expect(
      anim.maxIframeH!,
      "iframe never grew back toward the stale pre-resize height",
    ).toBeLessThanOrEqual(postResize.iframeH + 1);

    // Final state: clean, still at the post-resize geometry.
    await assertNoResidual(page);
    const end = await paneGeometry(page, pre.id);
    expect(
      Math.abs(end.iframe.h - postResize.overlayH),
      "settled iframe stays at the post-resize height",
    ).toBeLessThanOrEqual(2);
  });

  test("DARK-BACKGROUNDS: .pane, .pane-body, and the iframe element compute a dark opaque background-color (settle blank-frame guard)", async ({ page }) => {
    // SETTLE BLANK-FRAME GUARD (Cause A): when the FLIP settle unpins a pane
    // the iframe resizes W1→W2; engines can paint a BLANK (often white)
    // frame inside a resizing iframe before the embedded document repaints.
    // The pane chain must therefore compute a DARK, OPAQUE background — the
    // iframe element's own background is the load-bearing one.
    const bg = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".dv-render-overlay .pane")!;
      const body = pane.querySelector<HTMLElement>(".pane-body")!;
      const iframe = pane.querySelector<HTMLIFrameElement>("iframe")!;
      const paneCs = getComputedStyle(pane);
      const bodyCs = getComputedStyle(body);
      const iframeCs = getComputedStyle(iframe);
      return {
        pane: paneCs.backgroundColor,
        body: bodyCs.backgroundColor,
        iframe: iframeCs.backgroundColor,
        // getPropertyValue (not the typed property) — colorScheme is not on
        // older TS lib.dom CSSStyleDeclaration interfaces.
        paneScheme: paneCs.getPropertyValue("color-scheme"),
        iframeScheme: iframeCs.getPropertyValue("color-scheme"),
      };
    });

    /** Parse a computed rgb()/rgba() color into channels. */
    const parse = (value: string, label: string) => {
      const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(value);
      expect(m, `${label}: computed background-color parses (got "${value}")`).not.toBeNull();
      return {
        r: Number(m![1]),
        g: Number(m![2]),
        b: Number(m![3]),
        a: m![4] === undefined ? 1 : Number(m![4]),
      };
    };

    for (const [label, value] of Object.entries({ pane: bg.pane, "pane-body": bg.body, iframe: bg.iframe })) {
      const c = parse(value, label);
      // Opaque — a transparent background would let a blank resize frame
      // show through to whatever sits behind the pane.
      expect(c.a, `${label}: background is opaque`).toBeGreaterThanOrEqual(0.99);
      // DARK — every channel well below mid-gray. The theme surface is
      // --bg #0d1117 = rgb(13,17,23); a UA default white flash is
      // rgb(255,255,255). 96 cleanly separates them.
      expect(Math.max(c.r, c.g, c.b), `${label}: background is dark (not white/transparent)`).toBeLessThan(96);
    }

    // color-scheme: dark on the pane chain (steers engines that derive the
    // blank/initial canvas color from the element's color-scheme away from a
    // white default; also inherited from :root — asserted computed).
    expect(bg.paneScheme.trim(), "pane color-scheme is dark").toContain("dark");
    expect(bg.iframeScheme.trim(), "iframe color-scheme is dark").toContain("dark");
  });
});
