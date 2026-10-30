import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// NEEDS-YOU NOTIFICATIONS e2e (host-web/src/attentionNotify.ts).
//
// HONEST VERIFICATION SCOPE (state this clearly): the host e2e dev servers
// (vite :5173) do NOT serve /sw.js, so the REAL service-worker delivery path
// is NOT e2e-testable in this lane. The delivery MECHANISM is probe-proven on
// the operator's Fold (Edge Android 151 + Chrome: SW showNotification renders
// heads-ups + persistent shade entries; same-tag replace; click focuses the
// installed app). What THIS lane proves is OUR logic on top of that proven
// mechanism, through a STUBBED SW seam:
//
//   - a fake `navigator.serviceWorker` (ready → fake registration whose
//     showNotification/getNotifications log calls + model same-tag replace),
//     a fake `Notification` (controllable permission), and fake badge
//     methods, injected via addInitScript BEFORE the app boots;
//   - needs are driven through the REAL router (H.probeStatus — the same
//     source-bound path the SPA's statusEmitter uses);
//   - the toggle is driven through the REAL Settings UI (user-gesture
//     permission path) or the production setter via the DEV bridge;
//   - visibility is driven via the DEV bridge's override + a REAL
//     `visibilitychange` event dispatch (the headless page otherwise stays
//     "visible" forever — the kbdFocusOpen mechanism-proof precedent).
//
// host-web has NO unit runner (package.json: playwright only), so the PURE
// core (episodeDiff / summaryNotification / perPaneSuppressed) is asserted
// unit-style through the DEV bridge (`__hostAttention.pure`) — the same
// "pure math via bridge" precedent as proportions.spec.ts.
//
// The suite is serial (host-web playwright.config.ts: workers:1).
// =============================================================================

/** Storage key the toggle persists (must match src/attentionNotify.ts). */
const KEY = "vh-host:attentionNotify:v1";

type FakeEntry = {
  op: "sw-show" | "sw-closed" | "sw-register" | "sw-badge" | "sw-badge-clear";
  tag?: string;
  title?: string;
  body?: string;
  count?: number;
};

/** Install the SW/Notification/badge fakes BEFORE the single app boot.
 *  FRAME GUARD (load-bearing — see named-layouts.spec.ts): addInitScript also
 *  runs in CHILD FRAMES at attach, and a fresh iframe is briefly a same-origin
 *  about:blank sharing the HOST's localStorage — main-frame-only + once. */
