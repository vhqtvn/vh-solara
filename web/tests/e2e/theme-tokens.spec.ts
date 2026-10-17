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
  // Device-feedback round 2: the flat danger-TEXT token resolves to INK
  // under theme-eink (the flipped --danger-fg). The old #ffffff mapping was
  // correct only for solid danger fills and rendered every flat danger
  // consumer (menu Archive…, confirm titles, error hints) white-on-white —
  // the operator's "archive or delete isn't visible" report.
  expect(
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.cssText = "color: var(--danger-fg);position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(el);
      const v = getComputedStyle(el).color;
      el.remove();
      return v;
    }),
  ).toBe("rgb(0, 0, 0)");

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

// ----------------------------------------------------------------------------
// E Ink display profile — a manual, default-OFF preference that applies an
// EFFECTIVE e-ink theme while preserving the saved theme preference. This test
// proves, through the real Settings UI in a real browser: the default-off
// boot, that selecting an e-ink THEME alone never enables the profile, that
// toggling it ON attaches the effective e-ink class AND the motion/shadow
// kill-switch (computed, not just class-list), that the saved theme preference
// is preserved, that a second tab follows profile AND theme changes live
// (same-context storage events, no reload), and that toggling OFF restores the
// pre-toggle appearance exactly.

// Probe with INLINE animation/transition/scroll-behavior declarations. Under a
// normal theme the computed values are exactly what was declared; under the
// e-ink kill-switch (tokens.css targets `:root.theme-eink *` with !important —
// it exists precisely to override inline styles like Spinner's) they compute to
// none / none / auto. Running the SAME probe before and after the profile
// toggle proves the kill-switch attached BECAUSE of the profile.
async function motionProbe(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const el = document.createElement("div");
    el.style.cssText =
      "animation: probe-motion-eink 1s linear infinite; transition: opacity 0.3s ease; scroll-behavior: smooth; position:fixed; left:-9999px;";
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const out = {
      animationName: cs.animationName,
      transitionProperty: cs.transitionProperty,
      scrollBehavior: cs.scrollBehavior,
    };
    el.remove();
    return out;
  });
}

