import { expect, test, type Page } from "@playwright/test";

// The dismiss directive (lib/a11y.ts) arms its keydown (Escape) + click
// (outside-click) listeners on a setTimeout(0) AFTER the overlay mounts — so the
// click that opened the dialog can't immediately dismiss it. A test that opens
// the dialog and then presses Escape in the very next step can race ahead of
// that arming (toBeVisible resolves synchronously with the mount, before the
// arming macrotask fires) and the Escape is lost. Yield one page event-loop turn
// so the listener is attached before relying on Escape dismissal.
async function armDismiss(page: Page) {
  await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 0)));
}

// The project switcher opens as a DIALOG (Slice 1): clicking the .proj-current
// trigger mounts a .dialog-overlay/.dialog containing the project rows, recents,
// and "Add project…" entry. Selecting a project still drives the existing
// switchProject / ?dir= flow (no new routing).

test("project switcher opens a dialog, marks the active project, and re-scopes the session tree", async ({ page }) => {
  await page.goto("/");
  // No project is selected by default (the daemon's cwd is not a meaningful
  // project), so the switcher trigger invites the user to pick one.
  await expect(page.locator(".proj-name")).toContainText("Select project");

  // Open the switcher dialog and pin alpha via the recents entry — it becomes
  // the active project and scopes the tree to its synthetic session.
  await page.locator(".proj-current").click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".proj-name")).toContainText("alpha", { timeout: 8000 });
  await expect(page.locator(".tree-node", { hasText: "Project: alpha" })).toBeVisible({ timeout: 8000 });

  // Reopen; alpha is now the active pinned row (marked with the .on tint).
  await page.locator(".proj-current").click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();
  await expect(page.locator(".proj-item.on", { hasText: /alpha/ })).toBeVisible();

  // Add a project via the dialog (DOM prompt → a directory path).
  await page.getByRole("button", { name: /Add project/ }).click();
  await page.locator(".vh-prompt-input").fill("/work/projectx");
  await page.locator(".vh-prompt .confirm-go").click();

  // The UI re-scopes: the switcher shows the new project and the tree shows ITS
  // sessions (fixture returns one synthetic session per directory), not alpha's.
  await expect(page.locator(".proj-name")).toContainText("projectx", { timeout: 8000 });
  await expect(page.locator(".tree-node", { hasText: "Project: projectx" })).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".tree-node", { hasText: "Project: alpha" })).toHaveCount(0);

  // The workspace is encoded in the URL so the tab is self-describing (survives
  // reload, supports a per-tab workspace).
  await expect.poll(() => new URL(page.url()).searchParams.get("dir")).toBe("/work/projectx");
  await page.reload();
  await expect(page.locator(".tree-node", { hasText: "Project: projectx" })).toBeVisible({ timeout: 8000 });

  // Switching back to alpha (a pinned row) restores its sessions.
  await page.locator(".proj-current").click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".tree-node", { hasText: "Project: alpha" })).toBeVisible({ timeout: 8000 });
});

test("project switcher offers OpenCode recents to pin", async ({ page }) => {
  await page.goto("/");
  await page.locator(".proj-current").click();
  await expect(page.locator(".dialog.projects-dialog")).toBeVisible();

  // Recent section lists projects from OpenCode (GET /project), newest first.
  await expect(page.locator(".proj-section", { hasText: /Recent/ })).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();
  await expect(page.locator(".proj-item-name", { hasText: "beta" })).toBeVisible();
  // alpha is returned twice by OpenCode (same worktree, different ids) — the
  // recents list must dedupe by directory and show it exactly once.
  await expect(page.locator(".proj-item-name", { hasText: "alpha" })).toHaveCount(1);

  // Picking a recent pins it and re-scopes to that project.
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".proj-name")).toContainText("alpha", { timeout: 8000 });
});

