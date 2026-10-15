import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { demoDir, projectUrl, resetLabels } from "./util";

// E-ink UX Slice 3 — discrete paging for the remaining owned scroll surfaces
// (the slice's centerpiece spec). Under einkProfile ON (default OFF), every
// owned overflowing surface gains explicit Prev/Next steps through the shared
// EinkSurfacePaging adapter over lib/paging.ts (UX S1 geometry):
//
//   session tree (vertical) · tag-filter rail (horizontal) · settings dialog
//   body (vertical) · nested reasoning bodies (vertical, independent of the
//   transcript) · code/diff pane (HORIZONTAL, +/- sigils preserved).
//
// All traversal is REAL button clicks on the real Chromium event path — never
// direct handler calls, never dragging, never synthetic scrollTop parking for
// the states under test. Physical e-ink panel outcomes (flash/ghosting, real
// handheld key delivery) are OUT of this spec's scope: browser automation
// proves only browser properties.
//
// Serial lane (workers:1, one shared mutable fixture backend): every test
// reloads the demo session; label state seeded via the real /vh/labels API is
// bracketed with resetLabels so nothing leaks into sibling specs.

// ── shared helpers ──────────────────────────────────────────────────────────

// Boot the SPA with the e-ink profile already enabled in storage (the saved
// preference — the manual activation path; scroll-follow.spec.ts's idiom).
async function bootEink(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("vh.prefs.einkProfile.v1", JSON.stringify({ v: 1, data: true }));
  });
}

async function openDemo(page: Page) {
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10_000 });
}

// Fixture source files written into the demo project dir so the CODE viewer
// (served from the real filesystem) has deterministic content: a unified diff
// whose lines are far wider than a 400px pane (horizontal overflow), with +/-
// sigils, and a 1x1 PNG (image fidelity probe). Written by the test process —
// the fixtureserver runs on the same host and serves this dir.
const DIFF_NAME = "eink-long.diff";
const PNG_NAME = "eink-tiny.png";
// Sentinels embedded at DISTINCT horizontal offsets of the wide diff lines —
// early / mid / late columns (each mark's left edge sits at a different x, so
// a traversal that stalls mid-line cannot light all three). The traversal
// proves each becomes visible at some stop, plus that the right edge
// (scrollLeft = extent) is actually reached.
const X_SENTINELS = ["XSTART", "XMIDDLE", "XEND"];

// The wide diff lines, built once and shared by the writer and the content
// integrity assertions (the +/- sigils are part of the preserved text).
const diffSigilLines = () => {
  const line = (sigil: string, before: number, mark: string, after: number) =>
    sigil + "z".repeat(before) + mark + "z".repeat(after);
  return [
    line("-", 8, X_SENTINELS[0], 300), // early column
    line("+", 150, X_SENTINELS[1], 160), // mid column
    line("+", 300, X_SENTINELS[2], 8), // late column
  ];
};

function writeFixtureFiles() {
  const lines = [
    "--- a/src/parser.go",
    "+++ b/src/parser.go",
    "@@ -1,3 +1,4 @@",
    " func Parse(s string) (*AST, error) {",
    ...diffSigilLines(),
    " }",
    "",
  ];
  nodeFs.writeFileSync(nodePath.join(demoDir, DIFF_NAME), lines.join("\n"), "utf8");
  // 1x1 transparent PNG.
  nodeFs.writeFileSync(
    nodePath.join(demoDir, PNG_NAME),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
}

function removeFixtureFiles() {
  for (const n of [DIFF_NAME, PNG_NAME]) {
    try {
      nodeFs.unlinkSync(nodePath.join(demoDir, n));
    } catch {
      /* already gone */
    }
  }
}

// Label-doc read-modify-write via the real CAS API (labels-multiclient.spec's
// withLabels shape) — deterministic tags/groups without UI-bound setup.
type LabelDocApi = {
  revision: number;
  groups: { id: string; name: string; color: string; collapsed: boolean; orderedRootSessionIds: string[] }[];
  tags: { id: string; name: string; color: string }[];
  tagIdsByRootSessionId: Record<string, string[]>;
};
async function withLabels(request: APIRequestContext, fn: (doc: LabelDocApi) => LabelDocApi) {
  const csrf = { "X-VH-CSRF": "1", "x-opencode-directory": demoDir };
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await request.get("/vh/labels", { headers: csrf });
    if (!cur.ok()) throw new Error(`withLabels GET -> ${cur.status}`);
    const base = (await cur.json()) as LabelDocApi;
    const next = fn(JSON.parse(JSON.stringify(base)));
    const put = await request.put("/vh/labels", {
      headers: csrf,
      data: { baseRevision: base.revision, ...next, revision: undefined },
    });
    if (put.ok()) return;
    if (put.status() === 409) continue;
    throw new Error(`withLabels: PUT rejected: ${await put.text()}`);
  }
  throw new Error("withLabels: exhausted 409 retries");
}

