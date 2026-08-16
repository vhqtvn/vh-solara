import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// Per-tab URL state + SPA route emission + restore — regression gate.
//
// Two coupled features on top of the multi-workspace model:
//
//  1. HYBRID URL state (Fork 1): the URL hash (#state=<encoded>) is the source
//     of truth for PER-TAB state (two same-origin tabs stay independent);
//     localStorage is the write-through mirror so a bare "/" reopen inherits
//     the last-saved state. history.replaceState writes the hash (no
//     hashchange → no fromJSON → survival-safe).
//
//  2. SPA route emission + restore (Fork 2): the embedded SPA posts
//     {type:"route",route} on a location.search change (mirroring the heartbeat
//     security model). The host captures it per-pane via updateParameters
//     (survival-safe — the renderer has no update()), persists it in the URL
//     hash, and restores it into the iframe src at cold creation (reload) so the
//     SPA deep-links itself.
//
// This spec proves:
//   - a route change is captured + survives reload (deep-link in iframe src);
//   - two tabs at "/" stay independent (each carries its own #state= hash);
//   - a route change does NOT reload the iframe (identity preserved).
//
// The route message is driven through the REAL routeMessage router via the
// DEV-only probePaneMessage bridge (source-bound to a real pane's
// contentWindow — same path the SPA's heartbeat-loop emission uses). The mock
// content page is the sanctioned seam (same model as the heartbeat protocol).
//
// Runs on Chromium + Firefox + WebKit (playwright.config.ts projects).
// =============================================================================

// ---- Fork 2: route survives reload ----------------------------------------

test("route change is captured + restored on reload (deep-link in iframe src)", async ({
  page,
}) => {
  await H.loadHost(page);
  const ids = await H.panes(page);
  const pane = ids[0];

  // Drive a route change into the pane exactly as the SPA's heartbeat-loop
  // emission would (source-bound to the real contentWindow).
  const route = "?dir=/test-project&session=42";
  const r = await H.probePaneMessage(page, {
    sourcePaneId: pane,
    origin: H.MOCK_ORIGIN,
    payload: { type: "route", route },
  });
  expect(r.accepted, "route message accepted (source-bound)").toBe(true);

  // The route was captured into the panel params WITHOUT reloading (the
  // renderer has no update() → survival-safe).
  const params = await H.paneParams(page);
  const captured = params.find((p) => p.id === pane);
  expect(captured?.route, "route captured into panel params").toBe(route);

  // Wait for the debounced save → URL hash (#state=) written via replaceState.
  await H.waitForHashContent(page, "dir=/test-project");

  // Reload — the cold restore reads the URL hash (per-tab source of truth).
  await page.reload();
  await expect
    .poll(async () => H.connected(page), { timeout: 20000 })
    .toBe(true);
  const restoredIds = await H.panes(page);
  for (const id of restoredIds) await H.waitForReady(page, id);

  // The iframe src must carry the restored route query (deep-link restore).
  const srcs = await H.iframeSrcs(page);
  const routed = srcs.find((s) => s.includes("dir=/test-project"));
  expect(
    routed,
    "at least one iframe src carries the restored route query",
  ).toBeTruthy();
  expect(routed, "iframe src carries the restored session query").toContain(
    "session=42",
  );

  // The route must also be in the restored panel params (round-trip).
  const restored = await H.paneParams(page);
  const restoredRoute = restored.find((p) => p.route === route);
  expect(
    restoredRoute,
    "route round-tripped through reload into panel params",
  ).toBeTruthy();
});

// ---- Fork 1: per-tab independence (URL hash beats shared localStorage) -----