test("e ink profile: default-off manual toggle composes a reversible effective theme across tabs", async ({ page }) => {
  await page.goto(projectUrl("/"));

  // ---- Default boot: profile OFF (no storage key), saved default theme renders.
  let classes = await htmlClasses(page);
  expect(classes).toContain("theme-dark");
  expect(classes).not.toContain("theme-eink");
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBeNull();

  // Baseline motion probe under dark: declarations compute exactly as written.
  const base = await motionProbe(page);
  expect(base).toEqual({ animationName: "probe-motion-eink", transitionProperty: "opacity", scrollBehavior: "smooth" });

  // Second tab in the SAME context: shares localStorage, receives its storage
  // events — the cross-tab consistency witness.
  const p2 = await page.context().newPage();
  await p2.goto(projectUrl("/"));
  await expect.poll(() => htmlClasses(p2)).toContain("theme-dark");

  // ---- Selecting an e-ink THEME (profile OFF) must NOT enable the profile.
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.locator('[role="option"][title="E Ink"]').click();
  classes = await htmlClasses(page);
  expect(classes).toContain("theme-eink"); // via the SAVED theme, not the profile
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBeNull();
  // The profile's own toggle stays unchecked.
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const einkToggle = dialog.getByRole("checkbox", { name: "E Ink mode" });
  await expect(einkToggle).toBeVisible();
  await expect(einkToggle).not.toBeChecked();

  // Back to the dark saved theme on both tabs before the profile phase, so the
  // later assertions can't pass on a stale class.
  await dialog.getByRole("button", { name: "Theme" }).click();
  await dialog.locator('[role="option"][title="Dark"]').click();
  await expect.poll(() => htmlClasses(page)).toContain("theme-dark");
  await expect.poll(() => htmlClasses(p2)).toContain("theme-dark");
  expect(await htmlClasses(p2)).not.toContain("theme-eink");

  // ---- Profile ON (manual toggle through the real Settings UI).
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await einkToggle.click();
  classes = await htmlClasses(page);
  expect(classes).toContain("theme-eink"); // effective e-ink theme attached
  expect(classes).not.toContain("theme-dark"); // …in place of the saved class
  expect(classes).toContain("theme-light-scoped"); // e-ink themes are light
  // The SAVED theme preference is preserved untouched.
  expect(await page.evaluate(() => localStorage.getItem("vh.theme.v1"))).toBe(
    JSON.stringify({ v: 1, data: "dark" }),
  );
  // Kill-switch attached BY THE PROFILE: computed none/none/auto on the probe.
  const killed = await motionProbe(page);
  expect(killed).toEqual({ animationName: "none", transitionProperty: "none", scrollBehavior: "auto" });
  // Shadow tokens resolve to none (borders carry elevation on e-ink).
  const on = await themeVars(page);
  expect(on.sm).toBe("none");
  expect(on.md).toBe("none");
  expect(on.lg).toBe("none");

  // Cross-tab: tab 2 followed the toggle live (storage event, no reload).
  await expect.poll(() => htmlClasses(p2)).toContain("theme-eink");

  // ---- While ON, the SAVED theme still drives which e-ink variant renders:
  // the color variant when explicitly picked…
  await dialog.getByRole("button", { name: "Theme" }).click();
  await dialog.locator('[role="option"][title="E Ink Color"]').click();
  await expect.poll(() => htmlClasses(page)).toContain("theme-eink-color");
  await expect.poll(() => htmlClasses(p2)).toContain("theme-eink-color");
  // …monochrome for anything else (back to dark).
  await dialog.locator('[role="option"][title="Dark"]').click();
  await expect.poll(() => htmlClasses(page)).toContain("theme-eink");
  await expect.poll(() => htmlClasses(p2)).toContain("theme-eink");
  expect(await htmlClasses(p2)).not.toContain("theme-eink-color");

  // ---- Profile OFF restores the saved appearance exactly.
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await einkToggle.click(); // uncheck
  classes = await htmlClasses(page);
  expect(classes).toContain("theme-dark");
  expect(classes).not.toContain("theme-eink");
  expect(classes).not.toContain("theme-eink-color");
  expect(await page.evaluate(() => localStorage.getItem("vh.theme.v1"))).toBe(
    JSON.stringify({ v: 1, data: "dark" }),
  );
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBe(
    JSON.stringify({ v: 1, data: false }),
  );
  // The kill-switch is gone: the probe computes exactly the pre-toggle baseline.
  expect(await motionProbe(page)).toEqual(base);
  // Tab 2 restores too.
  await expect.poll(() => htmlClasses(p2)).toContain("theme-dark");
  expect(await htmlClasses(p2)).not.toContain("theme-eink");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await p2.close();
});

// ----------------------------------------------------------------------------
// E Ink COLOR theme — computed probe (UX Slice 4). This closes the standing
// DEFER from the profile's Slice 1 review: the `theme-eink-color` variant had
// NO computed coverage (its monochrome sibling theme-eink was probed, this
// variant only had class-name checks). The contract, asserted COMPUTED (never
// by class presence):
//   - the motion/shadow/scroll kill-switch attaches to THIS variant too
//     (animation/transition/scroll-behavior → none/none/auto; --shadow-* →
//     none) — the whole point of the variant family is that both share the
//     stillness treatment;
//   - AND the property that makes this variant DISTINCT — saturated semantic
//     COLOR tokens that survive a colour-filter panel: --accent/--danger/
//     --ok/--warn/--sel are pairwise distinct and CHROMATIC (each has a
//     nonzero channel spread — none collapsed to the monochrome greys),
//     with token-level (--focus-ring === --accent) and real-surface (the
//     active settings nav item renders in --accent) wiring.
// Theme-scoped by design: the E Ink Color SAVED theme is picked through the
// real ThemePicker with the profile OFF (the kill-switch keys on the theme,
// not the profile), mirroring the matrix test's selection path.