// Seed N tags assigned to the given root sessions — populates the sidebar's
// tag-filter rail (and adds a chip line to those rows). Colors must be
// palette MEMBERSHIP tokens (pkg/web/labels.go validColorTokens). Seeded
// AFTER first load (see seedTreeOverflow for the inventory rationale).
async function seedTags(request: APIRequestContext, n: number, roots: string[]) {
  await withLabels(request, (doc) => {
    doc.tags = Array.from({ length: n }, (_, i) => ({
      id: `lt-eink-${i}`,
      name: `eink-tag-${i}`,
      color: i % 2 === 0 ? "teal" : "blue",
    }));
    doc.tagIdsByRootSessionId = Object.fromEntries(roots.map((r) => [r, doc.tags.map((t) => t.id)]));
    return doc;
  });
}

// Seed tags AND enough label GROUPS to make the session tree deterministically
// overflow a short sidebar: group headers add rows, tags add a chip line per
// root row. Seeded AFTER first load (the labels store validates newly
// referenced roots against the server's active-root inventory, which is only
// populated once the aggregator has hydrated the project).
async function seedTreeOverflow(request: APIRequestContext, roots: string[]) {
  await withLabels(request, (doc) => {
    doc.tags = [
      { id: "lt-eink-0", name: "eink-a", color: "teal" },
      { id: "lt-eink-1", name: "eink-b", color: "blue" },
    ];
    doc.groups = [
      { id: "lg-eink-1", name: "Group one", color: "teal", collapsed: false, orderedRootSessionIds: roots.slice(0, 2) },
      { id: "lg-eink-2", name: "Group two", color: "blue", collapsed: false, orderedRootSessionIds: roots.slice(2, 4) },
      { id: "lg-eink-3", name: "Group three", color: "purple", collapsed: false, orderedRootSessionIds: roots.slice(4, 6) },
    ];
    doc.tagIdsByRootSessionId = Object.fromEntries(roots.map((r) => [r, ["lt-eink-0", "lt-eink-1"]]));
    return doc;
  });
}

// One scroller's geometry along an axis, in a single round trip. Takes a
// LOCATOR (not a selector string) so hashed CSS-module classes can be matched
// via [class*=…] where needed.
function axisGeom(loc: import("@playwright/test").Locator, axis: "x" | "y") {
  return loc.evaluate((el, ax) => {
    const h = el as HTMLElement;
    return ax === "x"
      ? { pos: h.scrollLeft, extent: Math.max(0, h.scrollWidth - h.clientWidth), client: h.clientWidth }
      : { pos: h.scrollTop, extent: Math.max(0, h.scrollHeight - h.clientHeight), client: h.clientHeight };
  }, axis);
}

// ── tests ───────────────────────────────────────────────────────────────────

// (1) OFF baseline: NONE of the Slice-3 paging bars ever mount while the
//     profile is off — on any owned surface, in any overflowing state. The
//     OFF render/event path is unchanged (behavioral contract; bundle bytes
//     necessarily differ).
test("e-ink OFF: surface paging bars are absent on every owned surface", async ({ page, request }) => {
  test.setTimeout(60_000);
  writeFixtureFiles();
  try {
    await openDemo(page); // boots WITHOUT the profile key
    // Tags seed the filter rail so its overflow condition is met under OFF.
    // (Seeded AFTER the app loaded: the labels store validates newly
    // referenced roots against the server's active-root inventory, which is
    // populated once the aggregator has hydrated the demo project.)
    await seedTags(request, 6, ["demo", "other", "slow"]);
    await page.reload();
    await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10_000 });
    // Reasoning expanded (an overflowing nested body exists)…
    await page.locator("button.tool-head", { hasText: "Thinking" }).first().click();
    await expect(page.locator(".reasoning-body")).toBeVisible();
    // …filter rail open (overflowing chip rail exists)…
    await page.setViewportSize({ width: 400, height: 600 });
    await page.locator('[aria-label="Toggle sidebar"]').click();
    await page.locator('[aria-label="Filter sessions by tags"]').click();
    await expect(page.locator('[role="group"][aria-label="Filter sessions by tag"]')).toBeVisible();
    // …settings dialog open (overflowing body exists)…
    await page.locator(".sidebar-close").click(); // close the slide-over
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.locator('[data-eink="surface-paging"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    // …code viewer open on the long-line diff (overflowing x surface)…
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const code = page.frameLocator('iframe[title="Code"]');
    await code.locator('[aria-label="Filters"]').click();
    await code.locator(".code-filter-item", { hasText: "Ignored files" }).locator("input").click();
    await code.locator(".code-side-head").click(); // outside click closes the menu
    await code.locator(".code-tree-row", { hasText: DIFF_NAME }).click();
    await expect(code.locator(".code-tab-name", { hasText: DIFF_NAME })).toBeVisible({ timeout: 8000 });
    // …and nowhere else in the main document.
    await expect(page.locator('[data-eink="surface-paging"]')).toHaveCount(0);
    await expect(code.locator('[data-eink="surface-paging"]')).toHaveCount(0);
    await expect(page.locator('[data-eink="paging"]')).toHaveCount(0); // the S1 bar too
  } finally {
    removeFixtureFiles();
  }
});

