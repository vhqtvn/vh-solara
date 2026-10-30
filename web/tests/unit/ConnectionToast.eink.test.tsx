// @vitest-environment jsdom
// jsdom lacks matchMedia (Part.tsx → code/frame calls it at module load) —
// import the shared stub BEFORE any component import evaluates.
import "./_matchMedia";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import ConnectionToast, {
  GRACE_MS,
  DISCONNECT_BANNER_MS,
  ACK_MIN_VISIBLE_MS,
} from "../../src/components/ConnectionToast";
import { einkProfile, setEinkProfile } from "../../src/prefs";
import { connGrade, initConnStatus, installTunnelSampler, state } from "../../src/sync";
import { setState, setSelectedIdRaw } from "../../src/sync/store";
import { _resetWeakLinkForTest, recordFetchFailure } from "../../src/sync/weaklink";
import { __resetPaneVisibilityForTest, __setHostVisibleForTest } from "../../src/paneVisibility";

// Content-first connection display (card
// task-2026-10-30t09-11-45-resume-ux-connection-display, display layer only):
// ConnectionToast is the lifecycle owner of a TWO-TIER display keyed on the
// SHARED graded reduction (connGrade — string-deduped; read-only) with
// foreground-visible-time accounting via paneVisibility.
//
// Contract under test (the decided spec, thresholds = named exports):
//   QUIET TIER  — after GRACE_MS (1500) of FOREGROUND-VISIBLE hard-down
//     (grade reconnecting|offline), a static quiet pill: "Reconnecting…"
//     ("Connecting…" while connModel().phase === "connecting"; the offline
//     grade keeps its distinct "You're offline…" wording). NEVER "lost".
//     The 1500ms grace REPLACES the old 1200ms warn debounce — both must
//     not coexist (nothing may surface at 1200ms).
//   BANNER TIER — after DISCONNECT_BANNER_MS (30000) of foreground-visible
//     unresolved hard-down, a nonmodal DISMISSIBLE banner keyed on the
//     honest readiness signal (state.messagesDelivered[sel] === true —
//     never messages.length, never "ever reached live"):
//       warm   → "Still disconnected. Showing saved content; new activity
//                 may be missing."
//       absent → "Connecting is taking longer than expected."
//     Dismissal demotes to the quiet tier and never re-prompts within the
//     same disconnection episode.
//   ACK        — NO "Reconnected" after ordinary recovery (the routine ok is
//     RETIRED — the card is the recorded product decision re-opening the
//     A-F5′ "product decision only" lattice cell). A static "Back online"
//     appears ONLY at a live landing when the banner was actually visible
//     ≥ACK_MIN_VISIBLE_MS (5000); NEVER at degraded; clears on dismissal /
//     a meaningful action (document pointerdown/keydown) / a new episode.
//   A-F5 (6dd6e8e) PRESERVED — a degraded landing (socket live + converged,
//     only weak evidence left) closes the episode and clears its standing
//     surfaces (quiet pill / banner / offline pill); the restart warn's 4s
//     auto-expiry survives a silent degraded dip (the 2026-10-25 fence).
//   TIMING     — thresholds count foreground-visible time ONLY (paneVisibility
//     transitions pause/resume one-shot chained timers; no polling, no
//     per-frame work). Hidden duration NEVER escalates on reveal.
//
// What was reworked vs the pre-card file (all sanctioned by the card):
//   - every 1200ms-debounce pin → the 1500ms grace (the debounce is gone);
//   - "Connection lost — reconnecting…" wording pins → quiet-pill wording;
//   - the "Reconnected" ok lifecycle (2.5s expiry, coalesced stable status,
//     cell 2b) → RETIRED with the routine ack;
//   - the A-F4/A-F5 cancelledDebounce/warned fences → the episode model
//     (a degraded landing inside the grace closes the episode: the
//     cancelled grace never fires; a standing warn clears at the landing);
//   - `warned`-survives-so-live-acks tails → no ack from a degraded-closed
//     episode (never at degraded includes "not later, from that episode").
// The epoch/restart-warn lifecycle (4s OFF expiry / ON persistence /
// ON-only dismiss / self-entry no-op / effect-survives-epoch) is unchanged
// and still pinned below.

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

