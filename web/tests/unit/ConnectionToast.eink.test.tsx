// @vitest-environment jsdom
// jsdom lacks matchMedia (Part.tsx → code/frame calls it at module load) —
// import the shared stub BEFORE any component import evaluates.
import "./_matchMedia";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionToast from "../../src/components/ConnectionToast";
import { einkProfile, setEinkProfile } from "../../src/prefs";
import { connGrade, initConnStatus, installTunnelSampler, state } from "../../src/sync";
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
//   returns to live (the existing lifecycle, unchanged).
//
// ── Open-cell ledger (2026-10-26 connection-toast lattice study @ e6f9a7e) ──
// Cells the study adjudicated DOCUMENTED-NOT-FIXED. This block replaces the
// backlog card the study suggested: do not "fix" any of these without
// re-adjudication (each line carries the study's adjudication).
//   2b   ON early-removal deviation: degraded→live with warned=false removes
//        the "stable" recovery ok immediately (the live branch's
//        setToast(null)) vs the documented persist-until-dismissed contract
//        (ConnectionToast.tsx:36–38) — pinned AS-IS in the Part B cells
//        below; changing it is a behavior decision, not a defect fix.
//   7    reconnect↔offline flapping under 1200ms suppresses warns
//        indefinitely (each flip re-arms the debounce before it fires) —
//        arguably by design: a flapping link never persists long enough to
//        be worth a warn.
//   13   profile flip while live clears the toast (the profile signal read
//        re-runs the effect into the live/warned=false branch → null).
//   14   an OFF-armed 2.5s/4s expiry finishing after a flip to ON still
//        fires — the arming was legitimate under OFF when made.
//   15   ON→OFF mid-dip orphan (the profile-flip cluster's third member) —
//        no field harm observed; revisit only with a repro.
//   18   an epoch event during a pending disconnect debounce suppresses the
//        disconnect warn (the epoch branch clears the debounce and replaces
//        the toast with the restart warn) — the restart notice is the more
//        important signal; adjudicated acceptable. PINNED by the T1A-F1 test
//        below (2026-10-26 obligations pass), which also proves the epoch
//        run's cancellation leaves NO stale showArmed: a later degraded dip
//        does not spuriously clear the restart warn (e6f9a7e path holds).
//   A-F4′ (2026-10-26 obligations pass) the A-F4 clear's WARN-side variant:
//        a standing warn (its debounce already fired) whose replacement
//        debounce a degraded landing cancels is CLEARED. Adjudicated HONEST,
//        pinned both profiles below: degraded requires store status "live"
//        (connstatus.ts rule 4 — the socket is OPEN), so "Connection lost"
//        is counterfactual at the landing, and `warned` surviving guarantees
//        the documented live→ok resolution still fires. The ON contract's
//        letter (persist until RESOLVED≡live or DISMISSED) is in tension
//        with this; re-open ONLY as a product decision, not a defect fix.
//        → RE-ADJUDICATED 2026-10-29 (card
//        task-2026-10-29t06-06-05-pwa-toast-grading-amplifiers-and-grade-stamps):
//        that product decision landed as A-F5 — the clear was extended from
//        "cancelled a pending debounce" to "a standing FIRED warn too" (the
//        capture-1 §Q4 "degraded-orphaned warn": a warn that outlived full
//        stream reconvergence by up to the 30s fetch-spike window / a >45s
//        tree-stale dip). The Part B warned=true cells + T1C-F1 cells below
//        now pin the A-F5 contract; `warned` still survives every clear, so
//        the live→ok resolution ack is preserved (each test's tail pins it).

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

