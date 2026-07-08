import { expect, test } from "@playwright/test";

// The sidebar header must keep every control on a SINGLE line and never clip a
// button: the wordmark ("VHSolara") is the only flexible item, so it yields —
// shrinking, then being hidden entirely by a container query — while the logo
// and all buttons stay visible. (Regression guard for the mobile/touch layout
// where the larger touch targets used to squeeze the title to a "V…" sliver.)

function within(b: { x: number; y: number; width: number; height: number } | null, r: { x: number; y: number; width: number; height: number }) {
  expect(b).not.toBeNull();
  if (!b) return;
  expect(b.x).toBeGreaterThanOrEqual(r.x - 1);
  expect(b.x + b.width).toBeLessThanOrEqual(r.x + r.width + 1);
  expect(b.y + b.height).toBeLessThanOrEqual(r.y + r.height + 1);
}

test("desktop: wordmark shows at full width, all controls on one line", async ({ page }) => {
  await page.goto("/");
  const head = page.locator(".sidebar-head");
  await expect(head).toBeVisible();
  await expect(head.locator("strong")).toBeVisible();
  await expect(head.locator(".brand-mark")).toBeVisible();

  const r = (await head.boundingBox())!;
  expect(r.height).toBeLessThan(64); // single row — no wrap

  // Logo, helper, status pill and the two desktop buttons all sit inside the box.
  within(await head.locator(".brand-mark").boundingBox(), r);
  within(await head.locator(".help-inspect").boundingBox(), r);
  within(await head.locator(".status-ind").boundingBox(), r);
  for (const label of ["Search sessions", "Create session"]) {
    within(await head.getByRole("button", { name: label }).boundingBox(), r);
  }
});

test("narrow sidebar: wordmark drops, logo + buttons stay on one line", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.documentElement.style.setProperty("--sidebar-w", "200px"));
  const head = page.locator(".sidebar-head");
  await expect(head.locator("strong")).toBeHidden(); // container query hides it
  await expect(head.locator(".brand-mark")).toBeVisible(); // logo remains

  const r = (await head.boundingBox())!;
  expect(r.height).toBeLessThan(64);
  for (const label of ["Search sessions", "Create session"]) {
    const btn = head.getByRole("button", { name: label });
    await expect(btn).toBeVisible();
    within(await btn.boundingBox(), r);
  }
});

test.describe("touch / mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test("comfortable touch targets, wordmark dropped, nothing wraps or clips", async ({ page }) => {
    await page.goto("/");
    // Bring the slide-over sidebar fully on-screen (kill the slide transform so
    // measurements aren't taken mid-animation).
    await page.evaluate(() => {
      const el = document.querySelector(".sidebar") as HTMLElement | null;
      if (el) {
        el.classList.add("open");
        el.style.transition = "none";
        el.style.transform = "none";
      }
    });
    const head = page.locator(".sidebar-head");
    await expect(head.locator("strong")).toBeHidden();
    await expect(head.locator(".brand-mark")).toBeVisible();

    const r = (await head.boundingBox())!;
    expect(r.height).toBeLessThan(72); // still a single row, just taller buttons

    // search / new / close are all ~38px touch targets and fully inside the box.
    for (const label of ["Search sessions", "Create session", "Close"]) {
      const btn = head.getByRole("button", { name: label });
      const b = (await btn.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(36);
      expect(b.height).toBeGreaterThanOrEqual(36);
      within(b, r);
    }
  });
});