// A deterministic connMemo re-evaluation carrier. Installs (idempotently)
// the tunnel sampler over a stubbed fetch whose /vh/ responses carry
// X-VH-Tunnel-State: connected — the documented reactive carrier. Probe as
// many times as needed; the wrapper must STAY installed between probes.
// RESTORE OWNERSHIP LIVES IN afterEach: every install pushes its restore
// closure onto fetchRestores, drained by the top-level afterEach even when a
// test fails mid-flight. Tests never call restore themselves; the describes'
// afterEach deletes the latch and resets the weaklink counters between tests.
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
  return {
    probe: () => g.fetch("/vh/unit-tunnel-probe").then(() => undefined),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Quiet baseline: a live, converged store (fresh store boots "connecting",
  // which legitimately grades "reconnecting" and would open an episode on
  // its own). treeLastSeen is 0 → isStale() false; no cascade; no fetch
  // failures → the live grade holds.
  setState("status", "live");
  setState("epochChanged", false);
  // Normalize the paneVisibility module singleton: visible, no listeners
  // (the component subscribes at mount — after this reset).
  __resetPaneVisibilityForTest();
});

afterEach(() => {
  cleanup();
  setEinkProfile(false);
  localStorage.clear();
  setSelectedIdRaw(null);
  // Readiness-signal hygiene: the store is a module singleton — a prior
  // test's delivered/messages state would otherwise pin the banner wording.
  setState("messagesDelivered", reconcile({}));
  setState("messages", reconcile({}));
  // Navigator hygiene: initConnStatus() wires the online/offline listeners
  // ONCE per module (latched); a test that ends offline would leak the
  // navigator-offline grade into every later test. Heal unconditionally —
  // a no-op when the listeners were never wired.
  window.dispatchEvent(new Event("online"));
  // Drain any fetch stubs tunnelCarrier() installed — restore ownership
  // lives HERE (not on a test's green path), so an assertion failure between
  // install and restore cannot leak the stub across tests.
  for (const restore of fetchRestores.splice(0)) restore();
  __resetPaneVisibilityForTest();
  vi.useRealTimers();
});

describe("ConnectionToast — spec thresholds (named exports)", () => {
  it("exports GRACE_MS=1500, DISCONNECT_BANNER_MS=30000, ACK_MIN_VISIBLE_MS=5000", () => {
    expect(GRACE_MS).toBe(1500);
    expect(DISCONNECT_BANNER_MS).toBe(30_000);
    expect(ACK_MIN_VISIBLE_MS).toBe(5000);
  });
});

