import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// NAMED LAYOUTS (host-web/src/dockview/namedLayouts.ts + the staged-layout
// seam in layoutPersistence.ts + the Settings → "Layouts…" manager).
//
// WHAT THIS SPEC PROVES (mission cruxes):
//   1. SAVE → STORAGE ROUND-TRIP: saving the active workspace's arrangement
//      under a name writes `vh-host:namedLayouts:v1` carrying the FRACTIONAL
//      v3 serialization (per-child `fraction`, not px `size`) + panel params
//      (urls/labels) — the same shape the workspace-set persistence writes.
//   2. LOAD = NEW WORKSPACE WITH THE SAVED ARRANGEMENT [CRUX]: after saving,
//      mutating the live layout, then loading, a NEW workspace appears
//      (count +1), is active, is named after the save, and its panes match
//      the SAVED shares (±2% — the proportions spec's tolerance) + params —
//      while the source workspace keeps its MUTATED arrangement and pane ids.
//   3. EXISTING-WORKSPACE SURVIVAL ACROSS A LOAD [CRUX]: a pane in another
//      (background) workspace and a pane in the SOURCE workspace both
//      assertSurvived across the whole load action — loading never touches a
//      live workspace's tree (no fromJSON on a live workspace, ever).
//   4. NEW WORKSPACE'S PANES ARE ALIVE: the loaded workspace's iframes are
//      FRESH documents (mountTs differs from the source panes'; heartbeats
//      arrive; liveness goes "alive") — an aliveness claim, NOT a survival
//      claim.
//   5. OVERWRITE: same name saved twice → one entry, latest arrangement wins.
//   6. DELETE: the row × removes the entry; the list updates.
//   7. EMPTY-WORKSPACE SAVE GUARD: Save current is aria-disabled + hinted.
//   8. PERSISTENCE ROUND-TRIP: after a load, a reload restores the loaded
//      workspace through the NORMAL persisted set (it is a regular workspace
//      now) with its arrangement.
//
// UI paths (open settings → Layouts… → save/load/delete) drive the REAL
// production surface; the DEV bridge is used only for arrangement (splits),
// reads, and the cross-workspace survival setup — the established pattern of
// this suite. Serial (host-web playwright.config.ts: workers 1); each test
// clears persisted state via addInitScript BEFORE the single app boot.
// =============================================================================

/** Share tolerance (absolute fraction-of-extent) — the proportions spec's
 *  ±2% (healthy paths measure within ±0.5%). */
const TOL = 0.02;

/** Build viewport (w/h=1.78 → wide → HORIZONTAL root split, so the two-pane
 *  arrangement shares are measured along "width"). */
const WIDE = { width: 1280, height: 720 };

/** Storage key namedLayouts.ts writes (must match the module). */
const NAMED_LAYOUTS_KEY = "vh-host:namedLayouts:v1";

// ---- geometry helpers (mirrored from proportions.spec.ts — file-local there;
//      copy kept local here too rather than widening the shared util) --------

/** Each pane's share of the total extent along `axis` (groupBox-based). */
async function shares(
  page: Page,
  ids: string[],
  axis: "width" | "height",
): Promise<number[]> {
  const boxes: number[] = [];
  for (const id of ids) {
    const b = await H.groupBox(page, id);
    expect(b, `groupBox for ${id}`).not.toBeNull();
    boxes.push(b![axis]);
  }
  const total = boxes.reduce((a, b) => a + b, 0);
  expect(total, "positive measured extent").toBeGreaterThan(0);
  return boxes.map((x) => x / total);
}

function expectShares(actual: number[], expected: number[], label: string): void {
  expect(actual.length, `${label}: share count`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(
      Math.abs(actual[i] - expected[i]),
      `${label}: share[${i}] ${actual[i].toFixed(4)} vs ${expected[i].toFixed(4)}`,
    ).toBeLessThanOrEqual(TOL);
  }
}

/** Drag the root sash so pane `ids[0]` reaches ~`target` share of the split
 *  axis (from proportions.spec.ts — the production resize gesture). */
