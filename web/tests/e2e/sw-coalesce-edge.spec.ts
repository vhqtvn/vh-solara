// S2b carried pins — worker-edge e2e for the S2 SW policies that previously
// had only unit-level coverage (committer-gate defers F5/F9 + worker-defer
// tier1_a-R2F2):
//
//   F5  in-flight coalescing: N concurrent identical GETs → ONE network fetch
//       observable at the worker edge;
//   F9  forced failure: the shared upstream failure rejects EVERY waiter and
//       NOTHING is cached; a post-failure retry starts fresh;
//   R2F2 request.cache bypass: "no-store"/"reload" requests always hit the
//       network (no TTL-fresh serve), "no-store" additionally skips the put.
//
// Observation channel: the SW's own network fetches are recorded in the SW's
// OWN performance timeline (invisible to the page's CDP session), reachable
// via context.serviceWorkers()[0].evaluate(). A unique ?probe= query per case
// gives each case a distinct cache/coalesce key (the key is the FULL URL —
// the pathname enumeration is unchanged, so /oc/agent?probe=X still takes the
// boot-data path).

import { expect, test, type Page } from "@playwright/test";
import { demoDir } from "./util";

const appUrl = () => `/app?dir=${encodeURIComponent(demoDir)}`;

// Count the SW's own network fetches whose URL contains `fragment`.
async function swNetworkHits(context: import("@playwright/test").BrowserContext, fragment: string) {
  const sws = context.serviceWorkers();
  if (!sws.length) return 0;
  return sws[0].evaluate((frag) => {
    return (performance as unknown as { getEntriesByType: (t: string) => PerformanceEntry[] })
      .getEntriesByType("resource")
      .filter((e) => e.name.includes(frag)).length;
  }, fragment);
}

// Do any cache entries exist whose URL contains `fragment`?
async function cacheHasEntry(page: Page, fragment: string) {
  return page.evaluate(async (frag) => {
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      for (const req of await c.keys()) {
        if (req.url.includes(frag)) return true;
      }
    }
    return false;
  }, fragment);
}

async function boot(page: Page) {
  await page.goto(appUrl());
  await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => {
    const sw = navigator.serviceWorker;
    return sw.controller !== null && sw.controller.state === "activated";
  });
}

test("F5: three concurrent identical GETs share ONE network fetch at the worker edge", async ({ page, context }) => {
  await boot(page);
  const nonce = "s2b-f5-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const url = "/oc/agent?probe=" + nonce;

  const stamps = await page.evaluate(async (u) => {
    // Three waiters issued in the SAME task — all arrive at the SW while the
    // first network fetch is still in flight (the coalescing window).
    const rs = await Promise.all([fetch(u), fetch(u), fetch(u)]);
    const out = [];
    for (const r of rs) {
      out.push({ status: r.status, stamp: r.headers.get("x-vh-sw-at"), body: await r.text() });
    }
    return out;
  }, url);

  // Every waiter got a full, independent Response (bodies readable — a shared
  // single-use body would throw on the second read) with the SAME network
  // stamp (one shared upstream response).
  expect(stamps).toHaveLength(3);
  for (const s of stamps) {
    expect(s.status).toBe(200);
    expect(s.stamp, "SW-served (TTL stamp present)").toBeTruthy();
    expect(s.body.length).toBeGreaterThan(0);
  }
  expect(new Set(stamps.map((s) => s.stamp)).size, "all waiters share ONE upstream response").toBe(1);

  // THE pin: exactly one SW network fetch for the three concurrent waiters.
  expect(await swNetworkHits(context, "probe=" + nonce), "coalesced to one worker-edge fetch").toBe(1);

  // A SEQUENTIAL follow-up inside the fresh window serves from the cache —
  // no new network fetch, byte-identical stamp.
  const again = await page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, stamp: r.headers.get("x-vh-sw-at"), body: await r.text() };
  }, url);
  expect(again.status).toBe(200);
  expect(again.stamp).toBe(stamps[0].stamp);
  expect(again.body).toBe(stamps[0].body);
  expect(await swNetworkHits(context, "probe=" + nonce), "fresh-window follow-up added no network fetch").toBe(1);
});

