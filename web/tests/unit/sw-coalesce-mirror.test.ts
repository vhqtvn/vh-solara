// S2 SW mirror drift pin — web/public/sw.js is plain JS copied verbatim into
// the build (only __BUILD_ID__ is stamped), so it cannot import the bundle.
// Its policy tables and guard chain are mirrored in web/src/lib/swPolicy.ts
// (unit-tested in sw-coalesce-policy.test.ts). This spec reads the ACTUAL
// sw.js text and pins that the mirror and the SW agree: TTL table values,
// stamp header, shell key/TTL, put-prefixes, the guard-chain order, and the
// handlers that must survive every SW edit byte-for-byte in behavior
// (push / notificationclick / SKIP_WAITING message).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASSET_PUT_PREFIXES,
  BOOT_TTL_MS,
  SHELL_KEY,
  SHELL_TTL_MS,
  STAMP_HEADER,
} from "../../src/lib/swPolicy";

const sw = readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8");

describe("sw.js mirrors swPolicy tables", () => {
  it("carries the same stamp header, shell key and shell TTL", () => {
    expect(sw).toContain(`const STAMP_HEADER = "${STAMP_HEADER}";`);
    expect(sw).toContain(`const SHELL_KEY = "${SHELL_KEY}";`);
    expect(sw).toContain(`const SHELL_TTL_MS = ${SHELL_TTL_MS};`);
  });

  it("carries the exact boot-data TTL table (enumeration IS the table)", () => {
    for (const [path, ttl] of Object.entries(BOOT_TTL_MS)) {
      expect(sw, `boot TTL for ${path}`).toContain(`"${path}": ${ttl},`);
    }
    // The SW table must not enumerate anything beyond the mirror's five.
    const tableMatch = sw.match(/const BOOT_TTL_MS = \{([\s\S]*?)\};/);
    expect(tableMatch).not.toBeNull();
    const entries = tableMatch![1].split("\n").filter((l) => l.includes(":"));
    expect(entries).toHaveLength(Object.keys(BOOT_TTL_MS).length);
  });

  it("carries the same asset put-prefix gate", () => {
    expect(sw).toContain(`const ASSET_PUT_PREFIXES = [${ASSET_PUT_PREFIXES.map((p) => `"${p}"`).join(", ")}];`);
  });
});

