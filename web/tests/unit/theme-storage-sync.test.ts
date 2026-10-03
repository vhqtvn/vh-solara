// @vitest-environment jsdom
// Cross-document THEME sync (the reported bug: change the theme in one tab /
// host pane and the others keep the old theme until reload).
//
// persistedSignal-storage-sync.test.ts covers the generic mechanism; this file
// covers the THEME layer on top of it: the imperative apply (classes + inline
// vars on <html>) must re-run on the `storage` path for both vh.theme.v1 and
// vh.theme.custom.v1, the downstream pushes (embedded-view tokens + code-frame
// nudge) must run on the remote path too, and the visibilitychange catch-up
// must recover a write a frozen tab never saw.
//
// Same simulation model as the persistedSignal tests: another same-origin
// document writes the shared localStorage and the browser fires `storage` in
// THIS document — we set localStorage directly and dispatch the event.
import { afterEach, describe, expect, it } from "vitest";
import { customTheme, onThemeApplied, setCustomTheme, setThemeId, theme } from "../../src/theme";
import { broadcastTheme, THEME_TOKENS } from "../../src/themeTokens";

const LS_THEME = "vh.theme.v1";
const LS_CUSTOM = "vh.theme.custom.v1";

function fireStorage(key: string): void {
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

// Simulate another document writing the key: localStorage is shared
// same-origin, so by the time `storage` fires here our storage already holds
// the new value.
function remoteWrite(key: string, data: unknown): void {
  localStorage.setItem(key, JSON.stringify({ v: 1, data }));
  fireStorage(key);
}

// Force jsdom's visibilityState for a catch-up test, restoring the prototype
// getter afterwards (jsdom defines it on Document.prototype; the own-property
// override shadows it).
function forceVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
}
function restoreVisibility(): void {
  delete (document as { visibilityState?: string }).visibilityState;
}

afterEach(() => {
  restoreVisibility();
});

