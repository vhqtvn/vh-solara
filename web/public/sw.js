// vh-solara service worker — installable PWA, auto-updating.
//
// Each build stamps a unique BUILD_ID (see vite.config.ts) so the browser
// detects a new SW every deploy. The SW activates IMMEDIATELY (skipWaiting +
// clients.claim) and the page auto-reloads once onto the new version (see
// pwa.ts) — so a shipped fix is never stuck behind a stale cache.
//
// S2 page-load posture (policy mirrored + unit-tested in
// web/src/lib/swPolicy.ts — keep the two in sync;
// web/tests/unit/sw-coalesce-mirror.test.ts pins this file against drift):
//   - In-flight coalescing: identical concurrent GETs share ONE network fetch
//     (each waiter gets its own Response; failure rejects all waiters and
//     nothing is cached). Cold multi-pane boots no longer race N copies of
//     the same hashed bundle / boot doc over the wire.
//   - Boot-data TTL/SWR for an ENUMERATED set of /oc/* GET paths (see
//     BOOT_TTL_MS): /oc/provider 60s stale-while-revalidate; agent/config/
//     project/mcp 20s fresh window + background revalidate. GET-only, exact
//     pathname match; every other /oc path stays pass-through.
//   - Shell TTL: /app + /index.html navigations are network-first with a 30s
//     fresh window — a fresh cached shell serves with zero network, a stale
//     or missing one goes to the network first (coalesced). The deploy-
//     freshness contract is unchanged in kind: a normal reload past the TTL
//     always pulls the latest shell, and a new BUILD_ID reaps every prior
//     cache on activate, so cross-deploy staleness is bounded by the TTL.
//   - Hashed assets are immutable → cache-first (unchanged).
//
// Host-route exclusion (post-fold): `/` is the multi-server HOST shell
// (online-only — it embeds live cross-origin servers in iframes) and `/host/*`
// are its assets. This SW caches only the SINGLE-SERVER shell (at /app +
// /index.html), so it must NEVER intercept `/` or `/host/*` — doing so would
// cache the host shell under the shared /index.html key and pollute the
// single-server offline fallback with the wrong app. Host routes pass straight
// to the network. This mirrors Go's isHostRoute (pkg/web/server.go). BUILD_ID
// is unique per build, so shipping this reaps every prior cache (incl. any
// stale `/` from a pre-fold install) on activate.
//
// S3b narrow-scope posture: the SAME file serves TWO registrations on one
// origin — ROOT (scope "/"), registered by the SPA (pwa.ts, unchanged from
// S2b), and NARROW (scope "/app"), registered by the HOST shell at boot
// (host-web/src/swNarrow.ts) so cold-booting /app panes are BORN
// service-worker-controlled (pane src assignment is gated on this
// registration's ACTIVE worker — see iframeRenderer.ts). Nothing below may
// assume the root scope: every scope-sensitive branch (in-scope navigation
// strays, notificationclick's openWindow fallback) derives from
// self.registration.scope. Root-scope behavior is byte-stable with S2b.
// Cross-registration safety is receipted (S3a X2/X6): claim() respects
// longest-scope-prefix — the narrow claim takes panes from root, root NEVER
// takes panes from narrow, no ping-pong across deploy skew.

const BUILD_ID = "__BUILD_ID__";
const CACHE = "vh-" + BUILD_ID;

// --- Narrow-scope plumbing (S3b) ---------------------------------------------
// Lazily derived (self.registration is settled by the time any event fires).
// SCOPE_PATH is "/" for the root registration, "/app" for the narrow one.
let scopePathCache = null;
function scopePath() {
  if (scopePathCache === null) scopePathCache = new URL(self.registration.scope).pathname;
  return scopePathCache;
}
function narrowScope() {
  return scopePath() !== "/";
}

// Host focus channel: the HOST document is OUTSIDE the narrow scope, so this
// worker can never see it in clients.matchAll (S3a X4 — all engines; Firefox
// additionally returns NO iframe clients at all). At narrow activation the
// host transfers one port of a MessageChannel here (swNarrow.ts); a
// notificationclick that finds no focusable window client asks the host to
// focus itself over it. The port lives with the worker — the host re-wires on
// every activation (updatefound), so a BUILD_ID change tears down the stale
// channel deterministically.
let hostFocusPort = null;

