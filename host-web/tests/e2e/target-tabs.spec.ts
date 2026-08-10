import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// P4 Phase 2: flat-session-tabs MVP (the attention-target registry + tabstrip).
//
// The operator's unit of attention is a SESSION, not a workspace. The host keeps
// a registry of intentionally-visited AttentionTarget records (Fork B: a tab
// appears ONLY when the operator opens/selects it — no auto-enumeration). The
// flat tabstrip renders those records; clicking a tab drives a survival-safe
// SPA-INTERNAL route change (no iframe.src/reparent).
//
// This suite covers:
//  1. Visiting mints a tab; re-visit dedupes (host selectTarget + accepted route).
//  2. Tab click → selectTarget → SPA route changes → iframe IDENTITY SURVIVES.
//  3. Honest status: a live target shows its needs-you badge; a target whose
//     pane navigated away shows stale (NO badge — never a false needs-you).
//  4. Caps: unpinned cap 20 (LRU evict); pinned cap 10 (REFUSE, no silent evict).
//  5. Age retirement: a >7-day-old unpinned record is evicted (startup + mutation).
//
// CRUX #1 — TAB-SWITCH SURVIVAL: a tab click = selectTarget = SPA-internal route;
// the iframe element/src/renderer:'always' are NEVER touched. Identity
// (mountTs/nonce/connId) is UNCHANGED across the switch (assertSurvived).
//
// CRUX #2 — HONEST STATUS: a needs-you badge shows ONLY while a live pane is
// currently reporting that exact target; a stale target shows NO badge (it must
// not claim current attention it cannot honestly back).
//
// Runs on Chromium + Firefox (playwright.config.ts projects).
// =============================================================================

/** The mock content server origin the seeded panes bind to (configuredOrigin). */
const MOCK_ORIGIN = "http://127.0.0.1:5174";

