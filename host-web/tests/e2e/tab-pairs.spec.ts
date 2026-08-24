import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

/**
 * TAB-PAIRS e2e: the workspace tab label renders one (running|unread) pair per
 * pane, in the workspace's live serialized panel order, derived ONLY from the
 * server-reported status aggregates (runningCount/unreadCount on the
 * {type:"status"} message).
 *
 * CROSS-DEVICE HONESTY (deliberate scope): real two-device convergence rides
 * the EXISTING server machinery (tree stream + /vh/ack — see
 * web/src/statusEmitter.ts derivePaneCounts + actions.setSelectedId's
 * ack-on-select). This lane does NOT fake a two-device e2e; it asserts the
 * DERIVATION CONTRACT instead: the host renders EXACTLY the numbers the pane's
 * SPA reported (the SPA derives them from server-authoritative state, so any
 * device reporting from the same server reports the same numbers). Real
 * two-device verification = operator on-device, or a future lane-8
 * two-context test (flagged as an optional follow-up; NOT built here).
 *
 * The suite is serial (host-web playwright.config.ts: workers:1). Each test
 * calls loadHost in beforeEach for a fresh page + the seeded default workspace
 * (≥2 mock panes). Values are driven through the DEV bridge's probeStatus
 * (routes a full payload through the REAL router, source-bound to a real
 * pane's contentWindow — the same path the SPA's statusEmitter uses).
 */

const REPO_ROOT = path.resolve(process.cwd(), "..");
const VISION_DIR = path.join(REPO_ROOT, "tmp/host-web-playwright/vision/tab-pairs");

test.beforeAll(() => {
  fs.mkdirSync(VISION_DIR, { recursive: true });
});

/** Probe a full valid status with counts for a pane (through the real router). */
async function probeCounts(
  page: import("@playwright/test").Page,
  paneId: string,
  runningCount: number,
  unreadCount: number,
): Promise<void> {
  const r = await H.probeStatus(page, {
    sourcePaneId: paneId,
    origin: H.MOCK_ORIGIN,
    payload: {
      type: "status",
      dir: "",
      session: "",
      title: "",
      attention: "none",
      activity: "idle",
      following: true,
      runningCount,
      unreadCount,
    },
  });
  expect(r.accepted, `status (${runningCount}|${unreadCount}) accepted`).toBe(true);
}

/** The trailing (0|0) run for unprobed panes (the seeded ws has N>2 panes; the
 * mock's neutral echo covers the rest). Keeps expectations pane-count-robust. */
function zeros(n: number): string {
  return "(0|0)".repeat(Math.max(0, n));
}

