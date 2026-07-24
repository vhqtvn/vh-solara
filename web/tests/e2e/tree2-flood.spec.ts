import { expect, test, type Page } from "@playwright/test";
import { projectUrl } from "./util";

// tree2-flood — the sidebar "flood" e2e against the REAL seeded fixture.
//
// proj=1 4-state twisty model (commit a7f1f93): each node has a PERSISTED mode
// (collapsed | filtered | expanded, default "filtered") and the click cycle is
// collapsed|temp → filtered → expanded → collapsed. Children STAY resident in
// the flat map across mode toggles (instant re-expand, no refetch); the mode
// only gates RENDER:
//   collapsed — renders nothing (even working children).
//   filtered  — renders only WORKING children (the default → idle kids hidden).
//   expanded  — renders ALL resident children, working-first.
// A filtered/expanded/temp branch that is unloaded auto-fetches its children
// ONCE on mount (lazy frontier) — so a cold root's idle child is fetched at load
// even though filtered mode keeps it out of the render until an expand.
//
// The DETERMINISTIC crux — controls N resident children directly in the flat map
// (no SSE timing, no frontier gate) — lives in tests/unit/tree2Flood.test.tsx.
// That is the primary flood coverage: it asserts an idle loaded root renders as
// 1 row (not 9), user-expand renders all with NO fetch, user-collapse keeps them
// resident, and active-path auto-expand. This spec carries real-browser
// confidence against the seeded demo→sub pair without that fork's SSE fragility.

async function waitForTreeSettled(page: Page): Promise<void> {
  await expect(page.locator(".tree-row").first()).toBeVisible({ timeout: 15000 });
  // The shimmering .tree-spinner is gone (proj=1 4-state model); the sole busy
  // signal is now the pulsing ring (.tree-twisty.running), so wait for no running
  // twisties as the "settled" signal.
  await expect(page.locator(".tree-twisty.running")).toHaveCount(0, { timeout: 10000 });
}

test("(flood) an idle root renders filtered by default; expand reveals its child; a collapse/re-expand round-trip needs no refetch", async ({ page }) => {
  // Attach the children-request listener BEFORE navigation so we also capture the
  // cold-load LAZY-FRONTIER fetch (a filtered root auto-fetches its children once
  // on mount). The old "cold expand fetches" premise is gone: the expand click no
  // longer fetches because the child is already resident by then.
  const childrenReqs: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/vh/tree/children") && url.includes("id=demo")) childrenReqs.push(url);
  });

  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  const demoRow = page.locator(".tree-row", { hasText: "Demo session" });
  const subRow = page.locator(`.tree-node.sub[data-session-id="sub"]`);

  // HEADLINE (flood): at cold load, demo (an idle root) is in the default
  // FILTERED mode — idle children are HIDDEN (only working children would show).
  // sub is idle, so it does NOT render. demo shows the Expand twisty (every mode
  // except "expanded" does).
  await expect(demoRow.locator(".tree-twisty[aria-label='Expand']")).toBeVisible();
  await expect(subRow).toHaveCount(0);

  // The lazy frontier auto-fetches demo's children once (filtered + unloaded +
  // has-descendants). Wait for that fetch to land so sub is RESIDENT before the
  // round-trip below — that residency is what makes the later toggles refetch-free.
  await expect.poll(() => childrenReqs.length).toBeGreaterThan(0);
  const baselineReqs = childrenReqs.length;

  // Click the twisty: filtered → expanded. sub now renders (expanded shows ALL
  // resident children, working-first). No fetch — sub is already resident.
  await demoRow.locator(".tree-twisty").click();
  await expect(subRow).toBeVisible({ timeout: 8000 });

  // Collapse: expanded → collapsed. sub DISAPPEARS from render (collapsed renders
  // nothing) even though it REMAINS resident in the flat map. demo shows Expand.
  await demoRow.locator(".tree-twisty").click();
  await expect(subRow).toHaveCount(0, { timeout: 5000 });
  await expect(demoRow.locator(".tree-twisty[aria-label='Expand']")).toBeVisible();

  // Re-expand through the cycle: collapsed → filtered (sub still hidden — idle) →
  // expanded. sub REAPPEARS only at the expanded step. Because it STAYED resident
  // through the whole round-trip (mode toggles never drop the flat map), NO new
  // /vh/tree/children fetch fires at any step — the resident render-gate crux.
  await demoRow.locator(".tree-twisty").click(); // collapsed → filtered (sub hidden)
  await expect(subRow).toHaveCount(0);
  await demoRow.locator(".tree-twisty").click(); // filtered → expanded (sub reappears)
  await expect(subRow).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(1500); // give a buggy refetch a window to fire
  expect(childrenReqs.length).toBe(baselineReqs); // NO refetch — resident
});
