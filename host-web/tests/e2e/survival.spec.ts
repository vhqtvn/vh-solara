import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// iframe-survival regression gate — the load-bearing guarantee for the whole
// multi-server architecture.
//
// Moving/reparenting an <iframe> RELOADS it in current browsers. The host
// container MUST keep each iframe element permanently mounted (Dockview
// renderer:'always') and change only geometry/visibility. This spec proves
// every layout op preserves cross-origin iframe identity, that the two
// reload-causing mistakes (naive remove+re-add; toJSON→fromJSON reswap) are
// DETECTED (identity changes), AND — the multi-workspace crux — that switching
// workspace tabs (CSS-visibility-only overlay stack) keeps EVERY iframe alive.
//
// Runs on Chromium AND Firefox (see playwright.config.ts projects).
// =============================================================================

// The mock content page origin (served on :5174). Used to add a heartbeating
// server pane in the workspace-switch crux so its identity can be tracked.
const MOCK_ORIGIN = "http://127.0.0.1:5174";
function serverUrl(server: string): string {
  const q = new URLSearchParams({ server, view: "chat" });
  return `${MOCK_ORIGIN}/?${q.toString()}`;
}

test.describe("iframe-survival regression gate", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("split keeps the source pane identity", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    const newId = await H.split(page, a, "right");
    expect(newId, "split created a new pane").toBeTruthy();
    await H.waitForReady(page, newId!);
    await H.assertSurvived(page, a, before, "split source");
  });

  test("swap keeps BOTH pane identities", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;
    await H.swap(page, a, b);
    await H.assertSurvived(page, a, ba, "swap pane A");
    await H.assertSurvived(page, b, bb, "swap pane B");
  });

  test("drag-rearrange (native sash resize) keeps identity", async ({ page }) => {
    test.setTimeout(60_000);
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    const boxBefore = await H.groupBox(page, a);

    // Drag the first sash (the splitter between two grid panes). Native Dockview
    // pointer plumbing — the iframe must survive a geometry change. Sashes are
    // thin (4px); pick the first one with a real, grabbable bounding box.
    const sashes = page.locator(".dv-sash");
    const n = await sashes.count();
    expect(n, "at least one sash present").toBeGreaterThan(0);
    let sb: { x: number; y: number; width: number; height: number } | null = null;
    let horiz = true;
    for (let i = 0; i < n; i++) {
      const cand = sashes.nth(i);
      const b = await cand.boundingBox();
      if (b && b.width > 0 && b.height > 0) {
        sb = b;
        horiz = await cand.evaluate((el) => el.classList.contains("dv-horizontal"));
        break;
      }
    }
    expect(sb, "a grabbable sash is present").not.toBeNull();
    const dx = horiz ? 30 : 0;
    const dy = horiz ? 0 : 30;
    await page.mouse.move(sb!.x + sb!.width / 2, sb!.y + sb!.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb!.x + sb!.width / 2 + dx, sb!.y + sb!.height / 2 + dy, { steps: 8 });
    await page.mouse.up();

    const boxAfter = await H.groupBox(page, a);
    expect(boxAfter, "group box present after drag").not.toBeNull();
    // The geometry may or may not have shifted (a maximized/at-limit sash may
    // not move), but the iframe identity MUST be intact regardless.
    await H.assertSurvived(page, a, before, "sash resize");
  });

  test("focus another pane (within the active workspace) keeps identity", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    const beforeA = (await H.survival(page, a))!;
    const beforeB = (await H.survival(page, b))!;
    // Focus pane b via the bridge (setActive). The top tabstrip is now workspace-
    // scoped, so within-workspace focus uses the bridge / a pane header click.
    // "focus another pane" is a survival-safe setActive, never a layout disposal.
    await H.focusPane(page, b);
    await expect.poll(async () => H.focused(page)).toBe(b);
    await H.assertSurvived(page, a, beforeA, "focus-change source");
    await H.assertSurvived(page, b, beforeB, "focus-change target");
  });

  test("maximize + restore keeps identity", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    await H.maximize(page, a);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    await H.assertSurvived(page, a, before, "maximize");
    await H.exitMaximized(page);
    await expect.poll(async () => H.isMaximized(page)).toBe(false);
    await H.assertSurvived(page, a, before, "restore-from-maximize");
  });

  test("collapse-to-tray + restore keeps identity", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    expect(await H.gridPaneCount(page), ">=2 grid panes to allow collapse").toBeGreaterThanOrEqual(2);
    await H.collapse(page, a);
    await expect.poll(async () => (await H.trayIds(page)).includes(a)).toBe(true);
    await H.assertSurvived(page, a, before, "collapse-to-tray");
    await H.restore(page, a);
    await expect.poll(async () => (await H.trayIds(page)).includes(a)).toBe(false);
    await H.assertSurvived(page, a, before, "restore-from-tray");
  });

  test("can't collapse the last visible pane", async ({ page }) => {
    const ids = await H.panes(page);
    // Close panes until only one grid pane remains.
    for (let i = 1; i < ids.length; i++) await H.closePane(page, ids[i]);
    await expect.poll(async () => H.gridPaneCount(page)).toBe(1);
    const last = (await H.panes(page))[0];
    const before = (await H.survival(page, last))!;
    await H.collapse(page, last); // guard: no-op
    await expect.poll(async () => H.trayIds(page)).toEqual([]);
    // identity unchanged (collapse was refused)
    await H.assertSurvived(page, last, before, "last-pane collapse refused");
  });

  // ---- THE MULTI-WORKSPACE SURVIVAL CRUX (load-bearing acceptance bar) ------
  // Switching workspace tabs MUST NOT reload any iframe. The whole architecture
  // rests on permanently-mounted iframes (renderer:'always' + a CSS-visibility
  // overlay stack, one DockviewHost per workspace). This test is the proof: a
  // pane in workspace 1 keeps its identity (mountTs/nonce/connId) across a
  // switch to workspace 2 and back, AND a pane in workspace 2 keeps its identity
  // while hidden. Red without the overlay mechanism (a naive dispose/recreate
  // would reload); green with it.
  test("workspace switch keeps EVERY iframe's identity (survival crux)", async ({ page }) => {
    test.setTimeout(60_000);
    // Workspace 1 (the default) is active + seeded. Record server A's identity.
    const ws1 = await H.activeWorkspace(page);
    expect(ws1, "default workspace is active").toBeTruthy();
    const ws1Panes = await H.panes(page);
    expect(ws1Panes.length, "ws1 has seeded panes").toBeGreaterThanOrEqual(1);
    const a = ws1Panes[0];
    const beforeA = await H.waitForReady(page, a);

    // Create Workspace 2 → it becomes active. Its grid is empty (0 panels).
    const ws2 = await H.addWorkspace(page);
    expect(ws2, "workspace 2 created").toBeTruthy();
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
    expect(await H.panes(page), "ws2 is empty initially").toEqual([]);

    // Add server B in workspace 2. It opens a pane + heartbeats.
    const bUrl = serverUrl("ws-switch-b");
    const b = await H.addServer(page, bUrl, "ws-switch-b");
    expect(b, "server B pane opened in ws2").toBeTruthy();
    const beforeB = await H.waitForReady(page, b!);

    // Switch back to Workspace 1. CSS-visibility-only: no host disposed, no
    // fromJSON, no iframe reload. Server A's pane must be visible again AND its
    // identity strictly unchanged. Server B's pane (now hidden in ws2) must
    // ALSO retain its identity (it stays mounted, just visibility:hidden).
    await H.setActiveWorkspace(page, ws1!);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);

    // Server A survived the round-trip (identity unchanged; fresh heartbeat).
    await H.assertSurvived(page, a, beforeA, "ws1 pane A across ws2 round-trip");
    // Server B survived being hidden (its host is visibility:hidden, NOT
    // unmounted — its iframe keeps heartbeating with the SAME identity).
    await H.assertSurvived(page, b!, beforeB, "ws2 pane B while hidden");

    // Switch back to Workspace 2 — server B becomes visible again, identity
    // still unchanged. This proves the second switch is also survival-safe.
    await H.setActiveWorkspace(page, ws2!);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
    await H.assertSurvived(page, b!, beforeB, "ws2 pane B after second switch");
    await H.assertSurvived(page, a, beforeA, "ws1 pane A after ws2 re-shown");
  });

  test("closing a workspace destroys its host but keeps the others alive", async ({ page }) => {
    // Lifecycle coverage for closeWorkspace (workspace destruction — the ONE
    // sanctioned iframe-reload path, since the workspace is destroyed not
    // switched). Closing the active workspace must activate a remaining one
    // cleanly; a surviving workspace's iframes must NOT reload.
    const ws1 = await H.activeWorkspace(page);
    const aIds = await H.panes(page);
    const a = aIds[0];
    const beforeA = (await H.survival(page, a))!;

    // Create a second workspace (becomes active) so closing it has a remaining
    // workspace to fall back to.
    const ws2 = await H.addWorkspace(page);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);

    // Close ws2 → the active workspace returns to ws1.
    const ok = await H.closeWorkspace(page, ws2!);
    expect(ok, "closeWorkspace applied").toBe(true);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
    await expect.poll(async () => H.workspaces(page)).toEqual([ws1]);

    // ws1's pane survived the sibling's destruction (its host was never touched).
    await H.assertSurvived(page, a, beforeA, "ws1 pane across ws2 close");

    // Closing the LAST remaining workspace is refused (the shell never has zero).
    const refused = await H.closeWorkspace(page, ws1!);
    expect(refused, "can't close the last workspace").toBe(false);
    await expect.poll(async () => H.workspaces(page)).toEqual([ws1]);
  });

  // ---- negative controls: the gate must DETECT a real reload ---------------

  test("NEGATIVE: naive remove + re-add RELOADS the iframe", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    await H.naiveReload(page, a);
    await H.assertReloaded(page, a, before, "naive remove+re-add");
  });

  test("NEGATIVE: toJSON → fromJSON reswap RELOADS every iframe", async ({ page }) => {
    const ids = await H.panes(page);
    const snapshots = await Promise.all(ids.map(async (id) => ({ id, before: (await H.survival(page, id))! })));
    await H.jsonReswap(page);
    for (const { id, before } of snapshots) {
      await H.assertReloaded(page, id, before, `jsonReswap pane ${id}`);
    }
  });
});
