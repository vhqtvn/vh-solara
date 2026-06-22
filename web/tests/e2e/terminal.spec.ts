import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Repo root — a real directory, so the PTY can actually spawn a shell. (The
// fixture's own project dir hosts the fake sessions, but the terminal needs a
// real on-disk dir; these are orthogonal.)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function termList(page: import("@playwright/test").Page, dir: string) {
  return page.evaluate(async (d) => {
    const r = await fetch(`/vh/term/list?dir=${encodeURIComponent(d)}`);
    return r.ok ? ((await r.json()) as Array<{ id: string }>) : [];
  }, dir);
}

test("terminal tabs: separate shells, add, switch, and per-tab kill", async ({ page }) => {
  await page.goto(`/?dir=${encodeURIComponent(repoRoot)}`);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForSelector(".term-host");
  await page.waitForSelector(".term-status.open", { timeout: 10000 });

  // Starts with a single shared tab.
  await expect(page.locator(".term-tab")).toHaveCount(1);

  // Write a marker into the shared shell.
  await page.locator(".term-host").click();
  await page.keyboard.type("echo TAB_SHARED");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  // Add a second shell → 2 tabs, and it's a FRESH shell (no shared marker).
  await page.getByRole("button", { name: "New terminal" }).click();
  await expect(page.locator(".term-tab")).toHaveCount(2);
  await page.waitForSelector(".term-status.open", { timeout: 10000 });
  await page.locator(".term-host").click();
  await page.keyboard.type("echo TAB_SECOND");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await expect.poll(async () => (await page.locator(".xterm-rows").innerText()).includes("TAB_SECOND")).toBe(true);
  expect(await page.locator(".xterm-rows").innerText()).not.toContain("TAB_SHARED");

  // The server reports two independent terminals for this dir.
  await expect.poll(async () => (await termList(page, repoRoot)).map((t) => t.id).sort()).toEqual(
    expect.arrayContaining(["shared"]),
  );
  const ids = (await termList(page, repoRoot)).map((t) => t.id);
  expect(ids.length).toBe(2);
  expect(ids).toContain("shared");
  expect(ids.some((i) => i.startsWith("t:"))).toBe(true);

  // Kill the second tab via its × → tab drops AND the server PTY is gone.
  await page.locator(".term-tab").nth(1).locator(".term-tab-kill").click();
  await expect(page.locator(".term-tab")).toHaveCount(1);
  await expect.poll(async () => (await termList(page, repoRoot)).map((t) => t.id)).toEqual(["shared"]);
});

test("terminal: a session-bound tab can be opened for the selected session", async ({ page }) => {
  await page.goto("/"); // fixture's own project → has sessions to select
  await page.locator(".tree-node").first().click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForSelector(".term-dock");

  // The "session" bind control appears once a session is selected; clicking it
  // adds a second tab (the session terminal) and makes it active.
  const bind = page.getByRole("button", { name: "Terminal for current session" });
  await expect(bind).toBeVisible();
  const before = await page.locator(".term-tab").count();
  await bind.click();
  await expect(page.locator(".term-tab")).toHaveCount(before + 1);
  // The new tab is selected (a session terminal).
  await expect(page.locator(".term-tab.on")).toHaveCount(1);
});
