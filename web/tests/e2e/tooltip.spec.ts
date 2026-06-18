import { expect, test } from "@playwright/test";

// Adds a probe button with a chosen `data-tip` at fixed coordinates, hovers it,
// and returns the rendered `.tooltip` box plus the viewport width.
async function probeTip(
  page: import("@playwright/test").Page,
  tip: string,
  css: Record<string, string>,
) {
  await page.evaluate(
    ({ tip, css }) => {
      document.getElementById("tip-probe")?.remove();
      const b = document.createElement("button");
      b.id = "tip-probe";
      b.textContent = "probe";
      b.setAttribute("data-tip", tip);
      Object.assign(b.style, { position: "fixed", zIndex: "999", ...css });
      document.body.appendChild(b);
    },
    { tip, css },
  );
  await page.locator("#tip-probe").hover();
  const bubble = page.locator(".tooltip");
  await expect(bubble).toBeVisible();
  const box = (await bubble.boundingBox())!;
  const vw = await page.evaluate(() => window.innerWidth);
  return { box, vw };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // Wait for the app (and its root <Tooltip/>) to mount.
  await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible();
});

test("a long tooltip wraps within max-width instead of overflowing", async ({ page }) => {
  const longTip =
    "This is a deliberately very long tooltip that should wrap onto multiple " +
    "lines rather than stretch into a single line that runs off the screen.";
  const { box } = await probeTip(page, longTip, { top: "40px", left: "400px" });
  // .tooltip max-width is 280px; wrapping keeps it at/under that (+1px tolerance).
  expect(box.width).toBeLessThanOrEqual(281);
  // Wrapped onto multiple lines, so it's taller than a single ~24px line.
  expect(box.height).toBeGreaterThan(30);
});

test("a long tooltip near the right edge stays inside the viewport", async ({ page }) => {
  const longTip =
    "This is a deliberately very long tooltip anchored hard against the right " +
    "edge of the viewport, where naive centring would clip it off-screen.";
  const { box, vw } = await probeTip(page, longTip, { top: "40px", right: "2px" });
  expect(box.x).toBeGreaterThanOrEqual(7); // left edge within the 8px margin (1px tol)
  expect(box.x + box.width).toBeLessThanOrEqual(vw - 7); // right edge within margin
});

test("a long tooltip near the left edge stays inside the viewport", async ({ page }) => {
  const longTip =
    "This is a deliberately very long tooltip anchored hard against the left " +
    "edge of the viewport, where naive centring would clip it off-screen.";
  const { box, vw } = await probeTip(page, longTip, { top: "40px", left: "2px" });
  expect(box.x).toBeGreaterThanOrEqual(7);
  expect(box.x + box.width).toBeLessThanOrEqual(vw - 7);
});

test("a short tooltip is centred over its anchor", async ({ page }) => {
  await probeTip(page, "Short", { top: "40px", left: "500px", width: "60px" });
  const box = (await page.locator(".tooltip").boundingBox())!;
  const anchorCentre = 500 + 60 / 2; // fixed left + width/2
  const tipCentre = box.x + box.width / 2;
  expect(Math.abs(tipCentre - anchorCentre)).toBeLessThanOrEqual(2);
});
