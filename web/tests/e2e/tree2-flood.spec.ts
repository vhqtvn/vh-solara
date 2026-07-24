import { expect, test, type Page } from "@playwright/test";
import { projectUrl } from "./util";

// tree2-flood — the sidebar "flood" e2e against the REAL seeded fixture.
//
// BEFORE the fix, an active (loaded) parent dumped ALL its resident children
// into the sidebar (TreeBranch rendered treeChildrenOf unconditionally). AFTER
// the render-gate fix, an idle root renders COLLAPSED by default (▸ N twisty)
// even once its children become resident; collapsing a user-expanded parent
// HIDES its children from render while they stay resident (instant re-expand,
// no refetch).
//
// The DETERMINISTIC crux — controls N resident children directly in the flat map
// (no SSE timing, no frontier gate) — lives in tests/unit/tree2Flood.test.tsx.
// That is the primary flood coverage: it asserts an idle loaded root with 8
// resident children renders as 1 row (not 9), user-expand renders all with NO
// fetch, user-collapse keeps them resident, and active-path auto-expand.
//
// Why this spec uses the seeded demo→sub pair instead of forking N children:
// the fork approach (POST /session/demo/fork) was implemented and the fork POST
// succeeds, but the forked ses_fork%d children did not reliably ship RESIDENT
// (node.upsert) to the client within the assertion window. The §5.4 frontier
// gate ships a child resident only if its parent is in the connection's
// expanded set (e.c) at fork time; coordinating expand→fork→SSE-arrival against
// the SERIAL shared mutable fixture proved timing-fragile. The seeded demo→sub
// pair exercises the SAME render-gate contract (default-collapsed, collapse
// hides resident child, re-expand needs no refetch) deterministically, so this
// spec carries real-browser confidence without the fork's SSE fragility.

async function waitForTreeSettled(page: Page): Promise<void> {
  await expect(page.locator(".tree-row").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".tree-spinner")).toHaveCount(0, { timeout: 10000 });
}

test("(flood) an idle root renders collapsed by default; collapse hides its resident child; re-expand needs no refetch", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  // Track /vh/tree/children?id=demo requests to assert the no-refetch crux.
  const childrenReqs: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/vh/tree/children") && url.includes("id=demo")) childrenReqs.push(url);
  });

  const demoRow = page.locator(".tree-row", { hasText: "Demo session" });
  const subRow = page.locator(`.tree-node.sub[data-session-id="sub"]`);

  // HEADLINE (flood): at cold load, demo (an idle root) renders COLLAPSED — it
  // does NOT flood its child `sub` into the sidebar. demo shows the Expand
  // twisty and sub is NOT rendered. (sub is not resident yet — §5 ships an idle
  // root's children only after an expand fetch — so it renders nothing here.)
  await expect(demoRow.locator(".tree-twisty[aria-label='Expand']")).toBeVisible();
  await expect(subRow).toHaveCount(0);

  // Expand demo (cold: sub is not resident → this fetches it). demo is now
  // userExpanded, so its resident children render.
  await demoRow.locator(".tree-twisty").click();
  await expect(subRow).toBeVisible({ timeout: 8000 });
  const afterExpandReqs = childrenReqs.length;
  expect(afterExpandReqs).toBeGreaterThan(0); // the cold expand fetched

  // COLLAPSE demo → sub DISAPPEARS from render (the flood is gated off), even
  // though it REMAINS resident in the flat map. demo shows Expand again.
  await demoRow.locator(".tree-twisty").click(); // collapse
  await expect(subRow).toHaveCount(0, { timeout: 5000 });
  await expect(demoRow.locator(".tree-twisty[aria-label='Expand']")).toBeVisible();

  // RE-EXPAND demo → sub REAPPEARS, and because it stayed resident through the
  // render-collapse, NO /vh/tree/children fetch fires. (Under the OLD
  // fetch-collapse model, collapse would have dropped sub + flipped loaded:false,
  // forcing a refetch on re-expand.)
  await demoRow.locator(".tree-twisty").click(); // re-expand
  await expect(subRow).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(1500); // give a buggy refetch a window to fire
  expect(childrenReqs.length).toBe(afterExpandReqs); // NO refetch — resident
});
