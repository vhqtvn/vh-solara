import { test, expect, type Page, type Frame } from "@playwright/test";
import * as H from "../e2e/util";

// =============================================================================
// LANE 8 — real-embedding host-web e2e (graduated from the Phase-0′ spike).
//
// The REAL production `web/` SPA embedded as a cross-origin <iframe> inside the
// host-web host shell. This is the FIRST host-web lane to NOT use the mock
// content page (host-web/iframe-content/content.ts) — it embeds the real SPA
// served by a real `local-server` binary (built + materialized into
// pkg/web/dist/, served via //go:embed).
//
// Topology (cross-ORIGIN, same-SITE — the production subdomain analog):
//   host parent  : http://localhost:5183   (host-web SolidJS/Dockview shell,
//                                           VITE_IFRAME_ORIGIN=:8765)
//   embedded SPA : http://localhost:8765   (real vh-solara local-server,
//                                           --auth-mode none (loopback default),
//                                           --frame-ancestors localhost:5183)
//
// AUTH POSTURE: --auth-mode none (server default, loopback-permitted). NO login
// step, NO session cookie. The two cruxes this lane closes are cookie-
// INDEPENDENT:
//   (A) the live production heartbeat emitter (web/src/heartbeat.ts) drives the
//       host's Q1-C "document alive" indicator — postMessage, no cookie needed;
//   (B) the real-SPA iframe survives a Dockview layout op (renderer:'always') —
//       iframe identity, no cookie needed.
// The SameSite=Lax cookie crux was PROVEN by the Phase-0′ spike in passphrase
// mode and is not re-exercised here. The "gate continuity" assertion below is
// satisfied trivially under no-auth (no /auth/login gate to redirect to); it
// remains a valid smoke that a regression starting to gate would be caught.
//
// Runs on Chromium + Firefox (see playwright.real-embed.config.ts). Scheduled/
// dispatchable ONLY — NOT PR-blocking.
// =============================================================================

// Derive the real origin from the SAME env var the Playwright config uses to
// boot the webServer (playwright.real-embed.config.ts), so a port override
// cannot drift the config's boot target from the spec's frame-finder.
const REAL = `http://localhost:${process.env.REAL_EMBED_REAL_PORT ?? "8765"}`;

// ---------------------------------------------------------------------------
// network probe (reused from the Phase-0′ spike, proven on both browsers)
// ---------------------------------------------------------------------------

/** Collect /vh + /oc responses attributed by originating frame. Used to confirm
 *  the real SSE channel connects from within the cross-origin iframe. */
function attachNet(page: Page) {
  const watchByFrame = new Map<Frame, number>(); // /vh/project-settings/watch SSE count
  const allVh: { url: string; status: number }[] = [];
  page.on("response", (resp) => {
    const u = resp.url();
    const status = resp.status();
    try {
      if (u.includes("/vh/") || u.includes("/oc/")) {
        allVh.push({ url: u.replace(/^https?:\/\/[^/]+/, ""), status });
        if (u.includes("/vh/project-settings/watch")) {
          const f = resp.frame();
          watchByFrame.set(f, (watchByFrame.get(f) ?? 0) + 1);
        }
      }
    } catch {
      /* frame may be detached */
    }
  });
  return {
    watchFor: (f: Frame) => watchByFrame.get(f) ?? 0,
    allVh,
  };
}

/** First real-server child frame in the host shell (after gate continuity, its
 *  URL is the SPA at localhost:8765/?… — NOT /auth/login). */
async function firstRealFrame(page: Page, timeout = 30000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const f = page
      .frames()
      .find((fr) => fr !== page.mainFrame() && fr.url().startsWith(REAL));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  throw new Error("no real-server iframe frame appeared within timeout");
}

/** Wait until the real SPA mounted inside the iframe (real shell, not the
 *  placeholder banner). */
