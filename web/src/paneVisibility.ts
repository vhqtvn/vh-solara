// Pane visibility — "can the operator actually see this SPA right now?"
//
// Standalone, that is just document.visibilityState. Embedded in the host
// shell it is NOT: the host keeps every dockview pane (hidden tabs, inactive
// workspaces) permanently mounted with `renderer: "always"` and hides them via
// `visibility: hidden`, which leaves the iframe document "visible" and is not
// observable from inside a cross-origin iframe (IntersectionObserver ignores
// the visibility property). So the host tells each pane explicitly:
//
//   host → pane  { type: "vh-host-visibility", visible: boolean }
//
// (sent by host-web IframeRenderer on change, on iframe load, and periodically
// as a resync). Source-guarded to window.parent like the other host→pane
// listeners (selectListener / tailListener).
//
// Consumers (polling loops — see lib/poll.ts) read isPaneVisible() and
// subscribe via onPaneVisibilityChange() so hidden panes stop generating
// tunnel traffic and catch up once when they become visible again.
import { createSignal } from "solid-js";
import { isEmbedded } from "./embedded";

export const HOST_VISIBILITY_TYPE = "vh-host-visibility";

// Default visible: an old host (or the window before its first message) must
// never freeze a pane's polling.
const [hostVisible, setHostVisible] = createSignal(true);
const [docVisible, setDocVisible] = createSignal(
  typeof document === "undefined" ? true : document.visibilityState !== "hidden",
);

/** Reactive: true when the document is visible AND the host has not hidden the pane. */
export const paneVisible = () => docVisible() && hostVisible();

/** Non-reactive read for timer callbacks. */
export const isPaneVisible = (): boolean => paneVisible();

/**
 * Non-reactive: true when the DOCUMENT is visible, even if the host has hidden
 * the pane. Splits the two hiders: host-hidden (inactive workspace — document
 * still "visible" in the CSS-hidden cross-origin iframe) vs document-hidden
 * (the whole tab backgrounded). Sync recovery policy keys off this split:
 * the tree stream keeps its watchdog/liveness recovery while host-hidden
 * (hidden-pane status must stay fresh), while a document-hidden pane recovers
 * nothing (see sync.ts + docs/ai/hidden-pane-status.md).
 */
export const isDocVisible = (): boolean => docVisible();

type Listener = (visible: boolean) => void;
const listeners = new Set<Listener>();
let last = true;

function notify(): void {
  const v = isPaneVisible();
  if (v === last) return;
  last = v;
  for (const l of [...listeners]) l(v);
}

/** Subscribe to visibility transitions. Returns an unsubscribe. */
export function onPaneVisibilityChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Validate a host→pane visibility payload (allowlist; anything else → null). */
export function asHostVisibility(data: unknown): boolean | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { type?: unknown; visible?: unknown };
  if (d.type !== HOST_VISIBILITY_TYPE || typeof d.visible !== "boolean") return null;
  return d.visible;
}

let installed = false;

// (2026-10-12 v1.77.3 recurrence) The WebKit standalone-PWA failure class is
// not just a LOST visibilitychange event (healed below) — the browser can
// strand document.visibilityState ITSELF at "hidden" while the document is
// visibly in the foreground (first lock/app-switch after load; no further
// event fires). Every "re-derive from live state" heal then faithfully
// re-derives the lie forever: freeze with no recovery. The counter-evidence
// is a TRUSTED pointerdown — genuinely hidden panes cannot be hit-tested
// (visibility:hidden iframes/background tabs receive no input), so real user
// input while believed hidden PROVES the state stale. Set by the gate's
// input listener; cleared by every REAL visibilitychange (the browser's
// state machine is talking again). While set, derivations treat the
// document as visible instead of trusting the stuck state.
let visibilityStateDiscredited = false;

/** Derive docVisible, honoring a discredited visibilityState. */
function derivedDocVisible(): boolean {
  if (visibilityStateDiscredited) return true;
  return document.visibilityState !== "hidden";
}