// --- Policy tables (mirror of web/src/lib/swPolicy.ts) ----------------------
const STAMP_HEADER = "x-vh-sw-at"; // store-time stamp on cached entries (ms epoch)
const SHELL_KEY = "/index.html"; // cache key for the single-server shell
const SHELL_TTL_MS = 30000;
const BOOT_TTL_MS = {
  "/oc/provider": 60000, // stale-while-revalidate window
  "/oc/agent": 20000,
  "/oc/config": 20000,
  "/oc/project": 20000,
  "/oc/mcp": 20000,
};
const ASSET_PUT_PREFIXES = ["/assets/", "/icon", "/screenshots/"];

// --- In-flight coalescing ---------------------------------------------------
// Identical concurrent GETs share one maker promise; the key is dropped the
// moment it settles (success or failure) so nothing queues past the in-flight
// lifetime and a post-failure retry starts fresh.
const inflight = new Map();
function coalesce(key, maker) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(maker)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// stampedCopy buffers a response and rebuilds it with the TTL stamp. The
// buffering is what makes the body safely reusable per waiter (a Response
// body is single-use). CE/CL/Vary MUST be dropped: the fetch API exposes the
// DECODED body while the received headers still describe the compressed wire
// representation — re-attaching CE to decoded bytes would make the browser
// gunzip plain data, and a stale Vary:Accept-Encoding would claim a variance
// the reconstructed (decoded, single-variant) entry does not have.
async function stampedCopy(res, at) {
  const body = await res.blob();
  const headers = new Headers(res.headers);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("Vary");
  headers.set(STAMP_HEADER, String(at));
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

// entryAge of a cached entry from its stamp; unstamped/garbage → Infinity
// (fully aged → network-first; an unstamped entry is never "fresh").
function entryAge(stampedAt) {
  if (stampedAt === null || stampedAt === undefined || stampedAt === "") return Infinity;
  const t = Number(stampedAt);
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Infinity;
}

self.addEventListener("install", () => {
  // Deliberately NO network work here: on a cold boot this SW registers while
  // the page's own boot traffic is still fighting for the (tunnel-limited)
  // wire, and a precache fetch in install both delays activation and competes
  // with that traffic. The shell precache moved to activate, AFTER
  // clients.claim() so interception starts as early as possible.
  self.skipWaiting(); // activate the new version right away
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      // Claim FIRST (perf): pages load their boot data while old caches are
      // still being reaped. Reaping in-flight responses is not disturbed by
      // cache deletion.
      try {
        await self.clients.claim();
      } catch {
        /* no clients to claim yet — fine */
      }
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      // Best-effort shell precache (moved off install — see above). Failure
      // is fine: the fetch handler's network-first branch fills the entry.
      try {
        const c = await caches.open(CACHE);
        const res = await fetch(SHELL_KEY);
        if (res.ok) await c.put(SHELL_KEY, await stampedCopy(res, Date.now()));
      } catch {
        /* offline or busy — the fetch handler will fill it */
      }
    })(),
  );
});