// Part B helper: a deterministic connMemo re-evaluation carrier. Installs
// (idempotently) the tunnel sampler over a stubbed fetch whose /vh/ responses
// carry X-VH-Tunnel-State: connected — the documented reactive carrier (the
// same drive shape as the degraded-dip test above). Probe as many times as
// needed; the wrapper must STAY installed between probes (restoring fetch
// would discard it while the latch still claims installed). RESTORE OWNERSHIP
// LIVES IN afterEach (2026-10-26 obligations pass, dropped advisory): every
// install pushes its restore closure onto fetchRestores, drained by the
// top-level afterEach even when a test fails mid-flight — an assertion
// failure between install and restore can no longer leak the stub (and the
// spent install latch) into later tests. Tests therefore never call restore
// themselves; the describes' afterEach deletes the latch and resets the
// weaklink counters between tests.
const fetchRestores: Array<() => void> = [];
function tunnelCarrier(): { probe: () => Promise<void> } {
  const g = globalThis as { fetch: typeof fetch; __vhTunnelSampled?: boolean };
  if (!g.__vhTunnelSampled) {
    const orig = g.fetch;
    g.fetch = (() =>
      Promise.resolve({
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === "x-vh-tunnel-state" ? "connected" : null) },
      } as unknown as Response)) as typeof fetch;
    installTunnelSampler();
    fetchRestores.push(() => {
      g.fetch = orig;
    });
  }
  // Latch leak (a prior test skipped its restore — belt-and-braces: with
  // afterEach-owned restores this branch should be unreachable). Probe with
  // whatever fetch is present — if it doesn't carry the header this fails
  // loudly here, it never silently passes.
  return {
    probe: () => g.fetch("/vh/unit-tunnel-probe").then(() => undefined),
  };
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
  // Drain any fetch stubs tunnelCarrier() installed — restore ownership
  // lives HERE (not on a test's green path), so an assertion failure between
  // install and restore cannot leak the stub across tests. Runs AFTER the
  // describes' latch-deleting afterEach hooks (innermost-first), which is
  // fine: nothing probes fetch between the hooks.
  for (const restore of fetchRestores.splice(0)) restore();
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

  // A-F4 (2026-10-26 connection-toast lattice study, follow-up to the flake
  // fix above): clear-on-cancelled-debounce. The confirmed orphan interleaving
  // (3 transitions, byte-identical pre/post the 2026-10-25 fix): warned live →
  // the ok fires and arms the 2.5s expiry → HARD drop (the reconnecting run
  // kills the expiry and arms the 1200ms debounce; the toast still reads the
  // STALE ok) → sub-second recovery lands DEGRADED (socket reopened — status
  // "live" — but the drop racked ≥2 FE fetch failures, so the grade is
  // degraded, not live): the degraded run CANCELS the pending replacement warn
  // and fires no branch — the stale "Reconnected" sat on screen with ZERO
  // timers until the next grade transition. The fix clears the dead toast,
  // fenced to fire ONLY when a debounce was actually cancelled (degraded with
  // no pending debounce is the 2026-10-25-protected path, pinned above).
  it("OFF: a degraded landing inside the debounce clears the stale ok (no orphan)", async () => {
    const { container } = await mount();

    // warned=true → live: the ok fires and arms the 2.5s expiry.
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected");

    // Hard drop: this run kills the expiry and arms the 1200ms debounce; the
    // toast still reads the (now stale) ok — replacement pending.
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected");

    // Sub-second recovery lands DEGRADED (failures racked during the drop
    // grade the socket-open write down to degraded — no sampler carrier
    // needed: the status write itself re-evaluates the reduction).
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the landing is real, not vacuous
    expect(toastEl(container)).toBeNull(); // RED pre-fix (the orphan) — GREEN post-fix

    // Nothing is armed to change it later: zero timers, and a long advance
    // leaves the (absent) toast untouched.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastEl(container)).toBeNull();
  });

  // ── Part B (2026-10-26 lattice study): the degraded→live seam ────────────
  // All four cells of {warned} × {profile} pinned at this fake-timer seam:
  // dip = recordFetchFailure + (status write | sampler carrier) driving the
  // grade to degraded; recovery = _resetWeakLinkForTest + one sampler probe
  // re-grading live. The two OFF cells; the ON pair is in the describe below.

  // A-F5 (2026-10-29 PWA resume card) — the orphaned-warn lifecycle fix, OFF
  // cell. Capture-1 §Q4's "degraded-orphaned warn" amplifier: a warn that
  // fired under "reconnecting" was NOT cleared by a landing on "degraded" —
  // it sat on screen with ZERO timers until the grade actually reached
  // "live", i.e. up to the 30s fetch-failure spike window (or a >45s
  // tree-stale dip) AFTER the streams had fully reconverged. degraded is
  // only reachable from status "live" + cascadePending false (the reduction
  // requires the converged socket), so the hard-down condition the warn
  // announced has GENUINELY ended at the landing. RED pre-fix (the warn
  // survived); GREEN post-fix (cleared; `warned` survives → live still acks).
  it("OFF/warned=true: a degraded landing clears the standing warn (no orphan); live still acks with the 2.5s ok", async () => {
    const { container } = await mount();

    // A warn fired before the landing (the 1200ms debounce elapsed → warned=true).
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");

    // The landing: socket reopened (status write → "live") and CONVERGED,
    // but the drop racked ≥2 FE fetch failures → the write grades degraded.
    // The debounce already fired — pre-A-F5 this was the silent dip the warn
    // survived; now the standing warn is cleared AT the landing.
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the landing is real, not vacuous
    expect(toastEl(container)).toBeNull(); // RED pre-fix (the ~30s orphan)
    expect(vi.getTimerCount()).toBe(0); // nothing armed: it cannot come back

    // …and it STAYS cleared past the entire spike window (pre-fix the warn
    // sat until the grade reached live — up to the 30s decay).
    await vi.advanceTimersByTimeAsync(35_000);
    expect(toastEl(container)).toBeNull();

    // The resolution ack was NOT lost: `warned` survived the clear, so live
    // fires the recovery ok — which auto-expires at 2.5s under OFF.
    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    await vi.advanceTimersByTimeAsync(2499);
    expect(toastEl(container)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)).toBeNull();
  });

  it("OFF/warned=false: recovery-to-live inside the 2.5s window clears the ok immediately (not via the expiry)", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected"); // ok fired; warned consumed → false; 2.5s expiry armed

    // The dip rides the sampler carrier (status stays "live" — no status
    // write to carry the re-evaluation; the probe's reactive tunnel write
    // does). The e6f9a7e fence: the pending expiry survives the silent dip.
    const carrier = tunnelCarrier();
    recordFetchFailure("network");
    recordFetchFailure("network");
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)?.textContent).toContain("Reconnected");

    // Recovery inside the 2.5s window: the live run takes the warned=false
    // path → the ok is cleared BY THE TRANSITION, earlier than the expiry.
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)).toBeNull();
    expect(vi.getTimerCount()).toBe(0); // the expiry was cleared, not left to fire
  });

  // ── 2026-10-26 obligations pass (T1A-F1 / T1C-F1) ────────────────────────

  // T1A-F1: epoch-while-showArmed. Potential defect to rule out: if any run
  // cleared showTimer WITHOUT the callback firing and left showArmed set, a
  // LATER degraded landing — which legitimately keeps whatever is on screen
  // (the e6f9a7e silent-dip path) — would see a stale cancelledDebounce=true
  // and wrongly clear the toast. Adjudicated by tracing every
  // clearTimeout(showTimer) site in ConnectionToast.tsx: the effect's
  // top-of-run capture (`cancelledDebounce = showArmed; showArmed = false`)
  // sits BEFORE the unconditional clear, so NO effect run can leave the flag
  // set (the epoch branch included); dismiss resets it explicitly; onCleanup
  // is unreachable-irrelevant (the component is dead). NO DEFECT — this test
  // PINS that adjudication: an epoch firing while a debounce is pending
  // cancels it (the restart warn replaces the pending warn — open-cell 18's
  // suppression, now pinned) and a subsequent degraded landing clears
  // NOTHING: under OFF the restart warn's 4s expiry survives the dip
  // (e6f9a7e), under ON the persistent restart warn stays.
  it("epoch while a debounce is armed: no stale clear on a later degraded dip (both profiles)", async () => {
    const { container } = await mount();

    // OFF phase — a drop arms the 1200ms debounce (no toast yet)…
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
    // …then the daemon restarts mid-debounce: the epoch run captures AND
    // RESETS showArmed, cancels the debounce, and shows the restart warn.
    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    expect(state.epochChanged).toBe(false); // the latch was consumed

    // The debounce is truly cancelled: past its would-fire point the restart
    // warn is still alone on screen, and the 4s expiry is the ONLY timer
    // (a surviving debounce would make this 2).
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    expect(vi.getTimerCount()).toBe(1);

    // The degraded landing: cancelledDebounce must be FALSE here (the epoch
    // run consumed it) — the A-F4 branch must NOT fire…
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the dip is real, not vacuous
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    // …and the 4s expiry survives the silent dip (e6f9a7e): 1200ms already
    // burned above; 2799ms more keeps it on screen, +1ms hides it.
    await vi.advanceTimersByTimeAsync(2799);
    expect(toastEl(container)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)).toBeNull();

    // ON phase — same interleaving, persistent posture: the restart warn
    // arms NO expiry under ON, and the degraded landing must clear NOTHING
    // (the stale-flag scenario would have cleared it here too).
    setEinkProfile(true);
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    expect(vi.getTimerCount()).toBe(0); // no expiry under ON; the debounce was cancelled
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
  });

  // T1C-F1, OFF flavor — the A-F4 warn-side clear, reshaped for A-F5 (the
  // 2026-10-29 card). Pre-A-F5 the interleaving needed a "silent degraded
  // dip the warn survives" bridge; A-F5 clears the standing warn AT that
  // landing, so the bridge is now itself the fix under test. What this test
  // still pins: (i) the fresh drop after the landing re-arms the 1200ms
  // REPLACEMENT debounce with nothing on screen; (ii) a degraded landing
  // inside that debounce CANCELS the replacement — no warn may appear at
  // the cancelled debounce's would-fire point; (iii) `warned` survives both
  // clears, so live still fires the resolution ok (auto-expiring under OFF).
  it("OFF: a degraded landing inside a replacement debounce fires no warn; the cancelled replacement stays cancelled", async () => {
    const { container } = await mount();

    // The warn fires (debounce elapsed → warned=true).
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");

    // The degraded landing CLEARS the standing warn (A-F5) — and is the
    // bridge that lets the grade re-arm (connGrade is string-deduped, so a
    // fresh "reconnecting" run requires leaving the grade first).
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)).toBeNull();

    // A fresh drop re-arms the 1200ms REPLACEMENT debounce; nothing is on
    // screen (the warn was cleared at the landing, the replacement pends).
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
    expect(vi.getTimerCount()).toBe(1); // the replacement debounce, alone

    // Degraded lands inside the debounce: the socket reopened weakly — this
    // run CANCELS the replacement (A-F4 captures it); nothing true remains
    // on screen and nothing may appear for the cancelled debounce.
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the landing is real, not vacuous
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)).toBeNull(); // the cancelled replacement never fired

    // The resolution ack was NOT lost: `warned` survived the clears, so live
    // fires the recovery ok — which auto-expires at 2.5s under OFF.
    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    await vi.advanceTimersByTimeAsync(2499);
    expect(toastEl(container)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)).toBeNull();
  });

  // A-F5 disposition coverage — the OFFLINE warn site (ConnectionToast's
  // other warn text). The offline warn fires on the "offline" grade; a
  // degraded landing means navigatorOnline came back AND the socket is live
  // AND convergence completed (the reduction's rule order), so the offline
  // condition has genuinely recovered: the warn must clear there too — not
  // sit until "live" (pre-fix behavior).
  it("OFF: an offline warn is cleared by a degraded landing too (the offline condition genuinely recovered)", async () => {
    const { container } = await mount();
    initConnStatus(); // wires the navigator online/offline signal listeners

    window.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(1200);
    expect(connGrade()).toBe("offline");
    expect(toastEl(container)?.textContent).toContain("You're offline");

    // Network returns; the socket reopens CONVERGED but the outage racked
    // ≥2 fetch failures → the landing is degraded, not live.
    recordFetchFailure("network");
    recordFetchFailure("network");
    window.dispatchEvent(new Event("online"));
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)).toBeNull(); // RED pre-fix — the offline orphan
    expect(vi.getTimerCount()).toBe(0);

    // …and live still acks (`warned` survived the clear).
    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)?.textContent).toContain("Reconnected");
  });

  // Re-assert bound PIN (per-attempt reconnecting re-asserts). The transport
  // re-asserts status "reconnecting" on EVERY retry attempt (tree onerror —
  // native CONNECTING retries and each backoff-ladder rung). Those writes
  // re-evaluate the model, but connGrade is string-deduped, so the toast
  // effect NEVER re-runs mid-grade: no new debounce, no re-fired warn, no
  // timer — the toast cannot be EXTENDED by attempts, only by the grade
  // genuinely holding "reconnecting". Pinned here (unchanged behavior); the
  // A-F5 clear above supplies the other half of the bound (resolution at
  // the actual reconnection landing, live OR degraded).
  it("OFF pin: per-attempt reconnecting re-asserts never re-arm the warn; exactly one warn fires", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");
    expect(vi.getTimerCount()).toBe(0);

    // The per-attempt shape: repeated same-value re-assert writes AND
    // model-churning writes that keep the GRADE constant ("connecting" and
    // "reconnecting" both grade to "reconnecting" — only the phase differs).
    for (let i = 0; i < 5; i++) {
      setState("status", "reconnecting");
      setState("status", "connecting");
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    // Still exactly the one warn — no re-arm, no second surface, no timer.
    expect(toastEl(container)?.textContent).toContain("Connection lost");
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ConnectionToast — e-ink profile ON (quiet UI: persistent notices)", () => {
  beforeEach(() => {
    setEinkProfile(true);
  });

  // The Part B cells below rack weaklink fetch-failure counters (module
  // singletons) and consume the tunnel sampler's install latch — the same
  // reset discipline as the OFF describe above, so the spike cannot leak into
  // later tests and a future sampler-dependent test cannot silently no-op.
  afterEach(() => {
    _resetWeakLinkForTest();
    delete (globalThis as { __vhTunnelSampled?: boolean }).__vhTunnelSampled;
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

  // ── Part B, ON pair (2026-10-26 lattice study): degraded→live × warned ───

  // A-F5, ON cell (the orphaned-warn fix under the quiet profile). The warn
  // is an "important notice" that persists while the condition holds — but a
  // degraded landing means the condition ENDED (socket live + converged,
  // weak evidence only), so persistence past the landing would show a
  // falsehood for an unbounded duration. RED pre-fix (the warn survived);
  // GREEN post-fix. `warned` survives → the later live fires the persistent
  // recovery ok (the documented ON resolution).
  it("ON/warned=true: a degraded landing clears the standing warn (no orphan); live still acks with the persistent ok", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");

    // Landing: socket reopened + converged, but the drop racked ≥2 failures
    // → degraded. Pre-A-F5 the warn survived this silently under ON too.
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)).toBeNull(); // RED pre-fix (the ON orphan)
    expect(vi.getTimerCount()).toBe(0); // under ON nothing else is armed either

    // It stays cleared (no timer can bring it back; the grade holds).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastEl(container)).toBeNull();

    // Resolution ack intact: live fires the ok, which coalesces into a
    // stable status under ON (no 2.5s flash).
    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(toastEl(container)?.textContent).toContain("Reconnected"); // stable, readable on a slow panel
  });

  // Dismiss × degraded interaction pin (card-2 run-1 F1 DEFER, closed here):
  // a warn the OPERATOR dismissed (not one the A-F5 branch cleared) meets a
  // degraded landing next. The A-F5 branch fires its setToast(null) as a
  // NO-OP at that landing (the fence: "degraded with toast=null is a no-op
  // (incl. a dismissed warn)") — and `warned` is untouched by BOTH dismiss()
  // and the branch, so the resolution ack must still fire when the grade
  // later reaches live. Coverage-closure PIN (green-on-landing expected).
  it("ON: a dismissed warn meets a degraded landing (no-op clear); warned survives so live still acks", async () => {
    const { container } = await mount();

    // The warn fires (debounce elapsed → warned=true)…
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");

    // …and the operator dismisses it: banner gone, `warned` stays true
    // (dismiss clears toast + timers, never the warned latch).
    fireEvent.click(toastEl(container)!.querySelector('button[aria-label="Dismiss notice"]')!);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();

    // The degraded landing (socket reopened + converged, ≥2 racked failures):
    // the A-F5 branch runs but its setToast(null) is a no-op — toast stays
    // null, nothing is armed, and `warned` survives the pass-through.
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the landing is real, not vacuous
    expect(toastEl(container)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    // The resolution ack was NOT lost by the dismissal: live fires the
    // "Reconnected" ok — a stable status under ON (no 2.5s flash).
    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(toastEl(container)?.textContent).toContain("Reconnected");
  });

  // Lattice cell 2b — KNOWN DEVIATION, pinned AS-IS (see the open-cell
  // ledger in the file header): the documented ON contract says the recovery
  // ok "stays until dismissed or superseded" (ConnectionToast.tsx:36–38),
  // but a degraded→live recovery with warned=false takes the live branch's
  // setToast(null) and removes the stable ok IMMEDIATELY. Accepted by the
  // study's adjudication (early removal of a benign ok is harmless; the
  // alternative — teaching the live branch profile+warned history — is a
  // behavior change out of this slice's scope). Do NOT "fix" via a test
  // assertion flip; re-adjudicate first.
  it("ON/warned=false: recovery-to-live removes the stable ok immediately (accepted deviation from persist-until-dismissed)", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected"); // ok fired; warned consumed → false; ON: no expiry

    // Dip via the sampler carrier: the stable ok survives the silent dip
    // (nothing pending to cancel — the A-F4 fence holds here too).
    const carrier = tunnelCarrier();
    recordFetchFailure("network");
    recordFetchFailure("network");
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)?.textContent).toContain("Reconnected");

    // Recovery: the live run's warned=false path clears it — the deviation.
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)).toBeNull(); // PINNED CURRENT BEHAVIOR (cell 2b)
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── 2026-10-26 obligations pass, ON pair (A-F4 symmetry + warn-side) ─────

  // Advisory pin: ON-profile symmetry of the A-F4 branch — the c0c36f2
  // regression drove the OFF flavor only. The branch is profile-independent
  // BY CODE (no quiet read inside it); this test VERIFIES rather than
  // assumes: under ON the ok arms NO 2.5s expiry (quiet skips the arming),
  // so when the degraded landing cancels the replacement debounce the A-F4
  // branch is the ONLY clearer — if it somehow failed to fire under ON, the
  // stale ok would persist and the null assertion below would go red (a
  // finding to report, not to force green).
  it("ON: a degraded landing inside the debounce clears the stale ok (A-F4, profile symmetry)", async () => {
    const { container } = await mount();

    // warned=true → live: the ok fires and, under ON, coalesces into a
    // stable status — no expiry is armed.
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected"); // ok fired; warned consumed → false
    expect(vi.getTimerCount()).toBe(0); // ON: no 2.5s expiry armed

    // Hard drop: arms the 1200ms replacement; the stale ok stays up.
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    expect(vi.getTimerCount()).toBe(1); // the debounce, alone

    // Sub-second recovery lands DEGRADED (failures racked during the drop
    // grade the socket-open write down): the run cancels the replacement and
    // the A-F4 branch clears the orphaned ok — the same clear as OFF,
    // verified under ON.
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the landing is real, not vacuous
    expect(toastEl(container)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastEl(container)).toBeNull(); // nothing is armed to change it later
  });

  // T1C-F1, ON flavor — the A-F4 warn-side clear, reshaped for A-F5 (the
  // OFF flavor's comment carries the full reasoning). Under ON the standing
  // warn now clears AT the degraded landing; what stays pinned: the fresh
  // drop re-arms the replacement debounce with nothing on screen, a degraded
  // landing inside it cancels the replacement (no warn at its would-fire
  // point), and `warned` survives so live fires the persistent recovery ok.
  it("ON: a degraded landing inside a replacement debounce fires no warn; the cancelled replacement stays cancelled", async () => {
    const { container } = await mount();

    // The warn fires and persists under ON (warns carry no expiry in either
    // profile; under ON nothing else retires it either).
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)?.textContent).toContain("Connection lost");

    // The degraded landing clears the standing warn (A-F5) — and is the
    // re-arm bridge (connGrade is string-deduped).
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)).toBeNull();

    // A fresh drop re-arms the 1200ms REPLACEMENT debounce; nothing on screen.
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
    expect(vi.getTimerCount()).toBe(1); // the replacement debounce, alone

    // Degraded lands inside the debounce → the run cancels the replacement;
    // no warn may appear for the cancelled debounce's would-fire point.
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the landing is real, not vacuous
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)).toBeNull(); // the cancelled replacement never fired

    // Resolution-ack intact: live fires the ok, which coalesces into a
    // stable status under ON (no 2.5s flash).
    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)?.textContent).toContain("Reconnected");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(toastEl(container)?.textContent).toContain("Reconnected"); // stable, readable on a slow panel
  });
});
