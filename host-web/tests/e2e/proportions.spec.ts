import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// PROPORTIONAL SPLIT GEOMETRY — fractional persistence (v3) + live
// re-normalizer (host-web/src/dockview/proportions.ts +
// layoutPersistence.ts).
//
// WHAT THIS SPEC PROVES (mission cruxes):
//   1. PURE MATH (unit-grade, via the DEV bridge — host-web has no vitest;
//      page.evaluate is the repo's established pattern for host-web logic):
//      px→fraction→px round-trips, integer remainder distribution sums
//      EXACTLY, zero-size guards degenerate to equal shares.
//   2. CROSS-VIEWPORT RESTORE [CRUX]: an uneven layout built at 1280×800 and
//      reloaded at 800×600 restores the same pane SHARES (±2%) — the v3 blob
//      stores per-branch fractions, and cold restore recomputes px from the
//      CURRENT container. Also asserts the stored blob actually carries
//      `fraction` (not px `size`) and pane ids/params round-trip.
//   3. v2→v3 MIGRATION: a legacy px blob under vh-host:layout:v2 (no `v`
//      marker) loads through the in-memory fractionize path — proportional
//      restore at a DIFFERENT viewport, no seed fallback, and the next save
//      writes v3 + removes the legacy key.
//   4. LIVE RE-NORMALIZER [CRUX]: after an auto-transpose flip (dockview
//      rebuilds branch splitviews WITHOUT saved proportions — probe-measured
//      drift 60/40 → 50.9/49.1 → 47.3/52.7 across two resizes), a resize
//      within the tall regime re-applies the STORED user-intent fractions
//      through live-tree APIs (BranchNode.resizeChild) and both pane
//      identities SURVIVE (assertSurvived — no fromJSON, no iframe reload).
//
// The suite is serial (host-web playwright.config.ts: workers:1); each test
// clears persisted layout in beforeEach so it starts from the fresh seed.
// =============================================================================

/** Share tolerance (absolute fraction-of-extent). The mission's ±2%; the
 *  healthy paths measure within ±0.5% and the probe-measured broken paths
 *  drift >9pp, so this separates cleanly. */
const TOL = 0.02;

const WIDE = { width: 1280, height: 800 }; // build viewport (w/h=1.6 → wide)
const SMALL = { width: 800, height: 600 }; // restore viewport (w/h=1.33 → wide)
const TALL = { width: 600, height: 800 }; // flip viewport (h/w=1.33 → tall)
const TALL2 = { width: 500, height: 700 }; // in-regime resize (h/w=1.4 → tall)

// ---- geometry helpers --------------------------------------------------------

/** Each pane's share of the total extent along `axis` (groupBox-based —
 *  the same measurement the probe used; ±0.5% accurate against serialized
 *  shares). */
async function shares(
  page: Page,
  ids: string[],
  axis: "width" | "height",
): Promise<number[]> {
  const boxes: number[] = [];
  for (const id of ids) {
    const b = await H.groupBox(page, id);
    expect(b, `groupBox for ${id}`).not.toBeNull();
    boxes.push(b![axis]);
  }
  const total = boxes.reduce((a, b) => a + b, 0);
  expect(total, "positive measured extent").toBeGreaterThan(0);
  return boxes.map((x) => x / total);
}

function expectShares(
  actual: number[],
  expected: number[],
  label: string,
): void {
  expect(actual.length, `${label}: share count`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(
    Math.abs(actual[i] - expected[i]),
      `${label}: share[${i}] ${actual[i].toFixed(4)} vs ${expected[i].toFixed(4)}`,
    ).toBeLessThanOrEqual(TOL);
  }
}

/** Drag dockview sash `index` by (dx, dy) with the real mouse (the production
 *  resize gesture — its pointerup relayout is what saves dockview
 *  proportions). Waits for the FLIP animation to settle. */
async function dragSash(page: Page, index: number, dx: number, dy: number): Promise<void> {
  const sash = page.locator(".dv-sash").nth(index);
  const bb = await sash.boundingBox();
  expect(bb, `sash ${index} boundingBox`).not.toBeNull();
  const cx = bb!.x + bb!.width / 2;
  const cy = bb!.y + bb!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 8 });
  await page.mouse.up();
  await H.waitForLayoutSettled(page);
}

/** Drag the root sash so pane `ids[0]` reaches ~`target` share of the split
 *  axis (computes the px delta from the CURRENT geometry). */
