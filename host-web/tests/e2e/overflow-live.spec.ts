import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

/**
 * OVERFLOW LIVE-SYNC e2e: the "⋯" overflow workspace list (the tab select)
 * must reflect the SAME live TAB-PAIRS / needs-you numbers the tabstrip tabs
 * render — for a workspace HIDDEN behind the overflow trigger, as counts
 * change, INCLUDING while the popover is open (strip membership is frozen
 * then; badges never are — the WorkspaceOverflow contract).
 *
 * Operator report this spec red-signals: tab badge numbers (TAB-PAIRS
 * running/unread micro-badges + needs-you pills) update live, but the
 * overflow select shows STALE numbers.
 *
 * Two staleness classes are covered by one scenario:
 *  A. COUNTS CHANGE WHILE CLOSED → opening the popover must show the CURRENT
 *     numbers (store-level staleness would fail this).
 *  B. COUNTS CHANGE WHILE OPEN (frozen membership) → the open row's badge run
 *     and the trigger cue must update LIVE (row-reactivity staleness would
 *     fail this).
 *
 * Counts are driven through the DEV bridge's probeStatus (routes a full
 * payload through the REAL router, source-bound to a real pane's
 * contentWindow — the same path the SPA's statusEmitter uses). Geometry is
 * copied from the proven workspace-tabs saturation recipe: at a 600px
 * viewport, six long-named workspaces push the quiet seed workspace behind
 * the overflow trigger while the active tab stays visible.
 */

/** Probe a full valid status for a pane (through the real router). */
async function probeCounts(
  page: Page,
  paneId: string,
  runningCount: number,
  unreadCount: number,
  attention: "none" | "needs_reply" | "needs_permission" = "none",
): Promise<void> {
  const r = await H.probeStatus(page, {
    sourcePaneId: paneId,
    origin: H.MOCK_ORIGIN,
    payload: {
      type: "status",
      dir: "",
      session: "",
      title: "",
      attention,
      activity: "idle",
      following: true,
      runningCount,
      unreadCount,
    },
  });
  expect(r.accepted, `status (${runningCount}|${unreadCount} ${attention}) accepted`).toBe(true);
}

/** The trailing "(0|0)" pairs for unprobed panes in the data-pairs mirror. */
function zeros(n: number): string {
  return "(0|0)".repeat(Math.max(0, n));
}

test.describe("overflow live sync (hidden-workspace badges in the ⋯ select)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("hidden workspace's counts update live in the overflow rows + cue (open popover = frozen membership)", async ({ page }) => {
    // Saturation geometry (proven in workspace-tabs.spec.ts): 600px viewport
    // + six long-named workspaces → the quiet seed can never fit beside the
    // long active tab, so it sits behind the overflow trigger.
    await page.setViewportSize({ width: 600, height: 800 });
    const seed = (await H.workspaces(page))[0];
    const seedPanes = await H.panes(page);
    expect(seedPanes.length).toBeGreaterThanOrEqual(2);
    // Live FIRST: the mock's neutral handshake status (0|0) must land before
    // any probe so it can never overwrite a probed value (last write wins).
    await H.waitForReady(page, seedPanes[0]);

    for (let i = 0; i < 6; i++) {
      await H.addWorkspace(page, `LongWorkspaceNameForWidthPaddingLongWorkspaceNameForWidth${i}`);
    }

    const trigger = page.locator('[data-testid="ws-overflow-trigger"]');
    await expect(trigger).toBeVisible();
    // The seed workspace (quiet, canonically first) is hidden behind "⋯".
    await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${seed}"]`)).toHaveCount(0);

    // ---- A. count change while CLOSED → open shows CURRENT numbers -------
    await probeCounts(page, seedPanes[0], 2, 3);
    await trigger.click();
    const pairs = page.locator(`[data-testid="ws-overflow-pairs"][data-workspace="${seed}"]`);
    await expect(pairs).toHaveCount(1);
    await expect(pairs).toHaveAttribute("data-pairs", `(2|3)${zeros(seedPanes.length - 1)}`);
    await expect(pairs.locator('[data-pane-index="0"] [data-kind="running"]')).toHaveText("2");
    await expect(pairs.locator('[data-pane-index="0"] [data-kind="unread"]')).toHaveText("3");
    // Trigger cue: exactly ONE hidden workspace with running/unread activity
    // (the six long ones have no panes) → kind=activity, count=1.
    const cue = page.locator('[data-testid="ws-overflow-cue"]');
    await expect(cue).toHaveAttribute("data-kind", "activity");
    await expect(cue).toHaveAttribute("data-count", "1");

    // ---- B. count change while OPEN → the open row updates LIVE ----------
    // (The open popover freezes strip membership; badges must never freeze.)
    await probeCounts(page, seedPanes[0], 5, 0);
    await expect(pairs).toHaveAttribute("data-pairs", `(5|0)${zeros(seedPanes.length - 1)}`);
    await expect(pairs.locator('[data-pane-index="0"] [data-kind="running"]')).toHaveText("5");
    await expect(pairs.locator('[data-pane-index="0"] [data-kind="unread"]')).toHaveCount(0);

    // ---- B2. needs-you appears live on the open row + flips the cue ------
    await probeCounts(page, seedPanes[0], 5, 0, "needs_reply");
    const need = page.locator(`[data-testid="ws-overflow-need"][data-workspace="${seed}"]`);
    await expect(need).toHaveCount(1);
    await expect(need).toHaveText("1");
    await expect(cue).toHaveAttribute("data-kind", "needs-you");
    await expect(cue).toHaveAttribute("data-count", "1");
    // Membership is still frozen while the popover is open: the now-needy
    // seed workspace is NOT promoted into the strip mid-interaction.
    await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${seed}"]`)).toHaveCount(0);
  });
});
