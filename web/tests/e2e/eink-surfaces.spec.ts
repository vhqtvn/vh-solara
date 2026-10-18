import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
// Slice 3b (this file's later tests) completes the three surfaces S3 stopped
// on — same adapter, same coverage-loop style:
//
//   notes pane (vertical; editing semantics untouched) · mermaid expand
//   overlay (vertical, INSIDE the portaled overlay; Esc/close/zoom-escape
//   preserved) · ToolPart's nested .tool-output / .tool-edit scrollers
//   (vertical, independent of the transcript; disclosures preserved).
//
// All traversal is REAL button clicks on the real Chromium event path — never
// direct handler calls, never dragging, never synthetic scrollTop parking for
// the states under test. Physical e-ink panel outcomes (flash/ghosting, real
// handheld key delivery) are OUT of this spec's scope: browser automation
// proves only browser properties.
//
// Serial lane (workers:1, one shared mutable fixture backend): every test
// reloads the demo session; label state seeded via the real /vh/labels API is
// bracketed with resetLabels (and notes-doc state with resetNotes) so nothing
// leaks into sibling specs.

// ── shared helpers ──────────────────────────────────────────────────────────

// Boot the SPA with the e-ink profile already enabled in storage (the saved
// preference — the manual activation path; scroll-follow.spec.ts's idiom).
async function bootEink(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("vh.prefs.einkProfile.v1", JSON.stringify({ v: 1, data: true }));
  });
}

// "Paging bar fully inside the chat viewport" setup invariant, with a 1px
// sub-pixel slack. scrollIntoView({ block: "end" }) aligns the bar's bottom to
// the scrollport bottom EXACTLY in ideal math, but Chromium quantizes the
// programmatic scroll offset to whole device pixels (DPR 1), leaving a
// residual of up to ±0.5px whose SIGN depends on the fractional layout
// heights of the environment — CI's freshly installed font set shifts text
// metrics, so the same alignment that reads −0.34px locally reads +0.2…0.5px
// on the runner (run 39108418154: 3/3 deterministic false with the bar
// PAINTED fully at the viewport bottom — an invisible sub-pixel overshoot the
// zero-tolerance `r.bottom <= c.bottom` turned into a hard failure). The
// invariant's meaning is "Playwright's click actionability never needs to
// scroll for the bar" — a sub-pixel-adjacent rect does not trigger it, so the
// 1px slack preserves the invariant exactly while killing the coin flip.
function inChatViewport(el: HTMLElement): boolean {
  const chat = el.closest(".chat-scroll") as HTMLElement | null;
  if (!chat) return false;
  const r = el.getBoundingClientRect();
  const c = chat.getBoundingClientRect();
  return r.bottom <= c.bottom + 1 && r.top >= c.top - 1;
}

async function openDemo(page: Page) {
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10_000 });
  // CI cold-daemon guard (2026-10-17 run 39028326511: test 5 failed 3/3 with
  // the reasoning paging bar tens of px below the chat viewport after its
  // one-time setup scroll): on a slow first boot the daemon's opencode
  // status route 503s and the demo transcript hydrates PROGRESSIVELY — a
  // park/expand/scrollIntoView executed mid-arrival lands on stale
  // geometry, and content arriving after the one-time setup scroll shifts
  // the bar below the viewport before the assertion reads it. Locally (warm
  // daemon) hydration beats the test, which is why the failure never
  // reproduced in isolation. Wait for the transcript to QUIESCE — message
  // count + chat scrollHeight stable across three 150ms samples — before
  // any test interacts with it. Purely additive (~300ms) when already
  // settled; bounded at ~15s so a wedged stream cannot hang a test.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const chat = document.querySelector(".chat-scroll");
        if (!chat) return resolve();
        let m = -1;
        let s = -1;
        let stable = 0;
        let tries = 0;
        const tick = () => {
          const m2 = document.querySelectorAll(".msg").length;
          const s2 = Math.round((chat as HTMLElement).scrollHeight);
          if (m2 === m && s2 === s) {
            if (++stable >= 3) return resolve();
          } else {
            stable = 0;
          }
          m = m2;
          s = s2;
          if (++tries > 100) return resolve();
          setTimeout(tick, 150);
        };
        tick();
      }),
  );
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

// Which of the given needle substrings are VISIBLE inside one scroller (a
// Range over the owning text node, rect intersecting the scroller's box on
// BOTH axes) — the coverage-loop primitive for text-marked surfaces (the
// code-pane sentinel check, generalized off the x axis).
function visibleNeedles(loc: import("@playwright/test").Locator, needles: string[]) {
  return loc.evaluate((el, ns) => {
    const h = el as HTMLElement;
    const vp = h.getBoundingClientRect();
    const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    const found: string[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const text = n.textContent ?? "";
      for (const s of ns) {
        if (found.includes(s)) continue;
        const at = text.indexOf(s);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(n, at);
        range.setEnd(n, at + s.length);
        const r = range.getBoundingClientRect();
        if (
          r.width > 0 &&
          r.right > vp.left + 1 && r.left < vp.right - 1 &&
          r.bottom > vp.top + 1 && r.top < vp.bottom - 1
        ) found.push(s);
      }
    }
    return found;
  }, needles);
}

// Reset the notes doc (todos + markdown) to empty via the real /vh/notes API —
// the same serial-suite bracket discipline as resetLabels: the notes test
// creates todos through the real form (they persist daemon-side), and the
// suite shares one backend. Scoped to the demo project key via
// x-opencode-directory (the header the SPA's installCsrf stamps on every
// request; the notes doc is per-project).
async function resetNotes(request: APIRequestContext) {
  const put = await request.put("/vh/notes", {
    headers: { "X-VH-CSRF": "1", "x-opencode-directory": demoDir },
    data: { notes: "", todos: [] },
  });
  if (!put.ok()) throw new Error(`resetNotes: PUT /vh/notes -> ${put.status}`);
}

// Restore a session's seeded baseline (serial-suite hygiene; part-delta.spec's
// resetSession shape). NOTE: the shell-simulation turns the tool-output test
// injects are NOT persisted by the fake, so reset cannot remove them from the
// aggregator store — that test keeps its markers run-unique and scopes its
// locators to them instead (disclosed in the test).
async function resetSession(page: Page, id: string) {
  const res = await page.request.post(`/oc/fixture/reset?session=${id}`, {
    headers: { "X-VH-CSRF": "1" },
  });
  if (!res.ok()) throw new Error(`resetSession(${id}) -> ${res.status} ${res.statusText()}`);
}

// ── tests ───────────────────────────────────────────────────────────────────

