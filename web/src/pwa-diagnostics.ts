// PWA install diagnostics — a framework-agnostic module of pure + async gather
// functions that compute every install-prompt-related signal the browser exposes
// from JS. The Settings → App panel (SettingsDialog.tsx) renders the result.
//
// Design principle: HONEST OBSERVABILITY, not theater. The browser deliberately
// hides Chrome's engagement heuristic, dismissal cooldown, incognito mode, and
// SW-fetch-handler presence from JS. This module gathers what JS CAN see and
// names the rest as explicitly unknowable — it never guesses at the hidden
// state. See `CANNOT_OBSERVE` and `WEBAPK_NOTE` below.
//
// The module is split into three layers so it is unit-testable without a DOM:
//   1. Pure helpers (UA sniff, manifest validation, install-type + cause logic)
//      — take explicit args, no globals. Tested directly.
//   2. Async gatherers (manifest fetch, SW state, related apps, outcome) — take
//      injected dependencies (a fetch impl, an SW-like object, a storage).
//   3. runDiagnostics(deps?) — the orchestrator that reads globals, calls the
//      gatherers + computers, and returns one DiagnosticsResult. Tests pass a
//      full deps object; the UI calls it with no args.

// (No React/Solid JSX in this file — only data + types. Solid's createSignal is
// not even imported here; the capture-state accessors live in pwa-install.ts.)

// pwa-install is imported (not JSX) so this module can read the capture-state
// accessors as the orchestrator's browser default. ES imports are hoisted, so
// this is available throughout. Tests override via DiagDeps and never hit the
// default path. pwa-install.ts is safe to import in node (its module-top
// detectInstalled() guards on typeof window).
import * as pwaInstall from "./pwa-install";

/** Display modes Chrome reports via matchMedia("(display-mode: …)"). */
export type DisplayMode = "fullscreen" | "standalone" | "minimal-ui" | "window-controls-overlay" | "browser";

/** Status chip color buckets for a signal row. */
export type ChipStatus = "ok" | "warn" | "bad" | "info";

/** What kind of install this browser produces (or "already running"). */
export type InstallType =
  | "webapk" // Android Chrome / Samsung → signed WebAPK via webapk.com
  | "chromium-shortcut" // Desktop Chrome / Edge / Brave → managed shortcut
  | "ios-bookmark" // iOS (any browser) → home-screen bookmark
  | "firefox-managed" // Android Firefox → managed shortcut
  | "not-installed"; // none of the above (e.g. desktop Firefox/Safari, or no UA match)

/** One rendered signal row (label + chip + value, optional detail). */
export interface SignalRow {
  label: string;
  status: ChipStatus;
  value: string;
  detail?: string;
}

/** beforeinstallprompt / appinstalled capture state for the current session. */
export interface CaptureState {
  /** Did beforeinstallprompt fire since the page loaded? */
  bipFired: boolean;
  /** When (epoch ms), if it fired this session. */
  bipFiredAt: number | null;
  /** The event's `platforms` array (e.g. ["web", "play"]). */
  bipPlatforms: string[];
  /** Is the captured event still unconsumed (canInstall())? */
  capturedEventAvailable: boolean;
  /** Did appinstalled fire this session? */
  appinstalledFired: boolean;
}

/** Result of fetching + validating /manifest.webmanifest. */
export interface ManifestCheck {
  url: string;
  fetched: boolean;
  parseOk: boolean;
  httpStatus?: number;
  error?: string;
  hasShortNameOrName: boolean;
  hasIcon192: boolean;
  hasIcon512: boolean;
  hasStartUrl: boolean;
  displayValid: boolean;
  preferRelatedAppsFalseOrAbsent: boolean;
  startUrlSameOrigin: boolean;
  /** Overall installability: all the per-field checks passed. */
  ok: boolean;
}

/** Result of inspecting navigator.serviceWorker. */
export interface ServiceWorkerCheck {
  supported: boolean;
  registrationCount: number;
  controllerPresent: boolean;
  activeState: "activated" | "activating" | "installed" | "installing" | "redundant" | "unknown" | null;
  scopeCoversOrigin: boolean;
  scope?: string;
  /** Overall: SW registered AND controlling AND scope covers the page. */
  ok: boolean;
}

