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

// ---- stale-frozen-hash (round 3) helpers -------------------------------------

/** Loose parsed-blob shape for the comparative-read tests below. */
type Blob = Record<string, unknown> & {
  seq?: number;
  workspaces?: Array<{ id: string; name?: string; layout?: unknown }>;
};

function blobWsIds(p: unknown): string[] {
  if (typeof p !== "object" || p === null) return [];
  return ((p as Blob).workspaces ?? []).map((w) => w.id);
}

/** Wait until BOTH mirrors carry the SAME blob (hash json === localStorage
 *  string — the last flushSave wrote them together, so their seq matches too)
 *  AND it satisfies `accept` AND has been byte-stable ≥700ms (> the 450ms hash
 *  debounce + margin — the same quiescence discipline as util's
 *  waitForQuiescentHash, tightened to "mirrors identical" because the
 *  comparative read compares the TWO mirrors, not just the hash). */
async function settleBothMirrors(
  page: Page,
  accept: (p: unknown) => boolean,
  what: string,
  timeoutMs = 10000,
): Promise<Blob> {
  const deadline = Date.now() + timeoutMs;
  let stableRaw: string | null = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const raws = await page.evaluate(
      (key) => ({
        ls: localStorage.getItem(key),
        hash: window.location.hash.startsWith("#state=")
          ? decodeURIComponent(window.location.hash.slice("#state=".length))
          : null,
      }),
      H.LAYOUT_STORAGE_KEY,
    );
    let ok = false;
    let parsed: unknown = null;
    if (raws.ls && raws.hash === raws.ls) {
      try {
        parsed = JSON.parse(raws.ls);
        ok = accept(parsed);
      } catch {
        ok = false;
      }
    }
    if (ok && raws.ls === stableRaw) {
      if (Date.now() - stableSince >= 700) return parsed as Blob;
    } else if (ok) {
      stableRaw = raws.ls;
      stableSince = Date.now();
    } else {
      stableRaw = null;
    }
    await page.waitForTimeout(80);
  }
  throw new Error(`${what} never settled (hash === LS, stable) within ${timeoutMs}ms`);
}

/** A hand-written install-era RELIC blob for the URL hash: ONE workspace, one
 *  pane at a valid mock url, seq `seq` (null = a pre-seq seq-less blob — the
 *  legacy migration case). Shaped like the operator's frozen launcher URL. */
function relicHashJson(seq: number | null, paneUrl: string): string {
  return JSON.stringify({
    v: 3,
    ...(seq !== null ? { seq } : {}),
    activeWorkspaceId: "ws-relic",
    workspaces: [
      {
        id: "ws-relic",
        name: "Install Relic",
        layout: {
          grid: {
            root: {
              type: "branch",
              data: [
                {
                  type: "leaf",
                  fraction: 1,
                  data: { id: "g-relic", views: ["pane-relic"], activeView: "pane-relic" },
                },
              ],
            },
            width: 1024,
            height: 768,
            orientation: "HORIZONTAL",
          },
          panels: {
            "pane-relic": { id: "pane-relic", params: { url: paneUrl, label: "relic" } },
          },
          activeGroup: "g-relic",
        },
      },
    ],
  });
}

/** Clone a settled blob, ADD an empty workspace `extraId`, and re-stamp `seq`
 *  — the "this tab's own later flush" hash used by the hash-newer/tie tests
 *  (its extra workspace proves WHICH candidate won the comparative read). */
function hashVariantWithExtraWs(base: Blob, extraId: string, seq: number): string {
  const parsed = JSON.parse(JSON.stringify(base)) as Blob;
  parsed.seq = seq;
  parsed.workspaces = [...(parsed.workspaces ?? []), { id: extraId, name: "Hash WS", layout: null }];
  return JSON.stringify(parsed);
}

/** Relaunch the page carrying `hashJson` on the URL (a real navigation — via
 *  about:blank — so the hash is present at module init, exactly the frozen
 *  launcher-replay posture), then wait for the app to come up. */