describe("ConnectionToast — restart warn (epoch lifecycle, unchanged)", () => {
  // The degraded-dip / re-grade tests below rack weaklink fetch-failure
  // counters (module singletons) and consume the tunnel sampler's install
  // latch. Reset both so state cannot leak into later tests in this file.
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

  it("ON: the restart warn persists past the OFF 4s auto-hide, dismissible", async () => {
    const { container } = await mount();
    setEinkProfile(true);

    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    await vi.advanceTimersByTimeAsync(6_000);
    const still = toastEl(container);
    expect(still).not.toBeNull(); // OFF would have hidden at 4s
    expect(still!.textContent).toContain("vh-solara restarted");

    // ON-only dismiss clears it.
    fireEvent.click(still!.querySelector('button[aria-label="Dismiss notice"]')!);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
  });

  // T1A-F1 rework (epoch-while-grace-armed). The old pin: an epoch firing
  // while the 1200ms debounce was pending cancels it (open-cell 18: the
  // restart notice is the more important signal) and a later degraded
  // landing clears NOTHING. New shape, same adjudication: an epoch while
  // the 1500ms grace is pending CLOSES the episode (the cancelled grace
  // never fires — no quiet pill at its would-fire point), the restart warn
  // stands alone with the 4s expiry as the ONLY timer, and the degraded
  // landing neither replaces nor clears it (its expiry survives the dip —
  // the 2026-10-25 fence). The ON phase mirrors: persistent restart warn,
  // zero timers, degraded clears nothing.
  it("epoch while the grace is armed: grace cancelled, restart warn stands, degraded dip clears nothing (both profiles)", async () => {
    const { container } = await mount();

    // OFF phase — a drop opens an episode and arms the grace (one timer)…
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    // …then the daemon restarts mid-grace: the epoch run closes the episode
    // (cancelling the grace) and shows the restart warn.
    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    expect(state.epochChanged).toBe(false); // the latch was consumed

    // The grace is truly cancelled: past its would-fire point the restart
    // warn is still ALONE on screen (no quiet pill), and the 4s expiry is
    // the ONLY timer (a surviving grace timer would make this 2).
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    expect(vi.getTimerCount()).toBe(1);

    // The degraded landing (socket reopened + converged, ≥2 racked
    // failures) must clear NOTHING and must not cancel the 4s expiry.
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the dip is real, not vacuous
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    await vi.advanceTimersByTimeAsync(1_999); // 2000 + 1999 = 3999 burned
    expect(toastEl(container)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)).toBeNull(); // expiry survived the dip

    // ON phase — same interleaving, persistent posture: the restart warn
    // arms NO expiry under ON, the grace is cancelled again, and a degraded
    // landing clears nothing.
    setEinkProfile(true);
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    expect(vi.getTimerCount()).toBe(0); // no expiry under ON; the grace was cancelled
    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
  });

  // D1 rework: the toast must keep REACTING after an epoch event — the
  // effect's dependency set survives the self-scheduled no-op re-run. After
  // the restart warn, a LATER drop must still escalate to the quiet pill
  // (superseding the restart warn at grace fire — the preserved
  // debounce-replace semantics) and its resolution must clear it with NO
  // ack (ordinary recovery). Both profiles.
  it("after an epoch event, later grade transitions still drive surfaces (both profiles)", async () => {
    const { container } = await mount();

    // Epoch first (its consume-write is what schedules the no-op re-run).
    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");

    // Still under ON… no — OFF here: a LATER drop opens an episode under
    // the standing restart warn; at grace fire the quiet pill supersedes it.
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    const pill = toastEl(container);
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("Reconnecting…");
    // …and ordinary recovery clears it with NO ack (the routine ok retired).
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastEl(container)).toBeNull();

    // ON too: second epoch (persistent warn), a drop supersedes at grace
    // fire, recovery clears, no ack.
    setEinkProfile(true);
    setState("epochChanged", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("vh-solara restarted");
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
  });
});

