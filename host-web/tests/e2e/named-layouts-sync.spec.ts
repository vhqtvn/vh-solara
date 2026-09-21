import { test, expect, type Page, type Route } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// NAMED LAYOUTS SYNC v1 (host-web's /vh/layouts catalog client + the Layouts
// popover's merged list — server-backed tab-only named layouts, phases 3-4).
//
// This is the MOCK-FLEET lane: there is no real backend, so /vh/layouts is
// fulfilled by Playwright route interception with fixture docs. The REAL
// server path is covered by the folded lane (tests/folded-e2e/
// layouts-sync.spec.ts). What this spec pins:
//   1. MERGED LIST: local entries + server entries; server rows carry the
//      "synced" badge and DISABLED rename/delete (the worker catalog owns
//      the row — v1 has no server rename/delete).
//   2. COLLISION (F3 H1 crux): local X + server X → ONE row (server wins);
//      Load applies the SERVER entry through the validated path; the LOCAL
//      entry survives byte-intact in vh-host:namedLayouts:v2 (the view-merge
//      NEVER writes back into the local store).
//   3. CAS RETRY: a stale baseRevision PUT (409 + current doc) is adopted
//      and retried exactly ONCE; the second PUT carries the adopted
//      revision; the row then shows the synced badge.
//   4. TARGET GATE (F3 success criterion): a server entry with an
//      unallowlisted pane target (javascript: — isFleetEntry rejects it) is
//      BLOCKED at load with a VISIBLE error; no pane opens, no workspace is
//      created, the popover stays open.
//   5. DEV DEGRADATION: with NO interception (the vite dev server answers
//      /vh/layouts with its SPA fallback), the catalog is silently empty,
//      local saves still succeed, the publish warns exactly once with
//      "skipping server layout sync", and local rows remain listed + loadable.
//   6. STRUCTURAL GATE (F3 hardening): a server entry whose layout is an
//      object but NOT a restorable SavedLayout ({}), or a valid-shaped
//      SavedLayout with ZERO panels, is BLOCKED at load with the visible
//      invalid-entry error ("could not be loaded") — no empty workspace is
//      created, the popover stays open (local saves cannot produce a
//      zero-panel layout; REJECT is the ruling).
//
// UI paths drive the REAL production surface (popover → save/load); the DEV
// bridge is used only for arrangement + reads (the suite's established
// pattern). Serial (workers 1); each test clears persisted state BEFORE the
// single app boot.
// =============================================================================

const WIDE = { width: 1280, height: 720 };
const SYNC_URL = "**/vh/layouts";
const NAMED_LAYOUTS_KEY = "vh-host:namedLayouts:v2";

/** One-pane fractional layout fixture targeting `url` (the SavedLayout shape
 *  the staged cold-restore pipeline consumes). */
function onePaneLayout(url: string, label = "fixture"): Record<string, unknown> {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          { type: "leaf", fraction: 1, data: { id: "g-1", views: ["pane-1"], activeView: "pane-1" } },
        ],
      },
    },
    panels: { "pane-1": { id: "pane-1", params: { url, label } } },
    activeGroup: "g-1",
  };
}

/** A wire-shaped server catalog entry. */
function wireEntry(name: string, url: string): Record<string, unknown> {
  return {
    scope: "tab",
    name,
    tabTitle: `${name} tab`,
    layout: onePaneLayout(url),
    savedAt: Date.now(),
  };
}

/** Fulfill a GET with a catalog doc. */
async function fulfillDoc(route: Route, revision: number, entries: Record<string, unknown>[]): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ revision, entries }),
  });
}

// ---- manager UI helpers (the REAL Layouts popover surface) -------------------

async function openLayouts(page: Page): Promise<void> {
  await page.locator('[data-testid="layouts-btn"]').click();
  await expect(page.locator('[data-testid="layouts-popover"]')).toBeVisible();
}