async function waitForSpaMounted(frame: Frame, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last: { hasAssetsScript: boolean; rootChildren: number; bodyText: string } | null = null;
  while (Date.now() < deadline) {
    try {
      last = await frame.evaluate(() => {
        const root = document.getElementById("root");
        return {
          hasAssetsScript: !!document.querySelector('script[src*="/assets/index-"]'),
          rootChildren: root ? root.children.length : 0,
          bodyText: document.body ? document.body.innerText.slice(0, 200) : "",
        };
      });
      if (last && last.hasAssetsScript && last.rootChildren > 0) return last;
    } catch {
      // frame document not ready yet (cross-origin load in progress)
    }
    await frame.waitForTimeout(100).catch(() => {});
  }
  expect(last?.hasAssetsScript, "real SPA shell (/assets/index-*) loaded").toBe(true);
  expect(last?.rootChildren, "SPA mounted into #root").toBeGreaterThan(0);
  return last!;
}

/** The host bridge (window.__host) is DEV-only; the real-embed lane runs the
 *  host DEV server (:5183 dev:host:real-embed) so it is present. The seeded
 *  panes (4) point at the real server via VITE_IFRAME_ORIGIN. This waits until
 *  the bridge is up and the first pane exists, then returns its id. */
async function firstRealPaneId(page: Page, timeout = 30000): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ids = await H.panes(page);
    if (ids.length > 0) return ids[0];
    await page.waitForTimeout(100);
  }
  throw new Error("host bridge exposed no panes within timeout");
}

/** Wait until the real SPA's heartbeat has been ACCEPTED by the host for this
 *  pane — i.e. the live production heartbeat emitter (web/src/heartbeat.ts)
 *  posted, the host verified source+origin+nonce, and liveness is "alive".
 *  This is the readiness signal for the real SPA (the mock's waitForReady keys
 *  on connId/WS-echo, which the real SPA omits). */
async function waitForRealAlive(page: Page, id: string, timeout = 30000): Promise<void> {
  await expect
    .poll(async () => H.liveness(page, id), { timeout, message: "real SPA heartbeat accepted → document alive" })
    .toBe("alive");
}

// ---------------------------------------------------------------------------

