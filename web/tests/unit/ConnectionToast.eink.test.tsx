// @vitest-environment jsdom
// jsdom lacks matchMedia (Part.tsx → code/frame calls it at module load) —
// import the shared stub BEFORE any component import evaluates.
import "./_matchMedia";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionToast from "../../src/components/ConnectionToast";
import { einkProfile, setEinkProfile } from "../../src/prefs";
import { connGrade, installTunnelSampler, state } from "../../src/sync";
import { setState } from "../../src/sync/store";
import { _resetWeakLinkForTest, recordFetchFailure } from "../../src/sync/weaklink";

// E-ink display profile (UX Slice 4 — quiet UI): the ConnectionToast's
// profile-scoped persistence contract, at the component seam with FAKE TIMERS.
// The component reads the REAL graded reduction (connGrade) and the REAL
// epoch latch (state.epochChanged) — both driven through the real sync store
// (status writes are plain reactive store writes; nothing here touches the
// network: no startSync, no EventSource).
//
// Contract under test:
//   OFF (default): unchanged pre-profile behavior — the restart warn
//     auto-hides at 4s, the "Reconnected" ok auto-hides at 2.5s, and NO
//     dismiss affordance renders.
//   ON: important notices (disconnect warn, restart warn) PERSIST (no
//     auto-expiry is armed); the recovery ok coalesces into a stable status
//     (persists too); an ON-only dismiss button clears the current notice.
//   Resolution: the warn is superseded by the recovery ok when the grade
//     returns to live (the existing lifecycle, unchanged).

function toastEl(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="status"]');
}

async function mount() {
  const r = render(() => <ConnectionToast />);
  // Flush Solid's effect queue so the mount-time effect (grade read) settles
  // before the test drives transitions.
  await vi.advanceTimersByTimeAsync(0);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Quiet baseline: a live, converged store (fresh store boots "connecting",
  // which legitimately grades as "reconnecting" and would arm the 1200ms
  // debounce on its own). treeLastSeen is 0 → isStale() false; no cascade;
  // no fetch failures → the live grade holds.
  setState("status", "live");
  setState("epochChanged", false);
});

afterEach(() => {
  cleanup();
  setEinkProfile(false);
  localStorage.clear();
  vi.useRealTimers();
});

describe("ConnectionToast — e-ink profile OFF (baseline unchanged)", () => {
  // The degraded-dip test below racks weaklink fetch-failure counters (module
  // singletons) and consumes the tunnel sampler's install latch. Reset both so
  // the spike cannot leak into later tests in this file (silently re-grading
  // their stores to "degraded") and a future sampler-dependent test cannot
  // silently no-op — the connstatus.test.ts delete-latch pattern.
  afterEach(() => {
    _resetWeakLinkForTest();
    delete (globalThis as { __vhTunnelSampled?: boolean }).__vhTunnelSampled;
  });

  it("auto-expires the restart warn at 4s and renders no dismiss button", async () => {
    const { container } = await mount();
    expect(einkProfile()).toBe(false);

    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    let el = toastEl(container);
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("vh-solara restarted");
    expect(el!.querySelector('button[aria-label="Dismiss notice"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(3999);
    expect(toastEl(container)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)).toBeNull(); // auto-hidden at exactly 4s
    expect(state.epochChanged).toBe(false); // the latch was consumed
  });

  it("shows the reconnect warn after the 1200ms debounce; recovery ok auto-expires at 2.5s", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1199);
    expect(toastEl(container)).toBeNull(); // debounce not elapsed
    await vi.advanceTimersByTimeAsync(1);
    const warn = toastEl(container);
    expect(warn).not.toBeNull();
    expect(warn!.textContent).toContain("Connection lost");

    // Resolution: back to live → the ok replaces the warn…
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    const ok = toastEl(container);
    expect(ok).not.toBeNull();
    expect(ok!.textContent).toContain("Reconnected");
    expect(ok!.querySelector('button[aria-label="Dismiss notice"]')).toBeNull();
    // …and auto-expires 2.5s later (the pre-profile transient).
    await vi.advanceTimersByTimeAsync(2499);
    expect(toastEl(container)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)).toBeNull();
  });

  // Field flake 2026-10-25 (pins-verdict run 3, web e2e preferences.spec.ts:387
  // "E Ink OFF: notices stay transient"): under load the recovery ok got
  // ORPHANED on screen — a live → degraded dip (FE fetch-failure spike) inside
  // the ok's 2.5s expiry window cleared the pending auto-hide timer while
  // matching no toast branch, so "Reconnected" stayed up past every assertion
  // window (the e2e toHaveCount(0) failed 14× with the status icon showing
  // "degraded — recent network errors"). The ok is a TRANSIENT under OFF: its
  // expiry must survive a silent degraded dip.
  it("OFF: the recovery ok still auto-expires when the grade dips to degraded mid-window", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");

    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected");

    // 500ms into the ok's 2.5s window: ≥2 FE-vantage fetch failures land
    // (route-aborted /vh/ fetches classify as "network" — the deliberate-
    // abort exclusion covers real AbortError only)…
    await vi.advanceTimersByTimeAsync(500);
    recordFetchFailure("network");
    recordFetchFailure("network");
    // …and the next connMemo evaluation re-grades live → degraded. In the
    // real app that re-run rides the ~5s health tick or any store write; the
    // tunnel sampler's documented reactive carrier (X-VH-Tunnel-State read
    // off a /vh/ fetch) drives it here deterministically.
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve({
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === "x-vh-tunnel-state" ? "connected" : null) },
      } as unknown as Response)) as typeof fetch;
    installTunnelSampler();
    await globalThis.fetch("/vh/unit-tunnel-probe");
    (globalThis as { fetch: typeof fetch }).fetch = origFetch;

    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the dip is real, not vacuous
    // The dip neither replaced nor cleared the ok…
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    // …and it still EXPIRES on schedule (2.5s from fire; 2s remain).
    await vi.advanceTimersByTimeAsync(1999);
    expect(toastEl(container)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)).toBeNull();
  });
});