async function dragToShare(
  page: Page,
  ids: [string, string],
  axis: "width" | "height",
  target: number,
): Promise<void> {
  const sash = page.locator(".dv-sash").first();
  const bb = await sash.boundingBox();
  expect(bb, "root sash boundingBox").not.toBeNull();
  const cur = await shares(page, ids, axis);
  const boxes: number[] = [];
  for (const id of ids) {
    const b = await H.groupBox(page, id);
    boxes.push(b![axis]);
  }
  const total = boxes.reduce((a, b) => a + b, 0);
  const delta = Math.round((target - cur[0]) * total);
  if (delta === 0) return;
  const cx = bb!.x + bb!.width / 2;
  const cy = bb!.y + bb!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + (axis === "width" ? delta : 0), cy + (axis === "height" ? delta : 0), { steps: 8 });
  await page.mouse.up();
  await H.waitForLayoutSettled(page);
}

// ---- manager UI helpers (the REAL Settings surface) --------------------------

/** Open the settings popover via the real gear trigger. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-btn"]').click();
  await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
}

/** Open Settings → "Layouts…" (the manager sub-view). */
async function openManager(page: Page): Promise<void> {
  await openSettings(page);
  await page.locator('[data-testid="settings-layouts"]').click();
  await expect(page.locator('[data-testid="layouts-manager"]')).toBeVisible();
}

/** Save the active workspace's layout under `name` via the REAL manager UI. */
async function saveViaUI(page: Page, name: string): Promise<void> {
  await openManager(page);
  await page.locator('[data-testid="layout-name-input"]').fill(name);
  await page.locator('[data-testid="layout-save"]').click();
}

/** The saved-layout row for `name` (locator). */
function layoutRow(page: Page, name: string) {
  return page.locator('[data-testid="layout-row"]', { hasText: name });
}

/** The shape of a stored named-layout blob this spec inspects. */
interface StoredLayout {
  grid?: { root?: { type?: string; data?: unknown[] } };
  panels?: Record<string, { params?: { url?: string; label?: string } }>;
}

/** The parsed named-layouts store from localStorage (null when absent). */
async function namedStore(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, NAMED_LAYOUTS_KEY);
}

/** The stored fractional layout blob for `name` (parsed from localStorage). */
async function storedLayout(page: Page, name: string): Promise<StoredLayout | null> {
  const store = await namedStore(page);
  if (!store) return null;
  const entry = store[name] as { layout?: StoredLayout } | undefined;
  return entry?.layout ?? null;
}

/** Arrange exactly TWO side-by-side panes at an UNEVEN ~70/30 split and wait
 *  for both to be live. Returns the pane ids (left first). */
async function unevenTwo(
  page: Page,
  firstShare = 0.7,
): Promise<[string, string]> {
  const [a, b] = await H.twoPanes(page);
  await H.waitForSideBySide(page, a, b);
  await dragToShare(page, [a, b], "width", firstShare);
  return [a, b];
}

