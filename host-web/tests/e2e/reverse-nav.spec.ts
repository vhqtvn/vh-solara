import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// P4 enabler: host→pane reverse-nav select-command.
//
// Proves the host can direct a pane's embedded SPA to switch to a specific
// {dir, session} WITHOUT reloading the iframe (a survival-safe SPA-INTERNAL
// route change). The host calls selectTarget → posts {type:'vh-host-select'} →
// the mock stand-in (host-web/iframe-content/content.ts) re-emits
// {type:'route',route} as the round-trip signal → the host's route-capture
// (updateRoute) observes it. The real SPA's heartbeat loop produces the same
// round-trip after its SPA-internal setSelectedId/switchProject; the mock
// stand-in models it faithfully (source-guard + allowlist + route re-emit).
//
// CRUX: SURVIVAL. The select drives the SPA via postMessage only — the iframe
// element, its src, and `renderer:'always'` are NEVER touched. Identity
// (mountTs/nonce/connId) is UNCHANGED across the select (no reload).
//
// Runs on Chromium + Firefox (playwright.config.ts projects).
// =============================================================================

test.describe("P4 reverse-nav (host→pane select-command)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("selectTarget round-trips a route change WITHOUT reloading the iframe (survival)", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];

    // Baseline identity BEFORE the select.
    const before = (await H.survival(page, pane))!;
    expect(before.mountTs, "baseline mountTs present").toBeGreaterThan(0);

    // Drive a select through the production HostOps path. The host posts
    // {type:'vh-host-select',dir,session} to the pane's contentWindow (origin-
    // scoped to the mock's :5174). The mock stand-in source-guards, validates,
    // and re-emits {type:'route',route} → the host captures it via updateRoute
    // (params only, survival-safe — the renderer has no update()).
    const DIR = "/proj-revnav";
    const SESSION = "sess-42";
    await H.selectTarget(page, pane, DIR, SESSION);

    // ROUND-TRIP #1: the host captured the route into the pane's params
    // (updateRoute, the SAME path the SPA's heartbeat-loop emission uses). This
    // proves the host→select→mock→route→host round-trip completed. The route is
    // encoded the same way the real SPA's allowlistRoute (URLSearchParams) +
    // the mock's encodeURIComponent both encode it.
    const expectedRoute = `?dir=${encodeURIComponent(DIR)}&session=${encodeURIComponent(SESSION)}`;
    await expect
      .poll(
        async () => {
          const params = await H.paneParams(page);
          return params.find((p) => p.id === pane)?.route ?? null;
        },
        { timeout: 5000 },
      )
      .toBe(expectedRoute);

    // ROUND-TRIP #2 (defense-in-depth): the mock stand-in surfaced the select
    // into its DOM (deterministic, not network-bound). The mock received the
    // exact {dir, session} the host posted.
    const iframe = page
      .locator(`[data-pane-id="${pane}"] iframe.pane-iframe`)
      .contentFrame()
      .locator("#app");
    await expect(iframe).toHaveAttribute("data-select-dir", DIR);
    await expect(iframe).toHaveAttribute("data-select-session", SESSION);
    await expect(iframe).toHaveAttribute("data-route", expectedRoute);

    // CRUX — SURVIVAL: the select is a postMessage + SPA-internal route change;
    // the iframe element is untouched. Identity (mountTs/nonce/connId) UNCHANGED.
    await H.assertSurvived(page, pane, before, "select");
  });

  test("selectTarget is origin-scoped: posts only to the pane's configured origin", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];

    // The seeded panes are mock content at :5174. selectTarget posts with
    // targetOrigin = configuredOrigin (:5174); the mock receives it (its origin
    // matches) and re-emits the route. If the host had posted to '*' or a wrong
    // origin the mock would still receive it, so this test's real teeth are in
    // the unit-level listener (source-guard + allowlist) — here we prove the
    // happy path end-to-end: a real select on a seeded pane round-trips.
    const before = (await H.survival(page, pane))!;
    await H.selectTarget(page, pane, "/anywhere", "sX");
    await expect
      .poll(
        async () => {
          const params = await H.paneParams(page);
          return params.find((p) => p.id === pane)?.route ?? null;
        },
        { timeout: 5000 },
      )
      .toBe(`?dir=${encodeURIComponent("/anywhere")}&session=sX`);
    // Survival holds.
    await H.assertSurvived(page, pane, before, "origin-scoped select");
  });

  test("selectTarget is no-op for an unknown pane (no throw, survival unchanged)", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const before = (await H.survival(page, pane))!;

    // An unknown pane id → lookupContentWindow returns null → selectTarget is a
    // no-op (no post, no throw). The known pane is untouched.
    await H.selectTarget(page, "nonexistent-pane-id", "/x", "s");
    // No route captured for the unknown pane (it has no params entry).
    const params = await H.paneParams(page);
    expect(params.find((p) => p.id === "nonexistent-pane-id")).toBeUndefined();
    // The known pane survived (nothing global changed).
    await H.assertSurvived(page, pane, before, "no-op select on unknown pane");
  });

  test("repeated selectTarget calls keep round-tripping WITHOUT reloading", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const before = (await H.survival(page, pane))!;

    // Drive several selects in sequence (the P4 flat-tabs / NEXT-jump pattern:
    // the operator hops between sessions). Each round-trips a route; the iframe
    // survives all of them (identity stable across the whole sequence).
    for (let i = 0; i < 3; i++) {
      await H.selectTarget(page, pane, `/d${i}`, `s${i}`);
      const want = `?dir=${encodeURIComponent(`/d${i}`)}&session=s${i}`;
      await expect
        .poll(
          async () => {
            const params = await H.paneParams(page);
            return params.find((p) => p.id === pane)?.route ?? null;
          },
          { timeout: 5000 },
        )
        .toBe(want);
    }

    // Identity SURVIVED the whole sequence: mountTs/nonce/connId unchanged.
    await H.assertSurvived(page, pane, before, "repeated selects");
  });
});