test("two tabs at / stay independent (per-tab URL hash, not shared localStorage)", async ({
  browser,
}) => {
  // Two PAGES in the SAME browser context share localStorage — this is the
  // model that proves per-tab independence. Each page has its own URL (with
  // its own #state= hash) and its own JS context (module init runs per page).
  //
  // NOTE: a cold restore does NOT trigger a save (installLayoutSaver hooks
  // AFTER fromJSON) — only user mutations persist. Route changes call
  // scheduleSave, so driving a route probe on each page writes that page's OWN
  // hash. The test uses a route-based distinction (cleaner than panel counts
  // which race when two pages share localStorage): A and B each write a
  // DISTINCT route into their own hash, then A overwrites localStorage with a
  // THIRD route. On reload, B must read its OWN hash, not localStorage.
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    // A loads first, drives route "?dir=/A" → A's hash + localStorage carry it.
    await H.loadHost(pageA);
    const aPane = (await H.panes(pageA))[0];
    await H.probePaneMessage(pageA, {
      sourcePaneId: aPane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "route", route: "?dir=/tab-A" },
    });
    await H.waitForHashContent(pageA, "dir=/tab-A");

    // B loads at "/" (no hash) → reads localStorage (carries dir=/tab-A from
    // A). B drives route "?dir=/tab-B" → B's hash + localStorage carry it.
    // B's hash is now frozen at dir=/tab-B (B won't mutate again).
    await H.loadHost(pageB);
    const bPane = (await H.panes(pageB))[0];
    await H.probePaneMessage(pageB, {
      sourcePaneId: bPane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "route", route: "?dir=/tab-B" },
    });
    await H.waitForHashContent(pageB, "dir=/tab-B");

    // A diverges AGAIN: drives route "?dir=/tab-A2" → A's hash + localStorage
    // carry dir=/tab-A2. B's hash is STILL dir=/tab-B (frozen in B's own URL).
    // localStorage now holds dir=/tab-A2 (A just wrote it).
    await H.probePaneMessage(pageA, {
      sourcePaneId: aPane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "route", route: "?dir=/tab-A2" },
    });
    await H.waitForHashContent(pageA, "dir=/tab-A2");
    // Confirm localStorage now holds A's newest (dir=/tab-A2), NOT B's.
    const lsRoute = await pageB.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ?? "";
    }, H.LAYOUT_STORAGE_KEY);
    expect(lsRoute, "localStorage holds A's newest route").toContain("dir=/tab-A2");

    // B's hash is STILL dir=/tab-B (frozen). On reload, B must read its OWN
    // hash (dir=/tab-B), NOT localStorage (dir=/tab-A2).
    const bHashBefore = await H.rawHash(pageB);
    expect(bHashBefore.startsWith("#state="), "B carries its own #state= hash").toBe(true);
    expect(JSON.stringify(await H.readHashState(pageB))).toContain("dir=/tab-B");

    // Reload B. B navigates to B's current URL (with B's frozen hash).
    await pageB.reload();
    await expect
      .poll(async () => H.connected(pageB), { timeout: 20000 })
      .toBe(true);
    const bIds = await H.panes(pageB);
    for (const id of bIds) await H.waitForReady(pageB, id);

    // B's restored panel params must carry dir=/tab-B (from B's OWN hash), NOT
    // dir=/tab-A2 (from the shared localStorage A clobbered).
    const restored = await H.paneParams(pageB);
    const bRestored = restored.find((p) => p.id === bPane);
    expect(bRestored?.route, "B restored from its OWN hash (dir=/tab-B)").toBe("?dir=/tab-B");
    expect(bRestored?.route, "B did NOT inherit A's localStorage (dir=/tab-A2)").not.toBe("?dir=/tab-A2");
  } finally {
    await context.close();
  }
});

// ---- Fork 2 survival: route change does NOT reload the iframe -------------

test("route change does NOT reload the iframe (identity preserved)", async ({
  page,
}) => {
  await H.loadHost(page);
  const ids = await H.panes(page);
  const pane = ids[0];

  const before = (await H.survival(page, pane))!;

  // Drive a route change (as the SPA's heartbeat emission would). This calls
  // updateParameters (survival-safe — no src change, no renderer update).
  await H.probePaneMessage(page, {
    sourcePaneId: pane,
    origin: H.MOCK_ORIGIN,
    payload: { type: "route", route: "?dir=/survival-test&session=7" },
  });

  // The route was captured into params.
  const params = await H.paneParams(page);
  expect(params.find((p) => p.id === pane)?.route).toBe(
    "?dir=/survival-test&session=7",
  );

  // Identity SURVIVED: mountTs/nonce/connId unchanged (iframe not reloaded).
  await H.assertSurvived(page, pane, before, "route change");
});
