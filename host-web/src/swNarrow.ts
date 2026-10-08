// swNarrow — S3b levers A+B of the page-load performance program.
//
// LEVER A (narrow host registration): the HOST document registers `/sw.js`
// with scope `/app`, BEFORE any pane iframe's src is assigned. Registration
// is started by the earliest caller of paneSrcGate()/ensureNarrowRegistration()
// — today that is the first pane renderer's init (iframeRenderer.ts) and the
// notification path (attentionNotify.ts); a boot-module-eval call in
// index.tsx is a disclosed follow-up (the file is concurrently owned by the
// theme session). The ordering GUARANTEE does not depend on the call site:
// every pane src assignment funnels through the gate below, which waits for
// the narrow registration's ACTIVE worker, so cold panes are BORN
// service-worker-controlled either way. The same script URL also backs the
// SPA's ROOT registration (web/src/pwa.ts) — the two coexist safely because
// claim() respects longest-scope-prefix: the narrow claim takes panes from
// root, root NEVER takes panes from narrow, and deploy skew causes zero pane
// reloads (S3a X2/X6 receipts, all engines).
//
// WHY scope "/app" with NO Service-Worker-Allowed header: a script served at
// `/sw.js` (root path) has default max scope "/", which already CONTAINS
// "/app" — the header only ever WIDENS a sub-path script's max scope. Adding
// `Service-Worker-Allowed: /app` to /sw.js would actually BREAK the SPA's
// root registration (it would cap the shared script's max scope at /app),
// and an `/app/sw.js` alias would derive scope "/app/" — which does NOT
// prefix-match the pane document URL "/app" (no trailing slash). Scope "/app"
// is the only shape that covers the panes without any server change; its
// string-prefix side-cases (/apple) are handled by the SW's narrow stray
// respondWith branch (see web/public/sw.js — the Firefox invariant).
//
// LEVER B (activation barrier): pane-iframe src assignment is gated on this
// held registration's ACTIVE worker (iframeRenderer.ts → paneSrcGate). The
// gate is NEVER serviceWorker.ready — under narrow-only the host document's
// `ready` hangs forever on every engine, and under both-state it reselects
// the ROOT registration (S3a X4 measured facts). The gate watches
// reg.active / the installing worker's statechange directly.
//
// FAILURE POSTURE (fail-open, bounded): a registration failure (dev servers
// without /sw.js, engines without SW, HTTP origins) or a slow activation
// must NEVER break pane creation — the gate resolves un-gated after
// ACTIVATION_BUDGET_MS (2s worst case; a clean rejection or an already-active
// worker resolves immediately). Degraded mode is simply today's pre-S3b
// behavior: panes boot uncontrolled and warm up via the SPA's own root
// registration + claim.
//
// ROLLBACK: admin forceReload (web/src/admin.ts) unregisters EVERY
// registration; unregisterNarrow() below is the scoped surgical form. Live
// panes KEEP their controller until unload (S3a X6 c6 — unregister does not
// strip running clients), and the operator's next pane reload boots
// root-controlled (the SPA re-registers root from each pane).
//
// HOST FOCUS CHANNEL: the host document is OUTSIDE the narrow scope, so the
// worker can never see it in clients.matchAll (S3a X4 — and Firefox returns
// no iframe clients either). Once the narrow worker is active we transfer
// one MessageChannel port to it; a notificationclick that finds no
// focusable window client asks the host to focus itself over the port
// (window.focus() — no routing decision, the NO-AUTO-NEXT default; see
// attentionNotify.ts). Honest limit: a gesture-less window.focus() from a
// port message may be ignored by the engine — the reliable bring-to-front
// stays client.focus() inside the worker's notificationclick handler.

/** The narrow registration scope (pane documents live at `/app` exactly). */
export const NARROW_SCOPE = "/app";

/** Worst-case pane-src delay before fail-open (ms). */
export const ACTIVATION_BUDGET_MS = 2000;

let registerPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let gatePromise: Promise<void> | null = null;
let heldReg: ServiceWorkerRegistration | null = null;
// Host-held end of the worker focus channel. Kept referenced so it is not
// GC'd (a collected port closes the channel); re-wired on every activation.
let focusPort: MessagePort | null = null;

/** The held narrow registration (null until registered / on failure). */
export function narrowRegistration(): ServiceWorkerRegistration | null {
  return heldReg;
}

/**
 * Establish (or re-establish) the host focus channel with an active narrow
 * worker. Called on the activation path — the port lives with the worker, so
 * a BUILD_ID update (new worker) needs a fresh channel; updatefound below
 * re-wires when the replacement activates.
 */
