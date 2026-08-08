import { test, expect } from "@playwright/test";
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
// What this gate proves (the slice's crux):
//   - panes are seeded from VITE_SERVERS (count + labels match the config),
//   - each pane's iframe src is the configured url (not the mock fleet's),
//   - no mock-fleet label ("srv-A · …") leaks into a real-fleet session,
//   - a `javascript:` (non-http/https) VITE_SERVERS entry is REJECTED and never
//     reaches an iframe src (the F1 guard, proven not just code-read).
// What it does NOT re-prove: a live real server's auth/SSE (the Phase-0 spike
// already proved that; out of scope here).
// =============================================================================

test.describe("config-driven fleet seeding (VITE_SERVERS)", () => {
  test("seeds panes from VITE_SERVERS, not the mock fleet", async ({ page }) => {
    await page.goto("/");
    // Heartbeats flowing through the store router → "connected" proves the
    // configured urls (which point at the mock content page) actually loaded and
    // heartbeated, i.e. the url wiring is real, not just a label.
    await expect(page.locator('[data-testid="statusbar"]')).toContainText(
      "connected",
      { timeout: 30_000 },
    );

    // Exactly the configured number of panes, not the mock fleet's 4.
    const tabs = page.locator('[data-testid="ws-tab"]');
    await expect
      .poll(async () => await tabs.count(), { timeout: 20_000 })
      .toBe(FLEET_SERVERS.length);

    // Labels are the configured ones, NOT the mock "srv-A · …" labels.
    const texts = await tabs.allInnerTexts();
    for (const f of FLEET_SERVERS) {
      expect(
        texts.some((t) => t.includes(f.label)),
        `tab label includes configured "${f.label}"`,
      ).toBe(true);
    }
    expect(
      texts.join("\n"),
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

    // Statusbar focus reflects the first configured label (tab0 is focused).
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
      "connected",
      { timeout: 30_000 },
    );

    // The poisoned entry must NOT seed a pane: the count is the VALID entries
    // only (isFleetEntry filtered out the javascript: value at seed time).
    const tabs = page.locator('[data-testid="ws-tab"]');
    await expect
      .poll(async () => await tabs.count(), { timeout: 20_000 })
      .toBe(FLEET_SERVERS.length);

    // The poisoned label never appears in any tab.
    const texts = await tabs.allInnerTexts();
    expect(
      texts.join("\n"),
      "the poisoned label never appears in any tab",
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