/** Days-to-ms for the age-retirement math (must match the registry constant). */
const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("P4 flat-session-tabs (registry + tabstrip)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // --------------------------------------------------------------------------
  // 1. VISIT MINTS A TAB; RE-VISIT DEDUPES
  // --------------------------------------------------------------------------

  test("visiting a target mints a tab; re-visit dedupes (no duplicate)", async ({
    page,
  }) => {
    // Fork B: a tab appears ONLY when the operator selects a session. Drive a
    // select through the production HostOps path → visit() (host-driven) + the
    // route round-trip → visit() again (SPA-internal). Dedupe → exactly 1 tab.
    const ids = await H.panes(page);
    const pane = ids[0];
    const DIR = "/proj-tabs";
    const SESSION = "sess-mint";

    expect(await H.targetCount(page), "no tabs before any visit").toBe(0);

    await H.selectTarget(page, pane, DIR, SESSION);

    // The visit landed (host-driven); the route round-trip dedupes to the same
    // record. Exactly one tab for this exact (serverId,dir,session).
    await H.waitForTargetCount(page, 1);
    const recs = await H.targets(page);
    expect(recs.length).toBe(1);
    expect(recs[0].serverId).toBe(MOCK_ORIGIN);
    expect(recs[0].dir).toBe(DIR);
    expect(recs[0].session).toBe(SESSION);

    // Re-visit the SAME target → still exactly one tab (deduped).
    await H.selectTarget(page, pane, DIR, SESSION);
    await H.waitForTargetCount(page, 1);

    // Visit a DIFFERENT session → second tab.
    await H.selectTarget(page, pane, DIR, "sess-other");
    await H.waitForTargetCount(page, 2);

    // The active target is the most-recently-visited one.
    const at = await H.activeTarget(page);
    expect(at).toEqual({ serverId: MOCK_ORIGIN, dir: DIR, session: "sess-other" });
  });

  // --------------------------------------------------------------------------
  // 2. TAB CLICK → selectTarget → SPA ROUTE CHANGES → IFRAME SURVIVES (CRUX #1)
  // --------------------------------------------------------------------------

  test("tab click drives selectTarget; iframe identity SURVIVES the switch", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];

    // Visit two targets on the same pane/server (the operator hops between
    // sessions of the same server).
    const DIR_A = "/proj-surv";
    const SESS_A = "sess-a";
    const SESS_B = "sess-b";
    await H.selectTarget(page, pane, DIR_A, SESS_A);
    await H.selectTarget(page, pane, DIR_A, SESS_B);
    await H.waitForTargetCount(page, 2);

    // Baseline identity BEFORE the tab click.
    const before = (await H.survival(page, pane))!;
    expect(before.mountTs, "baseline mountTs present").toBeGreaterThan(0);

    // Click the FIRST tab (sess-a) in the UI. The Tabstrip resolves the pane
    // via findPaneForServer(MOCK_ORIGIN) → the seeded pane → selectTarget.
    const tabA = page.locator(
      `[data-testid="target-tab"][data-dir="${DIR_A}"][data-session="${SESS_A}"]`,
    );
    await expect(tabA).toHaveCount(1);
    await tabA.click();

    // The select round-tripped: the pane's route now points at sess-a.
    const wantRouteA = `?dir=${encodeURIComponent(DIR_A)}&session=${SESS_A}`;
    await expect
      .poll(
        async () => {
          const params = await H.paneParams(page);
          return params.find((p) => p.id === pane)?.route ?? null;
        },
        { timeout: 5000 },
      )
      .toBe(wantRouteA);

    // The active target is now sess-a.
    await expect.poll(async () => H.activeTarget(page)).toEqual({
      serverId: MOCK_ORIGIN,
      dir: DIR_A,
      session: SESS_A,
    });

    // CRUX — SURVIVAL: the tab click was a selectTarget = SPA-internal route
    // change; the iframe element/src were NEVER touched. Identity UNCHANGED.
    await H.assertSurvived(page, pane, before, "tab click switch");
  });

  // --------------------------------------------------------------------------
  // 3. HONEST STATUS (CRUX #2)
  // --------------------------------------------------------------------------

  test("honest status: live target shows needs-you; navigated-away target is stale (no badge)", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const DIR = "/proj-honest";

    // Visit target A, then send a needs_permission status for it → A is live
    // with a needs-you badge.
    await H.selectTarget(page, pane, DIR, "sess-live");
    await H.waitForTargetCount(page, 1);

    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: DIR,
        session: "sess-live",
        title: "Live",
        attention: "needs_permission",
        activity: "idle",
      },
    });

    // Wait for the live status to land on the record.
    await expect
      .poll(
        async () => {
          const r = (await H.targets(page)).find(
            (t) => t.dir === DIR && t.session === "sess-live",
          );
          return r?.liveStatus?.attention ?? null;
        },
        { timeout: 5000 },
      )
      .toBe("needs_permission");

    // The tab is LIVE and shows the needs-you badge in the DOM.
    const tabLive = page.locator(
      `[data-testid="target-tab"][data-session="sess-live"]`,
    );
    await expect(tabLive).toHaveAttribute("data-live", "1");
    await expect(tabLive.locator('[data-testid="target-needs-you"]')).toHaveCount(1);

    // Now navigate the SAME pane to target B (a different session). The pane
    // is no longer reporting A → A goes STALE.
    await H.selectTarget(page, pane, DIR, "sess-gone");
    await H.waitForTargetCount(page, 2);

    // Send a status for B (so B becomes the live target). The pane's status
    // bridge now reports (DIR, sess-gone); applyLiveStatus flips liveness.
    // attention must be a valid Attention ("none" — not "idle", which is an
    // Activity; the router rejects out-of-vocabulary attention values).
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: DIR,
        session: "sess-gone",
        title: "Gone",
        attention: "none",
        activity: "idle",
      },
    });

    // CRUX #2 — HONEST STATUS: A is NO LONGER LIVE. Its tab is stale and MUST
    // NOT show a needs-you badge (even though its last-known liveStatus was
    // needs_permission). A stale target never claims current attention.
    const tabStale = page.locator(
      `[data-testid="target-tab"][data-session="sess-live"]`,
    );
    await expect.poll(async () => tabStale.getAttribute("data-live"), { timeout: 5000 }).toBe("0");
    await expect(tabStale.locator('[data-testid="target-needs-you"]')).toHaveCount(0);

    // B is the live target now; it shows no badge (its attention is "idle").
    const tabB = page.locator(
      `[data-testid="target-tab"][data-session="sess-gone"]`,
    );
    await expect(tabB).toHaveAttribute("data-live", "1");
    await expect(tabB.locator('[data-testid="target-needs-you"]')).toHaveCount(0);
  });

  // --------------------------------------------------------------------------
  // 4. CAPS — unpinned LRU-evict (20) + pinned refuse (10)
  // --------------------------------------------------------------------------

  test("unpinned cap 20 LRU-evicts the least-recently-visited on insert", async ({
    page,
  }) => {
    // Visit 21 distinct unpinned targets. The registry caps unpinned at 20 and
    // evicts the LRU (the FIRST visited — visits are most-recent-first, so the
    // earliest visit is the least-recent → evicted when the 21st inserts).
    for (let i = 0; i < 21; i++) {
      await H.visitTarget(page, MOCK_ORIGIN, `/cap-${i}`, `s-${i}`);
    }
    await H.waitForTargetCount(page, 20);

    // The FIRST visited (/cap-0/s-0) is the LRU victim → evicted.
    const recs = await H.targets(page);
    expect(
      recs.find((r) => r.dir === "/cap-0" && r.session === "s-0"),
      "LRU victim (cap-0) evicted",
    ).toBeUndefined();
    // The LAST visited (/cap-20) survives (it's the most-recent).
    expect(
      recs.find((r) => r.dir === "/cap-20" && r.session === "s-20"),
    ).toBeDefined();
  });

  test("pinned cap 10 REFUSES a new pin (no silent eviction)", async ({
    page,
  }) => {
    // Visit + pin 10 distinct targets.
    for (let i = 0; i < 10; i++) {
      await H.visitTarget(page, MOCK_ORIGIN, `/pin-${i}`, `p-${i}`);
      const ok = await H.pinTarget(page, MOCK_ORIGIN, `/pin-${i}`, `p-${i}`);
      expect(ok, `pin ${i} accepted`).toBe(true);
    }
    // Visit an 11th target and try to pin it → REFUSED (returns false).
    await H.visitTarget(page, MOCK_ORIGIN, "/pin-10", "p-10");
    const refused = await H.pinTarget(page, MOCK_ORIGIN, "/pin-10", "p-10");
    expect(refused, "11th pin refused at cap 10").toBe(false);

    // All 10 existing pins SURVIVE (no silent eviction). The 11th record stays
    // unpinned (it was visited but the pin was refused).
    const recs = await H.targets(page);
    const pinned = recs.filter((r) => r.pinned);
    expect(pinned.length, "exactly 10 pins survive (no silent evict)").toBe(10);
    const unpinned11 = recs.find((r) => r.dir === "/pin-10");
    expect(unpinned11?.pinned, "11th target remained unpinned").toBe(false);
  });

  // --------------------------------------------------------------------------
  // 5. AGE RETIREMENT — >7-day-old unpinned evicted (startup + mutation)
  // --------------------------------------------------------------------------

  test("age retirement: a >7-day-old unpinned record is evicted on mutation", async ({
    page,
  }) => {
    // Visit two fresh targets A + B.
    await H.visitTarget(page, MOCK_ORIGIN, "/age-a", "s-a");
    await H.visitTarget(page, MOCK_ORIGIN, "/age-b", "s-b");
    await H.waitForTargetCount(page, 2);

    // Backdate A to 8 days ago (past the 7-day retirement threshold). Persisted.
    await H.backdateTarget(page, MOCK_ORIGIN, "/age-a", "s-a", 8);

    // Visit a 3rd target C. visit() runs retireAged() on mutation → A (aged,
    // unpinned) is evicted; B (fresh) + C (new) survive.
    await H.visitTarget(page, MOCK_ORIGIN, "/age-c", "s-c");

    const recs = await H.targets(page);
    expect(
      recs.find((r) => r.dir === "/age-a"),
      "aged record A retired on mutation",
    ).toBeUndefined();
    expect(recs.find((r) => r.dir === "/age-b")).toBeDefined();
    expect(recs.find((r) => r.dir === "/age-c")).toBeDefined();
  });

  test("age retirement: pinned records are NOT aged out (pins are exempt)", async ({
    page,
  }) => {
    // Visit + pin A, then backdate it far past 7 days. Pinned records are exempt
    // from age retirement → A survives.
    await H.visitTarget(page, MOCK_ORIGIN, "/age-pin", "s-pin");
    await H.pinTarget(page, MOCK_ORIGIN, "/age-pin", "s-pin");
    await H.backdateTarget(page, MOCK_ORIGIN, "/age-pin", "s-pin", 30);

    // A mutation triggers retireAged — but A is pinned, so it stays.
    await H.visitTarget(page, MOCK_ORIGIN, "/age-fresh", "s-fresh");
    const recs = await H.targets(page);
    const pinned = recs.find((r) => r.dir === "/age-pin");
    expect(pinned, "pinned record NOT aged out even at 30 days").toBeDefined();
    expect(pinned?.pinned).toBe(true);
  });

  // --------------------------------------------------------------------------
  // DISMISS (mechanic; UI is Phase 3)
  // --------------------------------------------------------------------------

  test("dismiss removes a record without affecting its pane", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    await H.selectTarget(page, pane, "/dismiss", "s-d");
    await H.waitForTargetCount(page, 1);

    // The pane is alive before dismiss.
    const before = (await H.survival(page, pane))!;

    await H.dismissTarget(page, MOCK_ORIGIN, "/dismiss", "s-d");
    await H.waitForTargetCount(page, 0);

    // CRUX: dismissing a tab does NOT close its pane/session (it's a registry
    // record, not a pane lifecycle). The pane's iframe SURVIVED.
    await H.assertSurvived(page, pane, before, "dismiss does not close the pane");
  });
});