describe("ConnectionToast — e-ink profile ON (quiet UI: persistent notices)", () => {
  beforeEach(() => {
    setEinkProfile(true);
  });

  it("the disconnect warn persists well past every OFF expiry window until resolved", async () => {
    const { container } = await mount();
    expect(einkProfile()).toBe(true);

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    const warn = toastEl(container);
    expect(warn).not.toBeNull();
    expect(warn!.textContent).toContain("Connection lost");

    // >5s of visibility while unresolved (OFF's largest window is 4s; the
    // warn must NOT vanish — no auto-expiry is armed under ON).
    await vi.advanceTimersByTimeAsync(10_000);
    const still = toastEl(container);
    expect(still).not.toBeNull();
    expect(still!.textContent).toContain("Connection lost");

    // Resolution replaces it with the recovery ok (existing lifecycle).
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    const ok = toastEl(container);
    expect(ok).not.toBeNull();
    expect(ok!.textContent).toContain("Reconnected");
  });

  it("the restart warn persists past the OFF 4s auto-hide", async () => {
    const { container } = await mount();

    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    await vi.advanceTimersByTimeAsync(6_000);
    const still = toastEl(container);
    expect(still).not.toBeNull(); // OFF would have hidden at 4s
    expect(still!.textContent).toContain("vh-solara restarted");
  });

  // D1 (commit-review): the toast must keep REACTING after an epoch event —
  // the effect's dependency set survives the self-scheduled no-op re-run
  // (the reads are hoisted above the epochSelfReentry guard precisely so a
  // zero-read run can never orphan the effect). Same mounted component.
  it("after an epoch event, later grade transitions still drive toasts (both profiles)", async () => {
    const { container } = await mount();

    // Epoch first (its consume-write is what schedules the no-op re-run).
    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");

    // Still under ON: a LATER drop must warn (the effect is not dead)…
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1300);
    expect(toastEl(container)?.textContent).toContain("Connection lost");
    // …and its resolution must replace it with the persistent recovery ok.
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected");

    // OFF too (the guard is profile-independent; so is the fix): a second
    // epoch arms the restart notice, it expires at 4s, and a subsequent
    // drop still warns.
    setEinkProfile(false);
    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    await vi.advanceTimersByTimeAsync(4000);
    expect(toastEl(container)).toBeNull();
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1300);
    expect(toastEl(container)?.textContent).toContain("Connection lost");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    await vi.advanceTimersByTimeAsync(2500);
    expect(toastEl(container)).toBeNull(); // OFF auto-expiry intact post-epoch
  });

  it("the recovery ok coalesces into a stable status (no 2.5s flash)", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");

    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    // 8s later the stable status is STILL there (readable on a slow panel).
    await vi.advanceTimersByTimeAsync(8_000);
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    // No pile-up: exactly one toast surface exists.
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
  });

  it("dismisses via the ON-only button; a dismissed warn stays gone while the grade holds", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    const btn = toastEl(container)!.querySelector('button[aria-label="Dismiss notice"]');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();

    // The condition still holds (grade unchanged → the effect never re-fires;
    // connGrade is string-deduped), so the dismissal holds.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(toastEl(container)).toBeNull();

    // A NEW grade transition legitimately re-surfaces notices: the recovery
    // ok (the warn HAD fired — `warned` recorded the drop)…
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    // …which is itself dismissable under ON.
    fireEvent.click(toastEl(container)!.querySelector('button[aria-label="Dismiss notice"]')!);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();

    // …and a fresh drop warns again. (The store's status vocabulary has no
    // "offline" — that grade comes from the navigator signal, not the store;
    // a status write of "reconnecting" is the driveable drop shape here.)
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");
  });
});