describe("ConnectionToast — quiet tier (the 1.5s grace replaces the 1200ms debounce)", () => {
  afterEach(() => {
    _resetWeakLinkForTest();
    delete (globalThis as { __vhTunnelSampled?: boolean }).__vhTunnelSampled;
  });

  // THE replacement proof. The old 1200ms warn debounce must be GONE:
  // nothing at 1200ms (old behavior: "Connection lost" had fired), nothing
  // at 1499ms, the quiet pill at exactly 1500ms — and the wording never
  // says "lost" (first-load/reconnect alike; the spec's "never 'lost'").
  it("shows nothing at 1200ms and 1499ms; the quiet pill appears at exactly 1500ms, never saying 'lost'", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)).toBeNull(); // RED vs old: the debounce fired here
    await vi.advanceTimersByTimeAsync(299);
    expect(toastEl(container)).toBeNull(); // 1499: grace not elapsed
    await vi.advanceTimersByTimeAsync(1);
    const pill = toastEl(container);
    expect(pill).not.toBeNull(); // 1500: grace elapsed
    expect(pill!.textContent).toContain("Reconnecting…");
    expect(pill!.textContent).not.toContain("lost");
    expect(pill!.querySelector('button[aria-label="Dismiss notice"]')).toBeNull(); // quiet tier: no dismiss
  });

  // First-load distinction (display over the EXISTING phase facet — no
  // grading change): store status "connecting" grades "reconnecting" with
  // phase "connecting" → the pill says "Connecting…", never "lost".
  it("first-load (phase connecting) says 'Connecting…', not 'Reconnecting…'", async () => {
    const { container } = await mount();

    setState("status", "connecting");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    const pill = toastEl(container);
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("Connecting…");
    expect(pill!.textContent).not.toContain("Reconnecting…");
    expect(pill!.textContent).not.toContain("lost");
  });

  // The offline grade keeps its distinct honest wording (browser has no
  // network — "reconnecting" would be a lie), now on the quiet-tier timing.
  it("offline: 'You're offline — waiting for network…' at the grace boundary (not 1200ms)", async () => {
    const { container } = await mount();
    initConnStatus(); // wires the navigator online/offline signal listeners

    window.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(1200);
    expect(toastEl(container)).toBeNull(); // the old debounce's fire point: silent
    await vi.advanceTimersByTimeAsync(299);
    expect(toastEl(container)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)?.textContent).toContain("You're offline");
  });

  // Re-assert bound PIN, reworked (per-attempt reconnecting re-asserts).
  // The transport re-asserts status "reconnecting" on EVERY retry attempt
  // and cycles "connecting"/"reconnecting"; those writes re-evaluate the
  // model but connGrade is string-deduped, so the effect NEVER re-runs
  // mid-grade: no re-armed grace, no second surface. The pill's TEXT tracks
  // the live phase facet (Connecting…/Reconnecting…) without touching any
  // timer. After the grace fired, the ONLY armed timer is the escalation
  // (banner) timer — the display is done creating timers for this tier.
  it("per-attempt re-asserts never re-arm the grace; exactly one surface; phase-flips retarget the wording", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");

    // The per-attempt shape: repeated same-grade writes + phase churn.
    for (let i = 0; i < 5; i++) {
      setState("status", "reconnecting");
      setState("status", "connecting");
      await vi.advanceTimersByTimeAsync(1);
    }
    // The wording followed the LIVE phase (last write: "connecting")…
    expect(toastEl(container)?.textContent).toContain("Connecting…");
    // …still exactly one surface, and only the escalation timer is armed
    // (a re-armed grace would make this 2; zero would mean no escalation).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("ConnectionToast — banner tier (30s escalation, wording, dismissal)", () => {
  afterEach(() => {
    _resetWeakLinkForTest();
    delete (globalThis as { __vhTunnelSampled?: boolean }).__vhTunnelSampled;
  });

  // Boundary: the banner escalates at exactly DISCONNECT_BANNER_MS of
  // foreground-visible hard-down (cumulative with the grace — one clock),
  // replacing the quiet pill. With no session selected there is no warm
  // content to promise → the absent-content wording.
  it("quiet at 29999ms cumulative; banner at exactly 30000ms (absent-content wording, no selection)", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS - GRACE_MS - 1); // 29999 cumulative
    expect(toastEl(container)?.textContent).toContain("Reconnecting…"); // still quiet
    await vi.advanceTimersByTimeAsync(1); // 30000 cumulative
    const banner = toastEl(container);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Connecting is taking longer than expected.");
    // Nonmodal + dismissible: the dismiss affordance renders in BOTH profiles.
    expect(banner!.querySelector('button[aria-label="Dismiss notice"]')).not.toBeNull();
  });

  // Warm wording: the selected session's delivered flag is the honest
  // readiness signal (READ-ONLY consumption) — never messages.length.
  it("warm content: 'Still disconnected. Showing saved content; new activity may be missing.'", async () => {
    const { container } = await mount();
    setSelectedIdRaw("s1");
    setState("messagesDelivered", "s1", true);

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS);
    const banner = toastEl(container);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Still disconnected. Showing saved content; new activity may be missing.");
  });

  // Delivered=false (reserved-but-not-delivered / never opened) is ABSENT
  // content — the absent wording, not the saved-content promise.
  it("selected but not delivered (reserved-empty): absent-content wording", async () => {
    const { container } = await mount();
    setSelectedIdRaw("s2");
    setState("messages", "s2", { order: [], byId: {} }); // the pre-reserved slot

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS);
    expect(toastEl(container)?.textContent).toContain("Connecting is taking longer than expected.");
  });

  // The banner's wording is REACTIVE on the readiness signal (the operator
  // can switch sessions or delivery can flip mid-banner): the text swaps
  // with no timer involvement.
  it("banner wording follows the readiness signal live (absent → warm with no timer)", async () => {
    const { container } = await mount();
    setSelectedIdRaw("s1");

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS);
    expect(toastEl(container)?.textContent).toContain("Connecting is taking longer than expected.");
    expect(vi.getTimerCount()).toBe(0); // nothing armed past the banner

    setState("messagesDelivered", "s1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Still disconnected. Showing saved content; new activity may be missing.");
    expect(vi.getTimerCount()).toBe(0); // the swap was reactive, not timed
  });

  // Episode semantics: dismissing the banner demotes to the quiet tier and
  // it NEVER re-prompts within the same disconnection episode — however
  // long the outage runs afterwards.
  it("dismissal demotes to the quiet tier; no same-episode re-prompt however long the outage runs", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS);
    const banner = toastEl(container)!;
    expect(banner.textContent).toContain("Connecting is taking longer than expected.");
    fireEvent.click(banner.querySelector('button[aria-label="Dismiss notice"]')!);
    await vi.advanceTimersByTimeAsync(0);

    // Demoted: the quiet pill is back, one surface.
    const pill = toastEl(container);
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("Reconnecting…");
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);

    // …and the banner NEVER comes back this episode (a full minute more).
    await vi.advanceTimersByTimeAsync(60_000);
    const still = toastEl(container)!;
    expect(still.textContent).toContain("Reconnecting…");
    expect(still.querySelector('button[aria-label="Dismiss notice"]')).toBeNull();
  });
});