// Legacy "apply update" message — harmless now that install skips waiting.
// VH_HOST_FOCUS_CHANNEL (S3b): the host shell transfers a MessageChannel port
// (host-mediated notification focus — see the note above the declaration).
// VH_PING is a zero-behavior liveness probe any same-origin page can use
// (e2e asserts the out-of-scope host document CAN reach this worker).
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
  if (e.data && e.data.type === "VH_HOST_FOCUS_CHANNEL" && e.ports && e.ports[0]) {
    hostFocusPort = e.ports[0];
  }
  if (e.data && e.data.type === "VH_PING") {
    try {
      e.source && e.source.postMessage({ type: "vh-pong" });
    } catch {
      /* source went away — ignore */
    }
  }
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
// S3b scope-aware order (S3a X4 receipts — the NARROW registration's matchAll
// can never see the host window; Firefox returns no iframe clients either):
//   1. focus an existing controlled window client (the click's user
//      activation makes client.focus() the reliable bring-to-front);
//   2. else ask a connected host shell to focus itself over the focus
//      channel (deterministic on engines where matchAll is blind);
//   3. else open the app INSIDE this worker's scope — openWindow enforces
//      scope, and openWindow("/") from the narrow worker is rejected on every
//      engine (X4). For the root registration the target is "/" — unchanged.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
      for (const c of all) {
        if ("focus" in c) return c.focus();
      }
      if (hostFocusPort) {
        try {
          hostFocusPort.postMessage({ type: "vh-focus-host" });
          return;
        } catch {
          /* stale port (worker/client teardown race) — fall through */
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(scopePath());
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/vh/")) return;
  const bootTtl = BOOT_TTL_MS[url.pathname]; // exact-pathname enumeration
  if (bootTtl !== undefined) {
    e.respondWith(bootDataResponse(req, bootTtl));
    return;
  }
  if (url.pathname.startsWith("/oc/")) return; // live API: only the set above
  // Host shell (`/`) + its assets (`/host/*`) are online-only and excluded
  // from caching — see the header note. Never intercept, never cache.
  if (url.pathname === "/" || url.pathname.startsWith("/host/")) return;

  const isNav = req.mode === "navigate" || url.pathname.endsWith(".html");
  if (isNav) {
    // Shell policy is narrowed to the SINGLE-SERVER shell only. Other
    // navigations (unknown root paths serve the HOST shell server-side) pass
    // through — pre-S2 the nav branch cached ANY nav response under
    // /index.html, letting a host-shell document pollute the single-server
    // offline fallback; this narrowing closes that quirk.
    if (url.pathname === "/app" || url.pathname.startsWith("/app/") || url.pathname === "/index.html") {
      e.respondWith(shellResponse(req));
      return;
    }
    // S3b FIREFOX INVARIANT (S3a X1 case-C): a worker whose fetch listener
    // lets an IN-SCOPE navigation fall through permanently drops that
    // client's SW coverage on Firefox — on reload AND on every later
    // same-frame re-src. The narrow scope is a STRING prefix ("/app" also
    // matches strays like /apple), and this worker only ever sees fetch
    // events for in-scope requests, so any navigation reaching this line
    // under the narrow scope is in-scope: serve it with an explicit
    // pass-through respondWith (fetch(request) counts — X1 `-rw` control).
    // The root registration keeps the S2b fall-through byte-for-byte (its
    // only real navigation clients are the /app shells, which respond above;
    // switching root pass-throughs to respondWith would also change redirect
    // semantics, e.g. the /auth login redirect).
    if (narrowScope() && url.pathname.startsWith(scopePath())) {
      e.respondWith(fetch(req));
    }
    return;
  }
  e.respondWith(assetResponse(req, url));
});

// Shell: network-first with a short TTL. Fresh cached shell → serve with zero
// network (this is what removes the serialized pane-doc stride on warm boots);
// stale/miss → ONE coalesced network fetch that refreshes the cache (deploy
// freshness). Offline (or any fetch failure) → stale-any-age cached shell.
// request.cache "reload"/"no-cache"/"no-store" (F5 / location.reload() /
// explicit opt-out) bypass the FRESH serve — a reload always pulls the live
// shell (F10; mirrors the boot-data bypass, plus "no-cache": Chromium
// surfaces a NAVIGATION's reload mode to the SW fetch event as "no-cache",
// not "reload" — verified empirically; subresource modes present truthfully)
// — but the entry is still READ so the offline fallback survives (offline +
// reload serves the cached shell, not a 504), and a successful reload fetch
// still refreshes the cache (no-store skips the put, mirroring
// bootPutEligible).
async function shellResponse(req) {
  const noStore = req.cache === "no-store";
  const bypass = noStore || req.cache === "reload" || req.cache === "no-cache";
  const cache = await caches.open(CACHE);
  const cached = await cache.match(SHELL_KEY);
  const age = cached ? entryAge(cached.headers.get(STAMP_HEADER)) : Infinity;
  if (cached && !bypass && age < SHELL_TTL_MS) return cached;
  try {
    const make = await coalesce("shell:" + SHELL_KEY, async () => {
      const res = await fetch(SHELL_KEY);
      if (res.ok) {
        // One buffered body feeds both the cache entry and every waiter
        // (a Blob is reusable across Response constructors).
        const body = await res.blob();
        const headers = new Headers(res.headers);
        headers.delete("Content-Encoding");
        headers.delete("Content-Length");
        headers.delete("Vary");
        headers.set(STAMP_HEADER, String(Date.now()));
        const mk = () => new Response(body, { status: res.status, statusText: res.statusText, headers });
        if (!noStore) await cache.put(SHELL_KEY, mk());
        return mk;
      }
      return () => res.clone(); // error pages: per-waiter clone, never cached
    });
    return make();
  } catch {
    if (cached) return cached; // stale-any-age offline fallback
    return new Response("", { status: 504, statusText: "offline" });
  }
}