test("project switcher shows a running badge for a non-active workspace", async ({ browser }) => {
  // Fresh context (own localStorage) so this is self-contained.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const api = ctx.request;

  await page.goto("/");
  // Pin + scope to /work/alpha via the recents entry. This makes the worker
  // lazily create the alpha aggregator and hydrate its synthetic session
  // (id "proj_alpha", directory /work/alpha).
  await page.locator(".proj-current").click();
  await expect(page.locator(".dialog.projects-dialog")).toBeVisible();
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".proj-name")).toContainText("alpha", { timeout: 8000 });

  // Bridge the alpha aggregator DETERMINISTICALLY. Switching via the SPA opens a
  // /vh/stream?dir=/work/alpha EventSource whose handler runs aggFor("/work/alpha")
  // → create + Run + hydrate, but the EventSource connect + hydrate is timing-
  // variable. A direct snapshot GET with the same ?dir= runs aggFor on the same
  // server (idempotent — it reuses the aggregator if the stream already made it)
  // and blocks until the snapshot is computed, so by the time it returns the alpha
  // aggregator exists, has hydrated proj_alpha, and (Run opens the tail before
  // hydrating) is subscribed to the fake /event stream. This removes the
  // EventSource-connect race without changing any production code path.
  await expect.poll(
    async () => (await api.get("/vh/snapshot?sessions=&dir=/work/alpha")).status(),
    { timeout: 10000 },
  ).toBe(200);

  // GATE before emitting the busy event: once /vh/projects reports alpha's
  // synthetic session, the alpha aggregator is hydrated and (Run opens the
  // SubscribeEvents tail before hydrating) subscribed to the fake /event stream —
  // otherwise the session.status emit below (no replay) is lost.
  await expect
    .poll(
      async () => {
        const r = await api.get("/vh/projects");
        const j = (await r.json()) as { dir: string; roots: number }[];
        return (j ?? []).some((p) => p.dir === "/work/alpha" && p.roots >= 1);
      },
      { timeout: 10000 },
    )
    .toBeTruthy();

  // Mark proj_alpha busy via the test-only fixture hook (sticky until reset).
  // The X-VH-CSRF header is required on POST (csrfGuard covers /oc/* and /vh/*).
  // The alpha aggregator is long-lived in the worker's s.aggs and stays
  // subscribed to the fake /event stream, so the session.status reaches it and
  // bumps busyCount. RETRY the emit a few times: aggregator.Run opens its
  // SubscribeEvents tail in a goroutine and then hydrates, so hydration (the gate
  // above) does not strictly guarantee the /event subscription is open yet, and
  // the emit is fire-once with no replay. setActivityLocked no-ops on a busy→busy
  // repeat, so re-emitting cannot double-count.
  const csrf = { "X-VH-CSRF": "1" };
  let alphaRunning = false;
  for (let i = 0; i < 12 && !alphaRunning; i++) {
    await api.post("/oc/fixture/busy?session=proj_alpha", { headers: csrf });
    const r = await api.get("/vh/running-sessions");
    const j = (await r.json()) as { workspaces?: { dir: string }[] };
    alphaRunning = (j.workspaces ?? []).some((w) => w.dir === "/work/alpha");
    if (!alphaRunning) await page.waitForTimeout(250);
  }
  expect(alphaRunning).toBe(true);

  // Pin beta via recents and switch to it so alpha becomes a NON-active pinned
  // row (no synthetic Default project exists anymore — beta takes the active slot).
  await page.locator(".proj-current").click();
  await page.locator(".proj-pick", { hasText: "beta" }).click();
  await expect(page.locator(".proj-name")).toContainText("beta", { timeout: 8000 });

  // Reopen the dialog: the alpha row shows a running badge (it is not the active
  // project, so its activity comes from the endpoint).
  await page.locator(".proj-current").click();
  await expect(page.locator(".dialog.projects-dialog")).toBeVisible();
  const alphaRow = page.locator(".proj-item", { hasText: "alpha" });
  await expect(alphaRow).toBeVisible();
  await expect(alphaRow).not.toHaveClass(/\bon\b/); // not the active project
  await expect(alphaRow.locator(".proj-badge.run")).toBeVisible({ timeout: 8000 });
  // proj_alpha is the single root in /work/alpha and is busy, so the badge reads
  // "1 running" (idle = roots − running = 0, omitted). The old "N sessions" label
  // must be gone (the field was renamed sessions → roots and the badge now shows
  // running/idle, never "sessions").
  await expect(alphaRow.locator(".proj-badge.run")).toContainText(/1 running/);
  await expect(alphaRow.locator(".proj-badge.run")).not.toContainText(/sessions/);

  // Cleanup so the sticky busy state doesn't leak into later serial tests.
  await api.post("/oc/fixture/reset?session=proj_alpha", { headers: { "X-VH-CSRF": "1" } });
  await ctx.close();
});

