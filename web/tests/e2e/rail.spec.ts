// Phase 3 S2b — the width-tier rail band (narrow host panes, 560–720 visual px).
//
// The fixture serves the SPA standalone (zoom = 1, `.app` box = viewport), so
// page.setViewportSize drives the width tier end-to-end: RO on `.app` ->
// visual-px classification -> `data-w-tier` attribute -> sidebar presentation
// (narrow drawer / rail / wide inline). The tier attribute lands ASYNC
// (RO -> rAF) — every tier assertion WAITS for the attribute rather than
// racing it. Asserts the honest seam: computed drawer/inline geometry, tree +
// chat coexisting with nonzero non-overlapping widths, the ellipsis contract
// on rail titles, the persisted sidebar width NOT being written across tier
// transitions, and the kill-switch reverting to the legacy media-query drawer.
import { expect, test } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

const RAIL = { width: 640, height: 800 };
const NARROW = { width: 500, height: 800 };
const WIDE = { width: 1280, height: 800 };
// Evidence screenshots land in the gitignored repo tmp/ (playwright CWD is
// web/, so ../tmp is the repo's tmp — NOT ../../tmp, which escapes the repo).
const EVIDENCE = "../tmp/rail-evidence";

test("rail band (640px): compact rail inline beside chat — no drawer, no persisted-width write", async ({ page }) => {
  await page.setViewportSize(RAIL);
  await page.goto(projectUrl("/"));
  // The tier attribute lands async (RO -> rAF); wait for it, don't race it.
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "rail");
  await expect(page.locator(".app")).toHaveAttribute("data-h-tier", "normal"); // both axes live

  // Inline column, not the fixed off-canvas drawer — and no scrim shadow even
  // if a stale .open class were present.
  const sb = page.locator(".sidebar");
  await expect(sb).toHaveCSS("position", "relative");
  await expect(sb).toHaveCSS("transform", "none");
  await expect(sb).toHaveCSS("box-shadow", "none");

  // Tree AND chat coexist: open the demo session FROM THE RAIL (the rail's
  // whole purpose — the tree row is visible and clickable in-band)…
  await page.locator(".tree-node[data-session-id=\"demo\"]").click();
  await expect(page.locator(".chat")).toBeVisible();
  // …then both boxes are nonzero and non-overlapping (rail | chat).
  const tree = await page.locator(".tree").boundingBox();
  const chat = await page.locator(".chat").boundingBox();
  expect(tree).toBeTruthy();
  expect(chat).toBeTruthy();
  expect(tree!.width).toBeGreaterThan(0);
  expect(chat!.width).toBeGreaterThan(0);
  expect(tree!.x + tree!.width).toBeLessThanOrEqual(chat!.x + 1);

  // Rail chrome contract: nothing to toggle (nav-toggle hidden), search +
  // tag-filter affordances compacted away, the `+` new-session affordance kept.
  await expect(page.locator(".nav-toggle")).toBeHidden();
  await expect(page.getByRole("button", { name: "Search sessions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter sessions by tags" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create session" })).toBeVisible();

  // Titles render and the truncation contract holds. A long-titled session is
  // created through the real API pair (POST /oc/session — the same call the
  // `+` button's createSession makes — then a title PATCH) so truncation is
  // deterministic; the seeded short titles alone could all happen to fit.
  // x-opencode-directory scopes the raw request to the demo project (the SPA's
  // installCsrf adds this header on its own fetches; page.request does not).
  const oc = { "X-VH-CSRF": "1", "x-opencode-directory": demoDir };
  const created = await page.request.post("/oc/session", { headers: oc, data: {} });
  expect(created.ok()).toBeTruthy();
  const sid = ((await created.json()) as { id: string }).id;
  const patched = await page.request.patch(`/oc/session/${sid}`, {
    headers: oc,
    data: { title: "Rail band truncation probe title that cannot possibly fit a one hundred sixty pixel column" },
  });
  expect(patched.ok()).toBeTruthy();
  const probeTitle = page.locator(`.tree-node[data-session-id="${sid}"] .tree-title`);
  await expect(probeTitle).toBeVisible();
  const trunc = await probeTitle.evaluate((el) => ({
    sw: el.scrollWidth,
    cw: el.clientWidth,
    te: getComputedStyle(el).textOverflow,
    ox: getComputedStyle(el).overflow,
  }));
  expect(trunc.te).toBe("ellipsis");
  expect(trunc.ox).toBe("hidden");
  expect(trunc.sw).toBeGreaterThan(trunc.cw); // actually truncated, not just styled
  // ~26px compact rows (base is ~30px via the twisty cell + padding).
  const rowH = await page.locator(`.tree-row:has(.tree-node[data-session-id="${sid}"])`).evaluate((el) => el.offsetHeight);
  expect(rowH).toBeGreaterThanOrEqual(18);
  expect(rowH).toBeLessThanOrEqual(30);

  // The persisted sidebar width is NOT written by rail mode: cross the tier
  // boundaries (rail -> narrow -> rail) and compare the stored envelope.
  const wBefore = await page.evaluate(() => localStorage.getItem("vh.sidebar.w.v1"));
  await page.setViewportSize(NARROW);
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "narrow");
  await page.setViewportSize(RAIL);
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "rail");
  const wAfter = await page.evaluate(() => localStorage.getItem("vh.sidebar.w.v1"));
  expect(wAfter).toBe(wBefore);

  // Evidence (gitignored tmp/) for the operator's visual review.
  await page.screenshot({ path: `${EVIDENCE}/rail-640x800.png` });
});

