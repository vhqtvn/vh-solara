import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// NAMED LAYOUTS v2 (host-web/src/dockview/namedLayouts.ts + the staged-layout
// seam in layoutPersistence.ts + the tabstrip "Layouts" popover).
//
// WHAT THIS SPEC PROVES (mission cruxes):
//   1. TAB SAVE → STORAGE ROUND-TRIP: saving the active workspace under a name
//      + TAB TITLE writes `vh-host:namedLayouts:v2` as a scope:"tab" entry
//      carrying the FRACTIONAL v3 serialization + panel params + the title.
//   2. LOAD = NEW WORKSPACE NAMED AFTER THE TAB TITLE [CRUX]: after saving,
//      mutating the live layout, then loading, a NEW workspace appears, is
//      active, is named after the saved TAB TITLE (NOT the layout name), and
//      its panes match the SAVED shares (±2%) + params — while the source
//      workspace keeps its MUTATED arrangement and pane ids.
//   3. EXISTING-WORKSPACE SURVIVAL ACROSS A LOAD [CRUX]: panes in other
//      workspaces assertSurvived across the whole load action — loading never
//      touches a live workspace's tree (no fromJSON on a live workspace).
//   4. RENAME ROUND-TRIP: rename → list shows the new name → load still works
//      → old name gone. Collision rename → inline error, no change.
//   5. MASTER SAVE: a 2-workspace session with distinct names/arrangements +
//      a known active → the v2 blob carries both (names, layouts) + the
//      active workspace's NAME.
//   6. MASTER LOAD [CRUX]: after mutating the session, a confirm-gated load
//      replaces it — workspace set == saved set (names + arrangements
//      ±tolerance + params), active == saved active. All iframes are NEW
//      documents (fresh mounts; liveness goes "alive") — an aliveness claim,
//      NOT a survival claim.
//   7. MASTER LOAD CONFIRM GATE: the first Load tap is non-destructive
//      (workspace count unchanged); ✓ proceeds, ✕ cancels.
//   8. v1 → v2 MIGRATION: a planted v1 blob surfaces as a tab entry with
//      tabTitle == name; the first v2 write removes the v1 key.
//   9. DE-CONFUSION: Settings carries "Edit layout…" (the overlay trigger)
//      and NO "Layouts…" sub-view; the tabstrip "Layouts" button opens the
//      new popover; the two tabstrip popovers are mutually exclusive.
//  10. OVERWRITE / DELETE / EMPTY-WORKSPACE GUARD / PERSISTENCE ROUND-TRIP
//      (v1 semantics, re-driven through the new surface).
//
// UI paths (open the Layouts popover → scope → save/load/rename/delete) drive
// the REAL production surface; the DEV bridge is used only for arrangement
// (splits), reads, and cross-workspace setup — the established pattern of
// this suite. Serial (host-web playwright.config.ts: workers 1); each test
// clears persisted state via addInitScript BEFORE the single app boot.
// =============================================================================

/** Share tolerance (absolute fraction-of-extent) — the proportions spec's
 *  ±2% (healthy paths measure within ±0.5%). */
const TOL = 0.02;

/** Build viewport (w/h=1.78 → wide → HORIZONTAL root split, so the two-pane
 *  arrangement shares are measured along "width"). */
const WIDE = { width: 1280, height: 720 };

/** Storage keys namedLayouts.ts reads/writes (must match the module). */
const NAMED_LAYOUTS_KEY = "vh-host:namedLayouts:v2";
const LEGACY_NAMED_LAYOUTS_KEY_V1 = "vh-host:namedLayouts:v1";

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

// ---- manager UI helpers (the REAL Layouts popover surface) ------------------

/** Open the Layouts popover via the real tabstrip trigger. */
async function openLayouts(page: Page): Promise<void> {
  await page.locator('[data-testid="layouts-btn"]').click();
  await expect(page.locator('[data-testid="layouts-popover"]')).toBeVisible();
}

