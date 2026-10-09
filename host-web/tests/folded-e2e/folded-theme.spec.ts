import { expect, test, type Page } from "@playwright/test";
import { iframeSrcs } from "../e2e/util";

// =============================================================================
// FOLDED-POSTURE HOST-THEME e2e — closes the dev-posture-only coverage gap
// (review F1): every host-theme behavioral crux previously proven ONLY in the
// dev lane (`tests/e2e/settings.spec.ts`, Vite dev server) is re-proven here
// in the FOLDED PRODUCTION topology the operator actually runs — the REAL
// `local-server` binary serving the host at `/` (both SPAs built +
// materialized, host built with VITE_HOST_FOLDED=1 → base /host/, minified,
// DEV bridges dead-code-eliminated), same-origin `/app` pane iframes, NO Vite
// dev server anywhere.
//
// Why this is not redundant with the dev specs: the folded build is a
// DIFFERENT artifact (minified, hashed entry, folded base, no bridges) and the
// fold is a DIFFERENT topology (host + SPA share ONE origin). The four
// scenarios below are the ones where that difference is load-bearing:
//
//   1. PRE-PAINT ISOLATION (the core gap): the inline head script in
//      index.html must survive `vite build` byte-preserved and carry the
//      persisted theme onto <html> BEFORE the entry bundle runs. In dev the
//      entry is `/src/index.tsx`; here it is the hashed `/host/assets/…`
//      bundle — the route-hold proves the INLINE script's work alone, then
//      the handoff to the minified bundle's applyHostTheme().
//   2. PICKER SMOKE: the real gear → "Theme…" → light-theme flow in the
//      minified build (menu-first landing per ed1878a, class + light marker
//      + color-scheme + body palette).
//   3. CROSS-WINDOW STORAGE SYNC: two host documents on the SAME folded
//      origin tracking each other's picker writes live via the storage
//      listener (zero reloads).
//   4. SAME-ORIGIN KEY-SPLIT (folded-UNIQUE — physically meaningful ONLY
//      here): host and SPA share one origin, so the storage event for a host
//      theme write fires in the SPA document too. The vh-host:theme:v1 /
//      vh.theme.v1 key split is what keeps the two theme systems independent;
//      the dev posture (cross-origin mock iframe) CANNOT exercise this.
//
// Production-safe like folded-restore.spec.ts: DOM + localStorage reads only
// (no DEV bridges exist in the folded build).
// =============================================================================

const HOST_THEME_KEY = "vh-host:theme:v1";
const SPA_THEME_KEY = "vh.theme.v1";
const SPA_CUSTOM_THEME_KEY = "vh.theme.custom.v1";
/** Real persisted envelope setHostTheme writes (host-web/src/theme.ts). */
const LIGHT_ENVELOPE = JSON.stringify({ v: 1, data: "solarized-light" });
/** solarized-light body bg (#fdf6e3) — the same palette value the dev lane
 * asserts; proves the theme block shipped inside the folded CSS bundle. */
const LIGHT_BG = "rgb(253, 246, 227)";

/** Open Settings (gear) and wait for the popover — landing on the MENU view
 * (the on-open view reset, ed1878a): a menu-only item is visible, the theme
 * picker is not. */
async function openSettingsOnMenu(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-btn"]').click();
  await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-reload"]')).toBeVisible();
  await expect(page.locator('[data-testid="theme-grid"]')).toHaveCount(0);
}

/** Open the theme picker through the real menu item ("Theme…"). */
async function openThemePicker(page: Page): Promise<void> {
  await openSettingsOnMenu(page);
  await page.locator('[data-testid="settings-theme"]').click();
  await expect(page.locator('[data-testid="theme-grid"]')).toBeVisible();
}

