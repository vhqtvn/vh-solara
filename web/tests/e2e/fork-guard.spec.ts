import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Fork FE guard (send-net-resilience slice 4c, DEC-A8 "guard only") — the
// real-browser assertions for the honesty path. Upstream fork is NOT
// idempotent and has no caller id, so a retried fork duplicates a whole
// session; the guard bounds the POST, single-flights it, and surfaces an
// outcome-unknown notification with inspect-tree guidance instead of the old
// silent no-op — and NEVER auto-retries.
//
// Failure injection is BROWSER-SIDE (page.route on the /oc fork route): the
// shared fixtureserver's fork handler is immediate-success only, and
// pkg/fixtures/opencode.go is fenced for this slice (G2). Interception in
// the browser exercises the exact user path (button → fetch → guard →
// notification surface) without touching the fixture. The 15s TIMEOUT class
// was unit-pinned with fake timers (createMessageActionsFork.test.ts); the
// e2e below now covers it too through the guard's REAL bound (one parked
// 15s window — cluster C, defer D-4C-F1; a page.clock variant was attempted
// and retired, see the test's deviation note).
//
// Serial lane (workers:1) like the rest of the suite; each test creates its
// own session and the afterEach removes it from the shared fixtureserver.

const csrf = { "X-VH-CSRF": "1" };

// The session this test created (afterEach cleanup).
let currentSession = "";

// Draft-create a session whose first user message is the fork target
// (the reply-resilience raisePermissionCard flow, minus the [[perm]] marker:
// a plain turn that completes on its own).
async function sessionWithMessage(page: import("@playwright/test").Page, text: string) {
  currentSession = "";
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByPlaceholder("Message…").fill(text);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => new URL(page.url()).searchParams.get("session") ?? "")
    .not.toBe("");
  currentSession = new URL(page.url()).searchParams.get("session") ?? "";
}

async function forkButton(page: import("@playwright/test").Page, text: string) {
  // The action bar is opacity-gated on .msg:hover — Playwright's click
  // hovers first, which reveals it.
  const row = page.locator(".msg", { hasText: text }).first();
  await expect(row).toBeVisible({ timeout: 8000 });
  return row.getByRole("button", { name: "Fork" });
}

test.afterEach(async ({ request }) => {
  if (currentSession) {
    const res = await request.post(`/oc/fixture/delete?session=${encodeURIComponent(currentSession)}`, { headers: csrf });
    if (!res.ok()) throw new Error(`fixture delete failed: ${res.status()} ${res.statusText()}`);
    currentSession = "";
  }
});

