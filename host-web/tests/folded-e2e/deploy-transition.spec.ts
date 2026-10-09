import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { LAYOUT_STORAGE_KEY, iframeSrcs } from "../e2e/util";

// =============================================================================
// FOLDED-POSTURE deploy-transition e2e — the BUILD_ID deploy lane (lane-9
// posture: real binary, production fold topology, dispatchable NOT PR-blocking).
//
// This lane closes the deferral recorded in folded-sw-narrow.spec.ts:
// "the deploy-transition shape (BUILD_ID bump → bounded reloads) … needs a
// second binary + port swap mid-test — new lane infra, out of this slice's
// scope." It ports the S3a X6 cross-reload matrix (tmp-only fixture servers)
// onto the REAL binary path: TWO vh-solara `local-server` binaries built from
// the same tree with DIFFERENT BUILD_ID stamps (the swBuildId vite plugin
// stamps web/public/sw.js's `__BUILD_ID__` per build — every real deploy does
// exactly this), booted on the SAME port mid-test to model a deploy swap.
//
// SCENARIO (per engine):
//   1. boot binary A (stamp X) → folded host at `/` → restore a planted
//      3-pane layout (same-origin `/app?pane=N` iframes, born SW-controlled
//      via the S3b gate) → warm: panes narrow-controlled, served stamp X,
//      CacheStorage exactly ["vh-X"].
//   2. THE DEPLOY: kill A, boot binary B (stamp Y) on the SAME port.
//   3. Drive the update the way the product does: `registration.update()` —
//      the same public verb web/src/pwa.ts itself calls on visibilitychange/
//      hourly cadence (called directly here so the check is immediate instead
//      of hourly; the byte-diff → install → skipWaiting → claim →
//      controllerchange → guard-reload chain beyond it is 100% product code).
//      Driven from BOTH a pane (longest-scope getRegistration) and the host
//      (explicit "/app" registration) so the drive does not depend on which
//      registration an engine resolves first. NOTE: the pwa.ts version-poll
//      path (/vh/version) is INERT here by construction: both binaries are
//      unstamped local builds reporting version "dev" — the SW byte-diff
//      machinery is the only deploy signal, which is exactly the BUILD_ID
//      semantics under test.
//
// ORACLE (engine-truthful, document-level): a context init script counts
// DOCUMENT creations per pane (`?pane=N` keyed; the performance navigation
// entry classifies reload-typed boots). Same-document navigations (e.g. the
// host's debounced `#state=` hash saves) create NO document and cannot
// pollute these counts — Playwright's framenavigated (also recorded, receipt
// only) DOES emit for same-document navigations and is not assertable.
//
// ASSERTIONS (the four transition invariants):
//   (1) each controlled pane reloads EXACTLY ONCE onto the new deploy —
//       per-pane: birth + exactly one reload-typed boot (zero or ≥2 fails),
//       aggregate reload-typed /app boots === pane count;
//   (2) the HOST document is NOT reloaded (zero reload-typed host boots,
//       host document-creation count unchanged across the swap, a host
//       window marker set before the swap survives);
//   (3) old-stamp caches are reaped, the new cache is populated, zero
//       residual old-stamp entries: CacheStorage keys exactly ["vh-Y"];
//   (4) panes remain SW-controlled through the transition (controller
//       scriptURL /sw.js in every pane at the end).
// Plus the X6 no-loop proof: counts identical across a stability window.
//
// HONEST LIMITS (receipted, not hidden):
//   - The swap-on-same-port models a deploy restart; a real deploy may also
//     change hashed asset bytes (here only sw.js differs — the minimal, and
//     harder-for-SW-detection, deploy delta the BUILD_ID mechanism exists
//     for; asset-byte churn is cache-first misses and not exercised).
//   - The pane reload responses' served shells are byte-identical between A
//     and B; "onto stamp Y" is proven by composition (controller change +
//     single vh-Y cache + served sw.js stamp Y), not by document bytes.
//   - update() is driven explicitly (product cadence is visibilitychange/
//     hourly — too slow for a test); Chromium throttles rapid update checks,
//     so the drive retries with settles (X6 c4 precedent).
//
//   - EMPTY-CACHE-NAME RESURRECTION (observed on BOTH chromium and firefox,
//     deterministically): a terminating old-stamp worker's fetch handler can
//     `caches.open("vh-X")` AFTER the new worker's activation reap deleted
//     it (sw.js opens the cache unconditionally at handler start; the dead-
//     server/no-put paths then never fill it) — the old-stamp NAME reappears
//     holding ZERO entries. The lane asserts the materially-load-bearing
//     form — ZERO residual old-stamp ENTRIES + the new cache populated — and
//     receipts any resurrected empty name under residualOldStampCaches for
//     coordinator disposition (product hardening candidate, not a serving
//     defect: nothing stale is servable from an empty cache, and the next
//     deploy's reap removes the name).
//
// INFRA: the spec itself spawns/kills/swaps the two binaries (a config-level
// webServer cannot express a mid-test port swap). Requires the runner
// host-web/scripts/deploy-transition-run.sh (or make
// test-host-web-deploy-transition) to have built both binaries + written
// artifacts/stamps.json first. Serial (workers:1). Zero product changes: all
// observation is public web APIs (CacheStorage, performance navigation
// entries, navigator.serviceWorker) + DOM.
// =============================================================================

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const artifacts =
  process.env.VH_DEPLOY_ARTIFACTS ?? path.join(repoRoot, "tmp/agent-runs/page-load-perf-deploy-lane");