/** Persisted install-outcome telemetry (read from localStorage). */
export interface OutcomeTelemetry {
  lastOutcome: { outcome: string; platform: string; ts: number } | null;
  installedAt: number | null;
}

/** Result of navigator.getInstalledRelatedApps() (progressive enhancement). */
export interface RelatedAppsCheck {
  apiPresent: boolean;
  apps: { platform: string; url?: string; id?: string }[];
}

/** The full panel payload returned by runDiagnostics(). */
export interface DiagnosticsResult {
  secureContext: boolean;
  isDevBuild: boolean;
  isIosSafari: boolean;
  isIos: boolean;
  isAndroidFirefox: boolean;
  displayMode: DisplayMode;
  alreadyInstalled: boolean;
  capture: CaptureState;
  manifest: ManifestCheck;
  serviceWorker: ServiceWorkerCheck;
  outcome: OutcomeTelemetry;
  relatedApps: RelatedAppsCheck;
  installType: InstallType;
  /** Single-sentence operator-facing interpretation (failure-mode table). */
  likelyCause: string;
  /** The rendered signal rows. */
  signals: SignalRow[];
  /** Things JS cannot observe — shown verbatim as callouts. */
  cannotObserve: string[];
  /** WebAPK propagation caveat, shown verbatim. */
  webapkNote: string;
}

// --- Static, verbatim panel text -------------------------------------------

/** JS-cannot-observe callouts. Shown to the operator as plain "cannot be checked
 *  from JS" bullets so the panel never pretends to know more than it does. */
export const CANNOT_OBSERVE: string[] = [
  "Chrome's 30-second + 1-tap engagement heuristic state (has the browser decided you've used the site enough to earn a prompt?).",
  "The cooldown timer Chrome applies after you dismiss a prompt (it won't re-offer for weeks).",
  "Whether you're in incognito / private browsing mode (Chrome never offers install there).",
  "Whether the service worker actually has a fetch handler (JS cannot inspect a SW's event listeners — we infer from registration + controller only).",
  "Kiosk / enterprise / parental-control policies that suppress the install prompt.",
  "Future Chrome installability-criteria changes — this panel reflects current Chrome behavior and may need adjustment over time.",
];

/** WebAPK post-deploy self-detection caveat (shown verbatim). */
export const WEBAPK_NOTE =
  "If you already installed this app as a WebAPK, manifest changes may take ~30 days to reach your installed app (Chrome re-checks ~monthly).";

/** Chip label for a status bucket. */
export function chipLabel(status: ChipStatus): string {
  switch (status) {
    case "ok":
      return "OK";
    case "warn":
      return "WARN";
    case "bad":
      return "FAIL";
    case "info":
      return "INFO";
  }
}

// --- 1. Pure helpers -------------------------------------------------------

/** Match the iOS family from a UA (any browser — Safari, Chrome, Firefox, Edge on iOS). */
export function isIosFromUA(ua: string, platform?: string, maxTouchPoints?: number): boolean {
  const iOS = /iP(hone|ad|od)/i.test(ua) || (platform === "MacIntel" && (maxTouchPoints ?? 0) > 1);
  return iOS;
}

/** Android Firefox (which never fires beforeinstallprompt). */
export function isAndroidFirefoxFromUA(ua: string): boolean {
  return /Android/i.test(ua) && /Firefox/i.test(ua);
}

/** Android, non-Firefox (Chrome / Samsung / Edge on Android → WebAPK). */
export function isAndroidFromUA(ua: string): boolean {
  return /Android/i.test(ua) && !/Firefox/i.test(ua);
}

/** Desktop Chromium family (Chrome / Edge / Brave) — Brave is indistinguishable
 *  from Chrome by design. Desktop Firefox/Safari return false. */
export function isDesktopChromiumFromUA(ua: string, isAndroid: boolean, isIos: boolean): boolean {
  if (isAndroid || isIos) return false;
  // Edge contains "Edg/", Brave matches Chrome exactly. Both contain "Chrome/".
  return /Chrome/i.test(ua) && !/Firefox/i.test(ua);
}

/** Read the current display-mode from a matchMedia impl. Returns "browser" when
 *  no installable display-mode matches (i.e. a plain tab). */