async function initFakes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window !== window.top) return; // frames must keep the REAL platform
    const w = window as unknown as Record<string, unknown>;
    if (w.__attentionNotifyFakeInstalled) return;
    w.__attentionNotifyFakeInstalled = true;
    localStorage.clear();

    const log: Array<Record<string, unknown>> = [];
    interface FakeNotif {
      tag: string;
      title: string;
      closed: boolean;
      close(): void;
    }
    const openByTag = new Map<string, FakeNotif[]>();
    function mkNotif(tag: string, title: string): FakeNotif {
      const n: FakeNotif = {
        tag,
        title,
        closed: false,
        close() {
          if (n.closed) return;
          n.closed = true;
          log.push({ op: "sw-closed", tag });
          const arr = openByTag.get(tag);
          if (arr) {
            const i = arr.indexOf(n);
            if (i >= 0) arr.splice(i, 1);
          }
        },
      };
      return n;
    }
    const reg = {
      // `ready`/register() only ever resolve registrations with an ACTIVE
      // worker (spec guarantee) — the S4 notifyRegistration prefers root and
      // checks reg.active, so the fake models an active worker stub.
      active: {},
      // Platform fact #6 model: a same-tag show REPLACES the open entry.
      showNotification(title: string, opts: { tag?: string; body?: string }) {
        const tag = opts?.tag ?? "";
        openByTag.delete(tag); // replaced entries vanish WITHOUT close events
        const n = mkNotif(tag, title);
        openByTag.set(tag, [n]);
        log.push({ op: "sw-show", tag, title, body: opts?.body ?? "" });
        return Promise.resolve();
      },
      getNotifications(f: { tag?: string }) {
        if (f && typeof f.tag === "string") {
          return Promise.resolve((openByTag.get(f.tag) ?? []).slice());
        }
        const all: FakeNotif[] = [];
        for (const arr of openByTag.values()) all.push(...arr);
        return Promise.resolve(all);
      },
    };
    const swc = {
      get ready() {
        return Promise.resolve(reg);
      },
      register: (url: string) => {
        log.push({ op: "sw-register", tag: url });
        return Promise.resolve(reg);
      },
      // S4 notify-focus plumbing — model exactly what attentionNotify touches
      // on the REAL navigator.serviceWorker: the "message" EventTarget + the
      // controller's postMessage. The WORKER side (sw.js) is simulated: the
      // pending cold-open flag (notificationclick's openWindow rung arms it;
      // a VH_NOTIFY_FOCUS_QUERY consumes it ONCE and replies "vh-notify-focus"
      // as a message event — mirroring web/public/sw.js).
      addEventListener: (t: string, fn: (ev: { data: unknown }) => void) => {
        if (t === "message") messageListeners.push(fn);
      },
      removeEventListener: (t: string, fn: (ev: { data: unknown }) => void) => {
        if (t !== "message") return;
        const i = messageListeners.indexOf(fn);
        if (i >= 0) messageListeners.splice(i, 1);
      },
      get controller() {
        return controllerStub;
      },
    };
    const messageListeners: Array<(ev: { data: unknown }) => void> = [];
    let workerPendingNotify = false;
    let notifyQueryCount = 0;
    const controllerStub = {
      postMessage(m: { type?: string }) {
        if (m && m.type === "VH_NOTIFY_FOCUS_QUERY") {
          notifyQueryCount++;
          if (!workerPendingNotify) return; // ordinary boot — nothing pending
          workerPendingNotify = false; // one-shot consume (mirrors sw.js)
          setTimeout(() => {
            for (const fn of messageListeners) fn({ data: { type: "vh-notify-focus" } });
          }, 0);
        }
      },
    };
    try {
      Object.defineProperty(navigator, "serviceWorker", {
        get: () => swc,
        configurable: true,
      });
    } catch {
      /* engine refused the shadow — tests fail loudly downstream */
    }

    // Fake Notification: controllable permission; requestPermission honors a
    // test-set grant outcome (window.__fakeSwGrant). The manager only uses
    // the SW show path (platform fact #3) — the constructor is never called.
    const perm = { value: "granted" };
    function FakeNotification(): void {
      /* unused by design */
    }
    Object.defineProperty(FakeNotification, "permission", {
      get: () => perm.value,
      configurable: true,
    });
    FakeNotification.requestPermission = () => {
      const grant = (w.__fakeSwGrant as string | undefined) ?? perm.value;
      perm.value = grant;
      return Promise.resolve(grant);
    };
    try {
      Object.defineProperty(window, "Notification", {
        value: FakeNotification,
        configurable: true,
      });
    } catch {
      /* ignore */
    }

    // Badge fakes (the real setAppBadge is a silent no-op on Android — here we
    // need to OBSERVE the calls).
    const nav = navigator as unknown as Record<string, unknown>;
    nav.setAppBadge = (n?: number) => {
      log.push({ op: "sw-badge", count: n });
      return Promise.resolve();
    };
    nav.clearAppBadge = () => {
      log.push({ op: "sw-badge-clear" });
      return Promise.resolve();
    };

    w.__fakeSw = {
      log,
      setPermission: (p: string) => {
        perm.value = p;
      },
      openCounts: (): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const [t, arr] of openByTag) out[t] = arr.length;
        return out;
      },
      // S4 notify-focus worker-side controls.
      armPendingNotify: () => {
        workerPendingNotify = true;
      },
      pendingNotifyArmed: (): boolean => workerPendingNotify,
      notifyQueryCount: (): number => notifyQueryCount,
      /** Deliver the worker→page warm-path signal through the REAL installed
       *  listener (models host.postMessage from notificationclick). */
      deliverNotifyFocus: () => {
        for (const fn of messageListeners) fn({ data: { type: "vh-notify-focus" } });
      },
    };
  });
}

// ---- tiny wrappers over the in-page fakes / DEV bridge -----------------------

async function fakeLog(page: Page): Promise<FakeEntry[]> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fakeSw?: { log: unknown[] } }).__fakeSw;
    return (f ? f.log : []) as FakeEntry[];
  });
}

/** Shows recorded for a tag (the fake SW's view of what the platform saw). */
async function shows(page: Page, tag: string): Promise<FakeEntry[]> {
  return (await fakeLog(page)).filter((e) => e.op === "sw-show" && e.tag === tag);
}

/** Title of a tag's LATEST show call ("" when none yet). The summary UPDATES
 *  via same-tag replace, so a tag legitimately accumulates show calls — the
 *  latest one is the current content. */
