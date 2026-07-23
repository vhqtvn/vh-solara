import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Phase 3 Step D — tree=2 symptom coverage (a–e).
//
// These specs prove the five recurring old-client (proj=1) bugs are GONE under
// the tree=2 default render. Each test is a real assertion against the rendered
// DOM, not a tautology. They run against the shared serial fixture (pkg/fixtures)
// and target seeded sessions by data-session-id so they are robust to other
// tests in the serial suite accumulating state.
//
// The symptoms (from the design doc §3 + Phase 3 closeout):
//  (a) first-click an idle/collapsed session loads its transcript immediately
//  (b) a subagent under a collapsed parent stays NESTED (never jumps to root)
//  (c) a collapsed (loaded:false) node shows its agent chip AND is right-clickable
//  (d) reload does NOT flatten the tree (structure preserved from the frontier)
//  (e) an archived session does NOT ghost (disappears via node.remove)

// Helper: wait for the shared fixture to settle. At cold start there are NO
// spinners (no sessions are busy), so checking spinner-count alone would pass
// before the tree snapshot even arrives via SSE. First wait for the tree to
// populate (at least one .tree-row), THEN check for no running sessions.
async function waitForTreeSettled(page: import("@playwright/test").Page) {
  await expect(page.locator(".tree-row").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".tree-spinner")).toHaveCount(0, { timeout: 10000 });
}

// ─── (a) ─────────────────────────────────────────────────────────────────────
// OLD BUG: clicking a collapsed/"materialized" session showed an empty pane (the
// placeholder node had no detail yet, and the client wouldn't fetch it on click).
// tree=2 FIX: every node carries its own data; clicking the row opens the chat
// which fetches the transcript independently of the tree-expand path.
test("(a) first-click an idle collapsed session loads its transcript immediately", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  // demo is a collapsed root at cold start (loaded:false, has children).
  const demoRow = page.locator(".tree-row", { hasText: "Demo session" });
  await expect(demoRow).toBeVisible();
  // Confirm it has children → the twisty is an "Expand" button (not a leaf).
  await expect(demoRow.locator(".tree-twisty[aria-label='Expand']")).toBeVisible();
  // Confirm it is idle (no spinner — the symptom is about IDLE collapsed sessions).
  await expect(demoRow.locator(".tree-spinner")).toHaveCount(0);

  // Click the row body (NOT the twisty) — this opens the chat, not the tree.
  await demoRow.locator(".tree-node").click();

  // The transcript loads immediately: the header reflects the session and the
  // seeded assistant message (with rendered code) is visible. No empty pane.
  await expect(page.locator(".main-title")).toContainText("Demo session");
  await expect(page.locator(".msg.assistant").first()).toBeVisible({ timeout: 8000 });
  // The daemon-rendered code block proves the full transcript was fetched.
  await expect(page.locator(".md pre.chroma").first()).toBeVisible();
});

// ─── (b) ─────────────────────────────────────────────────────────────────────
// OLD BUG: a subagent (child) would jump to the root level on certain operations
// (the proj=1 client inferred parent/child locally and could misplace a child).
// tree=2 FIX: the server owns the parent/child structure; the client never
// re-infers it. A child node always renders with the .sub class.
test("(b) a subagent under a collapsed parent stays nested, never at root", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  // At cold start, the child ("sub") is collapsed under "demo" and NOT visible.
  const subLocator = page.locator(`.tree-node[data-session-id="sub"]`);
  await expect(subLocator).toHaveCount(0);

  // Critically, "sub" must NEVER appear as a root-level row (without .sub class).
  // This is the heart of the "subagent-shown-as-root" symptom.
  await expect(page.locator(`.tree-node[data-session-id="sub"]:not(.sub)`)).toHaveCount(0);

  // Expand demo → sub appears as a CHILD (with .sub class).
  const demoRow = page.locator(".tree-row", { hasText: "Demo session" });
  await demoRow.locator(".tree-twisty").click();
  await expect(subLocator).toBeVisible({ timeout: 8000 });
  // The child MUST carry the .sub class (depth > 0).
  await expect(page.locator(`.tree-node.sub[data-session-id="sub"]`)).toBeVisible();
  // And it must NOT appear without .sub (i.e. never at root level).
  await expect(page.locator(`.tree-node[data-session-id="sub"]:not(.sub)`)).toHaveCount(0);
});