export function detectDisplayMode(matchMedia?: (q: string) => { matches: boolean }): DisplayMode {
  if (!matchMedia) return "browser";
  const modes: DisplayMode[] = ["fullscreen", "standalone", "minimal-ui", "window-controls-overlay"];
  for (const m of modes) {
    try {
      if (matchMedia(`(display-mode: ${m})`).matches) return m;
    } catch {
      /* matchMedia may be unavailable — treat as no match */
    }
  }
  return "browser";
}

const VALID_DISPLAY_MODES = new Set(["fullscreen", "standalone", "minimal-ui", "window-controls-overlay"]);

/** Validate a parsed manifest object against Chrome's installability field
 *  requirements. `origin` is the page origin (location.origin) used for the
 *  start_url same-origin check. Returns only the per-field booleans. */
export function validateManifestJson(
  json: unknown,
  origin: string,
): Pick<
  ManifestCheck,
  | "hasShortNameOrName"
  | "hasIcon192"
  | "hasIcon512"
  | "hasStartUrl"
  | "displayValid"
  | "preferRelatedAppsFalseOrAbsent"
  | "startUrlSameOrigin"
  | "ok"
> {
  const m = (json ?? {}) as Record<string, unknown>;
  const icons = Array.isArray(m.icons) ? (m.icons as Record<string, unknown>[]) : [];
  const iconHas = (px: string) =>
    icons.some((i) => {
      const sizes = typeof i.sizes === "string" ? i.sizes : "";
      return sizes.includes(px);
    });
  const hasShortNameOrName = typeof (m.short_name ?? m.name) === "string" && String(m.short_name ?? m.name).trim() !== "";
  const hasIcon192 = iconHas("192");
  const hasIcon512 = iconHas("512");
  const hasStartUrl = typeof m.start_url === "string" && m.start_url.trim() !== "";
  const displayValid = typeof m.display === "string" && VALID_DISPLAY_MODES.has(m.display);
  const preferRelatedAppsFalseOrAbsent = m.prefer_related_applications !== true;
  let startUrlSameOrigin = false;
  if (hasStartUrl) {
    try {
      startUrlSameOrigin = new URL(m.start_url as string, origin).origin === origin;
    } catch {
      startUrlSameOrigin = false;
    }
  }
  const ok =
    hasShortNameOrName &&
    hasIcon192 &&
    hasIcon512 &&
    hasStartUrl &&
    displayValid &&
    preferRelatedAppsFalseOrAbsent &&
    startUrlSameOrigin;
  return {
    hasShortNameOrName,
    hasIcon192,
    hasIcon512,
    hasStartUrl,
    displayValid,
    preferRelatedAppsFalseOrAbsent,
    startUrlSameOrigin,
    ok,
  };
}

/** Compute the install-type label from UA + display flags. See InstallType. */
export function computeInstallType(input: {
  ua: string;
  isIos: boolean;
  isAndroidFirefox: boolean;
  isAndroid: boolean;
  displayMode: DisplayMode;
  navigatorStandalone: boolean;
}): InstallType {
  const standalone =
    input.navigatorStandalone ||
    input.displayMode === "standalone" ||
    input.displayMode === "fullscreen" ||
    input.displayMode === "minimal-ui" ||
    input.displayMode === "window-controls-overlay";
  if (standalone) {
    // Already running as an installed app. (The App section is normally hidden
    // when installed, but this keeps the label honest if it's ever shown.)
    return "webapk"; // we can't tell WebAPK from shortcut from JS at runtime
  }
  if (input.isIos) return "ios-bookmark";
  if (input.isAndroidFirefox) return "firefox-managed";
  if (input.isAndroid) return "webapk";
  const isDesktopChromium = isDesktopChromiumFromUA(input.ua, input.isAndroid, input.isIos);
  return isDesktopChromium ? "chromium-shortcut" : "not-installed";
}

/** Human label for an InstallType. */
export function installTypeLabel(t: InstallType, standalone: boolean): string {
  if (
    standalone &&
    (t === "webapk" || t === "chromium-shortcut" || t === "ios-bookmark" || t === "firefox-managed")
  ) {
    return "Already installed (running standalone)";
  }
  switch (t) {
    case "webapk":
      return "WebAPK (Android Chrome / Samsung)";
    case "chromium-shortcut":
      return "Chromium-managed shortcut (Desktop Chrome / Edge / Brave)";
    case "ios-bookmark":
      return "Home-screen bookmark (iOS)";
    case "firefox-managed":
      return "Firefox-managed shortcut (Android Firefox)";
    case "not-installed":
      return "Not installed / browser has no install prompt";
  }
}

