import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

/**
 * TAB-PAIRS BADGES e2e: the workspace tab label renders one per-pane badge
 * group — a NEUTRAL "running" badge + an ACCENT "unread" badge (nonzero counts
 * only) — in the workspace's live serialized panel order, derived ONLY from
 * the server-reported status aggregates (runningCount/unreadCount on the
 * {type:"status"} message). This is the badge-UI redesign of the old raw
 * "(2|0)(0|3)" text run (operator directive: "(X|Y) is my annotation only,
 * you need to design better UI/UX").
 *
 * DOM contract under [data-testid="ws-tab-pairs"] (the stable container):
 *   - one [data-pane-index="i"] group per pane with a nonzero count (NONZERO-
 *     ONLY rendering — a (0|0) pane renders no group; i is the pane's index in
 *     the live panel order, so pane↔group association survives gaps);
 *   - within a group, up to two badges: [data-kind="running"] then
 *     [data-kind="unread"], each with data-count (the TRUE integer) and text
 *     fmtCount(n) (the "9+" display cap);
 *   - data-pairs on the container mirrors the FULL pair run incl zero pairs
 *     (the machine-readable derivation surface);
 *   - role="img" + aria-label carry the human-words summary ("2 running,
 *     3 unread").
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
  page: Page,
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

/** The tab-pairs badge-run container for a workspace. */
function pairsEl(page: Page, ws: string | null) {
  return page.locator(`[data-testid="ws-tab-pairs"][data-workspace="${ws}"]`);
}
/** The badge group for pane index `idx` (NONZERO panes only render a group). */
function groupEl(page: Page, ws: string | null, idx: number) {
  return pairsEl(page, ws).locator(`[data-pane-index="${idx}"]`);
}
/** The running|unread badge for pane index `idx`. */
function badgeEl(page: Page, ws: string | null, idx: number, kind: "running" | "unread") {
  return groupEl(page, ws, idx).locator(`[data-kind="${kind}"]`);
}

/** The trailing "(0|0)" pairs for unprobed panes in the data-pairs mirror
 * (the seeded ws has N≥2 panes; the mock's neutral echo covers the rest).
 * Keeps data-pairs expectations pane-count-robust. */
function zeros(n: number): string {
  return "(0|0)".repeat(Math.max(0, n));
}

