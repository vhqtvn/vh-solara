import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// PWA kill/relaunch persistence gate — proves the host state (workspace set +
// names + layouts + active workspace) survives the Android-PWA kill cycle:
// mutate → the process dies → relaunch at the CLEAN start_url (no hash) → the
// localStorage mirror is the ONLY restore source → state must be there.
//
// WRITE PATH (2026-08-31 hardening — the structural fix): scheduleSave() now
// writes the localStorage MIRROR SYNCHRONOUSLY (microtask-coalesced to one
// write per JS task) on EVERY mutation, and the 450ms debounce survives ONLY
// for the URL-hash replaceState (history churn is what the debounce existed
// for). The kill-timing dependency therefore collapses from "the page lived
// 450ms AND fired a hide-family event" (the c557b1b flush-on-hide anchors —
// still installed: visibilitychange→hidden + freeze + pagehide, all flushing
// BOTH mirrors synchronously) to "the mutation's event handler ran", which
// every real kill sequence satisfies: the mutation happens on the foregrounded
// page, BEFORE any backgrounding. The strongest crux below (instant kill, NO
// hide grace) failed even WITH c557b1b when the kill preceded the hide.
//
// ROOT CAUSE HISTORY (src/dockview/layoutPersistence.ts): saves were DEBOUNCED
// (450ms) and flushed only by the timer. Android kills backgrounded PWAs
// without firing reliable unload events at kill time — the LAST events the
// page gets are the transition to HIDDEN / freeze / pagehide when the operator
// backgrounds the app; the later kill is silent. c557b1b anchored a synchronous
// flush on those events. The residual on-device loss (2026-08-31) is diagnosed
// via the always-on diag ring (layoutDiag.ts): read source/origin, flush
// trigger/bytes, seeds — surfaced through Settings → "Copy layout diagnostics"
// and asserted unit-grade at the bottom of this spec.
//
// KILL MECHANISM (empirically probed on chromium AND firefox before this spec
// was written; probes deleted after):
//   • `page.close()` fires `visibilitychange→hidden` then `pagehide` before
//     death — BUT the app's close-time flush was observed NONDETERMINISTIC on
//     firefox (two probe runs: one committed the blob at the close-time hidden
//     event, one did not — while an independently-registered later listener's
//     synchronous write DID commit both times; close-time teardown races the
//     handler). A correct fix therefore must NOT depend on close-time events —
//     and neither does Android: the page is hidden while LIVE (screen off /
//     home / switch / swipe-away), the process is killed LATER, silently.
//   • `sibling.bringToFront()` does NOT fire visibilitychange in headless
//     chromium/firefox — a genuine hidden state cannot be produced that way.
//
// THE CRUXES reproduce the real Android sequences deterministically:
//   CRUX A (instant kill — the NEW strongest guarantee): mutate → the mirror is
//     already written (microtask) → kill IMMEDIATELY (navigate to about:blank;
//     every pending timer dies) → fresh page at clean `/` → restored. No hide
//     grace at all — this failed under BOTH the pre-fix debounce and c557b1b's
//     hide-anchored flush when the kill preceded the hide.
//   CRUX B (the Android sequence): mutate → HIDE ON THE LIVE PAGE (patch
//     `document.visibilityState` → "hidden" and dispatch a REAL
//     `visibilitychange` through the app's REAL listener — headless cannot
//     produce a genuine hidden state; probed) → kill → relaunch → restored.
//
// HONESTY LIMITS, stated up front:
//   • A kill with NO prior hide event AND no completed-mutation mirror write
//     (renderer killed while VISIBLE mid-task) is inherently unfixable from web
//     code: nothing fired, nothing ran. Real Android never does this —
//     backgrounding always hides the page first, and mutations complete on the
//     foregrounded page.
//   • The visibilitychange hide is produced by patching visibilityState because
//     headless tab-switching fires nothing (probed); the listener, the event
//     dispatch, and the synchronous flush are all real.
//   • Android-native kill is NOT headlessly demonstrable (the mission's own
//     honesty caveat) — the on-device diag ring is the verification net for any
//     residual divergence the proxies cannot see.
// =============================================================================

/** Read + parse the raw v3 blob from the host origin's localStorage. */
async function readPersisted(page: Page): Promise<{
  activeWorkspaceId?: string;
  workspaces?: Array<{ id?: string; name?: string }>;
} | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, H.LAYOUT_STORAGE_KEY);
}

