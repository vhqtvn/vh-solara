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
// is unit-pinned with fake timers (createMessageActionsFork.test.ts) — an
// e2e 15s wall-clock hang is not worth its runtime; the network-failure
// class here drives the SAME notice + guidance path.
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
  release();
  const bell = page.getByRole("button", { name: "Notifications" });
  await expect(bell.locator(".notif-badge")).toBeVisible({ timeout: 8000 });
  await bell.click();
  const item = page.locator(".notif-item").first();
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
