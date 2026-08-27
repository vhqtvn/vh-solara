import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// PWA kill/relaunch persistence gate — proves the host state (workspace set +
// names + layouts + active workspace) survives the Android-PWA kill cycle:
// mutate → the process dies (pending debounced save would die with it) →
// relaunch at the CLEAN start_url (no hash) → the localStorage mirror is the
// ONLY restore source → state must be there.
//
// ROOT CAUSE UNDER TEST (src/dockview/layoutPersistence.ts): saves are
// DEBOUNCED (450ms) and flushed only by the timer. Android kills backgrounded
// PWAs without firing reliable unload events at kill time — the LAST event
// the page gets is the transition to HIDDEN (visibilitychange→hidden /
// pagehide) when the operator backgrounds the app; the later kill is silent.
// A save scheduled inside that window died with the process, so the localStorage
// mirror stayed at the PREVIOUS flush (for a fresh PWA context: the boot-time
// seed write) → relaunch re-seeded to default. The fix: a SYNCHRONOUS
// flush-on-hide (visibilitychange→hidden AND pagehide listeners calling
// flushSave directly — localStorage + history.replaceState are sync-safe
// there; no async, no timers).
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
// THE CRUX therefore reproduces the real Android sequence deterministically:
//   1. mutate (a debounced save is now PENDING — asserted, so a pre-fix pass
//      cannot be vacuous);
//   2. HIDE ON THE LIVE PAGE: patch `document.visibilityState` → "hidden" and
//      dispatch a REAL `visibilitychange` through the app's REAL listener
//      (headless cannot produce a genuine hidden state — probed). The flush
//      runs synchronously on a live page — no teardown race. This is the
//      Android "operator backgrounds the app" moment;
//   3. KILL: navigate to about:blank. The old document is DESTROYED — every
//      pending timer dies with it (exactly the Android kill's effect on the
//      debounced save). `pagehide` fires synchronously BEFORE the old
//      document's destruction (spec-guaranteed, honored by both engines), a
//      second flush opportunity the fix provides;
//   4. RELAUNCH: a fresh page in the SAME context (same-origin localStorage —
//      the WebAPK shares the browser profile's per-origin storage) at the
//      CLEAN start_url `/` — no `#state=` hash, so `readBlob()` falls to the
//      localStorage mirror (hash-first read order unchanged).
//
// HONESTY LIMITS, stated up front:
//   • A kill with NO prior hide event (renderer killed while VISIBLE — e.g.
//     chromium `Page.crash()`) is inherently unfixable from web code: nothing
//     fires, so nothing can flush. Real Android never does this — backgrounding
//     always hides the page first. The live-hide step above is that moment.
//   • The visibilitychange hide is produced by patching visibilityState because
//     headless tab-switching fires nothing (probed); the listener, the event
//     dispatch, and the synchronous flush are all real.
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
  test("CRUX: hide on the live page, then kill (timers die) — state restored on clean relaunch", async ({
    page,
    context,
  }) => {
    // ---- Session 1: the "PWA process". Fresh context → seed loads.
    await H.loadHost(page);
    const ws1 = (await H.workspaces(page))[0];
    expect(ws1, "default workspace exists").toBeTruthy();

    // Mutate: add a workspace (activates it), put a pane in it, rename it.
    // addWorkspace/renameWorkspace/addServer each schedule a DEBOUNCED save.
    const ws2 = await H.addWorkspace(page, "Killed WS");
    expect(ws2, "ws2 created").toBeTruthy();
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
    const ws2Pane = await H.addServer(page, H.serverUrl("kill-crux"), "kill-crux");
    expect(ws2Pane, "server pane opened in ws2").toBeTruthy();
    await H.renameWorkspace(page, ws2!, "Renamed WS");

    // HONEST-RED GUARD: we are INSIDE the 450ms window — the mutation must NOT
    // be in localStorage yet (if it were, a pre-fix pass would be vacuous).
    expect(
      await persistedHasWorkspace(page, ws2!),
      "save still pending (inside debounce window)",
    ).toBe(false);

    // ---- The Android hide, ON THE LIVE PAGE (see the KILL MECHANISM block:
    // headless cannot produce a genuine hidden state, so patch the visibility
    // read and dispatch a REAL event through the app's REAL listener). The
    // fix's flush must commit HERE — synchronously, before any teardown.
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
    // debounced save can never fire now). pagehide fires synchronously before
    // the old document's destruction (spec-guaranteed; a second flush chance).
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

    // Same kill as the crux (document destruction — timers die).
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

    // Same kill as the crux (document destruction — timers die). With nothing
    // pending, the hide/pagehide flush hooks must perform NO write.
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

  test("SYNCHRONOUS flush: dispatching pagehide writes the pending state in the SAME tick (no timer, no await)", async ({
    page,
  }) => {
    await H.loadHost(page);
    const ws2 = await H.addWorkspace(page, "Pagehide WS");
    await H.renameWorkspace(page, ws2!, "Pagehide Renamed");

    // One evaluate = one JS tick: capture the PRE state, dispatch a synthetic
    // pagehide (the listener must flush synchronously), then read the blob
    // BEFORE any await/timer could fire. Attribution is airtight: if the write
    // appears in `post` but not `pre`, ONLY the handler could have done it.
    const { pre, post } = await page.evaluate(({ key, wsId }) => {
      const read = () => {
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
      const pre = read();
      window.dispatchEvent(new Event("pagehide"));
      const post = read();
      return { pre, post };
    }, { key: H.LAYOUT_STORAGE_KEY, wsId: ws2! });

    expect(pre, "pre-dispatch: save still pending (inside debounce window)").toBeNull();
    expect(post, "post-dispatch: pending state flushed SYNCHRONOUSLY").toBe(
      `${ws2}:Pagehide Renamed`,
    );
  });

  test("SYNCHRONOUS flush: visibilitychange → hidden writes the pending state in the SAME tick", async ({
    page,
  }) => {
    await H.loadHost(page);
    const ws2 = await H.addWorkspace(page, "Vischange WS");
    await H.renameWorkspace(page, ws2!, "Vischange Renamed");

    // Same-tick proof as the pagehide variant, with the visibilitychange hook
    // isolated: patch document.visibilityState to report "hidden" (headless
    // tab-switch does not fire real visibility events — probed), dispatch the
    // event, read before any await, then restore the getter.
    const { pre, post } = await page.evaluate(({ key, wsId }) => {
      const read = () => {
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
      const pre = read();
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      try {
        document.dispatchEvent(new Event("visibilitychange"));
      } finally {
        delete (document as Partial<Document> & { visibilityState?: string }).visibilityState;
      }
      const post = read();
      return { pre, post };
    }, { key: H.LAYOUT_STORAGE_KEY, wsId: ws2! });

    expect(pre, "pre-dispatch: save still pending (inside debounce window)").toBeNull();
    expect(post, "post-dispatch: pending state flushed SYNCHRONOUSLY").toBe(
      `${ws2}:Vischange Renamed`,
    );
  });
});