/** The failure-mode interpretation row. Priority-ordered match against the
 *  contract table. Returns a single operator-facing sentence. */
export function computeLikelyCause(input: {
  alreadyInstalled: boolean;
  isIos: boolean;
  isAndroidFirefox: boolean;
  manifestOk: boolean;
  manifestError?: string;
  swSupported: boolean;
  swRegistered: boolean;
  swControllerPresent: boolean;
  swActiveState: string | null;
  isDevBuild: boolean;
  secureContext: boolean;
  bipFired: boolean;
  capturedEventAvailable: boolean;
  lastOutcomeDismissed: boolean;
}): string {
  if (input.alreadyInstalled) {
    return "Already installed (display-mode is standalone) — the install button is hidden by design; this panel only applies before install.";
  }
  if (input.isIos) {
    return "iOS never fires beforeinstallprompt by design — use the Share → Add to Home Screen instructions above. No install button will appear here.";
  }
  if (input.isAndroidFirefox) {
    return "Android Firefox never fires beforeinstallprompt by design — Firefox does not support WebAPK install. No install prompt is available.";
  }
  if (!input.secureContext) {
    return "Page is not in a secure context (HTTPS or localhost). Chrome requires HTTPS for installability.";
  }
  if (!input.manifestOk) {
    return `Manifest problem: ${input.manifestError ?? "a required field is missing or invalid"}. Fix the deployed manifest.webmanifest.`;
  }
  if (!input.swSupported) {
    return "This browser has no serviceWorker API — it cannot install a PWA at all.";
  }
  if (!input.swRegistered) {
    if (input.isDevBuild) {
      return "Service worker is not registered because this is a Vite dev build (pwa.ts skips registration when import.meta.env.DEV). Run a production build / preview to test install.";
    }
    return "Service worker is not registered. In production this means the SW is blocked or failed to register; check the browser console for /sw.js errors.";
  }
  if (!input.swControllerPresent) {
    return "Service worker is registered but not yet controlling the page — it's still installing/activating, or its scope doesn't cover this URL. Reload once; if it persists, check the SW scope.";
  }
  if (input.swActiveState && input.swActiveState !== "activated") {
    return `Service worker active state is "${input.swActiveState}" (not "activated"). Reload once to let it finish activating.`;
  }
  if (input.lastOutcomeDismissed) {
    return "You dismissed the last install prompt — Chrome applies a multi-week cooldown before offering it again. The prompt won't re-fire on its own during that window.";
  }
  if (input.capturedEventAvailable) {
    return "An install prompt IS captured and ready — tap the Install button above. (If it still doesn't appear, the event may have already been consumed.)";
  }
  if (!input.bipFired) {
    // Everything JS can check is OK, but BIP hasn't fired. The three real causes
    // are all invisible to JS — be honest rather than guessing.
    return "beforeinstallprompt hasn't fired, but everything JS can check (manifest, SW, secure context) is OK. The most likely causes are all invisible to JS: Chrome's engagement heuristic (~30s use + a tap) hasn't been met, you're in a dismissal cooldown, or you're in incognito. See the callouts below.";
  }
  return "No specific cause identified — review the signal rows above. If the prompt still doesn't fire, the cause is likely one of the JS-invisible factors listed below.";
}

// --- 2. Async gatherers (take injected deps) -------------------------------

/** Minimal shape of navigator.serviceWorker this module reads. */
export interface SwLike {
  controller: { state?: string } | null;
  getRegistrations(): Promise<RegLike[]>;
}
export interface RegLike {
  scope: string;
  active: { state?: string } | null;
  installing: { state?: string } | null;
  waiting: { state?: string } | null;
}

/** Inspect the service-worker subsystem. `sw` is null when unsupported. */
export function gatherServiceWorker(sw: SwLike | null, locationHref: string): ServiceWorkerCheck {
  const supported = !!sw;
  if (!supported) {
    return {
      supported: false,
      registrationCount: 0,
      controllerPresent: false,
      activeState: null,
      scopeCoversOrigin: false,
      ok: false,
    };
  }
  // getRegistrations is async but we want a sync-ish gather; the orchestrator
  // awaits it. This function does the synchronous per-registration analysis.
  return {
    supported: true,
    registrationCount: 0, // filled by the orchestrator after awaiting getRegistrations
    controllerPresent: !!sw.controller,
    activeState: null,
    scopeCoversOrigin: false,
    ok: false,
  };
}

