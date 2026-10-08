// S2b early-SW-registration pin — registration timing + reload-storm absence
// + cold-boot SW coverage, in a real browser (lane 6).
//
// The change under test: pwa.ts registers the service worker at MODULE-EVAL
// time instead of window `load`, so claim() lands early enough that the later
// panes' doc/boot fetches are intercepted on a cold boot. The feared failure
// mode was a reload storm: at cold boot there is no controller, and the first
// activation fires `controllerchange` — the pwa.ts guard must treat that as a
// no-op (it captures hadController BEFORE register() and only reloads when a
// PREVIOUS controller existed).
//
// Pinned here, per fresh context (= a genuine cold boot: Playwright contexts
// start with no SW registration):
//   1. register() is CALLED at module eval — strictly before the window load
//      event (regAt < loadAt). If someone reintroduces window-load
//      registration, this fails.
//   2. The first activation fires controllerchange DURING boot (claim works)
//      and the page does NOT reload: zero main-frame navigations after the
//      initial goto, and an in-page token planted post-load survives.
//   3. Cold-boot SW coverage: a fetch issued after claim is served BY the SW
//      (the x-vh-sw-at stamp header only exists on SW-reconstructed
//      responses), and the activate-time shell precache lands in the cache —
//      that entry is what later pane docs serve from within the 30s TTL.
//   4. F10: page.reload() (request.cache "reload") bypasses the TTL-fresh
//      shell serve — the SW fetches the shell from the NETWORK again (a new
//      SW-scope /index.html resource entry appears) and the app still boots.
//      Pre-F10, a reload inside the 30s TTL served the cached shell.
//
// SW-scope observability: the SW's own network fetches are invisible to the
// page's CDP session, but they ARE recorded in the SW's own performance
// timeline, reachable via context.serviceWorkers()[0].evaluate() — the
// worker-edge observation channel this spec uses (same channel as
// sw-coalesce-edge.spec.ts).

import { expect, test } from "@playwright/test";
import { demoDir } from "./util";

const appUrl = () => `/app?dir=${encodeURIComponent(demoDir)}`;

// Stamp boot-relative timings from an init script (runs before any page
// script, so the load listener and the register() wrapper are in place before
// the app's own module evaluates).
const BOOT_TIMINGS_INIT = `
(() => {
  window.__vhS2bBoot = { regAt: null, controllerAt: null, loadAt: null };
  const W = window.__vhS2bBoot;
  const sw = navigator.serviceWorker;
  const orig = sw.register.bind(sw);
  sw.register = function (...args) {
    W.regAt = performance.now();
    return orig.apply(this, args);
  };
  sw.addEventListener("controllerchange", () => {
    W.controllerAt = performance.now();
  });
  window.addEventListener("load", () => {
    W.loadAt = performance.now();
  });
})();
`;

async function waitControlled(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => {
    const sw = navigator.serviceWorker;
    return sw.controller !== null && sw.controller.state === "activated";
  });
}

test("cold boot: SW registers at module eval, claims mid-boot, never reloads", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(BOOT_TIMINGS_INIT);
  await page.goto(appUrl());
  await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible({ timeout: 20000 });
  await waitControlled(page);
  // load fires after module eval by construction; wait for it explicitly so
  // the regAt < loadAt comparison below never races an unfired load event.
  await page.waitForFunction(() => document.readyState === "complete");

  // (1) Registration happened at module eval, not window load.
  const t = await page.evaluate(() => (window as { __vhS2bBoot?: Record<string, number | null> }).__vhS2bBoot);
  expect(t?.regAt, "register() must have been called").not.toBeNull();
  expect(t?.loadAt, "window load must have fired").not.toBeNull();
  expect(t!.regAt!, "register() called BEFORE window load (module-eval timing)").toBeLessThan(t!.loadAt!);

  // (2) The first activation claimed this page during boot (controllerchange
  // fired) — and that must NOT have reloaded it: the reload-storm pin.
  expect(t?.controllerAt, "claim() fired controllerchange during cold boot").not.toBeNull();
  const token = await page.evaluate(() => {
    (window as { __vhBootToken?: number }).__vhBootToken = Math.random();
    return (window as { __vhBootToken: number }).__vhBootToken;
  });
  let navs = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navs++;
  });
  // Any storm reload would fire within a boot settle window of the claim.
  await page.waitForTimeout(1500);
  expect(navs, "no main-frame navigation/reload after cold-boot claim").toBe(0);
  expect(
    await page.evaluate(() => (window as { __vhBootToken?: number }).__vhBootToken),
    "the post-load token survived (same document, no reload)",
  ).toBe(token);

  // (3) Cold-boot coverage: a post-claim fetch of an enumerated /oc/* path is
  // served BY the SW — x-vh-sw-at is only attached to SW-reconstructed
  // responses, never to a pass-through network response.
  const stamp = await page.evaluate(async () => {
    const r = await fetch("/oc/config");
    const h = r.headers.get("x-vh-sw-at");
    await r.blob();
    return h;
  });
  expect(stamp, "post-claim boot-data fetch is SW-served (TTL stamp present)").toBeTruthy();

  // And the activate-time shell precache landed — the entry later pane docs
  // (and warm reloads) serve from within the 30s TTL. waitForFunction throws
  // on timeout, so reaching past it IS the assertion.
  await page.waitForFunction(async () => {
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      for (const req of await c.keys()) {
        if (new URL(req.url).pathname === "/index.html") return true;
      }
    }
    return false;
  }, undefined, { timeout: 15_000 });
});