const PORT = Number(process.env.VH_DEPLOY_PORT ?? 8821);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BIN_A = process.env.VH_DEPLOY_BIN_A ?? path.join(repoRoot, "tmp/vh-solara-deploy-a");
const BIN_B = process.env.VH_DEPLOY_BIN_B ?? path.join(repoRoot, "tmp/vh-solara-deploy-b");

/** Panes in the planted layout (mission range 2–4; X6 precedent is 3). */
const PANE_COUNT = 3;

// --- server management (the deploy swap) -------------------------------------

interface ServerHandle {
  child: ChildProcess;
  stopping: boolean;
  gone: boolean;
  /** Set ONLY on an exit we did not order (a crash) — fails fast. */
  exitInfo: { code: number | null; signal: string | null } | null;
  output: () => string;
}

function spawnServer(bin: string, tag: string): ServerHandle {
  if (!existsSync(bin)) {
    throw new Error(
      `${tag} binary not found at ${bin} — run \`bash host-web/scripts/deploy-transition-run.sh\` first`,
    );
  }
  // One SHARED state dir for both binaries: a real deploy keeps the server's
  // persisted state; isolating per-binary would model a fresh install instead.
  const stateDir = path.join(artifacts, "state");
  const child = spawn(
    bin,
    ["local-server", "--addr", `127.0.0.1:${PORT}`, "--opencode-url", "http://127.0.0.1:1"],
    { cwd: repoRoot, env: { ...process.env, VH_STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const handle: ServerHandle = {
    child,
    stopping: false,
    gone: false,
    exitInfo: null,
    output: () => out,
  };
  let out = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
  });
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  child.once("exit", (code, signal) => {
    handle.gone = true;
    if (!handle.stopping) handle.exitInfo = { code, signal };
  });
  return handle;
}

async function waitReady(h: ServerHandle, what: string): Promise<void> {
  // local-server probes the (deliberately dead) --opencode-url for up to 30s
  // BEFORE binding its HTTP listener ("local-server stays up; opencode
  // status=failed") — the lane-9 webServer allows 60s for the same boot.
  const deadline = Date.now() + 75_000;
  for (;;) {
    if (h.exitInfo) {
      throw new Error(
        `${what} exited early (code=${h.exitInfo.code} signal=${h.exitInfo.signal}):\n${h.output().slice(-4000)}`,
      );
    }
    try {
      const r = await fetch(`${ORIGIN}/`);
      if (r.ok) return;
    } catch {
      /* not accepting connections yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} never became ready on ${ORIGIN}:\n${h.output().slice(-4000)}`);
    }
    await new Promise((res) => setTimeout(res, 250));
  }
}

async function stopServer(h: ServerHandle): Promise<void> {
  if (h.gone) return;
  h.stopping = true;
  const exited = new Promise<void>((res) => h.child.once("exit", res));
  h.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((res) => setTimeout(res, 5000))]);
  if (!h.gone) {
    h.child.kill("SIGKILL");
    await exited;
  }
  // Release grace: let the kernel close the listener fd before B rebinds.
  await new Promise((res) => setTimeout(res, 300));
}

// --- production-safe page probes ----------------------------------------------

/** The BUILD_ID currently served in /sw.js bytes (no-store → network truth). */
async function servedStamp(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const r = await fetch("/sw.js", { cache: "no-store" });
    const t = await r.text();
    const m = t.match(/const BUILD_ID = "([^"]+)"/);
    return m ? m[1] : null;
  });
}

/** Origin-wide CacheStorage keys, sorted (host page — same origin as panes). */
async function cacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await caches.keys()).slice().sort());
}