function parseRgb(s: string): [number, number, number] | null {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

test("e ink color theme: computed motion/shadow kill-switch AND saturated semantic colors", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  // Default section is Theme — pick the color variant through the real UI.
  await dialog.locator('[role="option"][title="E Ink Color"]').click();
  const classes = await htmlClasses(page);
  expect(classes).toContain("theme-eink-color");
  expect(classes).toContain("theme-light-scoped");
  expect(classes).not.toContain("theme-eink"); // the monochrome sibling is absent

  // ---- Kill-switch attaches to the COLOR variant too (computed). ----
  expect(await motionProbe(page)).toEqual({
    animationName: "none",
    transitionProperty: "none",
    scrollBehavior: "auto",
  });
  const vars = await themeVars(page);
  expect(vars.sm).toBe("none");
  expect(vars.md).toBe("none");
  expect(vars.lg).toBe("none");

  // ---- Saturated semantic colors (the variant's reason to exist). ----
  const colors = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n: string) => cs.getPropertyValue(n).trim();
    return { accent: g("--accent"), danger: g("--danger"), ok: g("--ok"), warn: g("--warn"), sel: g("--sel"), mdLink: g("--md-link") };
  });
  // Computed values are hex per the tokens.css declarations — resolve each
  // through the SAME engine serialization a consumer sees (probe element).
  const resolve = (decl: string) =>
    page.evaluate((d) => {
      const el = document.createElement("div");
      el.style.cssText = `${d};position:fixed;left:-9999px;top:-9999px;`;
      document.body.appendChild(el);
      const v = getComputedStyle(el).color;
      el.remove();
      return v;
    }, decl);
  const chroma = (v: string) => {
    const rgb = parseRgb(v);
    return rgb ? Math.max(...rgb) - Math.min(...rgb) : -1;
  };
  const [accent, danger, ok, warn, sel, mdLink] = await Promise.all([
    resolve("color: var(--accent)"),
    resolve("color: var(--danger)"),
    resolve("color: var(--ok)"),
    resolve("color: var(--warn)"),
    resolve("color: var(--sel)"),
    resolve("color: var(--md-link)"),
  ]);
  // Chromatic: every semantic token carries real hue (channel spread > 8 —
  // comfortably above rendering noise, far below the designed saturation).
  for (const [name, v] of Object.entries({ accent, danger, ok, warn, sel })) {
    expect(chroma(v), `${name} must stay saturated under e-ink-color (got ${v})`).toBeGreaterThan(8);
  }
  // Pairwise distinct hues among the status meanings (the monochrome collapse
  // is what this rules out). --sel is EXEMPT: the eink-color block defines it
  // as accent's sibling (#0b5cad === --accent) by design, so it is asserted
  // as wiring (below), not as a distinct fifth hue.
  const setStatuses = new Set([accent, danger, ok, warn]);
  expect(setStatuses.size).toBe(4);
  expect(sel).toBe(accent); // the documented sel===accent wiring, computed
  // Token wiring: focus ring and the markdown link both resolve to accent.
  expect(vars.focusRing).toBe(colors.accent);
  expect(mdLink).toBe(accent);
  // Device-feedback round 2: --danger-fg FOLLOWS the saturated danger hue
  // (chromatic flat danger text on the white page — not the old invisible
  // white-on-white, and not the monochrome sibling's ink).
  const dangerFg = await resolve("color: var(--danger-fg)");
  expect(dangerFg).toBe(danger);
  expect(chroma(dangerFg)).toBeGreaterThan(8);

  // ---- Real-surface color consumer: the ACTIVE settings nav item renders
  // in --accent (computed, through the real ThemePicker-selected theme). ----
  const activeNav = dialog.locator(".settings-nav-item.on");
  await expect(activeNav).toBeVisible();
  expect(await activeNav.evaluate((el) => getComputedStyle(el).color)).toBe(accent);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