/**
 * Re-derive docVisible from LIVE document.visibilityState (not the cached
 * signal) and notify. Self-heal for a lost `visibilitychange → visible` event
 * (iOS standalone PWA lock/unlock, bfcache restore — sync.ts:209-212 hedges
 * the same class): while the cache is stale-hidden, notify()'s edge dedupe
 * swallows EVERY later resync — including the host's periodic
 * vh-host-visibility message — because paneVisible() still reads the stale
 * signal. Re-deriving from ground truth un-swallows it: the transition fires
 * exactly when the cache was wrong, so the animation gate un-pauses and the
 * sync facade resumes like a normal reveal. No-op when the cache was right.
 * A visibilityState discredited by real user input is not re-trusted here.
 */
export function resyncDocVisibility(): void {
  if (typeof document === "undefined") return;
  setDocVisible(derivedDocVisible());
  notify();
}

/**
 * Install the document-visibility tracker and (when embedded) the host→pane
 * visibility listener. Idempotent. Wire once in index.tsx.
 */
export function startPaneVisibility(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  last = isPaneVisible();
  document.addEventListener("visibilitychange", () => {
    // A real event means the browser's visibility state machine is talking
    // again — re-trust it (even if this particular event carries "hidden").
    visibilityStateDiscredited = false;
    setDocVisible(derivedDocVisible());
    notify();
  });
  if (!isEmbedded()) return;
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window.parent) return;
    const v = asHostVisibility(ev.data);
    if (v === null) return;
    setHostVisible(v);
    // The host resync arrives periodically (~10s) — ride it to re-derive the
    // DOCUMENT half from ground truth too, so a lost visibilitychange heals
    // in embedded panes without waiting for the gate's own periodic pass.
    resyncDocVisibility();
  });
}

/** Test-only: reset module state. */
export function __resetPaneVisibilityForTest(host = true, doc = true): void {
  gateTeardown?.();
  gateTeardown = null;
  setHostVisible(host);
  setDocVisible(doc);
  visibilityStateDiscredited = false;
  last = host && doc;
  listeners.clear();
  gateInstalled = false; // test hygiene: a fresh module is "not installed" again
}

/** Test-only: drive the host signal without a MessageEvent. */
export function __setHostVisibleForTest(v: boolean): void {
  setHostVisible(v);
  notify();
}

/**
 * Class toggled on <html> while the pane is not visible (host-hidden workspace
 * or the tab itself hidden). foundation/tokens.css pauses ALL CSS animations
 * under it (same !important discipline as the e-ink kill-switch).
 *
 * Why: the host hides inactive workspaces' iframes with `visibility:hidden`,
 * which the iframe CANNOT observe — its document stays "visible" — so without
 * this gate a hidden pane's indicator animations keep running unobserved, and
 * any running animation (even a compositor-only one) keeps the refresh driver
 * ticking and restyles the pane on every frame (profile-measured 2026-10-03:
 * idle hidden panes styled their animated elements on all 281 ticks of a
 * 4.8s capture). Paused animations are NOT running animations: they stop
 * requesting refresh-driver frames, and they resume mid-flight when the pane
 * becomes visible again (no state reset, no re-fire of one-shot cues).
 */
export const PANE_HIDDEN_CLASS = "pane-hidden";

/**
 * Self-heal cadence for the animation gate (~30s), mirroring the sync-side
 * self-heals (10s watchdog in sync/health.ts, on-visible resync in sync.ts).
 * Low frequency on purpose: this is the backstop for a lost show event, not a
 * hot path — every trigger just re-reads document.visibilityState and
 * re-applies one class toggle (a no-op when already correct).
 */
export const PANE_GATE_RESYNC_MS = 30_000;