// =============================================================================
// F3 fold: NEXT button pulse animation (Tabstrip.module.css scoped className).
//
// The NEXT hero button moved from the deleted bottom statusbar into the top
// tabstrip (next to "Add server"). Its pulse lives in Tabstrip.module.css as
// `.nextBtn { animation: ts-next-pulse ... }` — applied directly (no separate
// is-pulsing class; the <Show> in Tabstrip.tsx gates the button's existence on
// needsYouCount() > 0, so the button only renders when it should pulse). This
// is an OUTCOME check: the computed animationName resolves to the keyframe (not
// "none"), proving the slow opacity pulse actually plays. prefers-reduced-motion
// is NOT set in the headless default, so the animation is active. (The original
// F3 crux was a scoped-class bug in Statusbar.module.css; that component is
// gone, but the OUTCOME guarantee — the pulse plays — is re-pinned here against
// the button's new home.)
// =============================================================================

test("F3: NEXT button pulse animation applies (scoped is-pulsing class matches)", async ({
  page,
}) => {
  await H.loadHost(page);
  const ids = await H.panes(page);
  const pane = ids[0];

  // Before any needs-you: no NEXT button rendered.
  await expect(page.locator('[data-testid="attention-next"]')).toHaveCount(0);

  // Drive a needs_permission status → the NEXT hero button appears (N>0) and
  // should pulse (the slow opacity keyframe is the only animation; no GPU-heavy
  // CSS — AGENTS.md Firefox/WebRender rules).
  await H.probeStatus(page, {
    sourcePaneId: pane,
    origin: "http://127.0.0.1:5174",
    payload: {
      type: "status",
      dir: "",
      session: "s1",
      title: "",
      attention: "needs_permission",
      activity: "idle",
      following: true,
    },
  });
  await expect.poll(async () => H.needsYou(page), { timeout: 5000 }).toBe(1);

  const btn = page.locator('[data-testid="attention-next"]');
  await expect(btn).toBeVisible();

  // CRUX (F3 outcome): the computed animationName is the pulse keyframe, NOT
  // "none". Before the scoped-class fix the compound selector never matched →
  // animationName was "none" (the pulse never fired). With the fix both class
  // tokens are hashed and the selector matches → animationName resolves to the
  // keyframe. This proves the pulse actually plays.
  const animationName = await btn.evaluate((el) => {
    const cs = getComputedStyle(el as HTMLElement);
    return cs.animationName;
  });
  expect(animationName, "NEXT button pulse keyframe applied (not none)").not.toBe("none");
});