// ─── (c) ─────────────────────────────────────────────────────────────────────
// OLD BUG: a collapsed ("materialized") node showed NO agent chip and could not
// be right-clicked (the legacy StubNode explicitly omitted both). tree=2 FIX:
// every node carries its own agent data and spreads the context-menu triggers,
// so a collapsed node shows its chip AND opens the context menu on right-click.
test("(c) a collapsed node shows its agent chip and is right-clickable", async ({ page }) => {
  // The fixture does NOT serve agentStyles by default (agentDisplay returns
  // undefined → no chip). Intercept /vh/project-settings to provide a style for
  // the "build" agent so the chip renders. This mirrors features2.spec.ts:26.
  await page.route("**/vh/project-settings*", (route) => {
    if (route.request().url().includes("/project-settings/watch")) return route.continue();
    return route.fulfill({
      json: {
        agentStyles: { build: { label: "BLD", color: "warn", style: "solid" } },
      },
    });
  });

  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  // Target "Slow hydration" (the "slow" session) rather than "Demo session"
  // because the serial suite mutates demo's agent (prior tests switch agents on
  // it). "slow" keeps its original "build" agent throughout — confirmed by the
  // DOM showing "BLD Slow hydration" even late in the serial run. It is a
  // collapsed root at cold start (loaded:false, has descendants → ▸ 1).
  const row = page.locator(".tree-row", { hasText: "Slow hydration" });
  await expect(row).toBeVisible();
  await expect(row.locator(".tree-twisty[aria-label='Expand']")).toBeVisible();

  // Symptom 1: the agent chip is present on a COLLAPSED node (the old StubNode
  // explicitly omitted it). The chip shows the session's agent ("build" → "BLD").
  // The server's async seedColdLastAgents fills the agent AFTER the cold snapshot;
  // the lastAgent.set event + patchTreeAgent deliver it to the tree node.
  const chip = row.locator(".tree-agent");
  await expect(chip).toBeVisible({ timeout: 15000 });

  // Symptom 2: right-clicking the collapsed node opens the context menu (the old
  // StubNode did not spread the context-menu triggers).
  await row.locator(".tree-node").click({ button: "right" });
  await expect(page.locator(".ctxm-menu")).toBeVisible();
});

// ─── (d) ─────────────────────────────────────────────────────────────────────
// OLD BUG: on reload, the tree would "flatten" — show all sessions as flat roots
// or a stale partial list, losing the parent/child structure. tree=2 FIX: the
// server re-ships the frontier snapshot on reconnect; the client re-applies it.
// Structure is always authoritative from the server, never re-inferred locally.
test("(d) reload does not flatten the tree — structure preserved from the frontier", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);

  // Expand demo and confirm sub is a child.
  const demoRow = page.locator(".tree-row", { hasText: "Demo session" });
  await demoRow.locator(".tree-twisty").click();
  await expect(page.locator(`.tree-node.sub[data-session-id="sub"]`)).toBeVisible({ timeout: 8000 });

  // Reload — the cold snapshot ships roots only (collapsed). The child should
  // disappear (collapsed under demo) but NOT flatten to root level.
  await page.reload();
  await waitForTreeSettled(page);

  // demo is still a root with children (Expand twisty present = has descendants).
  const demoRowAfter = page.locator(".tree-row", { hasText: "Demo session" });
  await expect(demoRowAfter).toBeVisible();
  await expect(demoRowAfter.locator(".tree-twisty[aria-label='Expand']")).toBeVisible();

  // sub must NOT be visible (collapsed) and must NOT appear as a root.
  await expect(page.locator(`.tree-node[data-session-id="sub"]`)).toHaveCount(0);
  await expect(page.locator(`.tree-node[data-session-id="sub"]:not(.sub)`)).toHaveCount(0);

  // Re-expand demo → sub reappears as a child (re-fetched from the frontier).
  await demoRowAfter.locator(".tree-twisty").click();
  await expect(page.locator(`.tree-node.sub[data-session-id="sub"]`)).toBeVisible({ timeout: 8000 });
});

// ─── (e) ─────────────────────────────────────────────────────────────────────
// OLD BUG: archived sessions would "ghost" — a lingering empty row left behind
// by a stale local cache after the server removed the session. tree=2 FIX: the
// server emits a tree.op node.remove; the client drops the node cleanly.
test("(e) an archived session does not ghost — it disappears cleanly", async ({ page }) => {
  await page.goto(projectUrl("/"));

  // Create a fresh session so we don't disturb the seeded sessions.
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByPlaceholder("Message…").fill("ghost me");
  await page.keyboard.press("Enter");

  // Grab the created session's id from the deep-linked URL.
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBeTruthy();
  const id = new URL(page.url()).searchParams.get("session")!;
  const node = page.locator(`.tree-node[data-session-id="${id}"]`);
  await expect(node).toBeVisible({ timeout: 8000 });

  // Let the turn settle before archiving (avoids racing the trailing session.idle
  // which can re-hydrate a just-archived session).
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 8000 });

  // Archive via the session inspector (Usage pill → Session details → Archive).
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await page.getByRole("dialog", { name: "Usage" }).getByRole("button", { name: "Session details →" }).click();
  const insp = page.getByRole("dialog", { name: "Session inspector" });
  await insp.getByRole("button", { name: /Archive session/ }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm archive" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /Archive/ }).click();

  // The node disappears from the live tree.
  await expect(node).toHaveCount(0, { timeout: 8000 });

  // The "no ghost" assertion: wait a moment and confirm it does NOT reappear.
  // The old client's stale cache could re-render the row on the next tick; the
  // tree=2 node.remove drops it for good.
  await page.waitForTimeout(2000);
  await expect(node).toHaveCount(0);
});
