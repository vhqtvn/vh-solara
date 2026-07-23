import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Phase 3 parity — PINS + SEARCH restored on the tree=2 thin client.
//
// These specs prove the two features the deleted proj=1 client had are back on
// the tree=2 render path, with the OLD roots-only bug fixed:
//   (pins)   a pinned NON-ROOT session (sub, under demo) is hoisted into a
//            .tree-pinned group built from the flat map — REGARDLESS of the
//            parent's expand/collapse state — and is NOT duplicated in its tree
//            position (dedup). The old proj=1 client built the pinned group from
//            roots() only, so a pinned child vanished.
//   (search) the search input filters the rendered tree to a flat match list;
//            a non-matching root disappears, and the empty state renders.
//
// Pin is a CLIENT preference (sidebar.ts localStorage vh.pinned.v1) — it never
// touches the server fixture, so these tests do not perturb the shared serial
// fixture state the other specs rely on.

// Mirrors tree2-symptoms.spec.ts: wait for the tree to populate (at least one
// .tree-row) and for no spinners (no busy sessions) before asserting.
async function waitForTreeSettled(page: import("@playwright/test").Page) {
  await expect(page.locator(".tree-row").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".tree-spinner")).toHaveCount(0, { timeout: 10000 });
}

// ─── pins ────────────────────────────────────────────────────────────────────
test("(pins) a pinned NON-ROOT session is hoisted to the pinned group and dedup'd from the tree", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  // Expand demo so its child `sub` renders in the tree (the pre-pin position).
  const demoRow = page.locator(".tree-row", { hasText: "Demo session" });
  await demoRow.locator(".tree-twisty").click();
  const subInTree = page.locator(`.tree-node.sub[data-session-id="sub"]`);
  await expect(subInTree).toBeVisible({ timeout: 8000 });

  // Pin the NON-ROOT child via its context menu (SessionContextMenu "Pin to top").
  await subInTree.click({ button: "right" });
  await expect(page.locator(".ctxm-menu")).toBeVisible();
  await page.locator(".ctxm-item", { hasText: "Pin to top" }).click();

  // CRUX: `sub` now appears in the .tree-pinned group (hoisted from the flat
  // map), even though it is a depth-1 child — the old proj=1 client only pinned
  // roots and would have dropped it.
  const pinnedSub = page.locator(`.tree-pinned .tree-node[data-session-id="sub"]`);
  await expect(pinnedSub).toBeVisible({ timeout: 5000 });

  // Dedup: `sub` is NOT also rendered in its natural tree position. There must
  // be exactly ONE row for sub, and it lives inside .tree-pinned.
  await expect(page.locator(`.tree-node[data-session-id="sub"]`)).toHaveCount(1);
  await expect(page.locator(`.tree-node.sub[data-session-id="sub"]`)).toHaveCount(0);

  // The hoist is independent of the parent's expand/collapse state: collapse
  // demo, and `sub` stays pinned (visible in .tree-pinned). This proves the
  // pinned group is built from the flat map, not from expanded children.
  await demoRow.locator(".tree-twisty").click(); // collapse demo
  await expect(pinnedSub).toBeVisible();
  // And demo's collapsed children (sub) never reappear in the tree body.
  await expect(page.locator(`.tree-node[data-session-id="sub"]:not(.tree-pinned *)`)).toHaveCount(0);
});

// ─── search ──────────────────────────────────────────────────────────────────
test("(search) filters the tree to a flat match list and renders the empty state", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  // Open the search input (header filter toggle) and type a query that matches
  // exactly one seeded root ("Another root" → the `other` session).
  await page.getByRole("button", { name: "Search sessions" }).click();
  const input = page.locator(".session-search-input");
  await expect(input).toBeVisible();
  await input.fill("Another");

  // The tree is replaced by a flat match list: `other` is visible, and a
  // non-matching root (`demo`) is filtered OUT (no longer rendered).
  await expect(page.locator(`.tree-node[data-session-id="other"]`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`.tree-node[data-session-id="demo"]`)).toHaveCount(0);

  // Clearing the query restores the normal tree (demo reappears as a root).
  await input.fill("");
  await expect(page.locator(`.tree-node[data-session-id="demo"]`)).toBeVisible({ timeout: 5000 });

  // A query matching nothing renders the empty state (old proj=1 "No matches").
  await input.fill("zzzznotasession");
  await expect(page.locator(".tree-empty")).toContainText("No matches");
  await expect(page.locator(".tree-row")).toHaveCount(0);
});
