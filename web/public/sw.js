// vh-solara service worker — installable PWA, auto-updating.
//
// Each build stamps a unique BUILD_ID (see vite.config.ts) so the browser
// detects a new SW every deploy. The SW activates IMMEDIATELY (skipWaiting +
// clients.claim) and the page auto-reloads once onto the new version (see
// pwa.ts) — so a shipped fix is never stuck behind a stale cache.
//
// Navigation (index.html) is network-first: a normal reload always pulls the
// latest shell (and thus the latest hashed assets), falling back to cache only
// when offline. Hashed assets are immutable → cache-first. The live API
// (/vh/, /oc/) is never intercepted.

const BUILD_ID = "__BUILD_ID__";
const CACHE = "vh-" + BUILD_ID;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/index.html"]).catch(() => {})));
  self.skipWaiting(); // activate the new version right away
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// Legacy "apply update" message — harmless now that install skips waiting.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/vh/") || url.pathname.startsWith("/oc/")) return;

  const isNav = req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html");

  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isNav) {
        // Network-first: always try for the freshest shell so a new deploy is
        // picked up on reload; fall back to cache when offline.
        try {
          const res = await fetch(req);
          if (res.ok) cache.put("/index.html", res.clone());
          return res;
        } catch {
          const cached = await cache.match("/index.html");
          return cached || new Response("", { status: 504, statusText: "offline" });
        }
      }
      // Hashed assets are immutable → cache-first.
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icon"))) {
          cache.put(req, res.clone());
        }
        return res;
      } catch {
        return new Response("", { status: 504, statusText: "offline" });
      }
    })(),
  );
});
