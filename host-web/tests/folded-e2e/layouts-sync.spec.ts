import { expect, test, type Page } from "@playwright/test";
import { LAYOUT_STORAGE_KEY, iframeSrcs } from "../e2e/util";

// =============================================================================
// FOLDED LAYOUTS SYNC e2e — the PRODUCT CRUX lane for server-backed tab-only
// named layouts (task-2026-09-17t20-32-39, phases 3-4).
//
// Posture: the REAL folded binary (both SPAs embedded) serves the host shell
// at `/` and the worker API same-origin — GET/PUT /vh/layouts is the REAL
// Go handler over the REAL persisted catalog (named-layouts.json under the
// lane's ISOLATED VH_STATE_DIR, see playwright.folded.config.ts). No route
// interception anywhere: the PUT A issues and the GET B reads both cross the
// real HTTP + persistence boundary.
//
// CRUX (behavioral closure): device/context A saves a named tab layout →
// the real PUT lands on the server (asserted by reading the worker's catalog
// back) → a FRESH browser context B (empty storage — a different device on
// the same worker) opens the shell → the layout APPEARS in B's Layouts list
// (server-sourced, badged) → an explicit tap LOADS it: a new workspace
// mounts carrying the saved arrangement (panes render; the persisted blob
// shows the loaded workspace active).
//
// Everything here is PRODUCTION-SAFE (the folded build has no DEV bridges):
// DOM ([data-testid=…], .pane, iframe srcs), localStorage (the v3 blob), and
// same-origin fetch("/vh/layouts") from the page itself — the same surface
// the host shell's catalog client uses.
//
// Run-scoped names: the binary (and its state dir) can be REUSED across runs
// (reuseExistingServer), so every layout name here is suffixed with a
// run-unique token — a stale catalog entry from a previous run can never
// collide with this run's assertions.
// =============================================================================

// ---- production-safe helpers -------------------------------------------------

/** The `.pane` element ids in DOM order (production DOM read). */
async function paneIds(page: Page): Promise<string[]> {
  return page.locator(".pane[data-pane-id]").evaluateAll((els) =>
    (els as HTMLElement[]).map((e) => e.dataset.paneId ?? ""),
  );
}

/** The server catalog doc, read from INSIDE the page over the real API —
 *  the same same-origin fetch the host's catalog client issues. */
async function serverCatalog(page: Page): Promise<{
  revision: number;
  entries: Array<{ name: string; tabTitle?: string }>;
}> {
  return page.evaluate(async () => {
    const res = await fetch("/vh/layouts", { cache: "no-store" });
    return (await res.json()) as { revision: number; entries: Array<{ name: string; tabTitle?: string }> };
  });
}

/** Boot the folded host and wait for the self-seed pane (1 pane at /app). */
async function bootFolded(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();
  await expect
    .poll(async () => (await paneIds(page)).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);
}

/** Open the Layouts popover via the REAL tabstrip trigger. */
async function openLayouts(page: Page): Promise<void> {
  await page.locator('[data-testid="layouts-btn"]').click();
  await expect(page.locator('[data-testid="layouts-popover"]')).toBeVisible();
}

/** The saved-layout row for `name` (locator; precise on data-name). */
function layoutRow(page: Page, name: string) {
  return page.locator(`[data-testid="layout-row"][data-name="${name}"]`);
}

/** The parsed v3 blob from localStorage (null when absent). */
async function layoutBlob(page: Page): Promise<{
  activeWorkspaceId?: string;
  workspaces?: Array<{ id?: string; name?: string; layout?: { panels?: Record<string, { params?: { url?: string } }> } }>;
} | null> {
  return page.evaluate(({ key }) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, { key: LAYOUT_STORAGE_KEY });
}

// ---- the crux -----------------------------------------------------------------

