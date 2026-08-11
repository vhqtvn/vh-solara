import { test, expect } from "@playwright/test";
import { paneParams } from "../e2e/util";
import { FLEET_POISONED, FLEET_SERVERS } from "./fleet-data";

// =============================================================================
// Config-driven real-fleet seeding proof (Phase-1′ sub-slice).
//
// Runs ONLY under playwright.fleet.config.ts, which starts a DEDICATED host dev
// server on :5177 with VITE_SERVERS set to FLEET_SERVERS (pointing the pane urls
// at the existing mock content page :5174 as a stand-in "real" server). This
// proves resolveFleet() seeds the CONFIGURED {url,label} pairs — NOT the mock
// fleet — WITHOUT needing a live real vh-solara server.
//
// WORKSPACE MODEL (post workspace-tabs refactor, commit 41a28fa): the host
// shell's top Tabstrip carries ONE TAB PER WORKSPACE, not one tab per server
// pane. A configured fleet seeds into the SINGLE default workspace
// (initWorkspaces() → "Workspace 1"), so a fleet of N servers shows as ONE
// workspace tab + N panes (Dockview panels whose iframes live in the always-
// rendered overlay). Per-pane identity lives in those panes — verified here via
// the DEV-only window.__host bridge (paneParams → {id,url,label}) and the pane
// iframes (.pane-iframe srcs), NOT via the top Tabstrip. The fleet dev server
// runs the Vite dev build, so window.__host is present.
//
// What this gate proves (the slice's crux):
//   - the top Tabstrip shows the WORKSPACE tab(s), not per-server tabs,
//   - panes are seeded from VITE_SERVERS (count + url + label match the config),
//   - each pane's iframe src is the configured url (not the mock fleet's),
//   - no mock-fleet label ("srv-A · …") leaks into a real-fleet session,
//   - a `javascript:` (non-http/https) VITE_SERVERS entry is REJECTED and never
//     reaches an iframe src (the F1 guard, proven not just code-read).
// What it does NOT re-prove: a live real server's auth/SSE (the Phase-0 spike
// already proved that; out of scope here).
// =============================================================================

test.describe("config-driven fleet seeding (VITE_SERVERS)", () => {
  test("seeds panes from VITE_SERVERS into the workspace, not the mock fleet", async ({ page }) => {
    await page.goto("/");
    // Heartbeats flowing through the store router → focused-pane liveness
    // "document alive" (Q1-C) proves the configured urls (which point at the
    // mock content page) actually loaded and heartbeated, i.e. the url wiring is
    // real, not just a label.
    await expect(page.locator('[data-testid="statusbar"]')).toContainText(
      "document alive",
      { timeout: 30_000 },
    );

    // ---- TOP TABSTRIP: workspace tabstrip (i3 host-shell, Phase 1). ----
    // The fleet seeds into the SINGLE default workspace, so there is exactly
    // ONE workspace tab (the default "Workspace 1"). A ws tab carries the
    // WORKSPACE name, never a per-server label — the per-server identity lives
    // in the panes (proven below), not the strip. (Fleet seeding is proven via
    // panes + iframe srcs, which are unchanged by the tabstrip model.)
    const wsTabs = page.locator('[data-testid="ws-tab"]');
    await expect(wsTabs).toHaveCount(1);
    const wsTexts = await wsTabs.allInnerTexts();
    for (const f of FLEET_SERVERS) {
      expect(
        wsTexts.join("\n"),
        `no workspace tab carries the per-server label "${f.label}"`,
      ).not.toContain(f.label);
    }

    // ---- PANES: seeded from VITE_SERVERS, count + url + label config-driven. ----
    // Per-pane identity lives in Dockview's panes (verified via the DEV bridge),
    // not the top Tabstrip. Exactly the configured number of panes, not the mock
    // fleet's 4.
    await expect
      .poll(async () => (await paneParams(page)).length, { timeout: 20_000 })
      .toBe(FLEET_SERVERS.length);

    // Each configured {url,label} is carried by exactly one seeded pane.
    const params = await paneParams(page);
    for (const f of FLEET_SERVERS) {
      expect(
        params.some((p) => p.url === f.url && p.label === f.label),
        `a seeded pane carries configured {url,label} for "${f.label}"`,
      ).toBe(true);
    }
    // No mock-fleet label leaks into a real-fleet session.
    expect(
      params.map((p) => p.label).join("\n"),
      "no mock-fleet label leaked into a real-fleet session",
    ).not.toContain("srv-A");

    // Each configured url is the src of some seeded pane iframe (proves the url
    // — not just the label — is config-driven). getAttribute('src') returns the
    // raw attribute (the exact string set from params.url), not a resolved URL.
    const srcs = await page
      .locator(".pane-iframe")
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLIFrameElement).getAttribute("src")),
      );
    for (const f of FLEET_SERVERS) {
      expect(
        srcs,
        `a pane iframe src equals configured url for "${f.label}"`,
      ).toContain(f.url);
    }

    // Statusbar focus reflects the first configured label (pane0 is focused).
    await expect(page.locator('[data-testid="statusbar"]')).toContainText(
      FLEET_SERVERS[0].label,
    );
  });

  test("rejects a javascript: (non-http/https) VITE_SERVERS entry", async ({
    page,
  }) => {
    // NEGATIVE proof for the F1 guard: VITE_SERVERS (FLEET_JSON) is seeded with
    // the valid entries AND a `javascript:` poison entry. isFleetEntry() must
    // reject the poison at seed time so it never reaches an unsandboxed
    // iframe.src (which would execute same-origin against the host shell).
    await page.goto("/");
    await expect(page.locator('[data-testid="statusbar"]')).toContainText(
      "document alive",
      { timeout: 30_000 },
    );

    // The poisoned entry must NOT seed a pane: the pane count is the VALID
    // entries only (isFleetEntry filtered out the javascript: value at seed
    // time). Verified via the DEV bridge (paneParams) and the iframe DOM.
    await expect
      .poll(async () => (await paneParams(page)).length, { timeout: 20_000 })
      .toBe(FLEET_SERVERS.length);

    const params = await paneParams(page);
    // The poisoned label never appears in any pane.
    expect(
      params.map((p) => p.label).join("\n"),
      "the poisoned label never appears in any pane",
    ).not.toContain(FLEET_POISONED.label);

    // No pane iframe src is a javascript: value, and the poisoned url never
    // reaches an iframe src. getAttribute('src') returns the raw attribute (the
    // exact string set from params.url).
    const srcs = await page
      .locator(".pane-iframe")
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLIFrameElement).getAttribute("src") ?? ""),
      );
    expect(srcs.length, "only the valid panes have iframes").toBe(
      FLEET_SERVERS.length,
    );
    for (const src of srcs) {
      expect(src, "no iframe src is a javascript: value").not.toMatch(
        /^javascript:/,
      );
    }
    expect(
      srcs,
      "the poisoned url never reaches an iframe src",
    ).not.toContain(FLEET_POISONED.url);
  });
});