/**
 * Install the <html> class gate. Idempotent. Wire once in index.tsx after
 * startPaneVisibility(); it reads paneVisible() initially and on every
 * visibility transition thereafter.
 *
 * (2026-10-12 recurrence fix) Also registers the user-input override: a
 * TRUSTED pointerdown while the pane is believed hidden un-latches the gate.
 * Genuinely hidden panes cannot receive one (visibility:hidden iframes are
 * not hit-testable; background tabs get no input), so trusted input is proof
 * the operator is looking at this pane right now — it discredits a stuck
 * document.visibilityState (see visibilityStateDiscredited), heals BOTH
 * signals, and fires the paneVisible transition so the sync facade resumes
 * through the same edge. A later genuine hide (real visibilitychange, or the
 * host's own visible:false) re-pauses normally.
 *
 * @param opts.resyncMs test-only accelerator for the periodic self-heal
 *   interval (production: PANE_GATE_RESYNC_MS). Behavior-identical apart
 *   from cadence — lets integration tests watch the REAL scheduler fire
 *   while the pane is believed hidden, without fake timers.
 * @param opts.testTrustAllInput test-only bypass of the pointerdown
 *   isTrusted check (isTrusted is LegacyUnforgeable — no engine lets a
 *   synthetic event claim it, so jsdom cannot drive the trusted path). The
 *   check itself is covered by the untrusted-input negative test and the
 *   lane-6 e2e's real click.
 */
export function installPaneAnimationGate(opts?: { resyncMs?: number; testTrustAllInput?: boolean }): void {
  if (typeof document === "undefined") return;
  const apply = (): void => {
    document.documentElement.classList.toggle(PANE_HIDDEN_CLASS, !isPaneVisible());
  };
  // Always re-sync the class on install (idempotent, self-healing after a
  // module reset); subscribe only once.
  apply();
  if (gateInstalled) return;
  gateInstalled = true;
  onPaneVisibilityChange(apply);

  // (2026-10-12 freeze trace) The gate's only resume writer used to be the
  // single visibilitychange→visible transition; one lost event stranded a
  // VISIBLE pane paused forever (notify() dedupe swallowed everything later
  // while docVisible was stale). Mirror the sync-side self-heals: re-derive
  // ground truth AND re-apply on pageshow (bfcache restore / PWA unlock) and
  // window focus, plus a low-frequency periodic resync as the standalone
  // backstop. resyncDocVisibility() fires the paneVisible transition when the
  // cache was stale — so the sync facade heals through the same edge — and
  // the direct apply() below heals the class even if no transition fires.
  const resync = (): void => {
    resyncDocVisibility();
    apply();
  };
  window.addEventListener("pageshow", resync);
  window.addEventListener("focus", resync);
  const timer = window.setInterval(resync, opts?.resyncMs ?? PANE_GATE_RESYNC_MS);

  // (2026-10-12 v1.77.3 recurrence) All heals above re-derive from
  // document.visibilityState — which is exactly the part WebKit can strand
  // at "hidden" in a foregrounded standalone PWA (first lock/app-switch;
  // no recovery: every heal re-derives the lie). Trusted pointerdown while
  // believed hidden is counter-evidence no stuck state can survive: hidden
  // panes cannot be hit-tested. Narrow on purpose: pointerdown only (a
  // pointer physically requires the pane under the finger — keydown is
  // forgeable by host focus routing), isTrusted only (synthetic events are
  // not evidence), and it only ever transitions hidden→visible.
  const trustInput = opts?.testTrustAllInput === true;
  const onUserInput = (ev: Event): void => {
    if (!trustInput && !ev.isTrusted) return;
    if (isPaneVisible()) return; // common case: nothing to heal, zero work
    visibilityStateDiscredited = true;
    setDocVisible(true);
    setHostVisible(true); // a tapped pane is on-screen; a lying host resync corrects within ~10s
    notify(); // fires the reveal edge → apply() + the sync facade heal
    apply(); // belt-and-suspenders, same shape as resync
  };
  window.addEventListener("pointerdown", onUserInput, { capture: true, passive: true });

  gateTeardown = () => {
    window.removeEventListener("pageshow", resync);
    window.removeEventListener("focus", resync);
    window.clearInterval(timer);
    window.removeEventListener("pointerdown", onUserInput, { capture: true });
  };
}
let gateInstalled = false;
let gateTeardown: (() => void) | null = null;
