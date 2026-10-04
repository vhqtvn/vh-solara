import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Browser-level theme-token receipt (advisory follow-through for the
// theme-system reviews: OLED themes + token vocabulary slices). Asserts, in a
// real Chromium via getComputedStyle, that the shadow/scrim/focus tokens
// declared in styles/foundation/tokens.css actually DRIVE the surfaces they
// were extracted for — dialogs (--shadow-lg tier), the update toast
// (--shadow-md tier), the Mermaid overlay scrim (--scrim-strong), and keyboard
// focus on session-tree rows — across the theme matrix: one dark theme
// (default `dark`), one non-e-ink light theme (`light`), one e-ink theme
// (`eink`).
//
// Expected values are NEVER hardcoded: each assertion compares the surface's
// computed style against a *probe element* given the same token declaration
// (e.g. `box-shadow: var(--shadow-md)`), so both sides go through the engine's
// identical serialization. This asserts the wiring (token → surface), not a
// palette snapshot.
//
// Theme switching goes through the real user-visible path: Settings → Theme
// section (the default) → ThemePicker option click → setThemeId() →
// applyTheme(), which rewrites the html classes live (no reload). The dark
// phase covers the default boot (no localStorage).
//
// Honest scope notes:
// - Session-tree focus: `.tree-node:focus-visible` styles focus as an INSET
//   box-shadow ring from --accent (legacy/80-professional-pass.css), not an
//   outline — so the receipt asserts the computed inset ring on a really
//   keyboard-focused row (real Tab presses), plus the token-level
//   `--focus-ring === --accent` wiring on :root per theme.
// - The toast surface is the Update toast (ConnectionToast shares the same
//   --shadow-md tier but needs an SSE drop to surface; UpdateToast is the
//   deterministic trigger via the /vh/version route, per layout.spec.ts).
// - Scrim: --scrim/--scrim-strong are theme-UNoverridden by design; the
//   cross-theme var-level equality is asserted in the matrix test and the
//   overlay consumer is exercised once under the default dark theme.

// ----------------------------------------------------------------------------
// Helpers

async function htmlClasses(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.documentElement.classList));
}

interface ThemeVars {
  sm: string;
  md: string;
  lg: string;
  scrim: string;
  scrimStrong: string;
  focusRing: string;
  accent: string;
}

async function themeVars(page: import("@playwright/test").Page): Promise<ThemeVars> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n: string) => cs.getPropertyValue(n).trim();
    return {
      sm: g("--shadow-sm"),
      md: g("--shadow-md"),
      lg: g("--shadow-lg"),
      scrim: g("--scrim"),
      scrimStrong: g("--scrim-strong"),
      focusRing: g("--focus-ring"),
      accent: g("--accent"),
    };
  });
}

// Probe: append an off-screen div with the given declaration and return its
// computed value — the same var → computed serialization the real surface goes
// through, so an exact string comparison is valid.
async function probeBoxShadow(page: import("@playwright/test").Page, decl: string): Promise<string> {
  return page.evaluate((d) => {
    const el = document.createElement("div");
    el.style.cssText = `${d};position:fixed;left:-9999px;top:-9999px;`;
    document.body.appendChild(el);
    const v = getComputedStyle(el).boxShadow;
    el.remove();
    return v;
  }, decl);
}

async function probeBackground(page: import("@playwright/test").Page, decl: string): Promise<string> {
  return page.evaluate((d) => {
    const el = document.createElement("div");
    el.style.cssText = `${d};position:fixed;left:-9999px;top:-9999px;`;
    document.body.appendChild(el);
    const v = getComputedStyle(el).backgroundColor;
    el.remove();
    return v;
  }, decl);
}

// Real keyboard focus: press Tab (a genuine user keypress, so :focus-visible
// matches) until activeElement is a session-tree row. Bounded so a changed tab
// order fails loudly instead of hanging.
async function tabToTreeNode(page: import("@playwright/test").Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const onNode = await page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLElement && el.classList.contains("tree-node");
    });
    if (onNode) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab never reached a .tree-node within 40 presses");
}

function focusedTreeNodeState(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) {
      return { isNode: false, focusVisible: false, shadow: "" };
    }
    return {
      isNode: el.classList.contains("tree-node"),
      focusVisible: el.matches(":focus-visible"),
      shadow: getComputedStyle(el).boxShadow,
    };
  });
}

async function assertTreeNodeFocusRing(page: import("@playwright/test").Page): Promise<void> {
  const expected = await probeBoxShadow(page, "box-shadow: inset 0 0 0 2px var(--accent)");
  // A theme switch triggers async re-renders (the light syntax-sheet swap and
  // the tree re-render it causes) that can REPLACE the focused row a few
  // hundred ms AFTER keyboard focus lands — focus then falls to <body> and a
  // naive poll would read body's shadow ("none"). Retry: re-Tab to a row and
  // re-poll until a row HOLDS focus with the settled ring — what a keyboard
  // user actually experiences once the switch settles. The assertion itself
  // stays exact: focused row's computed inset ring === the --accent probe.
  for (let attempt = 0; attempt < 6; attempt++) {
    await tabToTreeNode(page);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const st = await focusedTreeNodeState(page);
      if (st.isNode && st.focusVisible && st.shadow === expected) {
        // Survive one more beat: if the row was replaced (focus → <body>),
        // fall through and re-Tab on the next attempt.
        await page.waitForTimeout(250);
        const after = await focusedTreeNodeState(page);
        if (after.isNode && after.focusVisible && after.shadow === expected) return;
      } else {
        await page.waitForTimeout(100);
      }
    }
  }
  throw new Error("tree row never held keyboard focus with the settled accent ring");
}