describe("theme cross-document storage sync", () => {
  it("re-applies a theme another document wrote, without a reload", () => {
    localStorage.clear();
    setThemeId("dark");
    expect(document.documentElement.classList.contains("theme-dark")).toBe(true);

    remoteWrite(LS_THEME, "nord");
    expect(theme()).toBe("nord");
    const el = document.documentElement;
    expect(el.classList.contains("theme-nord")).toBe(true);
    expect(el.classList.contains("theme-dark")).toBe(false);
  });

  it("a remote LIGHT theme flips the light markers", () => {
    localStorage.clear();
    setThemeId("dark");
    remoteWrite(LS_THEME, "light");
    const el = document.documentElement;
    expect(theme()).toBe("light");
    expect(el.classList.contains("theme-light-scoped")).toBe(true);
    expect(el.style.colorScheme).toBe("light");
  });

  it("remote custom fields re-apply live while the custom theme is active", () => {
    localStorage.clear();
    setCustomTheme({ bg: "#111111" });
    setThemeId("custom");
    expect(document.documentElement.style.getPropertyValue("--bg").trim()).toBe("#111111");

    remoteWrite(LS_CUSTOM, { ...customTheme(), bg: "#222244", accent: "#00ff88" });
    expect(customTheme().bg).toBe("#222244");
    expect(customTheme().accent).toBe("#00ff88");
    const el = document.documentElement;
    expect(el.style.getPropertyValue("--bg").trim()).toBe("#222244");
    expect(el.style.getPropertyValue("--accent").trim()).toBe("#00ff88");
    // still the custom theme, just re-applied with the new fields
    expect(el.classList.contains("theme-custom")).toBe(true);
  });

  it("remote custom fields update the signal but do NOT stomp a non-custom theme", () => {
    localStorage.clear();
    setThemeId("dark");
    remoteWrite(LS_CUSTOM, { ...customTheme(), bg: "#445566" });
    expect(customTheme().bg).toBe("#445566"); // signal follows the shared value…
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(""); // …but nothing is applied inline
    expect(document.documentElement.classList.contains("theme-dark")).toBe(true);
  });

  it("a same-version envelope's data is trusted as-is (pre-existing loadVersioned semantics)", () => {
    localStorage.clear();
    setThemeId("nord");
    // migrate only guards version transitions and non-JSON payloads; a
    // same-version envelope's data passes through untouched — identical to
    // what a boot-time load of the same bytes would produce. Characterized,
    // not endorsed (hardening the migrate is out of scope for this slice).
    remoteWrite(LS_THEME, 42);
    expect(theme() as unknown).toBe(42);
    expect(document.documentElement.classList.contains("theme-42")).toBe(true);
  });

  it("a legacy BARE (non-JSON) remote value migrates through the same path as boot", () => {
    localStorage.clear();
    setThemeId("dark");
    localStorage.setItem(LS_THEME, "nord"); // legacy unversioned spelling
    fireStorage(LS_THEME);
    expect(theme()).toBe("nord");
    expect(document.documentElement.classList.contains("theme-nord")).toBe(true);
  });

  it("fans out to onThemeApplied on the remote path, and unregistering stops it", () => {
    localStorage.clear();
    const calls: string[] = [];
    const off = onThemeApplied(() => calls.push("push"));
    remoteWrite(LS_THEME, "nord");
    expect(calls).toEqual(["push"]);
    // Local applies fan out through the SAME route (index.tsx registers the
    // embedded-view + code-frame pushes here; both paths share it).
    setThemeId("dracula");
    expect(calls).toEqual(["push", "push"]);
    off();
    remoteWrite(LS_THEME, "dark");
    setThemeId("dark");
    expect(calls).toEqual(["push", "push"]); // unregistered → no further fan-out
  });

  it("posts live theme tokens into a mounted embedded-view iframe on the remote path", async () => {
    localStorage.clear();
    // Production-shaped wiring (index.tsx): the token broadcast hangs off
    // onThemeApplied. theme.ts itself cannot import themeTokens' consumers'
    // graph, so the entry registers it — mirror that registration here.
    const off = onThemeApplied(broadcastTheme);
    const frame = document.createElement("iframe");
    frame.className = "view-frame";
    document.body.appendChild(frame);
    const received: { source?: string; type?: string; mode?: string; tokens?: Record<string, string> }[] = [];
    frame.contentWindow!.addEventListener("message", (e: MessageEvent) => received.push(e.data));
    try {
      remoteWrite(LS_THEME, "light");
      await new Promise((r) => setTimeout(r, 0)); // postMessage delivery is a queued task
      const msg = received.find((d) => d?.source === "vh-solara" && d?.type === "theme");
      expect(msg).toBeTruthy();
      expect(msg!.mode).toBe("light"); // theme-light-scoped was re-applied first
      // Every published --vh-* token key is present (jsdom resolves no custom
      // props, so values are "" — presence + mode are the contract here).
      for (const t of THEME_TOKENS) expect(msg!.tokens).toHaveProperty(t.token);
    } finally {
      off();
      frame.remove();
    }
  });
});

describe("theme frozen-tab visibility catch-up", () => {
  it("re-runs the storage path on visibilitychange → visible after a missed write", () => {
    localStorage.clear();
    setThemeId("dark");
    // Another document writes while this tab is FROZEN — the `storage` event
    // never ran here, so the in-memory signal is stale but localStorage (shared
    // same-origin) already holds the new value.
    localStorage.setItem(LS_THEME, JSON.stringify({ v: 1, data: "dracula" }));
    expect(theme()).toBe("dark");

    forceVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(theme()).toBe("dracula");
    expect(document.documentElement.classList.contains("theme-dracula")).toBe(true);
  });

  it("catches up a missed custom-fields write (custom theme active)", () => {
    localStorage.clear();
    setCustomTheme({ bg: "#101010" });
    setThemeId("custom");
    localStorage.setItem(LS_CUSTOM, JSON.stringify({ v: 1, data: { ...customTheme(), bg: "#303030" } }));

    forceVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(customTheme().bg).toBe("#303030");
    expect(document.documentElement.style.getPropertyValue("--bg").trim()).toBe("#303030");
  });

  it("ignores visibilitychange while still hidden", () => {
    localStorage.clear();
    setThemeId("dark");
    localStorage.setItem(LS_THEME, JSON.stringify({ v: 1, data: "nord" }));

    forceVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(theme()).toBe("dark"); // no catch-up until the tab is actually visible
  });

  it("is idempotent when nothing was missed", () => {
    localStorage.clear();
    setThemeId("nord");
    forceVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(theme()).toBe("nord");
    expect(document.documentElement.classList.contains("theme-nord")).toBe(true);
    expect(document.documentElement.classList.contains("theme-dark")).toBe(false);
  });
});