async function latestTitle(page: Page, tag: string): Promise<string> {
  const s = await shows(page, tag);
  return s.length ? s[s.length - 1].title ?? "" : "";
}

/** The manager's DECISION log (includes suppressed episodes that produced no
 *  platform call — the fake SW cannot see those). DEV bridge, absent in prod. */
async function managerLog(
  page: Page,
): Promise<Array<{ op: string; tag?: string; title?: string; body?: string; count?: number }>> {
  return page.evaluate(() => {
    const b = (window as unknown as { __hostAttention?: { log(): unknown[] } }).__hostAttention;
    return (b ? b.log() : []) as Array<{ op: string; tag?: string; title?: string; body?: string; count?: number }>;
  });
}

/** DEV-bridge visibility override (null = real document.visibilityState). */
async function setHidden(page: Page, hidden: boolean | null): Promise<void> {
  await page.evaluate((h) => {
    const b = (window as unknown as { __hostAttention?: { setHidden(v: boolean | null): void } }).__hostAttention;
    b?.setHidden(h);
  }, hidden);
}

/** Notify-focus one-shot state (armed / fired count). DEV bridge. */
async function notifyFocusState(page: Page): Promise<{ armed: boolean; fired: number }> {
  return page.evaluate(() => {
    const b = (window as unknown as { __hostAttention?: { notifyFocusState(): { armed: boolean; fired: number } } })
      .__hostAttention;
    return b ? b.notifyFocusState() : { armed: false, fired: -1 };
  });
}

/** Override the notify-focus arm deadline (null = production 30s). */
async function setNotifyFocusArmMs(page: Page, ms: number | null): Promise<void> {
  await page.evaluate((v) => {
    const b = (window as unknown as { __hostAttention?: { setNotifyFocusArmMs(x: number | null): void } })
      .__hostAttention;
    b?.setNotifyFocusArmMs(v);
  }, ms);
}

/** Simulate the notification-derived activation through the SAME handler the
 *  swNarrow focus-channel listener routes through (swFocusHostListener). */
async function simulateNotifyFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const b = (window as unknown as { __hostAttention?: { simulateNotifyFocus(): void } }).__hostAttention;
    b?.simulateNotifyFocus();
  });
}

/** Re-fire the production boot query (install-time in prod; App mount cannot
 *  be re-entered headlessly). */
async function requeryPendingNotifyFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const b = (window as unknown as { __hostAttention?: { requeryPendingNotifyFocus(): void } }).__hostAttention;
    b?.requeryPendingNotifyFocus();
  });
}

/** Enable/disable through the PRODUCTION setter (toggle + side effects). */
async function setNotifyEnabled(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => {
    const b = (window as unknown as { __hostAttention?: { setEnabled(x: boolean): void } }).__hostAttention;
    b?.setEnabled(v);
  }, on);
}

/** Probe a needs-you status for a pane through the REAL router. */
async function probeAttention(
  page: Page,
  paneId: string,
  attention: "none" | "needs_reply" | "needs_permission",
  title = "Needy",
): Promise<void> {
  const r = await H.probeStatus(page, {
    sourcePaneId: paneId,
    origin: H.MOCK_ORIGIN,
    payload: {
      type: "status",
      dir: "",
      session: "",
      title,
      attention,
      activity: "idle",
      following: true,
      runningCount: 0,
      unreadCount: 0,
    },
  });
  expect(r.accepted, `status ${attention} accepted`).toBe(true);
}

/** Wait until the fake SW holds exactly `n` open notifications for `tag`. */
async function waitForOpen(page: Page, tag: string, n: number, timeoutMs = 4000): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((t) => {
          const f = (window as unknown as { __fakeSw?: { openCounts(): Record<string, number> } }).__fakeSw;
          return f ? (f.openCounts()[t] ?? 0) : -1;
        }, tag),
      { timeout: timeoutMs },
    )
    .toBe(n);
}

// ---- pure core (unit-style, via the DEV bridge) -------------------------------

/** A synthetic NeedyPane for the pure-core probes. */
function needy(paneId: string, attention: "needs_reply" | "needs_permission", label = paneId): Record<string, unknown> {
  return { paneId, label, attention, firstNeedsYouAt: 0 };
}

