import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// The Preferences editor writes the project's .vh-solara/preferences.local.jsonc
// via /vh/project-settings. We intercept that endpoint so the test owns the data
// and never writes the repo's real file; /vh/render (the confirm diff) hits the
// real fixture daemon.
test("Preferences: agent-styles row edits, previews a diff, and saves", async ({ page }) => {
  let committed: any = null;
  await page.route("**/vh/project-settings*", async (route) => {
    const req = route.request();
    if (req.url().includes("/project-settings/watch")) return route.continue(); // real SSE
    if (req.method() === "GET") {
      await route.fulfill({ json: { agentStyles: { build: { label: "BLD", color: "warn", style: "solid" } } } });
      return;
    }
    // PUT/POST: dryRun returns a before/after pair; a real save returns ok.
    const body = JSON.parse(req.postData() || "{}");
    if (body.dryRun) {
      await route.fulfill({
        json: { old: `{\n  "agentStyles": {}\n}\n`, new: `{\n  "agentStyles": ${JSON.stringify(body.agentStyles, null, 2)}\n}\n` },
      });
    } else {
      committed = body;
      await route.fulfill({ json: { ok: true } });
    }
  });

  await page.goto(projectUrl("/"));
  // Reach the editor via the settings gear beside the project switcher. The gear
  // opens a project-settings dropdown (Preferences / Reload project); open it,
  // then pick the Preferences entry.
  await page.locator(".proj-settings").click();
  await page.getByRole("menuitem", { name: "Preferences" }).click();

  // The @build row is seeded from the (mocked) file.
  const buildRow = page.locator(".agents-row", { hasText: "@build" });
  await expect(buildRow).toBeVisible();
  const label = buildRow.locator(".agents-label");
  await expect(label).toHaveValue("BLD");

  // Edit the label; the live preview chip follows.
  await label.fill("SUP");
  await expect(buildRow.locator(".msg-agent.styled")).toHaveText("SUP");

  // Save… opens the confirm diff.
  await page.getByRole("button", { name: "Save…" }).click();
  const modal = page.locator(".agents-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".agents-diff")).not.toBeEmpty();

  // Confirm writes; the editor reports success and the payload carried our edit.
  await modal.getByRole("button", { name: "Save to file" }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator(".agents-msg")).toContainText("Saved");
  expect(committed.agentStyles.build.label).toBe("SUP");
  expect(committed.agentStyles.build.color).toBe("warn");
  // The combined payload always carries nameReplacements (possibly empty).
  expect(Array.isArray(committed.nameReplacements)).toBe(true);
});

test("Preferences: session-names editor adds a rule and previews the transform", async ({ page }) => {
  let committed: any = null;
  await page.route("**/vh/project-settings*", async (route) => {
    const req = route.request();
    if (req.url().includes("/project-settings/watch")) return route.continue();
    if (req.method() === "GET") {
      await route.fulfill({ json: {} });
      return;
    }
    const body = JSON.parse(req.postData() || "{}");
    if (body.dryRun) {
      await route.fulfill({
        json: { old: `{}`, new: JSON.stringify({ nameReplacements: body.nameReplacements }, null, 2) },
      });
    } else {
      committed = body;
      await route.fulfill({ json: { ok: true } });
    }
  });

  await page.goto(projectUrl("/"));
  await page.locator(".proj-settings").click();
  await page.getByRole("menuitem", { name: "Preferences" }).click();

  // The Session names section is the first <section>. Add a rule.
  await page.getByRole("button", { name: "Add rule" }).click();

  // Fill the pattern and replacement inputs (first row). Pattern is regex, so
  // brackets must be escaped to match literally.
  const pattern = page.locator('input[placeholder*="IMPORTANT"]');
  const replacement = page.locator('input[placeholder="❗"]');
  await pattern.first().fill("\\[\\[IMPORTANT\\]\\]");
  await replacement.first().fill("❗");

  // Edit the sample title and check the preview transforms.
  const sample = page.locator("#pref-name-sample");
  await sample.fill("[[IMPORTANT]] release");
  await expect(page.locator("#pref-name-sample ~ strong")).toContainText("❗ release");

  // Save → confirm → commit.
  await page.getByRole("button", { name: "Save…" }).click();
  const modal = page.locator(".agents-modal");
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Save to file" }).click();
  await expect(modal).toHaveCount(0);

  // The committed payload carries the rule.
  expect(committed.nameReplacements).toHaveLength(1);
  expect(committed.nameReplacements[0].pattern).toBe("\\[\\[IMPORTANT\\]\\]");
  expect(committed.nameReplacements[0].replacement).toBe("❗");
});

// ----------------------------------------------------------------------------
// E Ink display-signal check (requested diagnostics) — the app-preferences
// side of this spec. The check runs ONLY on the explicit "Check display
// signals" click (never at startup), reports CLUES (never identification),
// and can never change the profile by itself. Test 1 mocks the two positive
// display media queries through the sanctioned matchMedia patch seam (the
// terminal.spec.ts forceCoarsePointer pattern: addInitScript wraps the REAL
// matchMedia before any app code, delegating everything except the two
// e-ink queries) and proves positive clues leave the profile OFF until a
// SECOND explicit "Enable E Ink mode" click — which writes the same pref the
// manual toggle uses. Test 2 runs the check against the REAL unmocked
// desktop display (no positive signals) and proves the neutral copy plus a
// still-fully-usable manual toggle.

test("E Ink display-signal check: clues never auto-enable; Enable is a second explicit click", async ({ page }) => {
  await page.addInitScript(() => {
    const orig = window.matchMedia.bind(window);
    const positive = new Set(["(update: slow)", "(monochrome)"]);
    window.matchMedia = ((q: string) => {
      if (positive.has(q)) {
        return {
          matches: true,
          media: q,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => false,
        } as MediaQueryList;
      }
      return orig(q);
    }) as typeof window.matchMedia;
  });
  await page.goto(projectUrl("/"));

  // Default boot: profile OFF, nothing persisted.
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBeNull();

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const einkToggle = dialog.getByRole("checkbox", { name: "E Ink mode" });
  await expect(einkToggle).toBeVisible();
  await expect(einkToggle).not.toBeChecked();
  // Nothing ran on its own: no results and no Enable affordance render
  // before the explicit check click.
  await expect(dialog.locator("[data-eink-check-summary]")).toHaveCount(0);
  await expect(dialog.locator("[data-eink-check-clue]")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Enable E Ink mode" })).toHaveCount(0);

  // Explicit click #1: the check runs and reports the mocked positive
  // signals as CLUES.
  await dialog.getByRole("button", { name: "Check display signals" }).click();
  const summary = dialog.locator("[data-eink-check-summary]");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("compatible with an e-ink panel");
  await expect(dialog.locator("[data-eink-check-clue]")).toHaveCount(2);

  // Clues never identify and never auto-enable: the toggle is still OFF,
  // nothing was persisted by the check, and no theme class changed.
  await expect(einkToggle).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBeNull();
  let classes = await page.evaluate(() => Array.from(document.documentElement.classList));
  expect(classes).not.toContain("theme-eink");

  // Explicit click #2 (Enable): flips the same pref the manual toggle uses.
  await dialog.getByRole("button", { name: "Enable E Ink mode" }).click();
  await expect(einkToggle).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBe(
    JSON.stringify({ v: 1, data: true }),
  );
  classes = await page.evaluate(() => Array.from(document.documentElement.classList));
  expect(classes).toContain("theme-eink");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("E Ink display-signal check: real display with no signals → neutral copy, manual toggle intact", async ({ page }) => {
  // No matchMedia patch: the check consults the real display. A desktop
  // color display answers (update: fast) and (monochrome: 0) — no positive
  // clues, so the copy must be neutral and the manual path untouched.
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const einkToggle = dialog.getByRole("checkbox", { name: "E Ink mode" });
  await expect(einkToggle).not.toBeChecked();

  await dialog.getByRole("button", { name: "Check display signals" }).click();
  const summary = dialog.locator("[data-eink-check-summary]");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("No e-ink signals reported");
  await expect(summary).toContainText("enable E Ink mode manually");
  // No clues, no Enable affordance on a negative result.
  await expect(dialog.locator("[data-eink-check-clue]")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Enable E Ink mode" })).toHaveCount(0);

  // Manual ON stays fully usable when every signal is negative.
  await einkToggle.click();
  await expect(einkToggle).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBe(
    JSON.stringify({ v: 1, data: true }),
  );

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
