// S2 SW policy mirror — unit tests for web/src/lib/swPolicy.ts (classification,
// TTL decisions, entry aging, in-flight coalescer). The service worker itself
// is plain JS (not bundle-importable), so its decision logic lives here as a
// mirror; web/tests/unit/sw-coalesce-mirror.test.ts pins the sw.js text
// against these tables.

import { describe, expect, it } from "vitest";
import {
  ASSET_PUT_PREFIXES,
  BOOT_TTL_MS,
  SHELL_KEY,
  SHELL_TTL_MS,
  STAMP_HEADER,
  assetPutEligible,
  bootCacheKey,
  bootDecision,
  bootPutEligible,
  bypassBootCache,
  classifyRequest,
  createCoalescer,
  entryAge,
  shellDecision,
} from "../../src/lib/swPolicy";

const ORIGIN = "https://worker.example";

describe("classifyRequest (S2 guard chain)", () => {
  const classify = (path: string, opts: { method?: string; mode?: string; origin?: string } = {}) =>
    classifyRequest(
      opts.method ?? "GET",
      opts.origin ?? ORIGIN,
      path,
      opts.mode ?? "no-cors",
      ORIGIN,
    );

  it("enumerated boot-data paths classify as boot-data (GET, same-origin)", () => {
    for (const p of Object.keys(BOOT_TTL_MS)) {
      expect(classify(p), p).toBe("boot-data");
    }
  });

  it("boot-data is GET-only: non-GET on an enumerated path passes through", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
      expect(classify("/oc/provider", { method })).toBe("pass-through");
    }
  });

  it("boot-data is same-origin only: a foreign /oc/provider passes through", () => {
    expect(classify("/oc/provider", { origin: "https://evil.example" })).toBe("pass-through");
  });

  it("boot-data enumeration is EXACT-pathname: sibling /oc paths pass through", () => {
    // Not prefix matching — near-miss pathnames must not be pulled in.
    expect(classify("/oc/providers")).toBe("pass-through");
    expect(classify("/oc/provider/")).toBe("pass-through");
    expect(classify("/oc/providerx")).toBe("pass-through");
    expect(classify("/oc/CONFIG")).toBe("pass-through"); // case-sensitive exact match
    expect(classify("/oc/agent/xyz")).toBe("pass-through");
    expect(classify("/oc/session/abc")).toBe("pass-through");
  });

  it("/vh/* is never intercepted regardless of method or shape", () => {
    expect(classify("/vh/pins")).toBe("pass-through");
    expect(classify("/vh/")).toBe("pass-through");
    expect(classify("/vh/version", { method: "POST" })).toBe("pass-through");
  });

  it("host routes (`/` and /host/*) pass through untouched", () => {
    expect(classify("/", { mode: "navigate" })).toBe("pass-through");
    expect(classify("/host/assets/host-x.js")).toBe("pass-through");
  });

  it("single-server shell navigations classify as shell", () => {
    expect(classify("/app", { mode: "navigate" })).toBe("shell");
    expect(classify("/app/", { mode: "navigate" })).toBe("shell");
    expect(classify("/app/session/abc", { mode: "navigate" })).toBe("shell");
    expect(classify("/index.html", { mode: "navigate" })).toBe("shell");
    // .html suffix counts as nav even without navigate mode (subresource html).
    expect(classify("/index.html")).toBe("shell");
  });

  it("the shell is narrowed: other navigations pass through (host-shell quirk fix)", () => {
    // Unknown root paths serve the HOST shell server-side — they must never
    // be served/cached as the single-server shell (pre-S2 the nav branch
    // cached ANY nav response under /index.html).
    expect(classify("/session/xyz", { mode: "navigate" })).toBe("pass-through");
    expect(classify("/whatever/deep/path", { mode: "navigate" })).toBe("pass-through");
    expect(classify("/host/panel", { mode: "navigate" })).toBe("pass-through");
    expect(classify("/other.html", { mode: "navigate" })).toBe("pass-through");
  });

  it("same-origin static subresources classify as asset", () => {
    expect(classify("/assets/app-B3xV1zC4.js")).toBe("asset");
    expect(classify("/assets/main-x.css")).toBe("asset");
    expect(classify("/icon.svg")).toBe("asset");
    expect(classify("/icon-192.png")).toBe("asset");
    expect(classify("/screenshots/shot1.png")).toBe("asset");
    expect(classify("/manifest.webmanifest")).toBe("asset");
    expect(classify("/sw.js")).toBe("asset");
  });
});