/** True when the v3 blob already carries workspace `wsId` with `name`. */
async function persistedHasWorkspace(
  page: Page,
  wsId: string,
  name?: string,
): Promise<boolean> {
  const blob = await readPersisted(page);
  const ws = blob?.workspaces?.find((w) => w.id === wsId);
  if (!ws) return false;
  return name === undefined || ws.name === name;
}

test.describe("PWA kill/relaunch persistence", () => {
  test("CRUX A (strongest): instant kill, NO hide grace — mutate → kill immediately → restored", async ({
    page,
    context,
  }) => {
    // ---- Session 1: the "PWA process". Fresh context → seed loads.
    await H.loadHost(page);
    const ws1 = (await H.workspaces(page))[0];
    expect(ws1, "default workspace exists").toBeTruthy();

    // Mutate: add a workspace (activates it), put a pane in it, rename it —
    // each mutation schedules a save whose MIRROR half is written by a
    // microtask at mutation time.
    const ws2 = await H.addWorkspace(page, "Instant WS");
    expect(ws2, "ws2 created").toBeTruthy();
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
    const ws2Pane = await H.addServer(page, H.serverUrl("instant-kill"), "instant-kill");
    expect(ws2Pane, "server pane opened in ws2").toBeTruthy();
    await H.renameWorkspace(page, ws2!, "Instant Renamed");

    // THE NEW GUARANTEE, asserted BEFORE any kill: inside what used to be the
    // 450ms debounce window, the FULL mutation (rename included) is ALREADY in
    // the localStorage mirror. Pre-fix this read found only the boot-time seed
    // blob — and both the old debounce AND c557b1b's hide-anchored flush lose
    // this state when the kill precedes the hide.
    expect(
      await persistedHasWorkspace(page, ws2!, "Instant Renamed"),
      "mirror written SYNCHRONOUSLY at mutation time (inside the old debounce window)",
    ).toBe(true);

    // ---- Kill INSTANTLY. No hide dispatch, no grace period: navigate to
    // about:blank — the old document is DESTROYED, every pending timer (incl.
    // the 450ms hash debounce) dies with it. pagehide still fires before
    // destruction, but the restore below does NOT depend on it: the mirror
    // write landed at mutation time (asserted above).
    await page.goto("about:blank");
    await page.close();

    // ---- Session 2: relaunch. Fresh page, SAME context (same-origin
    // localStorage — the WebAPK shares the browser profile's per-origin
    // storage), CLEAN start_url — no hash, exactly the PWA relaunch.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect.poll(async () => H.connected(page2), { timeout: 20000 }).toBe(true);

    await expect
      .poll(async () => (await H.workspaces(page2)).sort())
      .toEqual([ws1, ws2].sort());
    expect(
      await H.workspaceName(page2, ws2!),
      "renamed workspace survived the instant kill",
    ).toBe("Instant Renamed");
    expect(await H.activeWorkspace(page2), "active workspace restored").toBe(ws2);
    await expect.poll(async () => H.panes(page2), { timeout: 20000 }).toContain(ws2Pane);
    await H.waitForReady(page2, ws2Pane!);
  });

  test("CRUX B: hide on the live page, then kill (timers die) — state restored on clean relaunch", async ({
    page,
    context,
  }) => {
    // ---- Session 1: the "PWA process". Fresh context → seed loads.
    await H.loadHost(page);
    const ws1 = (await H.workspaces(page))[0];
    expect(ws1, "default workspace exists").toBeTruthy();

    // Mutate: add a workspace (activates it), put a pane in it, rename it.
    const ws2 = await H.addWorkspace(page, "Killed WS");
    expect(ws2, "ws2 created").toBeTruthy();
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
    const ws2Pane = await H.addServer(page, H.serverUrl("kill-crux"), "kill-crux");
    expect(ws2Pane, "server pane opened in ws2").toBeTruthy();
    await H.renameWorkspace(page, ws2!, "Renamed WS");

    // WRITE-PATH GUARD (updated 2026-08-31): under the sync-mirror write path
    // the mutation is ALREADY persisted inside the old debounce window (the
    // pre-fix honest-red guard asserted the OPPOSITE — "still pending" — which
    // the sync mirror write now makes false by design). CRUX B re-validates the
    // full Android sequence on top of that guarantee.
    expect(
      await persistedHasWorkspace(page, ws2!, "Renamed WS"),
      "mirror already written (sync write at mutation time)",
    ).toBe(true);

    // ---- The Android hide, ON THE LIVE PAGE (see the KILL MECHANISM block:
    // headless cannot produce a genuine hidden state, so patch the visibility
    // read and dispatch a REAL event through the app's REAL listener). The
    // hide flush commits BOTH mirrors HERE — synchronously, before any
    // teardown (the hash is what was still debounced).
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      try {
        document.dispatchEvent(new Event("visibilitychange"));
      } finally {
        delete (document as Partial<Document> & { visibilityState?: string })
          .visibilityState;
      }
    });

    // ---- The kill: destroy the document (every pending timer dies — the
    // debounced hash save can never fire now). pagehide fires synchronously
    // before the old document's destruction (spec-guaranteed; a second flush
    // chance).
    await page.goto("about:blank");
    await page.close();

    // ---- Session 2: relaunch. Fresh page, SAME context (same-origin
    // localStorage), CLEAN start_url — no hash, exactly the PWA relaunch.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect.poll(async () => H.connected(page2), { timeout: 20000 }).toBe(true);

    // The workspace SET + the rename + the active workspace + ws2's pane all
    // restored from the localStorage mirror.
    await expect
      .poll(async () => (await H.workspaces(page2)).sort())
      .toEqual([ws1, ws2].sort());
    expect(
      await H.workspaceName(page2, ws2!),
      "renamed workspace survived the kill",
    ).toBe("Renamed WS");
    expect(await H.activeWorkspace(page2), "active workspace restored").toBe(ws2);
    await expect.poll(async () => H.panes(page2), { timeout: 20000 }).toContain(ws2Pane);
    await H.waitForReady(page2, ws2Pane!);

    // And ws1's seeded layout survived too (switch — CSS-visibility-only).
    await H.setActiveWorkspace(page2, ws1!);
    await expect.poll(async () => H.activeWorkspace(page2)).toBe(ws1);
    await expect
      .poll(async () => (await H.panes(page2)).length, { timeout: 20000 })
      .toBeGreaterThanOrEqual(2);
  });

  test("CONTROL (guards against a vacuous red): settled kill — save flushed BEFORE the kill — state restored", async ({
    page,
    context,
  }) => {
    await H.loadHost(page);
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Settled WS");
    expect(ws2, "ws2 created").toBeTruthy();
    await H.renameWorkspace(page, ws2!, "Settled Renamed");

    // Let the debounce COMPLETE — the mutation is durably in localStorage
    // before the kill. This must pass even WITHOUT the fix.
    await H.waitForPersistedWorkspaceName(page, ws2!, "Settled Renamed");

    // Same kill as the cruxes (document destruction — timers die).
    await page.goto("about:blank");
    await page.close();

    const page2 = await context.newPage();
    await page2.goto("/");
    await expect.poll(async () => H.connected(page2), { timeout: 20000 }).toBe(true);
    await expect
      .poll(async () => (await H.workspaces(page2)).sort())
      .toEqual([ws1, ws2].sort());
    expect(await H.workspaceName(page2, ws2!)).toBe("Settled Renamed");
    expect(await H.activeWorkspace(page2)).toBe(ws2);
  });

  test("hide/kill with NOTHING pending performs NO spurious write (blob byte-identical, key not removed)", async ({
    page,
    context,
  }) => {
    await H.loadHost(page);
    const ws2 = await H.addWorkspace(page, "Idle WS");
    // Settle completely: the flushed blob is the last word.
    await H.waitForPersistedWorkspaceName(page, ws2!, "Idle WS");
    const settledRaw = await page.evaluate(
      (k) => localStorage.getItem(k),
      H.LAYOUT_STORAGE_KEY,
    );
    expect(settledRaw, "settled blob exists").toBeTruthy();

    // Wait out any straggler debounce (route updates from panes can re-arm
    // the timer with IDENTICAL state; the guard under test is "no PENDING
    // save → no write", so let everything drain first).
    await page.waitForTimeout(1500);

    // Same kill as the cruxes (document destruction — timers die). With nothing
    // pending, the hide/pagehide/freeze flush hooks must perform NO write of
    // the layout key (the diag ring key is NOT part of this assertion — the
    // ring's own bookkeeping is allowed to live).
    await page.goto("about:blank");
    await page.close();

    const page2 = await context.newPage();
    await page2.goto("/");
    await expect.poll(async () => H.connected(page2), { timeout: 20000 }).toBe(true);
    const afterRaw = await page2.evaluate(
      (k) => localStorage.getItem(k),
      H.LAYOUT_STORAGE_KEY,
    );
    expect(afterRaw, "key not removed by the hide/kill").toEqual(settledRaw);
  });

  test("SYNCHRONOUS flush: dispatching pagehide completes the pending HASH in the SAME tick (no timer, no await)", async ({
    page,
  }) => {
    await H.loadHost(page);
    const ws2 = await H.addWorkspace(page, "Pagehide WS");
    await H.renameWorkspace(page, ws2!, "Pagehide Renamed");

    // One evaluate = one JS tick. Under the sync-mirror write path the
    // localStorage blob is ALREADY current at entry (pre-assert); the
    // debounced remainder is the URL HASH. Capture the pre state, dispatch a
    // synthetic pagehide (the listener must flush synchronously), then read
    // the hash BEFORE any await/timer could fire. Attribution is airtight: if
    // the hash acquires the rename in `post` but not `pre`, ONLY the handler
    // could have done it.
    const marker = encodeURIComponent("Pagehide Renamed");
    const { preLs, preHash, postHash } = await page.evaluate(
      ({ key, wsId, marker }) => {
        const readLs = () => {
          const raw = localStorage.getItem(key);
          if (!raw) return null;
          try {
            const p = JSON.parse(raw) as { workspaces?: Array<{ id: string; name: string }> };
            const ws = p.workspaces?.find((w) => w.id === wsId);
            return ws ? `${ws.id}:${ws.name}` : null;
          } catch {
            return null;
          }
        };
        const preLs = readLs();
        const preHash = window.location.hash.includes(marker);
        window.dispatchEvent(new Event("pagehide"));
        const postHash = window.location.hash.includes(marker);
        return { preLs, preHash, postHash };
      },
      { key: H.LAYOUT_STORAGE_KEY, wsId: ws2!, marker },
    );

    expect(preLs, "pre-dispatch: mirror ALREADY written (sync write path)").toBe(
      `${ws2}:Pagehide Renamed`,
    );
    expect(preHash, "pre-dispatch: hash still debounced").toBe(false);
    expect(postHash, "post-dispatch: hash flushed SYNCHRONOUSLY").toBe(true);
  });

  test("SYNCHRONOUS flush: visibilitychange → hidden completes the pending HASH in the SAME tick", async ({
    page,
  }) => {
    await H.loadHost(page);
    const ws2 = await H.addWorkspace(page, "Vischange WS");
    await H.renameWorkspace(page, ws2!, "Vischange Renamed");

    // Same-tick proof as the pagehide variant, with the visibilitychange hook
    // isolated: patch document.visibilityState to report "hidden" (headless
    // tab-switch does not fire real visibility events — probed), dispatch the
    // event, read before any await, then restore the getter.
    const marker = encodeURIComponent("Vischange Renamed");
    const { preLs, preHash, postHash } = await page.evaluate(
      ({ key, wsId, marker }) => {
        const readLs = () => {
          const raw = localStorage.getItem(key);
          if (!raw) return null;
          try {
            const p = JSON.parse(raw) as { workspaces?: Array<{ id: string; name: string }> };
            const ws = p.workspaces?.find((w) => w.id === wsId);
            return ws ? `${ws.id}:${ws.name}` : null;
          } catch {
            return null;
          }
        };
        const preLs = readLs();
        const preHash = window.location.hash.includes(marker);
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        try {
          document.dispatchEvent(new Event("visibilitychange"));
        } finally {
          delete (document as Partial<Document> & { visibilityState?: string }).visibilityState;
        }
        const postHash = window.location.hash.includes(marker);
        return { preLs, preHash, postHash };
      },
      { key: H.LAYOUT_STORAGE_KEY, wsId: ws2!, marker },
    );

    expect(preLs, "pre-dispatch: mirror ALREADY written (sync write path)").toBe(
      `${ws2}:Vischange Renamed`,
    );
    expect(preHash, "pre-dispatch: hash still debounced").toBe(false);
    expect(postHash, "post-dispatch: hash flushed SYNCHRONOUSLY").toBe(true);
  });

  test("MICROTASK COALESCING: N mutations in ONE JS task → exactly ONE localStorage mirror write", async ({
    page,
  }) => {
    await H.loadHost(page);
    // addWorkspace in its own task (mount side effects excluded from the
    // counted window); the counted window is exactly the 4 renames below.
    const ws2 = await H.addWorkspace(page, "Coalesce WS");
    expect(ws2, "ws2 created").toBeTruthy();

    // SPY CHOICE (cross-engine): `localStorage.setItem` cannot be intercepted
    // on firefox — Storage's members are unforgeable there, so an instance
    // shadow assignment silently no-ops (empirically: the same shadow spy
    // counted 1 on chromium and 0 on firefox while the write itself landed
    // on both). `JSON.stringify`, however, is a plain writable builtin on
    // every engine, and the mirror write is the ONLY code path that
    // stringifies a payload containing the workspace name. Count stringifys
    // whose result carries the marker = count mirror write SERIALIZATIONS;
    // the raw-blob check below proves the write itself landed.
    const r = await page.evaluate(
      async ({ wsId, marker }) => {
        const h = (window as unknown as {
          __host?: { renameWorkspace(i: string, n: string): void };
        }).__host;
        const orig = JSON.stringify;
        let writes = 0;
        JSON.stringify = function (...args: unknown[]) {
          const res: unknown = orig.apply(JSON, args as Parameters<typeof JSON.stringify>);
          if (typeof res === "string" && res.includes(marker)) writes++;
          return res as string;
        } as typeof JSON.stringify;
        try {
          h?.renameWorkspace(wsId, "Coalesce 1");
          h?.renameWorkspace(wsId, "Coalesce 2");
          h?.renameWorkspace(wsId, "Coalesce 3");
          h?.renameWorkspace(wsId, "Coalesce 4");
        } finally {
          /* keep the spy until the queued microtask has drained (below) */
        }
        // Drain the queued microtask (it was enqueued at the FIRST rename,
        // before these awaits, so it runs first), then restore.
        await Promise.resolve();
        await Promise.resolve();
        JSON.stringify = orig;
        const raw = localStorage.getItem("vh-host:layout:v3") ?? "";
        return { writes, hasFinal: raw.includes("Coalesce 4") };
      },
      { wsId: ws2!, marker: "Coalesce" },
    );

    expect(r.writes, "exactly ONE coalesced mirror write per JS task").toBe(1);
    expect(r.hasFinal, "the single write carried the FINAL state").toBe(true);
  });
});

