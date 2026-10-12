import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// App-like back semantics (lib/backStack.ts + Part A replaceState routing):
// browser back dismisses the TOPMOST open surface and NEVER walks session
// selection; forward never reopens; explicit closes leave no ghost entries.
//
// The ONE documented carve-out (the compat tail, pinned by the last test
// below): a popstate onto a LEGACY session entry — pushed by an older build
// (modern selection is replaceState-only) — still re-selects the session and
// switches project (sync.ts's legacy-walk handler).
//
// Every test keeps at least one surface open (or asserts history.length
// directly) before pressing back, so back never falls out of the app to the
// initial about:blank entry — the empty-stack case intentionally falls through
// to native behavior (no exit trapping, by design).

const settingsDialog = (page: import("@playwright/test").Page) =>
  page.locator('div[role="dialog"][aria-label="Settings"]');

async function selectDemoSession(page: import("@playwright/test").Page) {
  await page.locator(".tree-node", { hasText: "Demo session" }).first().click();
  await expect(page).toHaveURL(/[?&]session=demo/);
  await expect(page.locator(".main-title")).toContainText("Demo session", { timeout: 8000 });
}

test("back dismisses the topmost dialog without changing the session", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await selectDemoSession(page);

  await page.locator('button[aria-label="Settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();

  await page.goBack();

  // The dialog is dismissed…
  await expect(settingsDialog(page)).toBeHidden();
  // …and the session is UNTOUCHED (back never walks session selection).
  await expect(page.locator(".main-title")).toContainText("Demo session");
  await expect(page).toHaveURL(/[?&]session=demo/);
});

test("back unwinds stacked surfaces LIFO (topmost first)", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await selectDemoSession(page);

  // Surface 1: leave chat for the Changes view (view-swap token).
  await page.getByRole("button", { name: "Changes" }).click();
  await expect(page.locator(".main-title")).toHaveText("Changes");

  // Surface 2: the Settings dialog on top of it.
  await page.locator('button[aria-label="Settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();

  // Back #1 dismisses ONLY the topmost surface (the dialog); the Changes view
  // underneath survives.
  await page.goBack();
  await expect(settingsDialog(page)).toBeHidden();
  await expect(page.locator(".main-title")).toHaveText("Changes");

  // Back #2 unwinds the view swap back to chat — same session, same URL.
  await page.goBack();
  await expect(page.locator(".main-title")).toContainText("Demo session");
  await expect(page).toHaveURL(/[?&]session=demo/);
});

test("view swap: back returns to chat with the session intact", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await selectDemoSession(page);

  await page.getByRole("button", { name: "Changes" }).click();
  await expect(page.locator(".main-title")).toHaveText("Changes");

  await page.goBack();

  await expect(page.locator(".main-title")).toContainText("Demo session");
  await expect(page).toHaveURL(/[?&]session=demo/);
});

test("session selection creates no history entries; back never revisits a prior session", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await selectDemoSession(page);

  const lenAfterDemo = await page.evaluate(() => history.length);

  // Switch sessions twice (demo → other → demo). All replaceState: the joint
  // history must not grow.
  await page.locator(".tree-node", { hasText: "Another root" }).first().click();
  await expect(page).toHaveURL(/[?&]session=other/);
  await page.locator(".tree-node", { hasText: "Demo session" }).first().click();
  await expect(page).toHaveURL(/[?&]session=demo/);
  await expect(page.locator(".main-title")).toContainText("Demo session");

  expect(await page.evaluate(() => history.length)).toBe(lenAfterDemo);

  // With a surface open, back dismisses it — it must NOT revisit "Another
  // root" (the previous selection in the old pushState discipline).
  await page.locator('button[aria-label="Settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
  await page.goBack();
  await expect(settingsDialog(page)).toBeHidden();
  await expect(page.locator(".main-title")).toContainText("Demo session");
  await expect(page).toHaveURL(/[?&]session=demo/);
});

test("forward never reopens a dismissed surface", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await selectDemoSession(page);

  await page.locator('button[aria-label="Settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();

  await page.goBack(); // dismissed by back
  await expect(settingsDialog(page)).toBeHidden();

  await page.goForward(); // lands on the dead token: strict no-op
  await expect(settingsDialog(page)).toBeHidden();
  await expect(page.locator(".main-title")).toContainText("Demo session");
});

test("explicit close consumes its entry — no ghosts left behind", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await selectDemoSession(page);

  // Open: the current history entry carries a back-stack token.
  await page.locator('button[aria-label="Settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (history.state as Record<string, unknown> | null)?.vhBack))
    .toBeTruthy();

  // Close via the dialog's own ✕ (explicit dismissal): the token entry is
  // consumed and the current state returns to the canonical session entry.
  // (history.length does NOT shrink on back — forward entries stay in joint
  // history — so the ghost check is on history.state, not length.)
  await settingsDialog(page).locator('button[aria-label="Close"]').click();
  await expect(settingsDialog(page)).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = history.state as Record<string, unknown> | null;
        return { token: s?.vhBack ?? null, session: s?.session ?? null };
      }),
      { timeout: 5000 },
    )
    .toEqual({ token: null, session: "demo" });

  // A stranded entry would make the NEXT back a silent no-op: reopening and
  // pressing back exactly once must dismiss the dialog (no ghost bounce).
  await page.locator('button[aria-label="Settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
  await page.goBack();
  await expect(settingsDialog(page)).toBeHidden();
  await expect(page.locator(".main-title")).toContainText("Demo session");
});

test("back onto a LEGACY history entry (old-build pushState) switches project through the popstate compat tail", async ({ page }) => {
  await page.goto(projectUrl("/"));

  // Seed a LEGACY entry BEHIND the present in the old-build shape: older
  // builds pushed {session, dir} entries on selection (modern selection is
  // replaceState-only — sync/url.ts), and sync.ts's popstate wiring preserves
  // the old session+project walk for exactly those tabs. NO vhBack token in
  // the state: that marker belongs to the modern back-stack manager
  // (lib/backStack.ts), which must classify this entry as a non-token and
  // NOT claim the event as a surface dismissal.
  const dirB = "/work/cc-popstate-b";
  await page.evaluate((dir) => {
    const canonical = location.href;
    const st = history.state; // the modern app's canonical entry state
    const u = new URL(location.href);
    u.searchParams.set("session", "demo");
    u.searchParams.set("dir", dir);
    history.pushState({ session: "demo", dir }, "", u); // the legacy entry
    // Step PAST it (restoring the present) so the legacy entry sits behind
    // the modern present — the operator's back lands ON the legacy entry.
    history.pushState(st, "", canonical);
  }, dirB);

  // Gesture-honest back (a real operator gesture on a pre-upgrade tab), not
  // a synthetic popstate dispatch — the entry point under test is the
  // browser-driven popstate path itself.
  await page.goBack();

  // The popstate handler switched the app to the landed entry's project:
  // dir !== projectDir() fired switchProject(dir, true) (no history re-push).
  await expect(page.locator(".proj-name")).toContainText("cc-popstate-b", { timeout: 8_000 });
  await expect(page.locator(".tree-node", { hasText: "Project: cc-popstate-b" })).toBeVisible({ timeout: 8_000 });
  await expect(page).toHaveURL(/dir=%2Fwork%2Fcc-popstate-b/);

  // …and B lands in a clean draft context (the switch's resets left nothing
  // of A behind). Minimal honest set for the ENTRY POINT: the legacy walk is
  // a compat tail, not a surface to gold-plate.
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.locator(".composer")).toBeVisible();
  await expect(page.locator(".sendStatusLine")).toHaveCount(0);
});
