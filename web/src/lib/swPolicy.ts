// swPolicy — the POLICY MIRROR of web/public/sw.js (S2 page-load perf slice).
//
// The service worker is plain JS copied verbatim into the build (vite's
// swBuildId plugin only stamps __BUILD_ID__), so it CANNOT import from the
// bundle. This module is the unit-testable mirror of the SW's decision logic:
// request classification, TTL tables, entry aging, and the in-flight coalescer.
// web/public/sw.js carries the same tables/logic with cross-reference
// comments; web/tests/unit/sw-coalesce-mirror.test.ts pins the two against
// drift (table values + guard checks present in the SW text).
//
// S2 behavior implemented here (and in sw.js):
//   1. In-flight coalescing — identical concurrent GETs share one network
//      fetch; each waiter gets its own Response; failure rejects all waiters
//      and nothing is cached.
//   2. Boot-data TTL/SWR — ONLY the enumerated /oc/* GET paths below.
//      /oc/provider: 60s fresh window, stale-while-revalidate. The other four:
//      20s fresh window, background revalidate. GET-only, exact pathname match,
//      never /vh/*, never any other /oc path, host routes untouched.
//   3. Shell TTL — /app, /app/*, /index.html navigations get a 30s
//      network-first-with-TTL policy: fresh cached shell serves from cache,
//      stale/miss goes to the (coalesced) network first, preserving the
//      deploy-freshness contract (a new BUILD_ID still reaps every prior cache
//      on activate, bounding cross-deploy staleness to the TTL).

/** Header the SW writes into cached entries carrying the store time (ms epoch). */
export const STAMP_HEADER = "x-vh-sw-at";

/** Cache key the single-server shell (index.html) is stored under. */
export const SHELL_KEY = "/index.html";

/** Shell fresh window. Beyond it the shell fetch is network-first again. */
export const SHELL_TTL_MS = 30_000;

/**
 * Boot-data TTL table. Keys are EXACT pathnames (query not part of the match,
 * though the cache key is the full URL). Exact-path membership is the
 * enumeration itself: anything not a key here is pass-through, including
 * other /oc/* paths.
 */
export const BOOT_TTL_MS: Record<string, number> = {
  "/oc/provider": 60_000, // stale-while-revalidate window
  "/oc/agent": 20_000,
  "/oc/config": 20_000,
  "/oc/project": 20_000,
  "/oc/mcp": 20_000,
};

/** Path prefixes eligible for cache.put on the asset (cache-first) class. */
export const ASSET_PUT_PREFIXES = ["/assets/", "/icon", "/screenshots/"];

/** How a fetch event is dispatched by the SW. */
export type RequestClass = "pass-through" | "shell" | "boot-data" | "asset";

/**
 * The enumerated /oc/* boot-data GETs are PROJECT-SCOPED server-side: the SPA
 * stamps x-opencode-directory on every fetch (web/src/csrf.ts decorate) and
 * pkg/web reqDir scopes the /oc passthrough by it, so the SAME URL returns
 * different data per selected project (web/src/index.tsx re-fires these URLs
 * on project switch). The SW boot-data cache + coalesce key therefore
 * partitions by that header. Keying by URL alone would serve one project's
 * payload to another within the TTL.
 */
export const DIR_HEADER = "x-opencode-directory";

/** bootCacheKey mirrors the SW's bootDataResponse key construction (INJECTIVE
 * over (url, dirHeader): the marker is always appended; a headerless request
 * gets an empty payload, a dir-scoped one a non-empty encodeURIComponent(dir)
 * — so a bare URL, even one whose literal query already contains "?vhsw=…",
 * can never collide with a dir-scoped key, and vice versa). */
export function bootCacheKey(url: string, dirHeader: string | null): string {
  return `${url}?vhsw=${dirHeader ? encodeURIComponent(dirHeader) : ""}`;
}

/**
 * bypassBootCache mirrors the SW's request.cache handling: "no-store" and
 * "reload" bypass the fresh/stale serve (the request always goes to the
 * network). "no-store" additionally skips the cache put (see bootPutEligible).
 */
export function bypassBootCache(requestCache: string): boolean {
  return requestCache === "no-store" || requestCache === "reload";
}

/**
 * bypassShellCache mirrors the SHELL bypass vocabulary (F10). Wider than the
 * boot-data one: a reload NAVIGATION's cache mode surfaces as "no-cache" in
 * the SW fetch event in Chromium (subresource modes present truthfully), so
 * the shell must also treat "no-cache" as a bypass or a reload inside the 30s
 * TTL would serve the cached shell — the F10 finding.
 */
export function bypassShellCache(requestCache: string): boolean {
  return bypassBootCache(requestCache) || requestCache === "no-cache";
}

/** no-store must not write the cache; every other mode (incl. reload) may. */
export function bootPutEligible(requestCache: string): boolean {
  return requestCache !== "no-store";
}