test.describe.serial("folded layouts sync (server-backed named layouts)", () => {
  test("context A saves → PUT lands on the server; fresh context B discovers + loads", async ({
    browser,
    page,
  }) => {
    // Run-unique names (the server + its state dir can be reused across runs).
    const name = `sync-${Date.now().toString(36)}`;
    const tabTitle = `device-a-${Date.now().toString(36)}`;

    // ---- CONTEXT A: boot, save a named tab layout through the REAL UI ------
    await bootFolded(page);
    const origin = new URL(page.url()).origin;

    await openLayouts(page);
    await page.locator('[data-testid="layout-name-input"]').fill(name);
    await page.locator('[data-testid="layout-tabtitle-input"]').fill(tabTitle);
    await page.locator('[data-testid="layout-save"]').click();
    // The row appears immediately (local save)…
    await expect(layoutRow(page, name)).toBeVisible();

    // …and the real PUT landed: the WORKER's own catalog (read back through
    // the real API, not the interception-free UI path) carries the entry.
    await expect
      .poll(async () => (await serverCatalog(page)).entries.some((e) => e.name === name), {
        timeout: 10_000,
      })
      .toBe(true);
    const docA = await serverCatalog(page);
    const published = docA.entries.find((e) => e.name === name);
    expect(published, "published entry present in the worker catalog").toBeTruthy();
    expect(published!.tabTitle).toBe(tabTitle);
    expect(docA.revision).toBeGreaterThan(0);

    // A's own row adopts the committed doc → the synced badge shows.
    await expect(
      layoutRow(page, name).locator('[data-testid="layout-row-synced"]'),
    ).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");

    // ---- CONTEXT B: FRESH browser context (empty storage — device B) -------
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    try {
      await bootFolded(pageB);

      // The layout APPEARS in B's list, server-sourced + badged (discovery —
      // B's localStorage holds NOTHING of A's; the row can only come from
      // the fetched catalog).
      await openLayouts(pageB);
      const rowB = layoutRow(pageB, name);
      await expect(rowB).toBeVisible({ timeout: 10_000 });
      await expect(rowB).toHaveAttribute("data-synced", "1");
      await expect(rowB.locator('[data-testid="layout-row-synced"]')).toBeVisible();
      // The server row's delete is disabled (server-owned; v1 has no delete).
      await expect(rowB.locator('[data-testid="layout-delete"]')).toBeDisabled();

      // B's local store does NOT contain the entry (view-merge writes nothing
      // back into the local store — F3 H1).
      const localInB = await pageB.evaluate(
        (n) => localStorage.getItem("vh-host:namedLayouts:v2")?.includes(n) ?? false,
        name,
      );
      expect(localInB, "server row never written back into B's local store").toBe(false);

      // ---- explicit LOAD: the saved arrangement mounts as a new workspace --
      await rowB.locator('[data-testid="layout-load"]').click();

      // The popover closes (the loaded workspace is the result)…
      await expect(pageB.locator('[data-testid="layouts-popover"]')).toHaveCount(0);

      // …and a NEW workspace exists, is ACTIVE, is named after the saved TAB
      // TITLE, and carries the saved arrangement (A's source workspace had
      // exactly the one self-seed pane at origin + /app). The sync mirror is
      // written per-mutation, so poll the persisted blob.
      const blobB = await expect
        .poll(
          async () => {
            const b = await layoutBlob(pageB);
            if (!b || b.workspaces?.length !== 2) return null;
            const loaded = b.workspaces.find((w) => w.name === tabTitle);
            if (!loaded || b.activeWorkspaceId !== loaded.id) return null;
            return loaded;
          },
          { timeout: 15_000 },
        )
        .toBeTruthy();
      const loadedWs = (await layoutBlob(pageB))!.workspaces!.find((w) => w.name === tabTitle)!;
      const panels = Object.values(loadedWs.layout?.panels ?? {});
      expect(panels.length, "loaded workspace carries the saved single pane").toBe(1);
      expect(panels[0]?.params?.url, "loaded pane targets the saved /app origin").toBe(
        `${origin}/app`,
      );
      void blobB;

      // USER-VISIBLE outcome: the loaded workspace's pane RENDERS (an iframe
      // at /app is mounted for it) — not just a blob entry.
      await expect
        .poll(async () => (await paneIds(pageB)).length, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(1);
      const srcsB = await iframeSrcs(pageB);
      expect(
        srcsB.some((src) => src.startsWith(`${origin}/app`)),
        "the restored pane's iframe points at /app",
      ).toBe(true);
    } finally {
      await ctxB.close();
    }
  });
});