test.describe.serial("folded-posture host theme", () => {
  test("folded pre-paint: the inline head script carries the theme before the entry bundle runs", async ({
    page,
  }) => {
    // Fetch the HTML the REAL binary serves at `/` and locate the built entry
    // module script (a hashed asset under the folded base /host/ — also a
    // posture tripwire: a dev-server HTML would serve /src/index.tsx).
    const res = await page.request.get("/");
    expect(res.status(), "folded host shell served at /").toBe(200);
    const html = await res.text();
    const m =
      /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html) ??
      /<script[^>]*src="([^"]+)"[^>]*type="module"/.exec(html);
    expect(m, "built entry module script found in the served HTML").toBeTruthy();
    const entryPath = m![1];
    expect(
      entryPath,
      "entry is a hashed asset under the folded base (posture tripwire)",
    ).toMatch(/^\/host\/assets\/[^/]+\.js$/);
    const entryUrl = new URL(entryPath, new URL(res.url()).origin).href;

    // Seed persistence BEFORE load with the real key + envelope (direct
    // localStorage write — the picker→storage WRITE path is covered by the
    // dev lane and scenario 2 below; this isolates the boot READ path). The
    // init script runs before ANY page script, including the inline head
    // script — and, because this context has never booted a page, there is
    // no service worker yet, so the held request below hits the network
    // layer where Playwright routing lives.
    await page.addInitScript((args) => {
      localStorage.setItem(args.key, args.envelope);
    }, { key: HOST_THEME_KEY, envelope: LIGHT_ENVELOPE });

    // Route-hold EXACTLY the entry request. Module scripts are deferred: the
    // browser FETCHES when the parser reaches the tag but EXECUTES after
    // parsing — so when this request fires, head parsing has necessarily
    // passed the inline script (which runs synchronously at parse), and NO
    // module has executed yet. Whatever is on <html> now is the INLINE
    // script's work alone. (Same argument as the dev lane's
    // /src/index.tsx hold, against the built hashed bundle.)
    let releaseEntry: () => void = () => {};
    let signalRequested!: () => void;
    const entryRequested = new Promise<void>((r) => {
      signalRequested = r;
    });
    await page.route(
      (url) => url.href === entryUrl,
      async (route) => {
        signalRequested();
        await new Promise<void>((r) => {
          releaseEntry = r;
        });
        await route.continue();
      },
    );
    const nav = page.goto("/");
    // No unhandled rejection if a failed assert below closes the page
    // mid-hold; the happy path still awaits `nav` explicitly.
    void nav.catch(() => {});
    await entryRequested;

    // CRUX — held (no module JS has run): theme class + light marker from
    // the inline script alone. This is also the proof the inline script
    // survived `vite build` byte-preserved in the folded artifact.
    const cls = await page.evaluate(() => document.documentElement.className);
    expect(cls, "inline-script theme class (pre-entry-bundle)").toContain("theme-solarized-light");
    expect(cls, "inline-script light marker (pre-entry-bundle)").toContain("host-theme-light");

    // Release: the entry bundle boots and applyHostTheme() re-applies
    // idempotently — the classes survive the handoff (no flash back to
    // dark). host-app-root visible proves the app (and thus
    // applyHostTheme(), which runs before render) has actually executed.
    releaseEntry();
    await nav;
    await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/theme-solarized-light/);
    await expect(page.locator("html")).toHaveClass(/host-theme-light/);
  });

  test("folded picker smoke: Settings lands on the menu; a LIGHT theme applies the real palette", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();
    const html = page.locator("html");
    // Fresh context → empty storage → default dark, which IS the :root
    // palette: no theme- class on <html>.
    await expect(html).not.toHaveClass(/theme-/);

    // gear → MENU first (the on-open view reset, ed1878a) → "Theme…" → grid.
    await openThemePicker(page);

    // Pick a LIGHT theme: class + light marker + color-scheme flip + the
    // body painting from the theme palette (the folded CSS bundle carries
    // the full theme block).
    await page.locator('[data-testid="theme-solarized-light"]').click();
    await expect(html).toHaveClass(/theme-solarized-light/);
    await expect(html).toHaveClass(/host-theme-light/);
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe("light");
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe(LIGHT_BG);
  });

  test("folded cross-window sync: page B tracks page A's picker sequence live (zero reloads)", async ({
    page,
    context,
  }) => {
    // The witness loads FIRST at default dark (a page booted after the write
    // would read the stored theme at init, not through the storage
    // listener). Storage events fire only in OTHER same-origin documents —
    // both pages live on the SAME folded origin here.
    const pageB = await context.newPage();
    try {
      await pageB.goto("/");
      await expect(pageB.locator('[data-testid="host-app-root"]')).toBeVisible();
      const htmlB = pageB.locator("html");
      await expect(htmlB, "page B booted at default dark").not.toHaveClass(/theme-/);
      // Reload sentinel: if B were reloaded by any step below, this flag
      // would vanish (a fresh document never sets it).
      await pageB.evaluate(() => {
        (window as unknown as { __themeSyncNoReload?: boolean }).__themeSyncNoReload = true;
      });

      // Page A boots and drives the REAL picker: dark(dracula) → LIGHT →
      // default dark — B must track every transition without reloading.
      await page.goto("/");
      await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();
      await openThemePicker(page);

      await page.locator('[data-testid="theme-dracula"]').click();
      await expect(page.locator("html")).toHaveClass(/theme-dracula/);
      await expect(htmlB, "B tracks the dark theme via the storage listener").toHaveClass(
        /theme-dracula/,
      );

      await page.locator('[data-testid="theme-solarized-light"]').click();
      await expect(htmlB, "B tracks the light theme").toHaveClass(/theme-solarized-light/);
      await expect(htmlB, "B flips the light marker too").toHaveClass(/host-theme-light/);

      await page.locator('[data-testid="theme-dark"]').click();
      await expect(htmlB, "dark IS :root — every theme class clears in B").not.toHaveClass(
        /theme-/,
      );
      await expect(htmlB).not.toHaveClass(/host-theme-light/);

      // No reload ever happened in B (sentinel intact) — the classes moved
      // through the storage listener, live.
      expect(
        await pageB.evaluate(
          () => (window as unknown as { __themeSyncNoReload?: boolean }).__themeSyncNoReload,
        ),
        "page B was never reloaded",
      ).toBe(true);
    } finally {
      await pageB.close();
    }
  });

  test("folded same-origin key-split: host write lands under vh-host:theme:v1; the SPA keys never appear", async ({
    page,
  }) => {
    // Folded-UNIQUE: only in this posture do the host document and the
    // embedded /app SPA share ONE origin, so this is the only place the
    // storage-key split is a real, physical collision test. Fresh context
    // (Playwright gives each test its own); this drives its own picker write
    // — the same real path scenario 2 exercises.
    await page.goto("/");
    await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();

    // Wait for the folded self-seed /app pane to be LIVE: src assigned and
    // the SPA document fully loaded (module scripts, including its theme
    // module's key-filtered storage listener, run before the load event).
    const origin = new URL(page.url()).origin;
    await expect
      .poll(async () => (await iframeSrcs(page)).some((s) => s.startsWith(`${origin}/app`)), {
        timeout: 20000,
      })
      .toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const f = document.querySelector("iframe.pane-iframe") as HTMLIFrameElement | null;
            return !!f?.contentDocument && f.contentDocument.readyState === "complete";
          }),
        { timeout: 20000 },
      )
      .toBe(true);

    // The picker write (real UI path).
    await openThemePicker(page);
    await page.locator('[data-testid="theme-solarized-light"]').click();
    await expect(page.locator("html")).toHaveClass(/theme-solarized-light/);

    // Give the same-origin storage event every chance to (wrongly) reach
    // the SPA document before the negative asserts.
    await page.waitForTimeout(400);

    // The host key carries the write, under the real versioned envelope…
    expect(await page.evaluate((k) => localStorage.getItem(k), HOST_THEME_KEY)).toBe(
      LIGHT_ENVELOPE,
    );
    // …and the SPA's theme keys are ABSENT — the SPA's persistedSignal never
    // writes at boot (hydration is a pure read) and nothing in the host
    // write path may touch the SPA's keys.
    expect(
      await page.evaluate((k) => localStorage.getItem(k), SPA_THEME_KEY),
      "SPA theme key absent on the shared folded origin",
    ).toBeNull();
    expect(
      await page.evaluate((k) => localStorage.getItem(k), SPA_CUSTOM_THEME_KEY),
      "SPA custom-theme key absent too",
    ).toBeNull();

    // And the live same-origin /app SPA document did NOT react to the host
    // write: the storage event fired in it as well (storage events reach
    // ALL same-origin documents), but its key-filtered listener must ignore
    // vh-host:theme:v1 — the host's theme class never appears on the SPA's
    // <html>. Reaching into contentDocument is only possible same-origin —
    // the dev posture cannot assert this at all.
    const spaHtmlClass = await page.evaluate(() => {
      const f = document.querySelector("iframe.pane-iframe") as HTMLIFrameElement | null;
      return f?.contentDocument?.documentElement.className ?? null;
    });
    expect(spaHtmlClass, "same-origin /app iframe document is reachable (folded-only)").toBeTruthy();
    expect(spaHtmlClass, "the host theme must not leak into the SPA document").not.toContain(
      "theme-solarized-light",
    );
  });
});
