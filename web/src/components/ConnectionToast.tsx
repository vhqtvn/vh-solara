import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { state, consumeEpochChanged, connGrade, connModel, selectedId } from "../sync";
import { einkProfile } from "../prefs";
import { isPaneVisible, onPaneVisibilityChange } from "../paneVisibility";
import Icon from "./Icon";
import styles from "./ConnectionToast.module.css";

// Content-first connection display (card
// task-2026-10-30t09-11-45-resume-ux-connection-display — display layer only).
// The app's local content is complete and usable during reconnects; this
// surface must reflect that instead of crying "Connection lost".
// ConnectionToast is the lifecycle owner of a TWO-TIER display:
//
//   QUIET TIER  — after GRACE_MS of FOREGROUND-VISIBLE hard-down (grade
//     "reconnecting" | "offline"), a static quiet pill: "Reconnecting…"
//     ("Connecting…" while connModel().phase === "connecting" — first load
//     is never "lost"; the offline grade keeps its distinct honest
//     wording). The grace REPLACES the old 1200ms warn debounce.
//   BANNER TIER — after DISCONNECT_BANNER_MS of foreground-visible
//     unresolved hard-down, a nonmodal DISMISSIBLE banner keyed on the
//     honest readiness signal state.messagesDelivered[sel] (READ-ONLY
//     consumption — never messages.length, never "ever reached live"):
//     usable-warm content → "Still disconnected. Showing saved content; new
//     activity may be missing."; absent content → "Connecting is taking
//     longer than expected." Dismissal demotes to the quiet tier and never
//     re-prompts within the same disconnection episode.
//   ACK — NO "Reconnected" after ordinary recovery (the routine ok is
//     RETIRED — this card is the recorded product decision re-opening the
//     A-F5′ "product decision only" lattice cell). A static "Back online"
//     appears ONLY at a live landing when the banner was actually VISIBLE
//     ≥ACK_MIN_VISIBLE_MS; NEVER at degraded; clears on dismissal, a
//     meaningful action (document pointerdown/keydown), or a new episode.
//   RESTART WARN — the epoch-latched daemon-restart notice is unchanged
//     (4s auto-expiry under the e-ink profile OFF; persistent + dismiss
//     button under ON). An epoch event closes any open episode (the
//     restart notice is the more important signal — the open-cell-18
//     adjudication, preserved); the quiet pill supersedes a standing
//     restart warn at grace fire (the old debounce-replace semantics).
//
// TIMING — thresholds count FOREGROUND-VISIBLE time only (paneVisibility):
// hiding the pane pauses the accounting (elapsed absorbed, the one-shot
// disarmed); revealing re-arms it with the remaining budget. One chained
// ONE-SHOT timer per episode (grace → banner), no polling, no recurring
// timers, no ticking timestamps, no per-frame work. Background duration
// NEVER triggers escalation on return.
//
// A-F5 (6dd6e8e) PRESERVED — a "degraded" landing (only reachable from
// store status "live" with cascade convergence complete) means the
// hard-down condition has GENUINELY ended: the landing closes the episode
// and clears its standing surfaces (quiet pill / banner / offline pill),
// with no ack. Fences preserved: a degraded landing with NO open episode
// is a silent observational grade — no surface change, and the restart
// warn's 4s auto-expiry survives it (the 2026-10-25 field-flake fix).
//
// TRANSPORT ONLY — this surface reflects the worker SSE stream (sync.ts),
// NOT OpenCode's own health; wording stays topology-agnostic so the two
// can't be conflated (OpenCodeHealthPanel owns OpenCode lifecycle).
// OBSERVATIONAL ONLY (debate-1 Q5): grades/connModel are consumed
// read-only; the grading reduction and its thresholds are untouched.
//
// E-INK/PERF POSTURE — every surface is static text (no animations, no
// transitions), fixed-position (tier changes never shift layout), the
// state is carried by the TEXT, not color alone. The e-ink profile gates
// only the restart warn's auto-expiry/dismiss (its slow-panel windows are
// unreadable); the quiet pill already persists-until-resolved in both
// profiles and the banner/ack are dismissible in both by spec.
export const GRACE_MS = 1500;
export const DISCONNECT_BANNER_MS = 30_000;
export const ACK_MIN_VISIBLE_MS = 5000;

