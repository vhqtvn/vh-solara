// Default node env — this module is designed with full dependency injection so
// every signal-computing function is testable WITHOUT jsdom, matchMedia stubs,
// or global mutation. We pass mock fetch / SW / storage / accessors directly.
import { describe, expect, it, vi } from "vitest";
import {
  analyzeRegistrations,
  buildSignalRows,
  chipLabel,
  CANNOT_OBSERVE,
  computeInstallType,
  computeLikelyCause,
  detectDisplayMode,
  fetchManifest,
  gatherRelatedApps,
  installTypeLabel,
  isAndroidFirefoxFromUA,
  isAndroidFromUA,
  isDesktopChromiumFromUA,
  isIosFromUA,
  readOutcome,
  runDiagnostics,
  validateManifestJson,
  WEBAPK_NOTE,
  type DiagDeps,
  type RegLike,
} from "../../src/pwa-diagnostics";

// --- helpers --------------------------------------------------------------

/** A minimal Response-shaped object the fetchManifest code path accepts. */
function jsonResp(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A valid manifest matching the deployed web/public/manifest.webmanifest. */
const VALID_MANIFEST = {
  name: "VHSolara",
  short_name: "VHSolara",
  start_url: "/",
  scope: "/",
  display: "standalone",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};

const ORIGIN = "https://app.example.com";

// ==========================================================================
// 1. UA-sniff helpers
// ==========================================================================
describe("UA-sniff helpers", () => {
  it("isIosFromUA detects iPhone/iPad/iPod across browsers", () => {
    expect(isIosFromUA("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)")).toBe(true);
    expect(isIosFromUA("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)")).toBe(true);
    // Chrome on iOS
    expect(isIosFromUA("Mozilla/5.0 (iPod; …) CriOS/120")).toBe(true);
    // Android is NOT iOS
    expect(isIosFromUA("Mozilla/5.0 (Linux; Android 13; …) Chrome/120")).toBe(false);
    // Desktop is NOT iOS
    expect(isIosFromUA("Mozilla/5.0 (Windows NT 10.0) Chrome/120")).toBe(false);
  });

  it("isIosFromUA detects iPad-as-desktop via MacIntel + touch", () => {
    // iPadOS 13+ reports a Mac UA; the touch-points heuristic catches it.
    expect(isIosFromUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "MacIntel", 5)).toBe(true);
    // A real desktop Mac has no touch
    expect(isIosFromUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "MacIntel", 0)).toBe(false);
  });

  it("isAndroidFirefoxFromUA detects only Android Firefox (not desktop Firefox, not Android Chrome)", () => {
    expect(isAndroidFirefoxFromUA("Mozilla/5.0 (Linux; Android 13; SM-S901B) Firefox/120")).toBe(true);
    expect(isAndroidFirefoxFromUA("Mozilla/5.0 (Linux; Android 13; …) Chrome/120")).toBe(false);
    expect(isAndroidFirefoxFromUA("Mozilla/5.0 (Windows NT 10.0; rv:120) Gecko/20100101 Firefox/120")).toBe(false);
  });

  it("isAndroidFromUA detects Android excluding Firefox", () => {
    expect(isAndroidFromUA("Mozilla/5.0 (Linux; Android 13; …) Chrome/120")).toBe(true);
    expect(isAndroidFromUA("Mozilla/5.0 (Linux; Android 13; …) Firefox/120")).toBe(false);
    expect(isAndroidFromUA("Mozilla/5.0 (iPhone; …)")).toBe(false);
  });

  it("isDesktopChromiumFromUA detects Chrome/Edge/Brave on desktop only", () => {
    expect(isDesktopChromiumFromUA("Mozilla/5.0 (Windows NT 10.0) Chrome/120", false, false)).toBe(true);
    expect(isDesktopChromiumFromUA("Mozilla/5.0 (Macintosh) Chrome/120 Edg/120", false, false)).toBe(true);
    // Brave is indistinguishable from Chrome
    expect(isDesktopChromiumFromUA("Mozilla/5.0 (X11; Linux x86_64) Chrome/120", false, false)).toBe(true);
    // Desktop Firefox is excluded
    expect(isDesktopChromiumFromUA("Mozilla/5.0 (Windows NT 10.0; rv:120) Firefox/120", false, false)).toBe(false);
    // Android Chrome is NOT desktop
    expect(isDesktopChromiumFromUA("Mozilla/5.0 (Linux; Android 13) Chrome/120", true, false)).toBe(false);
  });
});

