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

// Gate-A acceptance test: a HUNG prompt_async socket (server never responds)
// MUST NOT silently lose the message. With enqueue-first, the composer clears
// ONLY after durable custody is confirmed; the message persists as a visible
// queue chip; after the bounded dispatch timeout it resolves to `unknown` (not
// `sent`, not removed); and exactly ONE prompt_async is issued (no auto-retry).
// After a reload the `unknown` chip + text + attachment identity survive.
//
// This is the deterministic reproduction of the original send-loss bug: the old
// 2.5s ACCEPTED_AFTER_MS race resolved "accepted" on a hung socket, the composer
// was cleared, and the message was gone (OpenCode never received it).
test("hung prompt_async never silently loses the message (enqueue-first + bounded dispatch timeout)", async ({ page }) => {
  test.setTimeout(90000); // 12s dispatch timeout + overhead + reload

  // Block the PWA service worker from registering for THIS test. Once a service
  // worker controls the page, Playwright's request route interception can be
  // bypassed for the page's fetches (the SW sits in the request path). In the
  // serial suite, prior tests warm+activate the SW; without blocking it, the
  // prompt_async route below never fires and the hung-socket simulation leaks
  // through to the fixture (the message echoes as a real turn). Registered
  // before page.goto so the SW script never loads.
  await page.route("**/sw.js*", (route) => route.abort());
  // Likewise drop any SW already registered in this fresh context.
  for (const sw of page.context().serviceWorkers()) {
    await sw.close();
  }

  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  const composer = page.getByPlaceholder("Message…");

  // Intercept prompt_async and delay the response PAST the drainer's bounded
  // dispatch timeout (12s default) — this deterministically reproduces a
  // hung/dropped socket: the drainer's AbortController fires at 12s, the fetch
  // rejects with AbortError, and the item resolves to `unknown`. We count
  // dispatches to assert exactly one (no auto-retry on timeout/abort).
  //
  // Implementation notes:
  //  - Page-level route (matches repo convention: "**/<endpoint>*" glob with a
  //    trailing wildcard, as used for /vh/project-settings* and /vh/version).
  //  - We DO call route.fulfill() (after the delay) so Playwright considers the
  //    route handled. By then the drainer has already aborted the fetch, so the
  //    fulfillment is a no-op for the (already-rejected) client request.
  //  - Counted at both the route layer and the page "request" event so a
  //    failure distinguishes "route never matched" from a genuine double-dispatch.
  let routeSeen = 0;
  let pageSeen = 0;
  page.on("request", (req) => {
    if (req.url().includes("/prompt_async")) {
      pageSeen++;
    }
  });
  await page.route("**/prompt_async*", async (route) => {
    routeSeen++;
    // Delay longer than the 12s dispatch timeout so the AbortController wins.
    await new Promise((r) => setTimeout(r, 20000));
    // The client fetch already aborted at ~12s; fulfill to close the route.
    await route.fulfill({ status: 204 }).catch(() => {});
  });

  // Paste an attachment so we also verify attachment metadata survives the
  // dispatch timeout (not just the text). Uses the synthetic ClipboardEvent
  // approach — no clipboard permissions needed (the event carries clipboardData).
  const marker = `hung-${Date.now()}`;
  await composer.evaluate((el) => {
    const dt = new DataTransfer();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    dt.items.add(new File([bytes], "hung-shot.png", { type: "image/png" }));
    Object.defineProperty(dt, "files", { get: () => [] as unknown as FileList });
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  // Wait for the live-session upload to produce the attachment chip.
  await expect(page.locator(".attach-chip", { hasText: "hung-shot.png" })).toBeVisible({ timeout: 8000 });

  // Type the marker + send. With enqueue-first the composer clears ONLY after
  // the enqueue POST confirms durable custody — even though prompt_async hangs.
  await composer.fill(marker);
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("", { timeout: 8000 });
  // The attachment chip cleared too (only after enqueue confirmed custody).
  await expect(page.locator(".attach-chip", { hasText: "hung-shot.png" })).toHaveCount(0, { timeout: 8000 });

  // The message is now a VISIBLE queue chip (dispatching — the drainer claimed
  // it and is stuck on the hung prompt_async). It must NOT be silently gone.
  const chip = page.locator(".queue-chip", { hasText: marker });
  await expect(chip).toBeVisible({ timeout: 8000 });

  // After the bounded dispatch timeout (12s default), the AbortController fires,
  // the fetch rejects, and the item resolves to `unknown` — NOT `sent`, NOT
  // removed. The text + attachment identity persist in the chip.
  await expect(chip).toHaveAttribute("data-state", "unknown", { timeout: 20000 });

  // Exactly ONE prompt_async was issued — no auto-retry (abort/timeout is
  // ambiguous: the POST may have reached OpenCode, so re-dispatch risks a dup).
  expect(routeSeen).toBe(1);
  expect(pageSeen).toBe(1);

  // After a reload, the `unknown` chip survives (backend-authoritative queue).
  await page.reload();
  await expect(page.locator(".queue-chip", { hasText: marker })).toHaveAttribute("data-state", "unknown", { timeout: 10000 });
  // Still exactly one dispatch total (reload doesn't re-dispatch terminal items).
  expect(routeSeen).toBe(1);
  expect(pageSeen).toBe(1);
});

// Finding #1 regression: retry() reuses sendText() to resend an OLD message. The
// old (buggy) sendText() cleared the composer after enqueue, so retrying an old
// message erased whatever NEW draft the operator was typing. The fix makes
// sendText() custody-only (it never touches the composer); only the composer
// send() path clears, and only under an ownership guard. So a retry MUST leave
// the current draft untouched.
test("retry of an old message does not erase a new composer draft", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  const composer = page.getByPlaceholder("Message…");

  // Send a first user message and wait for it to land in the transcript.
  const original = `retry-me-${Date.now()}`;
  await composer.fill(original);
  await page.keyboard.press("Enter");
  const firstMsg = page.locator(".msg.user", { hasText: original }).first();
  await expect(firstMsg).toBeVisible({ timeout: 8000 });

  // Type a NEW, unrelated draft. This is what must survive the retry.
  await composer.fill("new draft must survive");
  await expect(composer).toHaveValue("new draft must survive");

  // Retry the OLD message. sendText() is shared by retry(); before the fix it
  // cleared the composer and erased the new draft. Hover reveals the action row
  // (.msg-actions is opacity:0 until .msg:hover).
  await firstMsg.hover();
  await firstMsg.locator('button[aria-label="Retry"]').click();

  // The new draft survives: sendText() is custody-only and retry()'s caller
  // does not own the composer, so nothing is cleared.
  await expect(composer).toHaveValue("new draft must survive");
});

// Finding #2: a slow enqueue (up to 12s) leaves the composer editable. The old
// (buggy) sendText() unconditionally cleared the CURRENT input+attachments after
// the await, so state typed/attached DURING the enqueue wait was erased —
// directly contradicting the slice's no-silent-loss objective (the durable
// custody confirmation applies to the snapshot, not to state entered after). The
// fix adds an ownership guard in send(): it captures the snapshot before enqueue
// and clears ONLY if the composer still holds that exact state. This test
// delays the enqueue POST, types a new draft while it is in flight, and asserts
// the new draft survives the first enqueue's completion.
test("a slow enqueue does not erase text typed after Send (ownership guard)", async ({ page }) => {
  test.setTimeout(60000);

  // Block the PWA service worker for this test (same reason as the hung-socket
  // test: once a SW controls the page, Playwright's request route interception
  // can be bypassed for the page's fetches, and we must reliably intercept the
  // enqueue POST below). Registered before page.goto so the SW never loads.
  await page.route("**/sw.js*", (route) => route.abort());
  for (const sw of page.context().serviceWorkers()) {
    await sw.close();
  }

  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  const composer = page.getByPlaceholder("Message…");

  // Delay ONLY the enqueue POST (the durable-custody write). GETs (fetchQueue)
  // pass through unchanged so the UI keeps functioning. The composer stays
  // editable for the whole delay — the exact scenario from finding #2.
  await page.route("**/queue*", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });

  // Send A. send() snapshots A's text and awaits the (delayed) enqueue.
  const marker = `alpha-${Date.now()}`;
  await composer.fill(marker);
  await page.keyboard.press("Enter");

  // While A's enqueue is still in flight, type a NEW draft B. Before the fix,
  // A's enqueue completing would unconditionally clear the composer and erase B.
  await composer.fill("beta new draft");
  await expect(composer).toHaveValue("beta new draft");

  // A's enqueue eventually confirms durable custody: a queue chip appears (or,
  // if the session is idle and dispatches immediately, the message lands in the
  // transcript). Either proves A was confirmed while B sat in the composer.
  await expect(page.locator(".queue-chip, .msg.user", { hasText: marker })).toBeVisible({ timeout: 10000 });

  // The NEW draft B survives: the ownership guard saw input() !== snapText and
  // refused to clear. (Before the fix, the composer would be "" here.)
  await expect(composer).toHaveValue("beta new draft");
});