/** Synchronous analysis of already-fetched registration list. Exported for the
 *  orchestrator and for tests. */
export function analyzeRegistrations(
  regs: RegLike[],
  controller: { state?: string } | null,
  locationHref: string,
): ServiceWorkerCheck {
  const controllerPresent = !!controller;
  // Find the registration covering the current URL (scope is absolute, ends /).
  const covering = regs.find((r) => {
    try {
      return locationHref.startsWith(r.scope);
    } catch {
      return false;
    }
  });
  const activeState: ServiceWorkerCheck["activeState"] = covering?.active?.state
    ? (covering.active.state as ServiceWorkerCheck["activeState"])
    : controller?.state
      ? (controller.state as ServiceWorkerCheck["activeState"])
      : null;
  const scopeCoversOrigin = !!covering;
  const ok = controllerPresent && activeState === "activated" && scopeCoversOrigin;
  return {
    supported: true,
    registrationCount: regs.length,
    controllerPresent,
    activeState,
    scopeCoversOrigin,
    scope: covering?.scope,
    ok,
  };
}

/** Fetch + validate the manifest. Inject the fetch impl + page origin. */
export async function fetchManifest(
  url: string,
  fetchImpl: typeof fetch,
  origin: string,
): Promise<ManifestCheck> {
  const base: ManifestCheck = {
    url,
    fetched: false,
    parseOk: false,
    hasShortNameOrName: false,
    hasIcon192: false,
    hasIcon512: false,
    hasStartUrl: false,
    displayValid: false,
    preferRelatedAppsFalseOrAbsent: false,
    startUrlSameOrigin: false,
    ok: false,
  };
  let resp: Response;
  try {
    resp = await fetchImpl(url, { cache: "no-store" });
  } catch (e) {
    return { ...base, error: `fetch threw: ${(e as Error).message}` };
  }
  base.httpStatus = resp.status;
  if (!resp.ok) {
    return { ...base, error: `HTTP ${resp.status}` };
  }
  base.fetched = true;
  let json: unknown;
  try {
    json = await resp.json();
  } catch (e) {
    return { ...base, error: `JSON parse failed: ${(e as Error).message}` };
  }
  base.parseOk = true;
  return { ...base, ...validateManifestJson(json, origin) };
}

/** Call navigator.getInstalledRelatedApps() if present. Progressive enhancement. */
export async function gatherRelatedApps(
  fn: (() => Promise<{ platform: string; url?: string; id?: string }[]>) | null | undefined,
): Promise<RelatedAppsCheck> {
  if (!fn) return { apiPresent: false, apps: [] };
  try {
    const apps = await fn();
    return { apiPresent: true, apps: apps ?? [] };
  } catch {
    // Some browsers throw if the manifest has no related_applications; treat as
    // present-but-empty so we don't alarm the operator.
    return { apiPresent: true, apps: [] };
  }
}

/** Read persisted outcome telemetry from a storage (localStorage) impl. */
export function readOutcome(storage: { getItem(k: string): string | null } | null | undefined): OutcomeTelemetry {
  if (!storage) return { lastOutcome: null, installedAt: null };
  let lastOutcome: OutcomeTelemetry["lastOutcome"] = null;
  try {
    const raw = storage.getItem("vh.pwa.lastOutcome");
    if (raw) {
      const parsed = JSON.parse(raw) as { outcome?: unknown; platform?: unknown; ts?: unknown };
      if (parsed && typeof parsed.outcome === "string") {
        lastOutcome = {
          outcome: parsed.outcome,
          platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
          ts: typeof parsed.ts === "number" ? parsed.ts : 0,
        };
      }
    }
  } catch {
    /* corrupt JSON — treat as no telemetry */
  }
  let installedAt: number | null = null;
  try {
    const raw = storage.getItem("vh.pwa.installedAt");
    if (raw) {
      const n = Number(raw);
      installedAt = Number.isFinite(n) ? n : null;
    }
  } catch {
    /* storage blocked — no timestamp */
  }
  return { lastOutcome, installedAt };
}