// =============================================================================
// COLD-LOAD retirement (separate — no describe beforeEach; uses addInitScript
// to seed localStorage BEFORE the page's first paint so coldLoad() reads the
// aged blob at module init). This is the canonical Playwright pattern for
// "set persisted state before the app boots."
// =============================================================================

test("cold-load retirement: a >7-day-old unpinned record is evicted at startup", async ({
  page,
}) => {
  const now = Date.now();
  const blob = JSON.stringify({
    v: 1,
    records: [
      {
        target: { serverId: MOCK_ORIGIN, dir: "/cold-aged", session: "s" },
        title: "Aged",
        lastVisitedAt: now - 8 * DAY_MS,
        pinned: false,
      },
      {
        target: { serverId: MOCK_ORIGIN, dir: "/cold-fresh", session: "s" },
        title: "Fresh",
        lastVisitedAt: now - 1 * DAY_MS,
        pinned: false,
      },
    ],
  });

  // addInitScript writes localStorage BEFORE any page script runs, so the
  // targetRegistry's module-init coldLoad() reads this blob. coldLoad calls
  // retireAged() → the aged record is evicted, the fresh one survives.
  await page.addInitScript((blob) => {
    try {
      localStorage.setItem("vh-host:targets:v1", blob);
    } catch {
      // swallow (private mode / quota)
    }
  }, blob);

  await page.goto("/");
  // The registry is populated at module init (before heartbeats). Poll for the
  // fresh record — its presence proves coldLoad read the blob + retired the
  // aged one.
  await expect
    .poll(
      async () => (await H.targets(page)).some((r) => r.dir === "/cold-fresh"),
      { timeout: 20000 },
    )
    .toBe(true);

  const recs = await H.targets(page);
  expect(
    recs.find((r) => r.dir === "/cold-aged"),
    "aged record retired at cold startup",
  ).toBeUndefined();
  expect(
    recs.find((r) => r.dir === "/cold-fresh"),
    "fresh record survived cold startup",
  ).toBeDefined();
});
