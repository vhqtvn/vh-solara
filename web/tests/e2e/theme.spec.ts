import { expect, test } from "@playwright/test";

// Parse "rgb(r, g, b)" / "rgba(...)" to a 0–255 luminance-ish channel sum.
function channelSum(color: string): number {
  const m = color.match(/\d+(\.\d+)?/g);
  if (!m) return 0;
  return Number(m[0]) + Number(m[1]) + Number(m[2]);
}

async function useLightTheme(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const el = document.documentElement;
    el.className = el.className.replace(/\btheme-\S+/g, "").trim();
    el.classList.add("theme-light");
    el.style.colorScheme = "light";
  });
}

test("light theme defines the surface/emphasis vars that selects & session list use", async ({ page }) => {
  await page.goto("/");
  await useLightTheme(page);

  // The bug: --bg-input/--bg-elev/--fg-strong were never defined, so controls
  // fell back to hardcoded dark. They must now resolve to the light palette.
  const v = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const get = (n: string) => cs.getPropertyValue(n).trim();
    return {
      bgInput: get("--bg-input"),
      bg: get("--bg"),
      bgElev: get("--bg-elev"),
      bg2: get("--bg-2"),
      fgStrong: get("--fg-strong"),
      fg: get("--fg"),
    };
  });
  expect(v.bgInput).toBe(v.bg); // input surface tracks the (light) page bg
  expect(v.bgElev).toBe(v.bg2); // elevated popups track the (light) raised surface
  expect(v.fgStrong).toBe(v.fg); // running-session title is dark on light, not #fff
});

test("light theme: a select control renders a light background, not dark", async ({ page }) => {
  await page.goto("/");
  await useLightTheme(page);

  // Open Settings — its Theme/Session-list/etc. selects are .vh-select-btn.
  await page.getByRole("button", { name: "Settings" }).click();
  const btn = page.locator(".vh-select-btn").first();
  await expect(btn).toBeVisible();

  const bg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
  // Light surface => channels near white (sum well above the dark-fallback
  // #0d1117, whose channel sum is ~37).
  expect(channelSum(bg)).toBeGreaterThan(600);
});