test.describe("tab-pairs badges (per-pane running/unread micro-badges in the workspace tab label)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // Feature: NONZERO-ONLY rendering — only panes with a nonzero count render a
  // badge group; each group holds a badge per nonzero kind; a (0|0) pane
  // renders nothing (cleaner than the old render-all-when-any-nonzero rule;
  // association is carried by data-pane-index, asserted below).
  test("renders one badge group per NONZERO pane, one badge per nonzero kind", async ({ page }) => {
    const ids = await H.panes(page);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    await probeCounts(page, ids[0], 2, 0);
    await probeCounts(page, ids[1], 0, 3);

    const ws1 = (await H.workspaces(page))[0];
    // Pane 0: a single neutral running badge.
    await expect(badgeEl(page, ws1, 0, "running")).toHaveCount(1);
    await expect(badgeEl(page, ws1, 0, "unread")).toHaveCount(0);
    // Pane 1: a single accent unread badge.
    await expect(badgeEl(page, ws1, 1, "running")).toHaveCount(0);
    await expect(badgeEl(page, ws1, 1, "unread")).toHaveCount(1);
    // Unprobed panes are (0|0) → no groups at all beyond the two above.
    await expect(pairsEl(page, ws1).locator("[data-pane-index]")).toHaveCount(2);
    await expect(badgeEl(page, ws1, 0, "running")).toHaveText("2");
    await expect(badgeEl(page, ws1, 1, "unread")).toHaveText("3");
  });

  // Feature: a pane with BOTH counts nonzero renders BOTH badges, running
  // first (stable order — running is the ambient state, unread the newer
  // signal reading rightward).
  test("both badges in one pane group, running before unread", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 2, 3);

    const ws1 = (await H.workspaces(page))[0];
    const group = groupEl(page, ws1, 0);
    await expect(group.locator("[data-kind]")).toHaveCount(2);
    await expect(group.locator("[data-kind]").first()).toHaveAttribute("data-kind", "running");
    await expect(group.locator("[data-kind]").nth(1)).toHaveAttribute("data-kind", "unread");
  });

  // Feature: DERIVATION CONTRACT (badge terms): the badge group at pane-index
  // i carries data-count exactly equal to the status pane i reported (the host
  // renders, never derives); the data-pairs mirror still states
  // pair[i] === (runningCount|unreadCount) for EVERY pane incl zeros.
  test("derivation contract: badge counts equal the pane's reported aggregates", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 2, 0);
    await probeCounts(page, ids[1], 0, 3);

    const ws1 = (await H.workspaces(page))[0];
    const panes = await H.panes(page);
    for (let i = 0; i < panes.length; i++) {
      const st = await H.status(page, panes[i]);
      expect(st, `pane ${panes[i]} reported a status`).not.toBeNull();
      // Badge DOM: data-count === the TRUE reported integer (per nonzero kind).
      if (st!.runningCount > 0) {
        await expect(badgeEl(page, ws1, i, "running")).toHaveAttribute(
          "data-count",
          String(st!.runningCount),
        );
      } else {
        await expect(badgeEl(page, ws1, i, "running")).toHaveCount(0);
      }
      if (st!.unreadCount > 0) {
        await expect(badgeEl(page, ws1, i, "unread")).toHaveAttribute(
          "data-count",
          String(st!.unreadCount),
        );
      } else {
        await expect(badgeEl(page, ws1, i, "unread")).toHaveCount(0);
      }
    }
    // Machine mirror: the FULL run (zeros included) matches the pane order.
    const rendered = await pairsEl(page, ws1).getAttribute("data-pairs");
    const pairsNow: string[] = [];
    for (const p of panes) {
      const st = await H.status(page, p);
      pairsNow.push(`(${st!.runningCount}|${st!.unreadCount})`);
    }
    expect(rendered).toBe(pairsNow.join(""));
  });

  // Feature: pane↔group association survives zero gaps — a (0|0) pane between
  // nonzero panes renders no group, and the remaining group still names its
  // pane via data-pane-index (association by index, not visual position).
  test("pane-index association preserved across zero panes", async ({ page }) => {
    const ids = await H.panes(page);
    // Leave pane 0 at its (0|0) handshake echo; probe ONLY pane 1.
    await probeCounts(page, ids[1], 0, 3);

    const ws1 = (await H.workspaces(page))[0];
    const groups = pairsEl(page, ws1).locator("[data-pane-index]");
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toHaveAttribute("data-pane-index", "1");
    await expect(groupEl(page, ws1, 0)).toHaveCount(0);
    await expect(badgeEl(page, ws1, 1, "unread")).toHaveText("3");
  });

  // Feature: live updates — a re-reported status with changed counts flips the
  // badges (idempotent-on-change emission → recompute → new signal), including
  // a kind swap (running→unread) and a count change on a kept badge.
  test("updates when a pane re-reports changed counts", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 2, 0);
    await probeCounts(page, ids[1], 0, 3);
    const ws1 = (await H.workspaces(page))[0];
    await expect(badgeEl(page, ws1, 0, "running")).toHaveText("2");

    // Kind swap on pane 0: running 2 → unread 1.
    await probeCounts(page, ids[0], 0, 1);
    await expect(badgeEl(page, ws1, 0, "running")).toHaveCount(0);
    await expect(badgeEl(page, ws1, 0, "unread")).toHaveText("1");

    // Count change on pane 1's kept unread badge: 3 → 5.
    await probeCounts(page, ids[1], 0, 5);
    await expect(badgeEl(page, ws1, 1, "unread")).toHaveText("5");

    // data-pairs mirror tracks the same live changes.
    await expect(pairsEl(page, ws1)).toHaveAttribute(
      "data-pairs",
      `(0|1)(0|5)${zeros(ids.length - 2)}`,
    );
  });

  // Feature: zeroing a pane removes its badge group live; zeroing EVERY pane
  // removes the whole container (the all-zero fork — a quiet workspace reads
  // as a bare label).
  test("zeroing a pane removes its group; all-zero removes the container", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 2, 0);
    const ws1 = (await H.workspaces(page))[0];
    await expect(groupEl(page, ws1, 0)).toHaveCount(1);

    await probeCounts(page, ids[0], 0, 0);
    await expect(groupEl(page, ws1, 0)).toHaveCount(0);
    await expect(pairsEl(page, ws1)).toHaveCount(0);
    await expect(page.locator('[data-testid="ws-tab-label"]')).toBeVisible();
  });

  // Feature: BACKGROUND workspaces render their badges too (the operator reads
  // a hidden workspace's load from its tab).
  test("background-workspace tab shows its badges", async ({ page }) => {
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

    // Switch back to ws1 (ws2 becomes background) — ws2's tab keeps its badge.
    await H.setActiveWorkspace(page, (await H.workspaces(page))[0]);
    await expect
      .poll(async () => H.activeWorkspace(page))
      .toBe((await H.workspaces(page))[0]);
    await expect(badgeEl(page, ws2, 0, "unread")).toHaveCount(1);
    await expect(badgeEl(page, ws2, 0, "unread")).toHaveText("2");
  });

  // Feature: the needs-you amber badge coexists with the pairs badges
  // (distinct signals: pairs carry running+unread, the badge carries
  // needs_input) and stays OUTSIDE the badge run.
  test("needs-you badge coexists with the pairs badges", async ({ page }) => {
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
    const need = page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws1}"]`);
    await expect(need).toBeVisible();
    await expect(need).toHaveText("1");
    // The badge run renders its OWN signals, sibling of (not inside) the badge.
    await expect(badgeEl(page, ws1, 0, "running")).toHaveText("1");
    await expect(badgeEl(page, ws1, 0, "unread")).toHaveText("2");
    await expect(need.locator("[data-kind]")).toHaveCount(0);
  });

  // Feature: ZERO FORK — a workspace whose panes are ALL (0|0) renders a bare
  // name (no badge run at all). The seeded mock reports 0/0 for every pane.
  test("all-zero workspace shows the bare name (zero fork)", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    // The mock's handshake status echo carries (0|0) — no badges element.
    await expect(pairsEl(page, ws1)).toHaveCount(0);
    await expect(page.locator('[data-testid="ws-tab-label"]')).toBeVisible();

    // Explicit (0|0) reports still read as zero (not "no status") → still bare.
    const ids = await H.panes(page);
    for (const id of ids) await probeCounts(page, id, 0, 0);
    await expect(pairsEl(page, ws1)).toHaveCount(0);
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

  // Feature: display cap — a count ≥ 10 renders as the fixed-width "9+" while
  // data-count keeps the TRUE integer (the cap is display text only).
  test("caps a count of 10+ at 9+ (display formatting only)", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 12, 0);
    await probeCounts(page, ids[1], 0, 10);
    const ws1 = (await H.workspaces(page))[0];

    await expect(badgeEl(page, ws1, 0, "running")).toHaveText("9+");
    await expect(badgeEl(page, ws1, 0, "running")).toHaveAttribute("data-count", "12");
    await expect(badgeEl(page, ws1, 1, "unread")).toHaveText("9+");
    await expect(badgeEl(page, ws1, 1, "unread")).toHaveAttribute("data-count", "10");
    // The stored status keeps the TRUE integers (the cap is display-only).
    expect((await H.status(page, ids[0]))!.runningCount).toBe(12);
    expect((await H.status(page, ids[1]))!.unreadCount).toBe(10);
  });

  // Feature: accessibility — the badge run's title/aria-label are human words
  // ("2 running, 3 unread"), never pair notation.
  test("badge run carries human-words aria-label and title", async ({ page }) => {
    const ids = await H.panes(page);
    await probeCounts(page, ids[0], 2, 0);
    await probeCounts(page, ids[1], 0, 3);
    const ws1 = (await H.workspaces(page))[0];

    await expect(pairsEl(page, ws1)).toHaveAttribute("aria-label", "2 running, 3 unread");
    await expect(pairsEl(page, ws1)).toHaveAttribute("title", "2 running, 3 unread");

    // Running-only workspaces label without the unread half.
    await probeCounts(page, ids[1], 0, 0);
    await expect(pairsEl(page, ws1)).toHaveAttribute("aria-label", "2 running");
  });

  // Feature: legibility at both ends of the viewport range (operator gate).
  // Captures gitignored vision evidence + MEASURES narrow-width behavior
  // honestly: the badges are never content-truncated (their DOM text stays
  // intact); on overflow the .tabs row SCROLLS horizontally (the measured
  // geometry is recorded next to the screenshots).
  test("vision: legible at 1280 and ~360 width; narrow overflow measured, not truncated", async ({ page }) => {
    const ids = await H.panes(page);
    // Pane 0 reports needs_reply TOO, so the amber needs-you pill renders
    // alongside the badges — the vision receipts must prove the three badge
    // colors coexist legibly (neutral running vs accent unread vs amber
    // needs-you).
    const needy = await H.probeStatus(page, {
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
        runningCount: 2,
        unreadCount: 1,
      },
    });
    expect(needy.accepted).toBe(true);
    await probeCounts(page, ids[1], 0, 3);
    const ws1 = (await H.workspaces(page))[0];
    const run = pairsEl(page, ws1);
    await expect(badgeEl(page, ws1, 0, "running")).toHaveText("2");
    await expect(badgeEl(page, ws1, 0, "unread")).toHaveText("1");
    await expect(badgeEl(page, ws1, 1, "unread")).toHaveText("3");
    await expect(
      page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws1}"]`),
    ).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(VISION_DIR, "tab-pairs-1280.png") });

    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(200); // let the reflow settle
    await page.screenshot({ path: path.join(VISION_DIR, "tab-pairs-360.png") });

    // Honest narrow-width measurement: badge DOM is intact (no truncation of
    // the badge text itself); whether the row fits or scrolls is recorded.
    await expect(badgeEl(page, ws1, 0, "running")).toHaveText("2");
    await expect(badgeEl(page, ws1, 1, "unread")).toHaveText("3");
    const geom = await page.evaluate(() => {
      const tabs = document.querySelector('[data-testid="ws-tabs"]') as HTMLElement | null;
      const runEl = document.querySelector('[data-testid="ws-tab-pairs"]') as HTMLElement | null;
      const badge = runEl?.querySelector("[data-kind]") as HTMLElement | null;
      const unread = runEl?.querySelector('[data-kind="unread"]') as HTMLElement | null;
      const box = runEl?.getBoundingClientRect();
      const badgeBox = badge?.getBoundingClientRect();
      const unreadBox = unread?.getBoundingClientRect();
      const vw = window.innerWidth;
      const clipRight = tabs ? tabs.getBoundingClientRect().right : vw;
      // The badges are VISUALLY visible at scroll position 0 only if their
      // laid-out box fits inside the row's clip rect. getBoundingClientRect
      // reports the laid-out position even when an ancestor's overflow clips
      // the element — hence the explicit clip comparison.
      return {
        viewport: vw,
        tabsScrollWidth: tabs?.scrollWidth ?? 0,
        tabsClientWidth: tabs?.clientWidth ?? 0,
        runRight: box ? Math.round(box.right) : 0,
        runWidth: box ? Math.round(box.width) : 0,
        badgeWidth: badgeBox ? Math.round(badgeBox.width) : 0,
        badgeHeight: badgeBox ? Math.round(badgeBox.height) : 0,
        unreadWidth: unreadBox ? Math.round(unreadBox.width) : 0,
        badgesVisibleAtScroll0: !!box && box.right <= clipRight && box.left >= 0,
      };
    });
    fs.writeFileSync(
      path.join(VISION_DIR, "narrow-360-measurement.json"),
      JSON.stringify(geom, null, 2) + "\n",
    );
    expect(geom.runWidth).toBeGreaterThan(0);
    // Badge stays at legible size at 360px (the 15px pill height is kept).
    expect(geom.badgeHeight).toBeGreaterThanOrEqual(14);
    // PILL COMPACTION (the circle→pill slice): a single-digit badge used to be
    // a 15px-min-width circle (as wide as tall by construction). The compact
    // pill (4px radius, 3px horizontal padding, NO min-width) hugs its number:
    // a single-digit unread badge is now strictly narrower than the old 15px
    // floor. Shape change asserted from GEOMETRY, not CSS text.
    expect(geom.unreadWidth).toBeLessThan(15);
    expect(geom.badgeWidth).toBeLessThanOrEqual(geom.badgeHeight);
    // Scrollable overflow is the tabstrip's designed narrow behavior (the
    // row scrolls horizontally rather than ellipsizing the badges). Prove the
    // reveal: scroll the tab row to its end and the badge run becomes visible
    // inside the clip rect.
    if (!geom.badgesVisibleAtScroll0) {
      await page.evaluate(() => {
        const tabs = document.querySelector('[data-testid="ws-tabs"]') as HTMLElement | null;
        if (tabs) tabs.scrollLeft = tabs.scrollWidth;
      });
      await page.waitForTimeout(100);
      await expect(run).toBeVisible();
      await page.screenshot({ path: path.join(VISION_DIR, "tab-pairs-360-scrolled.png") });
    }
  });
});