// (2) Session tree: every tree row is reachable via repeated REAL Prev/Next
//     presses (first/middle/last covered — no dragging), only the tree moves
//     (the chat behind it is stationary), and the selected row keeps its
//     selection context through the traversal.
test("e-ink ON: session tree pages discretely, alone; selection context preserved", async ({ page, request }) => {
  test.setTimeout(60_000);
  await bootEink(page);
  // Desktop-column sidebar (wide tier) at a short height; seeded groups +
  // tags (headers + chip rows) make the tree deterministically overflow.
  // Seeded after load (see seedTreeOverflow), then reloaded so the tree
  // renders the seeded structure.
  await page.setViewportSize({ width: 780, height: 380 });
  await openDemo(page);
  await seedTreeOverflow(request, ["demo", "other", "slow", "mdhard", "mermaid", "editpvw"]);
  await page.reload();
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-eink-surface="tree"]')).toBeVisible({ timeout: 5000 });

  // Precondition (diagnosable): the tree genuinely overflows at this viewport.
  const g0 = await axisGeom(page.locator(".tree"), "y");
  expect(g0.extent, "tree must overflow for this test to be meaningful").toBeGreaterThan(0);

  // Select a DIFFERENT session (context to preserve). The switch is async
  // (session load over SSE): wait for it to LAND before capturing anything —
  // under a busy shared backend the capture could otherwise race the switch.
  // (The "other" session is empty, so the tree test's chat-stationarity check
  // is intentionally the light form; the strong background-stationary proof
  // for this slice lives in the settings-dialog test.)
  await page.locator(".tree-row", { hasText: "Another root" }).click();
  await expect(page.locator(".tree-row.selected", { hasText: "Another root" })).toBeVisible();
  await expect(page).toHaveURL(/session=other/, { timeout: 10_000 });
  await page.waitForTimeout(300); // let the empty-session view settle
  const chatBefore = await page.locator(".chat-scroll").evaluate((el: HTMLElement) => el.scrollTop);
  expect(chatBefore).toBeGreaterThanOrEqual(0);

  // Park at the TOP via repeated REAL Prev presses.
  for (let i = 0; i < 40; i++) {
    const before = (await axisGeom(page.locator(".tree"), "y")).pos;
    await page.locator('[data-eink-surface="tree"] [data-eink="surface-prev"]').click();
    const after = (await axisGeom(page.locator(".tree"), "y")).pos;
    if (after === 0) break;
    expect(after).toBeLessThan(before);
  }
  expect((await axisGeom(page.locator(".tree"), "y")).pos).toBe(0);

  // Traverse DOWN with real Next presses, recording which tree rows are
  // visible at each stop, until the extent (a further press is a no-op).
  const seen = new Set<number>();
  const stops: number[] = [];
  for (let i = 0; i < 60; i++) {
    const g = await axisGeom(page.locator(".tree"), "y");
    stops.push(g.pos);
    const visible = await page.evaluate(() => {
      const tree = document.querySelector(".tree") as HTMLElement | null;
      if (!tree) return [] as number[];
      const vp = tree.getBoundingClientRect();
      const out: number[] = [];
      document.querySelectorAll(".tree .tree-row").forEach((el, idx) => {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > vp.top + 1 && r.top < vp.bottom - 1) out.push(idx);
      });
      return out;
    });
    visible.forEach((idx) => seen.add(idx));
    const before = g.pos;
    await page.locator('[data-eink-surface="tree"] [data-eink="surface-next"]').click();
    const after = (await axisGeom(page.locator(".tree"), "y")).pos;
    if (Math.abs(after - before) <= 1) break; // no-op Next: extent reached
  }

  // Full coverage: EVERY rendered tree row intersected the viewport at some
  // stop (first/middle/last all reachable via the buttons alone).
  const total = await page.evaluate(
    () => Array.from(document.querySelectorAll(".tree .tree-row")).filter((el) => (el as HTMLElement).offsetHeight > 0).length,
  );
  expect(total).toBeGreaterThanOrEqual(5);
  const missed: number[] = [];
  for (let idx = 0; idx < total; idx++) if (!seen.has(idx)) missed.push(idx);
  expect(missed, `tree rows never in view: ${missed.join(",")}`).toEqual([]);

  // Bounded advance: no stop skipped a band taller than the tree viewport.
  const client = (await axisGeom(page.locator(".tree"), "y")).client;
  for (let i = 1; i < stops.length; i++) {
    expect(stops[i] - stops[i - 1]).toBeGreaterThan(0);
    expect(stops[i] - stops[i - 1]).toBeLessThanOrEqual(client + 1);
  }

  // Only the tree moved: the chat behind is exactly where it was.
  const chatAfter = await page.locator(".chat-scroll").evaluate((el: HTMLElement) => el.scrollTop);
  expect(chatAfter).toBe(chatBefore);

  // Selection context preserved through the traversal: still selected, and
  // the row still opens its session when clicked. (The "other" session is
  // legitimately EMPTY in the fixture — the proof of opening is the URL and
  // the empty-state, not .msg rows.)
  await expect(page.locator(".tree-row.selected", { hasText: "Another root" })).toBeVisible();
  await page.locator(".tree-row.selected", { hasText: "Another root" }).click();
  await expect(page).toHaveURL(/session=other/);
  await expect(page.getByText("No messages in this session yet.")).toBeVisible();
});

