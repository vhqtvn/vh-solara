// Install state + prompt for the PWA. Lets Settings show an "App" section only
// when running in a plain browser tab (not already installed), mirroring
// openchamber's display-mode detection + beforeinstallprompt capture.
import { createSignal } from "solid-js";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISPLAY_MODES = ["standalone", "minimal-ui", "fullscreen", "window-controls-overlay"];

function detectInstalled(): boolean {
  if (typeof window === "undefined") return false;
  if ((navigator as any).standalone) return true; // iOS Safari
  return DISPLAY_MODES.some((m) => window.matchMedia?.(`(display-mode: ${m})`).matches);
}

const [installed, setInstalled] = createSignal(detectInstalled());
const [deferred, setDeferred] = createSignal<BeforeInstallPromptEvent | null>(null);
export { installed };
// True when the browser has offered an install prompt we can trigger.
export const canInstall = () => !!deferred();

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
    setDeferred(e as BeforeInstallPromptEvent);
  });
  window.addEventListener("appinstalled", () => {
    setDeferred(null);
    setInstalled(true);
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
    const { outcome } = await e.userChoice;
    if (outcome === "accepted") setInstalled(true);
    return outcome === "accepted";
  } catch {
    return false;
  }
}
