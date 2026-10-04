// @vitest-environment jsdom
// Cross-document FONT sync (the same gap commit c8a7eb1c fixed for themes:
// change the font in one tab / host pane and the others keep the old font
// until reload).
//
// persistedSignal-storage-sync.test.ts covers the generic mechanism; this file
// covers the FONT layer on top of it: the imperative apply (CSS vars on <html>
// + the on-demand webfont <link>) must re-run on the `storage` path for
// vh.font.v1, vh.font.custom.v1 and vh.font.mono.v1 — with the custom-family
// apply guarded to "custom is the active font", mirroring the theme
// custom-fields guard — and the visibilitychange catch-up must recover a
// write a frozen tab never saw.
//
// Same simulation model as the theme tests: another same-origin document
// writes the shared localStorage and the browser fires `storage` in THIS
// document — we set localStorage directly and dispatch the event.
import { afterEach, describe, expect, it } from "vitest";
import { customFont, font, monoFont, setCustomFont, setFontId, setMonoFontId } from "../../src/font";

const LS_FONT = "vh.font.v1";
const LS_CUSTOM = "vh.font.custom.v1";
const LS_MONO = "vh.font.mono.v1";

const SYS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

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

function fontUi(): string {
  return document.documentElement.style.getPropertyValue("--font-ui").trim();
}
function fontMono(): string {
  return document.documentElement.style.getPropertyValue("--font-mono").trim();
}

describe("font cross-document storage sync", () => {
  it("re-applies a UI font another document wrote, without a reload", () => {
    localStorage.clear();
    setFontId("system");
    expect(fontUi()).toBe(SYS);

    remoteWrite(LS_FONT, "inter");
    expect(font()).toBe("inter");
    expect(fontUi()).toBe(`"Inter", ${SYS}`);
    // The on-demand webfont <link> is injected on the remote path too.
    expect(document.head.querySelector('link[href*="family=Inter"]')).toBeTruthy();
  });

  it("re-applies a mono font another document wrote, without a reload", () => {
    localStorage.clear();
    setMonoFontId("system-mono");
    remoteWrite(LS_MONO, "fira-code");
    expect(monoFont()).toBe("fira-code");
    expect(fontMono()).toContain('"Fira Code"');
  });

  it("a remote custom family re-applies live while the custom font is active", () => {
    localStorage.clear();
    setCustomFont("MyLocal");
    setFontId("custom");
    expect(fontUi()).toBe(`"MyLocal", ${SYS}`);

    remoteWrite(LS_CUSTOM, "OtherFont");
    expect(customFont()).toBe("OtherFont");
    expect(fontUi()).toBe(`"OtherFont", ${SYS}`);
  });

  it("a remote custom family updates the signal but does NOT stomp a non-custom font", () => {
    localStorage.clear();
    setFontId("inter");
    remoteWrite(LS_CUSTOM, "MyLocal");
    expect(customFont()).toBe("MyLocal"); // signal follows the shared value…
    expect(fontUi()).toBe(`"Inter", ${SYS}`); // …but the applied font is untouched
  });

  it("a legacy BARE (non-JSON) remote value migrates through the same path as boot", () => {
    localStorage.clear();
    setFontId("system");
    localStorage.setItem(LS_FONT, "geist"); // legacy unversioned spelling
    fireStorage(LS_FONT);
    expect(font()).toBe("geist");
    expect(fontUi()).toBe(`"Geist", ${SYS}`);
  });
});

describe("font frozen-tab visibility catch-up", () => {
  it("re-runs the storage path on visibilitychange → visible after a missed UI-font write", () => {
    localStorage.clear();
    setFontId("system");
    // Another document writes while this tab is FROZEN — the `storage` event
    // never ran here, so the in-memory signal is stale but localStorage (shared
    // same-origin) already holds the new value.
    localStorage.setItem(LS_FONT, JSON.stringify({ v: 1, data: "plex" }));
    expect(font()).toBe("system");

    forceVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(font()).toBe("plex");
    expect(fontUi()).toBe(`"IBM Plex Sans", ${SYS}`);
  });

  it("catches up a missed mono write and a missed custom write (custom active)", () => {
    localStorage.clear();
    setCustomFont("FirstFont");
    setFontId("custom");
    localStorage.setItem(LS_MONO, JSON.stringify({ v: 1, data: "victor-mono" }));
    localStorage.setItem(LS_CUSTOM, JSON.stringify({ v: 1, data: "SecondFont" }));

    forceVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(monoFont()).toBe("victor-mono");
    expect(fontMono()).toContain('"Victor Mono"');
    expect(customFont()).toBe("SecondFont");
    expect(fontUi()).toBe(`"SecondFont", ${SYS}`);
  });

  it("ignores visibilitychange while still hidden", () => {
    localStorage.clear();
    setFontId("system");
    localStorage.setItem(LS_FONT, JSON.stringify({ v: 1, data: "geist" }));

    forceVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(font()).toBe("system"); // no catch-up until the tab is actually visible
  });

  it("is idempotent when nothing was missed", () => {
    localStorage.clear();
    setFontId("inter");
    forceVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(font()).toBe("inter");
    expect(fontUi()).toBe(`"Inter", ${SYS}`);
  });
});