// (3) Tag-filter rail: on TOUCH (pointer:coarse) devices the rail is a
//     single nowrap row with hidden horizontal scroll (Sidebar.module.css
//     wraps it on fine pointers instead — Desktop Chrome at a narrow
//     viewport would never overflow). This test drives its OWN touch context
//     (the labels spec's browser.newContext idiom; explicit touch flags per
//     header.spec.ts's "touch / mobile" descriptor — no device presets) so
//     the coarse-pointer CSS branch is what renders; discrete left/right
//     steps must then expose every chip, and chip filtering still works
//     after traversal.
test("e-ink ON: tag-filter rail pages horizontally; chips stay operable", async ({ browser, request }) => {
  test.setTimeout(60_000);
  const ctx = await browser.newContext({
    viewport: { width: 400, height: 600 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8099",
  });
  const page = await ctx.newPage();
  try {
    await bootEink(page);
    await page.setViewportSize({ width: 400, height: 600 });
    await openDemo(page);
    // Seed AFTER load (active-root inventory; see the tree test), then reload.
    await seedTags(request, 6, ["demo"]);
    await page.reload();
    await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10_000 });
    // Open the mobile slide-over sidebar, then the filter rail. Both setup
    // actions dispatch a DOM click() on the real button: under accumulated
    // lane state the header's tabbar can overlap the nav-toggle's click point
    // (a pre-existing narrow-viewport layout collision, disclosed in the
    // slice report — hit-testing returns a .tabbar-tab over the button), so
    // actionability-checked clicks hang and even forced points can land
    // outside the viewport. These are SETUP actions only; every traversal
    // click below (inside the drawer, above the main area) is a real
    // actionability-checked click on the real event path.
    await page.locator('[aria-label="Toggle sidebar"]').evaluate((el) => (el as HTMLElement).click());
    await page.locator('[aria-label="Filter sessions by tags"]').evaluate((el) => (el as HTMLElement).click());
    const rail = page.locator('[role="group"][aria-label="Filter sessions by tag"]');
    await expect(rail).toBeVisible({ timeout: 10_000 });

    // Bounded guard before EVERY rail round trip below: a locator.evaluate
    // auto-waits forever for its element, so a mid-test rail unmount must
    // fail FAST here (with a locator error) instead of hanging the test.
    const railLeft = async () => {
      await expect(rail).toBeVisible({ timeout: 3000 });
      return rail.evaluate((el: HTMLElement) => el.scrollLeft);
    };
    const rg = await rail.evaluate((el: HTMLElement) => ({
      extent: el.scrollWidth - el.clientWidth,
    }));
    test.skip(rg.extent <= 1, "rail fits — nothing to page (viewport/tag-count dependent)");
    await expect(page.locator('[data-eink-surface="filter-rail"][data-axis="x"]')).toBeVisible();

    // Park fully left, then traverse right with REAL presses, recording which
    // chips are visible at each stop, until the extent.
    await page.locator('[data-eink-surface="filter-rail"] [data-eink="surface-prev"]').click();
    expect(await railLeft()).toBe(0);
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const before = await railLeft();
      const visible = await rail.evaluate((el: HTMLElement) => {
        const vp = el.getBoundingClientRect();
        const out: number[] = [];
        el.querySelectorAll("button").forEach((b, idx) => {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.right > vp.left + 1 && r.left < vp.right - 1) out.push(idx);
        });
        return out;
      });
      visible.forEach((idx) => seen.add(idx));
      await page.locator('[data-eink-surface="filter-rail"] [data-eink="surface-next"]').click();
      const after = await railLeft();
      if (Math.abs(after - before) <= 1) break;
    }
    const chips = await rail.evaluate((el: HTMLElement) => el.querySelectorAll("button").length);
    const missed: number[] = [];
    for (let i = 0; i < chips; i++) if (!seen.has(i)) missed.push(i);
    expect(missed, `chips never in view: ${missed.join(",")}`).toEqual([]);

    // A chip still filters after traversal (the rail's own action preserved).
    const chip = page.locator('[role="group"][aria-label="Filter sessions by tag"] button', { hasText: "eink-tag-3" });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  } finally {
    await ctx.close();
  }
});

