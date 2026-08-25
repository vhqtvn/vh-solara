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
//
// Host-route exclusion (post-fold): `/` is the multi-server HOST shell (online-
// only — it embeds live cross-origin servers in iframes) and `/host/*` are its
// assets. This SW caches only the SINGLE-SERVER shell (at /app + /index.html),
// so it must NEVER intercept `/` or `/host/*` — doing so would cache the host
// shell under the shared /index.html key and pollute the single-server offline
// fallback with the wrong app. Host routes pass straight to the network. This
// mirrors Go's isHostRoute (pkg/web/server.go). BUILD_ID is unique per build, so
// shipping this reaps every prior cache (incl. any stale `/` from a pre-fold
// install) on activate.

const BUILD_ID = "__BUILD_ID__";
const CACHE = "vh-" + BUILD_ID;

self.addEventListener("install", (e) => {
  // Precache only the SINGLE-SERVER shell. `/` is the host shell post-fold
  // (online-only) and must not be precached; /index.html resolves to the
  // single-server SPA index (a root-level static file). See the header note.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/index.html"]).catch(() => {})));
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

// Web Push: the daemon pushes a notice when the app is closed and you're away.
// The payload is the same notice JSON the in-app handler renders.
const PUSH_LABEL = {
  finished: ["✅", "finished"],
  waiting: ["⏳", "needs your input"],
  "stuck-thinking": ["🤔", "is thinking for a long time"],
  runaway: ["⚠️", "has a long-running command"],
  stalled: ["💤", "has stalled"],
};
self.addEventListener("push", (e) => {
  let n = {};
  try { n = e.data ? e.data.json() : {}; } catch { n = {}; }
  const l = PUSH_LABEL[n.type] || ["🔔", ""];
  const name = n.title || (n.sessionID ? String(n.sessionID).slice(0, 8) : "Session");
  const title = (l[0] + " " + name + " " + l[1]).trim();
  e.waitUntil(
    self.registration.showNotification(title, {
      body: n.detail || n.project || "",
      tag: (n.type || "notice") + ":" + (n.root || n.sessionID || ""),
      data: { root: n.root, sessionID: n.sessionID },
    }),
  );
});
// Notification click: focus an existing window when one exists, open the app
// otherwise. Deliberately GENERAL (push notices and the host shell's
// needs-you notifications — tags starting "vh-needy-" — share this path):
// never route to a specific pane/session from the (possibly stale)
// notification payload; the app re-derives fresh state on arrival.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
      for (const c of all) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/vh/") || url.pathname.startsWith("/oc/")) return;
  // Host shell (`/`) + its assets (`/host/*`) are online-only and excluded
  // from caching — see the header note. Never intercept, never cache.
  if (url.pathname === "/" || url.pathname.startsWith("/host/")) return;

  // `/` is excluded above (host route), so nav detection is the SPA navigation
  // mode or an explicit .html file — never the bare host root.
  const isNav = req.mode === "navigate" || url.pathname.endsWith(".html");

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
        if (res.ok && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icon") || url.pathname.startsWith("/screenshots/"))) {
          cache.put(req, res.clone());
        }
        return res;
      } catch {
        return new Response("", { status: 504, statusText: "offline" });
      }
    })(),
  );
});