function establishFocusChannel(worker: ServiceWorker): void {
  try {
    const channel = new MessageChannel();
    channel.port1.onmessage = (ev) => {
      if (ev.data && ev.data.type === "vh-focus-host") {
        try {
          window.focus();
        } catch {
          /* ignored — engines may refuse gesture-less focus */
        }
      }
    };
    channel.port1.onmessageerror = () => {
      focusPort = null;
    };
    worker.postMessage({ type: "VH_HOST_FOCUS_CHANNEL" }, [channel.port2]);
    focusPort = channel.port1;
  } catch {
    // An engine refusing out-of-scope document→worker postMessage: degrade —
    // notificationclick falls back to its matchAll/openWindow legs.
    focusPort = null;
  }
}

/** Wire the focus channel to every future activation of this registration. */
function watchActivations(reg: ServiceWorkerRegistration): void {
  reg.addEventListener("updatefound", () => {
    const sw = reg.installing;
    if (!sw) return;
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") establishFocusChannel(reg.active ?? sw);
    });
  });
}

/**
 * Lever A — ensure the narrow registration exists. Idempotent (one attempt
 * per host document; a second call returns the memoized promise). Never
 * rejects; resolves null on any failure (fail-open posture).
 */
export function ensureNarrowRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (registerPromise) return registerPromise;
  registerPromise = (async () => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: NARROW_SCOPE });
      heldReg = reg;
      watchActivations(reg);
      return reg;
    } catch {
      return null; // no /sw.js (dev hosts), no SW support, insecure origin…
    }
  })();
  return registerPromise;
}

/**
 * Lever B — the pane-src activation gate. Resolves when the narrow
 * registration has an ACTIVE worker (born-controlled pane boots), or as soon
 * as failure/timeout makes that impossible (fail-open). NEVER rejects, never
 * exceeds ACTIVATION_BUDGET_MS in total — INCLUDING the registration promise
 * itself: a stalled /sw.js script fetch is raced against the same deadline
 * (review b-F1), so pane src assignment is bounded even when register()
 * never settles. Memoized: every pane renderer shares one gate; panes created
 * later (operator splits) resolve instantly once the worker is active.
 */
export function paneSrcGate(): Promise<void> {
  if (gatePromise) return gatePromise;
  gatePromise = (async () => {
    const deadline = Date.now() + ACTIVATION_BUDGET_MS;
    // Race the REGISTRATION itself against the budget (b-F1): an unsettled
    // register() (stalled /sw.js fetch) must not extend the fail-open bound.
    // A registration that lands late is harmless — later panes share this
    // gate's resolved state, and any already-booted pane is picked up by the
    // worker's claim() (S3a X1 case B).
    const reg = await Promise.race([
      ensureNarrowRegistration(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ACTIVATION_BUDGET_MS)),
    ]);
    if (!reg) return; // registration failed or out of budget — open now
    if (reg.active) {
      establishFocusChannel(reg.active);
      return;
    }
    // Fresh registration: the installing (or waiting) worker must reach
    // "activated". skipWaiting() in install makes this fast; the deadline
    // caps the wait regardless (redundant worker, stuck install, …).
    const worker = reg.installing ?? reg.waiting;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated" || worker.state === "redundant") {
          clearTimeout(timer);
          resolve();
        }
      });
      // Attach-race close (review c-F2): the worker may have reached a
      // terminal state between the reg.installing read and the listener
      // attach above — re-check or the gate would wait out the full budget.
      if (worker.state === "activated" || worker.state === "redundant") {
        clearTimeout(timer);
        resolve();
      }
    });
    if (reg.active) establishFocusChannel(reg.active);
  })();
  gatePromise.catch(() => {}); // belt: the promise never rejects by construction
  return gatePromise;
}

/**
 * Scoped rollback hook: unregister the narrow registration (live panes keep
 * their controller until unload — S3a X6 c6). The admin forceReload path
 * already unregisters everything; this exists for a surgical revert that
 * keeps the SPA's root registration (and its PWA identity) intact.
 */
export async function unregisterNarrow(): Promise<boolean> {
  const reg =
    heldReg ??
    (typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? await navigator.serviceWorker.getRegistration(NARROW_SCOPE).catch(() => null)
      : null);
  heldReg = null;
  focusPort = null;
  gatePromise = Promise.resolve(); // later panes boot un-gated
  if (!reg) return false;
  return reg.unregister().catch(() => false);
}