// Boot data (enumerated /oc/* GETs only — see BOOT_TTL_MS):
//   fresh → cached copy, zero network;
//   stale → cached copy NOW + background revalidate for the next load (a
//           background failure leaves the stale entry in place);
//   miss  → coalesced fetch, stamped into the cache, per-waiter Response;
//           failure rejects every waiter (the same network error a
//           pass-through fetch would surface) and nothing is cached.
// PROJECT SCOPING: the enumerated GETs are scoped server-side by the
// x-opencode-directory header (pkg/web reqDir) that the SPA stamps on every
// fetch (web/src/csrf.ts decorate) — the SAME URL returns different data per
// selected project, and index.tsx re-fires these URLs on project switch. So
// the cache + coalesce key partitions by that header (bootCacheKey mirrors
// swPolicy.ts); keying by URL alone would serve one project's payload to
// another within the TTL. Pinned by
// web/tests/e2e/sw-bootdata-project-scope.spec.ts.
// cache:"no-store"/"reload" requests bypass the fresh/stale serve (no-store
// also skips the put) — an explicit app-side opt-out for context changes.
// Injective over (url, dir): the dir-scoped key always carries a NON-EMPTY
// encoded dir after the marker; the headerless key is exactly url + "?vhsw=".
// No bare URL — not even one whose literal query already contains "?vhsw=…"
// — can collide with a dir-scoped key, and vice versa (review R2F1).
function bootCacheKey(req) {
  const dir = req.headers.get("x-opencode-directory");
  return req.url + "?vhsw=" + (dir ? encodeURIComponent(dir) : "");
}
async function bootDataResponse(req, ttl) {
  const cache = await caches.open(CACHE);
  const key = bootCacheKey(req);
  const noStore = req.cache === "no-store";
  const bypass = noStore || req.cache === "reload";
  const cached = bypass ? null : await cache.match(key);
  const age = cached ? entryAge(cached.headers.get(STAMP_HEADER)) : Infinity;
  if (cached && age < ttl) return cached;
  const load = coalesce(key, async () => {
    const res = await fetch(req);
    if (!res.ok || noStore) return () => res.clone(); // serve through, don't cache
    const stamped = await stampedCopy(res, Date.now());
    await cache.put(key, stamped.clone());
    return () => stamped.clone();
  });
  if (cached) {
    load.catch(() => {}); // SWR: refresh failed — keep the stale entry
    return cached;
  }
  const make = await load;
  return make();
}

// Assets: cache-first (hashed /assets/ are immutable). The initial fetch is
// coalesced so N panes racing the same missing bundle share one network copy;
// each waiter clones the shared response (tee) and the cache stores another
// clone — the original body is never consumed directly.
async function assetResponse(req, url) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await coalesce("asset:" + req.url, () => fetch(req));
    if (
      res.ok &&
      ASSET_PUT_PREFIXES.some((p) => url.pathname.startsWith(p))
    ) {
      cache.put(req, res.clone());
    }
    return res.clone();
  } catch {
    return new Response("", { status: 504, statusText: "offline" });
  }
}