/** Per-cache entry URL list (sorted) — makes any residual old-stamp cache's
 * CONTENTS inspectable (which requests resurrected it). */
async function cacheContents(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      const reqs = await c.keys();
      out[k] = reqs.map((r) => new URL(r.url).pathname + new URL(r.url).search).sort();
    }
    return out;
  });
}

/** The deploy cache contract: the new-stamp cache exists AND is populated
 * (shell precached), and every residual old-stamp cache holds ZERO entries
 * (an empty resurrected NAME is receipted, any residual ENTRY is a defect). */
function cacheStateOk(
  keys: string[],
  contents: Record<string, string[]>,
  newKey: string,
): { ok: boolean; residual: Record<string, string[]>; newCachePopulated: boolean } {
  const residual: Record<string, string[]> = {};
  for (const k of keys) if (k !== newKey) residual[k] = contents[k] ?? ["<unread>"];
  const newEntries = contents[newKey] ?? [];
  const newCachePopulated =
    keys.includes(newKey) && newEntries.includes("/index.html") && newEntries.length > 0;
  const residualEmpty = Object.values(residual).every((v) => v.length === 0);
  return { ok: newCachePopulated && residualEmpty, residual, newCachePopulated };
}

/** The live planted pane frames (`/app?pane=N` — the self-seed pane has no query). */
function livePaneFrames(page: Page): Frame[] {
  return page.frames().filter((f) => f.url().startsWith(`${ORIGIN}/app?pane=`));
}

/** Controller script url PATHNAME per pane ("loading" while mid-navigation —
 * poll). scriptURL is absolute; the pathname normalizes it to "/sw.js". */
async function paneControllers(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const f of livePaneFrames(page)) {
    try {
      out.push(
        await f.evaluate(() => {
          const u = navigator.serviceWorker.controller?.scriptURL;
          return u ? new URL(u).pathname : "uncontrolled";
        }),
      );
    } catch {
      out.push("loading");
    }
  }
  return out;
}

/** All vh-deploy-* counters accumulated by the init script (tab-wide —
 * same-origin iframes share the tab's sessionStorage with the host). */
async function readCounters(page: Page): Promise<Record<string, string>> {
  const all = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith("vh-deploy-")) out[k] = sessionStorage.getItem(k) ?? "";
    }
    return out;
  });
  return all;
}

/** per-pane reload-typed boots, e.g. { "1": "0", "2": "0", "3": "0" }. */
function paneReloads(c: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (let n = 1; n <= PANE_COUNT; n++) out[String(n)] = c[`vh-deploy-pane-${n}-reloads`] ?? "0";
  return out;
}

/** Registration inventory (scope + worker states) — diagnostics for the drive. */
async function registrations(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return Promise.all(
      regs.map(async (r) => ({
        scope: new URL(r.scope).pathname,
        updateViaCache: String(r.updateViaCache),
        active: r.active
          ? { scriptURL: new URL(r.active.scriptURL).pathname, state: r.active.state }
          : null,
        installing: r.installing
          ? { scriptURL: new URL(r.installing.scriptURL).pathname, state: r.installing.state }
          : null,
        waiting: r.waiting
          ? { scriptURL: new URL(r.waiting.scriptURL).pathname, state: r.waiting.state }
          : null,
      })),
    );
  });
}

/** Plant a 3-pane v3 blob — the folded-restore planted-blob shape, with a
 * per-pane query (`/app?pane=N`) so frames + counters stay identifiable
 * across reloads. MUST run while the page is ON the origin (localStorage
 * unreachable on about:blank). */