/**
 * classifyRequest mirrors the SW fetch handler's guard chain exactly. Order
 * matters and is load-bearing:
 *   - non-GET → pass-through (boot-data/asset/shell caching is GET-only);
 *   - cross-origin → pass-through (never intercept another origin);
 *   - /vh/* → pass-through (live host API, online-only);
 *   - exact enumerated /oc boot path → boot-data (query ignored for class,
 *     the cache key is still the full URL);
 *   - other /oc/* → pass-through (live API, never cached);
 *   - `/` and /host/* → pass-through (host shell + its assets, online-only);
 *   - navigations narrow to the SINGLE-SERVER shell only (/app, /app/*,
 *     /index.html); other navigations (unknown root paths serve the HOST
 *     shell server-side) pass through so the host shell is never cached
 *     under the shared /index.html key (pre-S2 the nav branch cached ANY
 *     navigation response under that key — this narrowing closes that quirk);
 *   - everything else same-origin GET → asset (cache-first; put eligibility
 *     gated separately by assetPutEligible).
 */
export function classifyRequest(
  method: string,
  origin: string,
  pathname: string,
  mode: string,
  swOrigin: string,
): RequestClass {
  if (method !== "GET") return "pass-through";
  if (origin !== swOrigin) return "pass-through";
  if (pathname.startsWith("/vh/")) return "pass-through";
  if (Object.prototype.hasOwnProperty.call(BOOT_TTL_MS, pathname)) return "boot-data";
  if (pathname.startsWith("/oc/")) return "pass-through";
  if (pathname === "/" || pathname.startsWith("/host/")) return "pass-through";
  const isNav = mode === "navigate" || pathname.endsWith(".html");
  if (isNav) {
    if (pathname === "/app" || pathname.startsWith("/app/") || pathname === SHELL_KEY) {
      return "shell";
    }
    return "pass-through";
  }
  return "asset";
}

/** assetPutEligible mirrors the SW's cache.put prefix gate for the asset class. */
export function assetPutEligible(pathname: string): boolean {
  return ASSET_PUT_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * entryAge returns the age in ms of a cached entry from its stamp header
 * value. A missing, malformed, or non-numeric stamp yields Infinity: an
 * unstamped entry is treated as fully aged (network-first), so an entry
 * written without a stamp can never be served as "fresh".
 */
export function entryAge(stampedAt: string | null | undefined, now: number): number {
  if (stampedAt === null || stampedAt === undefined || stampedAt === "") {
    return Number.POSITIVE_INFINITY;
  }
  const t = Number(stampedAt);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - t);
}

export type ShellDecision = "cache" | "network";

/**
 * shellDecision: within the TTL the cached shell serves; stale → network.
 * A bypass request-cache mode ("reload"/"no-store" — F10, mirrors
 * bypassBootCache) always goes to the network regardless of age; the SW still
 * READS the cached entry so its offline fallback survives a bypassed reload.
 */
export function shellDecision(age: number, bypass = false): ShellDecision {
  return !bypass && age < SHELL_TTL_MS ? "cache" : "network";
}

export type BootDecision = "fresh" | "stale-revalidate" | "miss";

/**
 * bootDecision:
 *   - no cached entry → miss (coalesced network fetch, cache the stamped copy);
 *   - age < ttl → fresh (serve cached, zero network);
 *   - age >= ttl → stale-revalidate (serve cached now, refresh the cache in
 *     the background for the NEXT load — classic stale-while-revalidate; a
 *     background failure leaves the stale entry in place).
 */
export function bootDecision(cached: boolean, age: number, ttl: number): BootDecision {
  if (!cached) return "miss";
  return age < ttl ? "fresh" : "stale-revalidate";
}

/**
 * Coalescer — in-flight deduplication for identical concurrent fetches.
 * `fetch(key, maker)` starts `maker` on first call for a key and hands the
 * SAME promise to every concurrent caller; the entry is removed the moment
 * the shared promise settles (success OR failure), so nothing queues beyond
 * the in-flight lifetime and a retry after failure starts a fresh maker.
 *
 * The maker's resolved value must be safe to share across waiters; for
 * Responses that means a per-waiter factory (the SW blob-reconstructs or
 * clone()s per waiter — a Response body is single-use).
 */
export interface Coalescer {
  fetch<T>(key: string, maker: () => Promise<T>): Promise<T>;
  inFlight(key: string): boolean;
  size(): number;
}

export function createCoalescer(): Coalescer {
  const map = new Map<string, Promise<unknown>>();
  return {
    fetch<T>(key: string, maker: () => Promise<T>): Promise<T> {
      const existing = map.get(key);
      if (existing !== undefined) return existing as Promise<T>;
      const p = Promise.resolve()
        .then(maker)
        .finally(() => {
          map.delete(key);
        });
      map.set(key, p);
      return p;
    },
    inFlight(key: string): boolean {
      return map.has(key);
    },
    size(): number {
      return map.size;
    },
  };
}