// (1) OFF baseline: NONE of the Slice-3/3b paging bars ever mount while the
//     profile is off — on any owned surface, in any overflowing state (the
//     mermaid leg drives a viewport where the overlay genuinely overflows, so
//     its absent bar is non-vacuous). The OFF render/event path is unchanged
//     (behavioral contract; bundle bytes necessarily differ).
test("e-ink OFF: surface paging bars are absent on every owned surface", async ({ page, request }) => {
  test.setTimeout(90_000);
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

    // …the 3b surfaces too. Notes tab enabled (an independent pref — the
    // profile stays OFF): an overflowing notes pane still mounts no bar…
    // (1280 default width: the tab must be OUT of the TabBar's "⋯" overflow
    // menu to be clickable — same posture as interactive.spec's notes test.)
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(() => {
      localStorage.setItem("vh.prefs.notesEnabled.v1", JSON.stringify({ v: 1, data: true }));
    });
    await openDemo(page);
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(page.locator(".notes-view")).toBeVisible();
    // Seed todos through the real form so the pane GENUINELY overflows —
    // otherwise the absent-bar assertion below would be vacuous for this
    // surface (the mermaid-overlay leg is the other non-vacuous OFF proof).
    for (let i = 0; i < 14; i++) {
      await page.getByPlaceholder("Add a to-do…").fill(`eink-off-${i}`);
      await page.getByRole("button", { name: "Add to-do" }).click();
    }
    const offNotesExtent = await page.locator(".notes-view").evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight);
    expect(offNotesExtent, "notes pane must overflow for this leg to be meaningful").toBeGreaterThan(0);
    await expect(page.locator('[data-eink="surface-paging"]')).toHaveCount(0);
    // …and the mermaid overlay at a SHORT viewport — where its diagram
    // viewport GENUINELY overflows, so a non-gated bar would mount — mounts
    // none (the strong OFF form for the overlay surface).
    await page.setViewportSize({ width: 780, height: 340 });
    await page.locator(".tree-row", { hasText: "Mermaid diagrams" }).click();
    await expect(page.locator('[data-mermaid="inline"] svg').first()).toBeVisible({ timeout: 8000 });
    await page.locator('[data-mermaid="inline"]').getByTitle("Expand diagram").click();
    const offOverlay = page.locator('[data-mermaid="overlay"]');
    await expect(offOverlay).toBeVisible();
    // Precondition: the overlay's diagram really overflows at this viewport
    // (otherwise the absent bar would be vacuous).
    const offOverlayExtent = await offOverlay
      .locator('[class*="viewport"]:not([class*="viewportSvg"])')
      .evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight);
    expect(offOverlayExtent, "overlay viewport must overflow for this leg to be meaningful").toBeGreaterThan(0);
    await expect(page.locator('[data-eink="surface-paging"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(offOverlay).toHaveCount(0);
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
  // inChatViewport carries the 1px sub-pixel slack (see its comment).
  const barInChatView = await page.locator('[data-eink-surface="reasoning"]').evaluate(inChatViewport);
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
//     Slice 3b's "mermaid overlay pages discretely" test below (it needs a
//     SHORT viewport to overflow; this test keeps the roomy one and covers
//     only the preserved escape semantics).
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

// (9) Notes pane (Slice 3b): the pane's OWN overflow (todos + notes doc over
//     the bounded pane) pages discretely — marked content (todo texts
//     first…last, plus the notes textarea at the pane's foot) reachable via
//     real button presses only. Note-editing semantics are exercised THROUGH
//     the paged pane afterwards (form submit, todo toggle, notes typing) to
//     pin that paging changed no editing behavior.
test("e-ink ON: notes pane pages discretely; note editing preserved", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    localStorage.setItem("vh.prefs.einkProfile.v1", JSON.stringify({ v: 1, data: true }));
    localStorage.setItem("vh.prefs.notesEnabled.v1", JSON.stringify({ v: 1, data: true }));
  });
  // Default 1280x720 viewport (the Notes tab is a TabBar item, and TabBar
  // collapses whatever doesn't fit into its "⋯" overflow menu at narrower
  // widths — interactive.spec's notes test clicks the tab at this default
  // width; 14 todos guarantee the pane's owned overflow at this height).
  await openDemo(page);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const notes = page.locator(".notes-view");
  await expect(notes).toBeVisible();

  // Grow the pane's owned overflow through the REAL form (typing + submit —
  // this is also the editing-preserved path under test): 14 todos.
  const TODO_N = 14;
  for (let i = 0; i < TODO_N; i++) {
    await page.getByPlaceholder("Add a to-do…").fill(`eink-notes-${i}`);
    await page.getByRole("button", { name: "Add to-do" }).click();
  }
  await expect(page.locator(".todo-item", { hasText: "eink-notes-0" })).toBeVisible();
  await expect(page.locator(".todo-item", { hasText: `eink-notes-${TODO_N - 1}` })).toBeVisible();

  const bar = page.locator('[data-eink-surface="notes"]');
  await expect(bar).toBeVisible({ timeout: 5000 });
  // The pane scroller is the bar's reserved-row sibling (the pane column's
  // first child — the adapter mounted under it).
  const pane = page.locator('[data-eink-surface="notes"] >> xpath=preceding-sibling::*[1]');
  const g0 = await axisGeom(pane, "y");
  expect(g0.extent, "notes pane must overflow at this viewport").toBeGreaterThan(0);

  // Park at the pane's top via real Prev presses (fresh geometry each press).
  for (let i = 0; i < 40; i++) {
    const before = (await axisGeom(pane, "y")).pos;
    await bar.locator('[data-eink="surface-prev"]').click();
    const after = (await axisGeom(pane, "y")).pos;
    if (after === 0) break;
    expect(after).toBeLessThan(before);
  }
  expect((await axisGeom(pane, "y")).pos).toBe(0);

  // Traverse with real Next presses; at every stop record which todo texts
  // are visible inside the pane scroller (rect intersection) and whether the
  // notes textarea (the pane's foot) is on screen. All 14 todos + the
  // textarea must be covered, steps bounded by the pane viewport, extent
  // reached.
  const seen = new Set<string>();
  let notesSeen = false;
  const stops: number[] = [];
  for (let i = 0; i < 40; i++) {
    const g = await axisGeom(pane, "y");
    stops.push(g.pos);
    const vis = await page.evaluate(() => {
      const scroller = (document.querySelector('[data-eink-surface="notes"]') as HTMLElement | null)
        ?.previousElementSibling as HTMLElement | null;
      if (!scroller) return { todos: [] as string[], notes: false };
      const vp = scroller.getBoundingClientRect();
      const todos: string[] = [];
      document.querySelectorAll(".notes-view .todo-item .todo-text").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > vp.top + 1 && r.top < vp.bottom - 1) todos.push(el.textContent || "");
      });
      const tr = document.querySelector(".notes-text")?.getBoundingClientRect();
      const notesVisible = !!tr && tr.bottom > vp.top + 1 && tr.top < vp.bottom - 1;
      return { todos, notes: notesVisible };
    });
    vis.todos.forEach((t) => seen.add(t));
    if (vis.notes) notesSeen = true;
    const before = g.pos;
    await bar.locator('[data-eink="surface-next"]').click();
    const after = (await axisGeom(pane, "y")).pos;
    if (Math.abs(after - before) <= 1) break;
  }
  for (let i = 0; i < TODO_N; i++) {
    expect(seen, `todo eink-notes-${i} never visible`).toContain(`eink-notes-${i}`);
  }
  expect(notesSeen, "notes textarea never visible").toBe(true);
  const gEnd = await axisGeom(pane, "y");
  expect(gEnd.extent - gEnd.pos, "traversal reached the pane extent").toBeLessThanOrEqual(1);
  for (let i = 1; i < stops.length; i++) {
    expect(stops[i] - stops[i - 1]).toBeGreaterThan(0);
    expect(stops[i] - stops[i - 1]).toBeLessThanOrEqual(gEnd.client + 1);
  }

  // Editing preserved THROUGH the paged pane — real interactions only (these
  // may scroll the pane as a side effect; every invariant above is already
  // asserted): toggle the last todo via its checkbox (aria flips)…
  await page.locator(".todo-item", { hasText: `eink-notes-${TODO_N - 1}` }).getByRole("button", { name: "Mark done" }).click();
  await expect(page.locator(".todo-item.done", { hasText: `eink-notes-${TODO_N - 1}` })).toBeVisible();
  await page.locator(".todo-item.done", { hasText: `eink-notes-${TODO_N - 1}` }).getByRole("button", { name: "Mark not done" }).click();
  await expect(page.locator(".todo-item.done", { hasText: `eink-notes-${TODO_N - 1}` })).toHaveCount(0);
  // …and the notes textarea still accepts typing.
  await page.locator(".notes-text").fill("eink notes survive paging");
  await expect(page.locator(".notes-text")).toHaveValue("eink notes survive paging");
});

// (10) Mermaid overlay (Slice 3b): at a SHORT viewport the expanded diagram
//     genuinely overflows the overlay's viewport — discrete vertical steps
//     (mounted INSIDE the portaled overlay, below the viewport) traverse the
//     marked nodes (Start top · Decision/Run/Skip middle · End bottom) via
//     real button presses. Only the overlay moves (transcript + page scroll
//     untouched), and the overlay's own close semantics — Esc, the explicit
//     Close button, the body scroll lock — are preserved.
test("e-ink ON: mermaid overlay pages discretely; Esc/close preserved; only the overlay moves", async ({ page }) => {
  test.setTimeout(60_000);
  await bootEink(page);
  await page.setViewportSize({ width: 780, height: 340 });
  await openDemo(page);
  await page.locator(".tree-row", { hasText: "Mermaid diagrams" }).click();
  const inline = page.locator('[data-mermaid="inline"]');
  await expect(inline.locator("svg").first()).toBeVisible({ timeout: 8000 });
  await inline.getByTitle("Expand diagram").click();
  const overlay = page.locator('[data-mermaid="overlay"]');
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  const bar = page.locator('[data-eink-surface="mermaid-overlay"]');
  await expect(bar).toBeVisible({ timeout: 5000 });
  const vp = page.locator('[data-mermaid="overlay"] [class*="viewport"]:not([class*="viewportSvg"])');
  const g0 = await axisGeom(vp, "y");
  expect(g0.extent, "overlay viewport must overflow at this short viewport").toBeGreaterThan(0);

  // The transcript behind the scrim never moves while the overlay pages.
  const chatScroll = page.locator(".chat-scroll");
  const chatBefore = await chatScroll.evaluate((el: HTMLElement) => el.scrollTop);

  // Park at the diagram's top via real Prev presses…
  for (let i = 0; i < 20; i++) {
    const before = (await axisGeom(vp, "y")).pos;
    await bar.locator('[data-eink="surface-prev"]').click();
    const after = (await axisGeom(vp, "y")).pos;
    if (after === 0) break;
    expect(after).toBeLessThan(before);
  }
  expect((await axisGeom(vp, "y")).pos).toBe(0);

  // …then traverse with real Next presses, recording which of the seeded
  // diagram's node labels are visible at each stop.
  const LABELS = ["Start", "Decision", "Run", "Skip", "End"];
  const seen = new Set<string>();
  const stops: number[] = [];
  for (let i = 0; i < 30; i++) {
    const g = await axisGeom(vp, "y");
    stops.push(g.pos);
    const visible = await visibleNeedles(vp, LABELS);
    visible.forEach((l) => seen.add(l));
    const before = g.pos;
    await bar.locator('[data-eink="surface-next"]').click();
    const after = (await axisGeom(vp, "y")).pos;
    if (Math.abs(after - before) <= 1) break;
  }
  for (const l of LABELS) expect(seen, `diagram label ${l} never visible`).toContain(l);
  const gEnd = await axisGeom(vp, "y");
  expect(gEnd.extent - gEnd.pos, "traversal reached the overlay extent").toBeLessThanOrEqual(1);
  for (let i = 1; i < stops.length; i++) {
    expect(stops[i] - stops[i - 1]).toBeGreaterThan(0);
    expect(stops[i] - stops[i - 1]).toBeLessThanOrEqual(gEnd.client + 1);
  }

  // Only the overlay moved: the transcript's scroll position is unchanged.
  expect(await chatScroll.evaluate((el: HTMLElement) => el.scrollTop)).toBe(chatBefore);

  // Esc (the overlay's key path) still closes…
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  // …and so does the explicit Close button after a re-expand.
  await inline.getByTitle("Expand diagram").click();
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await overlay.getByRole("button", { name: "Close" }).click();
  await expect(overlay).toHaveCount(0);
  // The body scroll lock is released after close (unchanged close semantics).
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
});

