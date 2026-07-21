// Install state + prompt for the PWA. Lets Settings show an "App" section only
// when running in a plain browser tab (not already installed), mirroring
// openchamber's display-mode detection + beforeinstallprompt capture.
import { createSignal } from "solid-js";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  platforms?: string[];
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const DISPLAY_MODES = ["standalone", "minimal-ui", "fullscreen", "window-controls-overlay"];

// localStorage keys read by the diagnostics panel (web/src/pwa-diagnostics.ts).
// `lastOutcome` records the resolved userChoice after promptInstall(); `installedAt`
// records when the appinstalled event fired. Both survive reload so the panel can
// show "you dismissed N minutes ago" / "installed 2 days ago" context.
const LS_LAST_OUTCOME = "vh.pwa.lastOutcome";
const LS_INSTALLED_AT = "vh.pwa.installedAt";

function detectInstalled(): boolean {
  if (typeof window === "undefined") return false;
  if ((navigator as any).standalone) return true; // iOS Safari
  return DISPLAY_MODES.some((m) => window.matchMedia?.(`(display-mode: ${m})`).matches);
}

const [installed, setInstalled] = createSignal(detectInstalled());
const [deferred, setDeferred] = createSignal<BeforeInstallPromptEvent | null>(null);
// Capture-state telemetry for the Settings → App diagnostics panel. These answer
// "did beforeinstallprompt actually fire this session?" and "did appinstalled?"
// without the panel having to duplicate the listeners. `bipFired` keeps the
// timestamp + platforms array from the most recent event (it stays set even
// after the captured event is consumed by promptInstall, since the question is
// "did it fire", not "is it still available").
const [bipFired, setBipFired] = createSignal<{ fired: boolean; ts: number | null; platforms: string[] }>({
  fired: false,
  ts: null,
  platforms: [],
});
const [appinstalledSig, setAppinstalledSig] = createSignal(false);
export { installed };
// True when the browser has offered an install prompt we can trigger.
export const canInstall = () => !!deferred();
// Diagnostics accessors (consumed by web/src/pwa-diagnostics.ts).
export const beforeinstallpromptState = () => bipFired();
export const appinstalledFired = () => appinstalledSig();

// iOS Safari never fires beforeinstallprompt — detect it so we can show the
// manual "Add to Home Screen" instruction instead of an Install button.
export function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS)/.test(ua);
  return iOS && webkit;
}

export function initPwaInstall() {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep our own UI in control of when to prompt
    const ev = e as BeforeInstallPromptEvent;
    setDeferred(ev);
    setBipFired({ fired: true, ts: Date.now(), platforms: ev.platforms ?? [] });
  });
  window.addEventListener("appinstalled", () => {
    setDeferred(null);
    setInstalled(true);
    setAppinstalledSig(true);
    // Persist install time so the diagnostics panel can report "installed 2d ago"
    // across reloads. Guarded: some privacy modes throw on storage writes.
    try {
      localStorage.setItem(LS_INSTALLED_AT, String(Date.now()));
    } catch {
      /* storage blocked (incognito / disabled) — telemetry is best-effort */
    }
  });
  const refresh = () => setInstalled(detectInstalled());
  for (const m of DISPLAY_MODES) window.matchMedia?.(`(display-mode: ${m})`)?.addEventListener?.("change", refresh);
  window.addEventListener("focus", refresh);
}

// Trigger the native install prompt. Returns true if the user accepted.
export async function promptInstall(): Promise<boolean> {
  const e = deferred();
  if (!e) return false;
  setDeferred(null);
  try {
    await e.prompt();
    const choice = await e.userChoice;
    // Persist the resolved outcome so the diagnostics panel can surface "you
    // dismissed 5m ago — likely in Chrome's cooldown now" after a reload.
    try {
      localStorage.setItem(
        LS_LAST_OUTCOME,
        JSON.stringify({ outcome: choice.outcome, platform: choice.platform ?? "unknown", ts: Date.now() }),
      );
    } catch {
      /* storage blocked — telemetry is best-effort */
    }
    if (choice.outcome === "accepted") setInstalled(true);
    return choice.outcome === "accepted";
  } catch {
    return false;
  }
}