test.describe("attention-notify pure core (via __hostAttention.pure)", () => {
  test.beforeEach(async ({ page }) => {
    await initFakes(page);
    await H.loadHost(page);
  });

  test("episode edges: none→needy fires; kind-change within an episode does NOT re-fire; needy→none closes", async ({ page }) => {
    const fire = await page.evaluate(([prev, next]) => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { episodeDiff(p: unknown, n: unknown): unknown } };
      }).__hostAttention;
      return b!.pure.episodeDiff(prev, next);
    }, [
      [],
      [["p1", needy("p1", "needs_permission", "srv-A · chat")]],
    ]);
    expect(fire).toEqual([
      { kind: "fire", pane: { paneId: "p1", label: "srv-A · chat", attention: "needs_permission", firstNeedsYouAt: 0 } },
    ]);

    // needs_reply → needs_permission: SAME continuous episode → NO action.
    const kindChange = await page.evaluate(([prev, next]) => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { episodeDiff(p: unknown, n: unknown): unknown } };
      }).__hostAttention;
      return b!.pure.episodeDiff(prev, next);
    }, [
      [["p1", needy("p1", "needs_reply")]],
      [["p1", needy("p1", "needs_permission")]],
    ]);
    expect(kindChange).toEqual([]);

    // needs → none: the episode resolves → close.
    const resolve = await page.evaluate(([prev, next]) => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { episodeDiff(p: unknown, n: unknown): unknown } };
      }).__hostAttention;
      return b!.pure.episodeDiff(prev, next);
    }, [
      [["p1", needy("p1", "needs_reply")]],
      [],
    ]);
    expect(resolve).toEqual([{ kind: "close", paneId: "p1" }]);
  });

  test("summary aggregation: count/title/body, 3-label cap + ellipsis, empty → null, urgency order", async ({ page }) => {
    const five = ["a", "b", "c", "d", "e"].map((id) => needy(id, "needs_reply", `label-${id}`));
    const s5 = await page.evaluate((list) => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { summary(l: unknown): unknown } };
      }).__hostAttention;
      return b!.pure.summary(list);
    }, five);
    expect(s5).toEqual({ count: 5, title: "5 need you", body: "label-a, label-b, label-c …" });

    const s1 = await page.evaluate((list) => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { summary(l: unknown): unknown } };
      }).__hostAttention;
      return b!.pure.summary(list);
    }, [needy("a", "needs_reply", "label-a")]);
    expect(s1).toEqual({ count: 1, title: "1 needs you", body: "label-a" });

    const s0 = await page.evaluate(() => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { summary(l: unknown): unknown } };
      }).__hostAttention;
      return b!.pure.summary([]);
    });
    expect(s0).toBeNull();

    // The pure fn renders the GIVEN order as-is — ranking is the CALLER's job
    // (enumerateNeedy ranks: needs_permission before needs_reply). Assert the
    // contract both ways: a ranked input stays ranked, an unranked one is NOT
    // silently re-sorted (no hidden ordering magic in the pure core).
    const ranked = await page.evaluate((list) => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { summary(l: unknown): unknown } };
      }).__hostAttention;
      return b!.pure.summary(list);
    }, [needy("perm", "needs_permission", "perm-label"), needy("reply", "needs_reply", "reply-label")]);
    expect((ranked as { body: string }).body).toBe("perm-label, reply-label");
    const unranked = await page.evaluate((list) => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { summary(l: unknown): unknown } };
      }).__hostAttention;
      return b!.pure.summary(list);
    }, [needy("reply", "needs_reply", "reply-label"), needy("perm", "needs_permission", "perm-label")]);
    expect((unranked as { body: string }).body).toBe("reply-label, perm-label");
  });

  test("visibility gate: per-pane heads-up suppressed ONLY while visible; body text mapping; stable tags", async ({ page }) => {
    const gate = await page.evaluate(() => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { perPaneSuppressed(v: string): boolean; paneTag(p: string): string } };
      }).__hostAttention;
      return {
        visible: b!.pure.perPaneSuppressed("visible"),
        hidden: b!.pure.perPaneSuppressed("hidden"),
        prerender: b!.pure.perPaneSuppressed("prerender"),
        tag: b!.pure.paneTag("pane-7"),
      };
    });
    expect(gate.visible).toBe(true); // summary is NEVER gated — that is asserted live below
    expect(gate.hidden).toBe(false);
    expect(gate.prerender).toBe(false);
    expect(gate.tag).toBe("vh-needy-pane-7");

    const bodies = await page.evaluate(() => {
      const b = (window as unknown as {
        __hostAttention?: { pure: { body(a: string): string } };
      }).__hostAttention;
      return { perm: b!.pure.body("needs_permission"), reply: b!.pure.body("needs_reply") };
    });
    expect(bodies.perm).toBe("Waiting for permission");
    expect(bodies.reply).toBe("Waiting for your reply");
  });
});