async function relaunchWithHash(page: Page, hashJson: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto("/#state=" + encodeURIComponent(hashJson));
  await expect.poll(async () => H.connected(page), { timeout: 20000 }).toBe(true);
}

/** The LAST diag event of `kind` (the ring persists across sessions — anchor
 *  "no X since the read" assertions on the read's own timestamp). */
function lastDiag(events: H.DiagEvent[], kind: string): H.DiagEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === kind) return events[i];
  }
  return null;
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

test.describe("stale frozen #state= hash vs fresh localStorage (comparative read, round 3)", () => {
  // ROOT CAUSE (operator diag ring, proven): Android's launcher replays a
  // FROZEN install-time task URL — a stale #state= relic (1 workspace) plus
  // leaked SPA params (?dir=…&session=…) on the top URL. Hash-first-
  // unconditional read made the relic beat the fresh localStorage blob every
  // relaunch, and the booted app then SAVED the stale restore back over
  // localStorage (the clobber). The comparative read (seq = write timestamp,
  // newest decisively wins) + the boot-time hash heal + param strip defuse it.

  test("CRUX C (the operator's exact shape): ancient hash relic vs fresh 4-ws LS → LS restores, no seed, LS not regressed, hash HEALED", async ({
    page,
  }) => {
    // ---- Session A: build the FRESH state (the operator's ws-2..5 shape).
    await H.loadHost(page);
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Fresh WS 2");
    const ws3 = await H.addWorkspace(page, "Fresh WS 3");
    const ws4 = await H.addWorkspace(page, "Fresh WS 4");
    expect(ws2 && ws3 && ws4, "three workspaces added").toBeTruthy();
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(4);

    // Settle: BOTH mirrors byte-identical (one flushSave wrote them, same
    // seq) and stable — this is the "fresh" blob.
    const fresh = await settleBothMirrors(
      page,
      (p) => blobWsIds(p).length === 4,
      "fresh 4-ws blob",
    );
    const freshIds = blobWsIds(fresh);
    expect(typeof fresh.seq, "fresh blob carries a seq stamp").toBe("number");
    const freshSeq = fresh.seq!;

    // The RELIC: install-era 1-workspace blob whose seq is 1h older —
    // decisively beyond STALE_HASH_WINDOW_MS (the real one is days old).
    const relicSeq = freshSeq - 3_600_000;

    // ---- Relaunch carrying the frozen relic hash (the launcher replay).
    await relaunchWithHash(page, relicHashJson(relicSeq, H.serverUrl("relic")));

    // THE CRUX: the FRESH 4-workspace set restored — not the 1-ws relic.
    await expect
      .poll(async () => (await H.workspaces(page)).sort())
      .toEqual(freshIds.slice().sort());
    expect(await H.workspaceName(page, ws2!), "fresh names restored").toBe("Fresh WS 2");

    // The read fingerprint: LS won the comparison DECISIVELY, hash healed.
    const ring = await H.diagRing(page);
    const read = lastDiag(ring, "read");
    expect(read, "relaunch read event").toBeTruthy();
    expect(read!.pick, "localStorage won the comparative read").toBe("ls");
    expect(read!.source).toBe("v3");
    expect(read!.healed, "the stale hash was healed at boot").toBe(true);
    expect(read!.hashSeq, "the relic's seq, verbatim in the paste").toBe(relicSeq);
    expect(read!.lsSeq, "the mirror's seq, verbatim in the paste").toBe(freshSeq);
    expect(read!.ws).toBe(4);
    // NO seed after the relaunch's own read (a seed here IS the reset symptom).
    expect(
      ring.filter((e) => e.kind === "seed" && (e.t as number) >= (read!.t as number)).length,
      "no seed on the stale-hash relaunch",
    ).toBe(0);

    // The URL hash was HEALED to the fresh state — subsequent launches carry
    // the fresh hash, killing the frozen launcher URL permanently.
    const healedHash = (await H.readHashState(page)) as Blob | null;
    expect(healedHash, "hash still #state=-shaped after the heal").toBeTruthy();
    expect(blobWsIds(healedHash).sort()).toEqual(freshIds.slice().sort());

    // The boot's subsequent save does NOT regress LS below the 4-ws shape
    // (the pre-fix clobber: the stale restore was saved back over LS).
    await page.waitForTimeout(1500);
    const after = await readPersisted(page);
    expect((after?.workspaces ?? []).map((w) => w.id).sort()).toEqual(freshIds.slice().sort());
  });

  test("hash NEWER than LS → hash wins (browser-tab independence preserved)", async ({
    page,
  }) => {
    await H.loadHost(page);
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "LS WS");
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(2);
    const fresh = await settleBothMirrors(
      page,
      (p) => blobWsIds(p).length === 2,
      "2-ws fresh blob",
    );
    const lsSeq = fresh.seq!;

    // This tab's own LATER flush as a hash: same state + one extra workspace,
    // seq decisively (60s) newer than the mirror.
    const hashSeq = lsSeq + 60_000;
    await relaunchWithHash(page, hashVariantWithExtraWs(fresh, "ws-hash-newer", hashSeq));

    // The HASH's content restored (its extra workspace exists) — the tab's
    // own newest state, exactly the per-tab independence the hash exists for.
    await expect
      .poll(async () => (await H.workspaces(page)).sort())
      .toEqual([ws1, ws2, "ws-hash-newer"].sort());

    const ring = await H.diagRing(page);
    const read = lastDiag(ring, "read");
    expect(read!.pick).toBe("hash");
    expect(read!.hashSeq).toBe(hashSeq);
    expect(read!.lsSeq).toBe(lsSeq);
    expect(read!.healed, "a winning hash is never healed").toBe(false);
    const hashState = (await H.readHashState(page)) as Blob | null;
    expect(blobWsIds(hashState)).toContain("ws-hash-newer");
  });

  test("seq TIE → hash wins (same-tab reload semantics)", async ({ page }) => {
    await H.loadHost(page);
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Tie LS");
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(2);
    const fresh = await settleBothMirrors(
      page,
      (p) => blobWsIds(p).length === 2,
      "2-ws fresh blob",
    );
    const tieSeq = fresh.seq!;

    // A hash whose seq EXACTLY ties the mirror's, with different content.
    await relaunchWithHash(page, hashVariantWithExtraWs(fresh, "ws-tie-hash", tieSeq));

    await expect
      .poll(async () => (await H.workspaces(page)).sort())
      .toEqual([ws1, ws2, "ws-tie-hash"].sort());
    const ring = await H.diagRing(page);
    const read = lastDiag(ring, "read");
    expect(read!.pick, "tie → hash (HEAD's reload semantics)").toBe("hash");
    expect(read!.hashSeq).toBe(tieSeq);
    expect(read!.lsSeq).toBe(tieSeq);
    expect(read!.healed).toBe(false);
  });

  test("seq-LESS legacy hash vs seq-stamped LS → LS wins (the migration note)", async ({
    page,
  }) => {
    await H.loadHost(page);
    const ws1 = (await H.workspaces(page))[0];
    await H.addWorkspace(page, "Legacy 2");
    await H.addWorkspace(page, "Legacy 3");
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(3);
    const fresh = await settleBothMirrors(
      page,
      (p) => blobWsIds(p).length === 3,
      "3-ws fresh blob",
    );
    const freshIds = blobWsIds(fresh);
    const freshSeq = fresh.seq!;

    // A relic WITHOUT a seq field (a pre-seq blob): absent = 0 → the
    // seq-stamped mirror (any epoch-ms stamp) beats it decisively.
    await relaunchWithHash(page, relicHashJson(null, H.serverUrl("legacy")));

    await expect
      .poll(async () => (await H.workspaces(page)).sort())
      .toEqual(freshIds.slice().sort());
    const ring = await H.diagRing(page);
    const read = lastDiag(ring, "read");
    expect(read!.pick).toBe("ls");
    expect(read!.hashSeq, "seq-less hash reports null in the paste").toBeNull();
    expect(read!.lsSeq).toBe(freshSeq);
    expect(read!.healed).toBe(true);
  });

  test("top-URL hygiene: leaked dir/session stripped, proto + hash preserved; also fires with no hash", async ({
    page,
  }) => {
    await H.loadHost(page);
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Hygiene WS");
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(2);
    const fresh = await settleBothMirrors(
      page,
      (p) => blobWsIds(p).length === 2,
      "2-ws fresh blob",
    );
    const freshIds = blobWsIds(fresh);

    // The frozen install-era URL: leaked SPA route params + the stale relic.
    await page.goto("about:blank");
    await page.goto(
      "/?dir=%2Fx&session=y&proto=keep#state=" +
        encodeURIComponent(relicHashJson((fresh.seq as number) - 3_600_000, H.serverUrl("hygiene"))),
    );
    await expect.poll(async () => H.connected(page), { timeout: 20000 }).toBe(true);

    // dir/session GONE; every other param (proto — the web+vhsolara protocol
    // handler) preserved byte-identically; the hash present AND healed to the
    // fresh state (LS won decisively).
    const url = new URL(page.url());
    expect(url.search, "dir/session stripped, proto kept byte-identically").toBe("?proto=keep");
    expect(url.hash.startsWith("#state=")).toBe(true);
    const healedHash = (await H.readHashState(page)) as Blob | null;
    expect(blobWsIds(healedHash).sort()).toEqual(freshIds.slice().sort());
    const ring = await H.diagRing(page);
    const read = lastDiag(ring, "read");
    expect(read!.pick).toBe("ls");
    expect(read!.healed).toBe(true);
    // And the fresh state restored (not the relic).
    await expect
      .poll(async () => (await H.workspaces(page)).sort())
      .toEqual(freshIds.slice().sort());

    // Hygiene ALSO fires with no hash at all (a params-only frozen URL): the
    // clean search must not resurrect, and the mirror still restores.
    await page.goto("about:blank");
    await page.goto("/?dir=zz&session=qq");
    await expect.poll(async () => H.connected(page), { timeout: 20000 }).toBe(true);
    expect(new URL(page.url()).search, "leaked params stripped even without a hash").toBe("");
    await expect
      .poll(async () => (await H.workspaces(page)).sort())
      .toEqual(freshIds.slice().sort());
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

  // ---- DIAG ROUND 2 (restore events + seed blob fingerprint) ------------------
  // The round-1 ring proved the SAVE side works and that relaunches read a
  // valid v3 blob, but could NOT pin WHERE between initBlob and fromJSON a
  // layout nulled (the operator's paste showed read v3 + seed — an event
  // combination HEAD code cannot emit, which itself proved the deployed
  // device bundle diverged from source). Round 2 adds the missing per-
  // workspace `restore` events (outcome restored|failed + granular reason)
  // and the seed event's incoming-blob fingerprint — asserted here in the
  // dev posture; the folded lane asserts them against the production build.
  test("restore events: failed/blob-null on a fresh boot (with diagv + empty seed fingerprint); restored with pane count on reload; failed/pruned-all on an all-poison blob with NO seed", async ({
    page,
  }) => {
    // ---- Fresh boot: no blob → restore failed blob-null, then the seed with
    // an EMPTY blob fingerprint (nothing was incoming).
    await H.loadHost(page);
    const ring0 = await H.diagRing(page);
    const read0 = ring0.find((e) => e.kind === "read");
    expect(read0, "read event present").toBeTruthy();
    expect(read0!.diagv, "read carries the diag schema stamp").toBe(3);
    const restore0 = ring0.find((e) => e.kind === "restore");
    expect(restore0, "restore event present on the seeded boot").toBeTruthy();
    expect(restore0!.outcome).toBe("failed");
    expect(restore0!.reason).toBe("blob-null");
    expect(restore0!.source).toBe("blob");
    const seed0 = ring0.find((e) => e.kind === "seed");
    expect(seed0, "seed event present").toBeTruthy();
    expect(seed0!.blobPrefix, "no incoming blob → empty fingerprint").toBe("");

    // ---- Reload: the seeded layout restores — outcome restored, with the
    // restored pane count and the blob as the source.
    //
    // ARRANGEMENT FIX (2026-09-02, pre-existing-latent): a fresh dev-lane
    // boot persists NOTHING on its own — the mock content page emits a
    // routeless {type:"route"} (a no-op in the router; only a route STRING
    // captures + saves), and the seed hooks the layout saver for SUBSEQUENT
    // mutations only. On the operator's device the real SPA's route-string
    // emission is exactly what flushes a boot (ring: flush ~130ms after
    // boot). Without this step the reload below found NO blob and re-seeded
    // (observed red at b363ea1 AND effectively-455251d with this slice's
    // files reverted — a latent arrangement gap, not a persistence defect).
    // Reproduce the device-shaped boot flush so the reload restores:
    const seededIds = await H.panes(page);
    const routeProbe = await H.probePaneMessage(page, {
      sourcePaneId: seededIds[0],
      origin: H.MOCK_ORIGIN,
      payload: { type: "route", route: "?dir=/diag-round2&session=boot" },
    });
    expect(routeProbe.accepted, "route captured (the device-shaped boot flush)").toBe(true);
    await H.waitForSavedLayout(page, seededIds.length);
    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20000 }).toBe(true);
    const ring1 = await H.diagRing(page);
    const restores1 = ring1.filter((e) => e.kind === "restore");
    const r1 = restores1[restores1.length - 1];
    expect(r1, "this session's restore event").toBeTruthy();
    expect(r1!.outcome).toBe("restored");
    expect(r1!.source).toBe("blob");
    expect(r1!.panes, "all four seeded mock panes restored").toBe(4);
    const read1 = ring1.filter((e) => e.kind === "read").pop();
    expect(
      ring1.filter((e) => e.kind === "seed" && e.t >= read1!.t).length,
      "no seed on the restored boot",
    ).toBe(0);

    // ---- All-poison blob: EVERY panel url rewritten to javascript: → the
    // envelope still validates (per-pane URL validation is the repair
    // walker's job) → restore failed pruned-all:<ids>, workspace EMPTY, and
    // (blob present) NO seed — the exact branch that must never re-seed.
    const poisoned = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        workspaces: Array<{
          layout: {
            panels: Record<string, { params?: { url?: string } }>;
          } | null;
        }>;
      };
      for (const ws of parsed.workspaces) {
        if (!ws.layout) continue;
        for (const st of Object.values(ws.layout.panels)) {
          if (st.params) st.params.url = "javascript:alert(1)";
        }
      }
      localStorage.setItem(key, JSON.stringify(parsed));
      return true;
    }, H.LAYOUT_STORAGE_KEY);
    expect(poisoned, "poisoned the stored blob").toBe(true);
    await page.goto("/"); // clean start_url → read source v3
    await expect
      .poll(async () => (await H.panes(page)).length === 0 && (await H.workspaces(page)).length >= 1, { timeout: 10000 })
      .toBe(true);
    const ring2 = await H.diagRing(page);
    const read2 = ring2.filter((e) => e.kind === "read").pop();
    expect(read2!.source, "poisoned blob still reads as v3").toBe("v3");
    const r2 = ring2.filter((e) => e.kind === "restore").pop();
    expect(r2!.outcome).toBe("failed");
    expect(String(r2!.reason).startsWith("pruned-all:"), "reason lists the pruned ids").toBe(true);
    expect(
      ring2.filter((e) => e.kind === "seed" && e.t >= read2!.t).length,
      "a present-but-fully-pruned blob must NOT re-seed (empty workspace)",
    ).toBe(0);
  });
});
