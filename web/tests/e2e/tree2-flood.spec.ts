import { expect, test, type Page } from "@playwright/test";
import { projectUrl } from "./util";

// tree2-flood — the sidebar "flood" e2e against the REAL seeded fixture.
//
// proj=1 4-state twisty model, STATUS-SENSITIVE (commit a6f2ac3): each node has
// a PERSISTED mode (collapsed | filtered | expanded). The ABSOLUTE invariant —
// an idle node is NEVER in "filtered" — makes the default + click cycle depend
// on working():
//   idle node, no persisted mode → materialized as explicit COLLAPSED at cold
//     load (filtered now requires working()). The idle manual click cycle is
//     2-state: collapsed|temp → expanded → collapsed (filtered is SKIPPED — an
//     idle node can never reach it).
//   working node keeps the full 3-state cycle: collapsed|temp → filtered →
//     expanded → collapsed.
// Children STAY resident in the flat map across mode toggles (instant re-expand,
// no refetch); the mode only gates RENDER:
//   collapsed — renders nothing (even working children).
//   filtered  — renders only WORKING children (idle kids hidden).
//   expanded  — renders ALL resident children, working-first.
// A filtered/expanded/temp branch that is unloaded auto-fetches its children
// ONCE on mount (lazy frontier). A COLLAPSED branch never fetches — so an idle
// root (collapsed at cold load) does NOT auto-fetch; its child is fetched on the
// first expand (collapsed → expanded), not at load.
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

test("(flood) an idle root renders collapsed by default; expand reveals its child; a collapse/re-expand round-trip needs no refetch", async ({ page }) => {
  // Attach the children-request listener BEFORE navigation. Under the status-
  // sensitive model (commit a6f2ac3), an idle root with no persisted mode is
  // materialized as explicit COLLAPSED at cold load (the absolute invariant:
  // idle nodes are never in "filtered"). A collapsed branch never auto-fetches,
  // so NO /vh/tree/children request fires at cold load — the fetch is deferred
  // to the first revealing mode (the expand click below). The old "a filtered
  // root auto-fetches its children once on mount" premise is gone.
  const childrenReqs: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/vh/tree/children") && url.includes("id=demo")) childrenReqs.push(url);
  });

  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  const demoRow = page.locator(".tree-row", { hasText: "Demo session" });
  const subRow = page.locator(`.tree-node.sub[data-session-id="sub"]`);

  // HEADLINE (flood): at cold load, demo (an idle root) is COLLAPSED — the new
  // default for idle nodes (filtered requires working()). Collapsed renders
  // NOTHING, even working children, so the idle sub is hidden. demo shows the
  // Expand twisty (every mode except "expanded" does).
  await expect(demoRow.locator(".tree-twisty[aria-label='Expand']")).toBeVisible();
  await expect(subRow).toHaveCount(0);

  // Collapsed never fetches: confirm NO /vh/tree/children request has fired at
  // cold load (the inverted premise — the old filtered-root auto-fetch is gone
  // because an idle root is collapsed, and collapsed never fetches).
  await page.waitForTimeout(500); // give a cold fetch a window to (not) fire
  expect(childrenReqs.length).toBe(0);

  // Click the twisty: collapsed → expanded (idle nodes SKIP filtered — the
  // 2-state cycle). demo is now expanded + unloaded + has descendants → the
  // lazy frontier fires ONCE and fetches sub. sub becomes resident + visible.
  await demoRow.locator(".tree-twisty").click();
  await expect(subRow).toBeVisible({ timeout: 8000 });
  await expect.poll(() => childrenReqs.length).toBeGreaterThan(0); // the first (only) fetch
  const baselineReqs = childrenReqs.length;

  // Collapse: expanded → collapsed. sub DISAPPEARS from render (collapsed
  // renders nothing) even though it REMAINS resident in the flat map. demo
  // shows the Expand twisty.
  await demoRow.locator(".tree-twisty").click();
  await expect(subRow).toHaveCount(0, { timeout: 5000 });
  await expect(demoRow.locator(".tree-twisty[aria-label='Expand']")).toBeVisible();

  // Re-expand: collapsed → expanded (idle 2-state — filtered is SKIPPED, never
  // reachable for an idle node, so this is ONE click, not two). sub REAPPEARS
  // immediately. Because it STAYED resident through the whole round-trip (mode
  // toggles never drop the flat map, and a collapsed mode does NOT flip
  // loaded:false), NO new /vh/tree/children fetch fires — the resident
  // render-gate crux.
  await demoRow.locator(".tree-twisty").click(); // collapsed → expanded (sub reappears)
  await expect(subRow).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(1500); // give a buggy refetch a window to fire
  expect(childrenReqs.length).toBe(baselineReqs); // NO refetch — resident
});