// (11) Tool output (Slice 3b): a tool body's OWN bounded scroller (.tool-output,
//     max-height 320) pages discretely, independent of the transcript. The
//     overflowing output is produced through the REAL shell-simulation route
//     (POST /oc/session/:id/shell — the fake answers with a completed bash
//     tool whose output carries the command); marker substrings placed at the
//     start/middle/end of that output are the marked content. The disclosure
//     still collapses afterwards (tool action preserved).
test("e-ink ON: tool output pages discretely, independent of the transcript", async ({ page }) => {
  test.setTimeout(60_000);
  await bootEink(page);
  await page.setViewportSize({ width: 400, height: 600 });
  // Serial-suite hygiene: restore the seeded editpvw baseline first. The
  // shell turns injected below are NOT persisted by the fake, so a later
  // reset cannot remove them from the aggregator store — the markers are
  // kept run-unique and every locator is scoped to them instead.
  await resetSession(page, "editpvw");
  await page.goto(projectUrl("/?session=editpvw"));
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10_000 });

  const run = Date.now().toString(36);
  const OUT_MARKS = [`EINKOUT-START-${run}`, `EINKOUT-MID-${run}`, `EINKOUT-END-${run}`];
  // Short space-separated words (NOT long unbroken runs): .tool-output is
  // white-space: pre-wrap, which wraps only at soft break opportunities — a
  // single 1400-char "word" would overflow HORIZONTALLY instead (measured
  // scrollWidth 10k, vertical extent 0). ~150 short words wrap to ~60 lines
  // and genuinely overflow the 320px bound.
  const words = Array.from({ length: 150 }, (_, i) => `einkout${i}`);
  words[0] = OUT_MARKS[0];
  words[75] = OUT_MARKS[1];
  words[149] = OUT_MARKS[2];
  const cmd = words.join(" ");
  await page.evaluate(async (command) => {
    const res = await fetch("/oc/session/editpvw/shell", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) throw new Error(`shell route -> ${res.status}`);
  }, cmd);

  const row = page.locator(".tool", { hasText: OUT_MARKS[0] }).last();
  await expect(row).toBeVisible({ timeout: 10_000 });
  // Ensure the disclosure is OPEN (the injected turn is the session tail and
  // auto-opens, but do not rely on that — open it for real if it is closed).
  const wrap = row.locator('[class*="disclosure"]:not([class*="disclosure-"])');
  if (!(await wrap.evaluate((el) => el.classList.contains("open")))) {
    await row.locator(".tool-head").click();
  }
  // The plain-text bash body is the <pre> carrying the hashed tool-output class.
  const out = row.locator("pre[class*='tool-output']");
  await expect(out).toBeVisible();
  const g0 = await axisGeom(out, "y");
  expect(g0.extent, "tool output must overflow its 320px bound").toBeGreaterThan(0);
  const bar = row.locator('[data-eink-surface="tool-output"]');
  await expect(bar).toBeVisible({ timeout: 5000 });

  // Park the reader in history first (one real S1 prev press): a
  // tail-following reader is legitimately re-pinned by the app's own recovery
  // as the disclosure settles — parking ends that regime (test 5's rationale).
  await page.locator('[data-eink="prev-page"]').click();
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });

  // Bring the whole row (output + bar) into the chat viewport BEFORE the
  // stationarity window: otherwise Playwright's own actionability scrolling
  // would move .chat-scroll to reveal the bar — legitimate TEST-driven
  // movement (a one-time setup scroll; the invariant is asserted across the
  // paging CLICKS only).
  await bar.evaluate((el: HTMLElement) => el.scrollIntoView({ block: "end" }));
  await page.waitForTimeout(250);
  const chatScroll = page.locator(".chat-scroll");
  const chatBefore = await chatScroll.evaluate((el: HTMLElement) => el.scrollTop);
  const barInView = await bar.evaluate(inChatViewport);
  expect(barInView, "paging bar must sit inside the chat viewport for the click loop").toBe(true);

  // Park at the output's top via real Prev presses…
  for (let i = 0; i < 30; i++) {
    const before = (await axisGeom(out, "y")).pos;
    await bar.locator('[data-eink="surface-prev"]').click();
    const after = (await axisGeom(out, "y")).pos;
    if (after === 0) break;
    expect(after).toBeLessThan(before);
  }
  expect((await axisGeom(out, "y")).pos).toBe(0);

  // …then traverse, recording which output markers are visible at each stop.
  const seen = new Set<string>();
  const stops: number[] = [];
  for (let i = 0; i < 60; i++) {
    const g = await axisGeom(out, "y");
    stops.push(g.pos);
    const visible = await visibleNeedles(out, OUT_MARKS);
    visible.forEach((m) => seen.add(m));
    const before = g.pos;
    await bar.locator('[data-eink="surface-next"]').click();
    const after = (await axisGeom(out, "y")).pos;
    if (Math.abs(after - before) <= 1) break;
  }
  for (const m of OUT_MARKS) expect(seen, `output marker ${m} never visible`).toContain(m);
  const gEnd = await axisGeom(out, "y");
  expect(gEnd.extent - gEnd.pos, "traversal reached the output extent").toBeLessThanOrEqual(1);
  for (let i = 1; i < stops.length; i++) {
    expect(stops[i] - stops[i - 1]).toBeGreaterThan(0);
    expect(stops[i] - stops[i - 1]).toBeLessThanOrEqual(gEnd.client + 1);
  }

  // Independence: the transcript did not move across the paging clicks.
  expect(await chatScroll.evaluate((el: HTMLElement) => el.scrollTop)).toBe(chatBefore);

  // The disclosure still collapses (the tool action preserved).
  await row.locator(".tool-head").click();
  await page.waitForTimeout(350); // close animation (the 0fr grid transition)
  const collapsed = await out.evaluate((el) => {
    const clip = el.closest('[class*="disclosure-clip"]') as HTMLElement | null;
    const wrapEl = clip?.parentElement as HTMLElement | null;
    return { clipH: clip?.getBoundingClientRect().height ?? -1, wrapOpen: !!wrapEl?.classList.contains("open") };
  });
  expect(collapsed.wrapOpen).toBe(false);
  expect(collapsed.clipH).toBeLessThanOrEqual(1);
});

