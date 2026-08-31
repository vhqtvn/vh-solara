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
//   3. removeServer never-empty-grid refusal — removing a server is REFUSED
//      when ALL visible grid panes belong to it (hostController guard: the
//      grid must never go blank). Driven through the REAL catalog ✕ button;
//      refusal surfaces as the popover's error line, and neither pane set,
//      grid count, catalog (in-memory row + persisted blob), nor iframe
//      identity may change.
//
// All tests double as survival-regression guards for their specific op: they
// assert cross-origin iframe identity (mountTs/nonce/connId) is unchanged and
// uptime keeps climbing across the mutation.
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

  test("removeServer is REFUSED when all grid panes are the selected server (never-empty grid)", async ({ page }) => {
    // Arrange a grid whose EVERY pane belongs to one runtime-added server:
    // add it through the REAL popover (the production addServerWithOutcome
    // path), split it once (real-fleet split clones the source url), then
    // close every seeded mock pane (closePane has no count guard — proven by
    // the restore() test above).
    const seeded = await H.panes(page);
    const url = H.serverUrl("last-server");
    const label = "last-server";

    await H.openAddServer(page);
    await H.fillAndSubmit(page, url, label);
    // Success keeps the popover open — its catalog row is the removal
    // affordance under test. The added pane carries the exact url.
    const added = (await H.paneParams(page)).find((p) => p.url === url);
    expect(added, "add-server opened a pane for the url").toBeDefined();
    const keeper = added!.id;
    await H.waitForReady(page, keeper);
    const twin = await H.split(page, keeper, "right");
    expect(twin, "split cloned the server pane (real-fleet clone)").toBeTruthy();
    await H.waitForReady(page, twin!);

    const beforeKeeper = (await H.survival(page, keeper))!;
    const beforeTwin = (await H.survival(page, twin!))!;
    for (const id of seeded) await H.closePane(page, id);

    // Refusal precondition, PROVEN not assumed: the grid holds ONLY this
    // server's panes (matchingGrid == gridPaneCount → guard arithmetic ≤ 0).
    await expect.poll(async () => H.gridPaneCount(page), { timeout: 10_000 }).toBe(2);
    const remaining = await H.paneParams(page);
    expect(remaining.map((p) => p.id).sort(), "exactly the two server panes remain").toEqual([keeper, twin!].sort());
    for (const p of remaining) {
      expect(p.url, "every grid pane belongs to the selected server").toBe(url);
    }
    // The arrangement itself is survival-safe.
    await H.assertSurvived(page, keeper, beforeKeeper, "close-seeded-panes keeper");
    await H.assertSurvived(page, twin!, beforeTwin, "close-seeded-panes twin");

    // Catalog state BEFORE the attempt: the popover still lists the server
    // (remove affordance visible), and the persisted catalog holds the url.
    // (The catalog save is synchronous — no flush wait needed. The key must
    // match SERVERS_STORAGE_KEY in src/state/serverList.ts.)
    const removeBtn = page.locator(`[data-testid="remove-server"][data-url="${url}"]`);
    await expect(removeBtn, "catalog lists the server before the attempt").toBeVisible();
    const storageBefore = await page.evaluate(() => localStorage.getItem("vh-host:servers:v1"));
    expect(storageBefore, "persisted catalog contains the server").toContain(url);

    // Re-snapshot immediately before the op under test, so the assertion is
    // purely about removeServer (not the arrangement).
    const snapKeeper = (await H.survival(page, keeper))!;
    const snapTwin = (await H.survival(page, twin!))!;

    // ACT — the REAL operator path: click the catalog ✕. The production
    // handler (AddServer.remove) shows the error line exactly when
    // removeServer returns false.
    await removeBtn.click();

    // (1) REFUSED — the operator-visible signal: the popover's error line.
    const error = page.locator('[data-testid="add-server-error"]');
    await expect(error).toBeVisible();
    await expect(error).toHaveText("Can't remove the last server on the grid");

    // Direct contract probe on the SAME unchanged state (second attempt via
    // the typed bridge): the controller itself returns false.
    expect(await H.removeServer(page, url), "controller refuses (returns false)").toBe(false);

    // (2) NOTHING changed — pane set + grid count identical, catalog row
    // still listed, persisted catalog byte-identical.
    expect((await H.panes(page)).sort(), "no pane was removed").toEqual([keeper, twin!].sort());
    expect(await H.gridPaneCount(page), "grid count unchanged").toBe(2);
    await expect(removeBtn, "catalog row still listed (entry not dropped)").toBeVisible();
    const storageAfter = await page.evaluate(() => localStorage.getItem("vh-host:servers:v1"));
    expect(storageAfter, "persisted catalog untouched").toBe(storageBefore);

    // (3) Both iframes survive the refused op (identity + WS continuity).
    await H.assertSurvived(page, keeper, snapKeeper, "refused removeServer keeper");
    await H.assertSurvived(page, twin!, snapTwin, "refused removeServer twin");
  });
});
