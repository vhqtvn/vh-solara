import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// Runtime server-management gate (Phase-1′b-core).
//
// Proves an operator can add/remove servers at runtime, the catalog persists
// across a reload, and the iframe-src XSS boundary (isFleetEntry) rejects a
// `javascript:` url entered in the add-server form — mirroring the F1 fleet-
// rejection pattern in tests/fleet-e2e/fleet.spec.ts.
//
// Drives the REAL UI (the AddServer popover + catalog list) via the typed
// HostOps controller surface (store.hostOps), NOT the DEV-only window.__host
// bridge — so the same affordances the preview-build proof exercises are
// proven here against the dev server.
//
// Runs on Chromium AND Firefox (the default lane's project set). Each test gets
// a fresh browser context → empty localStorage → mock seed (4 panes), so this
// spec does not pollute the survival/shell/layout gates.
// =============================================================================

// The mock content page origin (served on :5174). Adding a server that points
// here (with distinct ?server=&view= params) loads a real heartbeating iframe,
// so "connected" stays true and the pane is genuinely live — not just a label.
const MOCK_ORIGIN = "http://127.0.0.1:5174";

function serverUrl(server: string): string {
  const q = new URLSearchParams({ server, view: "chat" });
  return `${MOCK_ORIGIN}/?${q.toString()}`;
}

/** Open the add-server popover and return locators for its inputs. */
async function openAddServer(page: import("@playwright/test").Page) {
  await page.locator('[data-testid="add-server-btn"]').click();
  await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();
}

async function fillAndSubmit(
  page: import("@playwright/test").Page,
  url: string,
  label: string,
): Promise<void> {
  await page.locator('[data-testid="add-server-url"]').fill(url);
  await page.locator('[data-testid="add-server-label"]').fill(label);
  await page.locator('[data-testid="add-server-submit"]').click();
}

test.describe("runtime server management", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("add-server opens a pane with the configured url + label", async ({ page }) => {
    const before = (await H.panes(page)).length;
    const url = serverUrl("custom-add");
    const label = "custom-add";

    await openAddServer(page);
    await fillAndSubmit(page, url, label);

    // A new pane appears.
    await expect.poll(async () => (await H.panes(page)).length).toBe(before + 1);

    // The new pane carries the exact {url,label} (proves the url — not just the
    // label — is wired through, the same way the fleet spec asserts srcs).
    const params = await H.paneParams(page);
    const added = params.find((p) => p.url === url);
    expect(added, "added pane carries the configured url").toBeDefined();
    expect(added!.label, "added pane carries the configured label").toBe(label);

    // The new pane's header shows the configured label (the top tabstrip is
    // workspace-scoped now; a pane is represented by its own custom header).
    // Use toContainText on the scoped pane (NOT toBeVisible on .pane-label): in
    // a narrow 5-pane column the label's flex-shrunk brand clips to a zero
    // bounding box, which Playwright reports as "hidden" even though the text is
    // rendered. The Split-button visibility above already proves the header is
    // shown; this proves the label text is wired through.
    await expect(
      page.locator(`[data-pane-id="${added!.id}"]`),
    ).toContainText(label);

    // The catalog lists the newly-added server (a remove affordance keyed by url).
    await expect(
      page.locator(`[data-testid="remove-server"][data-url="${url}"]`),
    ).toBeVisible();
  });

  test("remove-server closes that server's panes + drops it from the catalog", async ({
    page,
  }) => {
    const baseCount = (await H.panes(page)).length;
    const url = serverUrl("custom-rm");
    const label = "custom-rm";

    // Add a server first (so there is a catalog entry + pane to remove).
    await openAddServer(page);
    await fillAndSubmit(page, url, label);
    await expect.poll(async () => (await H.panes(page)).length).toBe(baseCount + 1);
    await expect(
      page.locator(`[data-testid="remove-server"][data-url="${url}"]`),
    ).toHaveCount(1);

    // Remove it via the catalog × button.
    await page
      .locator(`[data-testid="remove-server"][data-url="${url}"]`)
      .click();

    // That server's pane closed (count drops back to the baseline).
    await expect.poll(async () => (await H.panes(page)).length).toBe(baseCount);

    // No remaining pane points at the removed url.
    const params = await H.paneParams(page);
    expect(
      params.find((p) => p.url === url),
      "removed server has no open pane",
    ).toBeUndefined();

    // The catalog no longer lists it.
    await expect(
      page.locator(`[data-testid="remove-server"][data-url="${url}"]`),
    ).toHaveCount(0);
  });

  test("server list + layout persist across reload", async ({ page }) => {
    const url = serverUrl("custom-persist");
    const label = "custom-persist";

    // Add a server → catalog (synchronous persist) + a new pane.
    await openAddServer(page);
    await fillAndSubmit(page, url, label);
    const withAdded = (await H.panes(page)).length;
    expect(withAdded, "server was added").toBeGreaterThanOrEqual(5);

    // Flush the debounced LAYOUT save to localStorage before reloading (the
    // catalog save is synchronous, so it is already on disk).
    await H.waitForSavedLayout(page, withAdded);

    // Reload → cold restore: the saved layout round-trips (the added pane's url
    // passes isFleetEntry → restored), and the runtime catalog re-loads from
    // vh-host:servers:v1.
    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);
    await expect
      .poll(async () => (await H.panes(page)).length, { timeout: 20_000 })
      .toBe(withAdded);
    for (const id of await H.panes(page)) await H.waitForReady(page, id);

    // The added server's pane restored (pane header + pane url survive reload).
    const restoredParams = await H.paneParams(page);
    const restored = restoredParams.find((p) => p.url === url);
    expect(restored, "persisted server's pane restored after reload").toBeDefined();
    // toContainText on the scoped pane (not .pane-label toBeVisible — the label
    // is geometry-fragile in a narrow column; see the add-server test above).
    await expect(
      page.locator(`[data-pane-id="${restored!.id}"]`),
    ).toContainText(label);

    // The runtime catalog also restored (the remove affordance keyed by url is
    // present without re-adding the server).
    await openAddServer(page);
    await expect(
      page.locator(`[data-testid="remove-server"][data-url="${url}"]`),
    ).toBeVisible();
  });

  test("rejects a javascript: url (no pane, no iframe src) — iframe-src XSS boundary", async ({
    page,
  }) => {
    const before = (await H.panes(page)).length;

    await openAddServer(page);
    await fillAndSubmit(page, "javascript:alert(document.domain)", "evil");

    // An inline error is shown (the isFleetEntry guard rejected the url).
    await expect(page.locator('[data-testid="add-server-error"]')).toBeVisible();

    // No new pane opened.
    await expect.poll(async () => (await H.panes(page)).length).toBe(before);

    // No catalog entry for the poison (no remove affordance).
    await expect(
      page.locator('[data-testid="remove-server"]'),
    ).toHaveCount(0);

    // DEFENSE-IN-DEPTH: no pane iframe src is a javascript: value, and the
    // poison never reaches an iframe src (mirrors the F1 fleet negative proof).
    const srcs = await H.iframeSrcs(page);
    for (const src of srcs) {
      expect(src, "no iframe src is a javascript: value").not.toMatch(/^javascript:/i);
    }
    expect(
      srcs,
      "the javascript: url never reaches an iframe src",
    ).not.toContain("javascript:alert(document.domain)");
  });
});