test("two concurrent cold panes: one SW claims both, neither reloads", async ({ context }) => {
  test.setTimeout(60_000);
  // The lane-6 approximation of the folded multi-pane posture: two same-origin
  // documents booting concurrently in one context, both uncontrolled at
  // creation (fresh context → no registration), both registering the SW.
  const p1 = await context.newPage();
  const p2 = await context.newPage();
  await p1.addInitScript(BOOT_TIMINGS_INIT);
  await p2.addInitScript(BOOT_TIMINGS_INIT);
  await Promise.all([p1.goto(appUrl()), p2.goto(appUrl())]);
  await expect(p1.getByRole("button", { name: /Demo session/ })).toBeVisible({ timeout: 20000 });
  await expect(p2.getByRole("button", { name: /Demo session/ })).toBeVisible({ timeout: 20000 });
  await waitControlled(p1);
  await waitControlled(p2);

  // Exactly ONE registration exists (register() is idempotent per scope).
  const regs = await p1.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  expect(regs, "both panes' registrations collapsed into one").toBe(1);

  // Both panes got the claim — and neither reloaded (the multi-pane storm
  // shape: every claimed pane's guard sees hadController=false at cold boot).
  for (const p of [p1, p2]) {
    const stamps = await p.evaluate(() => (window as { __vhS2bBoot?: Record<string, number | null> }).__vhS2bBoot);
    expect(stamps?.controllerAt, "this pane was claimed").not.toBeNull();
    expect(stamps?.regAt, "register() called BEFORE window load (module-eval timing)").not.toBeNull();
    expect(stamps?.loadAt).not.toBeNull();
    expect(stamps!.regAt!, "module-eval registration").toBeLessThan(stamps!.loadAt!);
  }
  const tokens = await Promise.all(
    [p1, p2].map((p) => p.evaluate(() => ((window as { __vhPaneToken?: number }).__vhPaneToken = Math.random()))),
  );
  const navCount = (p: import("@playwright/test").Page) => {
    let n = 0;
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) n++;
    });
    return () => n;
  };
  const n1 = navCount(p1);
  const n2 = navCount(p2);
  await p1.waitForTimeout(1500);
  expect(n1(), "pane 1 did not reload").toBe(0);
  expect(n2(), "pane 2 did not reload").toBe(0);
  const after = await Promise.all(
    [p1, p2].map((p) => p.evaluate(() => (window as { __vhPaneToken?: number }).__vhPaneToken)),
  );
  expect(after[0]).toBe(tokens[0]);
  expect(after[1]).toBe(tokens[1]);
});

test("F10: page.reload() bypasses the TTL-fresh shell serve and still boots", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(appUrl());
  await waitControlled(page);
  // Wait for the activate-time shell precache, then read its TTL stamp.
  await page.waitForFunction(async () => {
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      for (const req of await c.keys()) {
        if (new URL(req.url).pathname === "/index.html") return true;
      }
    }
    return false;
  }, undefined, { timeout: 15_000 });
  const shellStamp = async () =>
    page.evaluate(async () => {
      for (const k of await caches.keys()) {
        const c = await caches.open(k);
        for (const req of await c.keys()) {
          if (new URL(req.url).pathname === "/index.html") {
            const r = await c.match(req);
            return r ? r.headers.get("x-vh-sw-at") : null;
          }
        }
      }
      return null;
    });
  const before = await shellStamp();
  expect(before, "cached shell entry exists with a TTL stamp").toBeTruthy();
  // Let the ms-precision stamp clock move well past `before` so a rewrite is
  // unambiguous.
  await page.waitForTimeout(50);

  // reload() navigates with request.cache "reload" → the SW must NOT serve
  // the TTL-fresh cached shell: it goes to the network and REWRITES the
  // cached entry (a fresh-cache serve never rewrites the stamp — that is the
  // pre-F10 behavior this pins away). (The SW's post-bypass network fetch can
  // be satisfied by the browser HTTP cache on localhost, so SW-scope fetch
  // counting is not a reliable signal here; the stamp rewrite is.)
  await page.reload();
  await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible({ timeout: 20000 });
  const after = await shellStamp();
  expect(after, "shell entry still cached after the reload").toBeTruthy();
  expect(Number(after!), "the reload REWROTE the shell entry (network bypass, not a TTL serve)").toBeGreaterThan(
    Number(before!),
  );
});
