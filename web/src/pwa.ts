// Service-worker registration for the installable PWA. The app shell is cached
// (instant loads, offline-capable); when the server ships a new version the SW
// installs it in the background and we surface an "update available" toast —
// the user reloads on their terms, we never reload from under them.
import { createSignal } from "solid-js";

const [updateReady, setUpdateReady] = createSignal(false);
let waiting: ServiceWorker | null = null;

export { updateReady };

// Apply the staged update: tell any waiting SW to take over, then reload onto
// the new version (works whether the update came from the SW or the version
// poll).
export function applyUpdate() {
  if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
  window.location.reload();
}

// SW-independent update detection: the daemon's /vh/version changes on every
// deploy (the embedded UI ships with it), so when it differs from the version we
// loaded with, a newer UI is live on the server — surface the "reload" toast.
// Works in a plain browser tab and through the tunnel, regardless of SW timing.
let loadedVersion: string | null = null;
async function checkVersion() {
  try {
    const r = await fetch("/vh/version", { cache: "no-store" });
    if (!r.ok) return;
    const v = (await r.json())?.version;
    if (!v) return;
    if (loadedVersion === null) loadedVersion = v;
    else if (v !== loadedVersion) setUpdateReady(true);
  } catch {
    /* offline / transient — retry next tick */
  }
}

// Run a version check immediately. Called on stream reconnect (sync.ts): a vh
// self-update/restart drops the SSE stream, so reconnecting is the moment a new
// build is most likely live — check then instead of waiting for the next poll.
export const checkVersionNow = () => void checkVersion();

export function startVersionCheck() {
  void checkVersion();
  setInterval(checkVersion, 3 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkVersion();
  });
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env?.DEV) return; // no SW in the dev server

  window.addEventListener("load", async () => {
    // Only auto-reload on a *controller change that we triggered* (an applied
    // update on an already-controlled page) — never on first install.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    const reg = await navigator.serviceWorker.register("/sw.js").catch(() => null);
    if (!reg) return;

    const flag = (sw: ServiceWorker | null) => {
      // Only an update (there is already a controlling SW), not the first install.
      if (sw && navigator.serviceWorker.controller) {
        waiting = sw;
        setUpdateReady(true);
      }
    };

    flag(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      sw?.addEventListener("statechange", () => {
        if (sw.state === "installed") flag(sw);
      });
    });

    // Re-check for a new version when the app regains focus, and hourly.
    const check = () => reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
    window.setInterval(check, 60 * 60 * 1000);
  });
}
