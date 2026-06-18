// Server-admin actions (restart, local-storage reset) kept out of components so
// the restart overlay and the admin popup can share state.
import { createSignal } from "solid-js";

// True while a vh-server restart is in flight; drives the full-screen overlay.
const [vhRestarting, setVhRestarting] = createSignal(false);
export { vhRestarting, setVhRestarting };

// Restart the vh daemon. The SSE connection drops as it re-execs and reconnects
// automatically (OpenCode survives in detached/external mode); RestartOverlay
// watches the connection status and hides once it's live again.
export async function restartVhServer() {
  setVhRestarting(true);
  try {
    await fetch("/vh/restart-server", { method: "POST" });
  } catch {
    /* the connection drops as the server restarts — expected */
  }
}

// Stream the OpenCode update. POST /vh/update-opencode returns the install log as
// a chunked text stream; onChunk fires with each decoded piece. Resolves when the
// stream ends (the server appends a "[vh] update complete" / "[vh] update failed"
// sentinel line). Throws only if the request itself can't start.
export async function streamOpenCodeUpdate(onChunk: (text: string) => void): Promise<void> {
  const res = await fetch("/vh/update-opencode", { method: "POST" });
  if (!res.ok || !res.body) {
    throw new Error(res.status === 501 ? "OpenCode is not managed here" : `update failed (HTTP ${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) onChunk(dec.decode(value, { stream: true }));
  }
  const tail = dec.decode();
  if (tail) onChunk(tail);
}

// Reload bypassing every cache: drop the Cache Storage entries and unregister
// the service worker (which otherwise serves cached assets), then reload so the
// shell + assets are fetched fresh from the network. For when a stale build is
// stuck despite the normal update path.
export async function forceReload() {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* best effort */
  }
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    /* best effort */
  }
  location.reload(); // SW gone + caches cleared → assets refetch from the network
}

// Clear all of this app's persisted state (keys are vh.*-prefixed) for recovery
// from a corrupted cache, then hard-reload so everything re-hydrates fresh.
export function resetLocalStorage() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("vh.")) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore — best effort */
  }
  location.reload();
}
