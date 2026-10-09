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
//   (e) unregisterNarrow() DURING an in-flight ensureNarrowRegistration(),
//       register settles SUCCESS: heldReg is re-populated by the settling
//       IIFE, registerPromise stays null (the rollback clear wins; the
//       success path does not re-memo) so the next ensure re-registers
//       FRESH (engine-deduplicated in reality) — the b-F1 ordering pin;
//   (f) the harsher variant where getRegistration() surfaces the nascent
//       registration (the spec creates the registration record during
//       install, before register() resolves): unregister() unregisters the
//       very registration the in-flight register() then resolves with, and
//       the settling IIFE STILL re-populates heldReg with it — the
//       B10-review-documented bounded advisory (zero consumers of
//       narrowRegistration() at HEAD; recovery is the next ensure);
//   (g) the same interleave with register() REJECTING: the caller resolves
//       null (never-rejects preserved through the race), heldReg stays
//       null, and the memo stays clear so the next call retries;
//   (h) N concurrent callers while register() REJECTS share exactly ONE
//       attempt and all resolve null; the (N+1)th caller retries and
//       succeeds (folded B10 c-F2 advisory pin — (a) covers the sequential
//       single-caller fail→retry, (c) covers concurrent SUCCESS; neither
//       covers concurrent FAILURE).
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

// B10 stage-1 review b-F1 defer: no test exercised unregisterNarrow() DURING
// an in-flight ensureNarrowRegistration(). The interleaving (traced by review
// leaves a-F1/c-F1/d-F1, all dispositioned advisory): unregisterNarrow()
// clears heldReg/focusPort/gatePromise/registerPromise and calls
// reg.unregister() while the IIFE registration is pending; the settling IIFE
// then re-sets heldReg on success — possibly a registration unregister() just
// unregistered — and the .then wrapper leaves registerPromise null (the
// rollback clear wins; success does not re-memo). These tests PIN that
// intended state; no product change needed.
describe("swNarrow unregister during in-flight registration (B10 review b-F1)", () => {
  it("(e) unregister during in-flight ensure, register settles SUCCESS: heldReg re-populated, memo stays null, next ensure re-registers", async () => {
    const regS = fakeReg();
    const regB = fakeReg();
    let release!: (r: ServiceWorkerRegistration) => void;
    const pending = new Promise<ServiceWorkerRegistration>((resolve) => {
      release = resolve;
    });
    const register = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockImplementationOnce(async () => regB);
    // Realistic engine seam while register() is unsettled: nothing visible
    // to getRegistration() yet in this variant — the rollback finds no reg.
    const getRegistration = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { serviceWorker: { register, getRegistration } });
    const sw = await loadSwNarrow();

    const first = sw.ensureNarrowRegistration();
    // register() call #1 is now in flight (IIFE parked on `pending`).

    const unregistered = await sw.unregisterNarrow(); // DURING the flight
    expect(unregistered).toBe(false); // nothing to unregister yet
    expect(getRegistration).toHaveBeenCalledWith("/app"); // heldReg was null → engine fallback taken
    expect(sw.narrowRegistration()).toBeNull(); // heldReg never set in this interleave

    release(regS); // the in-flight register() settles SUCCESS after the rollback
    await expect(first).resolves.toBe(regS); // never-rejects preserved through the race

    // Intended post-race state: the settling IIFE re-populates heldReg…
    expect(sw.narrowRegistration()).toBe(regS);

    // …but registerPromise stays null (rollback clear wins; success path does
    // not re-memo), so the next ensure performs a FRESH register() —
    // engine-deduplicated in reality, a distinct call at this seam.
    const second = await sw.ensureNarrowRegistration();
    expect(second).toBe(regB);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenNthCalledWith(1, "/sw.js", { scope: "/app" });
    expect(register).toHaveBeenNthCalledWith(2, "/sw.js", { scope: "/app" });
    expect(sw.narrowRegistration()).toBe(regB);
  });

  it("(f) getRegistration surfacing the in-flight registration: heldReg ends re-populated with the UNREGISTERED reg — the documented bounded advisory", async () => {
    const regS = fakeReg();
    const regB = fakeReg();
    let release!: (r: ServiceWorkerRegistration) => void;
    const pending = new Promise<ServiceWorkerRegistration>((resolve) => {
      release = resolve;
    });
    const register = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockImplementationOnce(async () => regB);
    // The spec creates the registration record during install, BEFORE
    // register() resolves — so getRegistration() can surface the very
    // registration the in-flight register() will hand back. This is the
    // exact a-F1/c-F1/d-F1 traced shape, not a synthetic one.
    const getRegistration = vi.fn(async () => regS);
    vi.stubGlobal("navigator", { serviceWorker: { register, getRegistration } });
    const sw = await loadSwNarrow();

    const first = sw.ensureNarrowRegistration();
    const unregistered = await sw.unregisterNarrow(); // DURING the flight
    expect(unregistered).toBe(true);
    expect(regS.unregister).toHaveBeenCalledTimes(1); // the rollback DID unregister it

    release(regS);
    await expect(first).resolves.toBe(regS);

    // The documented bounded advisory, pinned honestly: the settling IIFE
    // re-populates heldReg AFTER the rollback, leaving narrowRegistration()
    // pointing at a registration whose unregister() already ran. Benign at
    // HEAD (zero consumers of narrowRegistration(); engine-deduplicated
    // register()), and the recovery below re-establishes a live heldReg.
    expect(sw.narrowRegistration()).toBe(regS);

    const second = await sw.ensureNarrowRegistration();
    expect(second).toBe(regB);
    expect(register).toHaveBeenCalledTimes(2);
    expect(sw.narrowRegistration()).toBe(regB);
  });

  it("(g) same interleave with register() REJECTING: resolves null (never-rejects), heldReg stays null, next call retries", async () => {
    const regB = fakeReg();
    let rejectPending!: (err: unknown) => void;
    const pending = new Promise<ServiceWorkerRegistration>((_, reject) => {
      rejectPending = reject;
    });
    const register = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockImplementationOnce(async () => regB);
    const getRegistration = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { serviceWorker: { register, getRegistration } });
    const sw = await loadSwNarrow();

    const first = sw.ensureNarrowRegistration();
    await sw.unregisterNarrow(); // DURING the flight

    rejectPending(new Error("register aborted mid-flight"));
    await expect(first).resolves.toBeNull(); // never-rejects through the race
    expect(sw.narrowRegistration()).toBeNull(); // the settling IIFE's failure path never sets heldReg

    const second = await sw.ensureNarrowRegistration();
    expect(second).toBe(regB);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("(h) concurrent callers while register() REJECTS share ONE attempt; the (N+1)th call retries (c-F2 pin)", async () => {
    const regB = fakeReg();
    const register = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("transient failure");
      })
      .mockImplementationOnce(async () => regB);
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    const sw = await loadSwNarrow();

    const five = Promise.all(
      Array.from({ length: 5 }, () => sw.ensureNarrowRegistration()),
    );
    const results = await five;
    expect(results.every((r) => r === null)).toBe(true); // shared failure, never a rejection
    expect(register).toHaveBeenCalledTimes(1); // N callers, ONE failed attempt

    const next = await sw.ensureNarrowRegistration();
    expect(next).toBe(regB); // the memo cleared → the (N+1)th call retries
    expect(register).toHaveBeenCalledTimes(2);
  });
});
