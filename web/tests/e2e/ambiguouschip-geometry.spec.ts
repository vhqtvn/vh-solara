// AmbiguousChip geometry spec (defer-e2e-ambiguouschip-geometry-spec, W1
// item 6; closes the 225b5cd clamp-coverage defers — which named the WARNING
// clamp specifically: "normal warning fits unclamped at 400x600", "chip
// height bounded… warning still fully readable", "e-ink paging toolbar
// remains usable". The sibling .stale 3em clamp from the same commit is NOT
// exercised here; if it ever needs a geometry receipt it is its own
// obligation, not a claim of this spec.)
//
// WHAT THIS PINS, at the borderline e-ink viewport 400×600 (the geometry the
// max-height defense was built for — defer-scroll-follow-1943):
//   1. the BINDING verbatim warning note spans the chip's full content width
//      (flex-basis:100% — the .queue-detail-note idiom that prevents the 1ch
//      min-content collapse),
//   2. the clamp is IDLE in the normal case (the ~170-char note fits under
//      the 6em/4-line bound — no scrollable overflow),
//   3. under forced font-metric variance (test-injected 40px font on the
//      note) the clamp ENGAGES: the note is bounded to 6em, scrolls (still
//      readable, never tooltip-only), and the chip's total height stays
//      bounded, and
//   4. the e-ink paging toolbar's [data-eink="prev-page"] stays REALLY
//      clickable with the armed chip present (an enabled no-op at the extent
//      BY CONTRACT — ChatPagingControls.tsx:24-26 — so the real click is the
//      reachability receipt, not a state change).
//
// ARMING without Go changes (HZ-GEO-SPEC-GO-Boundary): projection mode is
// simulated by route interception exactly as send-outbox-resilience.spec.ts
// test D — /vh/version advertises daemonDispatchCapable, claim/resolve get
// 409 queue_custody_active, and the LIST rewrite marks the ORIGINAL item
// {unknown, reconcileTerminal, ambiguousDelivery} once its id is captured.
// Zero Go diff: pkg/fixtures/opencode.go is W2-held and untouched.
//
// Hygiene: part of the serial suite over the shared fixtureserver; queue
// state is owned + cleaned per test via the real queue API (the
// send-outbox-resilience cleanQueue pattern).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

const SID = "demo";

function apiUrl(suffix = ""): string {
  return `/vh/session/${SID}/queue${suffix}?dir=${encodeURIComponent(demoDir)}`;
}

async function listQueue(request: APIRequestContext): Promise<Array<{ id: string; state: string }>> {
  const res = await request.get(apiUrl());
  if (!res.ok()) return [];
  const j: any = await res.json().catch(() => ({}));
  return Array.isArray(j.items) ? j.items : [];
}

/** Remove every queue item this spec admits (and any leftover from a prior
 *  crashed run) — send-outbox-resilience's cleanQueue shape: DELETE carries
 *  the CSRF header (state-changing /vh/* requires it), ids are encoded, and
 *  the 45s retry outlasts the daemon's ~30s stale-dispatch threshold so a
 *  crashed prior run's `dispatching` item still self-heals. Bounded: never
 *  wedges the serial suite. */
