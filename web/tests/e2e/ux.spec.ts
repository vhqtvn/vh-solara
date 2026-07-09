import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Fixture-backed tests for the parallel-session / permission UX.

test("sending a prompt shows a working spinner that returns to idle", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.getByPlaceholder("Message…").fill("hello");
  await page.keyboard.press("Enter");
  // The session's sidebar shows the opencode-style working spinner during the
  // streamed turn (replacing the old blinking dot)...
  await expect(page.locator(".tree-node .tree-spinner").first()).toBeVisible({ timeout: 5000 });
  // ...and the chat shows the "Working…" shimmer (driven by the busy activity
  // signal, not just an in-flight assistant message)...
  await expect(page.locator(".working-text")).toBeVisible();
  // ...and both settle when the turn completes.
  await expect(page.locator(".tree-node .tree-spinner")).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 8000 });
});

test("a message sent while busy is queued, then auto-sent when the turn finishes", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  const composer = page.getByPlaceholder("Message…");
  // Start a turn that stays busy for several seconds.
  await composer.fill("[[stall]] busy a while");
  await page.keyboard.press("Enter");
  await expect(page.locator(".send-btn.stop")).toBeVisible({ timeout: 5000 });

  // Sending now queues instead of erroring; a Queue button appears beside Stop.
  await composer.fill("queued follow-up");
  await expect(page.locator(".send-btn.queue")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".queue-chip", { hasText: "queued follow-up" })).toBeVisible();

  // When the stalled turn ends, the queue drains: the chip clears and the
  // message is actually sent (appears as a user message).
  await expect(page.locator(".queue-chip", { hasText: "queued follow-up" })).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator(".msg.user", { hasText: "queued follow-up" })).toBeVisible({ timeout: 15000 });
});

test("Up-arrow recalls a previously sent prompt", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  const composer = page.getByPlaceholder("Message…");
  await composer.fill("first prompt for history");
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("");
  // Caret is at the start of the empty composer → Up recalls the last sent prompt.
  await composer.focus();
  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue("first prompt for history");
  // Down steps back to the (empty) live draft.
  await page.keyboard.press("ArrowDown");
  await expect(composer).toHaveValue("");
});

test("Stop clears the working indicator immediately (abort)", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  // [[stall]] keeps the turn busy server-side for several seconds.
  await page.getByPlaceholder("Message…").fill("[[stall]] hang please");
  await page.keyboard.press("Enter");
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 5000 });

  // Stop aborts on the server AND clears the local working state right away.
  // The fixture's OpenCode layer emits no idle on abort (like real OpenCode);
  // the /vh/abort verb marks the session idle authoritatively server-side, and
  // the client clears optimistically too — so the indicator must be gone at
  // once and STAY gone (a reconnect snapshot can't re-arm a stopped turn).
  await page.locator(".send-btn.stop").click();
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 2000 });
  await expect(page.locator(".tree-node .tree-spinner")).toHaveCount(0, { timeout: 2000 });
});

test("New session defers creation until the first message is sent", async ({ page }) => {
  await page.goto(projectUrl("/"));
  const treeNew = page.locator(".tree-node", { hasText: "New session" });
  const before = await treeNew.count();

  // Clicking New opens a draft composer WITHOUT creating a server session.
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.locator(".composer")).toBeVisible();
  await expect(treeNew).toHaveCount(before); // no new session yet

  // Sending the first message materializes the session in the tree.
  await page.getByPlaceholder("Message…").fill("first message");
  await page.keyboard.press("Enter");
  await expect(treeNew).toHaveCount(before + 1, { timeout: 8000 });
});

test("a permission request shows an actionable card that Reject dismisses", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.getByPlaceholder("Message…").fill("[[perm]] please run it");
  await page.keyboard.press("Enter");
  const card = page.locator(".perm-card");
  await expect(card).toBeVisible({ timeout: 5000 });
  // The card names the category and shows the concrete command being requested.
  await expect(card.locator(".perm-title")).toContainText("bash");
  await expect(card.locator(".perm-detail")).toContainText("rm -rf /tmp/scratch");
  await card.getByRole("button", { name: "Reject" }).click();
  await expect(page.locator(".perm-card")).toHaveCount(0, { timeout: 5000 });
});
