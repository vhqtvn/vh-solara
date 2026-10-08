// Post-fold service-worker route-exclusion guard.
//
// The fold (f461094) made `/` the multi-server HOST shell (online-only — it
// embeds live cross-origin servers in iframes) and moved the single-server SPA
// to `/app`. The single-server service worker (`web/public/sw.js`, scope `/`) is
// registered only by the single-server SPA, but its scope covers the whole
// origin — so if it intercepted `/` or `/host/*` it would cache the host shell
// under the shared `/index.html` key and pollute the single-server offline
// fallback with the WRONG app. The fix: the SW fetch handler + precache EXCLUDE
// host routes and cache only the single-server shell.
//
// The web e2e lane (pwa.spec.ts) runs against the fixture server, which opts
// OUT of the fold (hostShellAtRoot=false → single-server at `/`), so it cannot
// reproduce the production posture (`/` = host). This unit test is therefore a
// STATIC SOURCE GUARD over the committed SW — the same pattern
// wire-field-aliases.test.ts uses to pin source-level policy. It fails if the
// host-route exclusion is removed or the precache is broadened back to `/`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const swPath = path.resolve(here, "..", "..", "public", "sw.js"); // web/public/sw.js
const sw = readFileSync(swPath, "utf8");

describe("service worker host-route exclusion (post-fold cache-pollution fix)", () => {
  it("excludes `/` (host shell root) and `/host/*` (host assets) from interception", () => {
    // The fetch handler must early-return for host routes so they pass straight
    // to the network (never cached). This predicate mirrors Go's isHostRoute.
    expect(
      sw.includes('url.pathname === "/" || url.pathname.startsWith("/host/")'),
      "SW fetch handler must exclude host routes (`/` + `/host/*`) — see web/public/sw.js",
    ).toBe(true);
  });

  it("does NOT precache `/` (the host shell is online-only)", () => {
    // Pre-fold the precache was addAll(["/", "/index.html"]) where both were the
    // single-server index. Post-fold `/` is the host shell and must not be
    // precached. Since S2, install does NO network work at all (cold-boot
    // latency); the shell precache lives in activate and fetches ONLY the
    // single-server key — never `/`.
    expect(sw.includes("addAll("), "install must stay network-free (no addAll)").toBe(false);
    expect(sw.includes("fetch(SHELL_KEY)"), "activate precaches the single-server shell only").toBe(true);
    expect(
      sw.includes('addAll(["/", "/index.html"])'),
      "precache must NOT include `/` (host shell) — drop it from addAll",
    ).toBe(false);
  });

  it("keeps network-first-with-TTL navigation + /index.html fallback for the single-server shell", () => {
    // The fix must NOT turn navigation unconditionally cache-first (that would
    // serve stale content forever). Since S2 the shell is network-first with a
    // 30s fresh window: inside the TTL the cached shell serves (zero network),
    // at/after it the shell goes to the network and refreshes the entry; any
    // fetch failure falls back to the cached shell (offline). Guards against an
    // accidental unbounded cache-first revert.
    expect(sw.includes("const SHELL_TTL_MS = 30000;")).toBe(true);
    expect(sw.includes("age < SHELL_TTL_MS")).toBe(true);
    expect(sw.includes("await cache.put(SHELL_KEY, mk());")).toBe(true);
    expect(sw.includes("cache.match(SHELL_KEY)")).toBe(true);
  });

  it("still caches single-server hashed assets (did not over-exclude)", () => {
    // The host exclusion must not ripple into the single-server asset cache
    // clauses (/assets/, /icon, /screenshots/ are single-server root assets).
    // Since S2 the prefixes live in the ASSET_PUT_PREFIXES table (mirrored in
    // web/src/lib/swPolicy.ts).
    expect(sw.includes('const ASSET_PUT_PREFIXES = ["/assets/", "/icon", "/screenshots/"];')).toBe(true);
  });
});
