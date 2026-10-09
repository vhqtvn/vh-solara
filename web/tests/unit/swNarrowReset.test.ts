// @vitest-environment node
//
// swNarrow registerPromise RESET pins (B10 — closes S3b committer-gate DEFER
// c-F3: the memoized narrow-registration promise never reset).
//
// Pins the state machine of host-web/src/swNarrow.ts:
//   (a) a FAILED register() attempt does not stay memoized — a later caller
//       retries and succeeds (transient failure: dev host briefly lacking
//       /sw.js, network hiccup, insecure context);
//   (b) unregisterNarrow() drops the memo — a subsequent
//       ensureNarrowRegistration() performs a FRESH register() (the surgical
//       rollback can be followed by re-registration in the same document);
//   (c) SUCCESS memoization is PRESERVED — N concurrent callers while
//       register() is in flight produce exactly ONE register() call (the
//       memoization's original purpose);
//   (d) paneSrcGate stays fail-open AND memoized after a failed registration
//       — the deliberate asymmetry (register retried, gate not re-armed: a
//       re-armed gate could repeatedly delay pane boot).
//
// Placement: host-web has NO vitest lane — web/tests/unit is the repo's
// unit lane and already covers host-web source (themeCatalogParity.test.ts,
// hostWebCrossTreeImport.guard.test.ts). The web/tests/unit → host-web/src
// import direction is the unguarded one (the B9 guard scans host-web → web/
// only). Node env is sufficient: swNarrow reads `navigator` lazily inside
// function bodies (never at module scope), and none of these cases reach
// establishFocusChannel's `window`/MessageChannel path — a stubbed
// globalThis.navigator is the whole seam. Each test does vi.resetModules() +
// dynamic import so the module-singleton state (registerPromise, gatePromise,
// heldReg, focusPort) starts clean.
import { afterEach, describe, expect, it, vi } from "vitest";

/** Minimal registration stub: watchActivations only addEventListener's. */
function fakeReg(): ServiceWorkerRegistration {
  return {
    addEventListener: vi.fn(),
    unregister: vi.fn(async () => true),
  } as unknown as ServiceWorkerRegistration;
}

/** Fresh swNarrow module (fresh registerPromise/gatePromise/heldReg). */
function loadSwNarrow() {
  vi.resetModules();
  return import("../../../host-web/src/swNarrow");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("swNarrow registerPromise reset (B10 / S3b c-F3)", () => {
  it("(a) a failed register() does not stay memoized — a later call retries and succeeds", async () => {
    let fail = true;
    const good = fakeReg();
    const register = vi.fn(async (url: string, opts: { scope: string }) => {
      if (fail) throw new Error("transient: no /sw.js yet");
      return good;
    });
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    const sw = await loadSwNarrow();

    const first = await sw.ensureNarrowRegistration();
    expect(first).toBeNull(); // never-rejects contract: null, not a throw
    expect(sw.narrowRegistration()).toBeNull();

    fail = false; // the transient condition clears (dev server now serves /sw.js)
    const second = await sw.ensureNarrowRegistration();
    expect(second).toBe(good);
    expect(sw.narrowRegistration()).toBe(good);
    expect(register).toHaveBeenCalledTimes(2); // the failure was NOT served from memo
    expect(register).toHaveBeenNthCalledWith(1, "/sw.js", { scope: "/app" });
    expect(register).toHaveBeenNthCalledWith(2, "/sw.js", { scope: "/app" });
  });

  it("(b) unregisterNarrow() drops the memo — a subsequent ensure re-registers fresh", async () => {
    const regA = fakeReg();
    const regB = fakeReg();
    const register = vi.fn().mockResolvedValueOnce(regA).mockResolvedValueOnce(regB);
    vi.stubGlobal("navigator", {
      serviceWorker: { register, getRegistration: vi.fn(async () => undefined) },
    });
    const sw = await loadSwNarrow();

    const first = await sw.ensureNarrowRegistration();
    expect(first).toBe(regA);
    expect(sw.narrowRegistration()).toBe(regA);

    const unregistered = await sw.unregisterNarrow();
    expect(unregistered).toBe(true);
    expect(regA.unregister).toHaveBeenCalledTimes(1);
    expect(sw.narrowRegistration()).toBeNull();

    const second = await sw.ensureNarrowRegistration();
    expect(second).toBe(regB); // FRESH register(), not the stale memoized promise
    expect(register).toHaveBeenCalledTimes(2);
    expect(sw.narrowRegistration()).toBe(regB);
  });

  it("(c) concurrent callers while register() is in flight share ONE attempt (success memo preserved)", async () => {
    const reg = fakeReg();
    let release!: (r: ServiceWorkerRegistration) => void;
    const pending = new Promise<ServiceWorkerRegistration>((resolve) => {
      release = resolve;
    });
    const register = vi.fn(() => pending);
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    const sw = await loadSwNarrow();

    const five = Promise.all(
      Array.from({ length: 5 }, () => sw.ensureNarrowRegistration()),
    );
    // The async body's sync prefix calls register() before its first await,
    // so the count is exact already — callers 2–5 got the memo synchronously.
    expect(register).toHaveBeenCalledTimes(1);

    release(reg);
    const results = await five;
    expect(results.every((r) => r === reg)).toBe(true);

    // Post-success callers keep hitting the memo — still exactly one attempt.
    const later = await sw.ensureNarrowRegistration();
    expect(later).toBe(reg);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("(d) paneSrcGate stays fail-open and memoized after a failed registration (gate NOT re-armed)", async () => {
    vi.useFakeTimers(); // the 2s fail-open budget would otherwise linger as a real timer
    try {
      const register = vi.fn(async () => {
        throw new Error("no sw support here");
      });
      vi.stubGlobal("navigator", { serviceWorker: { register } });
      const sw = await loadSwNarrow();

      const gate = sw.paneSrcGate();
      await expect(gate).resolves.toBeUndefined(); // fail-open despite the failure

      // The gate memo is NOT re-armed on failure (deliberate asymmetry vs
      // ensureNarrowRegistration's retry): second call returns the SAME
      // promise, and the gate never triggers a second register() attempt.
      const again = sw.paneSrcGate();
      expect(again).toBe(gate);
      expect(register).toHaveBeenCalledTimes(1);
      expect(sw.narrowRegistration()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