// (4) Settings dialog body: the ACTIVE body pages (first/middle/last rows
//     reachable), the background chat NEVER moves, the focus trap keeps focus
//     inside the dialog, dialog actions stay reachable, the bar hides on a
//     section that fits, and the profile hint describes paging accurately.
test("e-ink ON: settings body pages alone; trap, actions, and overflow gating intact", async ({ page }) => {
  test.setTimeout(60_000);
  await bootEink(page);
  await page.setViewportSize({ width: 400, height: 560 });
  await openDemo(page);
  // The settings body is a CSS-module class (hashed in the DOM) — match by
  // stable substring instead of the bare class name.
  const settingsBody = page.locator('[class*="settings-content"]');
  const chatScroll = page.locator(".chat-scroll");
  await chatScroll.evaluate((el: HTMLElement) => (el.scrollTop = 120)); // park mid-transcript (non-vacuity; the authoritative capture happens late, below)

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  // Appearance is the long section — its body overflows at this viewport.
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const bar = page.locator('[data-eink-surface="settings"]');
  await expect(bar).toBeVisible({ timeout: 5000 });

  // Coverage: park at the top, then traverse with REAL presses recording
  // which settings rows/hints are visible at each stop.
  for (let i = 0; i < 40; i++) {
    await page.locator('[data-eink-surface="settings"] [data-eink="surface-prev"]').click();
    if ((await axisGeom(settingsBody, "y")).pos === 0) break;
  }
  expect((await axisGeom(settingsBody, "y")).pos).toBe(0);

  // Capture the transcript position LATE — after the app's own load-restore
  // has settled (in the full serial lane the shared demo transcript is long
  // and its restore re-pin can legitimately land seconds after boot, which
  // would make an early capture vacuously fail). Poll until the chat stops
  // moving, THEN capture: from here on, any movement is attributable to the
  // dialog paging under test.
  let chatBefore = -1;
  for (let i = 0; i < 12; i++) {
    const a = await chatScroll.evaluate((el: HTMLElement) => el.scrollTop);
    await page.waitForTimeout(300);
    const b = await chatScroll.evaluate((el: HTMLElement) => el.scrollTop);
    if (a === b) {
      chatBefore = b;
      break;
    }
  }
  expect(chatBefore).toBeGreaterThanOrEqual(0);

  const seen = new Set<number>();
  for (let i = 0; i < 60; i++) {
    const g = await axisGeom(settingsBody, "y");
    const visible = await settingsBody.evaluate((el: HTMLElement) => {
      const vp = el.getBoundingClientRect();
      const out: number[] = [];
      el.querySelectorAll(".setting-row, .setting-hint").forEach((row, idx) => {
        const r = row.getBoundingClientRect();
        if (r.height > 0 && r.bottom > vp.top + 1 && r.top < vp.bottom - 1) out.push(idx);
      });
      return out;
    });
    visible.forEach((idx) => seen.add(idx));
    const before = g.pos;
    await page.locator('[data-eink-surface="settings"] [data-eink="surface-next"]').click();
    const after = (await axisGeom(settingsBody, "y")).pos;
    if (Math.abs(after - before) <= 1) break;
  }
  const total = await settingsBody.evaluate(
    (el: HTMLElement) =>
      Array.from(el.querySelectorAll(".setting-row, .setting-hint")).filter(
        (row) => (row as HTMLElement).offsetHeight > 0,
      ).length,
  );
  const missed: number[] = [];
  for (let i = 0; i < total; i++) if (!seen.has(i)) missed.push(i);
  expect(missed, `settings rows never in view: ${missed.join(",")}`).toEqual([]);

  // Only the intended surface moved: the chat behind the overlay is parked
  // exactly where it was (dialog paging never scrolls the background chat).
  expect(await chatScroll.evaluate((el: HTMLElement) => el.scrollTop)).toBe(chatBefore);

  // Focus trap: after real pager clicks, focus is still INSIDE the dialog
  // (the buttons never move focus out — pointerdown is preventDefaulted).
  const focusInside = await dialog.evaluate((el) => el.contains(document.activeElement));
  expect(focusInside).toBe(true);

  // Dialog actions remain reachable while the bar is mounted: a real toggle
  // (and back — leave state as found).
  const notes = dialog.getByRole("checkbox", { name: "Notes tab" });
  await dialog.getByRole("button", { name: "General" }).click();
  await notes.click();
  await expect(notes).toBeChecked();
  await notes.click();
  await expect(notes).not.toBeChecked();

  // Overflow gating: the short About section fits — the bar unmounts…
  await dialog.getByRole("button", { name: "About" }).click();
  await expect(bar).toHaveCount(0);
  // …and returns for a section that overflows.
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await expect(bar).toBeVisible({ timeout: 5000 });

  // Accurate paging help copy: the profile hint mentions the page buttons.
  const hint = page.locator(".setting-hint", { hasText: "page buttons" });
  await expect(hint.first()).toBeVisible();

  // Escape (the dialog's own key path) still closes.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

// (5) Nested reasoning body: the bounded thinking scroller pages INDEPENDENTLY
//     of the transcript (chat scrollTop untouched), reaches its top and tail
//     via real presses, and the disclosure still collapses afterwards.
test("e-ink ON: reasoning body pages independently of the transcript", async ({ page }) => {
  test.setTimeout(60_000);
  await bootEink(page);
  await page.setViewportSize({ width: 400, height: 600 });
  await openDemo(page);
  // Park the reader in history FIRST with one real S1 prev-page press: a
  // tail-FOLLOWING reader is legitimately re-pinned by the app's own
  // recovery machinery as the disclosure animates/grows — parking
  // deterministically ends that regime, so any later transcript movement is
  // attributable to the paging actions under test.
  await page.locator('[data-eink="prev-page"]').click();
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });

  // The demo's last turn carries a LONG settled reasoning (p10: a ~2.7k-char
  // thinking block) inside the auto-expanded activity group — collapsed by
  // default (not the tail part). Expand it. NOTE: an earlier turn carries a
  // SHORT reasoning (p2r) whose body does NOT overflow — .last() targets
  // p10's head/body (document order), the one this test pages.
  const head = page.locator("button.tool-head", { hasText: "Thinking" }).last();
  await head.click();
  const body = page.locator(".reasoning-body").last();
  await expect(body).toBeVisible();
  // Precondition: the body genuinely overflows its 320px bound.
  const bg = await body.evaluate((el: HTMLElement) => ({
    extent: el.scrollHeight - el.clientHeight,
    top: el.scrollTop,
  }));
  expect(bg.extent).toBeGreaterThan(0);
  const bar = page.locator('[data-eink-surface="reasoning"]');
  await expect(bar).toBeVisible({ timeout: 5000 });

  // Bring the whole reasoning block (head + 320px body + paging bar) fully
  // into the chat viewport BEFORE any assertion: Playwright's click
  // actionability would otherwise scroll `.chat-scroll` itself to reveal a
  // bar sitting at the viewport's edge — legitimate TEST-DRIVEN movement
  // that has nothing to do with the paging actions under test. This setup
  // scroll is programmatic and one-time (the suite's established setup
  // pattern; the invariant below is asserted across the CLICKS only).
  await page.locator('[data-eink-surface="reasoning"]').evaluate((el: HTMLElement) =>
    el.scrollIntoView({ block: "end" }),
  );
  await page.waitForTimeout(250);
  const chatBefore = await page.locator(".chat-scroll").evaluate((el: HTMLElement) => el.scrollTop);
  // The bar must be fully inside the chat viewport for the invariant to be
  // attributable to the clicks (Playwright never needs to scroll for them).
  const barInChatView = await page.locator('[data-eink-surface="reasoning"]').evaluate((el: HTMLElement) => {
    const chat = el.closest(".chat-scroll") as HTMLElement | null;
    if (!chat) return false;
    const r = el.getBoundingClientRect();
    const c = chat.getBoundingClientRect();
    return r.bottom <= c.bottom && r.top >= c.top;
  });
  expect(barInChatView).toBe(true);

  // Park at the body's top via real Prev presses.
  for (let i = 0; i < 20; i++) {
    const before = await body.evaluate((el: HTMLElement) => el.scrollTop);
    await page.locator('[data-eink-surface="reasoning"] [data-eink="surface-prev"]').click();
    const after = await body.evaluate((el: HTMLElement) => el.scrollTop);
    if (after === 0) break;
    expect(after).toBeLessThan(before);
  }
  expect(await body.evaluate((el: HTMLElement) => el.scrollTop)).toBe(0);

  // A middle stop exists (a real intermediate position was visited above), and
  // the tail is reachable via real Next presses: the last content edge of the
  // thinking text is fully in view at the final stop.
  for (let i = 0; i < 20; i++) {
    const before = await body.evaluate((el: HTMLElement) => el.scrollTop);
    await page.locator('[data-eink-surface="reasoning"] [data-eink="surface-next"]').click();
    const after = await body.evaluate((el: HTMLElement) => el.scrollTop);
    if (Math.abs(after - before) <= 1) break;
  }
  const atEnd = await body.evaluate((el: HTMLElement) => {
    const last = el.lastElementChild as HTMLElement | null;
    return !!last && el.scrollHeight - el.scrollTop - el.clientHeight <= 1 && last.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1;
  });
  expect(atEnd, "reasoning tail content fully reached").toBe(true);

  // Independence: the transcript did not move one pixel.
  expect(await page.locator(".chat-scroll").evaluate((el: HTMLElement) => el.scrollTop)).toBe(chatBefore);

  // The disclosure still collapses (the tool/reasoning action is preserved).
  // The body stays MOUNTED for the close animation (Part.tsx keeps revealed
  // content mounted) — and CLIPPING does not shrink a child's layout box, so
  // the honest collapse contract is the STATE (the disclosure wrapper loses
  // .open) plus the GEOMETRY (the 0fr clip is zero-height; the body and its
  // pager are both clipped away inside it).
  await head.click();
  await page.waitForTimeout(350); // close animation (grid 0fr transition)
  const collapse = await body.evaluate((el) => {
    const clip = el.parentElement as HTMLElement;
    const wrap = clip.parentElement as HTMLElement;
    return {
      clipH: clip.getBoundingClientRect().height,
      wrapOpen: wrap.className.includes("open"),
    };
  });
  expect(collapse.wrapOpen).toBe(false);
  expect(collapse.clipH).toBeLessThanOrEqual(1);
});