async function dragToShare(
  page: Page,
  ids: [string, string],
  axis: "width" | "height",
  target: number,
  sashIndex: number,
): Promise<void> {
  const cur = await shares(page, ids, axis);
  const boxes: number[] = [];
  for (const id of ids) {
    const b = await H.groupBox(page, id);
    boxes.push(b![axis]);
  }
  const total = boxes.reduce((a, b) => a + b, 0);
  const delta = Math.round((target - cur[0]) * total);
  if (delta !== 0) {
    await dragSash(page, sashIndex, axis === "width" ? delta : 0, axis === "height" ? delta : 0);
  }
}

/** The stored v3 blob's grid shape for the active workspace: version marker +
 *  whether every root child carries `fraction` (and NOT px `size`). */
async function storedFractionShape(page: Page): Promise<{
  v: number | null;
  rootChildren: Array<{ hasFraction: boolean; hasSize: boolean; fraction?: number }>;
} | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as {
        v?: number;
        activeWorkspaceId: string;
        workspaces?: Array<{
          id: string;
          layout?: { grid?: { root?: { type?: string; data?: unknown } } } | null;
        }>;
      };
      const ws = parsed.workspaces?.find((w) => w.id === parsed.activeWorkspaceId);
      const root = ws?.layout?.grid?.root;
      if (!root || root.type !== "branch" || !Array.isArray(root.data)) return null;
      return {
        v: parsed.v ?? null,
        rootChildren: (root.data as Array<{ fraction?: number; size?: number }>).map((c) => ({
          hasFraction: typeof c.fraction === "number",
          hasSize: typeof c.size === "number",
          fraction: c.fraction,
        })),
      };
    } catch {
      return null;
    }
  }, H.LAYOUT_STORAGE_KEY);
}

// =============================================================================
// 1. PURE FRACTION MATH (unit-grade via the DEV bridge)
// =============================================================================

test.describe("proportion math (pure, via __hostProportions bridge)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await H.loadHost(page);
  });

  test("sizesToFractions: uneven px → shares summing to 1; zero/negative guards → equal", async ({ page }) => {
    const uneven = await page.evaluate(() => {
      const b = (window as unknown as { __hostProportions?: { sizesToFractions(s: number[]): number[] } }).__hostProportions;
      return b ? b.sizesToFractions([768, 512]) : null;
    });
    expect(uneven, "bridge present").not.toBeNull();
    expect(uneven!.length).toBe(2);
    expect(Math.abs(uneven![0] - 0.6)).toBeLessThan(1e-9);
    expect(Math.abs(uneven![1] - 0.4)).toBeLessThan(1e-9);
    expect(uneven!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);

    // Zero-size guard: all-zero sizes → equal fractions.
    const zeros = await page.evaluate(() => {
      const b = (window as unknown as { __hostProportions?: { sizesToFractions(s: number[]): number[] } }).__hostProportions;
      return b ? b.sizesToFractions([0, 0, 0]) : null;
    });
    expect(zeros).toEqual([1 / 3, 1 / 3, 1 / 3]);

    // Negative / non-finite sizes → equal fractions (never NaN).
    const bad = await page.evaluate(() => {
      const b = (window as unknown as { __hostProportions?: { sizesToFractions(s: number[]): number[] } }).__hostProportions;
      return b ? b.sizesToFractions([-1, 5]) : null;
    });
    expect(bad).toEqual([0.5, 0.5]);

    const empty = await page.evaluate(() => {
      const b = (window as unknown as { __hostProportions?: { sizesToFractions(s: number[]): number[] } }).__hostProportions;
      return b ? b.sizesToFractions([]) : null;
    });
    expect(empty).toEqual([]);
  });

  test("fractionsToSizes: integers summing EXACTLY (largest remainder); degenerate → equal; round-trip", async ({ page }) => {
    // Exact split.
    const even = await page.evaluate(() => {
      const b = (window as unknown as { __hostProportions?: { fractionsToSizes(f: number[], e: number): number[] } }).__hostProportions;
      return b ? b.fractionsToSizes([0.6, 0.4], 800) : null;
    });
    expect(even).toEqual([480, 320]);

    // Non-terminating shares: integer outputs, exact sum, largest remainder.
    const odd = await page.evaluate(() => {
      const b = (window as unknown as { __hostProportions?: { fractionsToSizes(f: number[], e: number): number[] } }).__hostProportions;
      return b ? b.fractionsToSizes([1 / 3, 1 / 3, 1 / 3], 1000) : null;
    });
    expect(odd!.reduce((a, b) => a + b, 0), "sums exactly to extent").toBe(1000);
    expect(Math.max(...odd!) - Math.min(...odd!)).toBeLessThanOrEqual(1);

    // Tie: half of an ODD extent splits floor/floor+1 (index-stable).
    const tie = await page.evaluate(() => {
      const b = (window as unknown as { __hostProportions?: { fractionsToSizes(f: number[], e: number): number[] } }).__hostProportions;
      return b ? b.fractionsToSizes([0.5, 0.5], 799) : null;
    });
    expect(tie!.reduce((a, b) => a + b, 0)).toBe(799);
    expect(Math.max(...tie!) - Math.min(...tie!)).toBeLessThanOrEqual(1);

    // Degenerate fractions (NaN) → equal split; zero extent → all zero.
    const degen = await page.evaluate(() => {
      const b = (window as unknown as { __hostProportions?: { fractionsToSizes(f: number[], e: number): number[] } }).__hostProportions;
      return {
        nanFrac: b ? b.fractionsToSizes([NaN, NaN], 500) : null,
        zeroExtent: b ? b.fractionsToSizes([0.5, 0.5], 0) : null,
      };
    });
    expect(degen.nanFrac).toEqual([250, 250]);
    expect(degen.zeroExtent).toEqual([0, 0]);

    // ROUND-TRIP: px → fractions → px preserves the split EXACTLY in sum and
    // within ±1 per element (largest-remainder integer distribution) across
    // multiple depths / uneven splits. Bit-exactness per element is NOT the
    // contract — the float fraction × extent product can floor either way.
    const rt = await page.evaluate(() => {
      const b = (window as unknown as {
        __hostProportions?: {
          sizesToFractions(s: number[]): number[];
          fractionsToSizes(f: number[], e: number): number[];
        };
      }).__hostProportions;
      if (!b) return null;
      const cases: number[][] = [
        [768, 512],
        [100, 900],
        [37, 53, 11],
        [1234],
        [5, 5, 5, 5, 5],
      ];
      return cases.map((sizes) => {
        const extent = sizes.reduce((a, c) => a + c, 0);
        const back = b.fractionsToSizes(b.sizesToFractions(sizes), extent);
        return {
          sizes,
          back,
          sumExact: back.reduce((a, c) => a + c, 0) === extent,
          withinOne: back.every((x, i) => Math.abs(x - sizes[i]) <= 1),
        };
      });
    });
    expect(rt, "bridge present").not.toBeNull();
    for (const c of rt!) {
      expect(c.sumExact, `round-trip ${JSON.stringify(c.sizes)} sums exactly`).toBe(true);
      expect(c.withinOne, `round-trip ${JSON.stringify(c.sizes)} within ±1 per element`).toBe(true);
    }
  });
});

