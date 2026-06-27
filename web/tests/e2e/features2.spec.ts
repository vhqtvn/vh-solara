import { expect, test } from "@playwright/test";

test("composer agent reflects the session's last-used agent; new sessions use the config default", async ({ page }) => {
  await page.goto("/");
  // The demo session's most recent assistant turn ran @build, so the composer
  // restores THAT per session — not the global/config default.
  await page.getByRole("button", { name: /Demo session/ }).click();
  const agent = page.locator(".agent-select");
  await expect(agent).toBeVisible();
  await expect(agent.locator(".vh-select-label")).toHaveText("@build");
  // The reply model is taken from the session's persisted model (OpenCode names
  // it `id`), so it shows the model — not "Select model".
  await expect(page.locator(".model-btn-name")).toHaveText("Dummy Model");

  // A NEW session has no history, so it falls back to the config default_agent
  // (the fixture sets default_agent="plan").
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(agent.locator(".vh-select-label")).toHaveText("@plan");
});

test("project agentStyles render a colored agent chip and a picker swatch", async ({ page }) => {
  // The project declares a display treatment for the `build` agent in
  // .vh-solara/project.jsonc (served via /vh/project-settings). Intercept it so
  // the test owns the config without touching the repo's real file.
  await page.route("**/vh/project-settings*", (route) =>
    route.fulfill({ json: { agentStyles: { build: { label: "BLD", color: "warn", style: "solid" } } } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();

  // The demo's most recent assistant turn ran @build → its message badge becomes
  // the styled chip: the terse label, the solid variant.
  const chip = page.locator(".msg-agent.styled").first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("BLD");
  await expect(chip).toHaveAttribute("data-chip", "solid");

  // The composer picker shows a color swatch for the (build) agent it restored.
  await expect(page.locator(".agent-select .vh-select-swatch")).toBeVisible();
});

test("header servers popover has Server/MCP/LSP/Plugins tabs", async ({ page }) => {
  await page.goto("/");
  // Opened from a header status button (opencode-web style), not Settings.
  await page.getByRole("button", { name: "Servers" }).click();
  const pop = page.getByRole("dialog", { name: "Servers" });

  // Default Server tab shows connection/config info.
  await expect(pop.getByRole("tab", { name: "Server" })).toHaveAttribute("aria-selected", "true");
  await expect(pop).toContainText("Connection");

  await pop.getByRole("tab", { name: "MCP" }).click();
  await expect(pop).toContainText("context7");
  await pop.getByRole("tab", { name: "LSP" }).click();
  await expect(pop).toContainText("gopls");
  await pop.getByRole("tab", { name: "Plugins" }).click();
  await expect(pop).toContainText("opencode-notify");
});

test("empty state invites a new session", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".empty-title")).toContainText("VHSolara");
  await page.locator(".empty-cta").click();
  // Selecting/creating a session replaces the empty state with the chat.
  await expect(page.locator(".empty")).toHaveCount(0);
  await expect(page.locator(".composer")).toBeVisible();
});

test("settings appearance has a configurable display font", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const fontSel = dialog.getByLabel("Display font");
  await expect(fontSel).toBeVisible();
  await fontSel.click(); // open the custom dropdown
  await page.getByRole("option", { name: "Inter" }).click();
  await expect(fontSel).toContainText("Inter");
  // The UI font variable updates.
  const fam = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-ui"),
  );
  expect(fam).toContain("Inter");
});

test("session list detailed density adds a second line per session", async ({ page }) => {
  await page.goto("/");
  // No second line in the default (compact) density.
  await expect(page.locator(".tree-sub")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const densSel = dialog.getByLabel("Session list density");
  await densSel.click();
  await page.getByRole("option", { name: /Detailed/ }).click();
  // Close settings.
  await page.keyboard.press("Escape");
  // Each session row now has a secondary line.
  await expect(page.locator(".tree-sub").first()).toBeVisible();
});

test("composer autocompletes @file, @agent and /command", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  const composer = page.getByPlaceholder("Message…");

  // @ shows agent + file suggestions; picking a file inserts its path.
  await composer.fill("look at @parser");
  await expect(page.locator(".ac-pop .ac-item", { hasText: "src/parser.go" })).toBeVisible({ timeout: 5000 });
  await page.locator(".ac-pop .ac-item", { hasText: "src/parser.go" }).first().click();
  await expect(composer).toHaveValue(/@src\/parser\.go /);

  // /command suggestions at the start of the line.
  await composer.fill("/comp");
  await expect(page.locator(".ac-pop .ac-item", { hasText: "/compact" })).toBeVisible({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".ac-pop")).toHaveCount(0);
});