// (6) Code/diff pane: HORIZONTAL discrete steps traverse wide diff lines
//     (start/middle/end sentinels each become visible), +/- sigils and the
//     whole text survive traversal byte-for-byte, the Wrap control removes
//     the pager when nothing overflows, and images keep original fidelity
//     (no blanket grayscale filters).
test("e-ink ON: code pane pages horizontally; +/- preserved; wrap interacts; images unfiltered", async ({ page }) => {
  test.setTimeout(90_000);
  await bootEink(page);
  writeFixtureFiles();
  try {
    await page.setViewportSize({ width: 400, height: 620 });
    await openDemo(page);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const code = page.frameLocator('iframe[title="Code"]');
    // The demo project dir lives under the repo-ignored tmp/ tree, so EVERY
    // file in it is git-ignored and the code tree hides ignored entries by
    // default — enable "Ignored files" (a stock control) before browsing.
    await code.locator('[aria-label="Filters"]').click();
    await code.locator(".code-filter-item", { hasText: "Ignored files" }).locator("input").click();
    await code.locator(".code-side-head").click(); // outside click closes the menu
    await code.locator(".code-tree-row", { hasText: DIFF_NAME }).click();
    await expect(code.locator(".code-tab-name", { hasText: DIFF_NAME })).toBeVisible({ timeout: 8000 });

    const pane = code.locator(".code-pane");
    const bar = code.locator('[data-eink-surface="code"][data-axis="x"]');
    await expect(bar).toBeVisible({ timeout: 5000 });
    // Precondition: horizontal overflow is real.
    const pg0 = await pane.evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth);
    expect(pg0).toBeGreaterThan(0);

    // Content integrity baseline (the +/- diff sigils are in the text).
    const textBefore = (await pane.textContent()) ?? "";
    expect(textBefore).toContain(X_SENTINELS[0]);
    // The +/- sigil lines are present verbatim (sigil semantics preserved).
    for (const l of diffSigilLines()) expect(textBefore).toContain(l);

    // Park fully left, then traverse right with REAL presses, recording which
    // sentinels are visible at each stop (Range rects over the text nodes).
    await code.locator('[data-eink-surface="code"] [data-eink="surface-prev"]').click();
    expect(await pane.evaluate((el: HTMLElement) => el.scrollLeft)).toBe(0);
    const seenSentinels = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const before = await pane.evaluate((el: HTMLElement) => el.scrollLeft);
      const visible = await pane.evaluate((el: HTMLElement, sts: string[]) => {
        const paneRect = el.getBoundingClientRect();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const found: string[] = [];
        let n: Node | null;
        while ((n = walker.nextNode())) {
          const text = n.textContent ?? "";
          for (const s of sts) {
            if (found.includes(s)) continue;
            const at = text.indexOf(s);
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(n, at);
            range.setEnd(n, at + s.length);
            const r = range.getBoundingClientRect();
            if (r.width > 0 && r.right > paneRect.left + 1 && r.left < paneRect.right - 1) found.push(s);
          }
        }
        return found;
      }, X_SENTINELS);
      visible.forEach((s) => seenSentinels.add(s));
      await code.locator('[data-eink-surface="code"] [data-eink="surface-next"]').click();
      const after = await pane.evaluate((el: HTMLElement) => el.scrollLeft);
      if (Math.abs(after - before) <= 1) break;
    }
    // Start, middle, and end sentinels all became visible at some stop.
    for (const s of X_SENTINELS) expect(seenSentinels, `sentinel ${s} never visible`).toContain(s);
    // Endpoint reachability: the traversal actually reached the right edge.
    const endPos = await pane.evaluate((el: HTMLElement) => el.scrollLeft);
    const extent = await pane.evaluate(
      (el: HTMLElement) => el.scrollWidth - el.clientWidth,
    );
    expect(extent - endPos).toBeLessThanOrEqual(1);

    // Content integrity AFTER traversal: byte-identical text, sigils intact.
    const textAfter = (await pane.textContent()) ?? "";
    expect(textAfter).toBe(textBefore);

    // Wrap control interaction: wrap removes the overflow → the pager hides;
    // unwrapping restores it.
    await code.getByRole("button", { name: "Wrap" }).click();
    await expect(code.locator(".code-pane.wrap")).toBeVisible();
    await expect(bar).toHaveCount(0, { timeout: 5000 });
    await code.getByRole("button", { name: "Wrap" }).click();
    await expect(bar).toBeVisible({ timeout: 5000 });

    // Image fidelity: open the PNG — computed filter must be none (no blanket
    // grayscale/contrast filter under the profile).
    await code.locator('[aria-label="Files"]').click();
    await code.locator(".code-tree-row", { hasText: PNG_NAME }).click();
    await expect(code.locator(".code-image img")).toBeVisible({ timeout: 8000 });
    const filter = await code.locator(".code-image img").evaluate((el) => getComputedStyle(el).filter);
    expect(filter).toBe("none");
  } finally {
    removeFixtureFiles();
  }
});

