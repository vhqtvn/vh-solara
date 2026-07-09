import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Sends a prompt containing the fixture trigger and returns once the assistant
// turn settles. The fixture maps [[ask]] -> a question.asked event.
async function openDemo(page: import("@playwright/test").Page) {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
}

test("a question request renders an answerable card and replies", async ({ page }) => {
  await openDemo(page);
  await page.getByPlaceholder(/Message/).fill("[[ask]] pick one");
  await page.keyboard.press("Enter");

  const card = page.locator(".question-card");
  await expect(card).toBeVisible({ timeout: 8000 });
  await expect(card).toContainText("Which approach should I take?");
  await expect(card).toContainText("Refactor");
  await expect(card).toContainText("Rewrite");

  // Display-only A:/B: keys are shown (separate DOM elements, not part of the value).
  await expect(card.locator(".question-opt-key").first()).toHaveText("A:");
  await expect(card.locator(".question-opt-key").nth(1)).toHaveText("B:");
  await expect(card.locator(".question-opt-label").first()).toHaveText("Refactor");

  // Free-text "type your own" is offered by default (the question doesn't set
  // custom:false), so a custom reply is always possible.
  await expect(card.locator(".question-custom")).toBeVisible();

  // Reply is disabled until an option is chosen.
  const reply = card.getByRole("button", { name: "Reply" });
  await expect(reply).toBeDisabled();
  await card.getByText("Refactor").click();
  await expect(reply).toBeEnabled();
  await reply.click();

  // The card clears once the reply is acknowledged (question.replied event)…
  await expect(card).toHaveCount(0, { timeout: 8000 });
  // …and the assistant continues with a visible result referencing the choice.
  await expect(page.locator(".msg.assistant").last()).toContainText("Refactor", { timeout: 8000 });
});

test("the notification bell surfaces a pending question as an action", async ({ page }) => {
  await openDemo(page);
  await page.getByPlaceholder(/Message/).fill("[[ask]] need a decision");
  await page.keyboard.press("Enter");
  await expect(page.locator(".question-card")).toBeVisible({ timeout: 8000 });

  // Badge appears; opening the menu lists an "Action needed" item.
  await expect(page.locator(".notif-badge")).toBeVisible();
  await page.getByRole("button", { name: "Notifications" }).click();
  const menu = page.getByRole("dialog", { name: "Notifications" });
  await expect(menu.locator(".notif-section", { hasText: "Action needed" })).toBeVisible();
  await expect(menu.locator(".notif-item.action").first()).toContainText("Which approach");
});

test("header usage pill shows context + quota and opens the inspector", async ({ page }) => {
  await openDemo(page);
  // OpenChamber-style Usage pill in the chat header.
  const pill = page.getByRole("button", { name: "Usage", exact: true });
  await expect(pill).toBeVisible();
  await pill.click();

  const menu = page.getByRole("dialog", { name: "Usage" });
  await expect(menu).toContainText("Context window");
  await expect(menu).toContainText("Provider quota");
  // Provider quota is reachable right here from the chat screen (not just Settings).
  await expect(menu.locator(".quota-name", { hasText: "Claude" })).toBeVisible();

  // Drill into the full session inspector.
  await menu.getByRole("button", { name: "Session details →" }).click();
  const insp = page.getByRole("dialog", { name: "Session inspector" });
  await expect(insp).toBeVisible();
  await expect(insp).toContainText("Total cost");
  await expect(insp).toContainText("Messages");
});

test("notes view persists a to-do and project notes to the server", async ({ page }) => {
  // Notes is off by default now — enable the pref so the tab is present.
  await page.addInitScript(() => localStorage.setItem("vh.prefs.notesEnabled.v1", JSON.stringify({ v: 1, data: true })));
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Notes", exact: true }).click();

  // Add a to-do.
  const todo = `ship it ${Date.now()}`;
  await page.getByPlaceholder("Add a to-do…").fill(todo);
  await page.getByRole("button", { name: "Add to-do" }).click();
  await expect(page.locator(".todo-text", { hasText: todo })).toBeVisible();

  // Write a note; it autosaves to the daemon.
  const note = `note ${Date.now()}`;
  await page.locator(".notes-text").fill(note);
  await page.waitForTimeout(800);

  // The server round-trips it: GET /vh/notes returns the saved content.
  const saved = await page.evaluate(async () => (await fetch("/vh/notes")).json());
  expect(saved.notes).toContain("note ");
  expect(saved.todos.some((t: any) => t.text.startsWith("ship it"))).toBeTruthy();
});

