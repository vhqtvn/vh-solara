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

test("every semantic theme variable is defined (no referenced-but-undefined vars)", async ({ page }) => {
  await page.goto("/");
  // The whole light-theme contrast saga came from vars referenced with hardcoded
  // dark fallbacks but never defined. Guard that they all resolve to a value.
  const VARS = [
    "--bg-input", "--bg-elev", "--fg-strong",
    "--accent-fg", "--danger-fg", "--danger", "--warn", "--ok", "--sel",
  ];
  const missing = await page.evaluate((vars: string[]) => {
    const cs = getComputedStyle(document.documentElement);
    return vars.filter((v) => cs.getPropertyValue(v).trim() === "");
  }, VARS);
  expect(missing).toEqual([]);
});

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

test("light theme: accent-filled controls (send button, active tab) use white text", async ({ page }) => {
  await page.goto("/");
  await useLightTheme(page);
  await page.getByRole("button", { name: /Demo session/ }).click();

  // The active view tab is filled with the (darker, on light) accent, so its
  // text must be white — not the dark navy that suits the dark theme's accent.
  const activeTab = page.locator(".seg button.on");
  await expect(activeTab).toBeVisible();
  expect(channelSum(await activeTab.evaluate((el) => getComputedStyle(el).color))).toBeGreaterThan(600);

  // Same for the accent send button (its icon inherits currentColor).
  const send = page.locator(".send-btn").first();
  await expect(send).toBeVisible();
  expect(channelSum(await send.evaluate((el) => getComputedStyle(el).color))).toBeGreaterThan(600);
});

test("light theme: a destructive menu item uses a readable red, not faint pink", async ({ page }) => {
  await page.goto("/");
  await useLightTheme(page);
  await page.getByRole("button", { name: /Demo session/ }).click();

  // Right-click the chat header title → the context menu with the "Archive…"
  // destructive item.
  await page.locator(".main-title.has-menu").click({ button: "right" });
  const danger = page.locator(".ctxm-item.danger");
  await expect(danger).toBeVisible();

  const color = await danger.evaluate((el) => getComputedStyle(el).color);
  const [r, g, b] = color.match(/\d+(\.\d+)?/g)!.map(Number);
  // A saturated dark red reads on white; the old light pink (#ffb4ba ≈ 255,180,186)
  // would fail the green/blue ceilings.
  expect(r).toBeGreaterThan(150);
  expect(g).toBeLessThan(120);
  expect(b).toBeLessThan(120);
});
