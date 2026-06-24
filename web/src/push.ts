// Web Push subscription (closed-app delivery). Distinct from the in-app/OS
// notice path in alerts.ts: this registers a browser push subscription with the
// daemon so it can reach this device even when the PWA is fully closed.
//
// The daemon gates push on attendance (only when you're away) and the
// subscription's scope, so an open, in-use app isn't doubled up.
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";
import { deviceId, scope } from "./alerts";

export const pushSupported =
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

const ENABLED_KEY = "vh.push.enabled.v1";
const [pushEnabled, setPushEnabledSig] = createSignal<boolean>(
  loadVersioned<boolean>(ENABLED_KEY, 1, false, (o) => o === true || o === 1 || o === "1"),
);
export { pushEnabled };

// The VAPID public key arrives as base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getReg(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

async function postSub(sub: PushSubscription): Promise<boolean> {
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    const r = await fetch("/vh/alerts/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: JSON.stringify({
        deviceId,
        scope: scope(),
        subscription: { endpoint: j.endpoint, keys: j.keys },
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// enablePush requests permission, subscribes via the SW push manager, and
// registers the subscription with the daemon. Returns an error string the
// settings UI can show.
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported) return { ok: false, error: "not supported on this browser" };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, error: `notifications ${perm}` };
  const reg = await getReg();
  if (!reg) return { ok: false, error: "service worker not ready" };

  const key = await fetch("/vh/alerts/push/key")
    .then((r) => r.json())
    .catch(() => null);
  if (!key?.enabled || !key.publicKey) return { ok: false, error: "push unavailable on server" };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.publicKey) as BufferSource,
      });
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    }
  }
  const ok = await postSub(sub);
  if (ok) {
    setPushEnabledSig(true);
    saveVersioned(ENABLED_KEY, 1, true);
  }
  return { ok, error: ok ? undefined : "could not register subscription" };
}

export async function disablePush(): Promise<void> {
  setPushEnabledSig(false);
  saveVersioned(ENABLED_KEY, 1, false);
  const reg = await getReg();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) await sub.unsubscribe().catch(() => {});
  try {
    await fetch("/vh/alerts/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: JSON.stringify({ deviceId }),
    });
  } catch {
    /* best effort */
  }
}

// syncPushScope re-registers the subscription so the daemon learns this device's
// new scope. Call after the device scope changes (no-op if push is off).
export async function syncPushScope(): Promise<void> {
  if (!pushEnabled()) return;
  const reg = await getReg();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) await postSub(sub);
}