// --- 3. Orchestrator -------------------------------------------------------

/** Dependency-injection seam. Every external read passes through here so the
 *  unit tests run fully in node with no DOM/global stubbing. */
export interface DiagDeps {
  isSecureContext?: boolean;
  isDev?: boolean;
  ua?: string;
  navigatorPlatform?: string;
  maxTouchPoints?: number;
  navigatorStandalone?: boolean;
  matchMedia?: (q: string) => { matches: boolean };
  fetchImpl?: typeof fetch;
  manifestUrl?: string;
  locationOrigin?: string;
  locationHref?: string;
  serviceWorker?: SwLike | null;
  getInstalledRelatedApps?: (() => Promise<{ platform: string; url?: string; id?: string }[]>) | null;
  storage?: { getItem(k: string): string | null } | null;
  beforeinstallpromptState?: () => { fired: boolean; ts: number | null; platforms: string[] };
  canInstall?: () => boolean;
  appinstalledFired?: () => boolean;
  isIosSafari?: () => boolean;
}

/** Build the rendered signal rows from the gathered result. Pure. */
export function buildSignalRows(r: Omit<DiagnosticsResult, "signals">): SignalRow[] {
  const rows: SignalRow[] = [];
  const fmtTs = (ts: number | null): string => {
    if (!ts) return "—";
    const d = new Date(ts);
    const ago = (() => {
      const s = Math.round((Date.now() - ts) / 1000);
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.round(s / 60)}m ago`;
      if (s < 86400) return `${Math.round(s / 3600)}h ago`;
      return `${Math.round(s / 86400)}d ago`;
    })();
    return `${d.toLocaleString()} (${ago})`;
  };
  rows.push({
    label: "Secure context (HTTPS)",
    status: r.secureContext ? "ok" : "bad",
    value: r.secureContext ? "yes" : "no — install requires HTTPS",
  });
  rows.push({
    label: "Build mode",
    status: r.isDevBuild ? "warn" : "info",
    value: r.isDevBuild ? "Vite dev build (SW registration is SKIPPED)" : "production build",
    detail: r.isDevBuild ? "pwa.ts returns early when import.meta.env.DEV — dev builds are never installable." : undefined,
  });
  rows.push({
    label: "Display mode",
    status: r.alreadyInstalled ? "ok" : "info",
    value: r.displayMode,
  });
  rows.push({
    label: "Already installed?",
    status: r.alreadyInstalled ? "ok" : "info",
    value: r.alreadyInstalled ? "yes (standalone)" : "no",
  });
  rows.push({
    label: "beforeinstallprompt fired?",
    status: r.capture.bipFired ? "ok" : "warn",
    value: r.capture.bipFired ? `yes, ${fmtTs(r.capture.bipFiredAt)}` : "not yet this session",
    detail: r.capture.bipFired && r.capture.bipPlatforms.length ? `platforms: ${r.capture.bipPlatforms.join(", ")}` : undefined,
  });
  rows.push({
    label: "Captured event still available?",
    status: r.capture.capturedEventAvailable ? "ok" : "warn",
    value: r.capture.capturedEventAvailable ? "yes — Install button should show" : "no (not fired, or already consumed)",
  });
  rows.push({
    label: "appinstalled fired?",
    status: r.capture.appinstalledFired ? "ok" : "info",
    value: r.capture.appinstalledFired ? "yes this session" : "no this session",
  });
  rows.push({
    label: "Manifest",
    status: r.manifest.ok ? "ok" : "bad",
    value: r.manifest.ok
      ? "valid (fetched + parsed, all required fields present)"
      : r.manifest.error
        ? `invalid: ${r.manifest.error}`
        : "invalid: a required field is missing",
    detail: r.manifest.httpStatus ? `HTTP ${r.manifest.httpStatus} from ${r.manifest.url}` : undefined,
  });
  if (r.manifest.fetched && r.manifest.parseOk && !r.manifest.ok) {
    const missing: string[] = [];
    if (!r.manifest.hasShortNameOrName) missing.push("name/short_name");
    if (!r.manifest.hasIcon192) missing.push("192px icon");
    if (!r.manifest.hasIcon512) missing.push("512px icon");
    if (!r.manifest.hasStartUrl) missing.push("start_url");
    if (!r.manifest.displayValid) missing.push("valid display");
    if (!r.manifest.startUrlSameOrigin) missing.push("same-origin start_url");
    if (!r.manifest.preferRelatedAppsFalseOrAbsent) missing.push("prefer_related_applications not true");
    if (missing.length) rows[rows.length - 1].detail = `missing/invalid: ${missing.join(", ")}`;
  }
  rows.push({
    label: "Service worker",
    status: r.serviceWorker.ok ? "ok" : r.serviceWorker.registrationCount > 0 ? "warn" : r.isDevBuild ? "warn" : "bad",
    value: !r.serviceWorker.supported
      ? "serviceWorker API unavailable"
      : r.serviceWorker.registrationCount === 0
        ? "no registrations"
        : `${r.serviceWorker.registrationCount} reg(s), controller ${r.serviceWorker.controllerPresent ? "present" : "null"}, active ${r.serviceWorker.activeState ?? "?"}`,
    detail: r.serviceWorker.scope ? `scope: ${r.serviceWorker.scope}; covers page: ${r.serviceWorker.scopeCoversOrigin}` : undefined,
  });
  rows.push({
    label: "getInstalledRelatedApps()",
    status: r.relatedApps.apiPresent ? (r.relatedApps.apps.length ? "ok" : "info") : "info",
    value: !r.relatedApps.apiPresent
      ? "API not present (progressive enhancement)"
      : r.relatedApps.apps.length
        ? `reports ${r.relatedApps.apps.length} installed app(s)`
        : "reports none (or manifest self-entry not yet deployed / WebAPK not yet rebuilt)",
  });
  rows.push({
    label: "Last install outcome",
    status: r.outcome.lastOutcome
      ? r.outcome.lastOutcome.outcome === "accepted"
        ? "ok"
        : "warn"
      : "info",
    value: r.outcome.lastOutcome
      ? `${r.outcome.lastOutcome.outcome} (${r.outcome.lastOutcome.platform}) ${fmtTs(r.outcome.lastOutcome.ts)}`
      : "never prompted (no telemetry)",
  });
  rows.push({
    label: "Installed at",
    status: r.outcome.installedAt ? "ok" : "info",
    value: r.outcome.installedAt ? fmtTs(r.outcome.installedAt) : "never",
  });
  rows.push({
    label: "Install type (this browser)",
    status: "info",
    value: installTypeLabel(r.installType, r.alreadyInstalled),
  });
  if (r.isIosSafari) {
    rows.push({ label: "iOS Safari detected", status: "warn", value: "no beforeinstallprompt by design" });
  } else if (r.isIos) {
    rows.push({ label: "iOS detected", status: "warn", value: "no beforeinstallprompt by design (any iOS browser)" });
  }
  if (r.isAndroidFirefox) {
    rows.push({ label: "Android Firefox detected", status: "warn", value: "no beforeinstallprompt by design" });
  }
  return rows;
}

/** Run the full diagnostic gather + compute. Reads browser globals by default;
 *  pass a DiagDeps object to override every input (for tests). */
export async function runDiagnostics(deps: DiagDeps = {}): Promise<DiagnosticsResult> {
  const isSecureContext = deps.isSecureContext ?? (typeof window !== "undefined" ? !!window.isSecureContext : false);
  const isDev = deps.isDev ?? !!(import.meta as any).env?.DEV;
  const ua =
    deps.ua ??
    (typeof navigator !== "undefined" ? navigator.userAgent : typeof globalThis !== "undefined" ? "" : "");
  const navigatorPlatform = deps.navigatorPlatform ?? (typeof navigator !== "undefined" ? navigator.platform : undefined);
  const maxTouchPoints = deps.maxTouchPoints ?? (typeof navigator !== "undefined" ? (navigator as any).maxTouchPoints : 0);
  const navigatorStandalone = deps.navigatorStandalone ?? (typeof navigator !== "undefined" ? !!(navigator as any).standalone : false);
  const matchMedia = deps.matchMedia ?? (typeof window !== "undefined" ? (q: string) => window.matchMedia(q) : undefined);
  const fetchImpl = deps.fetchImpl ?? (typeof globalThis !== "undefined" ? (globalThis as any).fetch : undefined);
  const manifestUrl = deps.manifestUrl ?? "/manifest.webmanifest";
  const locationOrigin = deps.locationOrigin ?? (typeof location !== "undefined" ? location.origin : "https://example.com");
  const locationHref = deps.locationHref ?? (typeof location !== "undefined" ? location.href : locationOrigin + "/");
  const sw = deps.serviceWorker ?? (typeof navigator !== "undefined" ? ((navigator as any).serviceWorker ?? null) : null);
  const gira = deps.getInstalledRelatedApps ?? (typeof navigator !== "undefined" ? (navigator as any).getInstalledRelatedApps?.bind(navigator) ?? null : null);
  const storage = deps.storage ?? (typeof localStorage !== "undefined" ? localStorage : null);

  // Lazy defaults read the real pwa-install singleton; deps override so tests
  // never touch it.
  const bipState =
    deps.beforeinstallpromptState ??
    (() => pwaInstall.beforeinstallpromptState());
  const canInstallFn = deps.canInstall ?? (() => pwaInstall.canInstall());
  const appinstalledFn = deps.appinstalledFired ?? (() => pwaInstall.appinstalledFired());
  const isIosSafariFn = deps.isIosSafari ?? (() => pwaInstall.isIosSafari());

  const isIos = isIosFromUA(ua, navigatorPlatform, maxTouchPoints);
  const isAndroidFirefox = isAndroidFirefoxFromUA(ua);
  const isAndroid = isAndroidFromUA(ua);
  const displayMode = detectDisplayMode(matchMedia);
  const alreadyInstalled =
    navigatorStandalone ||
    displayMode === "standalone" ||
    displayMode === "fullscreen" ||
    displayMode === "minimal-ui" ||
    displayMode === "window-controls-overlay";

  const bs = bipState();
  const capture: CaptureState = {
    bipFired: bs.fired,
    bipFiredAt: bs.ts,
    bipPlatforms: bs.platforms,
    capturedEventAvailable: canInstallFn(),
    appinstalledFired: appinstalledFn(),
  };

  const manifest = fetchImpl ? await fetchManifest(manifestUrl, fetchImpl, locationOrigin) : notFetched(manifestUrl, "fetch unavailable");

  let serviceWorker: ServiceWorkerCheck;
  if (!sw) {
    serviceWorker = gatherServiceWorker(null, locationHref);
  } else {
    let regs: RegLike[] = [];
    try {
      regs = await sw.getRegistrations();
    } catch {
      regs = [];
    }
    serviceWorker = analyzeRegistrations(regs, sw.controller, locationHref);
  }

  const relatedApps = await gatherRelatedApps(gira);
  const outcome = readOutcome(storage);
  const installType = computeInstallType({ ua, isIos, isAndroidFirefox, isAndroid, displayMode, navigatorStandalone });

  const likelyCause = computeLikelyCause({
    alreadyInstalled,
    isIos,
    isAndroidFirefox,
    manifestOk: manifest.ok,
    manifestError: manifest.error,
    swSupported: serviceWorker.supported,
    swRegistered: serviceWorker.registrationCount > 0,
    swControllerPresent: serviceWorker.controllerPresent,
    swActiveState: serviceWorker.activeState,
    isDevBuild: isDev,
    secureContext: isSecureContext,
    bipFired: capture.bipFired,
    capturedEventAvailable: capture.capturedEventAvailable,
    lastOutcomeDismissed: outcome.lastOutcome?.outcome === "dismissed",
  });

  const partial = {
    secureContext: isSecureContext,
    isDevBuild: isDev,
    isIosSafari: isIosSafariFn(),
    isIos,
    isAndroidFirefox,
    displayMode,
    alreadyInstalled,
    capture,
    manifest,
    serviceWorker,
    outcome,
    relatedApps,
    installType,
    likelyCause,
    cannotObserve: CANNOT_OBSERVE,
    webapkNote: WEBAPK_NOTE,
  };
  const signals = buildSignalRows(partial);
  return { ...partial, signals };
}

// Helpers for the orchestrator defaults.

function notFetched(url: string, reason: string): ManifestCheck {
  return {
    url,
    fetched: false,
    parseOk: false,
    error: reason,
    hasShortNameOrName: false,
    hasIcon192: false,
    hasIcon512: false,
    hasStartUrl: false,
    displayValid: false,
    preferRelatedAppsFalseOrAbsent: false,
    startUrlSameOrigin: false,
    ok: false,
  };
}