async function plantThreePanes(page: Page): Promise<void> {
  await page.evaluate(({ key, origin }) => {
    const leaf = (id: string, frac: number) => ({
      type: "leaf",
      fraction: frac,
      data: { id: `g-${id}`, views: [id], activeView: id },
    });
    const blob = {
      v: 3,
      activeWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          layout: {
            grid: {
              root: {
                type: "branch",
                data: [
                  leaf("pane-1", 1 / 3),
                  leaf("pane-2", 1 / 3),
                  leaf("pane-3", 1 / 3),
                ],
                width: 1024,
                height: 768,
                orientation: "HORIZONTAL",
              },
              width: 1024,
              height: 768,
              orientation: "HORIZONTAL",
            } as unknown,
            panels: {
              "pane-1": { id: "pane-1", params: { url: `${origin}/app?pane=1`, label: "this-server" } },
              "pane-2": { id: "pane-2", params: { url: `${origin}/app?pane=2`, label: "this-server" } },
              "pane-3": { id: "pane-3", params: { url: `${origin}/app?pane=3`, label: "this-server" } },
            } as unknown,
            activeGroup: "g-pane-1",
          } as unknown,
        },
      ],
    };
    localStorage.setItem(key, JSON.stringify(blob));
    history.replaceState(null, "", window.location.pathname);
  }, { key: LAYOUT_STORAGE_KEY, origin: ORIGIN });
}

// --- the lane -----------------------------------------------------------------

