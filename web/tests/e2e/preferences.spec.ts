import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// The Preferences editor writes the project's .vh-solara/preferences.local.jsonc
// via /vh/project-settings. We intercept that endpoint so the test owns the data
// and never writes the repo's real file; /vh/render (the confirm diff) hits the
// real fixture daemon.
test("Preferences: agent-styles row edits, previews a diff, and saves", async ({ page }) => {
  let committed: any = null;
  await page.route("**/vh/project-settings*", async (route) => {
    const req = route.request();
    if (req.url().includes("/project-settings/watch")) return route.continue(); // real SSE
    if (req.method() === "GET") {
      await route.fulfill({ json: { agentStyles: { build: { label: "BLD", color: "warn", style: "solid" } } } });
      return;
    }
    // PUT/POST: dryRun returns a before/after pair; a real save returns ok.
    const body = JSON.parse(req.postData() || "{}");
    if (body.dryRun) {
      await route.fulfill({
        json: { old: `{\n  "agentStyles": {}\n}\n`, new: `{\n  "agentStyles": ${JSON.stringify(body.agentStyles, null, 2)}\n}\n` },
      });
    } else {
      committed = body;
      await route.fulfill({ json: { ok: true } });
    }
  });

  await page.goto(projectUrl("/"));
  // Reach the editor via the settings gear beside the project switcher. The gear
  // opens a project-settings dropdown (Preferences / Reload project); open it,
  // then pick the Preferences entry.
  await page.locator(".proj-settings").click();
  await page.getByRole("menuitem", { name: "Preferences" }).click();

  // The @build row is seeded from the (mocked) file.
  const buildRow = page.locator(".agents-row", { hasText: "@build" });
  await expect(buildRow).toBeVisible();
  const label = buildRow.locator(".agents-label");
  await expect(label).toHaveValue("BLD");

  // Edit the label; the live preview chip follows.
  await label.fill("SUP");
  await expect(buildRow.locator(".msg-agent.styled")).toHaveText("SUP");

  // Save… opens the confirm diff.
  await page.getByRole("button", { name: "Save…" }).click();
  const modal = page.locator(".agents-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".agents-diff")).not.toBeEmpty();

  // Confirm writes; the editor reports success and the payload carried our edit.
  await modal.getByRole("button", { name: "Save to file" }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator(".agents-msg")).toContainText("Saved");
  expect(committed.agentStyles.build.label).toBe("SUP");
  expect(committed.agentStyles.build.color).toBe("warn");
  // The combined payload always carries nameReplacements (possibly empty).
  expect(Array.isArray(committed.nameReplacements)).toBe(true);
});

test("Preferences: session-names editor adds a rule and previews the transform", async ({ page }) => {
  let committed: any = null;
  await page.route("**/vh/project-settings*", async (route) => {
    const req = route.request();
    if (req.url().includes("/project-settings/watch")) return route.continue();
    if (req.method() === "GET") {
      await route.fulfill({ json: {} });
      return;
    }
    const body = JSON.parse(req.postData() || "{}");
    if (body.dryRun) {
      await route.fulfill({
        json: { old: `{}`, new: JSON.stringify({ nameReplacements: body.nameReplacements }, null, 2) },
      });
    } else {
      committed = body;
      await route.fulfill({ json: { ok: true } });
    }
  });

  await page.goto(projectUrl("/"));
  await page.locator(".proj-settings").click();
  await page.getByRole("menuitem", { name: "Preferences" }).click();

  // The Session names section is the first <section>. Add a rule.
  await page.getByRole("button", { name: "Add rule" }).click();

  // Fill the pattern and replacement inputs (first row). Pattern is regex, so
  // brackets must be escaped to match literally.
  const pattern = page.locator('input[placeholder*="IMPORTANT"]');
  const replacement = page.locator('input[placeholder="❗"]');
  await pattern.first().fill("\\[\\[IMPORTANT\\]\\]");
  await replacement.first().fill("❗");

  // Edit the sample title and check the preview transforms.
  const sample = page.locator("#pref-name-sample");
  await sample.fill("[[IMPORTANT]] release");
  await expect(page.locator("#pref-name-sample ~ strong")).toContainText("❗ release");

  // Save → confirm → commit.
  await page.getByRole("button", { name: "Save…" }).click();
  const modal = page.locator(".agents-modal");
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Save to file" }).click();
  await expect(modal).toHaveCount(0);

  // The committed payload carries the rule.
  expect(committed.nameReplacements).toHaveLength(1);
  expect(committed.nameReplacements[0].pattern).toBe("\\[\\[IMPORTANT\\]\\]");
  expect(committed.nameReplacements[0].replacement).toBe("❗");
});

// ----------------------------------------------------------------------------
// E Ink display-signal check (requested diagnostics) — the app-preferences
// side of this spec. The check runs ONLY on the explicit "Check display
// signals" click (never at startup), reports CLUES (never identification),
// and can never change the profile by itself. Test 1 mocks the two positive
// display media queries through the sanctioned matchMedia patch seam (the
// terminal.spec.ts forceCoarsePointer pattern: addInitScript wraps the REAL
// matchMedia before any app code, delegating everything except the two
// e-ink queries) and proves positive clues leave the profile OFF until a
// SECOND explicit "Enable E Ink mode" click — which writes the same pref the
// manual toggle uses. Test 2 runs the check against the REAL unmocked
// desktop display (no positive signals) and proves the neutral copy plus a
// still-fully-usable manual toggle.

test("E Ink display-signal check: clues never auto-enable; Enable is a second explicit click", async ({ page }) => {
  await page.addInitScript(() => {
    const orig = window.matchMedia.bind(window);
    const positive = new Set(["(update: slow)", "(monochrome)"]);
    window.matchMedia = ((q: string) => {
      if (positive.has(q)) {
        return {
          matches: true,
          media: q,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => false,
        } as MediaQueryList;
      }
      return orig(q);
    }) as typeof window.matchMedia;
  });
  await page.goto(projectUrl("/"));

  // Default boot: profile OFF, nothing persisted.
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBeNull();

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const einkToggle = dialog.getByRole("checkbox", { name: "E Ink mode" });
  await expect(einkToggle).toBeVisible();
  await expect(einkToggle).not.toBeChecked();
  // Nothing ran on its own: no results and no Enable affordance render
  // before the explicit check click.
  await expect(dialog.locator("[data-eink-check-summary]")).toHaveCount(0);
  await expect(dialog.locator("[data-eink-check-clue]")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Enable E Ink mode" })).toHaveCount(0);

  // Explicit click #1: the check runs and reports the mocked positive
  // signals as CLUES.
  await dialog.getByRole("button", { name: "Check display signals" }).click();
  const summary = dialog.locator("[data-eink-check-summary]");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("compatible with an e-ink panel");
  await expect(dialog.locator("[data-eink-check-clue]")).toHaveCount(2);

  // Clues never identify and never auto-enable: the toggle is still OFF,
  // nothing was persisted by the check, and no theme class changed.
  await expect(einkToggle).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBeNull();
  let classes = await page.evaluate(() => Array.from(document.documentElement.classList));
  expect(classes).not.toContain("theme-eink");

  // Explicit click #2 (Enable): flips the same pref the manual toggle uses.
  await dialog.getByRole("button", { name: "Enable E Ink mode" }).click();
  await expect(einkToggle).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBe(
    JSON.stringify({ v: 1, data: true }),
  );
  classes = await page.evaluate(() => Array.from(document.documentElement.classList));
  expect(classes).toContain("theme-eink");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("E Ink display-signal check: real display with no signals → neutral copy, manual toggle intact", async ({ page }) => {
  // No matchMedia patch: the check consults the real display. A desktop
  // color display answers (update: fast) and (monochrome: 0) — no positive
  // clues, so the copy must be neutral and the manual path untouched.
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const einkToggle = dialog.getByRole("checkbox", { name: "E Ink mode" });
  await expect(einkToggle).not.toBeChecked();

  await dialog.getByRole("button", { name: "Check display signals" }).click();
  const summary = dialog.locator("[data-eink-check-summary]");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("No e-ink signals reported");
  await expect(summary).toContainText("enable E Ink mode manually");
  // No clues, no Enable affordance on a negative result.
  await expect(dialog.locator("[data-eink-check-clue]")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Enable E Ink mode" })).toHaveCount(0);

  // Manual ON stays fully usable when every signal is negative.
  await einkToggle.click();
  await expect(einkToggle).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("vh.prefs.einkProfile.v1"))).toBe(
    JSON.stringify({ v: 1, data: true }),
  );

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

// ----------------------------------------------------------------------------
// E-ink profile hint copy (UX Slice 4 — whole-profile acceptance). The
// Appearance hint must describe the program's ACTUAL behavior: settled-PART
// streaming (not whole-reply completion — the old wording overclaimed),
// page buttons across the owned surfaces, persistent connection notices, and
// quiet periodic timers.
test("E Ink mode hint: accurate settled-part wording and truthful feature description", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const hint = dialog.locator("[data-eink-profile-hint]");
  await expect(hint).toBeVisible();

  const text = (await hint.textContent()) ?? "";
  // Settled-PART rendering, not whole-reply completion…
  expect(text).toContain("part by part");
  expect(text).toContain("each block appears once it settles");
  // …the old overly-broad claim is gone.
  expect(text).not.toContain("appear only once complete");
  // Paging is described, across the actual surface set…
  expect(text).toContain("page buttons");
  expect(text).toContain("terminal");
  expect(text).toContain("notes");
  // …so are persistent notices and quiet timers.
  expect(text).toContain("until the connection recovers or you dismiss them");
  expect(text).toContain("go quiet");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

// ----------------------------------------------------------------------------
// E-ink profile (UX Slice 4 — quiet UI): connection-notice persistence on the
// REAL event path. The drop is injected exactly as connstatus-thread.spec.ts
// does (an init-script EventSource wrapper closes the tree stream and fires
// its onerror — the tunnel-drop shape); the reconnect requests are held
// (aborted) by a route until the test releases them, so the reconnecting
// grade — and with it the warn — deterministically outlives every OFF expiry
// window. Physical e-ink panel readability is an operator observation, not a
// browser property; this proves the BROWSER contract:
//   ON: the warn stays visible >5s while unresolved; recovery coalesces into
//       a stable ok that also stays >5s; the ON-only dismiss clears it.
//   OFF: the same drop recovers into the transient ok, which auto-expires
//       (≤2.5s + slack) and no dismiss affordance ever renders.

// The tree stream URL carries sessions= EMPTY ("sessions=&"); only the TREE
// stream is dropped (the session stream stays live throughout).
const isTreeStreamUrl = (url: string): boolean =>
  url.includes("/vh/stream") && !/[?&]sessions=[^&]/.test(url);

async function installDropInjection(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const OrigES = window.EventSource;
    let firstTreeES: EventSource | null = null;
    const Wrapped = function (this: EventSource, url: string | URL, opts?: EventSourceInit) {
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      const u = typeof url === "string" ? url : String(url);
      if (u.indexOf("/vh/stream") !== -1 && !/[?&]sessions=[^&]/.test(u) && !firstTreeES) {
        firstTreeES = es;
      }
      return es;
    } as unknown as { new (url: string | URL, opts?: EventSourceInit): EventSource; CLOSED: number; OPEN: number; CONNECTING: number };
    Wrapped.prototype = OrigES.prototype;
    const W = Wrapped as unknown as { CLOSED: number; OPEN: number; CONNECTING: number };
    W.CLOSED = OrigES.CLOSED;
    W.OPEN = OrigES.OPEN;
    W.CONNECTING = OrigES.CONNECTING;
    window.EventSource = Wrapped as unknown as typeof window.EventSource;
    (window as unknown as { __vhDropTree: () => boolean }).__vhDropTree = () => {
      const es = firstTreeES;
      if (!es) return false;
      firstTreeES = null; // one shot
      es.close(); // readyState → CLOSED
      if (typeof es.onerror === "function") es.onerror(new Event("error"));
      return true;
    };
  });
}

// Passive toast-history recorder (connstatus-thread's idiom): the toast is
// <Show>-conditional and (under OFF) the ok lives only 2.5s — too transient
// for a polling expect to catch deterministically. Pure observation.
async function installToastHistory(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as unknown as { __vhToastHistory: string[] }).__vhToastHistory = [];
    let last = "";
    const record = () => {
      const el = document.querySelector('[role="status"]');
      const text = el && el.textContent ? el.textContent.trim() : "";
      if (text && text !== last) {
        (window as unknown as { __vhToastHistory: string[] }).__vhToastHistory.push(text);
      }
      last = text;
    };
    const obs = new MutationObserver(record);
    const start = () => {
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      record();
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  });
}

// Hold tree-stream reconnects (abort) while Date.now() < releaseAt, then
// passthrough to the real fixture stream — a deterministic recovery edge.
function holdTreeReconnects(page: import("@playwright/test").Page, release: { at: number }) {
  void page.route("**/vh/stream**", (route) => {
    const url = route.request().url();
    if (isTreeStreamUrl(url) && Date.now() < release.at) {
      return route.abort("connectionreset");
    }
    return route.continue();
  });
}

test("E Ink ON: connection notices persist until resolved or dismissed (>5s visibility on the real event path)", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem("vh.prefs.einkProfile.v1", JSON.stringify({ v: 1, data: true }));
  });
  await installDropInjection(page);
  await installToastHistory(page);
  const release = { at: 0 };
  holdTreeReconnects(page, release);

  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 15_000 });

  // Hold every reconnect for 9s — the warn (armed at +1.2s) must outlive the
  // largest OFF expiry window (4s) by >5s of visibility.
  release.at = Date.now() + 9_000;
  expect(await page.evaluate(() => (window as unknown as { __vhDropTree: () => boolean }).__vhDropTree())).toBe(true);

  const toast = page.getByRole("status");
  const warn = toast.filter({ hasText: "Connection lost" });
  await expect(warn).toBeVisible({ timeout: 15_000 });
  const warnSeenAt = Date.now();
  await expect(page.getByRole("button", { name: "Dismiss notice" })).toBeVisible();

  // >5s later, still unresolved → still visible (nothing auto-expired it).
  await page.waitForTimeout(Math.max(0, warnSeenAt + 5_500 - Date.now()));
  await expect(warn).toBeVisible();

  // Release: the real stream resumes; the warn resolves into the recovery ok…
  release.at = 0;
  const ok = toast.filter({ hasText: "Reconnected" });
  await expect(ok).toBeVisible({ timeout: 30_000 });
  const okSeenAt = Date.now();
  // …which coalesces into a STABLE status under ON (>5s — OFF's 2.5s flash
  // is exactly what this rules out).
  await page.waitForTimeout(Math.max(0, okSeenAt + 5_500 - Date.now()));
  await expect(ok).toBeVisible();

  // DISMISS clears it (the ON-only exit).
  await page.getByRole("button", { name: "Dismiss notice" }).click();
  await expect(toast).toHaveCount(0);
  // And it STAYS gone (no re-arm without a new grade transition).
  await page.waitForTimeout(1_500);
  await expect(toast).toHaveCount(0);
});

