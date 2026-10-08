// S2 pin D-F4 — SW-served entries work on second load (real browser).
//
// S1 ships Content-Encoding:gzip variants of static assets; the SW then
// caches them. This spec pins the SECOND-LOAD contract in a real Chromium:
// after the SW has cached the shell + hashed bundle, a reload is served by
// the SW (fromServiceWorker on the hashed JS response) and the app still
// boots (decode/exec fine), and offline the cached shell+assets still boot
// the SPA. It also pins the reconstruct-safety invariant the SW relies on
// when it rebuilds cached responses: cached SHELL and BOOT-DATA entries must
// carry NO Content-Encoding (the SW buffers the decoded body and must never
// re-attach the wire compression header to plain bytes) and must carry the
// TTL stamp header.
//
// Runs on /app (NOT `/`): the SW never intercepts `/`, and in this fixture
// world `/` is the SPA anyway (hostShellAtRoot=false) — /app is the
// production-fold pane-doc path, which is exactly the posture under test.

import { expect, test } from "@playwright/test";
import { demoDir } from "./util";

const appUrl = () => `/app?dir=${encodeURIComponent(demoDir)}`;

// Prime the SW deterministically: the page's own boot fetches usually race
// SW registration (they fire before clients.claim() lands), so we do not
// rely on them. After the SW is ready and controls the page, DRIVE the
// intercepted paths explicitly — one hashed bundle fetch (asset class) and
// one /oc/provider fetch (boot-data class) — then wait for the entries.
// This makes the cached state a property of the SW policy, not of boot
// timing.
async function primeAndInspect(page: import("@playwright/test").Page) {
  await page.goto(appUrl());
  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) throw new Error("no serviceWorker API");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      });
    }
  });
  return page.waitForFunction(
    async () => {
      // Pick the hashed bundle this page actually loaded (its own script).
      const js = performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .find((u) => u.includes("/assets/") && u.endsWith(".js"));
      if (!js) return "";
      // Both fetches go through the SW now that it controls the page: the
      // asset lands in the cache (cache-first miss), the provider too
      // (boot-data miss → stamped put under its PROJECT-PARTITIONED key —
      // the SPA's fetch wrapper adds x-opencode-directory, see
      // sw-bootdata-project-scope.spec.ts). Plain fetches (default cache
      // mode): no-store would bypass the boot-data put by design.
      await fetch(js);
      await fetch("/oc/provider");
      const keys = await caches.keys();
      for (const k of keys) {
        const c = await caches.open(k);
        const reqs = await c.keys();
        const has = (pred: (u: URL) => boolean) => reqs.some((r) => pred(new URL(r.url)));
        if (
          has((u) => u.pathname.startsWith("/assets/") && u.pathname.endsWith(".js")) &&
          has((u) => u.pathname === "/oc/provider") &&
          has((u) => u.pathname === "/index.html")
        ) {
          return k;
        }
      }
      return "";
    },
    undefined,
    { timeout: 20000 },
  );
}

test("D-F4: second load serves the hashed bundle via the SW and still boots", async ({ page }) => {
  const cacheName = await primeAndInspect(page);

  // Reconstruct-safety pin on the CACHED entries the SW rebuilt itself
  // (shell + boot data): no Content-Encoding on the stored bytes, TTL stamp
  // present. (Hashed assets keep their pass-through stored form.) Reads scan
  // cache KEYS by pathname — the boot-data entry lives under its
  // project-partitioned URL (?vhsw=…), so a bare-URL match() would miss it.
  const entryHeaders = await page.evaluate(async (name: string) => {
    const c = await caches.open(name);
    const readPath = async (pathname: string) => {
      for (const req of await c.keys()) {
        if (new URL(req.url).pathname === pathname) {
          const r = await c.match(req);
          if (!r) return null;
          return { ce: r.headers.get("Content-Encoding"), stamp: r.headers.get("x-vh-sw-at") };
        }
      }
      return null;
    };
    return {
      shell: await readPath("/index.html"),
      provider: await readPath("/oc/provider"),
    };
  }, cacheName);
  expect(entryHeaders.shell, "cached shell entry exists").not.toBeNull();
  expect(entryHeaders.shell!.ce, "cached shell must NOT carry Content-Encoding (decoded bytes)").toBe(null);
  expect(entryHeaders.shell!.stamp, "cached shell carries the TTL stamp").toBeTruthy();
  expect(entryHeaders.provider, "cached /oc/provider entry exists").not.toBeNull();
  expect(entryHeaders.provider!.ce, "cached boot data must NOT carry Content-Encoding").toBe(null);
  expect(entryHeaders.provider!.stamp, "cached boot data carries the TTL stamp").toBeTruthy();

  // Reload under CDP capture: the hashed JS response must come from the
  // service worker, and the app must fully boot on the SW-served bundle.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  let sawHashedJs = false;
  const servedBySw: string[] = [];
  cdp.on("Network.responseReceived", (ev) => {
    const r = ev.response as { url: string; fromServiceWorker?: boolean };
    if (r.url.includes("/assets/") && r.url.endsWith(".js")) {
      sawHashedJs = true;
      if (r.fromServiceWorker) servedBySw.push(r.url);
    }
  });
  await page.reload();
  await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible({ timeout: 20000 });
  expect(sawHashedJs, "a hashed JS response was observed over CDP").toBe(true);
  expect(servedBySw.length, "hashed JS served by the SW on second load").toBeGreaterThan(0);
});

test("D-F4: offline, the cached shell + assets still boot the SPA", async ({ page }) => {
  await primeAndInspect(page);
  await page.context().setOffline(true);
  try {
    // Navigation + assets + enumerated boot data all come from the SW cache;
    // only live streams (/vh/*, never cached) fail — the shell must still
    // mount the SPA.
    await page.goto(appUrl());
    await expect(
      page.locator("#root"),
      "SPA shell mounts offline from the SW cache",
    ).not.toBeEmpty({ timeout: 10000 });
  } finally {
    await page.context().setOffline(false);
  }
});