// =============================================================================
// 2. CROSS-VIEWPORT RESTORE [CRUX] — fractions persist, px recomputed
// =============================================================================

test.describe("fractional persistence (v3)", () => {
  test.beforeEach(async ({ page }) => {
    // Sentinel clear (viewport-shape startup pattern): localStorage clears on
    // the FIRST boot of this test's context only — the migration test below
    // writes its legacy blob AFTER the first boot and needs it to survive the
    // in-test page.goto("/"). sessionStorage survives same-tab navigation and
    // is fresh per Playwright test context.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("vh-test:booted")) {
        localStorage.clear();
        sessionStorage.setItem("vh-test:booted", "1");
      }
    });
    await page.setViewportSize(WIDE);
    await H.loadHost(page);
    // Isolate proportions from auto-transpose (both viewports here are wide,
    // but be deterministic about it; the toggle persists across reloads).
    await H.setViewportEnabled(page, false);
  });

  test("CROSS-VIEWPORT RESTORE [CRUX]: uneven layout saved at 1280×800 restores same SHARES at 800×600; blob stores fractions", async ({ page }) => {
    test.setTimeout(90_000);

    // Build a real depth-2 uneven tree: 60/40 at the root, 35/65 nested.
    const [keeper, right] = await H.twoPanes(page);
    await dragToShare(page, [keeper, right], "width", 0.6, 0);
    const nested = await H.split(page, keeper, "down");
    expect(nested, "nested split created").toBeTruthy();
    await H.waitForReady(page, nested!);
    await H.waitForLayoutSettled(page);
    await dragToShare(page, [keeper, nested!], "height", 0.35, 1);
    await H.waitForLayoutSettled(page);

    // Flush the debounced save, then capture the ACTUAL achieved shares (the
    // sash drag granularity means ~60/40, not exactly).
    await H.waitForSavedLayout(page, 3);
    const savedRoot = await shares(page, [keeper, right], "width");
    const savedNested = await shares(page, [keeper, nested!], "height");
    // Sanity: the built layout is genuinely uneven (the test would vacuously
    // pass on an even split).
    expect(Math.abs(savedRoot[0] - 0.5)).toBeGreaterThan(0.05);
    expect(Math.abs(savedNested[0] - 0.5)).toBeGreaterThan(0.05);

    // The stored blob is v3 and carries FRACTIONS, not px sizes.
    const shape = await storedFractionShape(page);
    expect(shape, "v3 blob readable").not.toBeNull();
    expect(shape!.v, "blob stamped v:3").toBe(3);
    expect(shape!.rootChildren.length).toBe(2);
    for (const [i, c] of shape!.rootChildren.entries()) {
      expect(c.hasFraction, `root child ${i} carries fraction`).toBe(true);
      expect(c.hasSize, `root child ${i} carries NO px size`).toBe(false);
    }
    expect(Math.abs(shape!.rootChildren[0].fraction! - savedRoot[0])).toBeLessThanOrEqual(TOL);

    // Pane params before the reload (round-trip semantics: fromJSON reuses
    // ids verbatim; urls/labels must survive the fractional transform).
    const before = await H.paneParams(page);
    const beforeById = new Map(before.map((p) => [p.id, p]));

    // Reload at a SMALLER viewport — set BEFORE the load so the cold restore
    // measures the new container extent. (Cold restore recreates the iframes
    // by design — assertSurvived does not apply; pane SEMANTICS do.)
    await page.setViewportSize(SMALL);
    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);
    await expect
      .poll(async () => (await H.panes(page)).length, { timeout: 20_000 })
      .toBe(3);
    for (const id of await H.panes(page)) await H.waitForReady(page, id);
    await H.waitForLayoutSettled(page);
    await page.waitForTimeout(400); // RO-driven relayout + settle

    // CRUX: pane SHARES (not px) match the saved shares within ±2%.
    const restoredRoot = await shares(page, [keeper, right], "width");
    const restoredNested = await shares(page, [keeper, nested!], "height");
    expectShares(restoredRoot, savedRoot, "restored root shares @800×600");
    expectShares(restoredNested, savedNested, "restored nested shares @800×600");

    // Round-trip semantics preserved: same ids, same {url,label}.
    const restored = await H.paneParams(page);
    expect(restored.length).toBe(3);
    for (const r of restored) {
      const b = beforeById.get(r.id);
      expect(b, `restored pane ${r.id} existed before reload`).toBeDefined();
      expect(r.url, `restored pane ${r.id} url unchanged`).toBe(b!.url);
      expect(r.label, `restored pane ${r.id} label unchanged`).toBe(b!.label);
    }
  });

  test("v2→v3 MIGRATION: legacy px blob under vh-host:layout:v2 loads proportionally (no seed fallback) and is superseded on next save", async ({ page }) => {
    test.setTimeout(90_000);

    // Build an uneven 60/40 two-pane layout and capture its RAW px
    // serialization (the exact artifact a v2-era app would have saved).
    const [keeper, right] = await H.twoPanes(page);
    await dragToShare(page, [keeper, right], "width", 0.6, 0);
    await H.waitForLayoutSettled(page);
    // Flush the debounced save BEFORE rewriting storage, so no pending save
    // can fire after the rewrite (a v3 save would REMOVE the legacy key we
    // are about to plant).
    await H.waitForSavedLayout(page, 2);
    const savedShares = await shares(page, [keeper, right], "width");
    expect(Math.abs(savedShares[0] - 0.5)).toBeGreaterThan(0.05);
    const pxLayout = (await H.serialize(page)) as Record<string, unknown>;

    // Replace storage with a LEGACY v2 envelope: the px layout, NO `v:3`
    // marker, under the OLD key — and drop the v3 blob + URL hash so the
    // cold read must fall through to the legacy key.
    await page.evaluate(({ legacyKey, v3Key, payload }) => {
      localStorage.removeItem(v3Key);
      localStorage.setItem(
        legacyKey,
        JSON.stringify({
          activeWorkspaceId: "ws-1",
          workspaces: [{ id: "ws-1", name: "Workspace 1", layout: payload }],
        }),
      );
      // Drop the #state= hash WITHOUT firing hashchange (same trick the app's
      // save path uses) so the next load's hash read misses.
      window.history.replaceState(null, "", window.location.pathname);
    }, { legacyKey: H.LEGACY_LAYOUT_STORAGE_KEY_V2, v3Key: H.LAYOUT_STORAGE_KEY, payload: pxLayout });

    // Cold load at a DIFFERENT viewport (900×700) — the legacy px blob must
    // restore PROPORTIONALLY (fractions recomputed against the new extent),
    // not px-exactly and not seed-fallback.
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto("/");
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);
    await expect
      .poll(async () => (await H.panes(page)).sort(), { timeout: 20_000 })
      .toEqual([keeper, right].sort());
    for (const id of await H.panes(page)) await H.waitForReady(page, id);
    await H.waitForLayoutSettled(page);

    const restoredShares = await shares(page, [keeper, right], "width");
    expectShares(restoredShares, savedShares, "migrated v2 blob restores shares @900×700");

    // The next save supersedes the legacy key: mutate → save flushes v3 and
    // REMOVES vh-host:layout:v2.
    const extra = await H.split(page, keeper, "down");
    expect(extra, "post-migration split works").toBeTruthy();
    await H.waitForSavedLayout(page, 3);
    const legacyLeft = await page.evaluate((key) => localStorage.getItem(key), H.LEGACY_LAYOUT_STORAGE_KEY_V2);
    expect(legacyLeft, "legacy v2 key removed after the first v3 save").toBeNull();
    const shape = await storedFractionShape(page);
    expect(shape?.v, "the superseding save is v3").toBe(3);
  });
});

