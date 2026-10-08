import { expect, test, type Page } from "@playwright/test";
import { LAYOUT_STORAGE_KEY, iframeSrcs } from "../e2e/util";

// =============================================================================
// FOLDED-POSTURE narrow-scope SW e2e — the S3b crux lane (levers A+B).
//
// Posture: the REAL binary serves the FOLDED PRODUCTION host at `/` (same
// topology as folded-restore.spec.ts — same-origin `/app` pane iframes, no
// Vite dev server). Since S3b the HOST document registers `/sw.js` with
// scope `/app` at boot (host-web/src/swNarrow.ts — lever A) and pane iframe
// src assignment is gated on that registration's ACTIVE worker
// (iframeRenderer.ts — lever B), so cold-booting panes are BORN
// service-worker-controlled and the S2/S2b machinery (coalescing, boot-data
// TTL/SWR, shell TTL) covers COLD boots, not just warm ones.
//
// Everything here is PRODUCTION-SAFE (no DEV bridges — dead-code-eliminated
// in the folded build): public SW APIs (getRegistration, frame controllers,
// response headers) and DOM only.
//
// Oracle note (honesty): A-F1's original deferred shape was "the SECOND
// pane's boot-data fetch carries x-vh-sw-at". This lane's server runs with a
// deliberately DEAD --opencode-url, so /oc/* responses are upstream errors —
// the SW serves error responses through UNSTAMPED (by policy). The
// equivalent born-controlled proof here uses the pane's BIRTH NAVIGATION
// instead: the shell document response (`/app`), which shellResponse ALWAYS
// stamps (fresh, stale and miss paths alike reconstruct with x-vh-sw-at) —
// plus the pane frame's own navigator.serviceWorker.controller. A pane that
// boots un-controlled shows NEITHER. The crux test covers BOTH loads: the
// COLD first boot (fresh registration racing the gated self-seed pane) and
// the planted 2-pane relaunch (restore path).
//
// Deferred (documented, not silently dropped): the deploy-transition shape
// (BUILD_ID bump → bounded reloads). The folded binary embeds exactly ONE
// build; expressing a skew needs a second binary + port swap mid-test — new
// lane infra, out of this slice's scope. The transition matrix itself is
// already receipted per engine (S3a X6, 3 engines × 6 cells, zero loops).
// =============================================================================

/** Origin of the folded server (config baseURL). */
function originOf(page: Page): string {
  return new URL(page.url()).origin;
}

/** Total panels across every workspace in a parsed v3 blob. */
function totalPanels(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 0;
  const wsList = (parsed as { workspaces?: Array<{ layout?: { panels?: Record<string, unknown> } }> })
    .workspaces ?? [];
  let n = 0;
  for (const ws of wsList) {
    const lp = ws.layout?.panels;
    if (lp && typeof lp === "object") n += Object.keys(lp).length;
  }
  return n;
}

/** Wait until the v3 blob satisfies `accept` AND has been byte-stable for
 * ≥700ms (the folded-restore quiescence discipline — a pending debounced
 * save firing after a plant would clobber the plant). */
async function waitForStableBlob(
  page: Page,
  accept: (parsed: unknown) => boolean,
  what: string,
  timeoutMs = 12000,
): Promise<void> {
  const STABLE_MS = 700;
  const deadline = Date.now() + timeoutMs;
  let stableRaw: string | null = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const raw = await page.evaluate(
      ({ key }) => localStorage.getItem(key),
      { key: LAYOUT_STORAGE_KEY },
    );
    let ok = false;
    if (raw !== null) {
      try {
        ok = accept(JSON.parse(raw));
      } catch {
        ok = false;
      }
    }
    if (ok && raw === stableRaw) {
      if (Date.now() - stableSince >= STABLE_MS) return;
    } else if (ok) {
      stableRaw = raw;
      stableSince = Date.now();
    } else {
      stableRaw = null;
    }
    await page.waitForTimeout(80);
  }
  throw new Error(`${what} never appeared stably in ${LAYOUT_STORAGE_KEY} within ${timeoutMs}ms`);
}

/** Plant a 2-pane v3 blob (both panes at origin + /app) — the folded-restore
 * planted-blob shape, local copy. MUST run while the page is ON the origin
 * (localStorage is unreachable on about:blank). */
