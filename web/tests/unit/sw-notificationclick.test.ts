// Service-worker notificationclick routing guard (needs-you notifications v1).
//
// The host shell (host-web) fires OS notifications through this root SW
// (`ServiceWorkerRegistration.showNotification`) when a pane's session needs
// the operator. The click contract (settled design, probe-validated on the
// operator's Fold): click → focus the HOST shell window when this worker's
// matchAll can see it (the ROOT registration controls the host at "/" — S4;
// the NARROW registration's matchAll can never see it, S3a X4), else focus an
// existing window, else ask the connected host over the focus channel, else
// openWindow(scopePath()). Deliberately GENERAL — never route to a specific
// pane/session from the notification payload (stale-state hazard); instead the
// worker tells the HOST "you were activated by a notification tap"
// (vh-notify-focus, warm postMessage / cold VH_NOTIFY_FOCUS_QUERY reply) and
// the host re-derives FRESH attention state (attentionNext).
//
// There is no direct web unit lane that EXECUTES the SW (sw runs only in a
// real registration context; the host e2e dev servers don't even serve it).
// This is therefore a STATIC SOURCE GUARD over the committed SW — the same
// pattern sw-host-exclusion.test.ts uses to pin source-level policy. It fails
// if the click handler reverts to unconditional openWindow, loses the
// focus-existing-window preference, skips the host-shell preference / notify
// signal, or grows payload-driven routing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOTIFY_FOCUS_MSG, NOTIFY_FOCUS_QUERY_MSG } from "../../src/lib/swPolicy";

const here = path.dirname(fileURLToPath(import.meta.url));
const swPath = path.resolve(here, "..", "..", "public", "sw.js"); // web/public/sw.js
const sw = readFileSync(swPath, "utf8");

