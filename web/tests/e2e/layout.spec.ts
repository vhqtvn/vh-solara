import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

test("sidebar collapses, persists, and exposes a resize handle (desktop)", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar-resize")).toBeAttached();

  // Toggle collapses the sidebar (desktop = collapse, not slide-over) and the
  // choice is persisted to localStorage.
  const collapsed = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("vh.sidebar.collapsed.v1") || "{}").data);
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(page.locator(".app.sidebar-collapsed")).toBeAttached();
  expect(await collapsed()).toBe(true); // persisted as a versioned envelope {v,data}

  // Expand again + persist.
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(page.locator(".app.sidebar-collapsed")).toHaveCount(0);
  expect(await collapsed()).toBe(false);
});

// Server-admin controls live in a popup opened by right-clicking / long-pressing
// the Settings button (kept out of the Servers popover and Settings dialog).
test("server admin popup can reload (rehydrate) state without restarting OpenCode", async ({ page, baseURL }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click({ button: "right" });
  const pop = page.getByRole("dialog", { name: "Server admin" });
  await expect(pop.getByRole("button", { name: /Force reload \(clear cache\)/ })).toBeVisible();
  await pop.getByRole("button", { name: /Reload server state/ }).click();
  await expect(pop.locator(".admin-ok")).toBeVisible({ timeout: 8000 });

  // CSRF: a state-changing request without the custom header is rejected…
  const blocked = await page.request.post(`${baseURL}/vh/reload`);
  expect(blocked.status()).toBe(403);
  // …and accepted with it.
  const res = await page.request.post(`${baseURL}/vh/reload`, { headers: { "X-VH-CSRF": "1" } });
  expect(res.ok()).toBeTruthy();

  // The "Restart vh server" control + endpoint are present (fixture no-op).
  await expect(pop.getByRole("button", { name: /Restart vh server/ })).toBeVisible();
  const rs = await page.request.post(`${baseURL}/vh/restart-server`, { headers: { "X-VH-CSRF": "1" } });
  expect(rs.ok()).toBeTruthy();
});

test("admin popup shows both vh-solara and OpenCode versions", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click({ button: "right" });
  const pop = page.getByRole("dialog", { name: "Server admin" });
  await expect(pop).toContainText("VHSolara");
  await expect(pop).toContainText("OpenCode");
});

// Restart OpenCode is now owned SOLELY by the update dialog (the admin menu
// just opens it). The confirmation counts running sessions across ALL workspaces
// the daemon manages, fetched on mount — so we drive it through the dialog's
// post-install state.
test("Restart OpenCode is owned by the update dialog, warns before acting, and can be cancelled", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click({ button: "right" });
  const pop = page.getByRole("dialog", { name: "Server admin" });

  // The admin menu no longer carries a standalone restart entry.
  await expect(pop.getByRole("button", { name: /^Restart OpenCode/ })).toHaveCount(0);

  // Reach a state that offers restart (done, after an install attempt).
  await pop.getByRole("button", { name: /Update OpenCode…/ }).click();
  const dlg = page.getByRole("dialog", { name: "Update OpenCode" });
  await dlg.getByRole("button", { name: /Update to 0\.2\.0/ }).click();
  await expect(dlg.locator(".ocu-ok")).toContainText("Installed", { timeout: 8000 });

  // Clicking restart shows a session-aware warning (counted across workspaces).
  await dlg.locator(".ocu-foot").getByRole("button", { name: "Restart OpenCode" }).click();
  await expect(dlg.locator(".ocu-confirm")).toContainText(/running session/, { timeout: 5000 });

  // Cancel backs out without restarting.
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg.locator(".ocu-confirm")).toHaveCount(0);
});