// (12) Tool edit preview (Slice 3b): the edit preview's own bounded scroller
//     (.tool-edit, max-height 320) pages discretely, same independence and
//     disclosure-preservation contract as the output body.
//
//     DISCLOSED SETUP — extent fabrication: no fixture path produces an
//     overflowing edit preview (editDiffLines caps blocks at 30 lines and no
//     seeded edit input reaches that bound), so the overflow is fabricated
//     IN-DOM by cloning the row's own preview lines with marker texts.
//     Everything after that setup is the real path: the adapter's observers
//     genuinely react to the growth, the bar mounts through the real overflow
//     gate, and every traversal step is a real button click on the real event
//     path.
test("e-ink ON: tool edit preview pages discretely, independent of the transcript", async ({ page }) => {
  test.setTimeout(60_000);
  await bootEink(page);
  await page.setViewportSize({ width: 400, height: 600 });
  await page.goto(projectUrl("/?session=editpvw"));
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10_000 });

  // The seeded replaceAll edit row. Expand it for real (a non-tail row starts
  // closed).
  const row = page.locator(".tool", { hasText: "Edit File" }).first();
  await row.locator(".tool-head").click();
  const edit = row.locator('[class*="tool-edit"]:not([class*="tool-edit-"])');
  await expect(edit).toBeVisible();

  // Fabricate the extent (see the DISCLOSED SETUP note above).
  const EDIT_MARKS = ["EINKEDIT-FIRST", "EINKEDIT-MIDDLE", "EINKEDIT-LAST"];
  await edit.evaluate((el, marks) => {
    const h = el as HTMLElement;
    const lines = h.querySelectorAll('[class*="tool-edit-line"]');
    const proto = lines[lines.length - 1];
    if (!proto) throw new Error("no preview line to clone");
    for (let i = 0; i < 40; i++) {
      const c = proto.cloneNode(true) as HTMLElement;
      c.textContent = i === 0 ? marks[0] : i === 20 ? marks[1] : i === 39 ? marks[2] : `eink edit preview line ${i}`;
      h.appendChild(c);
    }
  }, EDIT_MARKS);

  const bar = row.locator('[data-eink-surface="tool-edit"]');
  await expect(bar).toBeVisible({ timeout: 5000 });
  const g0 = await axisGeom(edit, "y");
  expect(g0.extent, "edit preview must overflow its 320px bound").toBeGreaterThan(0);

  // Park in history + bring the row into the chat viewport (test 11's setup
  // rationale: keep Playwright's actionability scrolls out of the
  // stationarity window).
  await page.locator('[data-eink="prev-page"]').click();
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  await bar.evaluate((el: HTMLElement) => el.scrollIntoView({ block: "end" }));
  await page.waitForTimeout(250);
  const chatScroll = page.locator(".chat-scroll");
  const chatBefore = await chatScroll.evaluate((el: HTMLElement) => el.scrollTop);

  // Park at the preview's top via real Prev presses…
  for (let i = 0; i < 30; i++) {
    const before = (await axisGeom(edit, "y")).pos;
    await bar.locator('[data-eink="surface-prev"]').click();
    const after = (await axisGeom(edit, "y")).pos;
    if (after === 0) break;
    expect(after).toBeLessThan(before);
  }
  expect((await axisGeom(edit, "y")).pos).toBe(0);

  // …then traverse, recording which clone markers are visible at each stop.
  const seen = new Set<string>();
  const stops: number[] = [];
  for (let i = 0; i < 60; i++) {
    const g = await axisGeom(edit, "y");
    stops.push(g.pos);
    const visible = await visibleNeedles(edit, EDIT_MARKS);
    visible.forEach((m) => seen.add(m));
    const before = g.pos;
    await bar.locator('[data-eink="surface-next"]').click();
    const after = (await axisGeom(edit, "y")).pos;
    if (Math.abs(after - before) <= 1) break;
  }
  for (const m of EDIT_MARKS) expect(seen, `edit marker ${m} never visible`).toContain(m);
  const gEnd = await axisGeom(edit, "y");
  expect(gEnd.extent - gEnd.pos, "traversal reached the preview extent").toBeLessThanOrEqual(1);
  for (let i = 1; i < stops.length; i++) {
    expect(stops[i] - stops[i - 1]).toBeGreaterThan(0);
    expect(stops[i] - stops[i - 1]).toBeLessThanOrEqual(gEnd.client + 1);
  }

  // Independence: the transcript did not move across the paging clicks.
  expect(await chatScroll.evaluate((el: HTMLElement) => el.scrollTop)).toBe(chatBefore);

  // The disclosure still collapses (the tool action preserved).
  await row.locator(".tool-head").click();
  await page.waitForTimeout(350); // close animation
  const collapsed = await edit.evaluate((el) => {
    const clip = el.closest('[class*="disclosure-clip"]') as HTMLElement | null;
    const wrapEl = clip?.parentElement as HTMLElement | null;
    return { clipH: clip?.getBoundingClientRect().height ?? -1, wrapOpen: !!wrapEl?.classList.contains("open") };
  });
  expect(collapsed.wrapOpen).toBe(false);
  expect(collapsed.clipH).toBeLessThanOrEqual(1);
});

// (13) Monochrome diff semantics (Slice 4): under the profile's effective
//     theme-eink, diff meaning must survive the loss of hue — the base
//     surfaces (.vh-diff-add/-del/-hunk in legacy/80-professional-pass.css)
//     tint by --ok/--danger/--accent, which collapse to near-identical greys
//     under the monochrome theme. The ON-scoped tokens.css rules carry the
//     meaning with borders and luminance instead, asserted COMPUTED on a REAL
//     diff render (a real throwaway git repo served by the real daemon's
//     /vh/git + /vh/render — git-safety.spec.ts's topology): added = white +
//     solid bar; removed = grey + dashed bar; hunk = inverted band. The OFF
//     leg proves the reinforcements are truly scoped: no borders, and the
//     hue-tinted baseline backgrounds remain pairwise distinct.
test("e-ink ON: diff add/del/hunk stay distinguishable without hue (computed); OFF keeps the hue baseline", async ({ page }) => {
  test.setTimeout(90_000);
  // Throwaway repo with a staged modification whose patch carries hunk
  // headers, added lines, and removed lines.
  const base = mkdtempSync(join(tmpdir(), "vh-eink-diff-"));
  const repo = join(base, "repo");
  const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: "pipe" });
  execSync(`git init ${JSON.stringify(repo)}`, { stdio: "pipe" });
  git('config user.email "t@t"');
  git('config user.name "t"');
  writeFileSync(join(repo, "notes.txt"), ["alpha line", "beta line", "gamma line", ""].join("\n"));
  git("add notes.txt");
  git('commit -m "base"');
  // Change beta (del+add), append two additions → add/del/hunk all present.
  writeFileSync(
    join(repo, "notes.txt"),
    ["alpha line", "BETA CHANGED", "gamma line", "delta added", "epsilon added", ""].join("\n"),
  );
  git("add notes.txt");
  try {
    const openChanges = async () => {
      await page.goto(`/?dir=${encodeURIComponent(repo)}`);
      await page.getByRole("button", { name: "Changes" }).click();
      await expect(page.locator(".git-commit-btn")).toBeVisible({ timeout: 8_000 });
      await page.locator(".gitfile-head").first().click(); // expand the file diff
      await expect(page.locator(".gitfile-diff .vh-diff-line")).not.toHaveCount(0);
    };
    const diffStyles = () =>
      page.locator(".gitfile-diff").evaluate((el) => {
        const pick = (cls: string) => {
          const line = el.querySelector(`.vh-diff-line.vh-diff-${cls}`) as HTMLElement | null;
          if (!line) return null;
          const cs = getComputedStyle(line);
          return {
            borderLeftStyle: cs.borderLeftStyle,
            borderLeftWidth: cs.borderLeftWidth,
            background: cs.backgroundColor,
            color: cs.color,
          };
        };
        return { add: pick("add"), del: pick("del"), hunk: pick("hunk") };
      });

    // ---- ON (profile effective theme = monochrome theme-eink). ----
    await bootEink(page);
    await openChanges();
    await expect
      .poll(() => page.evaluate(() => Array.from(document.documentElement.classList).includes("theme-eink")))
      .toBe(true);
    const on = await diffStyles();
    expect(on.add, "added lines must render").not.toBeNull();
    expect(on.del, "removed lines must render").not.toBeNull();
    expect(on.hunk, "hunk headers must render").not.toBeNull();
    // Added: white row + SOLID black bar.
    expect(on.add!.background).toBe("rgb(255, 255, 255)");
    expect(on.add!.borderLeftStyle).toBe("solid");
    // Removed: grey row + DASHED black bar — two independent non-hue
    // distinctions from added.
    expect(on.del!.background).toBe("rgb(214, 214, 214)");
    expect(on.del!.borderLeftStyle).toBe("dashed");
    // Hunk/changed: inverted black band with white text — maximum luminance
    // separation from both row kinds.
    expect(on.hunk!.background).toBe("rgb(0, 0, 0)");
    expect(on.hunk!.color).toBe("rgb(255, 255, 255)");
    // Pairwise distinguishability, hue-free: every pair differs in border
    // style and/or background luminance.
    expect(on.add!.borderLeftStyle).not.toBe(on.del!.borderLeftStyle);
    expect(on.add!.background).not.toBe(on.del!.background);
    expect(on.add!.background).not.toBe(on.hunk!.background);
    expect(on.del!.background).not.toBe(on.hunk!.background);

    // ---- OFF (default dark theme): the reinforcements are absent and the
    // hue baseline renders unchanged. A second page in the same context
    // shares localStorage — it strips the profile key BEFORE app boot (the
    // ON page keeps its in-memory ON state; storage events don't re-hydrate
    // an already-booted page's persistedSignal).
    const p2 = await page.context().newPage();
    await p2.addInitScript(() => {
      localStorage.removeItem("vh.prefs.einkProfile.v1");
    });
    await openChangesOn(p2);
    const off = await diffStylesOn(p2);
    expect(off.add).not.toBeNull();
    expect(off.del).not.toBeNull();
    expect(off.hunk).not.toBeNull();
    for (const l of [off.add!, off.del!, off.hunk!]) {
      expect(l.borderLeftStyle).toBe("none"); // the ON bars never fire OFF
    }
    // The hue-tinted baseline backgrounds remain pairwise distinct (the
    // pre-profile rendering this slice must not disturb).
    expect(off.add!.background).not.toBe(off.del!.background);
    expect(off.add!.background).not.toBe(off.hunk!.background);
    expect(off.del!.background).not.toBe(off.hunk!.background);
    await p2.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  // p2 helpers (a second page in the same context boots WITHOUT the profile
  // key — the OFF leg; declared after use for locality, hoisted functions).
  async function openChangesOn(p: import("@playwright/test").Page) {
    await p.goto(`/?dir=${encodeURIComponent(repo)}`);
    await p.getByRole("button", { name: "Changes" }).click();
    await expect(p.locator(".git-commit-btn")).toBeVisible({ timeout: 8_000 });
    await p.locator(".gitfile-head").first().click();
    await expect(p.locator(".gitfile-diff .vh-diff-line")).not.toHaveCount(0);
  }
  function diffStylesOn(p: import("@playwright/test").Page) {
    return p.locator(".gitfile-diff").evaluate((el) => {
      const pick = (cls: string) => {
        const line = el.querySelector(`.vh-diff-line.vh-diff-${cls}`) as HTMLElement | null;
        if (!line) return null;
        const cs = getComputedStyle(line);
        return { borderLeftStyle: cs.borderLeftStyle, background: cs.backgroundColor, color: cs.color };
      };
      return { add: pick("add"), del: pick("del"), hunk: pick("hunk") };
    });
  }
});