// (7) Diagrams: the mermaid expand overlay (the fit/detail + zoom escape)
//     still works under the profile, and the diagram keeps original fidelity
//     (no blanket filters). Discrete STEPPING inside the overlay viewport is
//     NOT implemented in this slice — see the closeout's scope disclosure.
test("e-ink ON: mermaid expand/escape preserved; diagram unfiltered", async ({ page }) => {
  test.setTimeout(60_000);
  await bootEink(page);
  await page.setViewportSize({ width: 780, height: 560 });
  await openDemo(page);
  await page.locator(".tree-row", { hasText: "Mermaid diagrams" }).click();
  const inline = page.locator('[data-mermaid="inline"]');
  await expect(inline).toBeVisible({ timeout: 8000 });
  // Original fidelity: no blanket filter on the rendered diagram.
  const filter = await inline.locator("svg").first().evaluate((el) => getComputedStyle(el).filter);
  expect(filter).toBe("none");
  // The expand escape (fit/detail access + Esc/back close) is intact.
  await inline.getByTitle("Expand diagram").click();
  await expect(page.locator('[data-mermaid="overlay"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-mermaid="overlay"]')).toHaveCount(0);
});

// (8) Composer/resize remeasure: growing the composer (long draft) and
//     resizing the viewport both shrink the chat viewport AFTER the profile
//     bar mounted — every subsequent page press must step against the CURRENT
//     geometry (bounded by the shrunk viewport) and still reach the tail, so
//     no content becomes unreachable. Editing survives paging (long draft
//     intact).
test("e-ink ON: composer growth and viewport resize remeasure chat paging; no stranded content", async ({ page }) => {
  test.setTimeout(60_000);
  await bootEink(page);
  await page.setViewportSize({ width: 400, height: 600 });
  await openDemo(page);
  // The S1 chat bar is present under ON.
  const bar = page.locator('[data-eink="paging"]');
  await expect(bar).toBeVisible();

  // A LONG draft grows the composer (autosize) — the transcript viewport
  // shrinks by that height AFTER the bar mounted.
  const ta = page.locator(".composer-text");
  await ta.click();
  await ta.fill(Array.from({ length: 30 }, (_, i) => `line ${i + 1} — a reasonably long draft line for the autosizer`).join("\n"));
  await page.waitForTimeout(350); // autosize rAF
  const draft = await ta.inputValue();
  expect(draft.length).toBeGreaterThan(300);

  const geom = () => axisGeom(page.locator(".chat-scroll"), "y");
  const shrunk = await geom();
  // The transcript still overflows at the shrunk viewport.
  expect(shrunk.extent).toBeGreaterThan(0);

  // Park in history with real Prev presses (establish reading intent).
  for (let i = 0; i < 80; i++) {
    const before = (await geom()).pos;
    await page.locator('[data-eink="prev-page"]').click();
    const after = (await geom()).pos;
    if (after === 0) break;
    expect(after).toBeLessThan(before);
  }

  // Page FORWARD to the tail with real Next presses. Every step must be
  // bounded by the CURRENT (post-growth) client height — a stale, pre-growth
  // geometry would step larger than the viewport — and the tail must be
  // reached (nothing stranded below the fold).
  let reachedTail = false;
  for (let i = 0; i < 80; i++) {
    const g = await geom();
    if (g.extent - g.pos < 24) {
      reachedTail = true;
      break;
    }
    await page.locator('[data-eink="next-page"]').click();
    const g2 = await geom();
    const delta = g2.pos - g.pos;
    expect(delta).toBeGreaterThan(0);
    expect(delta, "step bounded by the CURRENT viewport (remeasured at action time)").toBeLessThanOrEqual(shrunk.client + 1);
  }
  expect(reachedTail, "tail reachable after composer growth").toBe(true);

  // Viewport resize (the keyboard/resize class): geometry changes AGAIN, and
  // paging still moves with fresh, bounded steps.
  await page.setViewportSize({ width: 400, height: 500 });
  await page.waitForTimeout(300);
  await page.locator('[data-eink="prev-page"]').click();
  const gA = await geom();
  expect(gA.pos).toBeLessThan(gA.extent); // parked off-tail again
  await page.locator('[data-eink="next-page"]').click();
  const gB = await geom();
  expect(gB.pos - gA.pos).toBeGreaterThan(0);
  expect(gB.pos - gA.pos).toBeLessThanOrEqual(gA.client + 1);

  // The draft survived the paging interactions untouched.
  expect(await ta.inputValue()).toBe(draft);
});

// Label state is bracketed: this spec seeds tags/groups via the real API, and
// the serial suite shares one backend — reset before AND after so neither this
// spec's earlier tests nor sibling specs see leaked label state.
test.beforeEach(async ({ request }) => {
  await resetLabels(request);
});
test.afterEach(async ({ request }) => {
  await resetLabels(request);
});