/** Open the Layouts popover on the ALL-TABS scope. */
async function openLayoutsAllTabs(page: Page): Promise<void> {
  await openLayouts(page);
  await page.locator('[data-testid="layouts-scope-all"]').click();
}

/** Save the ACTIVE workspace's layout under `name` via the REAL popover UI.
 *  `tabTitle` defaults to the input's prefill (the current workspace's name). */
async function saveTabViaUI(
  page: Page,
  name: string,
  tabTitle?: string,
): Promise<void> {
  await openLayouts(page);
  await page.locator('[data-testid="layout-name-input"]').fill(name);
  if (tabTitle !== undefined) {
    await page.locator('[data-testid="layout-tabtitle-input"]').fill(tabTitle);
  }
  await page.locator('[data-testid="layout-save"]').click();
}

/** Save a whole-session snapshot under `name` via the REAL popover UI. */
async function saveMasterViaUI(page: Page, name: string): Promise<void> {
  await openLayoutsAllTabs(page);
  await page.locator('[data-testid="layout-name-input"]').fill(name);
  await page.locator('[data-testid="layout-save"]').click();
}

/** The saved-layout row for `name` (locator; precise on data-name). */
function layoutRow(page: Page, name: string) {
  return page.locator(`[data-testid="layout-row"][data-name="${name}"]`);
}

/** The shape of a stored tab-scope layout blob this spec inspects. */
interface StoredLayout {
  grid?: { root?: { type?: string; data?: unknown[] } };
  panels?: Record<string, { params?: { url?: string; label?: string } }>;
}

/** A stored master (session) snapshot. */
interface StoredMasterSession {
  activeWorkspaceName?: string | null;
  workspaces?: Array<{ name?: string; layout?: StoredLayout }>;
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

/** One raw store entry (either scope), or null. */
async function storedEntry(
  page: Page,
  name: string,
): Promise<Record<string, unknown> | null> {
  const store = await namedStore(page);
  if (!store) return null;
  const e = store[name] as Record<string, unknown> | undefined;
  return e ?? null;
}

/** The stored fractional layout blob for a TAB entry `name`. */
async function storedLayout(page: Page, name: string): Promise<StoredLayout | null> {
  const entry = await storedEntry(page, name);
  if (!entry) return null;
  return (entry.layout as StoredLayout) ?? null;
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

  test("tab save → storage round-trip: fractional blob + params + tab title", async ({ page }) => {
    const [a, b] = await unevenTwo(page);
    const params = await H.paneParams(page);
    expect(params.length).toBe(2);

    await saveTabViaUI(page, "battle", "patrol");
    // The popover stays open after a save; the list shows the entry WITH the
    // tab-title subtitle (the title differs from the layout name).
    await expect(layoutRow(page, "battle")).toBeVisible();
    await expect(
      layoutRow(page, "battle").locator('[data-testid="layout-row-tabtitle"]'),
    ).toHaveText("→ tab: patrol");

    const entry = await storedEntry(page, "battle");
    expect(entry, "v2 store entry written").not.toBeNull();
    expect(entry!.scope).toBe("tab");
    expect(entry!.tabTitle).toBe("patrol");
    const layout = entry!.layout as StoredLayout;
    // Fractional shape: the grid root is a branch whose children carry
    // `fraction` (and NOT px `size`) — the v3 serialization, same as the
    // workspace-set persistence writes.
    const root = layout.grid?.root;
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
    const savedUrls = Object.values(layout.panels ?? {})
      .map((p) => p.params?.url ?? "")
      .sort();
    const liveUrls = params.map((p) => p.url).sort();
    expect(savedUrls).toEqual(liveUrls);
    // savedAt is a recent epoch.
    expect(typeof entry!.savedAt).toBe("number");
    expect(Math.abs(Date.now() - (entry!.savedAt as number))).toBeLessThan(60_000);
    void a; void b;
  });

  test("load = NEW workspace named after the TAB TITLE with the saved arrangement (CRUX)", async ({ page }) => {
    const [a, b] = await unevenTwo(page);
    const savedParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));

    await saveTabViaUI(page, "battle", "patrol");
    await page.keyboard.press("Escape"); // close the popover

    // MUTATE the live layout after saving: re-drag to ~50/50. The loaded
    // workspace must restore the SAVED 70/30, not the current 50/50.
    await dragToShare(page, [a, b], "width", 0.5);
    const mutatedShares = await shares(page, [a, b], "width");
    expectShares(mutatedShares, [0.5, 0.5], "post-mutation source arrangement");

    const wsBefore = await H.workspaces(page);
    const sourceWs = await H.activeWorkspace(page);
    expect(wsBefore.length).toBe(1);

    // LOAD via the real popover UI (This-tab scope is the default).
    await openLayouts(page);
    await layoutRow(page, "battle").locator('[data-testid="layout-load"]').click();

    // The popover closes (the new workspace is the result).
    await expect(page.locator('[data-testid="layouts-popover"]')).toHaveCount(0);

    // A NEW workspace exists, is active, and is named after the TAB TITLE
    // (not the layout name).
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);
    const newWs = await H.activeWorkspace(page);
    expect(newWs).not.toBe(sourceWs);
    expect(await H.workspaceName(page, newWs!)).toBe("patrol");
    expect(await H.workspaceName(page, newWs!)).not.toBe("battle");

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

