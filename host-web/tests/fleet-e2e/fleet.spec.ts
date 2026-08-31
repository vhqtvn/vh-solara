import { test, expect } from "@playwright/test";
import { addServer, paneParams, waitForSavedLayout } from "../e2e/util";
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
    // Readiness: seed panes render as iframes whose srcs point at the configured
    // urls (the mock content page). The prior statusbar "document alive" gate is
    // gone with the statusbar (no DOM heartbeat indicator anymore); the iframe
    // srcs + pane params below prove the configured urls actually loaded (the
    // url-wiring-is-real guarantee), which is the load-bearing claim here.

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

    // The first configured label is carried by pane0's params (the statusbar
    // focus line that used to show it is gone with the statusbar; paneParams is
    // the same source). pane0 is the first seeded pane.
    const params0 = await paneParams(page);
    expect(
      params0.some((p) => p.label === FLEET_SERVERS[0].label),
      "the first configured label is carried by a seeded pane",
    ).toBe(true);
  });

  test("rejects a javascript: (non-http/https) VITE_SERVERS entry", async ({
    page,
  }) => {
    // NEGATIVE proof for the F1 guard: VITE_SERVERS (FLEET_JSON) is seeded with
    // the valid entries AND a `javascript:` poison entry. isFleetEntry() must
    // reject the poison at seed time so it never reaches an unsandboxed
    // iframe.src (which would execute same-origin against the host shell).
    await page.goto("/");
    // Readiness: seed panes render (the statusbar readiness gate is gone with
    // the statusbar; the iframe srcs + pane count below are the proof). The
    // poisoned entry must NOT seed a pane: the pane count is the VALID entries
    // only (isFleetEntry filtered out the javascript: value at seed time).
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

// =============================================================================
// F3 (card hostweb-layout-restore-proof-gaps): configured-fleet RESTORE
// validation — the validRestoreIds() fleetOrigins branch in
// src/dockview/layoutPersistence.ts.
//
// In this lane VITE_SERVERS is set (FLEET_JSON), so hasRealFleetEnv() is TRUE
// and cold restore builds an origin allowlist from the BUILD-TIME config
// (resolveBaseFleet → every FLEET_SERVERS url points at origin
// http://127.0.0.1:5174). A saved pane whose url origin is NOT a member is
// DROPPED; configured-origin panes survive. This branch is UNREACHABLE in the
// default mock-only suite (fleetOrigins is null there — protocol check only),
// which is exactly why the original review flagged it as unwitnessed.
//
// The allowlist is anchored to BUILD-TIME VITE_SERVERS, deliberately NOT the
// runtime catalog — so a pane ADDED at runtime to a configured origin survives
// restore, while one added at runtime to an unconfigured origin is dropped.
// Both sides are proven below with runtime-added panes (the seeded configured
// panes are the third, pre-existing side).
// =============================================================================

test.describe("configured-fleet restore validation (validRestoreIds fleetOrigins branch)", () => {
  test("restore keeps configured-origin panes and drops unconfigured-origin panes", async ({
    page,
  }) => {
    await page.goto("/");
    await expect
      .poll(async () => (await paneParams(page)).length, { timeout: 20_000 })
      .toBe(FLEET_SERVERS.length);
    const seeded = await paneParams(page);
    expect(seeded.length, "fleet seeded before mutation").toBe(FLEET_SERVERS.length);

    // A runtime-added server whose url ORIGIN is configured (the mock content
    // page :5174 — the same origin every FLEET_SERVERS url points at; the
    // query params differ, the origin does not).
    const CONFIGURED_URL = "http://127.0.0.1:5174/?server=fleet-extra&view=chat";
    const CONFIGURED_LABEL = "fleet-extra";
    // A runtime-added server at an ORIGIN NOT in the configured fleet. Nothing
    // listens on :5999 — the pane's iframe shows a connection error while
    // live, but the pane itself exists and SAVES; only RESTORE must drop it.
    const GHOST_URL = "http://127.0.0.1:5999/?server=ghost&view=chat";
    const GHOST_LABEL = "ghost";

    const extraPane = await addServer(page, CONFIGURED_URL, CONFIGURED_LABEL);
    expect(extraPane, "configured-origin runtime pane opened").toBeTruthy();
    const ghostPane = await addServer(page, GHOST_URL, GHOST_LABEL);
    expect(ghostPane, "unconfigured-origin runtime pane opened").toBeTruthy();
    await expect
      .poll(async () => (await paneParams(page)).length, { timeout: 20_000 })
      .toBe(FLEET_SERVERS.length + 2);

    // SAVE SIDE: the debounced save carries BOTH runtime-added panes — the
    // save path applies no origin filter; validation is restore-side only.
    await waitForSavedLayout(page, FLEET_SERVERS.length + 2);

    // RELOAD → cold restore under the fleetOrigins allowlist: the ghost pane
    // (origin :5999 ∉ {http://127.0.0.1:5174}) is dropped; every
    // configured-origin pane — seeded AND runtime-added — survives.
    await page.reload();
    await expect
      .poll(async () => (await paneParams(page)).length, { timeout: 20_000 })
      .toBe(FLEET_SERVERS.length + 1);

    const restored = await paneParams(page);
    // Every configured seeded pane survived with its exact {url,label}.
    for (const f of FLEET_SERVERS) {
      expect(
        restored.some((p) => p.url === f.url && p.label === f.label),
        `configured seeded pane "${f.label}" survived restore`,
      ).toBe(true);
    }
    // The runtime-added CONFIGURED-origin pane survived too — origin
    // membership, not seed-vs-runtime provenance, is the criterion.
    const extra = restored.find((p) => p.url === CONFIGURED_URL);
    expect(
      extra,
      "runtime-added configured-origin pane survived restore",
    ).toBeDefined();
    expect(extra!.label, "surviving runtime pane kept its label").toBe(CONFIGURED_LABEL);
    // The runtime-added UNCONFIGURED-origin pane was DROPPED.
    expect(
      restored.find((p) => p.url === GHOST_URL || p.label === GHOST_LABEL),
      "unconfigured-origin pane dropped on restore",
    ).toBeUndefined();
    // Defense in depth: no iframe src points at the unconfigured origin.
    const srcs = await page
      .locator(".pane-iframe")
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLIFrameElement).getAttribute("src") ?? ""),
      );
    expect(
      srcs.some((s) => s.startsWith("http://127.0.0.1:5999")),
      "no iframe src points at the unconfigured origin",
    ).toBe(false);
  });
});