test.describe("lane 8: real SPA cross-origin iframe embed", () => {
  test("gate continuity + real SPA render + real SSE + heartbeat drives host indicator (alive)", async ({
    page,
  }) => {
    const net = attachNet(page);

    // Load the host shell — it embeds the REAL server cross-origin. No login
    // step: --auth-mode none (loopback default) serves the SPA directly.
    await page.goto("/");

    // Wait for a real-origin iframe frame to appear.
    const frame = await firstRealFrame(page);

    // POINT (1) FRAME POLICY: the iframe document actually loaded the real
    // origin (--frame-ancestors permitted it; no XFO/CSP block). A blocked
    // frame would be about:blank / an error page, not the REAL origin.
    expect(frame.url().startsWith(REAL), `iframe loaded real origin: ${frame.url()}`).toBe(true);

    // POINT (2) GATE CONTINUITY: under --auth-mode none there is no auth gate,
    // so the iframe loaded the SPA directly (not redirected to /auth/login).
    // NOTE: this is trivially satisfied under no-auth — the SameSite=Lax cookie
    // crux was PROVEN by the Phase-0′ spike in passphrase mode and is not
    // re-exercised by this no-auth lane. This assertion still catches a
    // regression where the no-auth server started gating.
    expect(
      frame.url(),
      `iframe served the SPA (no auth-gate redirect): ${frame.url()}`,
    ).not.toContain("/auth/login");

    // POINT (4) REAL SPA UI RENDER: the real SPA mounted (shell into #root),
    // not the placeholder banner and not blank.
    await waitForSpaMounted(frame);
    const probe = await frame.evaluate(() => ({
      title: document.title,
      rootHTMLlen: document.getElementById("root")?.innerHTML.length ?? 0,
      hasPlaceholderBanner: /web UI was not built|placeholder/i.test(
        document.body?.innerText ?? "",
      ),
    }));
    expect(probe.hasPlaceholderBanner, "not the placeholder banner").toBe(false);
    expect(probe.rootHTMLlen, "#root has mounted content").toBeGreaterThan(0);

    // POINT (3) REALTIME (SSE) CONNECTS from within the cross-origin iframe,
    // same-origin to its own origin, ACCEPTED (200, not a 401 reject). The
    // SPA's main realtime channel is SSE (EventSource); /vh/project-settings/
    // watch opens on load regardless of project selection.
    await expect
      .poll(
        async () =>
          net.allVh.filter((s) => s.url.includes("/vh/project-settings/watch") && s.status === 200)
            .length,
        { timeout: 20000 },
      )
      .toBeGreaterThanOrEqual(1);
    const vh401 = net.allVh.filter((s) => s.status === 401);
    expect(
      vh401,
      "no /vh/* 401 (realtime requests accepted from within the iframe)",
    ).toHaveLength(0);

    // POINT (5) — THE CRUX (Q1-C): the LIVE PRODUCTION heartbeat emitter
    // (web/src/heartbeat.ts) drives the host's per-pane document-liveness
    // indicator. The real SPA is embedded (window.parent !== window → embed
    // gate passes) → the host handshakes on iframe load → the real SPA echoes
    // the issued challenge nonce → the host accepts (source+origin+nonce) →
    // liveness "alive" → the per-pane header indicator shows "document alive".
    // This is the FIRST lane to prove this end-to-end with the REAL SPA (the
    // mock survival gate proves it only with the mock stand-in).
    const id = await firstRealPaneId(page);
    await waitForRealAlive(page, id);
    expect(await H.liveness(page, id), "real SPA heartbeat accepted → document alive").toBe("alive");
    // Phase 1 (item 2): the per-pane liveness indicator was removed; the Q1-C
    // label now lives in the STATUSBAR for the focused pane. Focus this pane +
    // assert the statusbar reflects its "document alive" liveness (the SAME crux
    // — real heartbeat → host-accepted → visible Q1-C signal — at the statusbar).
    await H.focusPane(page, id);
    await expect(page.locator('[data-testid="statusbar"]')).toContainText("document alive");
  });

  test("real SPA iframe survives a Dockview split (renderer:always)", async ({ page }) => {
    const net = attachNet(page);
    await page.goto("/");
    // A real SPA frame mounted (pane-agnostic — just confirms SOME real pane is
    // live). The survival identity below is captured pane-precisely via the host
    // bridge (panes()[0]) so the split target and the identity probe are the
    // SAME pane — no frame/id ambiguity.
    const frame = await firstRealFrame(page);
    await waitForSpaMounted(frame);

    // settle: the real SPA's heartbeat must be ACCEPTED (host indicator "alive")
    // before the layout op — this is the identity the survival check keys on.
    const id = await firstRealPaneId(page);
    await waitForRealAlive(page, id);

    // settle SSE too (the realtime channel from within the iframe).
    await expect
      .poll(async () => net.watchFor(frame), { timeout: 20000 })
      .toBeGreaterThanOrEqual(1);

    // capture the live SPA's identity BEFORE the layout op, via the host's
    // acceptance of the real heartbeat. mountTs = the real SPA's
    // performance.timeOrigin (captured once per document load in
    // web/src/heartbeat.ts), so it changes iff the document reloaded — this is
    // the authoritative, pane-precise reload signal. (connId is null for the
    // real SPA — it has no WS echo — so we key on mountTs+nonce.) lastSeen is
    // the timestamp of the most-recent accepted heartbeat; we require a FRESH
    // heartbeat AFTER the split (waitForFreshHeartbeat) so the proof cannot be
    // satisfied by a stale pre-split record.
    const before = await H.survival(page, id);
    expect(before, "host holds an accepted heartbeat identity for the real pane").toBeTruthy();
    expect(before!.mountTs, "real heartbeat mountTs captured").toBeGreaterThan(0);
    expect(before!.nonce, "real heartbeat nonce captured (echoed host challenge)").toBeTruthy();
    expect(before!.lastSeen, "real heartbeat lastSeen captured").toBeGreaterThan(0);

    // survival-safe Dockview split (renderer:'always' keeps the existing iframe
    // mounted; the op adds a NEW pane without reloading the existing one).
    const created = await H.split(page, id, "right");
    expect(created, "split created a new pane").toBeTruthy();

    // POINT: the real SPA's iframe identity SURVIVED the layout op. Wait for a
    // heartbeat that arrived AFTER the split (lastSeen advanced past the
    // pre-split record) — this proves the SAME document kept emitting through
    // the op (not a cached pre-split record). Its mountTs+nonce MUST be
    // unchanged (no reload) and its uptime MUST be strictly greater (the
    // document is still progressing). This is the survival crux for the REAL
    // SPA (renderer:'always'), proven conclusively.
    const after = await H.waitForFreshHeartbeat(page, id, before!.lastSeen);
    expect(after.mountTs, "mountTs unchanged (iframe not reloaded)").toBe(before!.mountTs);
    expect(after.nonce, "nonce unchanged (iframe not reloaded)").toBe(before!.nonce);
    expect(after.uptime, "uptime strictly climbing (fresh post-split heartbeat)").toBeGreaterThan(
      before!.uptime,
    );
    // the host indicator is STILL alive after the op → the SAME document kept
    // heartbeating through the layout op (heartbeat stream persisted, no
    // reconnect). This is strictly stronger than a network-continuity probe.
    expect(await H.liveness(page, id), "still alive after the split").toBe("alive");

    // sanity: the split did create a NEW real-origin frame (the new pane).
    const realFrames = page.frames().filter((f) => f.url().startsWith(REAL));
    expect(realFrames.length, "split added a new real-origin frame").toBeGreaterThanOrEqual(2);
  });

  // ===========================================================================
  // GESTURE ROUND-TRIP (Slice 1 interaction model). The REAL production SPA's
  // hostGesture.ts (web/src/hostGesture.ts) recognizes a double-Ctrl (desktop)
  // / triple-tap (mobile) gesture INSIDE the cross-origin iframe + forwards ONE
  // closed {type:"host-gesture"} postMessage to the host. The host derives the
  // source pane from event.source (the iframe's contentWindow) + opens its
  // layout overlay anchored to that pane. This is the FIRST lane to prove the
  // full gesture→overlay round-trip with the REAL SPA (the mock-content lane-7
  // interaction-overlay spec proves the host side with a probe; this proves the
  // SPA side emits for real).
  //
  // The gestures are driven via frame.evaluate dispatch (runs in the iframe's
  // REAL window context, hitting hostGesture.ts's REAL listeners) for CI
  // determinism — cross-origin keyboard/pointer hardware routing through
  // Playwright is flaky. This still exercises the REAL recognizer + REAL
  // postMessage (origin-bound to the captured host) + REAL host routeMessage +
  // REAL overlay open. The only abstraction is the browser's hardware-event
  // generation (a Playwright concern, not a product concern).
  // ===========================================================================

  test("real SPA double-Ctrl gesture → host overlay opens for the source pane", async ({ page }) => {
    await page.goto("/");
    const frame = await firstRealFrame(page);
    await waitForSpaMounted(frame);
    const id = await firstRealPaneId(page);
    await waitForRealAlive(page, id);
    expect(await H.overlaySource(page), "overlay closed before the gesture").toBeNull();

    // Drive a double bare-Ctrl inside the real SPA's window. The recognizer
    // counts two non-repeated Control keydowns within 450ms → posts ONE
    // {type:"host-gesture", gesture:"layout-overlay-request"} to the captured
    // host origin (the handshake origin = localhost:5183, never '*').
    await frame.evaluate(() => {
      const fire = (key: string): void => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      };
      fire("Control");
      fire("Control");
    });

    // The host derived the source pane from event.source (this iframe's
    // contentWindow) + opened the overlay anchored to it.
    await expect
      .poll(async () => H.overlaySource(page), { timeout: 10000, message: "overlay opened for the real-SPA source pane" })
      .toBe(id);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    // The source pane carries the overlay-source focus badge.
    await expect(page.locator(`.pane[data-pane-id="${id}"].is-overlay-source`)).toHaveCount(1);
    await H.closeLayoutOverlay(page);
  });

  test("real SPA triple-tap gesture → host overlay opens for the source pane", async ({ page }) => {
    await page.goto("/");
    const frame = await firstRealFrame(page);
    await waitForSpaMounted(frame);
    const id = await firstRealPaneId(page);
    await waitForRealAlive(page, id);
    expect(await H.overlaySource(page), "overlay closed before the gesture").toBeNull();

    // Drive three primary-pointer taps in place inside the real SPA's window.
    // The recognizer counts three pointerdowns within 600ms + within 12px →
    // posts ONE {type:"host-gesture", gesture:"layout-overlay-request"}.
    await frame.evaluate(() => {
      const fire = (x: number, y: number): void => {
        const ev = new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true });
        Object.defineProperty(ev, "isPrimary", { value: true, configurable: true });
        window.dispatchEvent(ev);
      };
      fire(10, 10);
      fire(10, 10);
      fire(10, 10);
    });

    await expect
      .poll(async () => H.overlaySource(page), { timeout: 10000, message: "overlay opened for the real-SPA source pane (triple-tap)" })
      .toBe(id);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    await H.closeLayoutOverlay(page);
  });

  // ===========================================================================
  // PANE-ACTIVATE ROUND-TRIP (Slice 2 interaction regression fix). The REAL
  // production SPA's hostGesture.ts activate-forward listens for document
  // pointerdown (mobile tap) + window focus (desktop click-into-pane) inside
  // the cross-origin iframe + forwards ONE closed
  // {type:"host-gesture",gesture:"pane-activate"} postMessage to the host. The
  // host derives the source pane from event.source + activates it (focusPane →
  // setActive → onDidActivePanelChange → focusedId + is-active + visual
  // indicator). This closes the regression where tapping inside a cross-origin
  // iframe never reached Dockview's native activation (Phase 1 removed the only
  // host-DOM click target — the per-pane headers).
  //
  // Same gesture-bridge pattern Slice 1 proved for layout-overlay; this proves
  // the REAL SPA emits the pane-activate signal for real (the mock-content
  // interaction-overlay spec proves the host side with a probe; this proves the
  // SPA side emits).
  // ===========================================================================

  test("real SPA pointerdown → host activates the source pane (pane-activate round-trip)", async ({ page }) => {
    await page.goto("/");
    const frame = await firstRealFrame(page);
    await waitForSpaMounted(frame);
    const ids = await H.panes(page);
    expect(ids.length, "seeded panes present").toBeGreaterThanOrEqual(2);
    // firstRealFrame corresponds to panes()[0] (same DOM-order correspondence
    // Slice 1's gesture tests rely on for their overlay-source assertion).
    const target = ids[0];
    const other = ids[1];
    await waitForRealAlive(page, target);

    // Make the activation OBSERVABLE: focus a different pane first so the
    // target is NOT already active (otherwise activate is a host-side no-op).
    await H.focusPane(page, other);
    await expect.poll(async () => H.focused(page)).toBe(other);

    // Dispatch a pointerdown inside the real SPA's document — the production
    // activate-forward listener (document pointerdown) fires → posts ONE
    // {type:"host-gesture",gesture:"pane-activate"} to the captured host origin
    // (the handshake origin = localhost:5183, never '*').
    await frame.evaluate(() => {
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });

    // OUTCOME: the host derived the source pane from event.source (this iframe's
    // contentWindow) + activated it. focusedId + is-active moved to the target.
    await expect
      .poll(async () => H.focused(page), { timeout: 10000, message: "host activated the real-SPA source pane (pane-activate)" })
      .toBe(target);
    await expect(page.locator(`.pane[data-pane-id="${target}"].is-active`)).toHaveCount(1);
  });
});
