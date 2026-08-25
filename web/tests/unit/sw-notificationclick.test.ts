// Service-worker notificationclick routing guard (needs-you notifications v1).
//
// The host shell (host-web) fires OS notifications through this root SW
// (`ServiceWorkerRegistration.showNotification`) when a pane's session needs
// the operator. The click contract (settled design, probe-validated on the
// operator's Fold): click → focus an EXISTING window when one exists, else
// open the app at "/". Deliberately GENERAL — never route to a specific
// pane/session from the notification payload (stale-state hazard; the app
// re-derives fresh attention state on arrival, where the operator taps NEXT).
//
// There is no direct web unit lane that EXECUTES the SW (sw runs only in a
// real registration context; the host e2e dev servers don't even serve it).
// This is therefore a STATIC SOURCE GUARD over the committed SW — the same
// pattern sw-host-exclusion.test.ts uses to pin source-level policy. It fails
// if the click handler reverts to unconditional openWindow, loses the
// focus-existing-window preference, or grows payload-driven routing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  it("prefers focusing an existing window; openWindow stays the FALLBACK", () => {
    const iMatch = sw.indexOf("clients.matchAll");
    const iFocus = sw.indexOf("c.focus()");
    const iOpen = sw.indexOf('clients.openWindow("/")');
    expect(iMatch, "matchAll present").toBeGreaterThanOrEqual(0);
    expect(iFocus, "client.focus() present").toBeGreaterThanOrEqual(0);
    expect(iOpen, 'openWindow("/") fallback present').toBeGreaterThanOrEqual(0);
    // Source order pins the control flow: match first, focus inside the
    // matchAll result loop (returns BEFORE the fallback), openWindow last.
    expect(iFocus, "focus() must come after matchAll (it focuses a matched client)").toBeGreaterThan(iMatch);
    expect(iOpen, "openWindow must come AFTER focus (fallback only)").toBeGreaterThan(iFocus);
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