// ---- integration (stubbed SW seam, real router + real UI) ---------------------

test.describe("attention-notify integration (fake serviceWorker seam)", () => {
  test.beforeEach(async ({ page }) => {
    await initFakes(page);
    await H.loadHost(page);
  });

  test("toggle OFF (default, opt-in): needs produce NO notifications", async ({ page }) => {
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull(); // absent = OFF
    const ids = await H.panes(page);
    await probeAttention(page, ids[0], "needs_permission");
    await page.waitForTimeout(300); // any (wrong) fire would land within microtasks; be generous
    const sw = await fakeLog(page);
    expect(sw.filter((e) => e.op === "sw-show"), "nothing shown while OFF").toEqual([]);
    expect(sw.filter((e) => e.op === "sw-badge"), "no badge while OFF").toEqual([]);
    const m = await managerLog(page);
    expect(m.filter((e) => e.op === "show" || e.op === "suppressed")).toEqual([]);
    expect(m.filter((e) => e.op === "register"), "no SW registration while OFF").toEqual([]);
  });

  test("toggle ON via Settings UI (granted): SW registered; hidden episode fires per-pane tag/title/body + summary + badge", async ({ page }) => {
    const ids = await H.panes(page);
    const params = await H.paneParams(page);
    const label = params.find((p) => p.id === ids[0])!.label;

    // "Background" the host first (DEV override — the headless page is
    // otherwise visible and the per-pane heads-up is gated off).
    await setHidden(page, true);

    // Enable through the REAL Settings UI. The fake's permission is
    // pre-granted, so the click flips the toggle synchronously.
    await page.locator('[data-testid="settings-btn"]').click();
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
    const item = page.locator('[data-testid="settings-notify"]');
    await expect(item).toHaveAttribute("aria-checked", "false");
    await item.click();
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
      .toBe("on");
    await expect(item).toHaveAttribute("aria-checked", "true");
    // Registration happened ON ENABLE (the documented choice).
    expect((await fakeLog(page)).some((e) => e.op === "sw-register" && e.tag === "/sw.js")).toBe(true);

    // A need lands → ONE per-pane notification with the stable tag + title.
    await probeAttention(page, ids[0], "needs_permission");
    const tag = `vh-needy-${ids[0]}`;
    await expect.poll(async () => (await shows(page, tag)).length).toBe(1);
    const show = (await shows(page, tag))[0];
    expect(show.title).toBe(`${label} needs you`);
    expect(show.body).toBe("Waiting for permission");

    // The persistent summary + the badge fired alongside (hidden, so both).
    const summary = await shows(page, "vh-needy-summary");
    expect(summary.length).toBe(1);
    expect(summary[0].title).toBe("1 needs you");
    expect(summary[0].body).toContain(label);
    expect((await fakeLog(page)).some((e) => e.op === "sw-badge" && e.count === 1)).toBe(true);
  });

  test("episode dedupe: kind-change within an episode never re-fires; resolve→re-need re-fires the SAME tag", async ({ page }) => {
    const ids = await H.panes(page);
    const tag = `vh-needy-${ids[0]}`;
    await setHidden(page, true);
    await setNotifyEnabled(page, true);

    await probeAttention(page, ids[0], "needs_reply");
    await expect.poll(async () => (await shows(page, tag)).length).toBe(1);
    expect((await shows(page, tag))[0].body).toBe("Waiting for your reply");

    // Continuous episode, kind escalates: NO second show.
    await probeAttention(page, ids[0], "needs_permission");
    await page.waitForTimeout(300);
    expect((await shows(page, tag)).length).toBe(1);

    // Resolve → the per-pane notification CLOSES and the shade entry is gone.
    await probeAttention(page, ids[0], "none");
    await expect
      .poll(async () => (await fakeLog(page)).filter((e) => e.op === "sw-closed" && e.tag === tag).length)
      .toBe(1);
    await waitForOpen(page, tag, 0);

    // Re-need → a NEW episode fires the SAME tag (platform same-tag replace).
    await probeAttention(page, ids[0], "needs_permission");
    await expect.poll(async () => (await shows(page, tag)).length).toBe(2);
    await waitForOpen(page, tag, 1); // replaced, never stacked
  });

  test("summary: GLOBAL count across workspaces, live updates, close + badge clear at zero-needy", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const ids = await H.panes(page);
    const ws1Label = (await H.paneParams(page)).find((p) => p.id === ids[0])!.label;

    // A second workspace with its own pane (needs land there while it is
    // BACKGROUND — the global count must include it).
    await H.addWorkspace(page, "BG");
    const bgPane = await H.addServer(page, H.serverUrl("notify-bg"), "notify-bg");
    expect(bgPane).toBeTruthy();
    await H.waitForReady(page, bgPane!);
    const bgLabel = (await H.paneParams(page)).find((p) => p.id === bgPane)!.label;
    await H.setActiveWorkspace(page, ws1);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);

    await setHidden(page, true);
    await setNotifyEnabled(page, true);

    // Reply-need in the ACTIVE workspace first → summary "1 needs you".
    await probeAttention(page, ids[0], "needs_reply");
    await expect.poll(async () => latestTitle(page, "vh-needy-summary")).toBe("1 needs you");

    // …then a permission-need in the BACKGROUND workspace → the summary
    // UPDATES via same-tag replace (a second show call, still ONE open
    // entry), permission listed first (urgency rank), count = GLOBAL 2.
    await probeAttention(page, bgPane!, "needs_permission");
    await expect.poll(async () => latestTitle(page, "vh-needy-summary")).toBe("2 need you");
    const summary = (await shows(page, "vh-needy-summary"))[1]; // the 2-count update
    expect(summary.body).toBe(`${bgLabel}, ${ws1Label}`);
    await waitForOpen(page, "vh-needy-summary", 1); // replaced, never stacked
    expect((await fakeLog(page)).some((e) => e.op === "sw-badge" && e.count === 2)).toBe(true);

    // Background need resolves → summary updates to 1 (same-tag replace, not a
    // second entry) — proving the count tracks BACKGROUND workspaces live.
    await probeAttention(page, bgPane!, "none");
    await expect.poll(async () => latestTitle(page, "vh-needy-summary")).toBe("1 needs you");
    const updated = (await shows(page, "vh-needy-summary"))[2];
    expect(updated.body).toBe(ws1Label);
    await waitForOpen(page, "vh-needy-summary", 1);

    // Last need resolves → the summary notification CLOSES + the badge clears.
    await probeAttention(page, ids[0], "none");
    await expect
      .poll(async () => (await fakeLog(page)).filter((e) => e.op === "sw-closed" && e.tag === "vh-needy-summary").length)
      .toBe(1);
    await waitForOpen(page, "vh-needy-summary", 0);
    expect((await fakeLog(page)).some((e) => e.op === "sw-badge-clear")).toBe(true);
    // …and the per-pane entries closed with it.
    await waitForOpen(page, `vh-needy-${ids[0]}`, 0);
    await waitForOpen(page, `vh-needy-${bgPane}`, 0);
  });

  test("visibility gate (live): visible suppresses the per-pane heads-up but NOT the summary; hidden flushes the pending fire", async ({ page }) => {
    const ids = await H.panes(page);
    const tag = `vh-needy-${ids[0]}`;
    await setNotifyEnabled(page, true); // page still VISIBLE (override null)

    await probeAttention(page, ids[0], "needs_permission");
    await page.waitForTimeout(300);

    // Per-pane: suppressed (the operator is looking at the host)…
    expect((await shows(page, tag)).length).toBe(0);
    const m = await managerLog(page);
    expect(m.some((e) => e.op === "suppressed" && e.tag === tag)).toBe(true);
    // …but the summary + badge ARE maintained regardless of visibility.
    expect((await shows(page, "vh-needy-summary")).length).toBe(1);
    expect((await fakeLog(page)).some((e) => e.op === "sw-badge" && e.count === 1)).toBe(true);

    // Backgrounding the host (override + the REAL visibilitychange event) must
    // flush the pending heads-up for the still-open episode.
    await setHidden(page, true);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(async () => (await shows(page, tag)).length).toBe(1);
    expect((await shows(page, tag))[0].body).toBe("Waiting for permission");
  });

  test("disable mid-flight: off means off — everything we own closes + badge clears", async ({ page }) => {
    const ids = await H.panes(page);
    const tag = `vh-needy-${ids[0]}`;
    await setHidden(page, true);
    await setNotifyEnabled(page, true);
    await probeAttention(page, ids[0], "needs_permission");
    await expect.poll(async () => (await shows(page, tag)).length).toBe(1);
    await waitForOpen(page, "vh-needy-summary", 1);

    // Toggle off through the production setter (the Settings click routes
    // here) → owned notifications close + badge clears.
    await setNotifyEnabled(page, false);
    await expect
      .poll(async () => (await fakeLog(page)).filter((e) => e.op === "sw-closed").length)
      .toBe(2); // the per-pane entry + the summary
    await waitForOpen(page, tag, 0);
    await waitForOpen(page, "vh-needy-summary", 0);
    expect((await fakeLog(page)).some((e) => e.op === "sw-badge-clear")).toBe(true);
  });
});