test("OpenCode update opens a dialog, streams the log, then offers restart", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click({ button: "right" });
  const pop = page.getByRole("dialog", { name: "Server admin" });

  // Fixture reports installed/running 0.1.0 → latest 0.2.0.
  await expect(pop).toContainText("0.2.0");

  // Opens the dedicated update dialog via the STABLE menu entry.
  await pop.getByRole("button", { name: /Update OpenCode…/ }).click();
  const dlg = page.getByRole("dialog", { name: "Update OpenCode" });
  await expect(dlg).toBeVisible();

  // Run the update from the stable install-area action slot.
  await dlg.getByRole("button", { name: /Update to 0\.2\.0/ }).click();

  // On completion the install log COLLAPSES to a compact result line (D4)…
  await expect(dlg.locator(".ocu-ok")).toContainText("Installed", { timeout: 8000 });
  await expect(dlg.locator(".ocu-log")).toHaveCount(0); // collapsed by default
  // …and is exposed on demand via the toggle.
  await dlg.getByRole("button", { name: /Show install log/ }).click();
  await expect(dlg.locator(".ocu-log")).toContainText("update complete");
  await dlg.getByRole("button", { name: /Hide install log/ }).click();
  await expect(dlg.locator(".ocu-log")).toHaveCount(0);

  // Post-update offers an explicit Restart OpenCode + Close (no auto-restart),
  // both owned by the dialog.
  await expect(dlg.locator(".ocu-foot").getByRole("button", { name: "Restart OpenCode" })).toBeVisible();
  await expect(dlg.locator(".ocu-foot").getByRole("button", { name: "Close" })).toBeVisible();
});

test("terminal dock toggles from the header", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".term-dock")).toHaveCount(0);
  await page.getByRole("button", { name: "Terminal" }).click();
  await expect(page.locator(".term-dock")).toBeVisible();
  // Default project has no real dir → the terminal needs one.
  await expect(page.locator(".term-empty")).toContainText("Open a project");
  // The key-bar toggle is in the dock header.
  await expect(page.locator(".term-dock").getByLabel("Toggle key bar")).toBeVisible();
  // Close it again.
  await page.locator(".term-dock").getByLabel("Close terminal").click();
  await expect(page.locator(".term-dock")).toHaveCount(0);
});

test("terminal header controls stay light on a light theme (dark island)", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.evaluate(() => {
    const el = document.documentElement;
    el.className = el.className.replace(/\btheme-\S+/g, "").trim();
    el.classList.add("theme-light");
    el.style.colorScheme = "light";
  });
  await page.getByRole("button", { name: "Terminal" }).click();
  // The dock pins a dark palette, so its header button text/icon must be light
  // (channels near white) — not the light theme's dark --fg, which would be
  // invisible on the dock's dark background.
  const btn = page.locator(".term-dock").getByLabel("Close terminal");
  await expect(btn).toBeVisible();
  const color = await btn.evaluate((el) => getComputedStyle(el).color);
  const m = color.match(/\d+(\.\d+)?/g)!;
  const channelSum = Number(m[0]) + Number(m[1]) + Number(m[2]);
  expect(channelSum).toBeGreaterThan(450); // light foreground, not dark-on-dark
});

test("a new server version surfaces the update toast", async ({ page }) => {
  let version = "v-1";
  await page.route("**/vh/version", (route) => route.fulfill({ json: { version } }));
  await page.goto(projectUrl("/"));
  // First poll records v-1; no toast yet.
  await expect(page.locator(".update-toast")).toHaveCount(0);
  // Server ships a new version; the next visibility-triggered check notices.
  version = "v-2";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".update-toast")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".update-toast")).toContainText("new version");
});

test("Settings → Terminals lists sessions (empty by default)", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Terminals", exact: true }).click();
  await expect(dialog).toContainText("No active terminal sessions");
});

test("the Working… indicator shows while the assistant streams", async ({ page }) => {
  await page.goto(projectUrl("/"));
  // Use a fresh session (not the shared demo) so we don't perturb other specs.
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByPlaceholder("Message…").fill("stream please");
  await page.keyboard.press("Enter");
  // The Working… shimmer appears during the streamed turn…
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 5000 });
  // …and clears once the turn completes.
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 8000 });
});