async function plantTwoPanes(page: Page): Promise<void> {
  await page.evaluate(({ key }) => {
    const origin = window.location.origin;
    const blob = {
      v: 3,
      activeWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          layout: {
            grid: {
              root: {
                type: "branch",
                data: [
                  {
                    type: "leaf",
                    fraction: 0.5,
                    data: { id: "g-1", views: ["pane-1"], activeView: "pane-1" },
                  },
                  {
                    type: "leaf",
                    fraction: 0.5,
                    data: { id: "g-2", views: ["pane-2"], activeView: "pane-2" },
                  },
                ],
                width: 1024,
                height: 768,
                orientation: "HORIZONTAL",
              },
              width: 1024,
              height: 768,
              orientation: "HORIZONTAL",
            } as unknown,
            panels: {
              "pane-1": {
                id: "pane-1",
                params: { url: `${origin}/app`, label: "this-server" },
              },
              "pane-2": {
                id: "pane-2",
                params: { url: `${origin}/app`, label: "this-server" },
              },
            } as unknown,
            activeGroup: "g-1",
          } as unknown,
        },
      ],
    };
    localStorage.setItem(key, JSON.stringify(blob));
    history.replaceState(null, "", window.location.pathname);
  }, { key: LAYOUT_STORAGE_KEY });
}

/** The `/app` pane frames currently in the page (same-origin → evaluable). */
function appFrames(page: Page) {
  return page.frames().filter((f) => f.url().startsWith(`${originOf(page)}/app`));
}

/** Controller scriptURL inside a frame (null when un-controlled / loading). */
async function frameController(page: Page, index: number): Promise<string | null> {
  const frames = appFrames(page);
  const f = frames[index];
  if (!f) return null;
  try {
    return await f.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
  } catch {
    return null; // mid-navigation context — caller polls
  }
}