test("narrow band (500px): the legacy phone drawer, toggled by nav", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto(projectUrl("/"));
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "narrow");
  // Off-canvas fixed drawer with a visible nav toggle…
  const sb = page.locator(".sidebar");
  await expect(sb).toHaveCSS("position", "fixed");
  // Drawer width = min(--sidebar-w default 280, 86vw of 500 = 430) = 280.
  const closed = await sb.boundingBox();
  expect(Math.round(closed!.width)).toBe(280);
  await expect(page.locator(".nav-toggle")).toBeVisible();
  // …that slides it in (the .open state settles at translateX(0) after the
  // 180ms transition — wait for the settled transform, not just the class, so
  // the evidence screenshot below can't catch the slide mid-flight) with the
  // close affordance.
  await page.locator(".nav-toggle").click();
  await expect(sb).toHaveClass(/open/);
  await expect(sb).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, 0\)/);
  await expect(page.locator(".sidebar-close")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/narrow-500x800-drawer-open.png` });
});

test("wide band (1280px): inline sidebar at the persisted width", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto(projectUrl("/"));
  await expect(page.locator(".app")).toHaveAttribute("data-w-tier", "wide");
  const sb = page.locator(".sidebar");
  await expect(sb).toHaveCSS("position", "relative");
  // Fresh context -> the default persisted width (280, layout.ts).
  const box = await sb.boundingBox();
  expect(box).toBeTruthy();
  expect(Math.round(box!.width)).toBe(280);
  // Wide keeps the drag-resize affordance (rail does not).
  await expect(page.locator(".sidebar-resize")).toBeAttached();
  await page.locator(".tree-node[data-session-id=\"demo\"]").click();
  await expect(page.locator(".chat")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/wide-1280x800.png` });
});

test("kill-switch off at 640px: tier signal inert, legacy media-query drawer", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("vh.prefs.shapeTier.v1", JSON.stringify({ v: 1, data: "off" })),
  );
  await page.setViewportSize(RAIL);
  await page.goto(projectUrl("/"));
  // No attribute on EITHER axis is ever set — the module is fully inert.
  await expect(page.locator(".app[data-w-tier], .app[data-h-tier]")).toHaveCount(0);
  // 640 <= 720 and no data-w-tier -> the legacy media-query drawer applies.
  await expect(page.locator(".sidebar")).toHaveCSS("position", "fixed");
  await expect(page.locator(".nav-toggle")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/killed-640x800-legacy-drawer.png` });
});
