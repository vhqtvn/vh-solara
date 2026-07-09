import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

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
  await page.goto(projectUrl("/"));
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

// Injects a NESTED data-tip pair (outer button > inner span) at fixed coords.
async function probeNested(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    document.getElementById("tip-probe")?.remove();
    const outer = document.createElement("button");
    outer.id = "tip-outer";
    outer.setAttribute("data-tip", "OUTER");
    outer.textContent = "outer label "; // padding so part of outer is not under inner
    Object.assign(outer.style, {
      position: "fixed",
      zIndex: "999",
      top: "120px",
      left: "300px",
      width: "220px",
      height: "60px",
      display: "block",
    });
    const inner = document.createElement("span");
    inner.id = "tip-inner";
    inner.setAttribute("data-tip", "INNER");
    inner.textContent = "inner";
    Object.assign(inner.style, {
      display: "inline-block",
      width: "50px",
      height: "24px",
      background: "#f00",
    });
    outer.appendChild(inner);
    document.body.appendChild(outer);
  });
}

test("nested data-tip: hovering the inner element shows the inner tip", async ({ page }) => {
  await probeNested(page);
  const bubble = page.locator(".tooltip");
  // Hover the inner span's centre -> should show INNER (not OUTER).
  await page.locator("#tip-inner").hover();
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveText("INNER");
  // Move onto the outer button, at a point NOT over the inner span -> OUTER.
  await page.locator("#tip-outer").hover({ position: { x: 200, y: 30 } });
  await expect(bubble).toHaveText("OUTER");
  // Back onto the inner span -> INNER again (verifies re-entry promotes).
  await page.locator("#tip-inner").hover();
  await expect(bubble).toHaveText("INNER");
});

// Regression guard for the nested-tip promotion. The delegated `onOut` resolves
// the destination's own `data-tip`, so promotion does NOT depend on a follow-up
// `pointerover` reaching the document handler. Here the inner span intercepts
// its own `pointerover` (stopPropagation) so it never bubbles to the delegated
// listener — exactly the case where the old contains-guard left OUTER stuck.
test("nested data-tip promotes even when the inner pointerover is intercepted", async ({ page }) => {
  await page.evaluate(() => {
    document.getElementById("tip-probe")?.remove();
    const outer = document.createElement("button");
    outer.id = "tip-outer";
    outer.setAttribute("data-tip", "OUTER");
    outer.textContent = "outer label ";
    Object.assign(outer.style, {
      position: "fixed", zIndex: "999", top: "180px", left: "300px",
      width: "220px", height: "60px", display: "block",
    });
    const inner = document.createElement("span");
    inner.id = "tip-inner";
    inner.setAttribute("data-tip", "INNER");
    inner.textContent = "inner";
    Object.assign(inner.style, {
      display: "inline-block", width: "50px", height: "24px", background: "#f00",
    });
    // Swallow the follow-up pointerover so it never reaches the delegated
    // document handler (mimics stopPropagation / suppressed delivery).
    inner.addEventListener("pointerover", (e) => e.stopPropagation());
    outer.appendChild(inner);
    document.body.appendChild(outer);
  });
  const bubble = page.locator(".tooltip");
  // Land on OUTER first, then traverse onto the inner span.
  await page.locator("#tip-outer").hover({ position: { x: 200, y: 30 } });
  await expect(bubble).toHaveText("OUTER");
  await page.locator("#tip-inner").hover();
  // onOut must switch to INNER even though inner's pointerover was intercepted.
  await expect(bubble).toHaveText("INNER");
});