// ==========================================================================
// 2. detectDisplayMode
// ==========================================================================
describe("detectDisplayMode", () => {
  it("returns 'browser' when no installable display-mode matches", () => {
    const mm = (q: string) => ({ matches: false });
    expect(detectDisplayMode(mm)).toBe("browser");
  });

  it("returns the matching mode", () => {
    const mm = (q: string) => ({ matches: q === "(display-mode: standalone)" });
    expect(detectDisplayMode(mm)).toBe("standalone");
  });

  it("returns browser when matchMedia is unavailable", () => {
    expect(detectDisplayMode(undefined)).toBe("browser");
  });

  it("treats a matchMedia that throws as no-match (resilient)", () => {
    const mm = (): { matches: boolean } => {
      throw new Error("not implemented");
    };
    expect(detectDisplayMode(mm as never)).toBe("browser");
  });
});

// ==========================================================================
// 3. validateManifestJson
// ==========================================================================
describe("validateManifestJson", () => {
  it("validates a fully-compliant manifest", () => {
    const r = validateManifestJson(VALID_MANIFEST, ORIGIN);
    expect(r.ok).toBe(true);
    expect(r.hasShortNameOrName).toBe(true);
    expect(r.hasIcon192).toBe(true);
    expect(r.hasIcon512).toBe(true);
    expect(r.hasStartUrl).toBe(true);
    expect(r.displayValid).toBe(true);
    expect(r.preferRelatedAppsFalseOrAbsent).toBe(true);
    expect(r.startUrlSameOrigin).toBe(true);
  });

  it("fails when name/short_name are missing or empty", () => {
    const r = validateManifestJson({ ...VALID_MANIFEST, name: "", short_name: "" }, ORIGIN);
    expect(r.hasShortNameOrName).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("accepts name alone when short_name is absent", () => {
    const { name, ...noShort } = VALID_MANIFEST;
    const r = validateManifestJson({ name, ...noShort }, ORIGIN);
    expect(r.hasShortNameOrName).toBe(true);
  });

  it("fails when the 512px icon is missing", () => {
    const r = validateManifestJson(
      { ...VALID_MANIFEST, icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
      ORIGIN,
    );
    expect(r.hasIcon512).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("fails when display is 'browser' (not an installable mode)", () => {
    const r = validateManifestJson({ ...VALID_MANIFEST, display: "browser" }, ORIGIN);
    expect(r.displayValid).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("fails when prefer_related_applications is true", () => {
    const r = validateManifestJson({ ...VALID_MANIFEST, prefer_related_applications: true }, ORIGIN);
    expect(r.preferRelatedAppsFalseOrAbsent).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("flags a cross-origin start_url", () => {
    const r = validateManifestJson({ ...VALID_MANIFEST, start_url: "https://other.example/" }, ORIGIN);
    expect(r.startUrlSameOrigin).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("resolves a relative start_url against the page origin", () => {
    const r = validateManifestJson({ ...VALID_MANIFEST, start_url: "./app/" }, ORIGIN);
    expect(r.startUrlSameOrigin).toBe(true);
  });

  it("handles a null/undefined manifest gracefully (all false, ok false)", () => {
    const r = validateManifestJson(null, ORIGIN);
    expect(r.ok).toBe(false);
    expect(r.hasShortNameOrName).toBe(false);
  });
});

// ==========================================================================
// 4. fetchManifest
// ==========================================================================
describe("fetchManifest", () => {
  it("parses a 200 OK valid manifest as ok", async () => {
    const fetchImpl = vi.fn(async () => jsonResp(VALID_MANIFEST));
    const r = await fetchManifest("/manifest.webmanifest", fetchImpl as never, ORIGIN);
    expect(fetchImpl).toHaveBeenCalledWith("/manifest.webmanifest", { cache: "no-store" });
    expect(r.fetched).toBe(true);
    expect(r.parseOk).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("flags a 404 as fetched=false with an HTTP error", async () => {
    const fetchImpl = vi.fn(async () => jsonResp({ error: "no" }, false, 404));
    const r = await fetchManifest("/manifest.webmanifest", fetchImpl as never, ORIGIN);
    expect(r.fetched).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("HTTP 404");
    expect(r.httpStatus).toBe(404);
  });

  it("flags a JSON parse failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("unexpected token");
      },
    }));
    const r = await fetchManifest("/manifest.webmanifest", fetchImpl as never, ORIGIN);
    expect(r.fetched).toBe(true);
    expect(r.parseOk).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("JSON parse failed");
  });

  it("captures a network throw as a fetch error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const r = await fetchManifest("/manifest.webmanifest", fetchImpl as never, ORIGIN);
    expect(r.fetched).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("fetch threw");
  });

  it("marks an otherwise-fetched manifest invalid when a field is missing", async () => {
    const broken = { ...VALID_MANIFEST, display: "browser" };
    const fetchImpl = vi.fn(async () => jsonResp(broken));
    const r = await fetchManifest("/manifest.webmanifest", fetchImpl as never, ORIGIN);
    expect(r.fetched).toBe(true);
    expect(r.parseOk).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.displayValid).toBe(false);
  });
});

// ==========================================================================
// 5. analyzeRegistrations (service worker state)
// ==========================================================================
describe("analyzeRegistrations", () => {
  const HREF = ORIGIN + "/some/page";

  it("is fully OK when a covering registration has an activated controller", () => {
    const regs: RegLike[] = [
      { scope: ORIGIN + "/", active: { state: "activated" }, installing: null, waiting: null },
    ];
    const r = analyzeRegistrations(regs, { state: "activated" }, HREF);
    expect(r.registrationCount).toBe(1);
    expect(r.controllerPresent).toBe(true);
    expect(r.activeState).toBe("activated");
    expect(r.scopeCoversOrigin).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("reports no registrations when the SW list is empty", () => {
    const r = analyzeRegistrations([], null, HREF);
    expect(r.registrationCount).toBe(0);
    expect(r.controllerPresent).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("reports controller null when registered but not yet controlling", () => {
    const regs: RegLike[] = [
      { scope: ORIGIN + "/", active: { state: "installing" }, installing: null, waiting: null },
    ];
    const r = analyzeRegistrations(regs, null, HREF);
    expect(r.controllerPresent).toBe(false);
    expect(r.activeState).toBe("installing");
    expect(r.ok).toBe(false);
  });

  it("flags a scope mismatch (reg exists but doesn't cover the URL)", () => {
    const regs: RegLike[] = [
      { scope: ORIGIN + "/subapp/", active: { state: "activated" }, installing: null, waiting: null },
    ];
    const r = analyzeRegistrations(regs, { state: "activated" }, HREF);
    // Controller is present so it could still be controlling, but the covering
    // scope check fails — the page is outside the only registration's scope.
    expect(r.scopeCoversOrigin).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("falls back to controller.state when no covering registration is found", () => {
    const r = analyzeRegistrations([], { state: "activated" }, HREF);
    expect(r.controllerPresent).toBe(true);
    expect(r.activeState).toBe("activated");
    expect(r.scopeCoversOrigin).toBe(false);
    expect(r.ok).toBe(false);
  });
});

// ==========================================================================
// 6. readOutcome (localStorage telemetry)
// ==========================================================================
describe("readOutcome", () => {
  it("returns empty telemetry when storage is null", () => {
    const r = readOutcome(null);
    expect(r.lastOutcome).toBeNull();
    expect(r.installedAt).toBeNull();
  });

  it("parses a lastOutcome entry", () => {
    const store: Record<string, string> = {
      "vh.pwa.lastOutcome": JSON.stringify({ outcome: "dismissed", platform: "web", ts: 1234 }),
      "vh.pwa.installedAt": "5678",
    };
    const r = readOutcome({ getItem: (k) => store[k] ?? null });
    expect(r.lastOutcome).toEqual({ outcome: "dismissed", platform: "web", ts: 1234 });
    expect(r.installedAt).toBe(5678);
  });

  it("coerces a missing platform to 'unknown'", () => {
    const store: Record<string, string> = {
      "vh.pwa.lastOutcome": JSON.stringify({ outcome: "accepted", ts: 1 }),
    };
    const r = readOutcome({ getItem: (k) => store[k] ?? null });
    expect(r.lastOutcome?.platform).toBe("unknown");
  });

  it("survives corrupt JSON / non-numeric timestamps", () => {
    const store: Record<string, string> = {
      "vh.pwa.lastOutcome": "{not json",
      "vh.pwa.installedAt": "not-a-number",
    };
    const r = readOutcome({ getItem: (k) => store[k] ?? null });
    expect(r.lastOutcome).toBeNull();
    expect(r.installedAt).toBeNull();
  });

  it("ignores a lastOutcome with no outcome field", () => {
    const store: Record<string, string> = {
      "vh.pwa.lastOutcome": JSON.stringify({ platform: "web", ts: 1 }),
    };
    const r = readOutcome({ getItem: (k) => store[k] ?? null });
    expect(r.lastOutcome).toBeNull();
  });
});

// ==========================================================================
// 7. gatherRelatedApps
// ==========================================================================
describe("gatherRelatedApps", () => {
  it("returns apiPresent=false when the function is null", async () => {
    const r = await gatherRelatedApps(null);
    expect(r.apiPresent).toBe(false);
    expect(r.apps).toEqual([]);
  });

  it("returns the apps list when the API resolves", async () => {
    const fn = async () => [{ platform: "webapp", url: "/", id: "/" }];
    const r = await gatherRelatedApps(fn);
    expect(r.apiPresent).toBe(true);
    expect(r.apps).toHaveLength(1);
  });

  it("swallows a throwing API as present-but-empty (don't alarm)", async () => {
    const fn = async () => {
      throw new Error("not allowed");
    };
    const r = await gatherRelatedApps(fn);
    expect(r.apiPresent).toBe(true);
    expect(r.apps).toEqual([]);
  });
});

// ==========================================================================
// 8. computeInstallType
// ==========================================================================
describe("computeInstallType", () => {
  const base = {
    isIos: false,
    isAndroidFirefox: false,
    isAndroid: false,
    displayMode: "browser" as const,
    navigatorStandalone: false,
  };

  it("labels Android Chrome/Samsung as webapk", () => {
    expect(computeInstallType({ ...base, ua: "Android Chrome/120", isAndroid: true })).toBe("webapk");
  });

  it("labels Android Firefox as firefox-managed", () => {
    expect(computeInstallType({ ...base, ua: "Android Firefox/120", isAndroidFirefox: true })).toBe("firefox-managed");
  });

  it("labels iOS (any browser) as ios-bookmark", () => {
    expect(computeInstallType({ ...base, ua: "iPhone CriOS/120", isIos: true })).toBe("ios-bookmark");
  });

  it("labels desktop Chrome/Edge/Brave as chromium-shortcut", () => {
    expect(computeInstallType({ ...base, ua: "Windows Chrome/120" })).toBe("chromium-shortcut");
  });

  it("labels desktop Firefox / Safari as not-installed (no BIP support)", () => {
    expect(computeInstallType({ ...base, ua: "Windows Firefox/120" })).toBe("not-installed");
    expect(computeInstallType({ ...base, ua: "Macintosh Version/17 Safari" })).toBe("not-installed");
  });

  it("prefers standalone-mode as webapk (already running installed)", () => {
    expect(computeInstallType({ ...base, ua: "Windows Chrome/120", displayMode: "standalone" })).toBe("webapk");
  });

  it("honors navigator.standalone (iOS Safari launched from home screen)", () => {
    expect(computeInstallType({ ...base, ua: "iPhone", navigatorStandalone: true })).toBe("webapk");
  });
});

describe("installTypeLabel", () => {
  it("renders a human label for each type", () => {
    expect(installTypeLabel("webapk", false)).toContain("WebAPK");
    expect(installTypeLabel("chromium-shortcut", false)).toContain("Chromium");
    expect(installTypeLabel("ios-bookmark", false)).toContain("bookmark");
    expect(installTypeLabel("firefox-managed", false)).toContain("Firefox");
    expect(installTypeLabel("not-installed", false)).toContain("Not installed");
  });

  it("prefixes 'Already installed' when standalone + an installable type", () => {
    expect(installTypeLabel("webapk", true)).toContain("Already installed");
  });
});

// ==========================================================================
// 9. computeLikelyCause (failure-mode table)
// ==========================================================================
describe("computeLikelyCause (failure-mode table)", () => {
  const ok = {
    alreadyInstalled: false,
    isIos: false,
    isAndroidFirefox: false,
    manifestOk: true,
    swSupported: true,
    swRegistered: true,
    swControllerPresent: true,
    swActiveState: "activated" as const,
    isDevBuild: false,
    secureContext: true,
    bipFired: false,
    capturedEventAvailable: false,
    lastOutcomeDismissed: false,
  };

  it("calls out already-installed first", () => {
    expect(computeLikelyCause({ ...ok, alreadyInstalled: true })).toContain("Already installed");
  });

  it("explains iOS has no BIP by design", () => {
    expect(computeLikelyCause({ ...ok, isIos: true })).toContain("iOS never fires beforeinstallprompt");
  });

  it("explains Android Firefox has no BIP by design", () => {
    expect(computeLikelyCause({ ...ok, isAndroidFirefox: true })).toContain("Android Firefox never fires");
  });

  it("flags an insecure context", () => {
    expect(computeLikelyCause({ ...ok, secureContext: false })).toContain("secure context");
  });

  it("flags a manifest problem", () => {
    const r = computeLikelyCause({ ...ok, manifestOk: false, manifestError: "HTTP 404" });
    expect(r).toContain("Manifest problem");
    expect(r).toContain("HTTP 404");
  });

  it("flags dev-build SW skip specifically", () => {
    const r = computeLikelyCause({ ...ok, swRegistered: false, isDevBuild: true });
    expect(r).toContain("Vite dev build");
  });

  it("flags a prod missing SW as blocked/failed", () => {
    const r = computeLikelyCause({ ...ok, swRegistered: false, isDevBuild: false });
    expect(r).toContain("not registered");
    expect(r).toContain("/sw.js");
  });

  it("flags registered-but-no-controller", () => {
    const r = computeLikelyCause({ ...ok, swControllerPresent: false });
    expect(r).toContain("not yet controlling");
  });

  it("flags a non-activated active state", () => {
    const r = computeLikelyCause({ ...ok, swActiveState: "installing" });
    expect(r).toContain("installing");
  });

  it("calls out the dismissal cooldown from telemetry", () => {
    const r = computeLikelyCause({ ...ok, lastOutcomeDismissed: true });
    expect(r).toContain("cooldown");
  });

  it("prompts to use the Install button when an event IS captured", () => {
    const r = computeLikelyCause({ ...ok, capturedEventAvailable: true });
    expect(r).toContain("Install button");
  });

  it("honestly lists JS-invisible causes when all checks pass but BIP hasn't fired", () => {
    const r = computeLikelyCause({ ...ok, bipFired: false });
    expect(r).toContain("engagement heuristic");
    expect(r).toContain("cooldown");
    expect(r).toContain("incognito");
  });

  it("falls through to a generic review message when BIP fired but nothing else applies", () => {
    const r = computeLikelyCause({ ...ok, bipFired: true });
    expect(r).toContain("No specific cause");
  });
});

// ==========================================================================
// 10. buildSignalRows + static text
// ==========================================================================
describe("buildSignalRows + static panel text", () => {
  function baseResult() {
    return {
      secureContext: true,
      isDevBuild: false,
      isIosSafari: false,
      isIos: false,
      isAndroidFirefox: false,
      displayMode: "browser" as const,
      alreadyInstalled: false,
      capture: {
        bipFired: false,
        bipFiredAt: null,
        bipPlatforms: [],
        capturedEventAvailable: false,
        appinstalledFired: false,
      },
      manifest: {
        url: "/manifest.webmanifest",
        fetched: true,
        parseOk: true,
        httpStatus: 200,
        ok: true,
        hasShortNameOrName: true,
        hasIcon192: true,
        hasIcon512: true,
        hasStartUrl: true,
        displayValid: true,
        preferRelatedAppsFalseOrAbsent: true,
        startUrlSameOrigin: true,
      },
      serviceWorker: {
        supported: true,
        registrationCount: 1,
        controllerPresent: true,
        activeState: "activated" as const,
        scopeCoversOrigin: true,
        ok: true,
      },
      outcome: { lastOutcome: null, installedAt: null },
      relatedApps: { apiPresent: false, apps: [] },
      installType: "chromium-shortcut" as const,
      likelyCause: "test cause",
      cannotObserve: CANNOT_OBSERVE,
      webapkNote: WEBAPK_NOTE,
    };
  }

  it("includes the secure-context row", () => {
    const rows = buildSignalRows(baseResult());
    expect(rows.some((r) => r.label.includes("Secure context"))).toBe(true);
  });

  it("adds an iOS-specific row only when iOS is detected", () => {
    const r = { ...baseResult(), isIos: true };
    const rows = buildSignalRows(r);
    expect(rows.some((row) => row.label.includes("iOS"))).toBe(true);
  });

  it("lists the missing manifest fields in the detail when an otherwise-parsed manifest is invalid", () => {
    const r = {
      ...baseResult(),
      manifest: { ...baseResult().manifest, ok: false, hasIcon512: false, displayValid: false },
    };
    const rows = buildSignalRows(r);
    const m = rows.find((row) => row.label === "Manifest");
    expect(m?.detail).toContain("512px icon");
    expect(m?.detail).toContain("valid display");
  });

  it("exposes the static cannot-observe + WebAPK-note text verbatim", () => {
    expect(CANNOT_OBSERVE.length).toBeGreaterThan(0);
    expect(CANNOT_OBSERVE.some((c) => c.includes("engagement heuristic"))).toBe(true);
    expect(CANNOT_OBSERVE.some((c) => c.includes("cooldown"))).toBe(true);
    expect(CANNOT_OBSERVE.some((c) => c.includes("incognito"))).toBe(true);
    expect(WEBAPK_NOTE).toContain("~30 days");
  });
});

describe("chipLabel", () => {
  it("maps every status to a short label", () => {
    expect(chipLabel("ok")).toBe("OK");
    expect(chipLabel("warn")).toBe("WARN");
    expect(chipLabel("bad")).toBe("FAIL");
    expect(chipLabel("info")).toBe("INFO");
  });
});

// ==========================================================================
// 11. runDiagnostics orchestrator (full deps injection — no globals touched)
// ==========================================================================
describe("runDiagnostics orchestrator", () => {
  // A complete deps object that simulates a healthy desktop-Chrome tab where
  // BIP simply hasn't fired yet. Override per-test to flip signals.
  function healthyDeps(): DiagDeps {
    return {
      isSecureContext: true,
      isDev: false,
      ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/120",
      navigatorPlatform: "Win32",
      maxTouchPoints: 0,
      navigatorStandalone: false,
      matchMedia: () => ({ matches: false }),
      fetchImpl: vi.fn(async () => jsonResp(VALID_MANIFEST)) as never,
      manifestUrl: "/manifest.webmanifest",
      locationOrigin: ORIGIN,
      locationHref: ORIGIN + "/",
      serviceWorker: {
        controller: { state: "activated" },
        getRegistrations: async () => [
          { scope: ORIGIN + "/", active: { state: "activated" }, installing: null, waiting: null },
        ],
      },
      getInstalledRelatedApps: null,
      storage: { getItem: () => null },
      beforeinstallpromptState: () => ({ fired: false, ts: null, platforms: [] }),
      canInstall: () => false,
      appinstalledFired: () => false,
      isIosSafari: () => false,
    };
  }

  it("assembles a full result for a healthy-not-yet-prompted desktop tab", async () => {
    const r = await runDiagnostics(healthyDeps());
    expect(r.secureContext).toBe(true);
    expect(r.isDevBuild).toBe(false);
    expect(r.isIos).toBe(false);
    expect(r.displayMode).toBe("browser");
    expect(r.alreadyInstalled).toBe(false);
    expect(r.manifest.ok).toBe(true);
    expect(r.serviceWorker.ok).toBe(true);
    expect(r.installType).toBe("chromium-shortcut");
    expect(r.capture.bipFired).toBe(false);
    expect(r.signals.length).toBeGreaterThan(8);
    expect(r.likelyCause).toContain("engagement heuristic");
    expect(r.cannotObserve).toBe(CANNOT_OBSERVE);
    expect(r.webapkNote).toBe(WEBAPK_NOTE);
  });

  it("surfaces the dev-build SW skip (no registrations, DEV=true)", async () => {
    const deps = {
      ...healthyDeps(),
      isDev: true,
      serviceWorker: { controller: null, getRegistrations: async () => [] },
    };
    const r = await runDiagnostics(deps);
    expect(r.isDevBuild).toBe(true);
    expect(r.serviceWorker.registrationCount).toBe(0);
    expect(r.likelyCause).toContain("Vite dev build");
    // The Build mode row should carry a WARN chip in dev.
    const build = r.signals.find((row) => row.label === "Build mode");
    expect(build?.status).toBe("warn");
  });

  it("classifies an iPhone as ios-bookmark with a no-BIP-by-design cause", async () => {
    const deps = {
      ...healthyDeps(),
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
      navigatorPlatform: "iPhone",
      maxTouchPoints: 5,
      beforeinstallpromptState: () => ({ fired: false, ts: null, platforms: [] }),
    };
    const r = await runDiagnostics(deps);
    expect(r.isIos).toBe(true);
    expect(r.installType).toBe("ios-bookmark");
    expect(r.likelyCause).toContain("iOS never fires");
  });

  it("detects an already-installed standalone session", async () => {
    const deps = {
      ...healthyDeps(),
      matchMedia: (q: string) => ({ matches: q === "(display-mode: standalone)" }),
    };
    const r = await runDiagnostics(deps);
    expect(r.displayMode).toBe("standalone");
    expect(r.alreadyInstalled).toBe(true);
    expect(r.likelyCause).toContain("Already installed");
  });

  it("flags a manifest 404 as the likely cause", async () => {
    const deps = {
      ...healthyDeps(),
      fetchImpl: vi.fn(async () => jsonResp({ error: "no" }, false, 404)) as never,
    };
    const r = await runDiagnostics(deps);
    expect(r.manifest.ok).toBe(false);
    expect(r.manifest.error).toBe("HTTP 404");
    expect(r.likelyCause).toContain("Manifest problem");
    const m = r.signals.find((row) => row.label === "Manifest");
    expect(m?.status).toBe("bad");
  });

  it("flags a registered-but-no-controller SW (installing)", async () => {
    const deps = {
      ...healthyDeps(),
      serviceWorker: {
        controller: null,
        getRegistrations: async () => [
          { scope: ORIGIN + "/", active: null, installing: { state: "installing" }, waiting: null },
        ],
      },
    };
    const r = await runDiagnostics(deps);
    expect(r.serviceWorker.controllerPresent).toBe(false);
    expect(r.likelyCause).toContain("not yet controlling");
  });

  it("reads a dismissed lastOutcome and reports the cooldown cause", async () => {
    const store: Record<string, string> = {
      "vh.pwa.lastOutcome": JSON.stringify({ outcome: "dismissed", platform: "web", ts: Date.now() - 60_000 }),
    };
    const deps = {
      ...healthyDeps(),
      storage: { getItem: (k: string) => store[k] ?? null },
    };
    const r = await runDiagnostics(deps);
    expect(r.outcome.lastOutcome?.outcome).toBe("dismissed");
    expect(r.likelyCause).toContain("cooldown");
  });

  it("treats an insecure context as the likely cause (HTTPS required)", async () => {
    const deps = { ...healthyDeps(), isSecureContext: false };
    const r = await runDiagnostics(deps);
    expect(r.secureContext).toBe(false);
    expect(r.likelyCause).toContain("secure context");
    const sc = r.signals.find((row) => row.label.includes("Secure context"));
    expect(sc?.status).toBe("bad");
  });

  it("includes BIP platforms in the capture detail when fired", async () => {
    const deps = {
      ...healthyDeps(),
      beforeinstallpromptState: () => ({ fired: true, ts: 1234, platforms: ["web", "play"] }),
      canInstall: () => true,
    };
    const r = await runDiagnostics(deps);
    expect(r.capture.bipFired).toBe(true);
    expect(r.capture.bipPlatforms).toEqual(["web", "play"]);
    expect(r.capture.capturedEventAvailable).toBe(true);
    const row = r.signals.find((s) => s.label.includes("beforeinstallprompt fired"));
    expect(row?.status).toBe("ok");
  });

  it("labels Android Firefox as firefox-managed with a no-BIP cause", async () => {
    const deps = {
      ...healthyDeps(),
      ua: "Mozilla/5.0 (Linux; Android 13; SM-S901B) Firefox/120",
    };
    const r = await runDiagnostics(deps);
    expect(r.isAndroidFirefox).toBe(true);
    expect(r.installType).toBe("firefox-managed");
    expect(r.likelyCause).toContain("Android Firefox never fires");
  });

  it("reports getInstalledRelatedApps as present when the fn resolves", async () => {
    const deps = {
      ...healthyDeps(),
      getInstalledRelatedApps: async () => [{ platform: "webapp", url: "/", id: "/" }],
    };
    const r = await runDiagnostics(deps);
    expect(r.relatedApps.apiPresent).toBe(true);
    expect(r.relatedApps.apps).toHaveLength(1);
  });
});