test.describe("named layouts", () => {
  test.beforeEach(async ({ page }) => {
    // Clear persisted state BEFORE the app boots (single boot — see
    // settings.spec.ts for the rationale): no prior layout AND no prior
    // named-layout blob leaks in.
    //
    // FRAME GUARD (load-bearing): addInitScript ALSO runs in CHILD FRAMES at
    // attach — and a freshly-created iframe is briefly a SAME-ORIGIN
    // about:blank, where localStorage IS THE HOST'S OWN STORAGE. An unguarded
    // clear() there wipes the host storage MID-TEST the moment a load creates
    // new iframes (observed: the named-layout blob vanishing right after a
    // load). Main-frame-only + once-per-document.
    await page.addInitScript(() => {
      if (window !== window.top) return; // same-origin about:blank frames share the host storage
      const w = window as unknown as { __namedLayoutsCleared?: boolean };
      if (w.__namedLayoutsCleared) return;
      w.__namedLayoutsCleared = true;
      localStorage.clear();
    });
    await page.setViewportSize(WIDE);
    await H.loadHost(page);
  });

  test("save → storage round-trip: fractional blob + panel params", async ({ page }) => {
    const [a, b] = await unevenTwo(page);
    const params = await H.paneParams(page);
    expect(params.length).toBe(2);

    await saveViaUI(page, "battle");
    // The manager stays open after a save; the list shows the entry.
    await expect(layoutRow(page, "battle")).toBeVisible();

    const layout = await storedLayout(page, "battle");
    expect(layout, "named blob written").not.toBeNull();
    // Fractional shape: the grid root is a branch whose children carry
    // `fraction` (and NOT px `size`) — the v3 serialization, same as the
    // workspace-set persistence writes.
    const root = layout!.grid?.root;
    expect(root?.type).toBe("branch");
    const children = (root?.data ?? []) as Array<{ fraction?: number; size?: number }>;
    expect(children.length).toBe(2);
    for (const c of children) {
      expect(typeof c.fraction, "root child carries fraction").toBe("number");
      expect(c.size, "root child carries NO px size").toBeUndefined();
    }
    // The saved fractions ARE the arranged shares (~0.7/0.3, ±TOL).
    expect(Math.abs(children[0].fraction! - 0.7)).toBeLessThanOrEqual(TOL);
    // Panel params round-trip: the blob's panels carry the same urls/labels
    // as the live panes.
    const savedUrls = Object.values(layout!.panels ?? {})
      .map((p) => p.params?.url ?? "")
      .sort();
    const liveUrls = params.map((p) => p.url).sort();
    expect(savedUrls).toEqual(liveUrls);
    // savedAt is a recent epoch.
    const store = await namedStore(page);
    const entry = store!["battle"] as { savedAt?: number };
    expect(typeof entry.savedAt).toBe("number");
    expect(Math.abs(Date.now() - entry.savedAt!)).toBeLessThan(60_000);
    void a; void b;
  });

  test("load = NEW workspace with the saved arrangement (CRUX)", async ({ page }) => {
    const [a, b] = await unevenTwo(page);
    const savedParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));

    await saveViaUI(page, "battle");
    await page.keyboard.press("Escape"); // close the popover

    // MUTATE the live layout after saving: re-drag to ~50/50. The loaded
    // workspace must restore the SAVED 70/30, not the current 50/50.
    await dragToShare(page, [a, b], "width", 0.5);
    const mutatedShares = await shares(page, [a, b], "width");
    expectShares(mutatedShares, [0.5, 0.5], "post-mutation source arrangement");

    const wsBefore = await H.workspaces(page);
    const sourceWs = await H.activeWorkspace(page);
    expect(wsBefore.length).toBe(1);

    // LOAD via the real manager UI.
    await openManager(page);
    await layoutRow(page, "battle").locator('[data-testid="layout-load"]').click();

    // The popover closes (the new workspace is the result).
    await expect(page.locator('[data-testid="settings-popover"]')).toHaveCount(0);

    // A NEW workspace exists, is active, and is named after the save.
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);
    const newWs = await H.activeWorkspace(page);
    expect(newWs).not.toBe(sourceWs);
    expect(await H.workspaceName(page, newWs!)).toBe("battle");

    // Its panes are fresh ids (never aliasing the source panes) and go live.
    await expect.poll(async () => (await H.panes(page)).length, { timeout: 8000 }).toBe(2);
    const newPanes = await H.panes(page);
    expect(newPanes).not.toContain(a);
    expect(newPanes).not.toContain(b);
    for (const id of newPanes) await H.waitForReady(page, id);

    // CRUX: the loaded arrangement matches the SAVED shares (±TOL) and the
    // saved params (urls/labels).
    const loadedShares = await shares(page, newPanes, "width");
    expectShares(loadedShares, [0.7, 0.3], "loaded workspace arrangement");
    const loadedParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));
    expect(loadedParams).toEqual(savedParams);

    // The SOURCE workspace is untouched: same panes, still the MUTATED 50/50.
    await H.setActiveWorkspace(page, sourceWs!);
    expect(await H.panes(page)).toEqual([a, b]);
    const sourceSharesAfter = await shares(page, [a, b], "width");
    expectShares(sourceSharesAfter, [0.5, 0.5], "source workspace keeps its mutated arrangement");
  });

  test("CRUX — existing workspace panes SURVIVE the whole load action", async ({ page }) => {
    const [a] = await unevenTwo(page);
    const sourceBefore = await H.waitForFreshHeartbeat(page, a, 0);

    // A second workspace with a live pane (the background survivor).
    const ws2 = await H.addWorkspace(page);
    expect(ws2).toBeTruthy();
    const ws2Pane = await H.addServer(page, H.serverUrl("survivor"), "survivor");
    expect(ws2Pane).toBeTruthy();
    const ws2Before = await H.waitForReady(page, ws2Pane!);

    // Back to the source workspace; save + load from there.
    await H.setActiveWorkspace(page, (await H.workspaces(page))[0]);
    await saveViaUI(page, "battle");
    await page.keyboard.press("Escape");
    await openManager(page);
    await layoutRow(page, "battle").locator('[data-testid="layout-load"]').click();
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(3);

    // The background workspace's pane was NEVER touched (survival, not
    // aliveness: identity unchanged across the whole load action).
    await H.assertSurvived(page, ws2Pane!, ws2Before, "background ws2 pane across named-layout load");
    // The SOURCE workspace's pane survived too (saving + loading never
    // mutated its tree).
    await H.assertSurvived(page, a, sourceBefore, "source ws1 pane across named-layout load");
  });

  test("the loaded workspace's panes are ALIVE (fresh documents, not survival)", async ({ page }) => {
    const [a, b] = await unevenTwo(page);
    const sourceA = await H.waitForReady(page, a);
    const sourceB = await H.waitForReady(page, b);

    await saveViaUI(page, "battle");
    await page.keyboard.press("Escape");
    await openManager(page);
    await layoutRow(page, "battle").locator('[data-testid="layout-load"]').click();

    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);
    await expect.poll(async () => (await H.panes(page)).length, { timeout: 8000 }).toBe(2);
    const newPanes = await H.panes(page);
    for (const id of newPanes) await H.waitForReady(page, id);

    // Aliveness: fresh identities (mountTs differs from the source panes' —
    // these are NEW documents), heartbeats flowing, liveness "alive".
    const newA = await H.survival(page, newPanes[0])!;
    const newB = await H.survival(page, newPanes[1])!;
    expect(newA!.mountTs).not.toBe(sourceA.mountTs);
    expect(newB!.mountTs).not.toBe(sourceB.mountTs);
    for (const id of newPanes) {
      await expect.poll(async () => H.liveness(page, id), { timeout: 5000 }).toBe("alive");
    }
  });

  test("overwrite: same name saved twice → one entry, latest arrangement wins", async ({ page }) => {
    const [a, b] = await unevenTwo(page);
    void b;

    await saveViaUI(page, "battle");
    await page.keyboard.press("Escape");

    // Mutate: close the second pane → the arrangement is now ONE pane.
    await H.closePane(page, b);
    await expect.poll(async () => (await H.panes(page)).length, { timeout: 5000 }).toBe(1);

    // Save the SAME name again.
    await saveViaUI(page, "battle");

    // One entry only (overwrite, not append).
    await expect(page.locator('[data-testid="layout-row"]')).toHaveCount(1);
    const store = await namedStore(page);
    expect(Object.keys(store ?? {})).toEqual(["battle"]);

    // Loading yields the LATEST arrangement: one pane, the survivor's url.
    await page.keyboard.press("Escape");
    await openManager(page);
    await layoutRow(page, "battle").locator('[data-testid="layout-load"]').click();
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);
    await expect.poll(async () => (await H.panes(page)).length, { timeout: 8000 }).toBe(1);
    // The active workspace is the newly-loaded one; its single pane carries
    // the survivor's url (the latest saved arrangement).
    const loadedParams = await H.paneParams(page);
    const saved = await storedLayout(page, "battle");
    const savedUrls = Object.values(saved?.panels ?? {}).map((p) => p.params?.url ?? "");
    expect(loadedParams.map((p) => p.url)).toEqual(savedUrls);
    void a;
  });

  test("delete: row × removes the entry; the list updates", async ({ page }) => {
    await unevenTwo(page);
    await saveViaUI(page, "battle");
    await expect(layoutRow(page, "battle")).toBeVisible();

    await layoutRow(page, "battle").locator('[data-testid="layout-delete"]').click();

    await expect(page.locator('[data-testid="layout-row"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="layout-empty"]')).toBeVisible();
    expect(await namedStore(page)).toBeNull();
  });

  test("empty-workspace save guard: Save current aria-disabled + hinted", async ({ page }) => {
    // Create an empty workspace and make it active.
    const ws2 = await H.addWorkspace(page);
    expect(ws2).toBeTruthy();
    await expect.poll(async () => (await H.panes(page)).length, { timeout: 5000 }).toBe(0);

    await openManager(page);
    const saveBtn = page.locator('[data-testid="layout-save"]');
    await expect(saveBtn).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator('[data-testid="layout-save-hint"]')).toHaveText(
      /No panes to save/,
    );

    // Activation is a full no-op: clicking writes nothing. force:true because
    // Playwright's actionability wait refuses plain clicks on aria-disabled
    // elements — force still dispatches a REAL click through the handler.
    await page.locator('[data-testid="layout-name-input"]').fill("void");
    await saveBtn.click({ force: true });
    await expect(page.locator('[data-testid="layout-row"]')).toHaveCount(0);
    expect(await namedStore(page)).toBeNull();
  });

  test("persistence round-trip: the loaded workspace survives a reload in the normal set", async ({ page }) => {
    const [a, b] = await unevenTwo(page);
    const savedParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));
    void a; void b;

    await saveViaUI(page, "battle");
    await page.keyboard.press("Escape");
    await openManager(page);
    await layoutRow(page, "battle").locator('[data-testid="layout-load"]').click();
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);

    // Wait for the debounced save to flush the FULL state (source 2 panes +
    // loaded 2 panes = 4 panels) before reloading.
    await H.waitForSavedLayout(page, 4);

    // Reload (NOT goto — a bare goto("/") would DISCARD the #state= hash,
    // which is the per-tab source of truth the restore reads first; the
    // beforeEach init script clears the localStorage mirror on the fresh
    // document, so the hash is what must survive).
    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);

    // The loaded workspace is a REGULAR persisted workspace now: present,
    // active (the last save remembered it), named, with its arrangement.
    const ids = await H.workspaces(page);
    expect(ids.length).toBe(2);
    const names = await Promise.all(ids.map((id) => H.workspaceName(page, id)));
    expect(names).toContain("battle");
    const battleId = ids[names.indexOf("battle")];
    expect(await H.activeWorkspace(page)).toBe(battleId);

    const restored = await H.panes(page);
    expect(restored.length).toBe(2);
    for (const id of restored) await H.waitForReady(page, id);
    const restoredShares = await shares(page, restored, "width");
    expectShares(restoredShares, [0.7, 0.3], "reloaded battle arrangement");
    const restoredParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));
    expect(restoredParams).toEqual(savedParams);
  });
});

