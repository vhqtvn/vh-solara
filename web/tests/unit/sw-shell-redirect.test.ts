// Host-in-host regression — BEHAVIORAL test that EXECUTES web/public/sw.js.
//
// Production bug (live 2026-10-11): every dockview pane iframe (src `/app`)
// rendered the HOST shell. The SW served /app navigations from a shell fetched
// at `/index.html`; Go's FileServer answered that with `301 Location: ./`,
// fetch() followed the redirect to `/` (the HOST shell under hostShellAtRoot,
// 200), `res.ok` was true, so the host document was cached under the shell key
// and served for every /app pane → infinite host-in-host recursion.
//
// The static source guards (sw-coalesce-mirror / sw-host-exclusion) could not
// see this: they pin text, not behavior. This spec loads the real sw.js into a
// node:vm sandbox with a fake origin modeled on the production server and
// drives its activate + fetch listeners:
//   - the shell is fetched from /app (never a redirecting path);
//   - a REDIRECTED shell response is never cached nor served as the pane
//     document (the navigation is handed to the network instead);
//   - activate reaps a prior build's (possibly poisoned) cache.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SW_SRC = readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8");
const ORIGIN = "https://solara.test";
const APP_SHELL = "<!doctype html><title>VHSolara</title>";
const HOST_SHELL = "<!doctype html><title>VHSolara · Host</title>";

type Handler = (url: string, input: unknown) => Response;

// A followed redirect: what fetch() hands back after transparently following a
// 301 — a 200 whose `redirected` flag is set (constructed Responses can't set it).
function redirectedTo(body: string): Response {
  const r = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(r, "redirected", { value: true });
  return r;
}

// The pre-fix production server: /index.html → 301 ./ → / (host shell).
const prodServer: Handler = (url) => {
  const p = new URL(url, ORIGIN).pathname;
  if (p === "/index.html") return redirectedTo(HOST_SHELL);
  if (p === "/app" || p.startsWith("/app/")) return new Response(APP_SHELL, { status: 200 });
  if (p === "/") return new Response(HOST_SHELL, { status: 200 });
  return new Response("", { status: 404 });
};

class FakeCache {
  store = new Map<string, Response>();
  private key(k: unknown): string {
    const u = typeof k === "string" ? k : (k as { url: string }).url;
    return new URL(u, ORIGIN).href;
  }
  async match(k: unknown) {
    const r = this.store.get(this.key(k));
    return r ? r.clone() : undefined;
  }
  async put(k: unknown, r: Response) {
    this.store.set(this.key(k), r);
  }
}

class FakeCacheStorage {
  map = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.map.has(name)) this.map.set(name, new FakeCache());
    return this.map.get(name)!;
  }
  async keys() {
    return [...this.map.keys()];
  }
  async delete(name: string) {
    return this.map.delete(name);
  }
}

function loadSW(handler: Handler, scope = "/") {
  const listeners: Record<string, (e: unknown) => void> = {};
  const caches = new FakeCacheStorage();
  const fetched: string[] = [];
  const fetchFn = async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    fetched.push(typeof input === "string" ? `str:${new URL(url, ORIGIN).pathname}` : `req:${new URL(url).pathname}`);
    return handler(url, input);
  };
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      listeners[t] = fn;
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: { scope: ORIGIN + scope },
  };
  const ctx = vm.createContext({
    self,
    caches,
    fetch: fetchFn,
    location: { origin: ORIGIN },
    Response,
    Headers,
    URL,
    Map,
    Promise,
    Date,
    Number,
    String,
    console,
  });
  vm.runInContext(SW_SRC, ctx);

  async function activate() {
    let p: Promise<unknown> = Promise.resolve();
    listeners.activate({ waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  }
  async function navigate(path: string, cache = "default"): Promise<Response | undefined> {
    let p: Promise<Response> | undefined;
    const request = { method: "GET", url: ORIGIN + path, mode: "navigate", cache, headers: new Headers() };
    listeners.fetch({ request, respondWith: (x: Promise<Response>) => (p = x) });
    return p ? await p : undefined;
  }
  async function shellEntry(): Promise<string | undefined> {
    for (const name of await caches.keys()) {
      const r = await (await caches.open(name)).match("/index.html");
      if (r) return r.text();
    }
    return undefined;
  }
  return { activate, navigate, shellEntry, caches, fetched };
}

describe("sw.js shell never caches/serves a redirected (host) document", () => {
  for (const scope of ["/", "/app"]) {
    it(`[scope ${scope}] /app pane is served the single-server shell against the prod server`, async () => {
      const sw = loadSW(prodServer, scope);
      await sw.activate();
      expect(await sw.shellEntry(), "activate precache holds the APP shell").toBe(APP_SHELL);
      const res = await sw.navigate("/app", "reload"); // bypass → network path
      expect(await res!.text()).toBe(APP_SHELL);
      expect(await sw.shellEntry()).toBe(APP_SHELL);
      expect(sw.fetched).not.toContain("str:/index.html");
    });
  }

  it("a redirected shell response is neither cached nor served; the navigation goes to the network", async () => {
    const PASS = "<!doctype html><title>native navigation</title>";
    // Worst case: the shell URL itself redirects to the host shell. A navigation
    // Request (not the SW's own string fetch) models the browser's native load.
    const sw = loadSW((url, input) => {
      if (typeof input !== "string") return new Response(PASS, { status: 200 });
      return redirectedTo(HOST_SHELL);
    });
    await sw.activate();
    expect(await sw.shellEntry(), "activate must not precache a redirected response").toBeUndefined();
    const res = await sw.navigate("/app");
    const body = await res!.text();
    expect(body).not.toContain("· Host");
    expect(body).toBe(PASS);
    expect(await sw.shellEntry(), "fetch handler must not cache a redirected response").toBeUndefined();
  });

  it("activate reaps a prior build's poisoned shell cache (BUILD_ID recovery)", async () => {
    const sw = loadSW(prodServer);
    const old = await sw.caches.open("vh-OLDBUILD");
    await old.put("/index.html", new Response(HOST_SHELL));
    await sw.activate();
    expect(await sw.caches.keys()).not.toContain("vh-OLDBUILD");
    expect(await sw.shellEntry()).toBe(APP_SHELL);
    const res = await sw.navigate("/app"); // fresh entry → zero-network serve
    expect(await res!.text()).toBe(APP_SHELL);
  });
});
