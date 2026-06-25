// Client side of the notifications system: this device's identity + delivery
// scope, OS-notification permission, a presence heartbeat (so the daemon knows
// whether the user is actually attending), and the handler for daemon-emitted
// `notice` events (in-app list + OS notification).
//
// Per-device scope is the local "should THIS browser notify me" control:
//   off      — no in-app / OS notifications here
//   current  — only for the session currently in view (its root)
//   all      — any session in the project
// The daemon still gates outbound webhook CHANNELS by the active profile +
// attendance; this only governs local delivery.
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";
import { pushNotification } from "./notify";
import { heartbeat, type DeviceScope } from "./alertsApi";

// Session-store accessors, injected by sync at load (bindAlertsContext) instead
// of imported — this is the leaf side of what was a sync↔alerts import cycle.
// Safe no-op defaults so anything firing before bind is harmless.
let getSelectedId: () => string | null = () => null;
let getRoot: (id: string) => string = (id) => id;
let getTitle: (id: string) => string | undefined = () => undefined;
export function bindAlertsContext(ctx: {
  selectedId: () => string | null;
  rootOf: (id: string) => string;
  sessionTitle: (id: string) => string | undefined;
}) {
  getSelectedId = ctx.selectedId;
  getRoot = ctx.rootOf;
  getTitle = ctx.sessionTitle;
}

// --- device identity --------------------------------------------------------

const ID_KEY = "vh.device.id.v1";
function makeId(): string {
  const r = (globalThis.crypto?.getRandomValues?.(new Uint8Array(8)) ?? new Uint8Array(8));
  return "dev-" + Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
}
let storedId = loadVersioned<string>(ID_KEY, 1, "");
if (!storedId) {
  storedId = makeId();
  saveVersioned(ID_KEY, 1, storedId);
}
export const deviceId = storedId;

function defaultName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iP(hone|ad|od)/.test(ua) ? "iOS" :
    /Mac/.test(ua) ? "Mac" : /Win/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Firefox/.test(ua) ? "Firefox" :
    /Safari/.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}

const NAME_KEY = "vh.device.name.v1";
const [deviceName, setDeviceNameSig] = createSignal<string>(loadVersioned<string>(NAME_KEY, 1, defaultName()));
export function setDeviceName(n: string) {
  setDeviceNameSig(n);
  saveVersioned(NAME_KEY, 1, n);
}
export { deviceName };

const SCOPE_KEY = "vh.alerts.scope.v1";
const [scope, setScopeSig] = createSignal<DeviceScope>(
  loadVersioned<DeviceScope>(SCOPE_KEY, 1, "current", (o) => (o === "off" || o === "all" ? o : "current")),
);
export function setScope(s: DeviceScope) {
  setScopeSig(s);
  saveVersioned(SCOPE_KEY, 1, s);
  void sendHeartbeat(); // reflect the new scope server-side promptly
}
export { scope };

// --- OS notification permission --------------------------------------------

export const notifSupported = typeof Notification !== "undefined";
const [osPerm, setOsPerm] = createSignal<NotificationPermission>(
  notifSupported ? Notification.permission : "denied",
);
export { osPerm };
export async function enableOSNotifications(): Promise<NotificationPermission> {
  if (!notifSupported) return "denied";
  try {
    const p = await Notification.requestPermission();
    setOsPerm(p);
    return p;
  } catch {
    return Notification.permission;
  }
}

// --- presence heartbeat -----------------------------------------------------

let lastInteraction = Date.now();
function markInteraction() {
  lastInteraction = Date.now();
}

// Whether the user is actually attending right now: the app is visible AND they
// interacted recently. Used to decide whether merely having a session open counts
// as "seen" — leaving the PWA open while away should NOT auto-ack its nudges.
export function attendingNow(idleMs = 60_000): boolean {
  if (typeof document !== "undefined" && document.hidden) return false;
  return Date.now() - lastInteraction <= idleMs;
}

async function sendHeartbeat() {
  const focused = getSelectedId();
  await heartbeat({
    id: deviceId,
    name: deviceName(),
    focusedRoot: focused ? getRoot(focused) : "",
    scope: scope(),
    lastInteraction: new Date(lastInteraction).toISOString(),
    idle: typeof document !== "undefined" ? document.hidden : false,
  });
}

let started = false;
// startPresence wires interaction tracking + the heartbeat loop. Call once at
// app init. Heartbeats every 30s, plus immediately on focus/visibility change so
// "I just woke the device" reflects fast.
export function startPresence() {
  if (started || typeof window === "undefined") return;
  started = true;
  for (const ev of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(ev, markInteraction, { passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) markInteraction();
    void sendHeartbeat();
  });
  window.addEventListener("focus", () => {
    markInteraction();
    void sendHeartbeat();
  });
  void sendHeartbeat();
  setInterval(() => void sendHeartbeat(), 30_000);
}

// --- notice handling --------------------------------------------------------

export interface Notice {
  type: "finished" | "waiting" | "stuck-thinking" | "runaway" | "stalled";
  sessionID: string;
  root: string;
  project: string;
  title?: string;
  detail?: string;
  ts: number;
}

const LABEL: Record<Notice["type"], { emoji: string; verb: string }> = {
  finished: { emoji: "✅", verb: "finished" },
  waiting: { emoji: "⏳", verb: "needs your input" },
  "stuck-thinking": { emoji: "🤔", verb: "is thinking for a long time" },
  runaway: { emoji: "⚠️", verb: "has a long-running command" },
  stalled: { emoji: "💤", verb: "has stalled" },
};

function deliverable(n: Notice): boolean {
  const s = scope();
  if (s === "off") return false;
  if (s === "all") return true;
  // "current": only the session currently in view (matched by root).
  const focused = getSelectedId();
  if (!focused) return false;
  return getRoot(focused) === n.root || focused === n.sessionID;
}

// handleNotice is called by the sync stream for each `notice` event. It adds an
// in-app item and (when the app is backgrounded and permission is granted) an OS
// notification — the path that reaches a sleeping/locked device with the PWA
// merely open. "finished" in-app is left to the existing client settle logic to
// avoid a double entry; OS delivery covers all types.
export function handleNotice(raw: unknown) {
  const n = raw as Notice;
  if (!n || !n.type || !LABEL[n.type]) return;
  if (!deliverable(n)) return;

  const name = n.title || getTitle(n.sessionID) || n.sessionID.slice(0, 8);
  const { emoji, verb } = LABEL[n.type];
  const headline = `${emoji} ${name} ${verb}`;

  if (n.type !== "finished") {
    pushNotification({
      // "waiting" gets its own kind so it can be auto-marked-read once answered.
      kind: n.type === "waiting" ? "waiting" : "info",
      sessionID: n.root || n.sessionID,
      title: headline,
      detail: n.detail,
      tag: n.type, // the notice type, for state-driven auto-mark-read
    });
  }

  // OS notification when the app isn't in the foreground (covers a backgrounded
  // PWA on a sleeping device); when visible, the in-app bell is enough.
  if (notifSupported && osPerm() === "granted" && (typeof document === "undefined" || document.hidden)) {
    try {
      const note = new Notification(headline, {
        body: n.detail || n.project || "",
        tag: `${n.type}:${n.root || n.sessionID}`,
        renotify: false,
      } as NotificationOptions);
      note.onclick = () => {
        window.focus();
        note.close();
      };
    } catch {
      /* construction can throw on some platforms — ignore */
    }
  }
}
