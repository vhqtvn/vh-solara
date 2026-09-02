import { expect, test, type Page } from "@playwright/test";
import { DIAG_STORAGE_KEY, LAYOUT_STORAGE_KEY, iframeSrcs } from "../e2e/util";

// =============================================================================
// FOLDED-POSTURE RESTORE e2e — the crux lane for the on-device PWA relaunch
// layout loss (round 3, 2026-08-31).
//
// Posture under test: the REAL binary serves the FOLDED PRODUCTION host at
// `/` (VITE_HOST_FOLDED=1 build: base /host/, self-seed fleet = ONE pane at
// `origin + "/app"`, NO VITE_SERVERS, minified, DEV bridges absent). The
// embedded SPA iframes are SAME-ORIGIN `/app` documents — the exact topology
// of the operator's Android PWA (their diag ring: read source=v3 at
// href=<origin>/ standalone=true).
//
// Everything here is PRODUCTION-SAFE (no window.__host / __hostLayoutDiag —
// those are DEV-only and dead-code-eliminated in the folded build):
//   • DOM: `.pane[data-pane-id]` count, `[data-testid=empty-workspace]`,
//     `iframe.pane-iframe` srcs.
//   • localStorage: the v3 layout blob + the ALWAYS-ON diag ring
//     (vh-host:layout:diag) — the same instrument the operator's "Copy layout
//     diagnostics" Settings action produces.
//
// The three cruxes:
//   1. SELF-SEED SAVE → RELOAD RESTORES: the folded self-seed layout (1 pane
//      at /app) must survive a clean relaunch (goto "/" — no hash, exactly
//      the PWA start_url posture → read source=v3) with NO seed and NO empty
//      workspace.
//   2. PLANTED-BLOB RESTORE (isolates restore from save): a hand-written v3
//      blob shaped like the operator's (1 ws, 2 panes at origin+"/app" with
//      captured routes, 50/50 split) must restore both panes.
//   3. SECOND-WINDOW NO-CLOBBER: a second window booting at "/" while a
//      valid blob exists must never overwrite that blob with boot-time
//      writes (the notificationclick/openWindow duplicate-boot vector).
// =============================================================================

// ---- production-safe helpers (localStorage + DOM only) ----------------------

interface DiagEvent {
  t: number;
  kind: string;
  [field: string]: unknown;
}

/** The diag ring read straight from localStorage (always-on in production). */
async function ring(page: Page): Promise<DiagEvent[]> {
  return page.evaluate(
    ({ key }) => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as DiagEvent[]) : [];
      } catch {
        return [];
      }
    },
    { key: DIAG_STORAGE_KEY },
  );
}

/** The last event of `kind` in the ring, or null. */
function lastOf(events: DiagEvent[], kind: string): DiagEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === kind) return events[i];
  }
  return null;
}

/** Every event of `kind` at/after wall-clock `t`. */
function since(events: DiagEvent[], kind: string, t: number): DiagEvent[] {
  return events.filter((e) => e.kind === kind && e.t >= t);
}

/** The raw v3 blob string in localStorage (null when absent). */
async function blobRaw(page: Page): Promise<string | null> {
  return page.evaluate(
    ({ key }) => localStorage.getItem(key),
    { key: LAYOUT_STORAGE_KEY },
  );
}

/** Wait until the v3 localStorage mirror satisfies `accept(parsed)` AND has
 *  been byte-STABLE for ≥700ms (> SAVE_DEBOUNCE_MS=450 + margin — the same
 *  quiescence discipline as the dev lane's hash wait, applied to the mirror
 *  because the folded PWA relaunch reads the MIRROR, not the hash). */
