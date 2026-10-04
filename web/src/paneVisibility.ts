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

/**
 * Install the document-visibility tracker and (when embedded) the host→pane
 * visibility listener. Idempotent. Wire once in index.tsx.
 */
export function startPaneVisibility(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  last = isPaneVisible();
  document.addEventListener("visibilitychange", () => {
    setDocVisible(document.visibilityState !== "hidden");
    notify();
  });
  if (!isEmbedded()) return;
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window.parent) return;
    const v = asHostVisibility(ev.data);
    if (v === null) return;
    setHostVisible(v);
    notify();
  });
}

/** Test-only: reset module state. */
export function __resetPaneVisibilityForTest(host = true, doc = true): void {
  setHostVisible(host);
  setDocVisible(doc);
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
 * Install the <html> class gate. Idempotent. Wire once in index.tsx after
 * startPaneVisibility(); it reads paneVisible() initially and on every
 * visibility transition thereafter.
 */
export function installPaneAnimationGate(): void {
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
}
let gateInstalled = false;
