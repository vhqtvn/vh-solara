import { expect, test } from "@playwright/test";

// The project switcher opens as a DIALOG (Slice 1): clicking the .proj-current
// trigger mounts a .dialog-overlay/.dialog containing the project rows, recents,
// and "Add project…" entry. Selecting a project still drives the existing
// switchProject / ?dir= flow (no new routing).

test("project switcher opens a dialog, marks the active project, and re-scopes the session tree", async ({ page }) => {
  await page.goto("/");
  // Default project shows the seeded demo sessions.
  await expect(page.locator(".tree-node", { hasText: "Demo session" })).toBeVisible();
  await expect(page.locator(".proj-name")).toContainText("Default");

  // Open the switcher dialog.
  await page.locator(".proj-current").click();
  await expect(page.locator(".dialog.projects-dialog")).toBeVisible();

  // The active project (Default) is marked with the .on row tint.
  await expect(page.locator(".proj-item.on", { hasText: /Default/ })).toBeVisible();

  // Add a project via the dialog (DOM prompt → a directory path).
  await page.getByRole("button", { name: /Add project/ }).click();
  await page.locator(".vh-prompt-input").fill("/work/projectx");
  await page.locator(".vh-prompt .confirm-go").click();

  // The UI re-scopes: the switcher shows the new project and the tree shows ITS
  // sessions (fixture returns one synthetic session per directory), not demo's.
  await expect(page.locator(".proj-name")).toContainText("projectx", { timeout: 8000 });
  await expect(page.locator(".tree-node", { hasText: "Project: projectx" })).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".tree-node", { hasText: "Demo session" })).toHaveCount(0);

  // The workspace is encoded in the URL so the tab is self-describing (survives
  // reload, supports a per-tab workspace).
  await expect.poll(() => new URL(page.url()).searchParams.get("dir")).toBe("/work/projectx");
  await page.reload();
  await expect(page.locator(".tree-node", { hasText: "Project: projectx" })).toBeVisible({ timeout: 8000 });

  // Switching back to Default restores the demo sessions. The Default row's
  // accessible name now carries its directory/badge text, so match by substring.
  await page.locator(".proj-current").click();
  await expect(page.locator(".dialog.projects-dialog")).toBeVisible();
  await page.getByRole("button", { name: /Default project/ }).click();
  await expect(page.locator(".tree-node", { hasText: "Demo session" })).toBeVisible({ timeout: 8000 });
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

  // Switch back to Default so alpha becomes a NON-active pinned row.
  await page.locator(".proj-current").click();
  await page.getByRole("button", { name: /Default project/ }).click();
  await expect(page.locator(".proj-name")).toContainText("Default", { timeout: 8000 });

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
