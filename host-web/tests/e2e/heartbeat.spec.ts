import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// Document-liveness heartbeat protocol gate.
//
// Proves the host accepts/rejects heartbeats per the 7 constraints + Q1-C +
// Q2-A (see host-web/docs/heartbeat-protocol.md), and drives the Q1-C per-pane
// indicator ("document alive" / "reloaded" / "no recent signal").
//
// Two surfaces:
//   1. Scratch-pane protocol LOGIC (deterministic; no real heartbeat stream):
//      valid acceptance, wrong-origin rejection, wrong-window rejection, stale-
//      nonce rejection, silence→no-recent-signal, reload→new identity.
//   2. Real mock iframe END-TO-END: the mock's heartbeats drive the per-pane
//      header indicator; a real reload (naiveReload) flips it to "reloaded".
//
// The scratch pane is a self-contained mini-pane (sentinel source + configured
// origin + pending load) exposed via the DEV-only window.__host bridge — it has
// NO real iframe, so protocol assertions are deterministic (no interleaving with
// a live 4 Hz stream). The real-mock tests prove the wiring through the actual
// iframe + store router + renderer indicator.
//
// Runs on Chromium + Firefox + WebKit (playwright.config.ts projects). The
// bridge is DEV-only; this spec lives in tests/e2e (dev:host webServer).
// =============================================================================

const ORIGIN = "http://127.0.0.1:5174"; // mock content origin (:5174)
const WRONG_ORIGIN = "http://127.0.0.1:9999";