test("archive removes a session from the tree and the Archived browser restores it", async ({ page }) => {
  await page.goto(projectUrl("/"));
  // Create a fresh session so we don't disturb the seeded demo sessions.
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByPlaceholder("Message…").fill("archive me");
  await page.keyboard.press("Enter");

  // The created session is selected and deep-linked into the URL — grab its id so
  // the assertions target THIS session, not the shared pool of "New session" rows
  // other tests in the serial run leave behind.
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBeTruthy();
  const id = new URL(page.url()).searchParams.get("session")!;
  const node = page.locator(`.tree-node[data-session-id="${id}"]`);
  await expect(node).toBeVisible({ timeout: 8000 });

  // Let the turn fully settle before archiving. Archiving mid-stream races the
  // turn's trailing session.idle, which can re-hydrate the just-archived session
  // back into the live tree — so wait for the assistant response to complete (the
  // fixture streams "Done. Updated `parser.go` …" for a plain prompt).
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 8000 });

  // Archive via the session inspector (Usage pill → Session details → Archive).
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await page.getByRole("dialog", { name: "Usage" }).getByRole("button", { name: "Session details →" }).click();
  const insp = page.getByRole("dialog", { name: "Session inspector" });
  await insp.getByRole("button", { name: /Archive session/ }).click();

  // Archiving requires confirmation (lists related sessions).
  const confirm = page.getByRole("dialog", { name: "Confirm archive" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /Archive/ }).click();

  // Confirmed → this specific session leaves the live tree for good.
  await expect(node).toHaveCount(0, { timeout: 8000 });

  // …and shows up in the Archived browser, where Restore brings it back.
  await page.getByRole("button", { name: "Archived" }).click();
  const arch = page.getByRole("dialog", { name: "Archived sessions" });
  await expect(arch).toBeVisible();
  await expect(arch.locator(".arch-row").first()).toBeVisible({ timeout: 8000 });
  const beforeArch = await arch.locator(".arch-row").count();
  await arch.locator(".arch-restore").first().click();
  await expect.poll(() => arch.locator(".arch-row").count(), { timeout: 8000 }).toBeLessThan(beforeArch);
});

test("sidebar search filters sessions and pinning floats one to the top", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await expect(page.locator(".tree-node", { hasText: "Demo session" })).toBeVisible();

  // Search is collapsed by default — reveal it via the header toggle first.
  await page.getByRole("button", { name: "Search sessions" }).click();
  const search = page.getByPlaceholder("Search sessions…");
  await expect(search).toBeVisible();
  await search.fill("zzzznomatch");
  await expect(page.locator(".tree-empty")).toContainText("No matches");
  await search.fill("Demo");
  await expect(page.locator(".tree-node", { hasText: "Demo session" })).toBeVisible();
  await page.locator(".session-search-clear").click();
  await expect(search).toHaveValue("");

  // Pin via the context menu → the session moves into the tinted pinned group
  // at the top (no per-row pin icon; position is the signal).
  await page.locator(".tree-node", { hasText: "Demo session" }).first().click({ button: "right" });
  const menu = page.locator(".ctxm-menu");
  await menu.getByText(/Pin to top/).click();
  await expect(page.locator(".tree-pinned .tree-node", { hasText: "Demo session" })).toBeVisible();
});

test("session search collapses by default and toggles from the header", async ({ page }) => {
  await page.goto(projectUrl("/"));
  const search = page.getByPlaceholder("Search sessions…");
  await expect(search).toBeHidden(); // collapsed by default → reclaims a row

  const toggle = page.getByRole("button", { name: "Search sessions" });
  await toggle.click();
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();

  // Clearing keeps the field open (just empties it).
  await search.fill("Demo");
  await page.locator(".session-search-clear").click();
  await expect(search).toBeVisible();
  await expect(search).toHaveValue("");

  // Escape on an empty field collapses it.
  await search.press("Escape");
  await expect(search).toBeHidden();

  // The header toggle, when a filter is active, clears it and collapses.
  await toggle.click();
  await search.fill("Demo");
  await toggle.click();
  await expect(search).toBeHidden();
});