// (14) Target reachability (Slice 4 acceptance): every ON-only PAGING
//     control the program added — the S1 chat paging toolbar, the S3 surface
//     adapters (settings body, nested reasoning), and the S2 terminal
//     history toolbar — meets the ~44 CSS px target (the brief's DESIGN
//     choice) in RENDERED bounding boxes and sits inside the viewport
//     (reachable, not clipped).
//     Deliberate exception: the connection toast's inline dismiss action is
//     NOT a paging control and is intentionally compact (an in-pill glyph
//     button, ~21px) — it is behaviorally covered by the unit dismiss tests
//     and the preferences e2e dismiss leg; only the paging/navigation
//     controls carry the 44px target contract here.
test("e-ink ON: chat paging, surface adapters, and terminal history controls meet ~44px targets in-viewport", async ({ page }) => {
  test.setTimeout(90_000);
  await bootEink(page);

  // Bounding-box contract: ≥44px (½px float slack) on BOTH axes, fully
  // inside the viewport (null box = not rendered → fails loudly).
  const assertTarget = async (loc: import("@playwright/test").Locator, name: string) => {
    const box = await loc.boundingBox();
    expect(box, `${name} must render`).not.toBeNull();
    expect(box!.width, `${name} width ~44px target`).toBeGreaterThanOrEqual(43.5);
    expect(box!.height, `${name} height ~44px target`).toBeGreaterThanOrEqual(43.5);
    const vp = page.viewportSize()!;
    expect(box!.x, `${name} inside viewport (left)`).toBeGreaterThanOrEqual(-0.5);
    expect(box!.y, `${name} inside viewport (top)`).toBeGreaterThanOrEqual(-0.5);
    expect(box!.x + box!.width, `${name} inside viewport (right)`).toBeLessThanOrEqual(vp.width + 0.5);
    expect(box!.y + box!.height, `${name} inside viewport (bottom)`).toBeLessThanOrEqual(vp.height + 0.5);
  };

  // ---- Chat paging toolbar (S1) + the reasoning surface adapter (S3). ----
  await page.setViewportSize({ width: 400, height: 600 });
  await openDemo(page);
  await expect(page.locator('[data-eink="paging"]')).toBeVisible();
  // Device-feedback round 2: the toolbar is Prev/Next ONLY — its Latest
  // button was removed as a redundant duplicate of the "↓ Latest" pill (the
  // link interface the operator uses); the pill is covered by scroll-follow.
  for (const sel of ['[data-eink="prev-page"]', '[data-eink="next-page"]']) {
    await assertTarget(page.locator(sel), `chat ${sel}`);
  }
  await expect(page.locator('[data-eink="latest"]')).toHaveCount(0);
  // The demo's last turn carries a long settled reasoning (test 5's p10);
  // expand it and bring its bar on screen — its adapter buttons are targets.
  const head = page.locator("button.tool-head", { hasText: "Thinking" }).last();
  await head.click();
  await expect(page.locator(".reasoning-body").last()).toBeVisible();
  const reasoningBar = page.locator('[data-eink-surface="reasoning"]');
  await expect(reasoningBar).toBeVisible({ timeout: 5_000 });
  await reasoningBar.evaluate((el: HTMLElement) => el.scrollIntoView({ block: "end" }));
  await page.waitForTimeout(250);
  await assertTarget(reasoningBar.locator('[data-eink="surface-prev"]'), "reasoning surface-prev");
  await assertTarget(reasoningBar.locator('[data-eink="surface-next"]'), "reasoning surface-next");

  // ---- Settings body adapter (S3) at the dialog foot. ----
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const settingsBar = page.locator('[data-eink-surface="settings"]');
  await expect(settingsBar).toBeVisible({ timeout: 5_000 });
  await assertTarget(settingsBar.locator('[data-eink="surface-prev"]'), "settings surface-prev");
  await assertTarget(settingsBar.locator('[data-eink="surface-next"]'), "settings surface-next");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // ---- Terminal history toolbar (S2), booted like terminal.spec's
  // openTerminal (the repo checkout dir — its PTY is served by the real
  // daemon; nothing is typed into it). ----
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  await page.goto(`/?dir=${encodeURIComponent(repoRoot)}`);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForSelector('[data-eink="term-paging"]', { timeout: 15_000 });
  for (const sel of ['[data-eink="term-prev"]', '[data-eink="term-next"]', '[data-eink="term-latest"]']) {
    await assertTarget(page.locator(sel), `terminal ${sel}`);
  }
});

// ── device-feedback round 2 — destructive (danger) affordance visibility ────
// Operator feedback (verbatim): "the red parts - buttons like archive or
// delete isn't visible". Root cause: --danger-fg was #ffffff under BOTH e-ink
// variants — correct only for solid --danger fills, invisible-on-white for
// every FLAT danger-text consumer. The fix flips the token per variant (mono:
// ink; colour: the saturated danger hue) and adds theme-scoped monochrome
// SEMANTICS on a luminance ladder (neutral 1px border < recoverable-archive
// 2px ink outline < irreversible-delete solid ink fill; the menu entry is a
// fully inverted row). This test proves, COMPUTED on the REAL event paths
// (real right-click menu, real tap → Archive confirm, real ≥450ms hold →
// Delete confirm, real Usage→Session-details inspector, real streaming stop
// button), that every named destructive affordance is (a) ≥4.5:1 text
// contrast against its ACTUAL background and (b) distinguishable from the
// adjacent neutral action by a NON-hue property (border weight or solid
// fill) — under theme-eink AND theme-eink-color — and that the OFF (default
// dark) rendering of the same consumers is untouched (no solid fills, 1px
// borders, the pre-change flat red/pink text). Physical e-ink panel outcomes
// remain out of scope (browser automation proves browser properties only).