async function waitForQuiescentMirror(
  page: Page,
  accept: (parsed: unknown) => boolean,
  what: string,
  timeoutMs = 12000,
): Promise<unknown> {
  const STABLE_MS = 700;
  const deadline = Date.now() + timeoutMs;
  let stableRaw: string | null = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const raw = await blobRaw(page);
    let ok = false;
    let parsed: unknown = null;
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw);
        ok = accept(parsed);
      } catch {
        ok = false;
      }
    }
    if (ok && raw === stableRaw) {
      if (Date.now() - stableSince >= STABLE_MS) return parsed;
    } else if (ok) {
      stableRaw = raw;
      stableSince = Date.now();
    } else {
      stableRaw = null;
    }
    await page.waitForTimeout(80);
  }
  throw new Error(`${what} never appeared stably in ${LAYOUT_STORAGE_KEY} within ${timeoutMs}ms`);
}

/** The `.pane` element ids in DOM order (production DOM read). */
async function paneIds(page: Page): Promise<string[]> {
  return page.locator(".pane[data-pane-id]").evaluateAll((els) =>
    (els as HTMLElement[]).map((e) => e.dataset.paneId ?? ""),
  );
}

/** Total panels across every workspace in a parsed v3 blob. */
function totalPanels(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 0;
  const wsList = (parsed as { workspaces?: Array<{ layout?: { panels?: Record<string, unknown> } }> })
    .workspaces ?? [];
  let n = 0;
  for (const ws of wsList) {
    const lp = ws.layout?.panels;
    if (lp && typeof lp === "object") n += Object.keys(lp).length;
  }
  return n;
}

/** Fold the ring into a compact operator-paste-style fingerprint for failure
 *  output (same fields the on-device "Copy layout diagnostics" yields). */
function fingerprint(events: DiagEvent[]): string {
  return events
    .map((e) =>
      `${e.kind} ${JSON.stringify(
        Object.fromEntries(Object.entries(e).filter(([k]) => k !== "t")),
      )}`,
    )
    .join("\n");
}

// ---- the tests ---------------------------------------------------------------

