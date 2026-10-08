// S2 multi-pane dedupe pin — real-browser evidence that the SW's shell TTL +
// boot-data caching remove the per-pane duplication on pane boots.
//
// The coalescing COUNT (identical in-flight GETs sharing one network fetch)
// is NOT observable from the page/CDP (the SW's own network fetches emit no
// page-session records) — that number is pinned by the perf harness
// (tmp/agent-runs/page-load-perf, worker-edge request stats). What IS
// observable per page, and pinned here:
//   - the pane DOCUMENT (navigation entry) has transferSize 0 — the shell
//     TTL served it from the SW cache with zero wire bytes (warm pane-boot
//     stride removal);
//   - every /oc/provider resource entry has transferSize 0 — boot data
//     served from the SW cache, not re-fetched per pane;
//   - both panes still render the real fixture session (cached boot data is
//     usable data, not a broken variant);
//   - the SW cache holds NO /vh/* entries (live API stays un-intercepted).
//
// Runs on /app — see sw-gzip-secondload.spec.ts for the route rationale.

import { expect, test } from "@playwright/test";
import { demoDir } from "./util";

const appUrl = () => `/app?dir=${encodeURIComponent(demoDir)}`;

test("two concurrent panes boot with zero-wire docs and providers from the SW cache", async ({
  context,
  page,
}) => {
  // Prime: one full boot so the SW controls the origin, then DRIVE the
  // intercepted paths explicitly (the pane's own boot fetches race SW
  // registration; explicit fetches after control are deterministic): the
  // shell entry (activate precache), a hashed bundle (asset class), and
  // /oc/provider (boot-data class) all land in the cache.
  await page.goto(appUrl());
  await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible({ timeout: 20000 });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const js = performance
      .getEntriesByType("resource")
      .map((r) => r.name)
      .find((u) => u.includes("/assets/") && u.endsWith(".js"));
    // Plain (default cache-mode) fetches: a no-store boot-data fetch would
    // bypass the cache put by design (the request.cache opt-out).
    if (js) await fetch(js);
    await fetch("/oc/provider");
  });

  // Two NEW panes load concurrently (the multi-pane boot posture).
  const p2 = await context.newPage();
  const p3 = await context.newPage();
  await Promise.all([p2.goto(appUrl()), p3.goto(appUrl())]);

  // Both panes boot the real app from the SW-served shell + boot data.
  await expect(p2.getByRole("button", { name: /Demo session/ })).toBeVisible({ timeout: 20000 });
  await expect(p3.getByRole("button", { name: /Demo session/ })).toBeVisible({ timeout: 20000 });

  for (const p of [p2, p3]) {
    const wire = await p.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const providers = performance
        .getEntriesByType("resource")
        .filter((r) => r.name.endsWith("/oc/provider")) as PerformanceResourceTiming[];
      return {
        docTransfer: nav ? nav.transferSize : -1,
        providers: providers.map((r) => r.transferSize),
      };
    });
    // Pane doc served by the SW (shell TTL hit) — zero wire bytes.
    expect(wire.docTransfer, "pane document came from the SW cache, not the wire").toBe(0);
    // Boot data served by the SW cache — zero wire bytes per pane.
    expect(wire.providers.length, "the pane fetched /oc/provider").toBeGreaterThan(0);
    expect(
      wire.providers.every((t) => t === 0),
      "every /oc/provider fetch was SW-served (transferSize 0)",
    ).toBe(true);
  }

  // The live API is never cached: no /vh/* entries may exist in any SW cache.
  const vhEntries = await page.evaluate(async () => {
    const out: string[] = [];
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      for (const r of await c.keys()) {
        if (new URL(r.url).pathname.startsWith("/vh/")) out.push(r.url);
      }
    }
    return out;
  });
  expect(vhEntries, "no /vh/* URL may ever be SW-cached").toEqual([]);
});