test("E Ink OFF: notices stay transient — recovery ok auto-expires, no dismiss affordance", async ({ page }) => {
  test.setTimeout(90_000);
  await installDropInjection(page);
  await installToastHistory(page);
  const release = { at: 0 };
  holdTreeReconnects(page, release);

  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 15_000 });

  release.at = Date.now() + 6_000;
  expect(await page.evaluate(() => (window as unknown as { __vhDropTree: () => boolean }).__vhDropTree())).toBe(true);

  const toast = page.getByRole("status");
  const warn = toast.filter({ hasText: "Connection lost" });
  await expect(warn).toBeVisible({ timeout: 15_000 });
  // The OFF baseline has NO dismiss affordance — even while the warn holds.
  await expect(page.getByRole("button", { name: "Dismiss notice" })).toHaveCount(0);

  release.at = 0;
  // Recovery lands (durable via the history recorder — the ok is a 2.5s
  // transient under OFF, exactly the baseline under test)…
  await page.waitForFunction(
    () => (window as unknown as { __vhToastHistory: string[] }).__vhToastHistory.some((t) => t.includes("Reconnected")),
    undefined,
    { timeout: 30_000, polling: 250 },
  );
  // …and the ok AUTO-EXPIRES: by 4s after it fired (2.5s + slack) the toast
  // surface is gone.
  await page.waitForTimeout(4_000);
  await expect(toast).toHaveCount(0);
  // Still no dismiss anywhere in the OFF lifecycle.
  await expect(page.getByRole("button", { name: "Dismiss notice" })).toHaveCount(0);
});
