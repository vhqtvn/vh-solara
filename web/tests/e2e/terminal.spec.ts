import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Repo root — a real directory, so the PTY can actually spawn a shell. (The
// fixture's own project dir hosts the fake sessions, but the terminal needs a
// real on-disk dir; these are orthogonal.)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function termList(page: import("@playwright/test").Page, dir: string) {
  return page.evaluate(async (d) => {
    const r = await fetch(`/vh/term/list?dir=${encodeURIComponent(d)}`);
    return r.ok ? ((await r.json()) as Array<{ id: string }>) : [];
  }, dir);
}

async function termKill(page: import("@playwright/test").Page, dir: string, id: string) {
  return page.evaluate(
    async ({ d, i }) => {
      const r = await fetch(`/vh/term/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ dir: d, id: i }),
      });
      return r.ok;
    },
    { d: dir, i: id },
  );
}

test("terminal tabs: separate shells, add, switch, and per-tab kill", async ({ page }) => {
  await page.goto(`/?dir=${encodeURIComponent(repoRoot)}`);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForSelector(".term-host");
  await page.waitForSelector(".term-status.open", { timeout: 10000 });

  // Starts with a single shared tab.
  await expect(page.locator(".term-tab")).toHaveCount(1);

  // Write a marker into the shared shell.
  await page.locator(".term-host").click();
  await page.keyboard.type("echo TAB_SHARED");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  // Add a second shell → 2 tabs, and it's a FRESH shell (no shared marker).
  await page.getByRole("button", { name: "New terminal" }).click();
  await expect(page.locator(".term-tab")).toHaveCount(2);
  await page.waitForSelector(".term-status.open", { timeout: 10000 });
  await page.locator(".term-host").click();
  await page.keyboard.type("echo TAB_SECOND");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await expect.poll(async () => (await page.locator(".xterm-rows").innerText()).includes("TAB_SECOND")).toBe(true);
  expect(await page.locator(".xterm-rows").innerText()).not.toContain("TAB_SHARED");

  // The server reports two independent terminals for this dir.
  await expect.poll(async () => (await termList(page, repoRoot)).map((t) => t.id).sort()).toEqual(
    expect.arrayContaining(["shared"]),
  );
  const ids = (await termList(page, repoRoot)).map((t) => t.id);
  expect(ids.length).toBe(2);
  expect(ids).toContain("shared");
  expect(ids.some((i) => i.startsWith("t:"))).toBe(true);

  // Kill the second tab via its × → tab drops AND the server PTY is gone.
  await page.locator(".term-tab").nth(1).locator(".term-tab-kill").click();
  await expect(page.locator(".term-tab")).toHaveCount(1);
  await expect.poll(async () => (await termList(page, repoRoot)).map((t) => t.id)).toEqual(["shared"]);
});

test("terminal: a session-bound tab can be opened for the selected session", async ({ page }) => {
  await page.goto(projectUrl("/")); // fixture's own project → has sessions to select
  await page.locator(".tree-node").first().click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForSelector(".term-dock");

  // The "session" bind control appears once a session is selected; clicking it
  // adds a second tab (the session terminal) and makes it active.
  const bind = page.getByRole("button", { name: "Terminal for current session" });
  await expect(bind).toBeVisible();
  const before = await page.locator(".term-tab").count();
  await bind.click();
  await expect(page.locator(".term-tab")).toHaveCount(before + 1);
  // The new tab is selected (a session terminal).
  await expect(page.locator(".term-tab.on")).toHaveCount(1);
});

test("terminal: full-screen TUI (vim) stays live — xterm DECRQM stall regression", async ({ page }) => {
  // Regression for the xterm.js v6 DECRQM parser stall. vim emits
  // CSI [?] 12 $ p (DECRQM — "report mode") during startup to probe the
  // cursor-blink mode. xterm.js v6's built-in DECRQM handler deadlocks its
  // async write processor, so every term.write() AFTER that sequence queues
  // but never renders: the screen freezes on vim's first frame while input
  // still flows to the PTY, so the user types blind with no feedback and can't
  // even see :q work. The fix registers a no-op CSI handler that swallows
  // DECRQM before the broken built-in runs.
  //
  // This test launches vim, types a marker in insert mode, and asserts the
  // marker renders on screen — which only happens if the parser did NOT stall.
  // It then quits vim and types a shell command, proving the terminal stays
  // fully interactive through a TUI launch → use → exit cycle.
  await page.goto(`/?dir=${encodeURIComponent(repoRoot)}`);
  // Kill any leftover shared PTY from a prior iteration or failed run so the
  // Terminal click below spawns a FRESH shell with empty scrollback. The shared
  // PTY persists across SPA reconnects: each page.goto reattaches to the same
  // pty and replays its accumulated buffer, so a stale vim session, leftover
  // tildes, or a prior echo output would otherwise pollute the polls below
  // (e.g. the "~" probe would match stale scrollback before vim renders).
  // No-op if no shared session exists yet, so this is safe on the first run.
  await termKill(page, repoRoot, "shared");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForSelector(".term-host");
  await page.waitForSelector(".term-status.open", { timeout: 10000 });
  await page.locator(".term-host").click();

  // Unique throwaway path per run + `vim -n` (no swap file) so a vim killed by
  // a prior/failed run can't leave a .swp that trips E325: ATTENTION on the
  // next launch. :q! discards the buffer, so no file is written on success.
  const witness = `tmp/_decrqm_regression_${Date.now()}.txt`;
  await page.keyboard.type(`vim -n ${witness}`);
  await page.keyboard.press("Enter");
  // Wait until vim has drawn its UI — empty-buffer tildes ("~") only appear
  // once vim has rendered, which is also past the DECRQM probe that triggers
  // the stall. Polling (vs a fixed sleep) keeps this deterministic across
  // machines and vim startup speeds.
  await expect.poll(async () => (await page.locator(".xterm-rows").innerText()).includes("~"), {
    timeout: 15000,
  }).toBe(true);

  // Enter insert mode and type a unique marker. With the stall, the screen is
  // frozen at vim's first frame and this never renders.
  await page.keyboard.type("i");
  // xterm exposes no reliable insert-mode signal, so give vim time to actually
  // enter insert mode before sending the marker — otherwise the marker keystrokes
  // land as normal-mode commands and never render. The marker poll below is the
  // real guard; on the green path it returns instantly. Widened for slow CI.
  await page.waitForTimeout(400);
  const marker = `DECRQM_LIVE_${Date.now()}`;
  await page.keyboard.type(marker);
  await expect.poll(async () => (await page.locator(".xterm-rows").innerText()).includes(marker), {
    timeout: 15000,
  }).toBe(true);

  // Quit vim (:q! discards the buffer) and confirm the shell prompt returns by
  // running an echo whose output must render — proving the terminal is live end
  // to end, not just the insert echo.
  await page.keyboard.press("Escape");
  await page.keyboard.type(":q!");
  await page.keyboard.press("Enter");
  // Wait until the shell has reclaimed the tty before typing the witness echo.
  // Vim runs inline here (no alternate screen), so its tildes/status-line
  // persist in the scrollback after exit and can't be used as an "all clear" —
  // the shell prompt itself begins with a "~" segment, so "no ~" never becomes
  // true. Pattern-matching the shell prompt is environment-specific (a bare ">"
  // sigil on a zsh+powerlevel10k host vs "runner@host:...$" on CI bash, and the
  // prompt may embed a live clock), so it cannot be a reliable cross-env signal.
  //
  // Instead send a UNIQUE sentinel echo and poll for its OUTPUT. When the
  // sentinel token renders, the shell's line discipline is echoing input —
  // positively proving it reclaimed the tty and is ready to execute commands —
  // with no prompt-shape dependency and no stale-buffer match (the token is
  // unique per run). A bounded retry handles the vim-teardown race where the
  // first send is consumed by vim's exit path: on poll timeout, press Enter
  // (flush any partial line) and resend. Duplicate sentinel echoes are
  // harmless. The subsequent `echo VIM_EXITED_OK` witness output-poll is a
  // SECOND, independent guard (it asserts the command's OUTPUT rendered, not
  // just input echo): if the sentinel gave a false positive, the witness poll
  // would still fail.
  const ready = `VH_READY_${Date.now()}`;
  let reclaimed = false;
  for (let attempt = 0; attempt < 5 && !reclaimed; attempt++) {
    await page.keyboard.type(`echo ${ready}`);
    await page.keyboard.press("Enter");
    try {
      await expect.poll(async () => (await page.locator(".xterm-rows").innerText()).includes(ready), {
        timeout: 4000,
      }).toBe(true);
      reclaimed = true;
    } catch {
      // vim-teardown race: flush a partial line and resend on the next attempt.
      await page.keyboard.press("Enter");
    }
  }
  expect(
    reclaimed,
    "shell did not reclaim the tty after vim quit (sentinel echo never rendered)",
  ).toBe(true);
  await page.keyboard.type("echo VIM_EXITED_OK");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await page.locator(".xterm-rows").innerText()).includes("VIM_EXITED_OK"), {
    timeout: 15000,
  }).toBe(true);
});