  test("default tab title = the current workspace's name; emptied title saves as the layout name", async ({ page }) => {
    await unevenTwo(page);
    const sourceWs = (await H.workspaces(page))[0];
    const sourceName = await H.workspaceName(page, sourceWs);

    await openLayouts(page);
    // The prefill IS the current workspace's name (the mission default).
    await expect(page.locator('[data-testid="layout-tabtitle-input"]')).toHaveValue(sourceName!);
    await page.locator('[data-testid="layout-name-input"]').fill("battle");
    await page.locator('[data-testid="layout-save"]').click();
    await expect(layoutRow(page, "battle")).toBeVisible();
    // The title (the workspace's name) differs from the layout name → the
    // "→ tab:" subtitle shows it.
    await expect(
      layoutRow(page, "battle").locator('[data-testid="layout-row-tabtitle"]'),
    ).toHaveText(`→ tab: ${sourceName}`);

    // An EMPTIED title field falls back to the layout name at the storage
    // layer (a loaded workspace always gets a sensible title) — and when the
    // title equals the name, no subtitle renders.
    await page.locator('[data-testid="layout-name-input"]').fill("bare");
    await page.locator('[data-testid="layout-tabtitle-input"]').fill("");
    await page.locator('[data-testid="layout-save"]').click();
    const bare = await storedEntry(page, "bare");
    expect(bare!.tabTitle).toBe("bare");
    await expect(
      layoutRow(page, "bare").locator('[data-testid="layout-row-tabtitle"]'),
    ).toHaveCount(0);
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
    await saveTabViaUI(page, "battle");
    await page.keyboard.press("Escape");
    await openLayouts(page);
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

    await saveTabViaUI(page, "battle", "patrol");
    await page.keyboard.press("Escape");
    await openLayouts(page);
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

  test("rename round-trip: new name lists, loads, old name gone", async ({ page }) => {
    await unevenTwo(page);
    await saveTabViaUI(page, "battle", "patrol");
    await expect(layoutRow(page, "battle")).toBeVisible();

    // Rename via the pencil: the row's name swaps to an inline input.
    await layoutRow(page, "battle").locator('[data-testid="layout-rename"]').click();
    const input = layoutRow(page, "battle").locator('[data-testid="layout-rename-input"]');
    await expect(input).toBeVisible();
    await input.fill("skirmish");
    await input.press("Enter");

    // The list shows the NEW name; the old row is gone; the store is re-keyed
    // (entry preserved — tabTitle + savedAt intact).
    await expect(layoutRow(page, "skirmish")).toBeVisible();
    await expect(layoutRow(page, "battle")).toHaveCount(0);
    const entry = await storedEntry(page, "skirmish");
    expect(entry, "renamed entry present").not.toBeNull();
    expect(entry!.tabTitle).toBe("patrol");
    expect(await storedEntry(page, "battle")).toBeNull();

    // Load under the NEW name still works (the workspace is titled after the
    // entry's tabTitle).
    await page.keyboard.press("Escape");
    await openLayouts(page);
    await layoutRow(page, "skirmish").locator('[data-testid="layout-load"]').click();
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);
    expect(await H.workspaceName(page, (await H.activeWorkspace(page))!)).toBe("patrol");
  });

  test("rename collision → inline error, no change", async ({ page }) => {
    await unevenTwo(page);
    await saveTabViaUI(page, "battle");
    await page.keyboard.press("Escape");
    // Mutate the arrangement so the second save is a DIFFERENT snapshot.
    await H.closePane(page, (await H.panes(page))[1]);
    await saveTabViaUI(page, "siege");
    await expect(layoutRow(page, "battle")).toBeVisible();
    await expect(layoutRow(page, "siege")).toBeVisible();

    // Rename "siege" → "battle": refused (collision), inline error, and BOTH
    // entries survive unchanged.
    await layoutRow(page, "siege").locator('[data-testid="layout-rename"]').click();
    const input = layoutRow(page, "siege").locator('[data-testid="layout-rename-input"]');
    await input.fill("battle");
    await input.press("Enter");
    await expect(
      layoutRow(page, "siege").locator('[data-testid="layout-rename-error"]'),
    ).toBeVisible();
    await expect(layoutRow(page, "battle")).toBeVisible();
    await expect(layoutRow(page, "siege")).toBeVisible();
    const store = await namedStore(page);
    expect(Object.keys(store ?? {}).sort()).toEqual(["battle", "siege"]);
  });

  test("master save: blob carries every workspace + the active workspace's NAME", async ({ page }) => {
    // ws1 "alpha": two panes at 70/30.
    const [a, b] = await unevenTwo(page);
    const alpha = (await H.workspaces(page))[0];
    await H.renameWorkspace(page, alpha, "alpha");
    const alphaParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));
    void a; void b;

    // ws2 "recon": one pane.
    const recon = await H.addWorkspace(page);
    expect(recon).toBeTruthy();
    const reconPane = await H.addServer(page, H.serverUrl("recon"), "recon");
    await H.waitForReady(page, reconPane!);
    await H.renameWorkspace(page, recon!, "recon");

    // Active = alpha at save time (switch back first).
    await H.setActiveWorkspace(page, alpha);
    await saveMasterViaUI(page, "morning fleet");
    await expect(layoutRow(page, "morning fleet")).toBeVisible();
    // Master rows carry the "N tabs" subtitle.
    await expect(layoutRow(page, "morning fleet")).toContainText("2 tabs");

    const entry = await storedEntry(page, "morning fleet");
    expect(entry, "master entry written").not.toBeNull();
    expect(entry!.scope).toBe("master");
    const session = entry!.session as StoredMasterSession;
    expect(session.activeWorkspaceName).toBe("alpha");
    expect(session.workspaces?.map((w) => w.name)).toEqual(["alpha", "recon"]);
    // Each workspace's layout carries its panes: alpha's 2 (urls match), recon's 1.
    const alphaWs = session.workspaces![0];
    const reconWs = session.workspaces![1];
    const alphaUrls = Object.values(alphaWs.layout?.panels ?? {})
      .map((p) => p.params?.url ?? "")
      .sort();
    expect(alphaUrls).toEqual(alphaParams.map((p) => p.url));
    const reconUrls = Object.values(reconWs.layout?.panels ?? {})
      .map((p) => p.params?.url ?? "");
    expect(reconUrls).toEqual([H.serverUrl("recon")]);
  });

  test("master load CRUX: replaces the session (set + active + arrangements); iframes are fresh", async ({ page }) => {
    // ---- arrange + save (same shape as the master-save test) ---------------
    const [a, b] = await unevenTwo(page);
    const alpha = (await H.workspaces(page))[0];
    await H.renameWorkspace(page, alpha, "alpha");
    const alphaParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));
    const recon = await H.addWorkspace(page);
    const reconPane = await H.addServer(page, H.serverUrl("recon"), "recon");
    await H.waitForReady(page, reconPane!);
    await H.renameWorkspace(page, recon!, "recon");
    await H.setActiveWorkspace(page, alpha);
    await saveMasterViaUI(page, "morning fleet");
    await page.keyboard.press("Escape");

    // ---- MUTATE the session: split recon's pane + add a third workspace ----
    await H.setActiveWorkspace(page, recon!);
    const reconSplit = await H.split(page, reconPane!, "right");
    expect(reconSplit).toBeTruthy();
    await H.waitForReady(page, reconSplit!);
    await H.addWorkspace(page); // "Workspace 3"
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(3);

    // ---- confirm-gated master load ------------------------------------------
    await openLayoutsAllTabs(page);
    await layoutRow(page, "morning fleet").locator('[data-testid="layout-load"]').click();
    const row = layoutRow(page, "morning fleet");
    await expect(row).toHaveAttribute("data-confirming", "1");
    await expect(row).toContainText("Replace all tabs?");
    // First tap was NON-destructive (the confirm-gate test below drives the
    // cancel path; here we proceed immediately).
    await row.locator('[data-testid="layout-load-confirm"]').click();

    // The popover closes; the session is REPLACED.
    await expect(page.locator('[data-testid="layouts-popover"]')).toHaveCount(0);
    await expect.poll(async () => (await H.workspaces(page)).length, { timeout: 8000 }).toBe(2);

    // Set equality: exactly the saved names, in blob order; NO old ids.
    const ids = await H.workspaces(page);
    const names = await Promise.all(ids.map((id) => H.workspaceName(page, id)));
    expect(names).toEqual(["alpha", "recon"]);
    // Active == the saved active (by NAME).
    const activeName = await H.workspaceName(page, (await H.activeWorkspace(page))!);
    expect(activeName).toBe("alpha");

    // All iframes are NEW documents: fresh pane ids (none of the pre-load
    // panes survive as ids), each goes live + "alive" (an ALIVENESS claim —
    // the old workspaces were destroyed with their iframes by design).
    const oldPaneIds = new Set([a, b, reconPane!, reconSplit!]);
    await expect.poll(async () => (await H.panes(page)).length, { timeout: 8000 }).toBe(2);
    const freshAlphaPanes = await H.panes(page);
    expect(freshAlphaPanes.length).toBe(2);
    for (const id of freshAlphaPanes) {
      expect(oldPaneIds.has(id), `pane ${id} is a fresh id`).toBe(false);
      await H.waitForReady(page, id);
    }

    // CRUX: arrangements match the SAVED shares + params.
    await H.waitForLayoutSettled(page);
    const alphaShares = await shares(page, freshAlphaPanes, "width");
    expectShares(alphaShares, [0.7, 0.3], "restored alpha arrangement");
    const restoredParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));
    expect(restoredParams).toEqual(alphaParams);

    // recon restored as its OWN single-pane workspace.
    const reconId = ids[names.indexOf("recon")];
    await H.setActiveWorkspace(page, reconId);
    const reconPanes = await H.panes(page);
    expect(reconPanes.length).toBe(1);
    expect(oldPaneIds.has(reconPanes[0])).toBe(false);
    await H.waitForReady(page, reconPanes[0]);
    expect((await H.paneParams(page))[0].url).toBe(H.serverUrl("recon"));

    // Liveness across the whole restored session.
    for (const id of [...freshAlphaPanes, ...reconPanes]) {
      await expect.poll(async () => H.liveness(page, id), { timeout: 5000 }).toBe("alive");
    }

    // ---- PERSISTENCE NO-FIGHT (review finding C1/D2): the master load's
    // N-adds + M-closes burst all landed inside ONE debounce window; the
    // flushed save must serialize EXACTLY the post-replace session, and a
    // reload must restore it through the NORMAL persisted set (names,
    // arrangements, active) — mirroring the tab-scope round-trip above. ----
    // Return to the session's saved-active workspace first (the recon switch
    // above re-activated recon; persistence remembers the LAST active).
    const alphaId2 = ids[names.indexOf("alpha")];
    await H.setActiveWorkspace(page, alphaId2);
    // Wait for a flush carrying the post-replace session AND alpha as the
    // persisted active (panel-count polling cannot see an active-only
    // switch — poll the persisted blob's activeWorkspaceId directly).
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ key, alphaId }) => {
              const raw = localStorage.getItem(key);
              if (!raw) return false;
              try {
                const parsed = JSON.parse(raw) as {
                  activeWorkspaceId?: string;
                  workspaces?: unknown[];
                };
                return parsed.activeWorkspaceId === alphaId && parsed.workspaces?.length === 2;
              } catch {
                return false;
              }
            },
            { key: H.LAYOUT_STORAGE_KEY, alphaId: alphaId2 },
          ),
        { timeout: 8000 },
      )
      .toBe(true);
    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);
    const reloadedIds = await H.workspaces(page);
    expect(reloadedIds.length).toBe(2);
    const reloadedNames = await Promise.all(reloadedIds.map((id) => H.workspaceName(page, id)));
    expect(reloadedNames).toEqual(["alpha", "recon"]);
    // Active restored by NAME too.
    expect(await H.workspaceName(page, (await H.activeWorkspace(page))!)).toBe("alpha");
    const reloadedAlphaPanes = await H.panes(page);
    expect(reloadedAlphaPanes.length).toBe(2);
    for (const id of reloadedAlphaPanes) await H.waitForReady(page, id);
    await H.waitForLayoutSettled(page);
    const reloadedShares = await shares(page, reloadedAlphaPanes, "width");
    expectShares(reloadedShares, [0.7, 0.3], "reloaded alpha arrangement after master load");
    const reloadedParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));
    expect(reloadedParams).toEqual(alphaParams);
  });

  test("master load confirm gate: first tap non-destructive; ✕ cancels", async ({ page }) => {
    await unevenTwo(page);
    await saveMasterViaUI(page, "morning fleet");
    await page.keyboard.press("Escape");
    const countBefore = (await H.workspaces(page)).length;

    await openLayoutsAllTabs(page);
    const row = layoutRow(page, "morning fleet");
    await row.locator('[data-testid="layout-load"]').click();

    // Armed: the confirm affordances show; the session is UNTOUCHED so far.
    await expect(row).toHaveAttribute("data-confirming", "1");
    await expect(page.locator('[data-testid="layout-load-confirm"]')).toBeVisible();
    await expect(page.locator('[data-testid="layout-load-cancel"]')).toBeVisible();
    expect((await H.workspaces(page)).length).toBe(countBefore);

    // ✕ cancels: back to the plain row, still no mutation.
    await row.locator('[data-testid="layout-load-cancel"]').click();
    await expect(row).toHaveAttribute("data-confirming", "0");
    expect((await H.workspaces(page)).length).toBe(countBefore);

    // A SECOND Load tap arms again, and ✓ proceeds (count +1... no — a master
    // load REPLACES: the saved snapshot has exactly the same 1 workspace, so
    // the count stays 1; the proof is the confirm flow completing + the old
    // workspace ids being replaced).
    const idsBefore = (await H.workspaces(page)).join(",");
    await row.locator('[data-testid="layout-load"]').click();
    await row.locator('[data-testid="layout-load-confirm"]').click();
    await expect(page.locator('[data-testid="layouts-popover"]')).toHaveCount(0);
    await expect.poll(async () => {
      const ids = await H.workspaces(page);
      return ids.length === 1 && ids.join(",") !== idsBefore;
    }, { timeout: 8000 }).toBe(true);
  });

  test("v1 → v2 migration: v1 entry surfaces with tabTitle == name; first v2 write removes the v1 key", async ({ page }) => {
    // Plant a v1 blob BEFORE the app boots (init scripts run in insertion
    // order — the beforeEach clear runs first, this plants after it).
    await page.addInitScript((key) => {
      if (window !== window.top) return;
      localStorage.setItem(
        key,
        JSON.stringify({
          legacy: {
            layout: { grid: { root: { type: "branch", data: [] } }, panels: {} },
            savedAt: Date.now() - 5000,
          },
        }),
      );
    }, LEGACY_NAMED_LAYOUTS_KEY_V1);

    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);

    // The migrated entry surfaces under This tab, named as saved.
    await openLayouts(page);
    await expect(layoutRow(page, "legacy")).toBeVisible();
    // tabTitle == name → no "→ tab:" subtitle; the bridge read confirms the
    // in-memory migration carried tabTitle == name.
    await expect(
      layoutRow(page, "legacy").locator('[data-testid="layout-row-tabtitle"]'),
    ).toHaveCount(0);
    const listed = await page.evaluate(() => {
      const h = (window as unknown as {
        __host?: {
          namedLayouts(): Array<
            | { scope: string; name: string; tabTitle?: string }
            | { scope: string; name: string; tabs?: number }
          >;
        };
      }).__host;
      return h ? h.namedLayouts() : [];
    });
    const legacy = listed.find((e) => e.name === "legacy");
    expect(legacy?.scope).toBe("tab");
    expect((legacy as { tabTitle?: string } | undefined)?.tabTitle).toBe("legacy");

    // The v1 key is still on disk (migration is in-memory until a write)…
    expect(
      await page.evaluate((k) => localStorage.getItem(k) !== null, LEGACY_NAMED_LAYOUTS_KEY_V1),
    ).toBe(true);

    // …and the first v2 write (a fresh save) removes it while carrying the
    // migrated entry forward.
    await page.keyboard.press("Escape");
    await saveTabViaUI(page, "fresh");
    const v2 = await namedStore(page);
    expect(v2, "v2 key written").not.toBeNull();
    expect(Object.keys(v2!).sort()).toEqual(["fresh", "legacy"]);
    expect(
      await page.evaluate((k) => localStorage.getItem(k), LEGACY_NAMED_LAYOUTS_KEY_V1),
    ).toBeNull();
  });

  test("de-confusion: Settings has Edit layout… and NO Layouts…; the tabstrip Layouts button owns saved layouts", async ({ page }) => {
    // Settings: the overlay trigger is renamed; the manager sub-view is GONE.
    await page.locator('[data-testid="settings-btn"]').click();
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
    const editItem = page.locator('[data-testid="settings-layout"]');
    await expect(editItem).toHaveText(/Edit layout…/);
    await expect(editItem).not.toHaveText(/Layout…/);
    await expect(page.locator('[data-testid="settings-layouts"]')).toHaveCount(0);
    // The menu is exactly: Edit layout…, Reload page, Auto-rotate layout,
    // Needs-you notifications (the attention-notify opt-in toggle — the second
    // menuitemcheckbox, added by the needs-you notifications slice).
    await expect(page.locator('[data-testid="settings-popover"] [role="menuitem"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="settings-popover"] [role="menuitemcheckbox"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="settings-notify"]')).toHaveText(/Needs-you notifications/);
    await page.keyboard.press("Escape");

    // The tabstrip Layouts button opens the new popover.
    await openLayouts(page);
    await expect(page.locator('[data-testid="layouts-scope-tab"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="layout-name-input"]')).toBeVisible();

    // Mutual exclusion: opening Settings dismisses the Layouts popover (the
    // shared tabstrip surface group).
    await page.locator('[data-testid="settings-btn"]').click();
    await expect(page.locator('[data-testid="layouts-popover"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
  });

  test("overwrite: same name saved twice → one entry, latest arrangement wins", async ({ page }) => {
    const [a, b] = await unevenTwo(page);
    void b;

    await saveTabViaUI(page, "battle");
    await page.keyboard.press("Escape");

    // Mutate: close the second pane → the arrangement is now ONE pane.
    await H.closePane(page, b);
    await expect.poll(async () => (await H.panes(page)).length, { timeout: 5000 }).toBe(1);

    // Save the SAME name again.
    await saveTabViaUI(page, "battle");

    // One entry only (overwrite, not append).
    await expect(page.locator('[data-testid="layout-row"]')).toHaveCount(1);
    const store = await namedStore(page);
    expect(Object.keys(store ?? {})).toEqual(["battle"]);

    // Loading yields the LATEST arrangement: one pane, the survivor's url.
    await page.keyboard.press("Escape");
    await openLayouts(page);
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
    await saveTabViaUI(page, "battle");
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

    await openLayouts(page);
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
    await unevenTwo(page);
    const savedParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));

    await saveTabViaUI(page, "battle", "patrol");
    await page.keyboard.press("Escape");
    await openLayouts(page);
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
    // active (the last save remembered it), named after the TAB TITLE, with
    // its arrangement.
    const ids = await H.workspaces(page);
    expect(ids.length).toBe(2);
    const names = await Promise.all(ids.map((id) => H.workspaceName(page, id)));
    expect(names).toContain("patrol");
    const patrolId = ids[names.indexOf("patrol")];
    expect(await H.activeWorkspace(page)).toBe(patrolId);

    const restored = await H.panes(page);
    expect(restored.length).toBe(2);
    for (const id of restored) await H.waitForReady(page, id);
    const restoredShares = await shares(page, restored, "width");
    expectShares(restoredShares, [0.7, 0.3], "reloaded patrol arrangement");
    const restoredParams = (await H.paneParams(page)).map((p) => ({ url: p.url, label: p.label })).sort((x, y) => x.url.localeCompare(y.url));
    expect(restoredParams).toEqual(savedParams);
  });
});