type SurfaceKind = "restart" | "quiet" | "banner" | "ack";

export default function ConnectionToast() {
  // ── Display state (one surface at a time, DERIVED — no imperative toast
  //    juggling, so no orphan/stale-toast classes by construction) ──────────
  const [restartWarn, setRestartWarn] = createSignal(false);
  const [episodeOpen, setEpisodeOpen] = createSignal(false);
  const [pastGrace, setPastGrace] = createSignal(false);
  const [bannerDue, setBannerDue] = createSignal(false);
  const [bannerDismissed, setBannerDismissed] = createSignal(false);
  const [ackActive, setAckActive] = createSignal(false);

  // ── Episode accounting (foreground-visible time ONLY) ────────────────────
  // epElapsed accumulates VISIBLE milliseconds of the current hard-down
  // episode; epStart anchors the current visible span (null while paused).
  // bannerVisibleMs/bannerVisibleStart do the same for the ≥5s banner-
  // visibility ack gate. milestoneTimer is the ONE chained one-shot (grace
  // → banner), armed only while visible.
  let epElapsed = 0;
  let epStart: number | null = null;
  let bannerVisibleMs = 0;
  let bannerVisibleStart: number | null = null;
  let milestoneTimer: number | undefined;
  let hideTimer: number | undefined; // restart warn 4s expiry (profile OFF only)
  // True only between "the epoch branch armed the restart notice" and the
  // effect re-run that arming ITSELF schedules: consumeEpochChanged()
  // writes state.epochChanged inside the effect that just read it, so
  // Solid re-runs this effect immediately — and that re-run would land in
  // a clearing branch and kill the just-armed notice in the SAME flush.
  // When set, the very next run is a complete NO-OP; the reactive reads
  // stay hoisted ABOVE the guard so the no-op re-run cannot orphan the
  // effect's dependency set.
  let epochSelfReentry = false;

  const bannerShowing = () => bannerDue() && !bannerDismissed();

  // Absorb the running visible spans into the accumulators and disarm the
  // one-shot. Called on HIDE and at every episode close/settle.
  function pauseEpisodeClocks(now: number): void {
    if (epStart !== null) {
      epElapsed += now - epStart;
      epStart = null;
    }
    if (bannerShowing() && bannerVisibleStart !== null) {
      bannerVisibleMs += now - bannerVisibleStart;
      bannerVisibleStart = null;
    }
    clearTimeout(milestoneTimer);
    milestoneTimer = undefined;
  }

  // (Re)arm the chained one-shot for the next unfired milestone, with the
  // remaining budget. No-op while hidden or with nothing left to arm (the
  // banner fired, or was dismissed — no same-episode re-prompt).
  function armMilestone(): void {
    if (!episodeOpen() || !isPaneVisible()) return;
    clearTimeout(milestoneTimer);
    epStart = Date.now();
    if (!pastGrace()) {
      milestoneTimer = window.setTimeout(() => {
        epElapsed = GRACE_MS;
        epStart = Date.now();
        setPastGrace(true);
        // The quiet pill supersedes a standing restart warn (the old
        // debounce-replace semantics, preserved).
        clearTimeout(hideTimer);
        setRestartWarn(false);
        armMilestone();
      }, Math.max(0, GRACE_MS - epElapsed));
    } else if (!bannerDue() && !bannerDismissed()) {
      milestoneTimer = window.setTimeout(() => {
        epElapsed = DISCONNECT_BANNER_MS;
        epStart = Date.now();
        setBannerDue(true);
        bannerVisibleStart = Date.now();
        armMilestone(); // nothing further this episode; arms nothing
      }, Math.max(0, DISCONNECT_BANNER_MS - epElapsed));
    }
  }

  function openEpisode(): void {
    setAckActive(false); // a new episode invalidates any standing ack
    setEpisodeOpen(true);
    setPastGrace(false);
    setBannerDue(false);
    setBannerDismissed(false);
    epElapsed = 0;
    epStart = null;
    bannerVisibleMs = 0;
    bannerVisibleStart = null;
    armMilestone(); // no-op while hidden; the reveal re-arms
  }

  // Close the episode, clear its surfaces, stop its clocks. Returns the
  // accumulated banner-VISIBLE time (the ack gate's input).
  function closeEpisode(): number {
    pauseEpisodeClocks(Date.now());
    setEpisodeOpen(false);
    setPastGrace(false);
    setBannerDue(false);
    setBannerDismissed(false);
    return bannerVisibleMs;
  }

  createEffect(() => {
    // Reactive reads FIRST, on EVERY run — Solid tears an effect's
    // dependency set down before each re-run and re-establishes it only
    // from what the run actually reads. A run that reads nothing would
    // leave the set EMPTY and permanently kill this effect — so the reads
    // are hoisted ABOVE the guard, and the guard's early return stays a
    // pure no-op.
    const grade = connGrade();
    const ec = state.epochChanged;
    const quiet = einkProfile();
    if (epochSelfReentry) {
      epochSelfReentry = false;
      return;
    }
    // A silent "degraded" transition must NOT cancel a pending
    // auto-expiry (the restart warn's 4s window): live → degraded inside
    // it used to orphan the notice (field flake 2026-10-25). Every other
    // transition retires or replaces the restart warn immediately.
    if (ec || grade !== "degraded") clearTimeout(hideTimer);
    if (ec) {
      // Consume the latch here (only this surface reads it).
      consumeEpochChanged();
      epochSelfReentry = true; // the consume-write schedules the no-op re-run
      // The restart supersedes any open disconnect episode and any standing
      // ack (open-cell 18: the restart notice is the more important signal;
      // a "Back online" claim under a daemon restart is already stale).
      closeEpisode();
      setAckActive(false);
      setRestartWarn(true);
      // Say "vh-solara" explicitly so this can't be read as an OpenCode
      // event (OpenCodeHealthPanel owns OpenCode lifecycle separately).
      // Under the profile the notice persists until dismissed.
      if (!quiet) hideTimer = window.setTimeout(() => setRestartWarn(false), 4000);
      return;
    }
    if (grade === "reconnecting" || grade === "offline") {
      // Hard-down: open an episode if none is open. A flap WITHIN the
      // hard-down grades (reconnecting↔offline) is the SAME episode —
      // accounting continues, timers untouched (connGrade is
      // string-deduped, so per-attempt re-asserts never re-run this).
      if (!episodeOpen()) openEpisode();
    } else if (grade === "live") {
      // Recovery. Ordinary recoveries show NOTHING: the ack fires only
      // when the 30s banner was actually visible ≥ACK_MIN_VISIBLE_MS.
      if (episodeOpen()) {
        const bannerVisible = closeEpisode();
        if (bannerVisible >= ACK_MIN_VISIBLE_MS) setAckActive(true);
      }
      // A live landing retires the restart warn (the live grade requires
      // post-restart convergence — the re-sync it announced is done).
      setRestartWarn(false);
    } else if (grade === "degraded" && episodeOpen()) {
      // A-F5 (6dd6e8e), preserved: degraded is only reachable from store
      // status "live" with no pending convergence pass — the hard-down
      // condition the episode announced has GENUINELY ended at this
      // landing. Close the episode, clear the quiet pill / banner / offline
      // pill, and NEVER ack here. FENCE: degraded with NO open episode is
      // the silent observational dip — no surface change, no timer change.
      closeEpisode();
    }
  });

  // Foreground-visible accounting: paneVisibility transitions (and ONLY
  // transitions — no polling) pause/resume the clocks. Hidden duration is
  // invisible to every threshold; a reveal never escalates by itself.
  const unsubVisibility = onPaneVisibilityChange((visible) => {
    if (!episodeOpen()) return;
    if (visible) {
      armMilestone(); // re-arms with the remaining budget
      if (bannerShowing()) bannerVisibleStart = Date.now();
    } else {
      pauseEpisodeClocks(Date.now());
    }
  });

  // The ack clears on the next MEANINGFUL ACTION: any document-level user
  // input (pointerdown/keydown, capture+passive — armed only while the ack
  // shows, zero per-frame work) retires it.
  createEffect(() => {
    if (!ackActive()) return;
    const clear = () => setAckActive(false);
    document.addEventListener("pointerdown", clear, { capture: true, passive: true });
    document.addEventListener("keydown", clear, { capture: true, passive: true });
    onCleanup(() => {
      document.removeEventListener("pointerdown", clear, { capture: true });
      document.removeEventListener("keydown", clear, { capture: true });
    });
  });

  // ── Derived surface (one at a time) ───────────────────────────────────────
  const surface = createMemo((): SurfaceKind | null => {
    if (restartWarn()) return "restart";
    if (episodeOpen()) {
      if (bannerShowing()) return "banner";
      if (pastGrace()) return "quiet";
      return null;
    }
    return ackActive() ? "ack" : null;
  });

  const quietText = (): string => {
    const m = connModel();
    if (m.grade === "offline") return "You're offline — waiting for network…";
    // First load (hard socket still "connecting") is never "lost".
    return m.phase === "connecting" ? "Connecting…" : "Reconnecting…";
  };

  const bannerText = (): string => {
    // The honest readiness signal: server-attested initial-window delivery
    // for the SELECTED session (read-only). Warm content → the
    // saved-content promise; anything else (never opened, reserved-empty,
    // no selection) → the absent-content wording. Live-reactive: switching
    // sessions or a delivery flip retargets the wording with no timer.
    const sid = selectedId();
    const warm = !!sid && state.messagesDelivered[sid] === true;
    return warm
      ? "Still disconnected. Showing saved content; new activity may be missing."
      : "Connecting is taking longer than expected.";
  };

  // Dismissal. The banner demotes to the quiet tier (no same-episode
  // re-prompt) and freezes its visibility accumulator; the ack and the
  // restart warn simply clear. The quiet pill has NO dismiss affordance —
  // it is quiet and resolves with the episode.
  const dismiss = () => {
    if (restartWarn()) {
      clearTimeout(hideTimer);
      setRestartWarn(false);
    } else if (bannerShowing()) {
      if (bannerVisibleStart !== null) {
        bannerVisibleMs += Date.now() - bannerVisibleStart;
        bannerVisibleStart = null;
      }
      setBannerDismissed(true);
    } else if (ackActive()) {
      setAckActive(false);
    }
  };

  onCleanup(() => {
    clearTimeout(milestoneTimer);
    clearTimeout(hideTimer);
    unsubVisibility();
  });

  return (
    <Show when={surface()}>
      <div
        class={styles["conn-toast"]}
        classList={{
          warn: surface() === "banner" || surface() === "restart",
          ok: surface() === "ack",
          quiet: surface() === "quiet",
        }}
        role="status"
      >
        <Show when={surface() !== "quiet"}>
          <Icon name={surface() === "ack" ? "check" : "help"} size={15} />
        </Show>
        <span>
          {surface() === "restart"
            ? "vh-solara restarted — re-syncing…"
            : surface() === "quiet"
              ? quietText()
              : surface() === "banner"
                ? bannerText()
                : "Back online"}
        </span>
        {/* Dismiss: banner + ack in BOTH profiles (spec); the restart warn
            keeps the ON-only dismiss (its OFF 4s auto-expiry is the
            alternative); the quiet pill has none. */}
        <Show when={surface() === "restart" ? einkProfile() : surface() !== "quiet"}>
          <button
            type="button"
            class="icon-btn"
            aria-label="Dismiss notice"
            title="Dismiss notice"
            style={{
              padding: "2px 4px",
              margin: "-2px -2px -2px 4px",
              border: "0",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
            onClick={dismiss}
          >
            <Icon name="x" size={13} />
          </button>
        </Show>
      </div>
    </Show>
  );
}
