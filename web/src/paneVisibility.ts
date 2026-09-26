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
}

/** Test-only: drive the host signal without a MessageEvent. */
export function __setHostVisibleForTest(v: boolean): void {
  setHostVisible(v);
  notify();
}