describe("ConnectionToast — ack gating ('Back online')", () => {
  afterEach(() => {
    _resetWeakLinkForTest();
    delete (globalThis as { __vhTunnelSampled?: boolean }).__vhTunnelSampled;
  });

  // NO ack after ordinary recovery — the routine "Reconnected" ok is
  // RETIRED. A grace-only episode (drop, quiet pill, quick recovery) shows
  // NOTHING at the live landing and nothing later.
  it("no ack after ordinary recovery (grace-only episode); nothing ever re-surfaces", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");

    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull(); // RED vs old: "Reconnected" fired here
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastEl(container)).toBeNull(); // and nothing auto-expiry-shaped replaces it
  });

  // The ack fires ONLY when the banner was actually visible ≥5s. Sub-case A:
  // banner visible 4999ms → recovery → NO ack.
  it("banner visible 4999ms: recovery shows NO ack", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS); // banner up
    expect(toastEl(container)?.textContent).toContain("longer than expected");
    await vi.advanceTimersByTimeAsync(ACK_MIN_VISIBLE_MS - 1); // 4999 visible
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastEl(container)).toBeNull();
  });

  // Sub-case B: banner visible exactly 5000ms → recovery → the static
  // "Back online" ack, which persists (no auto-expiry timer — it clears on
  // dismissal / meaningful action / new episode).
  it("banner visible 5000ms: recovery shows the static 'Back online' ack (no auto-expiry)", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS);
    await vi.advanceTimersByTimeAsync(ACK_MIN_VISIBLE_MS); // 5000 visible
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    const ack = toastEl(container);
    expect(ack).not.toBeNull();
    expect(ack!.textContent).toContain("Back online");
    expect(vi.getTimerCount()).toBe(0); // static: nothing armed to remove it
    await vi.advanceTimersByTimeAsync(30_000);
    expect(toastEl(container)?.textContent).toContain("Back online"); // still there
    // Dismissible via its button (both profiles — this is OFF).
    expect(ack!.querySelector('button[aria-label="Dismiss notice"]')).not.toBeNull();
    fireEvent.click(ack!.querySelector('button[aria-label="Dismiss notice"]')!);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
  });

  // NEVER at degraded: even a banner that was visible ≥5s acks nothing when
  // the landing is degraded (socket live + converged, weak evidence only).
  // The episode's surfaces clear at the landing (A-F5, below), and the
  // later live does NOT resurrect an ack from that closed episode.
  it("never at degraded: banner visible ≥5s, degraded landing clears everything and never acks (incl. the later live)", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS + ACK_MIN_VISIBLE_MS);
    expect(toastEl(container)?.textContent).toContain("longer than expected");

    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded"); // the landing is real, not vacuous
    expect(toastEl(container)).toBeNull(); // surfaces cleared, NO ack
    expect(vi.getTimerCount()).toBe(0);

    // …and the later live (weak evidence decayed) shows nothing either: the
    // episode ended at the degraded landing.
    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)).toBeNull();
  });

  // A new episode clears a standing ack (the "Back online" claim describes
  // the PREVIOUS outage; a fresh drop makes it stale immediately).
  it("a new episode clears a standing ack", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS + ACK_MIN_VISIBLE_MS);
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Back online");

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull(); // ack gone at episode open (pre-grace)
  });

  // "Clears on the next meaningful action": a document-level user input
  // (pointerdown / keydown, capture+passive — zero per-frame work) retires
  // the ack. Armed only while the ack shows.
  it("a meaningful action (document pointerdown) clears the ack", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS + ACK_MIN_VISIBLE_MS);
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Back online");

    fireEvent.pointerDown(document);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull();
  });
});