describe("assetPutEligible", () => {
  it("matches the put prefix gate exactly", () => {
    expect(assetPutEligible("/assets/app-h.js")).toBe(true);
    expect(assetPutEligible("/icon.svg")).toBe(true);
    expect(assetPutEligible("/icon-192.png")).toBe(true);
    expect(assetPutEligible("/screenshots/x.png")).toBe(true);
    expect(assetPutEligible("/manifest.webmanifest")).toBe(false);
    expect(assetPutEligible("/sw.js")).toBe(false);
    expect(assetPutEligible("/")).toBe(false);
  });

  it("keeps the documented prefix list", () => {
    expect(ASSET_PUT_PREFIXES).toEqual(["/assets/", "/icon", "/screenshots/"]);
  });
});

describe("entryAge", () => {
  it("computes age from the stamp", () => {
    const now = 1_000_000;
    expect(entryAge(String(now - 5_000), now)).toBe(5_000);
    expect(entryAge(String(now), now)).toBe(0);
  });

  it("never returns negative age (clock skew tolerance)", () => {
    expect(entryAge(String(2_000_000), 1_000_000)).toBe(0);
  });

  it("missing / malformed / non-numeric stamps are fully aged (Infinity)", () => {
    expect(entryAge(null, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(entryAge(undefined, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(entryAge("", 1)).toBe(Number.POSITIVE_INFINITY);
    expect(entryAge("not-a-number", 1)).toBe(Number.POSITIVE_INFINITY);
    expect(entryAge("NaN", 1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("shellDecision", () => {
  it("serves from cache inside the TTL and goes to network at/after it", () => {
    expect(shellDecision(0)).toBe("cache");
    expect(shellDecision(SHELL_TTL_MS - 1)).toBe("cache");
    expect(shellDecision(SHELL_TTL_MS)).toBe("network");
    expect(shellDecision(Number.POSITIVE_INFINITY)).toBe("network"); // unstamped entry
  });
});

describe("bootDecision", () => {
  it("miss → fresh → stale-revalidate lifecycle", () => {
    expect(bootDecision(false, Number.POSITIVE_INFINITY, 20_000)).toBe("miss");
    expect(bootDecision(true, 0, 20_000)).toBe("fresh");
    expect(bootDecision(true, 19_999, 20_000)).toBe("fresh");
    expect(bootDecision(true, 20_000, 20_000)).toBe("stale-revalidate");
    expect(bootDecision(true, Number.POSITIVE_INFINITY, 60_000)).toBe("stale-revalidate");
  });

  it("carries the per-path TTL table (provider 60s SWR; the rest 20s)", () => {
    expect(BOOT_TTL_MS["/oc/provider"]).toBe(60_000);
    expect(BOOT_TTL_MS["/oc/agent"]).toBe(20_000);
    expect(BOOT_TTL_MS["/oc/config"]).toBe(20_000);
    expect(BOOT_TTL_MS["/oc/project"]).toBe(20_000);
    expect(BOOT_TTL_MS["/oc/mcp"]).toBe(20_000);
    expect(Object.keys(BOOT_TTL_MS)).toHaveLength(5);
  });

  it("exposes the stamp header + shell key constants the SW mirrors", () => {
    expect(STAMP_HEADER).toBe("x-vh-sw-at");
    expect(SHELL_KEY).toBe("/index.html");
    expect(SHELL_TTL_MS).toBe(30_000);
  });
});

describe("boot-data project scoping (review F1 fix)", () => {
  it("partitions the cache key by the project dir header", () => {
    const url = "https://worker.example/oc/agent";
    const a = bootCacheKey(url, "/home/alice/proj-a");
    const b = bootCacheKey(url, "/home/alice/proj-b");
    expect(a).not.toBe(b);
    expect(a).toBe(url + "?vhsw=" + encodeURIComponent("/home/alice/proj-a"));
    expect(b).toBe(url + "?vhsw=" + encodeURIComponent("/home/alice/proj-b"));
  });

  it("same project → same key; absent header → bare-marker key (stable both sides)", () => {
    const url = "https://worker.example/oc/provider";
    expect(bootCacheKey(url, "/p")).toBe(bootCacheKey(url, "/p"));
    expect(bootCacheKey(url, null)).toBe(url + "?vhsw=");
    // Round-trip: the encoded dir can never corrupt the URL it appends to.
    const weird = bootCacheKey(url, "/p ?&#=x");
    expect(weird.startsWith(url + "?vhsw=")).toBe(true);
    expect(decodeURIComponent(weird.slice(url.length + "?vhsw=".length))).toBe("/p ?&#=x");
  });

  it("is INJECTIVE: a headerless URL containing the marker can never alias a dir-scoped entry", () => {
    // Review R2F1: a dir-scoped entry for (/oc/agent, /project-a) must not be
    // reachable by a HEADERLESS request whose literal URL already carries the
    // partition suffix — the exact aliasing an append-only bare-fallback had.
    const base = "https://worker.example/oc/agent";
    const scoped = bootCacheKey(base, "/project-a"); // …/oc/agent?vhsw=%2Fproject-a
    const adversarial = bootCacheKey(scoped, null); // headerless req to that literal URL
    expect(adversarial).toBe(scoped + "?vhsw=");
    expect(adversarial).not.toBe(scoped);
    // Exhaustive pairwise over a representative tuple set: no two distinct
    // (url, dir) tuples share a key. ("" and null are deliberately the SAME
    // scope — Go's Header.Get returns "" for an absent header, so the server
    // cannot distinguish them either — they are excluded as non-distinct.)
    const urls = [base, base + "?x=1", "https://worker.example/oc/config"];
    const dirs: (string | null)[] = [null, "/a", "/b", "/a?vhsw=/b", "?vhsw=", "/project-a"];
    const seen = new Set<string>();
    for (const u of urls) {
      for (const d of dirs) {
        const k = bootCacheKey(u, d);
        expect(seen.has(k), `key collision on (${u}, ${d})`).toBe(false);
        seen.add(k);
      }
    }
  });

  it("no-store/reload bypass the fresh/stale serve; no-store also skips the put", () => {
    expect(bypassBootCache("no-store")).toBe(true);
    expect(bypassBootCache("reload")).toBe(true);
    expect(bypassBootCache("default")).toBe(false);
    expect(bypassBootCache("no-cache")).toBe(false);
    expect(bypassBootCache("force-cache")).toBe(false);
    expect(bypassBootCache("only-if-cached")).toBe(false);
    expect(bootPutEligible("no-store")).toBe(false);
    expect(bootPutEligible("reload")).toBe(true);
    expect(bootPutEligible("default")).toBe(true);
  });
});

describe("createCoalescer", () => {
  it("dedupes concurrent identical keys into ONE maker call", async () => {
    const c = createCoalescer();
    let calls = 0;
    let release!: (v: number) => void;
    const gate = new Promise<number>((r) => (release = r));
    const maker = async () => {
      calls++;
      return gate;
    };
    const waits = [c.fetch("k", maker), c.fetch("k", maker), c.fetch("k", maker)];
    await Promise.resolve(); // maker invocation is deferred a microtask — let it start
    expect(calls).toBe(1); // second/third callers share the in-flight promise
    expect(c.inFlight("k")).toBe(true);
    expect(c.size()).toBe(1);
    release(42);
    expect(await Promise.all(waits)).toEqual([42, 42, 42]);
  });

  it("resolves distinct values per key and runs makers for distinct keys", async () => {
    const c = createCoalescer();
    const seen: string[] = [];
    const mk = (v: string) => async () => {
      seen.push(v);
      return v;
    };
    const [a, b] = await Promise.all([c.fetch("a", mk("A")), c.fetch("b", mk("B"))]);
    expect([a, b]).toEqual(["A", "B"]);
    expect(seen.sort()).toEqual(["A", "B"]);
  });

  it("removes the key after success so a later call re-invokes the maker", async () => {
    const c = createCoalescer();
    let calls = 0;
    const mk = async () => ++calls;
    expect(await c.fetch("k", mk)).toBe(1);
    expect(c.inFlight("k")).toBe(false);
    expect(c.size()).toBe(0);
    expect(await c.fetch("k", mk)).toBe(2); // fresh maker, no queueing
  });

  it("a failed maker rejects ALL waiters and nothing is cached (key freed)", async () => {
    const c = createCoalescer();
    let calls = 0;
    const mk = async () => {
      calls++;
      throw new Error("network down");
    };
    const waits = [c.fetch("k", mk), c.fetch("k", mk), c.fetch("k", mk)];
    await Promise.all(waits.map((p) => expect(p).rejects.toThrow("network down")));
    expect(calls).toBe(1); // one shared failure, not three
    expect(c.inFlight("k")).toBe(false); // retry starts a fresh maker
    expect(await c.fetch("k", async () => "recovered")).toBe("recovered");
    expect(calls).toBe(1); // the failing maker ran exactly once; recovery was a NEW maker
  });

  it("a maker that throws synchronously still becomes a shared rejection", async () => {
    const c = createCoalescer();
    const boom = () => {
      throw new Error("sync throw");
    };
    await Promise.all([
      expect(c.fetch("k", boom)).rejects.toThrow("sync throw"),
      expect(c.fetch("k", boom)).rejects.toThrow("sync throw"),
    ]);
    expect(c.size()).toBe(0);
  });

  it("waiters joining LATE but before settle still share (no early eviction)", async () => {
    const c = createCoalescer();
    let calls = 0;
    const mk = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return "v";
    };
    const first = c.fetch("k", mk);
    await new Promise((r) => setTimeout(r, 5)); // in-flight, not settled
    const late = c.fetch("k", mk);
    expect(await Promise.all([first, late])).toEqual(["v", "v"]);
    expect(calls).toBe(1);
  });
});