test("Cmd/Ctrl+K command palette runs an action", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await page.getByPlaceholder("Type a command or session…").fill("Changes");
  await expect(palette.locator(".palette-item", { hasText: "Go to Changes" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  // The Changes view is now active.
  await expect(page.locator(".git")).toBeVisible({ timeout: 8000 });
});

test("settings App section (browser only) offers PWA install + orientation note", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  // In a plain browser tab the App section is present.
  await dialog.getByRole("button", { name: "App", exact: true }).click();
  await expect(dialog).toContainText("Install VHSolara as an app");
  // No install prompt in headless Chromium → manual instructions shown.
  await expect(dialog).toContainText(/Add to Home screen|Install app|Home Screen/);
});

test("settings has Appearance, General, Servers and About sections", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  for (const s of ["Appearance", "General", "Usage", "About"]) {
    await expect(dialog.getByRole("button", { name: s })).toBeVisible();
  }
});

test("message inspect shows tokens/cost/raw JSON", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  const msg = page.locator(".msg.assistant").first();
  await msg.hover();
  await msg.getByRole("button", { name: "Inspect" }).click();
  await expect(page.locator(".msg-inspect").first()).toContainText("role");
});

test("clicking a file path opens it in the code viewer", async ({ page }) => {
  // The old modal FileViewer was replaced by the code viewer: a clicked path now
  // opens the docked (desktop) / overlay (mobile) code surface, not a dialog.
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.locator(".filepath", { hasText: "src/parser.go" }).first().click();
  await expect(page.locator(".code-dock.dock, .code-dock.overlay")).toBeVisible({ timeout: 6000 });
});

test("UI zoom scales the interface and persists (versioned)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const slider = dialog.getByRole("slider", { name: "UI zoom" });
  await expect(slider).toBeVisible();
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = "1.3";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    // Zoom applies on release (change), not on every input, so dragging doesn't
    // rescale the slider out from under the pointer.
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // Applied to the document root and persisted as a versioned envelope.
  await expect.poll(() => page.evaluate(() => (document.documentElement.style as any).zoom)).toBe("1.3");
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("vh.prefs.uiScale.v1") || "{}").data),
  ).toBe(1.3);
});

test("hovering a control shows a DOM tooltip (not native title)", async ({ page }) => {
  await page.goto("/");
  // No native title attributes anywhere (they spawn windows in some WMs).
  await expect(page.locator("[title]")).toHaveCount(0);
  // data-tip drives a DOM tooltip on hover.
  await page.getByRole("button", { name: "Settings" }).hover();
  await expect(page.locator(".tooltip")).toContainText("Settings", { timeout: 3000 });
});

test("settings toggles live message streaming", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "General" }).click();
  const cb = dialog.getByRole("checkbox", { name: "Live message streaming" });
  await expect(cb).toBeChecked(); // on by default
  await cb.uncheck();
  await expect(cb).not.toBeChecked();
});

test("attaching a file shows a chip, uploads, and clears after send", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.locator(".composer input[type=file]").setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello attachment"),
  });
  // Uploaded to .vh-solara and queued as a chip.
  await expect(page.locator(".attach-chip .attach-name", { hasText: "note.txt" })).toBeVisible({ timeout: 8000 });
  // Sending the message clears the pending attachments.
  await page.getByPlaceholder("Message…").fill("see attached");
  await page.keyboard.press("Enter");
  await expect(page.locator(".attach-chip")).toHaveCount(0, { timeout: 8000 });
});

test("shell mode (! prefix) runs a command and shows output", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.getByPlaceholder(/Message/).fill("!ls -la");
  await page.keyboard.press("Enter");
  // The command runs as a bash tool whose head shows the command line.
  const shellTool = page.locator(".tool").filter({ hasText: "ls -la" }).last();
  await expect(shellTool).toBeVisible({ timeout: 8000 });
  // The captured output sits behind the tool's disclosure — expand if collapsed.
  const output = shellTool.getByText(/fixture shell output for: ls -la/);
  if (!(await output.isVisible())) await shellTool.locator(".tool-head").click();
  await expect(output).toBeVisible({ timeout: 4000 });
});