// Deterministic update-toast trigger (layout.spec.ts pattern): pin
// /vh/version, let the first poll record v-1, flip to v-2, force the
// visibility-triggered re-check. The toast has no auto-dismiss, so it stays
// mounted for the rest of the test and can be re-read under each theme.
async function triggerUpdateToast(page: import("@playwright/test").Page): Promise<void> {
  let version = "v-1";
  await page.route("**/vh/version", (route) => route.fulfill({ json: { version } }));
  await page.goto(projectUrl("/"));
  await expect(page.locator(".update-toast")).toHaveCount(0);
  version = "v-2";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".update-toast")).toBeVisible({ timeout: 8000 });
}

// ----------------------------------------------------------------------------

test("shadow + focus tokens drive dialog, toast, and tree focus across dark, light, and e-ink", async ({ page }) => {
  await triggerUpdateToast(page);
  const toast = page.locator(".update-toast");

  // ---- DARK (default boot: no localStorage, theme `dark`) ----
  let classes = await htmlClasses(page);
  expect(classes).toContain("theme-dark");
  expect(classes).not.toContain("theme-light-scoped");

  // Toast = --shadow-md tier.
  expect(await toast.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
    await probeBoxShadow(page, "box-shadow: var(--shadow-md)"),
  );

  const dark = await themeVars(page);
  expect(dark.focusRing).toBe(dark.accent); // token wiring: --focus-ring: var(--accent)

  // Keyboard-focused tree row shows the inset accent ring.
  await assertTreeNodeFocusRing(page);

  // Dialog = --shadow-lg tier.
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
    await probeBoxShadow(page, "box-shadow: var(--shadow-lg)"),
  );

  // ---- LIGHT (switch via the real ThemePicker; dialog stays open) ----
  await dialog.locator('[role="option"][title="Light"]').click();
  classes = await htmlClasses(page);
  expect(classes).toContain("theme-light");
  expect(classes).toContain("theme-light-scoped");
  expect(classes).not.toContain("theme-dark");

  const light = await themeVars(page);
  // Light shadows SOFTEN: every tier resolves differently from dark.
  expect(light.sm).not.toBe(dark.sm);
  expect(light.md).not.toBe(dark.md);
  expect(light.lg).not.toBe(dark.lg);
  expect(light.focusRing).toBe(light.accent);
  // Scrim tokens are theme-unoverridden by design.
  expect(light.scrim).toBe(dark.scrim);
  expect(light.scrimStrong).toBe(dark.scrimStrong);

  // The still-open dialog re-resolves to the softened light --shadow-lg.
  expect(await dialog.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
    await probeBoxShadow(page, "box-shadow: var(--shadow-lg)"),
  );
  // The persistent toast re-resolves to the softened light --shadow-md.
  expect(await toast.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
    await probeBoxShadow(page, "box-shadow: var(--shadow-md)"),
  );

  await page.keyboard.press("Escape"); // document-level keydown closes Settings
  await expect(dialog).toHaveCount(0);
  await assertTreeNodeFocusRing(page);

  // ---- E INK ----
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(dialog).toBeVisible();
  await dialog.locator('[role="option"][title="E Ink"]').click();
  classes = await htmlClasses(page);
  expect(classes).toContain("theme-eink");
  // e-ink themes are light themes: they carry the light marker TOO.
  expect(classes).toContain("theme-light-scoped");

  const eink = await themeVars(page);
  // Shadows resolve to none: borders carry elevation on e-ink.
  expect(eink.sm).toBe("none");
  expect(eink.md).toBe("none");
  expect(eink.lg).toBe("none");
  expect(eink.focusRing).toBe(eink.accent);
  expect(eink.scrim).toBe(dark.scrim);
  expect(eink.scrimStrong).toBe(dark.scrimStrong);

  // Dialog + toast compute to none via the same tokens (probe returns "none").
  expect(await dialog.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
    await probeBoxShadow(page, "box-shadow: var(--shadow-lg)"),
  );
  expect(await toast.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
    await probeBoxShadow(page, "box-shadow: var(--shadow-md)"),
  );

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await assertTreeNodeFocusRing(page);
});

test("mermaid overlay scrim resolves from --scrim-strong", async ({ page }) => {
  // The overlay consumer is exercised once, under the default dark theme:
  // --scrim/--scrim-strong are theme-unoverridden by design, and the matrix
  // test asserts that var-level equality across all three themes.
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Mermaid diagrams/ }).click();
  await page
    .locator("[data-mermaid='inline'] [data-mermaid-diagram] svg")
    .first()
    .waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-mermaid='inline'] button[title='Expand diagram']").first().click();
  const overlay = page.locator("[data-mermaid='overlay']");
  await expect(overlay).toBeVisible({ timeout: 10000 });

  expect(await overlay.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await probeBackground(page, "background: var(--scrim-strong)"),
  );
});