describe("sw.js guard chain (order is load-bearing)", () => {
  it("checks method and origin before any path policy", () => {
    const methodCheck = sw.indexOf('req.method !== "GET"');
    const originCheck = sw.indexOf("url.origin !== location.origin");
    const vhCheck = sw.indexOf('url.pathname.startsWith("/vh/")');
    const bootCheck = sw.indexOf("BOOT_TTL_MS[url.pathname]");
    const ocCheck = sw.indexOf('url.pathname.startsWith("/oc/")');
    const hostCheck = sw.indexOf('url.pathname === "/" || url.pathname.startsWith("/host/")');
    expect(methodCheck).toBeGreaterThan(-1);
    expect(originCheck).toBeGreaterThan(methodCheck);
    expect(vhCheck).toBeGreaterThan(originCheck);
    expect(bootCheck).toBeGreaterThan(vhCheck); // enumerated boot paths beat the /oc/ prefix bail
    expect(ocCheck).toBeGreaterThan(bootCheck); // all OTHER /oc paths pass through
    expect(hostCheck).toBeGreaterThan(ocCheck); // host routes last, untouched
  });

  it("drops Content-Encoding, Content-Length and Vary when reconstructing responses", () => {
    // The classic SW reconstruct pitfall: the fetch API exposes the DECODED
    // body while the received headers still describe the compressed wire
    // form; a stale Vary would claim a variance the decoded single-variant
    // entry does not have. Every reconstruct path must delete all three.
    const dels = sw.match(/headers\.delete\("Content-Encoding"\)/g) ?? [];
    const delCL = sw.match(/headers\.delete\("Content-Length"\)/g) ?? [];
    const delVary = sw.match(/headers\.delete\("Vary"\)/g) ?? [];
    expect(dels.length).toBeGreaterThanOrEqual(2);
    expect(delCL.length).toBeGreaterThanOrEqual(2);
    expect(delVary.length).toBeGreaterThanOrEqual(2);
  });

  it("narrowed shell: only /app, /app/*, /index.html take the shell path", () => {
    const shellNarrow = sw.indexOf(
      'url.pathname === "/app" || url.pathname.startsWith("/app/") || url.pathname === "/index.html"',
    );
    expect(shellNarrow).toBeGreaterThan(-1);
  });

  it("boot-data failures reject waiters and stale revalidate keeps the entry", () => {
    expect(sw).toContain('load.catch(() => {})');
    expect(sw).toContain("rejects every waiter");
  });

  it("boot-data cache keys partition by the project dir header (review F1)", () => {
    // The enumerated /oc GETs are project-scoped server-side by
    // x-opencode-directory; the SW must fold that header into BOTH the cache
    // key and the coalesce key (mirrors swPolicy.bootCacheKey). Keying by URL
    // alone would serve one project's payload to another within the TTL.
    expect(sw).toContain('req.headers.get("x-opencode-directory")');
    // INJECTIVE marker construction (review R2F1): the marker is ALWAYS
    // appended — non-empty payload for dir-scoped, empty for headerless — so
    // no bare URL (even one whose literal query contains "?vhsw=…") can
    // collide with a dir-scoped key.
    expect(sw).toContain('req.url + "?vhsw=" + (dir ? encodeURIComponent(dir) : "")');
    // The partitioned key must drive cache match AND put AND coalesce.
    const fn = sw.slice(sw.indexOf("function bootCacheKey"), sw.indexOf("async function bootDataResponse"));
    expect(fn).toContain("x-opencode-directory");
    const body = sw.slice(
      sw.indexOf("async function bootDataResponse"),
      sw.indexOf("async function assetResponse"),
    );
    expect(body).toContain("bootCacheKey(req)");
    expect(body).toContain("cache.match(key)");
    expect(body).toContain("cache.put(key,");
    expect(body).toContain("coalesce(key,");
  });

  it("no-store/reload requests bypass the fresh serve; no-store skips the put", () => {
    expect(sw).toContain('req.cache === "no-store"');
    expect(sw).toContain('req.cache === "reload"');
    expect(sw).toContain("if (!res.ok || noStore) return () => res.clone();");
  });
});

describe("sw.js handlers that must survive unchanged", () => {
  it("keeps the push notification handler with its label table", () => {
    for (const label of ["finished", "waiting", "stuck-thinking", "runaway", "stalled"]) {
      expect(sw).toContain(label);
    }
    expect(sw).toContain("self.registration.showNotification");
    expect(sw).toContain("notificationclick");
  });

  it("keeps the general notificationclick contract (focus-or-open, no routing)", () => {
    expect(sw).toContain("self.clients.matchAll({ type: \"window\", includeUncontrolled: false })");
    expect(sw).toContain('self.clients.openWindow("/")');
    // And it must NOT route to a pane/session from the payload.
    expect(sw).toContain("re-derives fresh state on arrival");
  });

  it("keeps the SKIP_WAITING message + skipWaiting install posture", () => {
    expect(sw).toContain('"SKIP_WAITING"');
    expect(sw).toContain("self.skipWaiting();");
  });

  it("install does NO network work (claim-first cold boot)", () => {
    const install = sw.slice(sw.indexOf('addEventListener("install"'), sw.indexOf('addEventListener("activate"'));
    expect(install).not.toContain("fetch(");
    expect(install).not.toContain("addAll");
    // activate claims BEFORE reaping + precache.
    const activate = sw.slice(sw.indexOf('addEventListener("activate"'), sw.indexOf('addEventListener("message"'));
    expect(activate.indexOf("clients.claim()")).toBeLessThan(activate.indexOf("caches.keys()"));
    expect(activate.indexOf("clients.claim()")).toBeLessThan(activate.indexOf("fetch(SHELL_KEY)"));
  });
});