test.describe.serial("folded narrow-scope SW (S3b levers A+B)", () => {
  test("CRUX born-controlled: cold panes boot SW-controlled on the real folded topology (A-F1)", async ({ page }) => {
    // Collect EVERY /app navigation response from the very first request —
    // BOTH loads (cold first boot + planted relaunch) count.
    const appResponses: { url: string; stamped: boolean }[] = [];
    page.on("response", (res) => {
      const u = res.url();
      if (u.endsWith("/app") || u.includes("/app?")) {
        res
          .allHeaders()
          .then((h) => appResponses.push({ url: u, stamped: h["x-vh-sw-at"] !== undefined }))
          .catch(() => appResponses.push({ url: u, stamped: false }));
      }
    });

    // Load 1 — the COLD boot (fresh context: no SW, no caches). The self-seed
    // pane's gated src assignment races the brand-new registration — the
    // lever-A+B interaction under test.
    await page.goto("/");
    await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();
    const origin = originOf(page);
    await expect
      .poll(async () => (await iframeSrcs(page)).length, { timeout: 20000 })
      .toBeGreaterThanOrEqual(1);
    await waitForStableBlob(page, (p) => totalPanels(p) === 1, "self-seed layout (1 panel)");

    // Plant the 2-pane blob (on-origin — localStorage), then relaunch.
    await plantTwoPanes(page);
    await page.goto("/");

    // Both planted panes restore with ASSIGNED srcs (layout restore itself
    // is NOT gated on the SW — only the src assignment moment is).
    await expect
      .poll(async () => (await iframeSrcs(page)).length, { timeout: 20000 })
      .toBe(2);
    const srcs = await iframeSrcs(page);
    expect(srcs.every((s) => s.startsWith(`${origin}/app`))).toBe(true);

    // Lever A: the narrow registration exists and is ACTIVE (observed from
    // the HOST document — explicit-URL getRegistration works out-of-scope,
    // S3a X4). Scope is exactly /app (no trailing slash — it must cover the
    // pane document URL /app).
    const narrow = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration("/app");
      return reg ? { scope: reg.scope, active: !!reg.active } : null;
    });
    expect(narrow, "narrow registration present + active").toEqual({
      scope: `${origin}/app`,
      active: true,
    });

    // CRUX (A-F1): the panes' BIRTH NAVIGATIONS were served by the SW — every
    // observed /app document response carries the SW's stamp header. A pane
    // that booted before activation (or un-gated) would fetch the shell from
    // the network: no such header exists on the Go-served shell. ≥3 = the
    // cold self-seed pane + both planted panes.
    await expect
      .poll(async () => appResponses.length, { timeout: 10000 })
      .toBeGreaterThanOrEqual(3);
    for (const r of appResponses) {
      expect(
        r.stamped,
        `pane shell ${r.url} must be SW-served (x-vh-sw-at present) — born-controlled violated`,
      ).toBe(true);
    }

    // Belt: the pane DOCUMENTS themselves report the narrow controller.
    await expect.poll(async () => await frameController(page, 0), { timeout: 10000 }).toContain("/sw.js");
    await expect.poll(async () => await frameController(page, 1), { timeout: 10000 }).toContain("/sw.js");
  });

  test("guard-reloaded pane REMAINS controlled (Firefox fall-through regression class)", async ({ page }) => {
    // The SPA's deploy guard reloads controlled panes once per BUILD_ID
    // (pwa.ts). S3a X1 case-C: a worker whose fetch listener lets an
    // in-scope navigation fall through permanently drops the client's
    // coverage on Firefox (reload AND later same-frame re-src). sw.js's
    // narrow stray branch (respondWith for every in-scope navigation) must
    // keep the reloaded pane controlled.
    await page.goto("/");
    await expect
      .poll(async () => appFrames(page).length, { timeout: 20000 })
      .toBeGreaterThanOrEqual(1);
    await expect.poll(async () => await frameController(page, 0), { timeout: 10000 }).toContain("/sw.js");

    // Reload INSIDE the pane (same-frame reload — the quirk's worst case).
    await appFrames(page)[0].evaluate(() => {
      location.reload();
    });

    // After the reload the pane is still controlled by /sw.js. (A permanent
    // fall-through loss never re-acquires a controller — "eventually
    // controlled" still falsifies that class; X1 pinned the stricter
    // earliest-script timing on the fixture engines.)
    await expect
      .poll(
        async () => {
          const frames = appFrames(page);
          if (frames.length === 0) return "gone";
          try {
            return await frames[0].evaluate(
              () => navigator.serviceWorker.controller?.scriptURL ?? "uncontrolled",
            );
          } catch {
            return "loading";
          }
        },
        { timeout: 20000 },
      )
      .toContain("/sw.js");
  });

  test("out-of-scope host document reaches the narrow worker (VH_PING/pong — the focus-channel leg)", async ({ page }) => {
    // The host doc at `/` is OUTSIDE the narrow scope: matchAll can never see
    // it, so notification focus is host-mediated over a MessageChannel the
    // host establishes with reg.active.postMessage (swNarrow.ts). This test
    // proves that POSTMESSAGE LEG works on the real topology (the same
    // mechanism establishFocusChannel relies on). The notificationclick
    // gesture itself is not synthesizable headless (S3a X4 honesty limit) —
    // the click handler's ladder is pinned by web/tests/unit/
    // sw-notificationclick.test.ts + the mirror spec.
    await page.goto("/");
    // Wait for the narrow worker to be ACTIVE first (fresh context: the
    // registration may still be installing right after goto).
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration("/app");
          return !!reg?.active;
        }),
      )
      .toBe(true);
    const outcome = await page.evaluate(() => {
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 8000);
        const onMessage = (ev: MessageEvent) => {
          if (ev.data && ev.data.type === "vh-pong") {
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener("message", onMessage);
            resolve("pong");
          }
        };
        navigator.serviceWorker.addEventListener("message", onMessage);
        void navigator.serviceWorker.getRegistration("/app").then((reg) => {
          if (!reg || !reg.active) {
            clearTimeout(timer);
            resolve("no-active-narrow");
            return;
          }
          reg.active.postMessage({ type: "VH_PING" });
        });
      });
    });
    expect(outcome).toBe("pong");
  });

  test("fail-open: when SW registration cannot succeed, panes still boot", async ({ browser }) => {
    // Bounded fail-open is an S3b invariant: a registration failure must
    // NEVER break pane creation. page.route CANNOT model this (the SW script
    // fetch goes through the browser's registration pipeline, not the page's
    // network — verified empirically: the route abort never fired and the
    // registration succeeded). Playwright's serviceWorkers:"block" context
    // is the honest trigger: registrations genuinely fail, exactly like an
    // engine/origin without working SW support.
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    try {
      await page.goto("/");
      await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();
      await expect
        .poll(async () => (await iframeSrcs(page)).length, { timeout: 20000 })
        .toBeGreaterThanOrEqual(1);
      await waitForStableBlob(page, (p) => totalPanels(p) === 1, "self-seed layout (1 panel)");

      await plantTwoPanes(page);
      await page.goto("/");

      await expect
        .poll(async () => (await iframeSrcs(page)).length, { timeout: 20000 })
        .toBe(2);

      // The panes actually LOAD (src assignment was not stranded by the gate).
      await expect
        .poll(
          async () => {
            const frames = appFrames(page);
            if (frames.length < 2) return 0;
            let ready = 0;
            for (const f of frames) {
              try {
                const st = await f.evaluate(() => document.readyState);
                if (st === "complete" || st === "interactive") ready++;
              } catch {
                /* still navigating */
              }
            }
            return ready;
          },
          { timeout: 20000 },
        )
        .toBe(2);

      // And no narrow registration exists (the failure is real, not a race).
      const reg = await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration("/app");
        return r ? r.scope : null;
      });
      expect(reg).toBeNull();
    } finally {
      await context.close();
    }
  });
});
