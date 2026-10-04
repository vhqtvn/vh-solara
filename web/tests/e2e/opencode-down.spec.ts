// OpenCode down-panel e2e (oc-death-watch S2 UI surfacing): drives the REAL
// health panel against a REAL oclife.Lifecycle through the fixtureserver's
// fixture-only /vh/fixture/oclife toggle (tools/fixtureserver/main.go), so
// the exact user-facing strings are asserted without killing anything.
//
// The panel polls /vh/opencode/status (5s normal, 2s while failed — see
// web/src/opencode-lifecycle.ts), so mode flips surface within one cadence;
// every assertion below is auto-retrying with generous budgets.
//
// SERIAL-SUITE HYGIENE: this lane is workers:1 over ONE shared
// fixtureserver. The lifecycle wiring is OFF by default and every test
// restores `?mode=off` (lifecycle=nil → /vh/opencode/status 503s again, the
// exact pre-spec posture) in afterEach, so sibling specs see today's
// behavior unchanged.

import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

test.afterEach(async ({ request }) => {
  // Restore the default fixture posture: no lifecycle wired (status 503,
  // panel renders nothing). Must run even when a test failed mid-way.
  const res = await request.get("/vh/fixture/oclife?mode=off");
  expect.soft(res.ok(), `afterEach mode=off -> ${res.status()}`).toBeTruthy();
});

test("down panel shows the down-since line, restart states, and clears on recovery", async ({
  page,
  request,
}) => {
  await page.goto(projectUrl("/"));

  // Baseline: the fixture ships no lifecycle wiring by default (status
  // 503 → lifecycleAvailable=false → the panel renders nothing).
  await expect(page.getByTestId("och-down-line")).toHaveCount(0);

  // ——— plain down ———
  await request.get("/vh/fixture/oclife?mode=down");
  const downLine = page.getByTestId("och-down-line");
  await expect(downLine).toBeVisible({ timeout: 15_000 });
  await expect(downLine).toContainText("OpenCode down since");
  // Plain down carries restart_attempts=0: no restarting/paused suffix.
  await expect(downLine).not.toContainText("restarting (attempt");
  await expect(downLine).not.toContainText("restart paused");
  // The problem card itself: role=alert titled "OpenCode down" (down_since
  // is set — vs "OpenCode failed to start" when it never came up). Filtered
  // by the title text because two unrelated role=alert surfaces exist in
  // the SPA (ChatView/Composer error slots) and strict-mode counts must not
  // trip on them.
  const card = page.getByRole("alert").filter({ hasText: "OpenCode down" });
  await expect(card).toContainText("fixture: opencode serve pid 4242 exited (signal KILL/9)");

  // ——— restart in progress ———
  await request.get("/vh/fixture/oclife?mode=restarting");
  await expect(downLine).toContainText("OpenCode down since", { timeout: 15_000 });
  await expect(downLine).toContainText("restarting (attempt 2)", { timeout: 15_000 });

  // ——— crash-loop give-up ———
  await request.get("/vh/fixture/oclife?mode=capped");
  await expect(downLine).toContainText("restart paused after 5 attempts", { timeout: 15_000 });
  await expect(downLine).not.toContainText("restarting (attempt");
  await expect(card).toContainText("fixture: opencode crash-loop: 5 restarts in 10m0s");

  // ——— recovery ———
  await request.get("/vh/fixture/oclife?mode=ready");
  await expect(downLine).toHaveCount(0, { timeout: 15_000 });
  await expect(card).toHaveCount(0, { timeout: 15_000 });
});
