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
 * placeholder banner and not the folded HOST shell).
 *
 * The probe is ANCHORED (`src^="/assets/index-"`): the single-server SPA's
 * bundle lives at root-level `/assets/index-*`, while the folded host shell's
 * bundle is `/host/assets/index-*`. The old substring match (`src*=`) let the
 * host shell's script satisfy this assertion, masking the post-fold breakage
 * (panes pointed at `/`, which the fold turned into the host-shell route) until
 * the later liveness gates. The anchor makes any wrong-document regression fail
 * HERE, at the earliest seam, with a clear message. */
async function waitForSpaMounted(frame: Frame, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last: { hasAssetsScript: boolean; rootChildren: number; bodyText: string } | null = null;
  while (Date.now() < deadline) {
    try {
      last = await frame.evaluate(() => {
        const root = document.getElementById("root");
        return {
          hasAssetsScript: !!document.querySelector('script[src^="/assets/index-"]'),
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
    // Phase 1 (item 2) removed the per-pane liveness indicator; the statusbar's
    // Q1-C "document alive" text (its replacement) was removed with the statusbar
    // (operator directive). So the crux — real heartbeat → host accepts → the
    // liveness STATE is "alive" — is now observable only via the bridge
    // (H.liveness, asserted above); it has no DOM surface anymore. Focus the
    // pane to exercise the same path the operator would (no DOM assertion).
    await H.focusPane(page, id);
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
  // / 3-finger-tap (mobile) gesture INSIDE the cross-origin iframe + forwards ONE
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

  test("real SPA 3-finger-tap gesture → host overlay opens for the source pane", async ({ page }) => {
    await page.goto("/");
    const frame = await firstRealFrame(page);
    await waitForSpaMounted(frame);
    const id = await firstRealPaneId(page);
    await waitForRealAlive(page, id);
    expect(await H.overlaySource(page), "overlay closed before the gesture").toBeNull();

    // Drive a 3-finger-tap inside the real SPA's window: three touch pointers
    // with DISTINCT pointerIds land together (a few px apart — three fingers
    // on one surface; finger 1 is the primary contact), then all three LIFT
    // near their landing spots. The hardened recognizer ignores non-touch
    // pointers (pointerType !== "touch"), arms only when the simultaneous
    // touch count reaches 3 within THREE_FINGER_TAP_WINDOW_MS, and fires on
    // the LAST lift iff every finger stayed within
    // THREE_FINGER_TAP_MAX_MOVEMENT_PX of its landing position (a tap, not a
    // swipe) → posts ONE {type:"host-gesture", gesture:"layout-overlay-request"}.
    await frame.evaluate(() => {
      const fire = (type: "pointerdown" | "pointerup", pointerId: number, x: number, y: number): void => {
        window.dispatchEvent(
          new PointerEvent(type, {
            pointerId,
            pointerType: "touch",
            isPrimary: pointerId === 1,
            clientX: x,
            clientY: y,
            bubbles: true,
          }),
        );
      };
      // Three fingers land together …
      fire("pointerdown", 1, 40, 40);
      fire("pointerdown", 2, 46, 42);
      fire("pointerdown", 3, 43, 47);
      // … and lift together, each within a few px of its landing spot (the
      // whole down→up sequence is synchronous dispatch, comfortably inside the
      // 300ms window; per-finger drift is far below the 15px swipe gate).
      fire("pointerup", 1, 41, 41);
      fire("pointerup", 2, 45, 43);
      fire("pointerup", 3, 44, 46);
    });

    await expect
      .poll(async () => H.overlaySource(page), { timeout: 10000, message: "overlay opened for the real-SPA source pane (3-finger-tap)" })
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

  // ===========================================================================
  // RECEIPTS BATCH — four deferred obligations closed against the REAL SPA in
  // one additive slice. Each test pins a contract previously proven only at
  // the mock seam (lane 7) or not at all, now exercised end-to-end through the
  // production SPA embedded cross-origin. Honest per-receipt limits are stated
  // in each test's header.
  // ===========================================================================

  // ---- Receipt 1: tail round-trip (real SPA) --------------------------------
  // The {type:'vh-host-tail'} round-trip was pinned only at the mock seam
  // (lane-7 tail.spec.ts). Here, against the REAL SPA:
  //   (a) the production statusEmitter (web/src/statusEmitter.ts) carries the
  //       `following` field through the real status bridge — with no session
  //       open (dead-OC fixture) the honest default is `true` (tailFollow.ts:
  //       unbound bridge → true; statusEmitter.ts: no session → true);
  //   (b) the production HostOps.setTail posts {type:'vh-host-tail',
  //       following:true} into the real SPA's contentWindow; the real
  //       tailListener (source=parent ✓, boolean allowlist ✓) dispatches
  //       forceChatTailFollow() — a documented NO-OP with no ChatView mounted
  //       (web/src/tailFollow.ts returns false when unbound), so the observable
  //       halves here are: the document is unharmed (still alive) and the pane
  //       identity SURVIVED (postMessage-only — a tail command never touches
  //       the iframe element).
  // HONEST LIMIT: the false→true flip leg (a live chat scrolled off-tail,
  // forced back to following=true) requires a mounted ChatView; the dead-OC
  // fixture has none, so that leg stays mock-seam-covered (lane-7 tail.spec.ts
  // models the reader's scroll + re-emits following transitions through the
  // same status bridge the real emitter uses).
  test("real SPA tail: statusEmitter reports following=true; setTail(true) is postMessage-only (identity survives)", async ({
    page,
  }) => {
    await page.goto("/");
    const frame = await firstRealFrame(page);
    await waitForSpaMounted(frame);
    const id = await firstRealPaneId(page);
    await waitForRealAlive(page, id);

    // (a) the real emitter's `following` field reached the host store through
    // the source-bound status bridge (setStatusFor is the only writer — not a
    // local echo).
    await expect
      .poll(async () => (await H.status(page, id))?.following, {
        timeout: 10000,
        message: "real statusEmitter reported following=true (honest no-session default)",
      })
      .toBe(true);

    // (b) production tail command into the real SPA. No crash, still alive,
    // identity unchanged across the post.
    const before = (await H.survival(page, id))!;
    expect(before.mountTs, "baseline mountTs present").toBeGreaterThan(0);
    await H.setTail(page, id, true);
    expect(await H.liveness(page, id), "real SPA still alive after the tail command").toBe("alive");
    await H.assertSurvived(page, id, before, "real tail command");
    // The emitter's report is unchanged by the command (following stayed true —
    // the dispatch no-ops without a chat; nothing regressed the report either).
    expect((await H.status(page, id))?.following, "following still reported true").toBe(true);
  });

  // ---- Receipt 2a: vh-host-select round-trip (real SPA) ---------------------
  // Deferred from the reverse-nav slice: the REAL selectListener's dispatch was
  // never exercised (lane 7 proves the host side with the mock stand-in). Here
  // the full round-trip runs against the production SPA:
  //   host selectTarget → {type:'vh-host-select',dir,session} → the real
  //   selectListener (source=parent, string allowlist) → dispatchSelect →
  //   switchProject/setSelectedId → syncUrl REWRITES the iframe URL
  //   (history.replaceState — pure URL state, observable with the dead OC) →
  //   the heartbeat's allowlistRoute tick (web/src/heartbeat.ts) posts
  //   {type:"route"} → the host's updateRoute captures it in pane params.
  test("real SPA vh-host-select round-trips a route change WITHOUT reloading (survival)", async ({
    page,
  }) => {
    await page.goto("/");
    const frame = await firstRealFrame(page);
    await waitForSpaMounted(frame);
    const id = await firstRealPaneId(page);
    await waitForRealAlive(page, id);
    const before = (await H.survival(page, id))!;

    // The fixture boots with no project (dead OC → no ?dir=), so this select
    // exercises the CROSS-DIR dispatch leg: switchProject(dir) followed by
    // setSelectedId(session).
    const DIR = "/proj-real-embed";
    const SESSION = "sess-re-1";
    await H.selectTarget(page, id, DIR, SESSION);

    // ROUND-TRIP: the real SPA's route emission was captured by the host. The
    // heartbeat reconstructs a canonical allowlisted "?dir=…&session=…"
    // (URLSearchParams encoding — %2F for "/"), identical in shape to lane 7's
    // mock contract.
    const expectedRoute = `?dir=${encodeURIComponent(DIR)}&session=${encodeURIComponent(SESSION)}`;
    await expect
      .poll(async () => (await H.paneParams(page)).find((p) => p.id === id)?.route ?? null, {
        timeout: 10000,
        message: "real SPA route emission captured by the host (select dispatch round-trip)",
      })
      .toBe(expectedRoute);

    // The dispatch's LOCAL effect is observable in the iframe's own URL (the
    // ?dir/?session deep-link syncUrl wrote) — proves the listener dispatched
    // inside the real SPA, not just that some route arrived at the host.
    await expect
      .poll(
        () =>
          frame.evaluate(() => {
            const p = new URLSearchParams(window.location.search);
            return `${p.get("dir")}\u0000${p.get("session")}`;
          }),
        { timeout: 5000, message: "real SPA URL deep-link updated by the select dispatch" },
      )
      .toBe(`${DIR}\u0000${SESSION}`);

    // CRUX — SURVIVAL: the select is postMessage + SPA-internal state; the
    // iframe element is untouched. Identity unchanged (no reload).
    await H.assertSurvived(page, id, before, "real select");
  });

  // ---- Receipt 2b: select listener allowlist pin (real SPA) -----------------
  // The REAL selectListener's payload allowlist against a poison payload: a
  // {type:'vh-host-select'} posted directly from the host window into the
  // pane's contentWindow passes the source-guard (the sender IS
  // window.parent) — only the allowlist (dir/session MUST be strings) can
  // reject it. Dropped → no dispatch → no URL change → no route emission, and
  // the document is unharmed. Mirrors lane 7's tail poison pin (mock seam),
  // here against the real SPA's web/src/selectListener.ts.
  test("real SPA select listener drops out-of-contract payloads (allowlist pin, no crash)", async ({
    page,
  }) => {
    await page.goto("/");
    const frame = await firstRealFrame(page);
    await waitForSpaMounted(frame);
    const id = await firstRealPaneId(page);
    await waitForRealAlive(page, id);

    // Establish a KNOWN route state first (a valid select round-trip).
    const DIR = "/proj-poison-pin";
    await H.selectTarget(page, id, DIR, "sess-known");
    const knownRoute = `?dir=${encodeURIComponent(DIR)}&session=sess-known`;
    await expect
      .poll(async () => (await H.paneParams(page)).find((p) => p.id === id)?.route ?? null, {
        timeout: 10000,
        message: "known route state established",
      })
      .toBe(knownRoute);

    // POISON: non-string session (an object payload) + a smuggled
    // access_token — the allowlist must drop it BEFORE dispatch (CF1: neither
    // ever reaches setSelectedId).
    await page.evaluate(
      ({ pane, payload }) => {
        const f = document.querySelector(
          `[data-pane-id="${pane}"] iframe.pane-iframe`,
        ) as HTMLIFrameElement | null;
        f?.contentWindow?.postMessage(payload, "*");
      },
      {
        pane: id,
        payload: { type: "vh-host-select", dir: "/evil", session: { evil: true }, access_token: "SECRET" },
      },
    );

    // No dispatch happened: the iframe URL is unchanged (still the known dir +
    // session), no new route was emitted, and the document is unharmed.
    await page.waitForTimeout(800);
    expect(
      await frame.evaluate(() => ({
        dir: new URLSearchParams(window.location.search).get("dir"),
        session: new URLSearchParams(window.location.search).get("session"),
      })),
      "poison payload dispatched nothing (URL unchanged)",
    ).toEqual({ dir: DIR, session: "sess-known" });
    expect(
      (await H.paneParams(page)).find((p) => p.id === id)?.route,
      "no route re-emission",
    ).toBe(knownRoute);
    expect(await H.liveness(page, id), "real SPA unharmed by the poison payload").toBe("alive");

    // A VALID payload through the SAME direct route DOES dispatch (proves the
    // rejection above was the allowlist, not the transport): same dir → the
    // setSelectedId warm-switch leg.
    await page.evaluate(
      ({ pane, payload }) => {
        const f = document.querySelector(
          `[data-pane-id="${pane}"] iframe.pane-iframe`,
        ) as HTMLIFrameElement | null;
        f?.contentWindow?.postMessage(payload, "*");
      },
      { pane: id, payload: { type: "vh-host-select", dir: DIR, session: "sess-after-poison" } },
    );
    await expect
      .poll(async () => (await H.paneParams(page)).find((p) => p.id === id)?.route ?? null, {
        timeout: 10000,
        message: "valid direct post dispatched (transport proven)",
      })
      .toBe(`?dir=${encodeURIComponent(DIR)}&session=sess-after-poison`);
  });

  // ---- Receipt 3: embedded TerminalDock presentation (real SPA) -------------
  // Deferred from S1b — with a CONTRACT CORRECTION: the deferred obligation's
  // original wording ("embedded first-open presents overlay-full") describes
  // the S1b default that was later REVERSED at operator request. Current
  // contract (web/src/ui.ts + the unit pin web/tests/unit/
  // termEmbeddedDefault.test.ts): first open is DOCKED (bottom dock) in ALL
  // contexts — standalone AND embedded; overlay-full (.full) is an explicit
  // user action via the dock's Full-screen toggle, session-scoped (never
  // persisted). This test pins the CURRENT contract inside the real embed
  // context (the lane-8 pane IS the real embedded SPA — the receipt's
  // territory), not the stale S1b expectation. Flagged in the slice closeout.
  // The dead-OC fixture has no terminal content, but the presentation state
  // (.full on the dock element) is pure CSS-class state, assertable at rest.
  test("real SPA embedded TerminalDock: first open DOCKED; explicit toggle → .full; session-scoped reopen keeps it", async ({
    page,
  }) => {
    await page.goto("/");
    const frame = await firstRealFrame(page);
    await waitForSpaMounted(frame);
    const ids = await H.panes(page);
    const id = ids[0];
    await waitForRealAlive(page, id);

    // Desktop-width precondition: the dock's docked/mobile-full split and the
    // Full-screen toggle button both key on the IFRAME's own
    // (min-width: 721px) media query (web/src/layout.ts isDesktop). Close the
    // sibling seeded panes so the survivor spans the full grid width (default
    // 1280px viewport), then settle the FLIP animation.
    for (const other of ids.slice(1)) await H.closePane(page, other);
    await H.waitForLayoutSettled(page);
    await expect
      .poll(() => frame.evaluate(() => matchMedia("(min-width: 721px)").matches), {
        timeout: 5000,
        message: "pane is desktop-width after closing siblings (isDesktop)",
      })
      .toBe(true);

    // First open: the SPA header's Terminal button mounts the dock DOCKED —
    // no .full (the operator-requested reversal of S1b full-first).
    await frame.locator('button[aria-label="Terminal"]').click();
    const dock = frame.locator(".term-dock");
    await expect(dock, "terminal dock mounted on first open").toBeVisible();
    await expect(dock, "first open is DOCKED (no overlay-full — S1b reversed)").not.toHaveClass(/full/);

    // Explicit Full-screen toggle → the overlay-full presentation (.full).
    await frame.locator('button[aria-label="Toggle full screen"]').click();
    await expect(dock, "explicit toggle presents overlay-full").toHaveClass(/full/);

    // Session-scoped persistence (deliberately never written to storage):
    // close + reopen keeps the full choice for this SPA session.
    await frame.locator('button[aria-label="Close terminal"]').click();
    await expect(dock, "dock unmounted on close").toHaveCount(0);
    await frame.locator('button[aria-label="Terminal"]').click();
    await expect(dock, "dock remounted on reopen").toBeVisible();
    await expect(dock, "session-scoped: reopen keeps the full choice").toHaveClass(/full/);
  });

  // ---- Receipt 4: PWA static assets on the real server ----------------------
  // From the favicon researcher pass: the CI-stable targets on the real
  // server's static surface (the lane pipeline builds web/ → materializes
  // dist → go build, so the app dist's PWA assets are embedded).
  // /favicon.ico is deliberately NOT asserted: in production mode it serves
  // the HOST shell's icon from pkg/web/host-dist, which is COLD in this lane
  // (404 by design — pinned in pkg/web/favicon_test.go).
  test("real server serves the SPA PWA assets (icon.svg, icon-192.png, manifest.webmanifest)", async ({
    request,
  }) => {
    const targets = ["/icon.svg", "/icon-192.png", "/manifest.webmanifest"];
    for (const p of targets) {
      const resp = await request.get(`${REAL}${p}`);
      expect(resp.status(), `GET ${p} → 200`).toBe(200);
      expect((await resp.body()).length, `GET ${p} non-empty body`).toBeGreaterThan(0);
    }
  });
});