async function cleanQueue(request: APIRequestContext): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const items = await listQueue(request);
    if (items.length === 0) return;
    let stuck = false;
    for (const it of items) {
      const del = await request.delete(apiUrl(`/${encodeURIComponent(it.id)}`), {
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      });
      if (!del.ok()) stuck = true;
    }
    if (!stuck) return;
    if (Date.now() > deadline) return; // bounded: never wedge the suite
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Projection-mode arming (test D's shape, parameterless): installs the
 *  intercepted daemon facts, sends one REAL composer gesture, captures the
 *  admitted item id, arms the ambiguous marker, and surfaces the chip via a
 *  focus-triggered list refetch (deterministic; the ~15s poll is the
 *  fallback). Returns the chip locator once it is visibly ACTIVE. */
async function armAmbiguousChip(page: Page, request: APIRequestContext, text: string) {
  let ambiguousId: string | null = null;
  await page.route("**/vh/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "e2e-projection", daemonDispatchCapable: true }),
    }),
  );
  await page.route(`**/vh/session/${SID}/queue/claim*`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "queue custody active", code: "queue_custody_active" }),
    }),
  );
  await page.route(`**/vh/session/${SID}/queue/*/resolve*`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "queue custody active", code: "queue_custody_active" }),
    }),
  );
  // The SPA's queue URLs carry NO query (the project dir travels in the
  // x-opencode-directory header), so match the LIST endpoint by predicate —
  // never claim/resolve sub-paths.
  const isQueueListUrl = (url: URL) => /\/vh\/session\/demo\/queue(\?.*)?$/.test(url.href);
  await page.route(isQueueListUrl, async (route) => {
    if (route.request().method() === "GET") {
      const res = await route.fetch();
      const j: any = await res.json();
      if (Array.isArray(j.items)) {
        for (const it of j.items) {
          if (ambiguousId && it.id === ambiguousId && it.state !== "sent") {
            it.state = "unknown";
            it.reconcileTerminal = true;
            it.ambiguousDelivery = true;
            it.detail = "journal-aware ambiguous-wait (e2e simulated)";
          }
        }
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    }
    return route.continue();
  });

  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10_000 });
  const composer = page.getByPlaceholder("Message…");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.locator(".queue-chip", { hasText: text })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await listQueue(request)).length, { timeout: 5_000 }).toBe(1);
  ambiguousId = (await listQueue(request))[0].id;
  // Deterministic arming: a focus event refetches the list NOW (the poll
  // would also catch it; focus is immediate).
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const chip = page.getByTestId("ambiguous-chip");
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toHaveAttribute("data-state", "active");
  return chip;
}

/** All geometry numbers the assertions consume, read in ONE evaluate so the
 *  measurements are a consistent DOM snapshot. */
async function chipGeometry(page: Page) {
  return page.evaluate(() => {
    const chip = document.querySelector('[data-testid="ambiguous-chip"]') as HTMLElement;
    const warn = document.querySelector('[data-testid="ambiguous-warning"]') as HTMLElement;
    const prev = document.querySelector('[data-eink="prev-page"]') as HTMLElement;
    const chipR = chip.getBoundingClientRect();
    const warnR = warn.getBoundingClientRect();
    const prevR = prev.getBoundingClientRect();
    return {
      chipW: chipR.width,
      chipH: chipR.height,
      chipBottom: chipR.bottom,
      warnW: warnR.width,
      warnH: warnR.height,
      warnScrollH: warn.scrollHeight,
      warnClientH: warn.clientHeight,
      warnMaxH: parseFloat(getComputedStyle(warn).maxHeight),
      prevH: prevR.height,
      viewportH: window.innerHeight,
    };
  });
}

test.beforeEach(async ({ request }, testInfo) => {
  // The 45s cleanQueue retry (a crashed prior run's `dispatching` item needs
  // ~30s to go stale) can exceed Playwright's DEFAULT 30s test timeout, and
  // a body-level test.setTimeout cannot extend a HOOK — set the whole
  // test's budget here (send-outbox-resilience.spec.ts:180-181's pattern).
  testInfo.setTimeout(120_000);
  await cleanQueue(request);
});

test.afterEach(async ({ request }) => {
  await cleanQueue(request);
});

