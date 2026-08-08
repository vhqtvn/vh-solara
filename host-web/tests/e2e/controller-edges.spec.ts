import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// Controller edge-case coverage — two runtime tree-mutation paths in
// hostController.ts that were flagged as untested and sit under the load-bearing
// iframe-survival guarantee (every runtime op must keep each iframe permanently
// mounted; no op may reload it).
//
//   1. restore() zero-grid-ref fallback — restoring a tray pane when the grid
//      is empty (no anchor group). Reachable via collapse + closePane-all-grid.
//   2. same-group swap — swapping two panes that already share one Dockview
//      group. Reachable deterministically only via the DEV dockAsTab helper
//      (native tab DnD is the only real-UI route; no shell op makes tabs).
//
// Both tests double as survival-regression guards for their specific op: they
// assert cross-origin iframe identity (mountTs/nonce/connId) is unchanged and
// uptime keeps climbing across the mutation. Runs on Chromium AND Firefox.
// =============================================================================

test.describe("host controller edge paths", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("restore() returns a tray pane to an empty grid (zero-grid-ref fallback)", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;

    // Park `a` in the tray. The collapse guard allows it (≥2 grid panes remain).
    await H.collapse(page, a);
    await expect.poll(async () => (await H.trayIds(page)).includes(a)).toBe(true);
    await H.assertSurvived(page, a, before, "collapse-to-tray");

    // Close EVERY remaining grid pane. closePane — unlike collapse — has no
    // count guard, so this empties the grid entirely while `a` stays floating.
    // This is the only route to restore()'s zero-grid-ref fallback branch.
    const rest = (await H.panes(page)).filter((id) => id !== a);
    expect(rest.length, "≥1 grid pane to clear").toBeGreaterThan(0);
    for (const id of rest) await H.closePane(page, id);
    await expect.poll(async () => H.gridPaneCount(page), { timeout: 10_000 }).toBe(0);
    await expect.poll(async () => (await H.trayIds(page))).toContain(a);
    // `a`'s iframe survived closing the OTHER panes (only those were disposed).
    await H.assertSurvived(page, a, before, "close-all-grid-panes");

    // restore() must bring `a` back as the sole grid pane (the fallback branch),
    // NOT silently strand it in the tray. (Pre-fix this was a silent no-op:
    // panel.api.moveTo resolved the missing group to `a`'s OWN floating group.)
    await H.restore(page, a);
    await expect.poll(async () => H.gridPaneCount(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await H.trayIds(page)).includes(a)).toBe(false);
    // Identity unchanged across the restore: moveTo repositions, never reloads.
    await H.assertSurvived(page, a, before, "restore-from-empty-grid");
  });

  test("swap of two panes in the SAME group splits them apart without reloading", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    const beforeA = (await H.survival(page, a))!;
    const beforeB = (await H.survival(page, b))!;

    // Arrange the same-group precondition: dock `a` into `b`'s group as a tab.
    // No real shell op creates tabs (split always opens a new group); only
    // native tab DnD does. This DEV-only arrangement uses the same survival-safe
    // primitive (moveTo center) the real swap's first step uses — assert it
    // survives so a reload in the arrangement can't be blamed on the swap.
    await H.dockAsTab(page, a, b);
    await H.assertSurvived(page, a, beforeA, "dockAsTab a");
    await H.assertSurvived(page, b, beforeB, "dockAsTab b");
    // Precondition proven: a and b now share one group (two tabs).
    await expect.poll(async () => H.sameGroup(page, a, b)).toBe(true);

    // Re-snapshot immediately before the op under test, so the assertion is
    // purely about swap (not the arrangement).
    const snapA = (await H.survival(page, a))!;
    const snapB = (await H.survival(page, b))!;

    await H.swap(page, a, b);

    // Same-group swap: a's center-move is a no-op reorder; b is split back out
    // to its own group on the right. There is no positional exchange to make
    // within one group, so ejecting b is the defensible behavior. Both iframes
    // must survive (moveTo repositions, never disposes a renderer).
    await H.assertSurvived(page, a, snapA, "same-group swap a");
    await H.assertSurvived(page, b, snapB, "same-group swap b");
    // b was split out → they are now in DIFFERENT groups.
    await expect.poll(async () => H.sameGroup(page, a, b)).toBe(false);
    // Neither pane was lost.
    const after = await H.panes(page);
    expect(after).toContain(a);
    expect(after).toContain(b);
  });
});