test("network-failed fork: single-flight (ONE request), outcome-unknown + inspect-tree guidance, never auto-retries", async ({ page }) => {
  test.setTimeout(45000);
  // Park the fork route in the browser: the POST hangs until we release it
  // to a connection failure (network-error class → outcome unknown).
  let forkRequests = 0;
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/oc/session/*/fork", async (route) => {
    forkRequests++;
    await parked;
    await route.abort("connectionfailed");
  });

  await sessionWithMessage(page, "fork guard network failure target");
  const fork = await forkButton(page, "fork guard network failure target");

  // SINGLE-FLIGHT under a parked request: two taps, ONE POST leaves the page.
  await fork.click();
  await page.waitForTimeout(300); // let the request park
  await fork.click();
  await page.waitForTimeout(300);
  expect(forkRequests).toBe(1);

  // Release to a connection failure → the honest outcome-unknown surface.
  // Slice A note (2026-10-10): open the bell BEFORE asserting — the unread
  // BADGE is legitimately transient here (attending-view acks mark ALL of the
  // viewed session's notifications read ~300ms after the turn completes, by
  // design — "viewing a session acks all of its notifications (any kind)",
  // sync/orchestration.ts ackSession). Asserting an 8s-visible badge required
  // catching that window and raced with recovery-timing shifts. The durable
  // observable is the ITEM in the opened panel: the outcome-unknown
  // notification with its guidance persists in the list (read or not).
  release();
  const bell = page.getByRole("button", { name: "Notifications" });
  await bell.click();
  // Target the FORK notification specifically (newest-first, but turn
  // completion can interleave a "Session finished" notification above it).
  const item = page.locator(".notif-item", { hasText: "Fork outcome unknown" }).first();
  await expect(item.locator(".notif-title")).toContainText("Fork outcome unknown");
  const detail = item.locator(".notif-detail");
  await expect(detail).toContainText("may still have been created");
  await expect(detail).toContainText("Inspect the session tree before retrying");
  await expect(detail).toContainText("duplicate session");
  await expect(detail).toContainText("cannot be automatically cancelled");
  // Never a "failed" claim for an outcome-unknown.
  await expect(item).not.toContainText("Fork not created");

  // NEVER auto-retry: after the outcome, no further request fires.
  await page.waitForTimeout(1500);
  expect(forkRequests).toBe(1);
});

test("successful fork: pre-guard behavior unchanged (selects the fork, silent)", async ({ page }) => {
  test.setTimeout(45000);
  await sessionWithMessage(page, "fork guard success target");
  const fork = await forkButton(page, "fork guard success target");

  await fork.click();
  // The fixture's fork handler answers the new session (ses_forkN) and the
  // SPA selects it — the URL ?session= moves to the fork id.
  await expect
    .poll(async () => new URL(page.url()).searchParams.get("session") ?? "")
    .toMatch(/^ses_fork\d+$/);
  // Silent success: no error notification badge.
  await expect(page.getByRole("button", { name: "Notifications" }).locator(".notif-badge")).toHaveCount(0);
});

// --- timeout class (cluster C, defer D-4C-F1) -----------------------------------
test("timed-out fork (parked POST, real 15s bound): outcome-unknown with the timeout wording, ONE request under a double-tap, never auto-retries", async ({ page }) => {
  test.setTimeout(45000);
  // CLOCK-CONTROL ATTEMPT AND HONEST RETREAT (documented deviation — this is
  // the "saying so" the slice contract demands, not a silent conversion): the
  // guard's bound is a plain setTimeout(FORK_TIMEOUT_MS) aborting an
  // AbortController-timed fetch, and a bare-page probe PROVED page.clock's
  // fastForward fires that timer and rejects a route-parked fetch. But in the
  // REAL app page, under --repeat-each, the fake-clock jump INTERMITTENTLY
  // never fired the app-armed 15s timer (evaluate-armed marker timers in the
  // same jump window DID fire; the badge never landed; extra jumps did not
  // recover it) — and runs containing the clock test also corrupted the
  // SIBLING net test's parked-fetch aborts (net-only runs: 8/8 green; mixed
  // runs: bursts of both tests failing). Root cause not established; the
  // contamination risk to the shared serial lane is disqualifying. This test
  // therefore pays ONE real 15s window — the same order as the reply spec's
  // three real 10s windows — and pins the identical guard behavior through
  // the real bound.
  let forkRequests = 0;
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/oc/session/*/fork", async (route) => {
    forkRequests++;
    await parked;
    await route.abort("connectionfailed");
  });

  await sessionWithMessage(page, "fork guard timeout target");
  const fork = await forkButton(page, "fork guard timeout target");

  // SINGLE-FLIGHT under a parked request: two taps, ONE POST leaves the page.
  await fork.click();
  await page.waitForTimeout(300); // let the request park
  await fork.click();
  await page.waitForTimeout(300);
  expect(forkRequests).toBe(1);

  // The server NEVER answers: the guard's OWN FORK_TIMEOUT_MS (15s) aborts
  // the POST → the honest outcome-unknown notice with the TIMEOUT wording.
  const bell = page.getByRole("button", { name: "Notifications" });
  await expect(bell.locator(".notif-badge")).toBeVisible({ timeout: 20_000 });
  await bell.click();
  // Target the FORK notification specifically (turn-completion notifications
  // can interleave above it in the newest-first list).
  const item = page.locator(".notif-item", { hasText: "Fork outcome unknown" }).first();
  await expect(item.locator(".notif-title")).toContainText("Fork outcome unknown");
  const detail = item.locator(".notif-detail");
  await expect(detail).toContainText("may still have been created");
  await expect(detail).toContainText("Inspect the session tree before retrying");
  await expect(detail).toContainText("duplicate session");
  await expect(detail).toContainText("cannot be automatically cancelled");
  // The TIMEOUT-class discriminator (vs the network class's "request failed"):
  // the exact 15s-bound wording the abort path emits.
  await expect(detail).toContainText("no confirmation within 15s");
  // Never a "failed" claim for an outcome-unknown.
  await expect(item).not.toContainText("Fork not created");

  // NEVER auto-retry: after the outcome, no further request fires (the net
  // test's post-outcome window).
  await page.waitForTimeout(1500);
  expect(forkRequests).toBe(1);

  // Release the parked POST (post-assertion hygiene: no never-settling route
  // handler outlives the test).
  release();
  await page.waitForTimeout(300);
});