async function saveTabViaUI(page: Page, name: string, tabTitle?: string): Promise<void> {
  await openLayouts(page);
  await page.locator('[data-testid="layout-name-input"]').fill(name);
  if (tabTitle !== undefined) {
    await page.locator('[data-testid="layout-tabtitle-input"]').fill(tabTitle);
  }
  await page.locator('[data-testid="layout-save"]').click();
}

function layoutRow(page: Page, name: string) {
  return page.locator(`[data-testid="layout-row"][data-name="${name}"]`);
}

/** The parsed local named-layouts store from localStorage (null when absent). */
async function namedStore(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, NAMED_LAYOUTS_KEY);
}

test.describe("named layouts sync (server catalog merge)", () => {
  test.beforeEach(async ({ page }) => {
    // Same guarded clear as named-layouts.spec.ts: main-frame-only, once per
    // document (a fresh iframe's same-origin about:blank shares the HOST's
    // storage — an unguarded clear there wipes host state mid-test).
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const w = window as unknown as { __namedLayoutsCleared?: boolean };
      if (w.__namedLayoutsCleared) return;
      w.__namedLayoutsCleared = true;
      localStorage.clear();
    });
    await page.setViewportSize(WIDE);
    await H.loadHost(page);
  });

  test("merged list: local + server rows; server rows badged with disabled rename/delete", async ({ page }) => {
    // A LOCAL-only row first (saved with NO interception — the publish
    // degrades silently to the vite SPA fallback).
    await saveTabViaUI(page, "local-only", "Local Tab");
    await expect(layoutRow(page, "local-only")).toBeVisible();
    await page.keyboard.press("Escape");

    // Now the server answers: one remote entry alongside the local one.
    await page.route(SYNC_URL, (route) =>
      fulfillDoc(route, 3, [wireEntry("srv-row", H.serverUrl("srv-Z"))]),
    );
    await openLayouts(page);

    // BOTH rows show; the server row is badged + data-synced, the local row is not.
    await expect(layoutRow(page, "srv-row")).toBeVisible();
    await expect(layoutRow(page, "local-only")).toBeVisible();
    await expect(layoutRow(page, "srv-row")).toHaveAttribute("data-synced", "1");
    await expect(
      layoutRow(page, "srv-row").locator('[data-testid="layout-row-synced"]'),
    ).toBeVisible();
    await expect(layoutRow(page, "local-only")).toHaveAttribute("data-synced", "0");
    await expect(
      layoutRow(page, "local-only").locator('[data-testid="layout-row-synced"]'),
    ).toHaveCount(0);

    // The server-owned row: rename + delete DISABLED (the worker catalog owns
    // it; a local mutation would resurrect on refresh).
    await expect(layoutRow(page, "srv-row").locator('[data-testid="layout-delete"]')).toBeDisabled();
    await expect(layoutRow(page, "srv-row").locator('[data-testid="layout-rename"]')).toBeDisabled();
    // The local row keeps its actions.
    await expect(layoutRow(page, "local-only").locator('[data-testid="layout-delete"]')).toBeEnabled();
  });

  test("collision: server wins the row; Load applies the SERVER entry; local entry survives in storage", async ({ page }) => {
    // LOCAL "shared": a TWO-pane arrangement (twoPanes) whose urls are the
    // seeded mock fleet's — distinguishable from the server fixture.
    await H.twoPanes(page);
    await saveTabViaUI(page, "shared", "Local Shared");
    await expect(layoutRow(page, "shared")).toBeVisible();
    await page.keyboard.press("Escape");

    // SERVER "shared": a DIFFERENT entry — one pane at srv-Z, its own title.
    await page.route(SYNC_URL, (route) =>
      fulfillDoc(route, 4, [wireEntry("shared", H.serverUrl("srv-Z"))]),
    );
    await openLayouts(page);

    // ONE row for the name, server-sourced (server wins the collision).
    await expect(page.locator('[data-testid="layout-row"][data-name="shared"]')).toHaveCount(1);
    await expect(layoutRow(page, "shared")).toHaveAttribute("data-synced", "1");

    // The view-merge NEVER writes back: the local store still holds the LOCAL
    // two-pane entry under the same name (masked in the list, intact on disk).
    const store = await namedStore(page);
    const local = store?.["shared"] as
      | { scope?: string; layout?: { panels?: Record<string, unknown> } }
      | undefined;
    expect(local, "shadowed local entry intact in the local store").toBeTruthy();
    expect(local!.scope).toBe("tab");
    expect(Object.keys(local!.layout?.panels ?? {}).length).toBe(2);

    // LOAD takes the SERVER entry: a new workspace titled after the SERVER
    // entry's tabTitle, carrying the SERVER fixture's single srv-Z pane.
    await layoutRow(page, "shared").locator('[data-testid="layout-load"]').click();
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);
    const loaded = await H.activeWorkspace(page);
    expect(await H.workspaceName(page, loaded!)).toBe("shared tab");
    await expect.poll(async () => (await H.panes(page)).length, { timeout: 8000 }).toBe(1);
    expect((await H.paneParams(page))[0]?.url).toBe(H.serverUrl("srv-Z"));
  });

  test("409 on save: adopt the returned doc and retry ONCE with the adopted revision", async ({ page }) => {
    await H.twoPanes(page);

    let revision = 5;
    let putCount = 0;
    const putBodies: Array<{ baseRevision: number; name: string }> = [];
    await page.route(SYNC_URL, async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        await fulfillDoc(route, revision, []);
        return;
      }
      const body = req.postDataJSON() as { baseRevision: number; entry: { name: string } };
      putCount += 1;
      putBodies.push({ baseRevision: body.baseRevision, name: body.entry.name });
      if (putCount === 1) {
        // A concurrent write lands first: stale CAS → 409 with the CURRENT doc.
        revision = 6;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ revision, entries: [] }),
        });
        return;
      }
      // The retry carries the ADOPTED revision → success; the catalog now
      // holds exactly the published entry.
      revision = 7;
      await fulfillDoc(route, revision, [req.postDataJSON()!.entry]);
    });

    await saveTabViaUI(page, "conflicted", "Conflicted Tab");

    // The publish ran GET(5) → PUT(5)=409(6) → PUT(6)=200(7): exactly TWO
    // PUTs, the second with the adopted revision — the deliberate retry.
    await expect.poll(() => putCount, { timeout: 8000 }).toBe(2);
    expect(putBodies[0]!.baseRevision).toBe(5);
    expect(putBodies[1]!.baseRevision).toBe(6);
    // The committed doc was adopted → the row shows the synced badge.
    await expect(
      layoutRow(page, "conflicted").locator('[data-testid="layout-row-synced"]'),
    ).toBeVisible({ timeout: 8000 });
  });

  test("server entry with an unallowlisted target: load BLOCKED with a visible error, nothing opens", async ({ page }) => {
    await page.route(SYNC_URL, (route) =>
      fulfillDoc(route, 2, [wireEntry("evil", "javascript:alert(1)")]),
    );
    await openLayouts(page);
    await expect(layoutRow(page, "evil")).toBeVisible();

    const wsBefore = (await H.workspaces(page)).length;
    await layoutRow(page, "evil").locator('[data-testid="layout-load"]').click();

    // Visible error (never a silent drop-to-seed or a partial open)…
    const err = page.locator('[data-testid="layout-load-error"]');
    await expect(err).toBeVisible();
    await expect(err).toHaveText(/targets not allowed/i);
    // …the popover STAYS open (a blocked load is not a result)…
    await expect(page.locator('[data-testid="layouts-popover"]')).toBeVisible();
    // …no workspace was created…
    expect((await H.workspaces(page)).length).toBe(wsBefore);
    // …and the poisoned url never reached an unsandboxed iframe.src.
    const srcs = await H.iframeSrcs(page);
    expect(srcs.some((src) => src.startsWith("javascript:"))).toBe(false);
  });

  test("server entry with a malformed ({} ) layout: load BLOCKED with the invalid-entry error, nothing opens", async ({ page }) => {
    // layout: {} is an OBJECT, so both catalog-client guards accept it and
    // the row lists — but it is not a restorable SavedLayout. Before the
    // loadLayoutEntry structural gate this cold-restored as an EMPTY
    // workspace; it must instead BLOCK with the visible invalid-entry
    // error, no workspace created.
    await page.route(SYNC_URL, (route) =>
      fulfillDoc(route, 2, [
        { scope: "tab", name: "blob", tabTitle: "blob tab", layout: {}, savedAt: Date.now() },
      ]),
    );
    await openLayouts(page);
    await expect(layoutRow(page, "blob")).toBeVisible();

    const wsBefore = (await H.workspaces(page)).length;
    await layoutRow(page, "blob").locator('[data-testid="layout-load"]').click();

    const err = page.locator('[data-testid="layout-load-error"]');
    await expect(err).toBeVisible();
    await expect(err).toHaveText(/could not be loaded/i);
    await expect(page.locator('[data-testid="layouts-popover"]')).toBeVisible();
    expect((await H.workspaces(page)).length).toBe(wsBefore);
  });

  test("server entry with a valid SavedLayout shape but ZERO panels: load BLOCKED, nothing opens", async ({ page }) => {
    // Valid SavedLayout structure (grid + panels objects) with panels
    // emptied: passes isSavedLayout, passes the target gate trivially, and
    // before the zero-panel gate cold-restored as an EMPTY workspace. Local
    // saves can never produce this (canSaveTab requires >0 panes) — the
    // REJECT ruling. Same blocked outcome as the malformed shape.
    const zeroPane: Record<string, unknown> = {
      ...onePaneLayout(H.serverUrl("srv-Z")),
      panels: {},
    };
    await page.route(SYNC_URL, (route) =>
      fulfillDoc(route, 2, [
        { scope: "tab", name: "ghost", tabTitle: "ghost tab", layout: zeroPane, savedAt: Date.now() },
      ]),
    );
    await openLayouts(page);
    await expect(layoutRow(page, "ghost")).toBeVisible();

    const wsBefore = (await H.workspaces(page)).length;
    await layoutRow(page, "ghost").locator('[data-testid="layout-load"]').click();

    const err = page.locator('[data-testid="layout-load-error"]');
    await expect(err).toBeVisible();
    await expect(err).toHaveText(/could not be loaded/i);
    await expect(page.locator('[data-testid="layouts-popover"]')).toBeVisible();
    expect((await H.workspaces(page)).length).toBe(wsBefore);
  });

  test("dev degradation: no backend → catalog silently empty; local saves work, warn once, stay loadable", async ({ page }) => {
    // NO route interception: the vite dev server answers /vh/layouts with its
    // SPA fallback (200 HTML) — the catalog client must degrade SILENTLY.
    const warnings: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "warning") warnings.push(msg.text());
    });

    await saveTabViaUI(page, "dev-local", "Dev Local");
    await expect(layoutRow(page, "dev-local")).toBeVisible();

    // Local row, NOT badged (no server doc adopted)…
    await expect(layoutRow(page, "dev-local")).toHaveAttribute("data-synced", "0");
    // …the publish degraded with exactly the documented console warning…
    await expect
      .poll(
        () => warnings.filter((w) => w.includes("skipping server layout sync")).length,
        { timeout: 8000 },
      )
      .toBeGreaterThanOrEqual(1);
    // …no load error was surfaced (a missing backend is not a load failure)…
    await expect(page.locator('[data-testid="layout-load-error"]')).toHaveCount(0);

    // …and the local layout LOADS normally (localStorage carries the feature).
    await page.keyboard.press("Escape");
    await openLayouts(page);
    await layoutRow(page, "dev-local").locator('[data-testid="layout-load"]').click();
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);
    expect(await H.workspaceName(page, (await H.activeWorkspace(page))!)).toBe("Dev Local");
  });
});
