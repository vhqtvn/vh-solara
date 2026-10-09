import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Git safety e2e (send-net-resilience slice 6, debate-2 Q3) — the real-browser
// crux for the uncertain-commit path: an unconfirmed commit must surface an
// honest outcome-unknown banner that WARDS the commit button and reconciles
// via status + the recent-commits log, never a blind retry; a definitive flow
// (real commit / real push to a local bare remote) proves the pre-guard
// behavior unchanged end-to-end through the REAL daemon git handlers.
//
// Topology: the fixtureserver serves the REAL pkg/web Server, so /vh/git/*
// runs REAL git against any dir the SPA's ?dir= points at. This spec creates
// a throwaway repo + bare origin (node-side), loads the SPA on that dir, and
// injects ONLY the failure classes browser-side (page.route — the fork-guard
// pattern; pkg/fixtures/opencode.go is fenced for this slice (G2) and is not
// touched). The commit-fetch TIMEOUT class is unit-pinned with fake timers
// (gitActionsGuard.test.ts); the network-failure class here drives the SAME
// uncertain path.
//
// Serial lane (workers:1): test 2 depends on test 1's landed commit.

const MSG = "e2e uncertain message";
let repo = "";
let origin = "";

function git(args: string, cwd: string) {
  execSync(`git ${args}`, { cwd, stdio: "pipe" });
}

test.beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "vh-git-e2e-"));
  origin = join(base, "origin.git");
  execSync(`git init --bare ${JSON.stringify(origin)}`, { stdio: "pipe" });
  repo = join(base, "repo");
  execSync(`git init ${JSON.stringify(repo)}`, { stdio: "pipe" });
  git('config user.email "t@t"', repo);
  git('config user.name "t"', repo);
  git(`remote add origin ${JSON.stringify(origin)}`, repo);
  writeFileSync(join(repo, "a.txt"), "initial\n");
  git("add a.txt", repo);
  git('commit -m "initial commit"', repo);
  // Establish upstream so the daemon's plain `git push` works.
  git("push -u origin HEAD", repo);
  // A staged change so the StagingPanel (commit box) renders.
  writeFileSync(join(repo, "b.txt"), "staged\n");
  git("add b.txt", repo);
});

test.afterAll(() => {
  if (repo) rmSync(join(repo, ".."), { recursive: true, force: true });
});

// Load the SPA on the throwaway repo and open the Changes view.
async function openChanges(page: import("@playwright/test").Page) {
  await page.goto(`/?dir=${encodeURIComponent(repo)}`);
  await page.getByRole("button", { name: "Changes" }).click();
  await expect(page.locator(".git-commit-btn")).toBeVisible({ timeout: 8000 });
}

test("network-failed commit: honest outcome-unknown banner wards the commit button, reconciles, then a real commit lands", async ({ page }) => {
  test.setTimeout(60000);
  await openChanges(page);

  // Inject the failure class browser-side: the commit POST dies on the link.
  await page.route("**/vh/git/commit*", (route) => route.abort("connectionfailed"));

  await page.locator(".git-commit-msg").fill(MSG);
  await page.locator(".git-commit-btn").click();

  // The honest banner (never a "failed" claim): outcome unknown + duplicate
  // risk + reconciliation guidance, plus the real recent-commits log through
  // the daemon's read endpoint.
  const banner = page.locator(".git-uncertain");
  await expect(banner).toBeVisible({ timeout: 8000 });
  await expect(banner).toContainText("Commit outcome unknown");
  await expect(banner).toContainText("may have landed");
  await expect(banner).toContainText("duplicate");
  await expect(banner.locator(".git-uncertain-log-row").first()).toContainText("initial commit");

  // The ward: commit button disabled + the drafted message retained.
  await expect(page.locator(".git-commit-btn")).toBeDisabled();
  await expect(page.locator(".git-commit-msg")).toHaveValue(MSG);

  // The notification carries the same honesty.
  const bell = page.getByRole("button", { name: "Notifications" });
  await expect(bell.locator(".notif-badge")).toBeVisible({ timeout: 8000 });
  await bell.click();
  const item = page.locator(".notif-item").first();
  await expect(item.locator(".notif-title")).toContainText("Commit outcome unknown");
  await expect(item.locator(".notif-detail")).toContainText("may have landed");

  // Reconcile: lift the injected failure, refresh status + log → ward lifts.
  await page.unroute("**/vh/git/commit*");
  await banner.getByRole("button", { name: /refresh status/i }).click();
  await expect(page.locator(".git-uncertain")).toHaveCount(0);
  await expect(page.locator(".git-commit-btn")).toBeEnabled();

  // The real commit lands through the REAL daemon handler (pre-guard
  // behavior): the staging panel collapses to a clean tree.
  await page.locator(".git-commit-btn").click();
  await expect(page.getByText("Working tree clean.")).toBeVisible({ timeout: 8000 });
});

test("network-failed push: honest retry-safe banner with the reconciliation log, then a real push lands", async ({ page }) => {
  test.setTimeout(60000);
  // A staged change so the staging panel (with the Push button) renders.
  writeFileSync(join(repo, "c.txt"), "push-me\n");
  git("add c.txt", repo);
  await openChanges(page);

  await page.route("**/vh/git/push*", (route) => route.abort("connectionfailed"));
  await page.getByRole("button", { name: "Push", exact: true }).click();

  const banner = page.locator(".git-uncertain");
  await expect(banner).toBeVisible({ timeout: 8000 });
  await expect(banner).toContainText("Push outcome unknown");
  await expect(banner).toContainText("safe");
  // The reconciliation log now shows test 1's landed commit.
  await expect(banner.locator(".git-uncertain-log-row").first()).toContainText(MSG);

  // Reconcile, then the REAL push to the bare remote (pre-guard behavior).
  // (The staged c.txt is intentionally NOT committed — a push moves commits,
  // not the index, so the panel keeps showing it; the proof is the done
  // notification + the remote below.)
  await page.unroute("**/vh/git/push*");
  await banner.getByRole("button", { name: /refresh status/i }).click();
  await expect(page.locator(".git-uncertain")).toHaveCount(0);
  await page.getByRole("button", { name: "Push", exact: true }).click();
  const bell = page.getByRole("button", { name: "Notifications" });
  await expect(bell.locator(".notif-badge")).toBeVisible({ timeout: 15000 });
  await bell.click();
  await expect(page.locator(".notif-item").first().locator(".notif-detail")).toContainText("pushed");

  // End-to-end proof: the remote actually received the commit.
  const remoteSubjects = execSync("git log --format=%s", { cwd: origin, stdio: "pipe" }).toString();
  expect(remoteSubjects).toContain(MSG);
});
