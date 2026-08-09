// @vitest-environment jsdom
// Cross-document settings sync for persistedSignal.
//
// Each host pane is a separate iframe document; each browser tab is a separate
// document. persistedSignal hydrates from localStorage at boot into an in-memory
// signal and writes on set, but the `storage` event is the ONLY browser channel
// that notifies OTHER documents on the same origin that a key changed. Without a
// listener, a setting changed in one document (e.g. uiScale in one host pane /
// tab) never propagates live to the others — they see it only after a reload
// (the reported bug #2: "settings in a window wont be sent to others, need to
// reload page").
//
// This test simulates another document writing by directly setting localStorage
// and dispatching a `storage` event on window (the real browser fires `storage`
// ONLY in other documents, never in the writer; dispatching it manually on THIS
// window models the receiving document's view). The signal MUST update live.
import { describe, expect, it } from "vitest";
import { persistedSignal } from "../../src/lib/store";

function fireStorage(key: string | null, newValue: string | null): void {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

describe("persistedSignal cross-document storage sync", () => {
  it("updates the in-memory signal when another document writes the key", () => {
    localStorage.clear();
    const [val, set] = persistedSignal<number>("vh.prefs.test.k1", 1, 1);
    expect(val()).toBe(1);

    // Change locally (same document): already reflected via the setter.
    set(2);
    expect(val()).toBe(2);

    // Another document writes the key. localStorage is shared same-origin, so
    // our localStorage now reflects the new value too; the `storage` event is
    // what tells us to re-read it into our in-memory signal.
    const enveloped = JSON.stringify({ v: 1, data: 42 });
    localStorage.setItem("vh.prefs.test.k1", enveloped);
    fireStorage("vh.prefs.test.k1", enveloped);

    // The crux: the signal reflects the other document's write WITHOUT a reload.
    expect(val()).toBe(42);
  });

  it("ignores storage events for other keys", () => {
    localStorage.clear();
    const [val] = persistedSignal<number>("vh.prefs.test.k2", 1, 7);
    expect(val()).toBe(7);
    localStorage.setItem("vh.prefs.unrelated", JSON.stringify({ v: 1, data: 99 }));
    fireStorage("vh.prefs.unrelated", JSON.stringify({ v: 1, data: 99 }));
    expect(val()).toBe(7); // unchanged
  });

  it("falls back cleanly on a foreign/garbage payload (no throw, no change)", () => {
    localStorage.clear();
    const [val] = persistedSignal<number>("vh.prefs.test.k3", 1, 5);
    expect(val()).toBe(5);
    localStorage.setItem("vh.prefs.test.k3", "not-json");
    fireStorage("vh.prefs.test.k3", "not-json");
    expect(val()).toBe(5); // parse fails → fallback, signal unchanged from view
  });

  it("does not re-write to storage when reacting to a storage event (no echo)", () => {
    localStorage.clear();
    const [val] = persistedSignal<number>("vh.prefs.test.k4", 1, 1);
    const before = localStorage.getItem("vh.prefs.test.k4");
    const enveloped = JSON.stringify({ v: 1, data: 8 });
    localStorage.setItem("vh.prefs.test.k4", enveloped);
    fireStorage("vh.prefs.test.k4", enveloped);
    expect(val()).toBe(8);
    // The reaction must use the raw setter, not the persisting setter, so the
    // stored value is exactly what the other document wrote (no re-serialization).
    expect(localStorage.getItem("vh.prefs.test.k4")).toBe(before === null ? enveloped : before);
    expect(localStorage.getItem("vh.prefs.test.k4")).toBe(enveloped);
  });
});