test("right-click session title opens a menu; Archive… confirms related sessions", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByPlaceholder("Message…").fill("menu me");
  await page.keyboard.press("Enter");

  // The created session is selected and deep-linked into the URL — grab its id so
  // the assertions target THIS session, not the shared pool of "New session" rows
  // other tests in the serial run leave behind.
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBeTruthy();
  const id = new URL(page.url()).searchParams.get("session")!;
  const node = page.locator(`.tree-node[data-session-id="${id}"]`);
  await expect(node).toBeVisible({ timeout: 8000 });

  // Let the turn fully settle before archiving. Archiving mid-stream races the
  // turn's trailing session.idle, which can re-hydrate the just-archived session
  // back into the live tree — so wait for the assistant response to complete.
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 8000 });

  // Right-click the chat header title → positioned context menu.
  await page.locator(".main-title.has-menu").click({ button: "right" });
  const menu = page.locator(".ctxm-menu");
  await expect(menu).toBeVisible();
  // Copy is now a labelled group with Title / Session id / Title + id entries.
  await expect(menu).toContainText("Copy");
  await expect(menu).toContainText("Session id");
  await expect(menu).toContainText("Title + id");

  // Archive… → confirmation lists the related sessions (just this one).
  await menu.getByText("Archive…").click();
  const confirm = page.getByRole("dialog", { name: "Confirm archive" });
  await expect(confirm).toBeVisible();
  await expect(confirm.locator(".confirm-list li")).toHaveCount(1);
  await confirm.getByRole("button", { name: /Archive/ }).click();

  // Confirmed → this specific session leaves the live tree for good.
  await expect(node).toHaveCount(0, { timeout: 8000 });
});

test("right-click → Rename updates the session title", async ({ page }) => {
  await page.goto(projectUrl("/"));
  // Use a fresh session so we don't rename the shared demo session.
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByPlaceholder("Message…").fill("rename me");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tree-node", { hasText: "New session" }).first()).toBeVisible({ timeout: 8000 });

  await page.locator(".main-title.has-menu").click({ button: "right" });
  const menu = page.locator(".ctxm-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Regenerate name");

  await menu.getByText("Rename…").click();
  const input = page.locator(".vh-prompt-input");
  await expect(input).toBeVisible();
  await input.fill("Renamed via menu");
  await page.locator(".vh-prompt .confirm-go").click();
  await expect(page.locator(".main-title")).toContainText("Renamed via menu", { timeout: 8000 });
});

test("right-click → Regenerate name asks the model then confirms the new title", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByPlaceholder("Message…").fill("name me");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tree-node", { hasText: "New session" }).first()).toBeVisible({ timeout: 8000 });

  await page.locator(".main-title.has-menu").click({ button: "right" });
  const menu = page.locator(".ctxm-menu");
  await expect(menu).toBeVisible();

  // Regenerate calls the model (fixture generate-name → "fixture-generated-name")
  // and pre-fills the confirm dialog with the de-slugified suggestion; confirming
  // applies it. Asserts the LLM→deslugify→confirm→PATCH path.
  await menu.getByText("Regenerate name").click();
  const input = page.locator(".vh-prompt-input");
  await expect(input).toHaveValue("Fixture generated name", { timeout: 8000 });
  await page.locator(".vh-prompt .confirm-go").click();
  await expect(page.locator(".main-title")).toContainText("Fixture generated name", { timeout: 8000 });
});

test("settings → usage shows multi-provider quota with pace", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Usage" }).click();

  // Fixture quota: Claude (two windows) + OpenRouter (credits).
  await expect(dialog.locator(".quota-name", { hasText: "Claude" })).toBeVisible();
  await expect(dialog.locator(".quota-name", { hasText: "OpenRouter" })).toBeVisible();
  await expect(dialog.locator(".quota-win-label", { hasText: "5h" })).toBeVisible();
  await expect(dialog).toContainText("$14.00 remaining");
  // The 7d window is at 88% with a short reset → pace predicts exhaustion before reset.
  await expect(dialog.locator(".quota-pace", { hasText: "exhausts" })).toBeVisible();
});
