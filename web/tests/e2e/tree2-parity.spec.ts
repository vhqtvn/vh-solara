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

// ─── pins re-expand (c_F1, re-expressed under the render-gate model) ──────────
// Bug c_F1 (the protectedIds pin-parity hook): collapsing a parent that has a
// PINNED descendant kept the descendant resident in the flat map, and the OLD
// onToggle ("has resident children → collapse") was ALWAYS true → the user could
// collapse but could NEVER re-expand (stuck). The OLD test asserted a re-expand
// FIRED GET /vh/tree/children?id=demo (proving the expand branch ran at all).
//
// NEW MODEL (render gate, flood fix): collapse no longer drops descendants or
// flips loaded:false — it only hides them from RENDER (a UI toggle). So the
// pinned descendant STAYS resident, and re-expanding is INSTANT with NO server
// round-trip. The crux therefore FLIPS: a re-expand must NOT fire a fetch (the
// child is already in the map). The first expand (cold: child not resident)
// DOES fetch; the re-expand (child resident) does NOT — that contrast is the
// proof that the new model is a render gate, not a fetch-collapse.
test("(pins) re-expanding a parent with a resident pinned descendant does NOT refetch (c_F1, render-gate)", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  // Count /vh/tree/children?id=demo requests across the whole test.
  const childrenReqs: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/vh/tree/children") && url.includes("id=demo")) childrenReqs.push(url);
  });

  const demoRow = page.locator(".tree-row", { hasText: "Demo session" });

  // FIRST expand: demo's child `sub` is NOT resident at cold load (demo is a
  // collapsed root), so this MUST fetch. sub arrives and renders in the body.
  await demoRow.locator(".tree-twisty").click();
  const subInTree = page.locator(`.tree-node.sub[data-session-id="sub"]`);
  await expect(subInTree).toBeVisible({ timeout: 8000 });
  await expect.poll(() => childrenReqs.length).toBeGreaterThan(0); // cold expand fetched
  const firstExpandReqs = childrenReqs.length;

  // Pin sub → hoisted into .tree-pinned (built from the flat map), dedup'd
  // from the tree body.
  await subInTree.click({ button: "right" });
  await expect(page.locator(".ctxm-menu")).toBeVisible();
  await page.locator(".ctxm-item", { hasText: "Pin to top" }).click();
  const pinnedSub = page.locator(`.tree-pinned .tree-node[data-session-id="sub"]`);
  await expect(pinnedSub).toBeVisible({ timeout: 5000 });

  // COLLAPSE demo. Under the render-gate model this is setUserNodeExpanded
  // (UI state) ONLY — sub STAYS resident in the flat map and STAYS hoisted in
  // .tree-pinned (the c_F1 pin-survives-collapse invariant).
  await demoRow.locator(".tree-twisty").click(); // collapse
  await expect(pinnedSub).toBeVisible(); // protected descendant survives

  // RE-EXPAND demo. CRUX: sub is ALREADY resident (the collapse was render-
  // only), so NO /vh/tree/children fetch fires. (Under the OLD fetch-collapse
  // model, collapse dropped sub + flipped loaded:false, so re-expand HAD to
  // refetch — that is what the old test asserted.) Contrast: firstExpandReqs>0
  // but the re-expand adds 0.
  await demoRow.locator(".tree-twisty").click(); // re-expand (the crux)
  // Give a buggy refetch a window to fire, then assert none did.
  await page.waitForTimeout(1500);
  expect(childrenReqs.length).toBe(firstExpandReqs); // NO new fetch

  // sub remains pinned (and still hoisted) after the round-trip.
  await expect(pinnedSub).toBeVisible();
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