test("e-ink 400×600: armed chip warning spans the row, clamp idle; forced font-metric variance engages the bounded scrollable clamp; paging toolbar stays clickable", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  // Boot the e-ink profile via its saved preference (the manual activation
  // path — the established boot idiom) BEFORE any app script.
  await page.addInitScript(() => {
    localStorage.setItem("vh.prefs.einkProfile.v1", JSON.stringify({ v: 1, data: true }));
  });
  await page.setViewportSize({ width: 400, height: 600 });

  const chip = await armAmbiguousChip(page, request, "ambiguous geometry probe");

  // The e-ink paging toolbar is mounted at this viewport (profile ON,
  // narrow): the geometry this spec defends lives WITH it present.
  await expect(page.locator('[data-eink="paging"]')).toBeVisible();

  // --- Phase 1: the normal case ------------------------------------------------
  const g1 = await chipGeometry(page);

  // (1) The warning note spans the chip's full CONTENT width (flex-basis:100%
  //     inside .ambiguousChip's 3px 8px padding → expected ≈ chipW − 16).
  expect(g1.warnW).toBeGreaterThanOrEqual(g1.chipW - 18);
  expect(g1.warnW).toBeLessThanOrEqual(g1.chipW - 14);

  // (2) Clamp IDLE: the ~170-char verbatim note fits under the 6em bound —
  //     no scrollable overflow (scrollHeight === clientHeight), height at or
  //     under the 4-line bound.
  expect(g1.warnMaxH).toBeGreaterThan(0);
  expect(g1.warnScrollH).toBe(g1.warnClientH);
  expect(g1.warnH).toBeLessThanOrEqual(g1.warnMaxH);
  // Chip total height bounded in the normal case (~3 lines of note).
  expect(g1.chipH).toBeLessThanOrEqual(170);
  // The chip stays inside the viewport (composer column, above the fold).
  expect(g1.chipBottom).toBeLessThanOrEqual(g1.viewportH);

  // (4a) REAL click receipt: prev-page is an enabled no-op at the extent BY
  //      CONTRACT — a real click with the armed chip present proves the
  //      toolbar is not buried (Playwright actionability would time out if
  //      the chip or its scroll covered it).
  await page.locator('[data-eink="prev-page"]').click();

  // --- Phase 2: forced font-metric variance → clamp ENGAGES ---------------------
  // Test-injected 40px font on the note simulates the variance the clamp
  // exists for (the note text itself is a hardcoded verbatim constant). 6em
  // at 40px = 240px: the wrapped content (~9 lines × 60px) now far exceeds
  // the bound.
  await page.addStyleTag({
    content: '[data-testid="ambiguous-warning"] { font-size: 40px !important; }',
  });
  await expect(page.getByTestId("ambiguous-warning")).toBeVisible();

  const g2 = await chipGeometry(page);

  // (3a) The clamp ENGAGED: the note's visible box is pinned at the 6em
  //      bound (240px at this font) while its content genuinely exceeds it.
  expect(g2.warnMaxH).toBeGreaterThanOrEqual(240);
  expect(Math.abs(g2.warnClientH - Math.min(g2.warnMaxH, 240))).toBeLessThanOrEqual(2);
  expect(g2.warnScrollH).toBeGreaterThanOrEqual(g2.warnClientH + 150);

  // (3b) Still readable: a REAL wheel gesture over the clamped note scrolls
  //      it (overflow-y:auto on the user input path — not just a
  //      programmatic scrollTop assignment).
  const wheelScrolled = await page.evaluate(() => {
    const warn = document.querySelector('[data-testid="ambiguous-warning"]') as HTMLElement;
    return { top: warn.getBoundingClientRect().top, left: warn.getBoundingClientRect().left };
  });
  await page.mouse.move(wheelScrolled.left + 30, wheelScrolled.top + 30);
  await page.mouse.wheel(0, 120);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const warn = document.querySelector('[data-testid="ambiguous-warning"]') as HTMLElement;
          return warn.scrollTop;
        }),
      { timeout: 3_000 },
    )
    .toBeGreaterThan(0);

  // (3c) The chip's total height stays bounded with the clamp engaged —
  //      the defense's purpose: a degenerate note can never grow the queue
  //      row without limit.
  expect(g2.chipH).toBeLessThanOrEqual(380);
  expect(g2.chipBottom).toBeLessThanOrEqual(g2.viewportH);

  // Key actions remain reachable with the clamp engaged (Wait + Send-new).
  await expect(page.getByTestId("ambiguous-wait")).toBeVisible();
  await expect(page.getByTestId("ambiguous-replace")).toBeVisible();

  // (4b) The paging toolbar remains REALLY clickable after engagement too.
  await page.locator('[data-eink="prev-page"]').click();

  // The chip is still the ACTIVE ambiguous chip throughout (no state drift
  // from the clicks — prev-page preserves mode by contract).
  await expect(chip).toHaveAttribute("data-state", "active");
});