describe("ConnectionToast — A-F5 preserved (degraded landing clears standing warns)", () => {
  afterEach(() => {
    _resetWeakLinkForTest();
    delete (globalThis as { __vhTunnelSampled?: boolean }).__vhTunnelSampled;
  });

  // A-F5 OFF cell, reworked tail. Capture-1 §Q4's orphaned-warn amplifier:
  // a warn that fired under "reconnecting" must not survive a degraded
  // landing (degraded REQUIRES store status "live" + no pending convergence
  // pass — the hard-down condition the warn announced has GENUINELY ended;
  // pre-A-F5 it sat with zero timers for up to the 30s fetch-spike window /
  // a >45s tree-stale dip AFTER full reconvergence). The quiet pill clears
  // at the landing and stays cleared. The OLD tail ("`warned` survives so
  // live still acks") is RETIRED with the routine ack: no ack fires from a
  // degraded-closed episode.
  it("OFF: a degraded landing clears the standing quiet pill; no ack at the later live", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");

    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)).toBeNull(); // cleared at the landing
    expect(vi.getTimerCount()).toBe(0); // nothing armed: it cannot come back

    await vi.advanceTimersByTimeAsync(35_000); // past the entire spike window
    expect(toastEl(container)).toBeNull();

    // The reworked tail: live fires NO ack from this closed episode.
    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)).toBeNull();
  });

  // A-F5 ON cell (the quiet profile mirror): the quiet pill is persistent
  // while the condition holds — but the degraded landing means the
  // condition ENDED, so persistence past it would show a falsehood for an
  // unbounded duration on a slow panel. Cleared at the landing; no ack.
  it("ON: a degraded landing clears the standing quiet pill; no ack at the later live", async () => {
    const { container } = await mount();
    setEinkProfile(true);

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");

    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastEl(container)).toBeNull();

    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)).toBeNull(); // no ack under ON either
  });

  // A-F5 disposition coverage — the OFFLINE wording site: a degraded
  // landing means navigatorOnline came back AND the socket is live AND
  // convergence completed, so the offline condition has genuinely
  // recovered: the offline pill clears there too.
  it("an offline quiet pill is cleared by a degraded landing too", async () => {
    const { container } = await mount();
    initConnStatus();

    window.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(connGrade()).toBe("offline");
    expect(toastEl(container)?.textContent).toContain("You're offline");

    recordFetchFailure("network");
    recordFetchFailure("network");
    window.dispatchEvent(new Event("online"));
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(toastEl(container)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    // …and the later live acks nothing.
    const carrier = tunnelCarrier();
    _resetWeakLinkForTest();
    await carrier.probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("live");
    expect(toastEl(container)).toBeNull();
  });

  // T1C-F1 rework — the A-F4 mirror under the episode model. A degraded
  // landing INSIDE the grace closes the episode and cancels the pending
  // grace: nothing may appear at the cancelled grace's would-fire point.
  // A fresh drop afterwards opens a NEW episode with a fresh grace (the
  // degraded landing is the string-dedup bridge that lets the grade
  // re-enter "reconnecting").
  it("a degraded landing inside the grace fires no pill; a fresh drop re-arms a fresh grace", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(500); // grace pending
    expect(vi.getTimerCount()).toBe(1);

    recordFetchFailure("network");
    recordFetchFailure("network");
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(connGrade()).toBe("degraded");
    expect(vi.getTimerCount()).toBe(0); // the grace was cancelled
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5_000);
    expect(toastEl(container)).toBeNull(); // the cancelled grace never fired

    // Fresh drop → NEW episode → fresh grace → the pill fires again.
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(toastEl(container)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");
  });
});