test.describe("layout diag ring (kill/relaunch diagnostics)", () => {
  test("read + seed events on a fresh boot; flush events carry trigger/bytes/ws/active; ring survives reload and the reload reads v3", async ({
    page,
  }) => {
    // Fresh context per test (playwright default) → no blob → seed boot.
    await H.loadHost(page);

    // ---- Fresh-boot fingerprints: the init `read` found NO blob, and the
    // default workspace was SEEDED with readSource "none" (the reset symptom's
    // exact signature — on-device, this pair on a RELAUNCH is the smoking gun).
    const ring1 = await H.diagRing(page);
    const reads1 = ring1.filter((e) => e.kind === "read");
    expect(reads1.length, "one read event at init").toBeGreaterThanOrEqual(1);
    const read1 = reads1[0];
    expect(read1.source).toBe("none");
    expect(read1.ws).toBe(0);
    expect(read1.origin).toBe("http://127.0.0.1:5173");
    const read1Href = read1.href as string;
    expect(typeof read1Href).toBe("string");
    expect(read1Href.length).toBeGreaterThan(0);
    expect(read1Href.length).toBeLessThanOrEqual(120);
    expect(read1.standalone).toBe(false);
    const seed1 = ring1.filter((e) => e.kind === "seed");
    expect(seed1.length, "default workspace seeded").toBeGreaterThanOrEqual(1);
    expect(seed1[0].readSource).toBe("none");
    expect(Array.isArray(seed1[0].initWs)).toBe(true);

    // ---- Mutate → the debounced flush lands a `flush` record with its
    // attribution fields.
    const ws2 = await H.addWorkspace(page, "Diag WS");
    expect(ws2, "ws2 created").toBeTruthy();
    await expect
      .poll(
        async () => {
          const ring = await H.diagRing(page);
          return ring.filter((e) => e.kind === "flush").length;
        },
        { timeout: 4000 },
      )
      .toBeGreaterThanOrEqual(1);
    const ring2 = await H.diagRing(page);
    const flush = [...ring2].reverse().find((e) => e.kind === "flush");
    expect(flush, "a flush event exists").toBeTruthy();
    expect(flush!.trigger).toBe("debounce");
    expect(typeof flush!.bytes).toBe("number");
    expect(flush!.bytes as number).toBeGreaterThan(0);
    expect(flush!.ws as number).toBeGreaterThanOrEqual(2);
    expect(typeof flush!.active).toBe("string");

    // ---- Reload: the ring PERSISTED across the navigation (it carries the
    // previous session's events) and the NEW session's read event reports the
    // HASH as its source — page.reload() keeps the URL (incl. the #state= the
    // pre-reload debounce flush wrote), and the hash is the per-tab source of
    // truth (hash-first read order — the designed behavior).
    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20000 }).toBe(true);
    const ring3 = await H.diagRing(page);
    expect(ring3.length, "ring survived the reload").toBeGreaterThanOrEqual(ring2.length);
    const reads3 = ring3.filter((e) => e.kind === "read");
    expect(reads3.length).toBeGreaterThanOrEqual(2);
    expect(reads3[reads3.length - 1].source, "reload read the per-tab hash").toBe("hash");

    // ---- CLEAN start_url (the PWA relaunch shape): goto("/") drops the hash,
    // so the init read falls through to the v3 localStorage mirror — the
    // exactly-the-relaunch fingerprint the on-device diagnosis needs.
    await page.goto("/");
    await expect.poll(async () => H.connected(page), { timeout: 20000 }).toBe(true);
    const ring4 = await H.diagRing(page);
    const reads4 = ring4.filter((e) => e.kind === "read");
    expect(reads4[reads4.length - 1].source, "clean start_url read the v3 mirror").toBe("v3");
    // No seed on either re-boot — a blob existed both times (the anti-reset
    // signal: a seed HERE would be the reset symptom's fingerprint).
    const seedsAfter = ring4.filter(
      (e) => e.kind === "seed" && (e.t as number) >= (reads3[reads3.length - 1].t as number),
    );
    expect(seedsAfter.length, "no re-seed on re-boots").toBe(0);
  });

  test("ring caps at 30 (oldest dropped), and persists through the cap churn", async ({
    page,
  }) => {
    await H.loadHost(page);
    const r = await page.evaluate(
      (key) => {
        const b = (
          window as unknown as {
            __hostLayoutDiag?: {
              ring(): Array<{ t: number; kind: string; i?: number }>;
              record(k: string, f?: Record<string, unknown>): void;
            };
          }
        ).__hostLayoutDiag;
        if (!b) return null;
        for (let i = 0; i < 45; i++) b.record("flush", { i });
        const ring = b.ring();
        // The ring must ALSO be persisted (the storage copy is what the
        // operator's "Copy layout diagnostics" reads after a relaunch).
        const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ i?: number }>;
        return {
          len: ring.length,
          first: ring[0]?.i,
          last: ring[ring.length - 1]?.i,
          storedLen: stored.length,
          storedFirst: stored[0]?.i,
        };
      },
      H.DIAG_STORAGE_KEY,
    );
    expect(r, "DEV bridge present").not.toBeNull();
    expect(r!.len, "ring capped at 30").toBe(30);
    expect(r!.first, "oldest 15 dropped (kept the LAST 30)").toBe(15);
    expect(r!.last).toBe(44);
    expect(r!.storedLen, "persisted copy matches the cap").toBe(30);
    expect(r!.storedFirst).toBe(15);
  });

  test("a CORRUPT diag ring never breaks persistence: boot, seed, and save all still work, and the ring restarts cleanly", async ({
    page,
  }) => {
    // Poison the diag key BEFORE any app script runs on this page.
    await page.addInitScript(
      (key) => {
        try {
          localStorage.setItem(key, "{not json — poison");
        } catch {
          /* best-effort poison */
        }
      },
      H.DIAG_STORAGE_KEY,
    );
    await H.loadHost(page);

    // Persistence itself works: mutate → the mirror write lands.
    const ws2 = await H.addWorkspace(page, "CorruptDiag WS");
    expect(ws2, "ws2 created").toBeTruthy();
    await H.waitForPersistedWorkspaceName(page, ws2!, "CorruptDiag WS");

    // The ring restarted cleanly around the corruption (fresh events only —
    // the garbage neither threw nor leaked into the ring).
    const ring = await H.diagRing(page);
    expect(ring.length).toBeGreaterThanOrEqual(1);
    expect(ring.every((e) => typeof e.kind === "string" && typeof e.t === "number")).toBe(
      true,
    );
    expect(ring.some((e) => e.kind === "read")).toBe(true);
    expect(ring.some((e) => e.kind === "seed")).toBe(true);
  });
});