test("F9: forced upstream failure rejects all waiters, caches nothing, retries fresh", async ({ page, context }) => {
  await boot(page);
  const nonce = "s2b-f9-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const url = "/oc/agent?probe=" + nonce;

  // Force the upstream failure the only way available without touching the
  // fixture: take the context offline (Playwright's network emulation reaches
  // the SW's own fetches — the SW's coalesced network fetch fails).
  await context.setOffline(true);
  const results = await page.evaluate(async (u) => {
    const one = async () => {
      try {
        const r = await fetch(u);
        await r.blob();
        return "ok:" + r.status;
      } catch (e) {
        return "reject:" + (e instanceof TypeError ? "TypeError" : String(e));
      }
    };
    return Promise.all([one(), one(), one()]);
  }, url);
  await context.setOffline(false);

  // Every waiter rejects (the shared failure propagates) — none is served a
  // cached or partial response.
  for (const r of results) {
    expect(r.startsWith("reject:"), `waiter outcome was ${r}`).toBe(true);
  }

  // NOTHING was cached for the failed key (the failure path never puts).
  expect(await cacheHasEntry(page, "probe=" + nonce), "failed fetch cached nothing").toBe(false);

  // Back online, the SAME URL succeeds — the post-failure retry started
  // fresh (the coalescer entry was dropped when the shared promise settled).
  // (A failed fetch also records a SW-scope resource entry, so re-baseline
  // here and pin the DELTA: exactly one new network fetch for the retry.)
  const hitsBeforeRetry = await swNetworkHits(context, "probe=" + nonce);
  const retry = await page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, stamp: r.headers.get("x-vh-sw-at") };
  }, url);
  expect(retry.status).toBe(200);
  expect(retry.stamp).toBeTruthy();
  expect(await cacheHasEntry(page, "probe=" + nonce), "the successful retry populated the cache").toBe(true);
  expect(
    await swNetworkHits(context, "probe=" + nonce),
    "the retry added exactly one network fetch",
  ).toBe(hitsBeforeRetry + 1);
});

test("R2F2: no-store/reload requests bypass the TTL serve (no-store also skips the put)", async ({ page, context }) => {
  await boot(page);
  const nonce = "s2b-r2f2-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const url = "/oc/agent?probe=" + nonce;

  // (1) cache:"no-store" → network (SW fetch), response 200, NOTHING cached.
  const noStore = await page.evaluate(async (u) => {
    const r = await fetch(u, { cache: "no-store" });
    return { status: r.status, stamp: r.headers.get("x-vh-sw-at") };
  }, url);
  expect(noStore.status).toBe(200);
  expect(await swNetworkHits(context, "probe=" + nonce), "no-store went to the network").toBe(1);
  expect(await cacheHasEntry(page, "probe=" + nonce), "no-store skipped the put").toBe(false);

  // (2) cache:"reload" → network again (bypass), and this one DOES populate
  // the cache (reload may put — mirrors bootPutEligible).
  const reload = await page.evaluate(async (u) => {
    const r = await fetch(u, { cache: "reload" });
    return { status: r.status, stamp: r.headers.get("x-vh-sw-at") };
  }, url);
  expect(reload.status).toBe(200);
  expect(reload.stamp).toBeTruthy();
  expect(await swNetworkHits(context, "probe=" + nonce), "reload went to the network too").toBe(2);
  expect(await cacheHasEntry(page, "probe=" + nonce), "reload populated the cache").toBe(true);

  // (3) a plain fetch NOW serves from the fresh cache — zero new network.
  const plain = await page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, stamp: r.headers.get("x-vh-sw-at") };
  }, url);
  expect(plain.status).toBe(200);
  expect(plain.stamp).toBe(reload.stamp);
  expect(await swNetworkHits(context, "probe=" + nonce), "plain fetch served fresh from the cache").toBe(2);
});