// ---- Settings toggle permission flows (real UI) -------------------------------

test.describe("needs-you Settings toggle (permission flows)", () => {
  test.beforeEach(async ({ page }) => {
    await initFakes(page);
    await H.loadHost(page);
  });

  async function openSettings(page: Page) {
    await page.locator('[data-testid="settings-btn"]').click();
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
  }

  test("denied permission: stays off + inline hint pointing at browser settings", async ({ page }) => {
    await page.evaluate(() => {
      const f = (window as unknown as { __fakeSw?: { setPermission(p: string): void } }).__fakeSw;
      f?.setPermission("denied");
    });
    await openSettings(page);
    const item = page.locator('[data-testid="settings-notify"]');
    await expect(item).toHaveAttribute("aria-checked", "false");
    await item.click();
    await expect(item).toHaveAttribute("aria-checked", "false"); // stays off
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull(); // never persisted on
    const hint = page.locator('[data-testid="settings-notify-hint"]');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("browser settings");
  });

  test("prompt declined: stays off + retry hint", async ({ page }) => {
    await page.evaluate(() => {
      const f = (window as unknown as { __fakeSw?: { setPermission(p: string): void } }).__fakeSw;
      f?.setPermission("default");
    });
    await openSettings(page);
    const item = page.locator('[data-testid="settings-notify"]');
    await item.click(); // requestPermission resolves "default" (declined)
    await expect(item).toHaveAttribute("aria-checked", "false");
    await expect(page.locator('[data-testid="settings-notify-hint"]')).toContainText("retry");
  });

  test("prompt granted via the click's user gesture: toggle flips on, no hint", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const f = (w.__fakeSw as { setPermission(p: string): void });
      f.setPermission("default");
      w.__fakeSwGrant = "granted"; // the prompt this click opens answers "granted"
    });
    await openSettings(page);
    const item = page.locator('[data-testid="settings-notify"]');
    await item.click();
    await expect(item).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
      .toBe("on");
    await expect(page.locator('[data-testid="settings-notify-hint"]')).toHaveCount(0);
  });

  test("toggle off from on: key persists off (reversible default, next boot starts OFF)", async ({ page }) => {
    await openSettings(page); // permission pre-granted (fake default)
    const item = page.locator('[data-testid="settings-notify"]');
    await item.click();
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
      .toBe("on");
    await item.click(); // off again
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
      .toBe("off");
    await expect(item).toHaveAttribute("aria-checked", "false");
  });
});