describe("service worker notificationclick routing (needs-you v1)", () => {
  it("matches CONTROLLED windows (includeUncontrolled: false), not all windows", () => {
    expect(
      sw.includes('clients.matchAll({ type: "window", includeUncontrolled: false })'),
      "notificationclick must matchAll({type:'window', includeUncontrolled:false}) — see web/public/sw.js",
    ).toBe(true);
    expect(
      sw.includes('clients.matchAll({ type: "window", includeUncontrolled: true })'),
      "the uncontrolled matchAll variant must not come back (claim() makes every window controlled)",
    ).toBe(false);
  });

  it("prefers the HOST shell window, then any window, then the focus channel, then openWindow", () => {
    const iMatch = sw.indexOf("clients.matchAll");
    const iHostPref = sw.indexOf('all.find((c) => new URL(c.url).pathname === "/")');
    const iHostFocus = sw.indexOf("host.focus()");
    const iFocus = sw.indexOf("c.focus()");
    const iHostPort = sw.indexOf("vh-focus-host");
    const iArm = sw.indexOf("pendingNotifyFocus = true");
    const iOpen = sw.indexOf("clients.openWindow(scopePath())");
    expect(iMatch, "matchAll present").toBeGreaterThanOrEqual(0);
    expect(iHostPref, "host-shell client preference present").toBeGreaterThanOrEqual(0);
    expect(iHostFocus, "host.focus() present").toBeGreaterThanOrEqual(0);
    expect(iFocus, "client.focus() present").toBeGreaterThanOrEqual(0);
    expect(iHostPort, "host-focus channel present").toBeGreaterThanOrEqual(0);
    expect(iArm, "cold-open pending activation arm present").toBeGreaterThanOrEqual(0);
    expect(iOpen, "openWindow(scopePath()) fallback present").toBeGreaterThanOrEqual(0);
    // Source order pins the control flow: match first, then the S4 HOST-shell
    // preference (the ROOT registration's matchAll sees the host at "/"; the
    // NARROW registration's can never — S3a X4 — so the find() is simply empty
    // there and the ladder degrades to the pre-S4 rungs, no scope branch
    // needed), focus inside the matchAll result loop (returns BEFORE the
    // fallbacks), then the S3b host-focus channel, openWindow last
    // (scope-aware: "/" for the root registration, "/app" for narrow).
    expect(iHostPref, "host-shell preference derives from the matchAll result").toBeGreaterThan(iMatch);
    expect(iHostFocus, "host.focus() must come after the host preference find").toBeGreaterThan(iHostPref);
    expect(iFocus, "focus() must come after the host-shell branch").toBeGreaterThan(iHostFocus);
    expect(iHostPort, "host-focus channel must come after client focus").toBeGreaterThan(iFocus);
    expect(iArm, "the cold-open arm must come after the focus channel (last-resort rung)").toBeGreaterThan(iHostPort);
    expect(iOpen, "openWindow must come AFTER the arm (the arm is set before the open)").toBeGreaterThan(iArm);
  });

  it("warm path: posts the notify-focus signal to the focused HOST client", () => {
    // The host — never the notification payload — owns the tab-selection
    // decision: after focusing the host window the worker tells it "this
    // activation came from a notification tap" and the host re-derives fresh
    // attention state (attentionNext). The literal is pinned against the
    // swPolicy mirror constant (NOTIFY_FOCUS_MSG).
    const iHostFocus = sw.indexOf("host.focus()");
    const iSignal = sw.indexOf(`host.postMessage({ type: "${NOTIFY_FOCUS_MSG}" })`);
    expect(iSignal, `warm-path signal '${NOTIFY_FOCUS_MSG}' present`).toBeGreaterThanOrEqual(0);
    expect(iSignal, "the signal is sent after the host client is focused").toBeGreaterThan(iHostFocus);
  });

  it("cold path: arms the pending activation BEFORE openWindow; the boot query consumes it once", () => {
    // Android sweeps a backgrounded PWA to zero clients, so the tap lands on
    // the openWindow rung. The booted host cannot have a listener yet, so the
    // worker REMEMBERS the activation and answers the host's
    // NOTIFY_FOCUS_QUERY with the same notify-focus signal — exactly once
    // (the flag is cleared on reply).
    const iArm = sw.indexOf("pendingNotifyFocus = true");
    const iQuery = sw.indexOf(`"${NOTIFY_FOCUS_QUERY_MSG}"`);
    expect(iArm, "cold-open arm present").toBeGreaterThanOrEqual(0);
    expect(sw.indexOf("clients.openWindow(scopePath())"), "openWindow present").toBeGreaterThan(iArm);
    expect(iQuery, `boot query '${NOTIFY_FOCUS_QUERY_MSG}' handler present`).toBeGreaterThanOrEqual(0);
    // One-shot semantics live in the message handler: guarded consume + reply.
    const msgHandler = sw.slice(
      sw.indexOf('addEventListener("message"'),
      sw.indexOf('addEventListener("push"'),
    );
    expect(msgHandler, "the query handler sits in the message listener").toContain(`"${NOTIFY_FOCUS_QUERY_MSG}"`);
    expect(msgHandler).toContain("if (pendingNotifyFocus)");
    expect(msgHandler).toContain("pendingNotifyFocus = false;");
    expect(msgHandler).toContain(`e.source.postMessage({ type: "${NOTIFY_FOCUS_MSG}" })`);
    expect(
      msgHandler.indexOf("pendingNotifyFocus = false;"),
      "the flag is cleared BEFORE the reply is sent",
    ).toBeLessThan(msgHandler.indexOf(`e.source.postMessage({ type: "${NOTIFY_FOCUS_MSG}" })`));
  });

  it("keeps the click GENERAL — no pane/session routing from the notification payload", () => {
    // The stale-state rule: never route to a specific pane. Guard against the
    // handler growing payload-driven deep links (notification.data → URL/pane).
    const handler = sw.slice(
      sw.indexOf("notificationclick"),
      sw.indexOf("addEventListener(\"fetch\""),
    );
    expect(handler.includes("data.pane") || handler.includes("data.session"),
      "notificationclick must not read pane/session identity from the payload (stale-state hazard)").toBe(false);
  });
});