// =============================================================================
// 3. LIVE RE-NORMALIZER [CRUX] — post-flip resize keeps user-intent shares
// =============================================================================

test.describe("live proportional re-normalizer (post-flip resize)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.setViewportSize(WIDE);
    await H.loadHost(page);
    // Auto-transpose stays ON (default after clear) — the flip is the defect
    // trigger this re-normalizer exists to heal.
  });

  test("RE-NORMALIZE [CRUX]: resize after an auto-transpose flip restores the user's split shares; both panes SURVIVE", async ({ page }) => {
    test.setTimeout(90_000);

    // Uneven 60/40 split (the user's intent the snapshot must remember).
    const [a, b] = await H.twoPanes(page);
    await dragToShare(page, [a, b], "width", 0.6, 0);
    await H.waitForLayoutSettled(page);
    const intent = await shares(page, [a, b], "width");
    expect(Math.abs(intent[0] - 0.5)).toBeGreaterThan(0.05);
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;

    // Cross into TALL → the real auto-transpose flip (debounced; flush
    // deterministically through the production transposeNow path).
    await page.setViewportSize(TALL);
    await H.viewportTransposeNow(page);
    await H.waitForLayoutSettled(page);
    expect(await H.viewportOrientation(page), "flipped to VERTICAL").toBe("VERTICAL");
    // The flip itself is fraction-preserving (probe: 0.5993/0.4007) — sanity.
    const postFlip = await shares(page, [a, b], "height");
    expectShares(postFlip, intent, "post-flip shares (flip is proportional)");

    // Resize WITHIN the tall regime. Without the re-normalizer this is where
    // dockview's post-flip lost-proportions regime drifts (probe: 60/40 →
    // 50.9/49.1 → 47.3/52.7). With it, the debounced resize-end re-applies
    // the stored fractions through live-tree APIs only.
    await page.setViewportSize(TALL2);
    await page.waitForTimeout(700); // past the 200ms re-normalize debounce
    await H.waitForLayoutSettled(page);
    await expect
      .poll(async () => {
        const s = await shares(page, [a, b], "height");
        return (
          s.length === 2 && Math.abs(s[0] - intent[0]) <= TOL && Math.abs(s[1] - intent[1]) <= TOL
        );
      }, { timeout: 8000 })
      .toBe(true);

    // Still VERTICAL (no spurious flip-back), and BOTH pane identities
    // SURVIVED the re-normalize (live-tree ops — no fromJSON, no reload).
    expect(await H.viewportOrientation(page), "still VERTICAL in the tall regime").toBe("VERTICAL");
    await H.assertSurvived(page, a, ba, "re-normalize pane A");
    await H.assertSurvived(page, b, bb, "re-normalize pane B");

    // A SECOND in-regime resize stays corrected too (the apply's relayout
    // re-saves dockview proportions, but the snapshot is still authoritative).
    await page.setViewportSize({ width: 450, height: 720 });
    await page.waitForTimeout(700);
    await H.waitForLayoutSettled(page);
    await expect
      .poll(async () => {
        const s = await shares(page, [a, b], "height");
        return (
          s.length === 2 && Math.abs(s[0] - intent[0]) <= TOL && Math.abs(s[1] - intent[1]) <= TOL
        );
      }, { timeout: 8000 })
      .toBe(true);
    await H.assertSurvived(page, a, ba, "second re-normalize pane A");
    await H.assertSurvived(page, b, bb, "second re-normalize pane B");
  });
});