test.describe("document-liveness heartbeat protocol", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // ---- 1. scratch-pane protocol logic (deterministic) ----------------------

  test("accepts a valid heartbeat (first-after-load) → document alive", async ({ page }) => {
    const id = "scratch-valid";
    await H.protocolScratch(page, id, ORIGIN);
    // No heartbeat yet → no recent signal.
    expect(await H.protocolLiveness(page, id)).toBe("no-signal");

    const r = await H.protocolProbe(page, {
      scratchId: id,
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 1000, nonce: "n1", uptime: 10 },
    });
    expect(r.accepted, "first post-load heartbeat accepted").toBe(true);
    expect(r.reason).toBe("accepted:first-after-load");
    expect(await H.protocolLiveness(page, id)).toBe("alive");

    await H.protocolDispose(page, id);
  });

  test("rejects a wrong-origin heartbeat (constraint #3)", async ({ page }) => {
    const id = "scratch-origin";
    await H.protocolScratch(page, id, ORIGIN);
    // Establish identity first so the origin check is the only variable.
    await H.protocolProbe(page, {
      scratchId: id,
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 1, nonce: "x", uptime: 0 },
    });

    const r = await H.protocolProbe(page, {
      scratchId: id,
      origin: WRONG_ORIGIN,
      payload: { type: "heartbeat", mountTs: 1, nonce: "x", uptime: 1 },
    });
    expect(r.accepted, "wrong-origin heartbeat rejected").toBe(false);
    expect(r.reason).toBe("rejected:origin-mismatch");

    await H.protocolDispose(page, id);
  });

  test("rejects a wrong-window heartbeat — unknown source (constraint #3)", async ({ page }) => {
    const id = "scratch-window";
    await H.protocolScratch(page, id, ORIGIN);

    const r = await H.protocolProbe(page, {
      scratchId: null, // unknown source window (not bound to any pane)
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 1, nonce: "x", uptime: 0 },
    });
    expect(r.accepted, "wrong-window heartbeat rejected").toBe(false);
    expect(r.reason).toBe("rejected:unknown-source");

    await H.protocolDispose(page, id);
  });

  test("rejects a stale nonce — identity changed without a load (constraint #4)", async ({ page }) => {
    const id = "scratch-stale";
    await H.protocolScratch(page, id, ORIGIN);
    // Establish the document identity with nonce "n1".
    await H.protocolProbe(page, {
      scratchId: id,
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 100, nonce: "n1", uptime: 0 },
    });

    // A heartbeat with a DIFFERENT nonce and NO pending load → stale rejection
    // (a previous document's heartbeat or a spoof).
    const r = await H.protocolProbe(page, {
      scratchId: id,
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 100, nonce: "n2", uptime: 5 },
    });
    expect(r.accepted, "stale-nonce heartbeat rejected").toBe(false);
    expect(r.reason).toBe("rejected:stale-nonce");

    await H.protocolDispose(page, id);
  });

  test("rejects a foreign nonce while pendingLoad is true; accepts the issued challenge (constraint #4)", async ({ page }) => {
    const id = "scratch-challenge";
    await H.protocolScratch(page, id, ORIGIN);
    // Issue a handshake → the host generates + REMEMBERS the challenge nonce it
    // issued for this pending load (previously discarded — the F1 block).
    await H.protocolHandshake(page, id);
    // (a) record the issued challenge nonce.
    const issued = await H.expectedNonce(page, id);
    expect(issued, "host recorded the issued challenge nonce").toBeTruthy();
    // Identity not yet established → no recent signal.
    expect(await H.protocolLiveness(page, id)).toBe("no-signal");

    // (b) a FOREIGN nonce while pendingLoad is true → rejected. Identity is NOT
    // established (treated like a wrong-origin/wrong-window rejection); the pane
    // stays no-signal because pendingLoad is still outstanding.
    const rForeign = await H.protocolProbe(page, {
      scratchId: id,
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 1000, nonce: `foreign-${issued}`, uptime: 1 },
    });
    expect(rForeign.accepted, "foreign nonce rejected while pendingLoad true").toBe(false);
    expect(rForeign.reason).toBe("rejected:stale-nonce");
    expect(await H.protocolLiveness(page, id), "identity not established after foreign nonce").toBe("no-signal");

    // (c) the ISSUED challenge nonce → accepted; identity established.
    const rIssued = await H.protocolProbe(page, {
      scratchId: id,
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 1000, nonce: issued, uptime: 2 },
    });
    expect(rIssued.accepted, "issued challenge nonce accepted").toBe(true);
    expect(rIssued.reason).toBe("accepted:first-after-load");
    expect(await H.protocolLiveness(page, id)).toBe("alive");

    await H.protocolDispose(page, id);
  });

  test("silence → no recent signal past the staleness threshold (constraint #7)", async ({ page }) => {
    test.setTimeout(15_000);
    const id = "scratch-silence";
    await H.protocolScratch(page, id, ORIGIN);
    await H.protocolProbe(page, {
      scratchId: id,
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 1, nonce: "s", uptime: 0 },
    });
    expect(await H.protocolLiveness(page, id)).toBe("alive");

    // STALE_MS = 3000 (docs §6). Wait past the threshold with no further
    // heartbeats → the indicator transitions to "no recent signal". A missed
    // heartbeat is NOT an SSE-failure diagnosis (Q1-C).
    await page.waitForTimeout(3500);
    expect(await H.protocolLiveness(page, id)).toBe("no-signal");

    await H.protocolDispose(page, id);
  });

  test("reload → new identity (mountTs/nonce change) → reloaded (constraint #4)", async ({ page }) => {
    const id = "scratch-reload";
    await H.protocolScratch(page, id, ORIGIN);
    await H.protocolProbe(page, {
      scratchId: id,
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 1000, nonce: "old", uptime: 5 },
    });
    expect(await H.protocolLiveness(page, id)).toBe("alive");

    // Simulate a reload: mark a pending load (as an iframe load would), then a
    // heartbeat carrying a NEW identity.
    await H.protocolNoteLoad(page, id);
    const r = await H.protocolProbe(page, {
      scratchId: id,
      origin: ORIGIN,
      payload: { type: "heartbeat", mountTs: 2000, nonce: "new", uptime: 1 },
    });
    expect(r.accepted, "post-reload heartbeat accepted").toBe(true);
    expect(r.reason).toBe("accepted:reload");
    expect(await H.protocolLiveness(page, id)).toBe("reloaded");

    await H.protocolDispose(page, id);
  });

  // ---- 2. real mock iframe end-to-end (the test seam) ----------------------
  // The mock content page is the "embedded SPA" stand-in (you cannot drive the
  // real web/ SPA in a host-web e2e without a real server). Its heartbeats
  // drive the real store router + the per-pane header indicator.

  test("real mock heartbeats drive the per-pane document-alive indicator", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    // The mock stand-in heartbeats unconditionally → Q1-C state "alive".
    await expect.poll(async () => H.liveness(page, a), { timeout: 10_000 }).toBe("alive");
    // The per-pane header indicator (Q1-C label) reflects it.
    const ind = page.locator(`[data-pane-id="${a}"] [data-testid="pane-liveness"]`);
    await expect(ind).toContainText("document alive");
  });

  test("a real iframe reload (naiveReload) flips the indicator to reloaded", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    await expect.poll(async () => H.liveness(page, a), { timeout: 10_000 }).toBe("alive");

    await H.naiveReload(page, a);
    // naiveReload creates a fresh iframe + (reconciled) re-binds + marks a
    // pending load + re-issues the handshake. The new document's first heartbeat
    // establishes a new identity → reload detected → "reloaded" for the display
    // window. See docs/heartbeat-protocol.md §4.
    await expect.poll(async () => H.liveness(page, a), { timeout: 10_000 }).toBe("reloaded");
    // The per-pane indicator reflects the reload too.
    const ind = page.locator(`[data-pane-id="${a}"] [data-testid="pane-liveness"]`);
    await expect(ind).toContainText("reloaded");
  });

  test("rejects a vh-host-handshake from a non-parent (sibling) source — heartbeats keep the legit identity (F1 source-guard)", async ({ page }) => {
    // The inbound vh-host-handshake handler must only accept a handshake from
    // the actual parent window (ev.source === window.parent). A sibling frame
    // that grabbed this window's WindowProxy via window.parent.frames[index] can
    // otherwise capture the forged origin/nonce, poison the echoed nonce and/or
    // redirect the heartbeats to the attacker. This is the F1 block on the
    // SPA/inbound side; it composes with the host-side challenge-nonce check.
    const ids = await H.panes(page);
    const a = ids[0];
    // Wait until the victim is heartbeating its legitimate identity: the host
    // issues a real vh-host-handshake on iframe load, so the mock captures the
    // host origin + the issued challenge nonce and echoes it.
    const before = await H.waitForReady(page, a);
    const realNonce = before.nonce;
    expect(realNonce, "victim has a legitimate nonce from the host handshake").toBeTruthy();

    // Forge a vh-host-handshake from a SIBLING source (NOT window.parent). The
    // poster is a distinct host-origin srcdoc frame appended to the host page,
    // so in the victim event.source === that sibling window, NOT the victim's
    // window.parent (the host). A direct host-side post would have
    // event.source === window.parent (the legitimate path) and could not
    // exercise the guard. The srcdoc frame is host-origin, so it can read the
    // stashed victim WindowProxy off window.parent (same-origin) and call
    // postMessage on it (postMessage is allowlisted cross-origin to :5174).
    await page.evaluate((victimId) => {
      const w = window as unknown as {
        __host?: { getIframe(i: string): HTMLIFrameElement | null };
        __attackVictim?: Window;
        __attackDelivered?: boolean;
      };
      const victimWin = w.__host!.getIframe(victimId)!.contentWindow as Window;
      w.__attackVictim = victimWin;
      const attacker = document.createElement("iframe");
      attacker.srcdoc =
        "<script>" +
        "window.parent.__attackVictim.postMessage(" +
        "{type:'vh-host-handshake',nonce:'attacker'},'*');" +
        "window.parent.__attackDelivered=true;" +
        "<\/script>";
      document.body.appendChild(attacker);
    }, a);
    await expect.poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __attackDelivered?: boolean }).__attackDelivered === true,
        ),
      { timeout: 5_000, message: "forged handshake delivered from sibling source" },
    ).toBe(true);

    // WITH the inbound source-guard: the victim rejected the forged handshake,
    // so its heartbeats still carry the legitimate nonce and the host keeps
    // accepting them → a FRESH heartbeat arrives carrying the SAME nonce and the
    // pane stays "alive". WITHOUT the guard: the victim switches its echoed
    // nonce to 'attacker'; the host then rejects every subsequent heartbeat as
    // stale-nonce (established identity is realNonce, no pending load) → no
    // fresh heartbeat ever arrives → waitForFreshHeartbeat times out. That
    // timeout is the regression signal, not flake.
    const after = await H.waitForFreshHeartbeat(page, a, before.lastSeen);
    expect(after.nonce, "victim nonce unchanged — forged handshake rejected").toBe(realNonce);
    expect(await H.liveness(page, a), "victim still alive after forged handshake").toBe("alive");
  });
});