// =============================================================================
// Vision evidence (gitignored): the Layouts popover in BOTH scopes (save
// forms + list rows with actions + the two-step confirm) + the renamed
// Settings menu. Gated behind VH_LAYOUTS_SHOTS=<dir> so ordinary runs write
// nothing (the tail.spec.ts pattern); the verification pass runs the suite
// once with the env var set and analyzes the captures with the vision tool.
// =============================================================================

test("vision evidence: Layouts popover (both scopes) + renamed Settings (gitignored screenshots)", async ({ page }) => {
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

  // This-tab scope: two-input save form + a saved row with the tab-title
  // subtitle + rename/delete affordances.
  await saveTabViaUI(page, "battle", "patrol");
  await expect(layoutRow(page, "battle")).toBeVisible();
  await page.locator('[data-testid="layouts-popover"]').screenshot({
    path: `${shotDir}/layouts-popover-tab.png`,
  });

  // All-tabs scope: one-input save form + the master row in the ARMED
  // two-step confirm state ("Replace all tabs?" + ✓/✕).
  await page.locator('[data-testid="layouts-scope-all"]').click();
  await page.locator('[data-testid="layout-name-input"]').fill("morning fleet");
  await page.locator('[data-testid="layout-save"]').click();
  await expect(layoutRow(page, "morning fleet")).toBeVisible();
  await layoutRow(page, "morning fleet").locator('[data-testid="layout-load"]').click();
  await expect(layoutRow(page, "morning fleet")).toHaveAttribute("data-confirming", "1");
  await page.locator('[data-testid="layouts-popover"]').screenshot({
    path: `${shotDir}/layouts-popover-master-confirm.png`,
  });
  await layoutRow(page, "morning fleet").locator('[data-testid="layout-load-cancel"]').click();

  // The de-confused Settings menu (Edit layout… / Reload / Auto-rotate).
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="settings-btn"]').click();
  await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
  await page.locator('[data-testid="settings-popover"]').screenshot({
    path: `${shotDir}/settings-edit-layout.png`,
  });
});
