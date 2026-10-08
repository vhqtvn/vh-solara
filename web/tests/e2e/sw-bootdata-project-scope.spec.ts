// S2 boot-data project scoping — regression pin for the review F1 fix.
//
// The enumerated /oc/* boot-data GETs are PROJECT-SCOPED: the SPA stamps
// x-opencode-directory on every fetch (web/src/csrf.ts decorate) and the
// server scopes the /oc passthrough by that header (pkg/web reqDir), with the
// SPA re-firing the SAME URLs on project switch (web/src/index.tsx). The SW's
// boot-data cache key therefore partitions by that header (sw.js bootCacheKey
// ⇄ swPolicy.bootCacheKey) — keying by URL alone would serve project A's
// cached payload to project B within the TTL.
//
// Pinning strategy (payload- and wire-independent): XHR (NOT fetch —
// installCsrf wraps window.fetch and would clobber the explicit header)
// against the enumerated /oc/agent URL with a controlled dir header, then
// observe the CACHE entries' TTL stamps. A network fetch (re)writes the entry
// with a fresh x-vh-sw-at stamp; a fresh-hit serve NEVER rewrites it — and a
// request wrongly served from another project's entry creates NO entry of its
// own. (Resource-timing transferSize cannot be used here: Chrome reports 0
// for EVERY service-worker-delivered response, whether the SW hit its cache
// or fetched the network itself.)
//   A#1 miss       → ?vhsw=A entry created
//   A#2 fresh hit  → A's stamp UNCHANGED (no network, no rewrite)
//   B#1 NEW KEY    → ?vhsw=B entry created — the regression pin: with a
//                    URL-only key B would be served A's fresh entry and NO B
//                    entry would ever exist
//   B#2 fresh hit  → B's stamp UNCHANGED

import { expect, test } from "@playwright/test";
import { demoDir } from "./util";

const appUrl = () => "/app?dir=" + encodeURIComponent(demoDir);
// Neither scope dir is the SPA's boot project: the app's own boot fetches
// (dir = demoDir) fill the vhsw=demoDir partition, which must not interact
// with these — A#1 has to be a genuine cold miss for ITS partition.
const DIR_A = "/tmp/vhsw-scope-a";
const DIR_B = "/tmp/vhsw-scope-b";

// getWithDir issues an XHR to path with the given x-opencode-directory.
// XHR is deliberate: installCsrf only wraps window.fetch, so an explicit
// header survives verbatim (decorate would clobber it on fetch).
async function getWithDir(page: import("@playwright/test").Page, path: string, dir: string) {
  return page.evaluate(
    ({ p, d }) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open("GET", p);
        x.setRequestHeader("x-opencode-directory", d);
        x.onload = () => resolve({ status: x.status, body: x.responseText });
        x.onerror = () => reject(new Error(`XHR ${p} dir=${d} failed`));
        x.send();
      }),
    { p: path, d: dir },
  );
}

// stampOf reads the current x-vh-sw-at stamp of the /oc/agent entry stored
// under the given dir partition (null when absent).
async function stampOf(page: import("@playwright/test").Page, dir: string) {
  return page.evaluate(
    async ({ d }) => {
      const agent = new URL("/oc/agent", location.href).href;
      const suffix = "?vhsw=" + encodeURIComponent(d);
      for (const name of await caches.keys()) {
        const c = await caches.open(name);
        for (const req of await c.keys()) {
          if (req.url === agent + suffix) {
            const r = await c.match(req);
            return r ? r.headers.get("x-vh-sw-at") : null;
          }
        }
      }
      return null;
    },
    { d: dir },
  );
}

test("boot-data cache is project-scoped: another project's dir never serves the first project's entry", async ({ page }) => {
  await page.goto(appUrl());
  // The SW must CONTROL this page before the XHRs below are intercepted.
  await page.waitForFunction(() => {
    const sw = navigator.serviceWorker;
    return sw.controller !== null && sw.controller.state === "activated";
  });

  // A#1: miss → network → ?vhsw=A entry created (the fake opencode answers
  // 200 for any dir; payload content is irrelevant to the pin).
  const a1 = await getWithDir(page, "/oc/agent", DIR_A);
  expect(a1.status).toBe(200);
  const aStamp1 = await stampOf(page, DIR_A);
  expect(aStamp1, "A#1 must create the vhsw=A cache entry (network miss)").not.toBeNull();

  // A#2: same project, well inside the 20s fresh window → served from the
  // cache WITHOUT a rewrite (stamp byte-identical).
  const a2 = await getWithDir(page, "/oc/agent", DIR_A);
  expect(a2.status).toBe(200);
  expect(a2.body).toBe(a1.body);
  expect(await stampOf(page, DIR_A), "A#2 must be a fresh-hit serve (stamp unchanged)").toBe(aStamp1);

  // B#1: DIFFERENT project → a fresh network fetch under B's OWN partition.
  // This is the regression assertion: with a URL-only key, B would be served
  // A's fresh entry (zero network, zero new entry) — the F1 bug.
  const b1 = await getWithDir(page, "/oc/agent", DIR_B);
  expect(b1.status).toBe(200);
  const bStamp1 = await stampOf(page, DIR_B);
  expect(bStamp1, "B#1 must create the vhsw=B entry (different project = network miss)").not.toBeNull();

  // B#2: B now has its own fresh entry → fresh-hit serve, stamp unchanged.
  const b2 = await getWithDir(page, "/oc/agent", DIR_B);
  expect(b2.status).toBe(200);
  expect(b2.body).toBe(b1.body);
  expect(await stampOf(page, DIR_B), "B#2 must be a fresh-hit serve (stamp unchanged)").toBe(bStamp1);
});