test.describe.serial("folded deploy-transition (BUILD_ID bump on the real binary path)", () => {
  test("old SW/shell → deploy swap → exactly-one pane reload, host intact, cache reaped", async ({ page }, testInfo) => {
    test.setTimeout(360_000); // two ~32s server boots (dead-opencode probe) + warm + swap + retries
    const engine = testInfo.project.name;

    // The build receipt (written by the runner) maps binary A/B → stamps.
    const stampsPath = path.join(artifacts, "stamps.json");
    expect(
      existsSync(stampsPath),
      `missing ${stampsPath} — run \`bash host-web/scripts/deploy-transition-run.sh\` first`,
    ).toBe(true);
    const stamps = JSON.parse(readFileSync(stampsPath, "utf8")) as { a: string; b: string };
    expect(stamps.a, "binary A stamp present").toBeTruthy();
    expect(stamps.b, "binary B stamp present").toBeTruthy();
    expect(stamps.a, "the two binaries must carry DIFFERENT BUILD_ID stamps").not.toBe(stamps.b);

    // The document-level oracle: counts DOCUMENT creations (boots) and
    // reload-typed boots, per pane (?pane=N) and for the host. Survives
    // reloads via the tab's sessionStorage (same-origin iframes share it).
    await page.addInitScript(() => {
      try {
        const navType =
          (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)
            ?.type ?? "unknown";
        const bump = (k: string) =>
          sessionStorage.setItem(k, String(Number(sessionStorage.getItem(k) ?? "0") + 1));
        if (location.pathname === "/app") {
          bump("vh-deploy-pane-boots");
          if (navType === "reload") bump("vh-deploy-pane-reloads");
          const m = location.search.match(/[?&]pane=(\d+)/);
          if (m) {
            bump(`vh-deploy-pane-${m[1]}-boots`);
            if (navType === "reload") bump(`vh-deploy-pane-${m[1]}-reloads`);
          }
        } else if (location.pathname === "/") {
          bump("vh-deploy-host-boots");
          if (navType === "reload") bump("vh-deploy-host-reloads");
        }
      } catch {
        /* storage sealed — the frame-event record below still runs */
      }
    });

    // Pane-document responses; SW-served shells carry the x-vh-sw-at stamp
    // header (a reload bypasses the fresh-cache serve → network → observed).
    const paneResponses: { url: string; stamped: boolean; phase: "a" | "b" }[] = [];
    let phase: "a" | "b" = "a";
    page.on("response", (res) => {
      const u = res.url();
      if (u.startsWith(`${ORIGIN}/app?pane=`)) {
        void res
          .allHeaders()
          .then((h) => paneResponses.push({ url: u, stamped: h["x-vh-sw-at"] !== undefined, phase }))
          .catch(() => paneResponses.push({ url: u, stamped: false, phase }));
      }
    });

    // Frame-event record (RECEIPT ONLY — framenavigated also fires for
    // same-document navigations such as the host's debounced #state= hash
    // saves, so these counts are evidence, never assertions).
    const paneNavs = new Map<Frame, number>();
    let hostNavEvents = 0;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) hostNavEvents++;
      else if (f.url().startsWith(`${ORIGIN}/app?pane=`))
        paneNavs.set(f, (paneNavs.get(f) ?? 0) + 1);
    });

    // ---- 1. boot binary A (stamp X) ----------------------------------------
    const serverA = spawnServer(BIN_A, "binary A");
    try {
      await waitReady(serverA, "binary A");

      // ---- 2. folded host: self-seed boot, plant 3 panes, relaunch ---------
      await page.goto("/");
      await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();
      await expect
        .poll(async () => (await iframeSrcs(page)).length, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(1);
      await plantThreePanes(page);
      await page.goto("/");
      await expect
        .poll(async () => (await iframeSrcs(page)).length, { timeout: 20_000 })
        .toBe(PANE_COUNT);
      expect((await iframeSrcs(page)).every((s) => s.startsWith(`${ORIGIN}/app?pane=`))).toBe(true);

      // ---- 3. old-deploy posture ------------------------------------------
      // Panes born SW-controlled (S3b gate) and stay controlled once warm.
      await expect
        .poll(async () => (await paneControllers(page)).join(","), { timeout: 20_000 })
        .toBe(Array.from({ length: PANE_COUNT }, () => "/sw.js").join(","));
      // Binary A serves its own stamp; CacheStorage holds ONLY the old cache.
      expect(await servedStamp(page), "binary A serves stamp X").toBe(stamps.a);
      await expect
        .poll(async () => cacheKeys(page), { timeout: 15_000 })
        .toEqual([`vh-${stamps.a}`]);

      // Warm + let both registrations (narrow + root) settle at stamp X.
      await page.waitForTimeout(4000);

      // ---- 4. baseline ------------------------------------------------------
      const cacheKeysBefore = await cacheKeys(page);
      const countersBaseline = await readCounters(page);
      const regsBaseline = await registrations(page);
      // Each planted pane has booted exactly ONCE so far (its birth), and no
      // pane has reload-booted; the host has booted exactly twice (the two
      // gotos) with zero reloads.
      expect(paneReloads(countersBaseline), "baseline: no pane reloads yet").toEqual({
        "1": "0",
        "2": "0",
        "3": "0",
      });
      for (let n = 1; n <= PANE_COUNT; n++) {
        expect(countersBaseline[`vh-deploy-pane-${n}-boots`]).toBe("1");
      }
      const hostBootsBaseline = countersBaseline["vh-deploy-host-boots"] ?? "0";
      expect(hostBootsBaseline, "baseline: host booted once per goto").toBe("2");
      await page.evaluate(() => {
        (window as unknown as { __vhDeployLaneHostMarker?: string }).__vhDeployLaneHostMarker =
          "alive";
      });

      // ---- 5. THE DEPLOY: kill A, boot B on the SAME port -----------------
      await stopServer(serverA);
      const serverB = spawnServer(BIN_B, "binary B");
      try {
        phase = "b";
        await waitReady(serverB, "binary B");

        // The swap alone must create NO pane/host documents (deploy ≠
        // reconnect storm; the SPA reconnects its streams without reloading).
        const countersPostSwap = await readCounters(page);
        expect(paneReloads(countersPostSwap), "server swap alone: zero pane reloads").toEqual({
          "1": "0",
          "2": "0",
          "3": "0",
        });
        expect(
          countersPostSwap["vh-deploy-host-boots"] ?? "0",
          "server swap alone: no new host document",
        ).toBe(hostBootsBaseline);

        // The server now serves stamp Y (B's embedded sw.js bytes).
        await expect
          .poll(async () => servedStamp(page), { timeout: 20_000 })
          .toBe(stamps.b);

        // ---- 6. drive the update the product way: registration.update() --
        // From a pane (longest-scope getRegistration → narrow) AND from the
        // host (explicit "/app"), so the drive is engine-agnostic. Chromium
        // throttles update checks following a recent soft check → bounded
        // retries with settles (X6 c4 precedent).
        const driveLog: unknown[] = [];
        let updateDrives = 0;
        // Breakdown (not a bare boolean) so a red run NAMES the failing piece.
        let lastBreakdown: Record<string, unknown> = {};
        const breakdown = async () => {
          const c = await readCounters(page);
          const reloads = paneReloads(c);
          const keys = await cacheKeys(page);
          const contents = await cacheContents(page);
          const cs = cacheStateOk(keys, contents, `vh-${stamps.b}`);
          const ctrl = await paneControllers(page);
          lastBreakdown = {
            cachesOk: cs.ok,
            reloadsOk:
              Object.keys(reloads).length === PANE_COUNT &&
              Object.values(reloads).every((v) => v === "1"),
            controllersOk: ctrl.length === PANE_COUNT && ctrl.every((x) => x === "/sw.js"),
            reloads,
            cacheKeys: keys,
            cacheContents: contents,
            residualOldStampCaches: cs.residual,
            newCachePopulated: cs.newCachePopulated,
            controllers: ctrl,
            counters: c,
          };
          const b = lastBreakdown as { cachesOk: boolean; reloadsOk: boolean; controllersOk: boolean };
          return b.cachesOk && b.reloadsOk && b.controllersOk;
        };
        const landed = async () => await breakdown();
        for (let i = 0; i < 6; i++) {
          if (await landed()) break;
          updateDrives++;
          const pane1 = page.frames().find((f) => f.url().startsWith(`${ORIGIN}/app?pane=1`));
          const paneScope = pane1
            ? await pane1
                .evaluate(async () => {
                  const reg = await navigator.serviceWorker.getRegistration();
                  await reg?.update();
                  return reg ? new URL(reg.scope).pathname : null;
                })
                .catch((e: unknown) => `error: ${String(e)}`)
            : "no-pane-frame";
          const hostScope = await page
            .evaluate(async () => {
              const reg = await navigator.serviceWorker.getRegistration("/app");
              await reg?.update();
              return reg ? new URL(reg.scope).pathname : null;
            })
            .catch((e: unknown) => `error: ${String(e)}`);
          driveLog.push({
            drive: updateDrives,
            paneScope,
            hostScope,
            regs: await registrations(page),
            caches: await cacheKeys(page),
            reloads: paneReloads(await readCounters(page)),
          });
          await page.waitForTimeout(5000);
        }

        // Diagnostics receipt FIRST (also lands on failure — see honesty
        // limits): whatever the assert verdict, the state is inspectable.
        const countersFinalPre = await readCounters(page);
        const diagnostics = {
          engine,
          lane: "deploy-transition",
          stamps: { a: stamps.a, b: stamps.b },
          updateDrives,
          driveLog,
          regsBaseline,
          regsFinal: await registrations(page),
          countersBaseline,
          countersFinalPre,
          lastBreakdown,
          cacheKeysBefore,
          cacheKeysFinalPre: await cacheKeys(page),
          cacheContentsFinalPre: await cacheContents(page),
          controllersFinalPre: await paneControllers(page),
          servedStampFinalPre: await servedStamp(page),
          frameEventRecord: {
            // receipt-only (same-document navigations included)
            paneNavsPostAttach: [...paneNavs.values()].sort(),
            hostNavEventsPostAttach: hostNavEvents,
          },
        };
        mkdirSync(path.join(artifacts, "receipts"), { recursive: true });
        writeFileSync(
          path.join(artifacts, "receipts", `deploy-transition-${engine}.json`),
          JSON.stringify(diagnostics, null, 2) + "\n",
        );

        // Manual poll (current-breakdown reporting): a second reload wave or
        // cache regression DURING this window must be named, not just "false".
        let landedOk = false;
        const pollDeadline = Date.now() + 15_000;
        while (Date.now() < pollDeadline) {
          if (await landed()) {
            landedOk = true;
            break;
          }
          await page.waitForTimeout(500);
        }
        if (!landedOk) {
          writeFileSync(
            path.join(artifacts, "receipts", `deploy-transition-${engine}.json`),
            JSON.stringify({ ...diagnostics, verdict: "red", lastBreakdown }, null, 2) + "\n",
          );
          throw new Error(
            `SW update transition not landed after ${updateDrives} registration.update() drives + 15s; CURRENT breakdown: ${JSON.stringify(lastBreakdown)}`,
          );
        }

        // ---- 7. the four transition invariants -----------------------------

        // (1) exactly ONE reload per pane: every pane's document count went
        // 1 → 2 via exactly one reload-typed boot (zero = missed reload,
        // ≥2 = reload loop).
        const counters = await readCounters(page);
        for (let n = 1; n <= PANE_COUNT; n++) {
          expect(
            counters[`vh-deploy-pane-${n}-reloads`] ?? "0",
            `pane ${n}: exactly one reload-typed boot`,
          ).toBe("1");
          expect(counters[`vh-deploy-pane-${n}-boots`] ?? "0", `pane ${n}: birth + reload only`).toBe("2");
        }
        expect(
          counters["vh-deploy-pane-reloads"],
          "aggregate: one reload per pane",
        ).toBe(String(PANE_COUNT));
        expect(counters["vh-deploy-pane-boots"]).toBe(String(1 + 2 * PANE_COUNT));

        // (2) the HOST document was NOT reloaded.
        expect(counters["vh-deploy-host-reloads"] ?? "0", "host reload-typed boots").toBe("0");
        expect(counters["vh-deploy-host-boots"] ?? "0", "host document count unchanged").toBe(
          hostBootsBaseline,
        );
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { __vhDeployLaneHostMarker?: string }).__vhDeployLaneHostMarker ??
              null,
          ),
          "host window marker survived (host document never navigated)",
        ).toBe("alive");

        // (3) old-stamp caches reaped (ZERO residual old-stamp ENTRIES — any
        // surviving entry is a defect), new cache populated with the shell.
        // An empty resurrected old-stamp NAME (see header) is receipted for
        // coordinator disposition, not silently ignored.
        const cacheKeysAfter = await cacheKeys(page);
        const cacheContentsAfter = await cacheContents(page);
        const cs = cacheStateOk(cacheKeysAfter, cacheContentsAfter, `vh-${stamps.b}`);
        expect(cs.newCachePopulated, "new-stamp cache populated (shell precached)").toBe(true);
        for (const [name, entries] of Object.entries(cs.residual)) {
          expect(
            entries,
            `residual old-stamp cache ${name} must hold ZERO entries (empty-name resurrection → receipt)`,
          ).toEqual([]);
        }
        expect(cacheKeysAfter).toContain(`vh-${stamps.b}`);

        // (4) panes remain SW-controlled through the transition.
        expect(await paneControllers(page), "every pane controlled by /sw.js").toEqual(
          Array.from({ length: PANE_COUNT }, () => "/sw.js"),
        );

        // Every observed pane document response was SW-served (x-vh-sw-at);
        // the post-swap reloads bypass the fresh-cache serve (request.cache
        // "reload"/"no-cache") → at least those are observed network-side.
        for (const r of paneResponses) {
          expect(r.stamped, `pane doc ${r.url} (${r.phase}) must be SW-served`).toBe(true);
        }
        expect(
          paneResponses.filter((r) => r.phase === "b").length,
          "post-swap pane reload responses observed",
        ).toBeGreaterThanOrEqual(PANE_COUNT);

        // ---- 8. no-loop stability window (X6 discipline) -------------------
        const stable = {
          counters: await readCounters(page),
          caches: await cacheKeys(page),
          residualNames: Object.keys(cs.residual),
          populated: cs.newCachePopulated,
        };
        await page.waitForTimeout(3000);
        expect(await readCounters(page), "stability: document counters unchanged").toEqual(
          stable.counters,
        );
        const stableCaches = await cacheKeys(page);
        const stableCs = cacheStateOk(
          stableCaches,
          await cacheContents(page),
          `vh-${stamps.b}`,
        );
        expect(stableCaches, "stability: cache names unchanged").toEqual(stable.caches);
        expect(stableCs.ok, "stability: cache state still contract-clean").toBe(true);
        expect(Object.keys(stableCs.residual), "stability: same residual names").toEqual(
          stable.residualNames,
        );

        // ---- final receipt (overwrites the diagnostics-only one) -----------
        const receipt = {
          ...diagnostics,
          verdict: "green",
          countersFinal: await readCounters(page),
          cacheKeysAfter: await cacheKeys(page),
          cacheContentsAfter: await cacheContents(page),
          controllers: await paneControllers(page),
          paneResponses: paneResponses.map((r) => ({
            url: r.url.replace(ORIGIN, ""),
            stamped: r.stamped,
            phase: r.phase,
          })),
        };
        writeFileSync(
          path.join(artifacts, "receipts", `deploy-transition-${engine}.json`),
          JSON.stringify(receipt, null, 2) + "\n",
        );
      } finally {
        await stopServer(serverB);
      }
    } finally {
      await stopServer(serverA);
    }
  });
});