// ---- notification-derived tap selection (S4 notify-focus) ----------------------
//
// The Android shade TAP itself (the real gesture on a swept PWA) is not
// headlessly reproducible — this block proves the MECHANISM the tap drives on
// the HOST side: the "vh-notify-focus" signal → one-shot arm → the PRODUCTION
// attentionNext.next() selection over FRESH live state (probeStatus-driven,
// never the notification payload), the cold-boot deferral (state arrives
// seconds after the shell), the deadline expiry (no stale hijack), and the
// boot-query one-shot (cold open). The sw.js side of the contract is pinned
// statically by web/tests/unit/sw-notificationclick.test.ts.

test.describe("notify-focus: notification-derived tab selection (S4)", () => {
  test.beforeEach(async ({ page }) => {
    await initFakes(page);
    await H.loadHost(page);
  });

  test("warm signal with live needy state selects the needy tab through production next(); no need → stays armed", async ({ page }) => {
    const ids = await H.panes(page);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    // Focus the OTHER pane so the selection is observable.
    await H.focusPane(page, ids[1]);
    await expect.poll(async () => H.focused(page)).toBe(ids[1]);
    // A need lands on pane 0 (fresh, router-driven — not payload-driven).
    await probeAttention(page, ids[0], "needs_permission");

    // The worker's warm-path signal arrives as an SW message event — deliver
    // it through the REAL installed listener.
    await page.evaluate(() => {
      const f = (window as unknown as { __fakeSw?: { deliverNotifyFocus(): void } }).__fakeSw;
      f?.deliverNotifyFocus();
    });
    // FRESH state selected the needy pane via the production next() path.
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(ids[0]);
    const st = await notifyFocusState(page);
    expect(st.armed).toBe(false); // fired immediately — no pending arm left
    expect(st.fired).toBe(1);

    // With NO needy pane, the same signal arms and WAITS (cold-boot posture)
    // instead of selecting anything.
    await probeAttention(page, ids[0], "none");
    await expect.poll(async () => H.needsYou(page)).toBe(0);
    await H.focusPane(page, ids[1]);
    await page.evaluate(() => {
      const f = (window as unknown as { __fakeSw?: { deliverNotifyFocus(): void } }).__fakeSw;
      f?.deliverNotifyFocus();
    });
    const armed = await notifyFocusState(page);
    expect(armed.armed).toBe(true);
    await page.waitForTimeout(250);
    expect(await H.focused(page)).toBe(ids[1]); // nothing was selected
  });

  test("cold-open deferral: signal with NO needy state stays armed and selects on the FIRST fresh arrival", async ({ page }) => {
    const ids = await H.panes(page);
    await setNotifyFocusArmMs(page, 4000); // generous arm window for this proof
    // Cold posture: activation arrives BEFORE any pane has reported a need.
    await simulateNotifyFocus(page);
    expect((await notifyFocusState(page)).armed).toBe(true);
    expect((await notifyFocusState(page)).fired).toBe(0);

    // Fresh state arrives seconds "later" (panes boot, probes land)…
    await probeAttention(page, ids[0], "needs_reply");
    // …and the armed one-shot selects it — exactly once.
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(ids[0]);
    const st = await notifyFocusState(page);
    expect(st.armed).toBe(false);
    expect(st.fired).toBe(1);
  });

  test("deadline expiry: an expired arm never hijacks a later arrival; ordinary needs never select", async ({ page }) => {
    const ids = await H.panes(page);
    await H.focusPane(page, ids[1]);
    await expect.poll(async () => H.focused(page)).toBe(ids[1]);
    await setNotifyFocusArmMs(page, 150);
    await simulateNotifyFocus(page);
    expect((await notifyFocusState(page)).armed).toBe(true);
    await page.waitForTimeout(400); // arm expires untouched
    expect((await notifyFocusState(page)).armed).toBe(false);

    // A need arriving AFTER expiry is a plain in-app need — no selection
    // (the operator taps NEXT). Only notification-derived activation selects.
    await probeAttention(page, ids[0], "needs_permission");
    await expect.poll(async () => H.needsYou(page)).toBe(1);
    await page.waitForTimeout(250);
    expect(await H.focused(page)).toBe(ids[1]);
    expect((await notifyFocusState(page)).fired).toBe(0);
  });

  test("boot query: install asked the worker; a pending cold-open activation replies ONCE, a re-query does not", async ({ page }) => {
    // Ordinary boot (beforeEach's loadHost): install fired the query, the
    // worker had nothing pending → no arm.
    const queries = () =>
      page.evaluate(() => (window as unknown as { __fakeSw?: { notifyQueryCount(): number } }).__fakeSw?.notifyQueryCount() ?? -1);
    expect(await queries()).toBeGreaterThanOrEqual(1);
    expect((await notifyFocusState(page)).armed).toBe(false);

    // notificationclick's openWindow rung armed the worker-side flag; the
    // (replayed) boot query consumes it exactly once and the reply runs the
    // same one-shot as the warm path.
    const ids = await H.panes(page);
    await H.focusPane(page, ids[1]);
    await probeAttention(page, ids[0], "needs_permission");
    await page.evaluate(() => {
      const f = (window as unknown as { __fakeSw?: { armPendingNotify(): void } }).__fakeSw;
      f?.armPendingNotify();
    });
    await requeryPendingNotifyFocus(page);
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(ids[0]);
    expect((await notifyFocusState(page)).armed).toBe(false);
    expect(
      await page.evaluate(() => (window as unknown as { __fakeSw?: { pendingNotifyArmed(): boolean } }).__fakeSw?.pendingNotifyArmed()),
      "the worker consumed the pending flag (one-shot)",
    ).toBe(false);

    // A SECOND query gets nothing — the flag was consumed, no re-arm.
    await requeryPendingNotifyFocus(page);
    await page.waitForTimeout(120);
    expect((await notifyFocusState(page)).armed).toBe(false);
    expect((await notifyFocusState(page)).fired).toBe(1);
  });
});