test("project switcher filters rows by search and shows a no-results state", async ({ page }) => {
  await page.goto("/");
  await page.locator(".proj-current").click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();

  // The search input lives in the dialog head (reuses the .dialog-search styling).
  const search = page.getByLabel("Search projects");
  await expect(search).toBeVisible();

  // Initially the list shows the OpenCode recents (alpha, beta) — no synthetic
  // default row exists anymore (the daemon's cwd is not a meaningful project).
  await expect(page.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();
  await expect(page.locator(".proj-item-name", { hasText: "beta" })).toBeVisible();

  // Typing a query matching only alpha (by name) hides beta.
  await search.fill("alpha");
  await expect(page.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();
  await expect(page.locator(".proj-item-name", { hasText: "beta" })).toHaveCount(0);

  // Matching by directory works too (case-insensitive): "WORK" hits both
  // /work/alpha and /work/beta.
  await search.fill("WORK");
  await expect(page.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();
  await expect(page.locator(".proj-item-name", { hasText: "beta" })).toBeVisible();

  // A query that matches nothing shows the no-results message and no rows.
  // ("Add project…" is .proj-add, NOT .proj-item, so it stays reachable.)
  await search.fill("zzzznomatch");
  await expect(page.locator(".proj-empty", { hasText: /No matching/ })).toBeVisible();
  await expect(page.locator(".proj-item")).toHaveCount(0);
  await expect(page.locator(".proj-add")).toBeVisible();

  // Clearing the query restores the full list.
  await search.fill("");
  await expect(page.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();
  await expect(page.locator(".proj-item-name", { hasText: "beta" })).toBeVisible();
});

// F6 regression guard: a search filter typed in one open of the switcher must
// NOT persist across close/reopen. The open-setup (clearing query + refetching
// recents/activity) lives in a createEffect keyed on open(), so EVERY opener
// shares one path — including the no-project empty-state CTA (NoProjectState →
// setProjSwitcherOpen(true)), which previously bypassed the toggle()-only
// setup and rendered with a stale filter. The CTA path is hard to exercise
// from within a project (the no-project state only shows when projectDir()===""),
// so this guards the shared open-setup via the sidebar trigger reopen, which
// the CTA also drives. Assert the search input is empty AND the filtered-out
// rows are visible again after reopen.
test("project switcher clears a stale search filter on close/reopen", async ({ page }) => {
  await page.goto("/");
  await page.locator(".proj-current").click();
  const dialog = page.getByRole("dialog", { name: "Switch project" });
  await expect(dialog).toBeVisible();
  const search = dialog.getByLabel("Search projects");

  // Recents (alpha, beta) are both visible before any filtering.
  await expect(dialog.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();
  await expect(dialog.locator(".proj-item-name", { hasText: "beta" })).toBeVisible();

  // Typing "alpha" hides beta (filtered out by the substring match).
  await search.fill("alpha");
  await expect(dialog.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();
  await expect(dialog.locator(".proj-item-name", { hasText: "beta" })).toHaveCount(0);

  // Close (backdrop click) then reopen via the same sidebar trigger. The
  // open-setup effect clears the query on the rising edge of open().
  await page.locator(".dialog-overlay").click({ position: { x: 8, y: 8 } });
  await expect(dialog).not.toBeVisible();

  await page.locator(".proj-current").click();
  const reopened = page.getByRole("dialog", { name: "Switch project" });
  await expect(reopened).toBeVisible();

  // The search input is empty again and BOTH rows are visible (no stale filter).
  await expect(reopened.getByLabel("Search projects")).toHaveValue("");
  await expect(reopened.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();
  await expect(reopened.locator(".proj-item-name", { hasText: "beta" })).toBeVisible();
});

// Slice 3: removing a pinned project requires an inline confirmation, so a stray
// tap can't drop a project. The row swaps its remove (✕) button for inline
// Confirm/Cancel controls — no separate dialog, no window.confirm. Only one row
// may be in confirm state at a time (starting remove on another row supersedes).
test("project switcher confirms inline before removing a pinned project", async ({ browser }) => {
  // Fresh context (own localStorage) so pin state is self-contained and this
  // doesn't depend on prior serial tests.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");

  // Pin alpha + beta via recents so there are TWO removable pinned rows.
  await page.locator(".proj-current").click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".proj-name")).toContainText("alpha", { timeout: 8000 });

  await page.locator(".proj-current").click();
  await page.locator(".proj-pick", { hasText: "beta" }).click();
  await expect(page.locator(".proj-name")).toContainText("beta", { timeout: 8000 });

  // Reopen; both alpha and beta are now pinned (removable) rows.
  await page.locator(".proj-current").click();
  const dialog = page.getByRole("dialog", { name: "Switch project" });
  await expect(dialog).toBeVisible();

  // (1) Clicking remove does NOT remove immediately: the inline confirm controls
  // appear, and alpha is still listed. (Semantic locators for the new controls.)
  await dialog.getByRole("button", { name: "Remove alpha", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm remove alpha", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel remove alpha", exact: true })).toBeVisible();
  await expect(dialog.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();

  // (2) Only ONE row can be pending at a time: starting remove on beta supersedes
  // alpha's confirm — beta is now confirming, alpha reverted to its normal button.
  await dialog.getByRole("button", { name: "Remove beta", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm remove beta", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm remove alpha", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Remove alpha", exact: true })).toBeVisible();

  // (3) Cancel keeps the project pinned: beta's confirm controls vanish and beta
  // is still removable (its remove button is back).
  await dialog.getByRole("button", { name: "Cancel remove beta", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm remove beta", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Remove beta", exact: true })).toBeVisible();

  // (4) Confirm actually unpins: start alpha's confirm, then confirm it. alpha's
  // remove button is gone afterwards (recents have NO remove buttons, so an
  // absent "Remove alpha" button proves alpha is no longer pinned even if it
  // reappears under "Recent (OpenCode)").
  await dialog.getByRole("button", { name: "Remove alpha", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm remove alpha", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove alpha", exact: true })).toHaveCount(0);

  await ctx.close();
});

// --- Dismissal + confirm-reset state machine (the F1 regression surface) ---
// The use:dismiss wiring bug silently disabled BOTH outside-click and Escape
// dismissal. These verify dismissal (Escape + backdrop click) and the pending-
// confirm reset branches. Locators are semantic (getByRole dialog/button,
// getByLabel) for dialog-open and confirm/cancel controls; the backdrop click
// targets the structural .dialog-overlay element (an action target, not a
// state assertion, so it is not subject to the pre-existing CSS-selector flake).

// Escape with no inline confirm pending closes the whole dialog (onEscape ->
// setOpen(false)). This is one of the branches F1 had dead.
test("project switcher closes on Escape when no confirm is pending", async ({ page }) => {
  await page.goto("/");
  await page.locator(".proj-current").click();
  const dialog = page.getByRole("dialog", { name: "Switch project" });
  await expect(dialog).toBeVisible();

  // With no inline confirm pending, Escape closes the whole dialog. Arm first —
  // see armDismiss — so the press doesn't race the directive's setTimeout(0).
  await armDismiss(page);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

// Clicking the overlay backdrop (outside the centered .dialog panel) closes the
// dialog (onClose -> setOpen(false)). The other branch F1 had dead.
test("project switcher closes on an outside (backdrop) click", async ({ page }) => {
  await page.goto("/");
  await page.locator(".proj-current").click();
  const dialog = page.getByRole("dialog", { name: "Switch project" });
  await expect(dialog).toBeVisible();

  // The overlay is fixed full-screen (inset:0) with 16px padding around the
  // centered 480px dialog, so a point in the top-left padding band is guaranteed
  // off the panel and lands on the overlay backdrop.
  const overlay = page.locator(".dialog-overlay");
  await overlay.click({ position: { x: 8, y: 8 } });
  await expect(dialog).not.toBeVisible();
});

// Escape while an inline confirm is pending cancels the confirm (Split mode:
// onEscape differs from onClose) and keeps the dialog open.
test("project switcher: Escape cancels a pending confirm and keeps the dialog open", async ({ browser }) => {
  // Fresh context (own localStorage) so pin state is self-contained.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");

  // Pin alpha via recents so it is a removable pinned row.
  await page.locator(".proj-current").click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".proj-name")).toContainText("alpha", { timeout: 8000 });

  // Reopen and start alpha's inline confirm.
  await page.locator(".proj-current").click();
  const dialog = page.getByRole("dialog", { name: "Switch project" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove alpha", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm remove alpha", exact: true })).toBeVisible();

  // Escape cancels the confirm (alpha's normal remove button returns) but does
  // NOT close the dialog.
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: "Confirm remove alpha", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Remove alpha", exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();

  await ctx.close();
});

// A pending confirm must not survive a dialog close/reopen (the createEffect
// that resets pendingRemove when open() goes false).
test("project switcher: a pending confirm resets when the dialog closes and reopens", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");

  await page.locator(".proj-current").click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".proj-name")).toContainText("alpha", { timeout: 8000 });

  // Open, start alpha's confirm, then close via the X button.
  await page.locator(".proj-current").click();
  const dialog = page.getByRole("dialog", { name: "Switch project" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove alpha", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm remove alpha", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  // Reopen: no confirm lingers — alpha shows its normal remove button, not the
  // confirm cluster.
  await page.locator(".proj-current").click();
  const reopened = page.getByRole("dialog", { name: "Switch project" });
  await expect(reopened).toBeVisible();
  await expect(reopened.getByRole("button", { name: "Confirm remove alpha", exact: true })).toHaveCount(0);
  await expect(reopened.getByRole("button", { name: "Remove alpha", exact: true })).toBeVisible();

  await ctx.close();
});

// Typing into search cancels a pending confirm (the onInput handler resets
// pendingRemove alongside setQuery).
test("project switcher: typing in search cancels a pending confirm", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");

  await page.locator(".proj-current").click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".proj-name")).toContainText("alpha", { timeout: 8000 });

  await page.locator(".proj-current").click();
  const dialog = page.getByRole("dialog", { name: "Switch project" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove alpha", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm remove alpha", exact: true })).toBeVisible();

  // "alpha" keeps alpha in the filtered list so the row/remove-button assertion
  // is robust to list re-filtering.
  const search = dialog.getByLabel("Search projects");
  await search.fill("alpha");
  await expect(dialog.getByRole("button", { name: "Confirm remove alpha", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Remove alpha", exact: true })).toBeVisible();

  await ctx.close();
});

// Slice 5: every non-default project row has a "Copy link" button that writes
// the per-project deep link (${origin}${pathname}?dir=<encoded dir>) to the
// clipboard, so an operator can grab/share/bookmark a per-project URL. This
// verifies the URL is built correctly AND that the click actually lands in the
// clipboard (the primary behavior). The URL is also exposed via a data-link
// attribute as a deterministic cross-check (clipboard read can be flaky). The
// recents row is used here (the fixture serves alpha/beta at "/"), but pinned
// rows carry the SAME button (CopyLinkButton is shared).
test("project switcher: Copy link writes the per-project deep link to the clipboard", async ({ browser }) => {
  // Fresh context so clipboard permissions + localStorage are self-contained.
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  await page.goto("/");

  // The expected deep link is built from the page's own origin+pathname so it
  // is robust to the fixture's random port. pathname is "/", so the base is the
  // origin with a trailing slash (matches ProjectSwitcher.projectLink).
  const u = new URL(page.url());
  const base = `${u.origin}${u.pathname}`;
  const expected = `${base}?dir=${encodeURIComponent("/work/alpha")}`;

  await page.locator(".proj-current").click();
  const dialog = page.getByRole("dialog", { name: "Switch project" });
  await expect(dialog).toBeVisible();

  // alpha is in the recents list (GET /project). Its row has a Copy link button.
  // The deterministic cross-check: data-link carries the exact URL the click
  // will write, proving buildProjectLink output before involving the clipboard.
  const copyBtn = dialog.getByRole("button", { name: "Copy link to alpha", exact: true });
  await expect(copyBtn).toBeVisible();
  await expect(copyBtn).toHaveAttribute("data-link", expected);

  // Click writes the URL to the clipboard. Read it back via the async Clipboard
  // API (granted above) and assert it equals the built deep link.
  await copyBtn.click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
    .toBe(expected);

  // The copied confirmation flips the icon (copy→check) + aria-label + tints the
  // button .copied for ~1.5s. Assert the label swap as a cheap confirmation-UX
  // check (the class/icon are covered by the unit + visual layers).
  await expect(dialog.getByRole("button", { name: "Copied link to alpha", exact: true })).toBeVisible();

  await ctx.close();
});