test.describe("tab-pairs (per-pane (running|unread) in the workspace tab label)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // Feature: one pair per pane, in panel order, matching the pane's reported
  // aggregates exactly (the derivation contract).
  test("renders one (running|unread) pair per pane in panel order", async ({ page }) => {
    const ids = await H.panes(page);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    await probeCounts(page, ids[0], 2, 0);
    await probeCounts(page, ids[1], 0, 3);

    const ws1 = (await H.workspaces(page))[0];
    const pairs = page.locator(`[data-testid="ws-tab-pairs"][data-workspace="${ws1}"]`);
    await expect(pairs).toHaveAttribute("data-pairs", `(2|0)(0|3)${zeros(ids.length - 2)}`);
    await expect(pairs).toHaveText(`(2|0)(0|3)${zeros(ids.length - 2)}`);

    // DERIVATION CONTRACT: the rendered pair at index i equals the status the
    // pane at index i reported (the host renders, never derives).
    const rendered = await pairs.getAttribute("data-pairs");
    const panes = await H.panes(page);
    const perPane = rendered!.match(/\(([^|)]+)\|([^)]+)\)/g) ?? [];
    expect(perPane.length, "one pair per pane").toBe(panes.length);
    for (let i = 0; i < panes.length; i++) {
      const st = await H.status(page, panes[i]);
      expect(st, `pane ${panes[i]} reported a status`).not.toBeNull();
      expect(perPane[i]).toBe(`(${st!.runningCount}|${st!.unreadCount})`);
    }
  });

  // Feature: live updates — a re-reported status with changed counts flips the
  // rendered pair (idempotent-on-change emission → recompute → new signal).
  test("updates when a pane re-reports changed counts", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 2, 0);
    await probeCounts(page, ids[1], 0, 3);
    const ws1 = (await H.workspaces(page))[0];
    const pairs = page.locator(`[data-testid="ws-tab-pairs"][data-workspace="${ws1}"]`);
    await expect(pairs).toHaveAttribute("data-pairs", `(2|0)(0|3)${zeros(ids.length - 2)}`);

    await probeCounts(page, ids[1], 1, 1);
    await expect(pairs).toHaveAttribute("data-pairs", `(2|0)(1|1)${zeros(ids.length - 2)}`);
  });

  // Feature: BACKGROUND workspaces render their pairs too (the operator reads
  // a hidden workspace's load from its tab).
  test("background-workspace tab shows its pairs", async ({ page }) => {
    const ws2 = await H.addWorkspace(page, "Background");
    await H.addServer(page, `${H.MOCK_ORIGIN}/?srv=bgpairs&view=chat`, "bg-pairs");
    // panes() reflects the ACTIVE workspace — ws2 just activated, so its only
    // pane IS the ws2 pane. Wait for it to be live FIRST: the mock posts its
    // neutral handshake status (0|0) once its handshake lands, and that echo
    // must not overwrite the probe below (last write wins in statusByPane).
    const ws2Panes = await H.panes(page);
    expect(ws2Panes.length).toBeGreaterThanOrEqual(1);
    await H.waitForReady(page, ws2Panes[0]);
    await probeCounts(page, ws2Panes[0], 0, 2);

    // Switch back to ws1 (ws2 becomes background) — ws2's tab keeps its pairs.
    await H.setActiveWorkspace(page, (await H.workspaces(page))[0]);
    await expect
      .poll(async () => H.activeWorkspace(page))
      .toBe((await H.workspaces(page))[0]);
    await expect(
      page.locator(`[data-testid="ws-tab-pairs"][data-workspace="${ws2}"]`),
    ).toHaveAttribute("data-pairs", "(0|2)");
  });

  // Feature: the needs-you amber badge coexists with the pairs (distinct
  // signals: pairs carry running+unread, the badge carries needs_input).
  test("needs-you badge coexists with the pairs", async ({ page }) => {
    const ids = await H.panes(page);
    const r = await H.probeStatus(page, {
      sourcePaneId: ids[0],
      origin: H.MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: "",
        session: "s1",
        title: "Needy",
        attention: "needs_reply",
        activity: "idle",
        following: true,
        runningCount: 1,
        unreadCount: 2,
      },
    });
    expect(r.accepted).toBe(true);

    const ws1 = (await H.workspaces(page))[0];
    await expect(
      page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws1}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="ws-tab-pairs"][data-workspace="${ws1}"]`),
    ).toHaveAttribute("data-pairs", `(1|2)${zeros(ids.length - 1)}`);
  });

  // Feature: ZERO-PAIR FORK — a workspace whose panes are ALL (0|0) renders a
  // bare name (no pairs run). The seeded mock reports 0/0 for every pane.
  test("all-zero workspace shows the bare name (zero-pair fork)", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    // The mock's handshake status echo carries (0|0) — no pairs element.
    await expect(
      page.locator(`[data-testid="ws-tab-pairs"][data-workspace="${ws1}"]`),
    ).toHaveCount(0);
    await expect(page.locator(`[data-testid="ws-tab-label"]`)).toBeVisible();

    // Explicit (0|0) reports still read as zero (not "no status") → still bare.
    const ids = await H.panes(page);
    for (const id of ids) await probeCounts(page, id, 0, 0);
    await expect(
      page.locator(`[data-testid="ws-tab-pairs"][data-workspace="${ws1}"]`),
    ).toHaveCount(0);
  });

  // Feature: closed-set validation — junk counts reject the whole status (the
  // previously stored status is untouched; no partial store).
  test("rejects junk counts (closed non-negative integers)", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 1, 1);
    const before = await H.status(page, ids[0]);

    for (const junk of [-1, 1.5, NaN, "2", null]) {
      const r = await H.probeStatus(page, {
        sourcePaneId: ids[0],
        origin: H.MOCK_ORIGIN,
        payload: {
          type: "status",
          dir: "",
          session: "",
          title: "",
          attention: "none",
          activity: "idle",
          following: true,
          runningCount: junk as unknown as number,
          unreadCount: 0,
        },
      });
      expect(r.accepted, `junk runningCount=${String(junk)} rejected`).toBe(false);
      expect(r.reason).toBe("ignored-non-pane-to-host");
    }
    // A MISSING field rejects too (required closed payload — no silent default).
    const r2 = await H.probeStatus(page, {
      sourcePaneId: ids[0],
      origin: H.MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: "",
        session: "",
        title: "",
        attention: "none",
        activity: "idle",
        following: true,
        unreadCount: 0,
      },
    });
    expect(r2.accepted, "missing runningCount rejected").toBe(false);

    expect(await H.status(page, ids[0])).toEqual(before);
  });

  // Feature: display cap — a count ≥ 10 renders as the fixed-width "9+".
  test("caps a count of 10+ at 9+ (display formatting only)", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 12, 0);
    await probeCounts(page, ids[1], 0, 10);
    const ws1 = (await H.workspaces(page))[0];
    await expect(
      page.locator(`[data-testid="ws-tab-pairs"][data-workspace="${ws1}"]`),
    ).toHaveAttribute("data-pairs", `(9+|0)(0|9+)${zeros(ids.length - 2)}`);
    // The stored status keeps the TRUE integers (the cap is display-only).
    expect((await H.status(page, ids[0]))!.runningCount).toBe(12);
    expect((await H.status(page, ids[1]))!.unreadCount).toBe(10);
  });

  // Feature: legibility at both ends of the viewport range (operator gate).
  // Captures gitignored vision evidence + MEASURES narrow-width behavior
  // honestly: the pairs element is never content-truncated (its text stays
  // intact in the DOM); on overflow the .tabs row SCROLLS horizontally (the
  // measured geometry is recorded next to the screenshots).
  test("vision: legible at 1280 and ~360 width; narrow overflow measured, not truncated", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 2, 1);
    await probeCounts(page, ids[1], 0, 3);
    const ws1 = (await H.workspaces(page))[0];
    const pairs = page.locator(`[data-testid="ws-tab-pairs"][data-workspace="${ws1}"]`);
    await expect(pairs).toHaveAttribute("data-pairs", `(2|1)(0|3)${zeros(ids.length - 2)}`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(VISION_DIR, "tab-pairs-1280.png") });

    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(200); // let the reflow settle
    await page.screenshot({ path: path.join(VISION_DIR, "tab-pairs-360.png") });

    // Honest narrow-width measurement: DOM text is intact (no truncation of
    // the pairs themselves); whether the row fits or scrolls is recorded.
    const intact = await pairs.textContent();
    expect(intact, "pairs text intact in the DOM at 360px").toBe(`(2|1)(0|3)${zeros(ids.length - 2)}`);
    const geom = await page.evaluate(() => {
      const tabs = document.querySelector('[data-testid="ws-tabs"]') as HTMLElement | null;
      const pairEl = document.querySelector('[data-testid="ws-tab-pairs"]') as HTMLElement | null;
      const box = pairEl?.getBoundingClientRect();
      const vw = window.innerWidth;
      const clipRight = tabs ? tabs.getBoundingClientRect().right : vw;
      // The pairs are VISUALLY visible at scroll position 0 only if their
      // laid-out box fits inside the row's clip rect. getBoundingClientRect
      // reports the laid-out position even when an ancestor's overflow clips
      // the element — hence the explicit clip comparison.
      return {
        viewport: vw,
        tabsScrollWidth: tabs?.scrollWidth ?? 0,
        tabsClientWidth: tabs?.clientWidth ?? 0,
        pairsRight: box ? Math.round(box.right) : 0,
        pairsWidth: box ? Math.round(box.width) : 0,
        pairsVisibleAtScroll0: !!box && box.right <= clipRight && box.left >= 0,
      };
    });
    fs.writeFileSync(
      path.join(VISION_DIR, "narrow-360-measurement.json"),
      JSON.stringify(geom, null, 2) + "\n",
    );
    expect(geom.pairsWidth).toBeGreaterThan(0);
    // Scrollable overflow is the tabstrip's designed narrow behavior (the
    // row scrolls horizontally rather than ellipsizing the pairs). Prove the
    // reveal: scroll the tab row to its end and the pairs element becomes
    // visible inside the clip rect.
    if (!geom.pairsVisibleAtScroll0) {
      await page.evaluate(() => {
        const tabs = document.querySelector('[data-testid="ws-tabs"]') as HTMLElement | null;
        if (tabs) tabs.scrollLeft = tabs.scrollWidth;
      });
      await page.waitForTimeout(100);
      await expect(pairs).toBeVisible();
      await page.screenshot({ path: path.join(VISION_DIR, "tab-pairs-360-scrolled.png") });
    }
  });
});