describe("ConnectionToast — visibility accounting (foreground-visible time only)", () => {
  afterEach(() => {
    _resetWeakLinkForTest();
    delete (globalThis as { __vhTunnelSampled?: boolean }).__vhTunnelSampled;
  });

  // Hidden intervals DON'T COUNT. Hiding at 1000ms of elapsed grace
  // disarms the one-shot timer; 35s of hidden time advances NOTHING (no
  // escalation on reveal — the background duration is invisible to the
  // accounting); the reveal re-arms the grace with its REMAINING 500ms and
  // the banner still waits for its full 30s of VISIBLE time afterwards.
  it("hidden time doesn't count: the grace pauses across a 35s hidden gap and resumes with its remainder", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(1_000); // 1000ms of visible grace burned
    __setHostVisibleForTest(false); // hide: pause + disarm
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(35_000); // hidden: nothing may fire
    expect(toastEl(container)).toBeNull();

    __setHostVisibleForTest(true); // reveal: NO escalation from the hidden span
    expect(toastEl(container)).toBeNull();
    expect(vi.getTimerCount()).toBe(1); // the re-armed grace remainder

    await vi.advanceTimersByTimeAsync(499); // 1499 visible total
    expect(toastEl(container)).toBeNull();
    await vi.advanceTimersByTimeAsync(1); // 1500 visible total
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");

    // The banner needs the full 30s of VISIBLE time — 28.5s more from here.
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS - GRACE_MS - 1);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)?.textContent).toContain("longer than expected");
  });

  // Long-background discipline: a disconnect that begins VISIBLE, goes
  // hidden for two minutes, and comes back must arrive at exactly the same
  // display state as if the hide never happened — the reveal itself never
  // escalates and no background-duration shortcut exists.
  it("background duration never triggers escalation on return (2-minute hidden span)", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(200); // 200ms visible
    __setHostVisibleForTest(false);
    await vi.advanceTimersByTimeAsync(120_000); // 2 minutes hidden
    __setHostVisibleForTest(true);
    expect(toastEl(container)).toBeNull(); // no pill, no banner at reveal

    // Grace completes at 1500 VISIBLE ms (1300 remain)…
    await vi.advanceTimersByTimeAsync(1_299);
    expect(toastEl(container)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");
    // …and the banner at 30000 VISIBLE ms.
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS - GRACE_MS);
    expect(toastEl(container)?.textContent).toContain("longer than expected");
  });

  // The banner-VISIBLE ≥5s ack gate uses the SAME foreground-visible
  // accounting: a hidden gap mid-banner freezes the accumulator. 2000
  // visible + a 60s hidden gap + 3000 more visible = exactly 5000 → the
  // ack fires; (2999 more would leave it at 4999 → no ack).
  it("banner-visible accounting pauses while hidden (visible-accumulator, not wall clock)", async () => {
    const { container } = await mount();

    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS); // banner up
    await vi.advanceTimersByTimeAsync(2_000); // 2000 banner-visible
    __setHostVisibleForTest(false);
    await vi.advanceTimersByTimeAsync(60_000); // hidden: frozen accumulator
    __setHostVisibleForTest(true);
    await vi.advanceTimersByTimeAsync(2_999); // 4999 banner-visible
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)).toBeNull(); // 4999 < 5000: no ack

    // The mirror: exactly 5000 visible (one more ms) acks.
    setState("status", "reconnecting");
    await vi.advanceTimersByTimeAsync(DISCONNECT_BANNER_MS);
    await vi.advanceTimersByTimeAsync(2_000);
    __setHostVisibleForTest(false);
    await vi.advanceTimersByTimeAsync(60_000);
    __setHostVisibleForTest(true);
    await vi.advanceTimersByTimeAsync(3_000); // 5000 banner-visible
    setState("status", "live");
    await vi.advanceTimersByTimeAsync(0);
    expect(toastEl(container)?.textContent).toContain("Back online");
  });

  // A disconnect that starts while HIDDEN opens the episode with a frozen
  // clock (no timer armed in the dark); the reveal starts the grace from
  // zero — the hidden head-start never counts.
  it("an episode opened while hidden arms nothing until the reveal", async () => {
    const { container } = await mount();

    __setHostVisibleForTest(false);
    setState("status", "reconnecting"); // drop lands while hidden
    await vi.advanceTimersByTimeAsync(60_000); // hidden: nothing armed, nothing fires
    expect(toastEl(container)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    __setHostVisibleForTest(true);
    expect(vi.getTimerCount()).toBe(1); // the grace arms NOW, from zero
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(toastEl(container)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl(container)?.textContent).toContain("Reconnecting…");
  });
});