// =============================================================================
// Vision evidence (gitignored): manager view (list + save control) + the
// loaded arrangement. Gated behind VH_LAYOUTS_SHOTS=<dir> so ordinary runs
// write nothing (the tail.spec.ts pattern); the verification pass runs the
// suite once with the env var set and analyzes the captures with the vision
// tool.
// =============================================================================

test("vision evidence: layouts manager + loaded arrangement (gitignored screenshots)", async ({ page }) => {
  const shotDir = process.env.VH_LAYOUTS_SHOTS;
  test.skip(!shotDir, "screenshot evidence only captured when VH_LAYOUTS_SHOTS is set");

  // Same guarded clear as the describe's beforeEach (main frame, once).
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const w = window as unknown as { __namedLayoutsCleared?: boolean };
    if (w.__namedLayoutsCleared) return;
    w.__namedLayoutsCleared = true;
    localStorage.clear();
  });
  await page.setViewportSize(WIDE);
  await H.loadHost(page);
  await unevenTwo(page);

  await saveViaUI(page, "battle");
  await expect(layoutRow(page, "battle")).toBeVisible();
  await page.locator('[data-testid="settings-popover"]').screenshot({
    path: `${shotDir}/layouts-manager.png`,
  });

  await page.keyboard.press("Escape");
  await openManager(page);
  await layoutRow(page, "battle").locator('[data-testid="layout-load"]').click();
  await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);
  await expect.poll(async () => (await H.panes(page)).length, { timeout: 8000 }).toBe(2);
  for (const id of await H.panes(page)) await H.waitForReady(page, id);
  await H.waitForLayoutSettled(page);
  await page.locator('[data-testid="host-app-root"]').screenshot({
    path: `${shotDir}/layouts-loaded-arrangement.png`,
  });
});