test.describe.serial("folded-posture layout restore", () => {
  test("folded self-seed saves; clean relaunch restores with no seed", async ({ page }) => {
    // Boot 1: fresh context, clean start_url (no hash) — the PWA launch posture.
    await page.goto("/");
    await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();

    // The folded self-seed: ONE pane at origin + /app (resolveBaseFleet →
    // localAppEntry). Wait for it to exist and be saved.
    await expect
      .poll(async () => (await paneIds(page)).length, { timeout: 20000 })
      .toBeGreaterThanOrEqual(1);
    const origin = new URL(page.url()).origin;
    const srcs = await iframeSrcs(page);
    expect(srcs.length, "one self-seeded iframe").toBe(1);
    expect(srcs[0].startsWith(`${origin}/app`), "self-seed points at /app").toBe(true);

    // The self-seed's own layout must be SAVED (the boot flush) — quiescent.
    const saved = (await waitForQuiescentMirror(
      page,
      (p) => totalPanels(p) === 1,
      "self-seed layout (1 panel)",
    )) as { workspaces?: Array<{ id?: string; layout?: { panels?: Record<string, unknown> } }> };
    const blobBefore = await blobRaw(page);
    expect(blobBefore).toBeTruthy();
    const wsId = saved.workspaces?.[0]?.id;

    // RELAUNCH: same origin+storage, clean start_url (goto "/", no #state=) —
    // exactly the Android PWA relaunch posture (the operator's ring shows the
    // relaunch read source=v3 at href=<origin>/).
    await page.goto("/");

    // CRUX 1: the workspace is NOT empty and NOT re-seeded — the saved layout
    // restores (≥1 pane again, no empty-workspace affordance).
    await expect
      .poll(async () => (await paneIds(page)).length, { timeout: 20000 })
      .toBeGreaterThanOrEqual(1);
    await expect(page.locator('[data-testid="empty-workspace"]')).toBeHidden();

    // CRUX 2: the diag ring — the relaunch read found the v3 blob and NO seed
    // fired after that read (the operator's ring shows exactly this seed —
    // the reset symptom's fingerprint). Anchored on the relaunch's OWN read
    // event, not a wall-clock window: boot 1's legitimate first-install seed
    // (readSource=none) can land within any fixed ms window of the relaunch.
    const events = await ring(page);
    const read = lastOf(events, "read");
    expect(read, "relaunch recorded a read event").toBeTruthy();
    expect(read!.source, "relaunch read source is v3 (blob present, no hash)").toBe("v3");
    const seeds = since(events, "seed", read!.t);
    expect(
      seeds,
      `no seed after the relaunch read (operator symptom: seed fires despite a valid v3 blob)\nring:\n${fingerprint(events)}`,
    ).toEqual([]);

    // CRUX 2b (diag round 2): the per-workspace restore event — outcome
    // "restored" from the blob (a "failed" outcome here pins the nulling step
    // via its reason: blob-null | no-entry | layout-null | invalid-shape |
    // pruned-all:<ids> | exception:<msg>).
    const restore = lastOf(events, "restore");
    expect(restore, "relaunch recorded a restore event").toBeTruthy();
    expect(restore!.outcome, "folded workspace restored from the blob").toBe("restored");
    expect(restore!.source).toBe("blob");
    expect(restore!.panes).toBe(1);

    // CRUX 3: the blob was not clobbered by the relaunch boot (still 1 panel
    // for the same workspace — a re-seed would rewrite a fresh pane id set).
    const after = (await waitForQuiescentMirror(
      page,
      (p) => totalPanels(p) === 1,
      "post-relaunch blob (1 panel)",
    )) as { workspaces?: Array<{ id?: string; layout?: { panels?: Record<string, unknown> } }> };
    expect(after.workspaces?.[0]?.id, "same workspace restored").toBe(wsId);
    const srcs2 = await iframeSrcs(page);
    expect(srcs2.length, "restored pane iframe present").toBe(1);
    expect(srcs2[0].startsWith(`${origin}/app`), "restored pane still points at /app").toBe(true);
  });

  test("planted folded blob (2 panes, /app origins, routes) restores", async ({ page }) => {
    // Boot once so the origin has a live host document to plant against.
    await page.goto("/");
    await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();

    // Plant a hand-written v3 blob shaped like the operator's diag (1 ws,
    // 2-3 panes, /app origins with captured routes). Isolates RESTORE from
    // SAVE: the blob never came from the save path.
    const planted = await page.evaluate(({ key }) => {
      const origin = window.location.origin;
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
                    {
                      type: "leaf",
                      fraction: 0.5,
                      data: { id: "g-1", views: ["pane-1"], activeView: "pane-1" },
                    },
                    {
                      type: "leaf",
                      fraction: 0.5,
                      data: { id: "g-2", views: ["pane-2"], activeView: "pane-2" },
                    },
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
                "pane-1": {
                  id: "pane-1",
                  params: {
                    url: `${origin}/app`,
                    label: "this-server",
                    route: "?dir=%2Fhome%2Fx%2Frepo&session=sess-a",
                  },
                },
                "pane-2": {
                  id: "pane-2",
                  params: { url: `${origin}/app`, label: "this-server" },
                },
              } as unknown,
              activeGroup: "g-1",
            } as unknown,
          },
        ],
      };
      localStorage.setItem(key, JSON.stringify(blob));
      history.replaceState(null, "", window.location.pathname); // clean start_url
      return localStorage.getItem(key);
    }, { key: LAYOUT_STORAGE_KEY });
    expect(planted).toBeTruthy();

    // Clean relaunch onto the planted blob (no hash → read source=v3).
    const relaunchAt = Date.now();
    await page.goto("/");

    // CRUX: BOTH planted panes restore (2 .pane elements, both iframes at
    // /app, the routed one deep-linked with its captured query).
    await expect
      .poll(async () => (await paneIds(page)).length, { timeout: 20000 })
      .toBe(2);
    await expect(page.locator('[data-testid="empty-workspace"]')).toBeHidden();
    const srcs = await iframeSrcs(page);
    expect(srcs.sort()).toEqual(
      [
        `${new URL(page.url()).origin}/app`,
        `${new URL(page.url()).origin}/app?dir=%2Fhome%2Fx%2Frepo&session=sess-a`,
      ].sort(),
    );

    // The ring: read v3, no seed, restore restored BOTH panes, and the blob
    // still carries BOTH planted panes (not clobbered by an empty/seeded
    // rewrite). Anchored on the relaunch's own read event (see test 1).
    const events = await ring(page);
    const read = lastOf(events, "read");
    expect(read?.source, "planted blob read as v3").toBe("v3");
    expect(
      since(events, "seed", read!.t),
      `no seed after planted restore\nring:\n${fingerprint(events)}`,
    ).toEqual([]);
    const restore = lastOf(events, "restore");
    expect(restore?.outcome, "planted blob restored both panes").toBe("restored");
    expect(restore?.panes).toBe(2);
    await waitForQuiescentMirror(page, (p) => totalPanels(p) === 2, "planted blob survives (2 panels)");
  });

  test("second window boot does not clobber a valid blob", async ({ context, page }) => {
    // Build a valid folded blob in window 1 (the self-seed save).
    await page.goto("/");
    await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();
    await expect
      .poll(async () => (await paneIds(page)).length, { timeout: 20000 })
      .toBeGreaterThanOrEqual(1);
    const blobBefore = await waitForQuiescentMirror(
      page,
      (p) => totalPanels(p) === 1,
      "window-1 blob (1 panel)",
    ).then(() => blobRaw(page));
    expect(blobBefore).toBeTruthy();

    // THE VECTOR: a SECOND window boots at "/" while the blob exists (the
    // notificationclick/openWindow duplicate-boot shape; localStorage is
    // shared). Its boot must NOT overwrite the valid blob — no seed-flush, no
    // empty-layout write.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.locator('[data-testid="host-app-root"]')).toBeVisible();
    await expect
      .poll(async () => (await paneIds(page2)).length, { timeout: 20000 })
      .toBeGreaterThanOrEqual(1);

    // Let the second window settle past every boot-time save path (the seed
    // flush ~130ms-after-boot the operator's ring shows, the debounced hash
    // flush at 450ms, and the restored panes' route-driven saves).
    await page2.waitForTimeout(2500);

    // The blob may only ever still carry the SAME single-panel layout. (A
    // clobber would replace panel ids / zero the layout / rewrite bytes for
    // a fresh seed.) Anchored on window 2's OWN read event (window 1's
    // legitimate first-install seed precedes it).
    const events = await ring(page2);
    const read = lastOf(events, "read");
    expect(read?.source, "second window read the existing blob").toBe("v3");
    const seeds = since(events, "seed", read!.t);
    expect(
      seeds,
      `second window must not seed against a valid blob\nring:\n${fingerprint(events)}`,
    ).toEqual([]);
    const blobAfter = await blobRaw(page2);
    expect(blobAfter, "blob still present after second-window boot").toBeTruthy();
    const panelsAfter = totalPanels(JSON.parse(blobAfter!));
    expect(panelsAfter, "blob still carries the window-1 layout (1 panel)").toBe(1);
  });

  test("stale frozen #state= relic vs fresh LS: comparative read + hash heal (the operator's Android shape)", async ({ page }) => {
    // Boot once so the origin has a live host document (and let the boot
    // self-seed save settle so it cannot race the plant below).
    await page.goto("/");
    await expect(page.locator('[data-testid="host-app-root"]')).toBeVisible();
    await waitForQuiescentMirror(page, (p) => totalPanels(p) === 1, "self-seed settle");

    // Plant BOTH candidates of the launcher-replay posture, in-page (the
    // folded build has no DEV bridge):
    //   localStorage = the FRESH state: 2 workspaces, 1 pane each at
    //                  origin + /app, seq = now.
    //   URL hash     = the install-era RELIC: 1 workspace, seq 1h older —
    //                  the frozen task URL Android's launcher replays.
    const { freshIds, relicSeq, freshSeq, relicHash } = await page.evaluate(({ key }) => {
      const origin = window.location.origin;
      const now = Date.now();
      const pane = (id: string, group: string) => ({
        grid: {
          root: {
            type: "branch",
            data: [
              {
                type: "leaf",
                fraction: 1,
                data: { id: group, views: [id], activeView: id },
              },
            ],
          },
          width: 1024,
          height: 768,
          orientation: "HORIZONTAL",
        },
        panels: {
          [id]: { id, params: { url: `${origin}/app`, label: "this-server" } },
        },
        activeGroup: group,
      });
      const fresh = {
        v: 3,
        seq: now,
        activeWorkspaceId: "ws-f1",
        workspaces: [
          { id: "ws-f1", name: "Fresh 1", layout: pane("pane-f1", "g-f1") },
          { id: "ws-f2", name: "Fresh 2", layout: pane("pane-f2", "g-f2") },
        ],
      };
      const relic = {
        v: 3,
        seq: now - 3_600_000,
        activeWorkspaceId: "ws-old",
        workspaces: [
          { id: "ws-old", name: "Install Relic", layout: pane("pane-old", "g-old") },
        ],
      };
      localStorage.setItem(key, JSON.stringify(fresh));
      return {
        freshIds: ["ws-f1", "ws-f2"],
        relicSeq: now - 3_600_000,
        freshSeq: now,
        relicHash: "#state=" + encodeURIComponent(JSON.stringify(relic)),
      };
    }, { key: LAYOUT_STORAGE_KEY });

    // Relaunch carrying the frozen relic hash on the URL (a real navigation —
    // via about:blank, because the current page's URL already ends in the
    // self-seed #state= and a hash-only goto would be a same-document
    // fragment jump with no reload/module-init). relicHash already starts
    // with "#state=".
    await page.goto("about:blank");
    await page.goto("/" + relicHash);

    // CRUX 1: the FRESH 2-workspace state restored (its active workspace's
    // pane is live; no empty-workspace affordance) — not the 1-ws relic.
    await expect
      .poll(async () => (await paneIds(page)).length, { timeout: 20000 })
      .toBeGreaterThanOrEqual(1);
    await expect(page.locator('[data-testid="empty-workspace"]')).toBeHidden();

    // CRUX 2: the diag ring shows the comparative read verbatim — LS won
    // decisively (pick=ls, lsSeq = freshSeq, hashSeq = relicSeq), the hash
    // was HEALED, and NO seed fired after that read.
    const events = await ring(page);
    const read = lastOf(events, "read");
    expect(read, "relaunch read event").toBeTruthy();
    expect(read!.source).toBe("v3");
    expect(read!.pick, "localStorage won the comparative read").toBe("ls");
    expect(read!.hashSeq).toBe(relicSeq);
    expect(read!.lsSeq).toBe(freshSeq);
    expect(read!.healed, "the frozen hash was healed at boot").toBe(true);
    expect(read!.ws).toBe(2);
    expect(
      since(events, "seed", read!.t),
      `no seed after the stale-hash relaunch\nring:\n${fingerprint(events)}`,
    ).toEqual([]);
    const restore = lastOf(events, "restore");
    expect(restore, "restore event present").toBeTruthy();
    expect(restore!.outcome).toBe("restored");

    // CRUX 3: the URL hash now carries the FRESH state (healed) — and the
    // blob is not clobbered below the fresh 2-workspace shape by the boot.
    const healed = await page.evaluate(() => {
      const hash = window.location.hash;
      if (!hash.startsWith("#state=")) return null;
      try {
        return JSON.parse(decodeURIComponent(hash.slice("#state=".length))) as {
          workspaces?: Array<{ id: string }>;
        };
      } catch {
        return null;
      }
    });
    expect(healed, "hash still #state=-shaped after the heal").toBeTruthy();
    expect(
      (healed!.workspaces ?? []).map((w) => w.id).sort(),
      "hash healed to the fresh 2-ws state",
    ).toEqual(freshIds.slice().sort());
    const after = (await waitForQuiescentMirror(
      page,
      (p) => totalPanels(p) === 2,
      "post-relaunch blob (2 panels)",
    )) as { workspaces?: Array<{ id?: string }> };
    expect(
      (after.workspaces ?? []).map((w) => w.id ?? "").sort(),
      "LS not regressed below the fresh workspace set",
    ).toEqual(freshIds.slice().sort());
  });
});