// WCAG 2.x contrast ratio for two css color strings. Handles both engine
// serializations a consumer can see: rgb()/rgba() and the color(srgb r g b)
// form Chromium computes color-mix() tints to (0–1 float channels).
function dangerParseChannels(color: string): [number, number, number] | null {
  let m = /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*[\d.]+)?\)/.exec(color);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+)?\)/.exec(color);
  if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255];
  return null;
}
function dangerContrast(fg: string, bg: string): number {
  const f = dangerParseChannels(fg);
  const b = dangerParseChannels(bg);
  if (!f || !b) return -1;
  const lum = (c: [number, number, number]) => {
    const ch = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const l1 = lum(f);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Alpha channel of a serialized color (1 when absent/opaque) — the tinted
// flats (.ctxm-pinerr) mix var(--danger) with TRANSPARENT, so their computed
// background carries alpha and must be composited over the surface behind
// before any contrast claim.
function dangerParseAlpha(color: string): number {
  let m = /rgba?\(\d+(?:\.\d+)?,\s*\d+(?:\.\d+)?,\s*\d+(?:\.\d+)?,\s*([\d.]+)\)/.exec(color);
  if (m) return Number(m[1]);
  m = /color\(srgb[^)]*\/\s*([\d.]+)\)/.exec(color);
  return m ? Number(m[1]) : 1;
}
// Composite a (possibly translucent) color over an opaque backdrop, in the
// same serialization vocabulary dangerParseChannels reads.
function dangerComposite(over: string, backdrop: string): string {
  const a = dangerParseAlpha(over);
  if (a >= 1) return over;
  const o = dangerParseChannels(over);
  const b = dangerParseChannels(backdrop);
  if (!o || !b) return over;
  const mixed = o.map((c, i) => c * a + b[i] * (1 - a));
  return `rgb(${mixed.map((v) => Math.round(v)).join(", ")})`;
}

// One element's danger-relevant computed shape: text color, its EFFECTIVE
// background (walks ancestors until an opaque bg — flat titles/buttons sit on
// the dialog or sheet surface), own background, and the top border width.
function dangerShape(loc: import("@playwright/test").Locator) {
  return loc.evaluate((target) => {
    const el = target as HTMLElement;
    const cs = getComputedStyle(el);
    let node: HTMLElement | null = el;
    let effectiveBg = "rgba(0, 0, 0, 0)";
    while (node) {
      const b = getComputedStyle(node).backgroundColor;
      const m = /rgba?\(\d+(?:\.\d+)?,\s*\d+(?:\.\d+)?,\s*\d+(?:\.\d+)?(?:,\s*([\d.]+))?\)/.exec(b);
      if (!m || Number(m[1] ?? 1) >= 1) {
        effectiveBg = b;
        break;
      }
      node = node.parentElement;
    }
    return {
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      effectiveBg,
      borderTopWidth: cs.borderTopWidth,
      borderTopColor: cs.borderTopColor,
    };
  });
}

// Resolve a declaration through the same engine serialization a consumer
// sees (theme-tokens.spec.ts's probe idiom). `prop` picks which computed
// property to read back (color by default; backgroundColor for fills).
function dangerResolve(
  page: import("@playwright/test").Page,
  decl: string,
  prop: "color" | "backgroundColor" = "color",
) {
  return page.evaluate(([d, p]) => {
    const el = document.createElement("div");
    el.style.cssText = `${d};position:fixed;left:-9999px;top:-9999px;`;
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const v = p === "backgroundColor" ? cs.backgroundColor : cs.color;
    el.remove();
    return v;
  }, [decl, prop] as const);
}

async function dangerOpenSessionMenu(page: import("@playwright/test").Page) {
  const title = page.locator(".main-title.has-menu");
  await expect(title).toBeVisible({ timeout: 8000 });
  await title.click({ button: "right" });
  const menu = page.locator(".ctxm-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("e-ink danger semantics: destructive affordances visible + non-hue distinguishable under both e-ink variants; OFF untouched", async ({ page }) => {
  test.setTimeout(120_000);

  // ---------- MONOCHROME (profile ON, default saved theme → theme-eink) ----------
  await bootEink(page);
  await openDemo(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("theme-eink")))
    .toBe(true);

  // The token flip itself: flat danger text now resolves to INK on the white
  // page (was #ffffff — white-on-white, the invisibility the operator hit).
  expect(await dangerResolve(page, "color: var(--danger-fg)")).toBe("rgb(0, 0, 0)");

  // ---- Session menu, REAL right-click on the chat header title. ----
  let menu = await dangerOpenSessionMenu(page);
  const monoEntry = await dangerShape(menu.locator(".ctxm-item.danger"));
  const monoNeutral = await dangerShape(menu.locator(".ctxm-item").first());
  expect(monoEntry.backgroundColor).toBe("rgb(0, 0, 0)"); // inverted solid row
  expect(monoEntry.color).toBe("rgb(255, 255, 255)");
  expect(dangerContrast(monoEntry.color, monoEntry.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  // Non-color distinguishability: solid fill + light text vs the flat neutral
  // item (transparent bg, ink text).
  expect(monoEntry.backgroundColor).not.toBe(monoNeutral.backgroundColor);
  expect(monoEntry.color).not.toBe(monoNeutral.color);

  // ---- Archive confirm (real TAP on Archive… — the recoverable path). ----
  await menu.getByText("Archive…").click();
  let confirm = page.getByRole("dialog", { name: "Confirm archive" });
  await expect(confirm).toBeVisible();
  const monoCaution = await dangerShape(confirm.locator(".confirm-go"));
  const monoCancel = await dangerShape(confirm.locator(".confirm-cancel"));
  expect(monoCaution.backgroundColor).toBe("rgb(255, 255, 255)"); // outline grade
  expect(monoCaution.color).toBe("rgb(0, 0, 0)");
  expect(monoCaution.borderTopWidth).toBe("2px"); // heavy outline…
  expect(monoCancel.borderTopWidth).toBe("1px"); // …vs the neutral 1px rung
  expect(dangerContrast(monoCaution.color, monoCaution.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);

  // ---- Delete confirm (real ≥450ms HOLD on Archive… — the irreversible
  // path; the gesture the menu's pointer/timer machinery classifies). ----
  menu = await dangerOpenSessionMenu(page);
  await menu.getByText("Archive…").click({ delay: 520 });
  confirm = page.getByRole("dialog", { name: "Confirm delete" });
  await expect(confirm).toBeVisible();
  const monoDangerDialog = await dangerShape(confirm);
  const monoDangerTitle = await dangerShape(confirm.locator(".dialog-title"));
  const monoDangerGo = await dangerShape(confirm.locator(".confirm-go"));
  expect(monoDangerDialog.borderTopWidth).toBe("2px"); // dialog-level weight cue
  expect(monoDangerTitle.color).toBe("rgb(0, 0, 0)"); // visible (was white-on-white)
  expect(dangerContrast(monoDangerTitle.color, monoDangerTitle.effectiveBg)).toBeGreaterThanOrEqual(4.5);
  expect(monoDangerGo.backgroundColor).toBe("rgb(0, 0, 0)"); // SOLID fill rung
  expect(monoDangerGo.color).toBe("rgb(255, 255, 255)");
  expect(dangerContrast(monoDangerGo.color, monoDangerGo.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  expect(monoDangerGo.backgroundColor).not.toBe(monoCaution.backgroundColor); // ladder rungs differ
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);

  // ---- Session inspector archive button (real Usage → Session details). ----
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await page.getByRole("dialog", { name: "Usage" }).getByRole("button", { name: "Session details →" }).click();
  const insp = page.getByRole("dialog", { name: "Session inspector" });
  await expect(insp).toBeVisible();
  const monoInsp = await dangerShape(insp.locator(".insp-archive"));
  expect(monoInsp.backgroundColor).toBe("rgb(255, 255, 255)");
  expect(monoInsp.color).toBe("rgb(0, 0, 0)");
  expect(monoInsp.borderTopWidth).toBe("2px"); // the caution outline grade
  expect(dangerContrast(monoInsp.color, monoInsp.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  await page.keyboard.press("Escape");
  await expect(insp).toHaveCount(0);

  // ---- Global danger consumer, REAL streaming state: the composer's stop
  // button (solid --danger fill) must keep its light text after the token
  // flip (the explicit solid-fill keep). ----
  await page.evaluate(async () => {
    const res = await fetch(`/oc/session/demo/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: JSON.stringify({ parts: [{ type: "text", text: "eink danger stop-button probe" }] }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`prompt_async -> ${res.status}`);
  });
  const stop = page.locator(".send-btn.stop");
  await expect(stop).toBeVisible({ timeout: 8000 });
  const monoStop = await dangerShape(stop);
  expect(monoStop.backgroundColor).toBe("rgb(0, 0, 0)");
  expect(monoStop.color).toBe("rgb(255, 255, 255)");
  expect(dangerContrast(monoStop.color, monoStop.backgroundColor)).toBeGreaterThanOrEqual(4.5);

  // ---- Representative GLOBAL flat-danger consumers, probe-mounted with
  // their REAL classes in the live document (the cascade is what's under
  // test): the chat failure result box (.msg-error — tinted bg +
  // --danger-fg text, white-on-grey before the flip) and the update
  // dialog's error text (.ocu-err — flat --danger text on the white page). ----
  const probed = await page.evaluate(() => {
    const mk = (cls: string) => {
      const el = document.createElement("p");
      el.className = cls;
      el.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = { color: cs.color, backgroundColor: cs.backgroundColor };
      el.remove();
      return out;
    };
    return { msgError: mk("msg-error"), ocuErr: mk("ocu-err") };
  });
  // .msg-error paints its own opaque tinted background — contrast against it.
  expect(dangerContrast(probed.msgError.color, probed.msgError.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  expect(probed.msgError.color).toBe("rgb(0, 0, 0)"); // the flipped token (was #ffffff)
  // .ocu-err is flat text on the e-ink page (--bg #ffffff by construction).
  expect(probed.ocuErr.color).toBe("rgb(0, 0, 0)");
  expect(dangerContrast(probed.ocuErr.color, "rgb(255, 255, 255)")).toBeGreaterThanOrEqual(4.5);
  // Settle + reset (serial-suite hygiene: no busy goroutine / transcript leak).
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 20000 });
  await resetSession(page, "demo");

  // ---------- OFF (default dark theme): the same consumers render the
  // pre-change baseline — no solid fills, no heavy borders (a second page in
  // the same context strips the profile key BEFORE boot; S4's p2 idiom). ----
  const p2 = await page.context().newPage();
  await p2.addInitScript(() => {
    localStorage.removeItem("vh.prefs.einkProfile.v1");
  });
  await p2.goto(projectUrl("/?session=demo"));
  await expect(p2.locator(".msg").first()).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => p2.evaluate((c) => document.documentElement.classList.contains(c), "theme-dark"))
    .toBe(true);
  menu = await dangerOpenSessionMenu(p2);
  const offEntry = await dangerShape(menu.locator(".ctxm-item.danger"));
  expect(offEntry.backgroundColor).toBe("rgba(0, 0, 0, 0)"); // flat, NOT the e-ink solid row
  const offEntryRgb = dangerParseChannels(offEntry.color);
  expect(offEntryRgb, `dark-theme danger text must parse (${offEntry.color})`).not.toBeNull();
  expect(offEntryRgb![0]).toBeGreaterThan(200); // the dark theme's light red (#ffb4ba)
  await menu.getByText("Archive…").click();
  const offConfirm = p2.getByRole("dialog", { name: "Confirm archive" });
  await expect(offConfirm).toBeVisible();
  const offCaution = await dangerShape(offConfirm.locator(".confirm-go"));
  expect(offCaution.borderTopWidth).toBe("1px"); // no outline grade OFF
  expect(offCaution.backgroundColor).not.toBe("rgb(255, 255, 255)"); // warn tint, not paper
  await offConfirm.getByRole("button", { name: "Cancel" }).click();
  await expect(offConfirm).toHaveCount(0);
  await p2.getByRole("button", { name: "Usage", exact: true }).click();
  await p2.getByRole("dialog", { name: "Usage" }).getByRole("button", { name: "Session details →" }).click();
  const offInsp = p2.getByRole("dialog", { name: "Session inspector" });
  await expect(offInsp).toBeVisible();
  expect((await dangerShape(offInsp.locator(".insp-archive"))).borderTopWidth).toBe("1px");
  await p2.keyboard.press("Escape");
  await expect(offInsp).toHaveCount(0);
  await p2.close();

  // ---------- E INK COLOR (profile ON + saved eink-color theme →
  // theme-eink-color): chromatic semantics KEPT by design — the same shapes
  // carry the saturated --danger / --warn hues. ----
  const p3 = await page.context().newPage();
  await p3.addInitScript(() => {
    localStorage.setItem("vh.prefs.einkProfile.v1", JSON.stringify({ v: 1, data: true }));
    localStorage.setItem("vh.theme.v1", JSON.stringify({ v: 1, data: "eink-color" }));
  });
  await p3.goto(projectUrl("/?session=demo"));
  await expect(p3.locator(".msg").first()).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => p3.evaluate((c) => document.documentElement.classList.contains(c), "theme-eink-color"))
    .toBe(true);
  // Token: flat danger text follows the saturated danger hue (not ink, not
  // the old invisible white).
  const colorFg = await dangerResolve(p3, "color: var(--danger-fg)");
  expect(colorFg).toBe(await dangerResolve(p3, "color: var(--danger)"));
  expect(colorFg).not.toBe("rgb(255, 255, 255)");
  expect(colorFg).not.toBe("rgb(0, 0, 0)");
  menu = await dangerOpenSessionMenu(p3);
  const colorEntry = await dangerShape(menu.locator(".ctxm-item.danger"));
  expect(colorEntry.backgroundColor).toBe("rgb(192, 39, 27)"); // solid --danger row
  expect(colorEntry.color).toBe("rgb(255, 255, 255)");
  expect(dangerContrast(colorEntry.color, colorEntry.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  await menu.getByText("Archive…").click();
  const colorCautionConfirm = p3.getByRole("dialog", { name: "Confirm archive" });
  await expect(colorCautionConfirm).toBeVisible();
  const colorCaution = await dangerShape(colorCautionConfirm.locator(".confirm-go"));
  expect(colorCaution.backgroundColor).toBe("rgb(255, 255, 255)");
  expect(colorCaution.color).toBe("rgb(0, 0, 0)");
  expect(colorCaution.borderTopWidth).toBe("2px"); // weight cue survives (hue-independent)
  expect(dangerContrast(colorCaution.color, colorCaution.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  await colorCautionConfirm.getByRole("button", { name: "Cancel" }).click();
  await expect(colorCautionConfirm).toHaveCount(0);
  menu = await dangerOpenSessionMenu(p3);
  await menu.getByText("Archive…").click({ delay: 520 });
  const colorDangerConfirm = p3.getByRole("dialog", { name: "Confirm delete" });
  await expect(colorDangerConfirm).toBeVisible();
  const colorDangerGo = await dangerShape(colorDangerConfirm.locator(".confirm-go"));
  const colorDangerTitle = await dangerShape(colorDangerConfirm.locator(".dialog-title"));
  expect(colorDangerGo.backgroundColor).toBe("rgb(192, 39, 27)"); // solid chromatic fill
  expect(colorDangerGo.color).toBe("rgb(255, 255, 255)");
  expect(dangerContrast(colorDangerGo.color, colorDangerGo.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  expect(dangerContrast(colorDangerTitle.color, colorDangerTitle.effectiveBg)).toBeGreaterThanOrEqual(4.5);
  await p3.keyboard.press("Escape");
  await expect(colorDangerConfirm).toHaveCount(0);
  await p3.close();
});

// ── device-feedback round 2 follow-up — paper flat-danger split + e-ink-colour
//    tinted flats. Two parked repairs from the DF2 review, both COMPUTED here
//    on the real rendered surfaces:
//    (1) the paper themes forced --danger-fg: #ffffff for their solid fills —
//        the same latent class DF2 fixed for e-ink: every FLAT danger-text
//        consumer (tinted chips, error hints) rendered white-on-light. The
//        split mirrors DF2: the token serves flat text (Paper: ink; Paper
//        Colour: the danger rust darkened 30%), and the solid fills keep
//        white via explicit paper-scoped keeps.
//    (2) under theme-eink-color the tinted flats (.ctxm-pinerr 12% tint,
//        .pwa-diag-chip[bad] 22% tint) against the saturated --danger-fg text
//        computed <4.5:1 — darkened TEXT via theme-scoped rules (the chromatic
//        posture keeps its hue by design).
//    Also pins that the DEFAULT dark theme is untouched: the flat consumers
//    still resolve exactly the base --danger-fg token (no new rule reaches
//    them). Physical panel outcomes remain out of scope.
test("paper danger split + eink-color tinted flats: flat text ≥4.5:1, solid fills keep white, dark untouched", async ({ browser }) => {
  test.setTimeout(150_000);

  // Own context, service workers blocked, ONE LIVE PAGE AT A TIME. Root
  // cause found while writing this test: each app page holds several
  // long-lived same-origin streams (tree + selected session + queue), and a
  // SECOND live page in the context pushes past the browser's 6-connections-
  // per-origin HTTP/1.1 budget — every further fetch (including the Settings
  // → App diagnostics' manifest fetch, which is what renders the chip rows)
  // then queues forever ("Gathering install signals…" sticks). Proven: with
  // two pages up, BOTH /manifest.webmanifest and /oc/agent time out on page 2
  // and closing page 1 unblocks them immediately. So each themed page below
  // is CLOSED before the next opens — every page then runs comfortably under
  // the budget. (SW block is belt-and-braces determinism for the diag's
  // service-worker row; see the closeout report for the two-tab note.)
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();

  // Boot with a SAVED theme (no e-ink profile — the paper themes are ordinary
  // saved themes; the scoping under test keys on the theme class alone).
  const bootSavedTheme = (p: import("@playwright/test").Page, themeId: string) =>
    p.addInitScript((t) => {
      localStorage.setItem("vh.theme.v1", JSON.stringify({ v: 1, data: t }));
    }, themeId);

  // Harvest the REAL hashed .pwa-diag-chip module class from the mounted
  // Settings → App diagnostics rows (the class is module-hashed, so a plain
  // probe className would match nothing; the attribute is set on the probe —
  // the cascade rule keys on class+attr, which is what's under test).
  const harvestChipClass = async (p: import("@playwright/test").Page) => {
    await p.getByRole("button", { name: "Settings" }).click();
    const dialog = p.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "App", exact: true }).click();
    await expect
      .poll(() => p.evaluate(() => document.querySelector('[class*="pwa-diag-chip"]')?.className ?? null), { timeout: 10_000 })
      .toBeTruthy();
    const cls = await p.evaluate(() => document.querySelector('[class*="pwa-diag-chip"]')!.className);
    await p.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    return cls;
  };

  // Probe a chip-shaped element (real harvested class + data-status="bad")
  // off-screen on the body and return its computed danger shape.
  const probeChip = (p: import("@playwright/test").Page, chipClass: string) =>
    p.evaluate((cls) => {
      const el = document.createElement("span");
      el.className = cls;
      el.setAttribute("data-status", "bad");
      el.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = { color: cs.color, backgroundColor: cs.backgroundColor };
      el.remove();
      return out;
    }, chipClass);

  // Probe .ctxm-pinerr appended INSIDE the real open context menu, so the
  // translucent 12% tint composites over the menu's actual bg-2 surface.
  // The menu's own computed backgroundColor is read EXPLICITLY as the
  // backdrop — dangerShape's ancestor walk terminates on the probe itself
  // when its tint serializes as color(srgb … / a) (non-rgb forms read as
  // terminal there), which would composite the tint over itself.
  const probePinerrInMenu = async (p: import("@playwright/test").Page) => {
    const menu = await dangerOpenSessionMenu(p);
    await menu.evaluate((host) => {
      const el = document.createElement("div");
      el.className = "ctxm-pinerr";
      el.setAttribute("data-danger-probe", "pinerr");
      (host as HTMLElement).appendChild(el);
    });
    const menuBg = await menu.evaluate((host) => getComputedStyle(host as HTMLElement).backgroundColor);
    const shape = await dangerShape(menu.locator("[data-danger-probe='pinerr']"));
    await menu.locator("[data-danger-probe='pinerr']").evaluate((el) => el.remove());
    return { shape, menuBg, menu };
  };

  // Measured ratios, logged as the run's receipt (visible in runner stdout).
  const measured: Record<string, number> = {};
  const atLeast = (name: string, ratio: number) => {
    measured[name] = ratio;
    expect(ratio, `${name} contrast ${ratio} must be ≥4.5 (and parse — a -1 means unparseable colors)`).toBeGreaterThanOrEqual(4.5);
  };

  // ---------- PAPER (monochrome saved theme) ----------
  await bootSavedTheme(page, "paper");
  await openDemo(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("theme-paper")))
    .toBe(true);
  {
    // Flat tinted consumer, REAL menu surface: .ctxm-pinerr (12% ink tint).
    const { shape, menuBg, menu } = await probePinerrInMenu(page);
    atLeast(
      "paper .ctxm-pinerr",
      dangerContrast(shape.color, dangerComposite(shape.backgroundColor, menuBg)),
    );
    // Solid-fill keep, real gesture path: hold Archive… → Delete confirm —
    // the .confirm-go solid --danger fill keeps WHITE text (not ink-on-ink).
    await menu.getByText("Archive…").click({ delay: 520 });
    const confirm = page.getByRole("dialog", { name: "Confirm delete" });
    await expect(confirm).toBeVisible();
    const go = await dangerShape(confirm.locator(".confirm-go"));
    atLeast("paper delete .confirm-go (white on fill)", dangerContrast(go.color, go.backgroundColor));
    expect(go.color).toBe("rgb(255, 255, 255)");
    expect(go.backgroundColor).toBe(await dangerResolve(page, "background: var(--danger)", "backgroundColor"));
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
  }
  // Flat consumers: the bad chip (22% ink tint over bg-2) + .ocu-err (flat
  // --danger text on the elevated bg-2 dialog surface).
  const chipClassPaper = await harvestChipClass(page);
  {
    const chip = await probeChip(page, chipClassPaper);
    atLeast("paper .pwa-diag-chip[bad]", dangerContrast(chip.color, chip.backgroundColor));
    const ocuErr = await page.evaluate(() => {
      const el = document.createElement("p");
      el.className = "ocu-err";
      el.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(el);
      const v = getComputedStyle(el).color;
      el.remove();
      return v;
    });
    atLeast("paper .ocu-err", dangerContrast(ocuErr, await dangerResolve(page, "background: var(--bg-2)", "backgroundColor")));
  }
  // Free the paper page's streams before the next themed page boots
  // (connection budget — see the context comment above).
  await page.close();

  // ---------- PAPER COLOUR (muted-chromatic saved theme) ----------
  const p2 = await ctx.newPage();
  await bootSavedTheme(p2, "paper-color");
  await openDemo(p2);
  await expect
    .poll(() => p2.evaluate(() => document.documentElement.classList.contains("theme-paper-color")))
    .toBe(true);
  {
    const { shape, menuBg, menu } = await probePinerrInMenu(p2);
    atLeast(
      "paper-color .ctxm-pinerr",
      dangerContrast(shape.color, dangerComposite(shape.backgroundColor, menuBg)),
    );
    await menu.getByText("Archive…").click({ delay: 520 });
    const confirm = p2.getByRole("dialog", { name: "Confirm delete" });
    await expect(confirm).toBeVisible();
    const go = await dangerShape(confirm.locator(".confirm-go"));
    atLeast("paper-color delete .confirm-go (white on fill)", dangerContrast(go.color, go.backgroundColor));
    expect(go.color).toBe("rgb(255, 255, 255)");
    expect(go.backgroundColor).toBe(await dangerResolve(p2, "background: var(--danger)", "backgroundColor"));
    await p2.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
  }
  const chipClassColor = await harvestChipClass(p2);
  {
    const chip = await probeChip(p2, chipClassColor);
    atLeast("paper-color .pwa-diag-chip[bad]", dangerContrast(chip.color, chip.backgroundColor));
    const ocuErr = await p2.evaluate(() => {
      const el = document.createElement("p");
      el.className = "ocu-err";
      el.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(el);
      const v = getComputedStyle(el).color;
      el.remove();
      return v;
    });
    // The raw rust (#a8503f) was <4.5:1 here — the paper-color keep routes
    // .ocu-err through the darkened flat-text token.
    atLeast("paper-color .ocu-err", dangerContrast(ocuErr, await dangerResolve(p2, "background: var(--bg-2)", "backgroundColor")));
  }
  // Solid-fill keep, REAL streaming state: the composer Stop button (solid
  // --danger fill) keeps white text under the tighter paper-color fill.
  await p2.evaluate(async () => {
    const res = await fetch(`/oc/session/demo/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: JSON.stringify({ parts: [{ type: "text", text: "paper danger stop-button probe" }] }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`prompt_async -> ${res.status}`);
  });
  const stop = p2.locator(".send-btn.stop");
  await expect(stop).toBeVisible({ timeout: 8000 });
  const stopShape = await dangerShape(stop);
  atLeast("paper-color .send-btn.stop (white on fill)", dangerContrast(stopShape.color, stopShape.backgroundColor));
  expect(stopShape.color).toBe("rgb(255, 255, 255)");
  expect(stopShape.backgroundColor).toBe(await dangerResolve(p2, "background: var(--danger)", "backgroundColor"));
  await expect(p2.locator(".working-text")).toHaveCount(0, { timeout: 20000 });
  await resetSession(p2, "demo");
  await p2.close();

  // ---------- E INK COLOUR (saved theme, no profile): the tinted flats were
  // the ~3.5:1 DF2 closeout finding — the scoped darkened text clears 4.5:1
  // while the variant keeps its chromatic-by-design hues. ----------
  const p3 = await ctx.newPage();
  await bootSavedTheme(p3, "eink-color");
  await openDemo(p3);
  await expect
    .poll(() => p3.evaluate(() => document.documentElement.classList.contains("theme-eink-color")))
    .toBe(true);
  {
    const { shape, menuBg, menu } = await probePinerrInMenu(p3);
    atLeast(
      "eink-color .ctxm-pinerr",
      dangerContrast(shape.color, dangerComposite(shape.backgroundColor, menuBg)),
    );
    // Dismiss the menu via a real outside click (bottom-right corner — far
    // from the title-anchored menu; the scrim closes it).
    await p3.mouse.click(1270, 700);
    await expect(menu).toHaveCount(0);
  }
  const chipClassEink = await harvestChipClass(p3);
  {
    const chip = await probeChip(p3, chipClassEink);
    atLeast("eink-color .pwa-diag-chip[bad]", dangerContrast(chip.color, chip.backgroundColor));
  }
  await p3.close();

  // ---------- DEFAULT DARK untouched: the flat consumers resolve exactly
  // the base --danger-fg token (no paper/eink-color rule reaches them), and
  // the token is still the base light pink — not white, not any split value.
  // ----------
  const p4 = await ctx.newPage();
  // The paper-color page's ThemePicker pick PERSISTED to this context's
  // shared localStorage — clear it so p4 boots the true default (dark).
  await p4.addInitScript(() => {
    localStorage.removeItem("vh.theme.v1");
    localStorage.removeItem("vh.prefs.einkProfile.v1");
  });
  await p4.goto(projectUrl("/?session=demo"));
  await expect(p4.locator(".msg").first()).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => p4.evaluate(() => document.documentElement.classList.contains("theme-dark")))
    .toBe(true);
  const darkToken = await dangerResolve(p4, "color: var(--danger-fg)");
  const darkTokenRgb = dangerParseChannels(darkToken);
  expect(darkTokenRgb, `dark token must parse (${darkToken})`).not.toBeNull();
  expect(darkTokenRgb![0]).toBeGreaterThan(200); // the base light pink (#ffb4ba)
  const chipClassDark = await harvestChipClass(p4);
  const darkProbes = await p4.evaluate((cls) => {
    const mk = (className: string, attr?: [string, string]) => {
      const el = document.createElement(cls === "ocu-err" ? "p" : "span");
      el.className = className;
      if (attr) el.setAttribute(attr[0], attr[1]);
      el.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(el);
      const v = getComputedStyle(el).color;
      el.remove();
      return v;
    };
    return { pinerr: mk("ctxm-pinerr"), chip: mk(cls, ["data-status", "bad"]) };
  }, chipClassDark);
  expect(darkProbes.pinerr).toBe(darkToken); // byte-identical: token drives it
  expect(darkProbes.chip).toBe(darkToken);
  await p4.close();
  await ctx.close();

  // The run's measured-contrast receipt (stdout — closeout evidence).
  console.log(`[danger-contrast] ${JSON.stringify(measured)}`);
});

// Label state is bracketed: this spec seeds tags/groups via the real API, and
// the serial suite shares one backend — reset before AND after so neither this
// spec's earlier tests nor sibling specs see leaked label state. The notes doc
// gets the same bracket (the notes test creates todos through the real form).
test.beforeEach(async ({ request }) => {
  await resetLabels(request);
  await resetNotes(request);
});
test.afterEach(async ({ request }) => {
  await resetLabels(request);
  await resetNotes(request);
});
