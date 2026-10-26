import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { state, consumeEpochChanged, connGrade } from "../sync";
import { einkProfile } from "../prefs";
import Icon from "./Icon";
import styles from "./ConnectionToast.module.css";

// A transient toast for sync health: warns when the live stream drops (the
// store auto-reconnects in the background), and briefly confirms when it
// recovers — so you never need to reload. Debounced so a momentary blip during
// normal reconnects doesn't flash. Also surfaces a server-restart detection
// (Feature 1 / S3): when the daemon generation (epoch) changes across a live
// connection, it restarted while you were connected — the merge-protect in
// applySnapshot already shielded the agent chips, and this toast tells you a
// re-sync is in flight.
//
// TRANSPORT ONLY — this toast reflects the worker SSE stream (sync.ts), NOT
// OpenCode's own health. "Server restarted" here means the vh-solara daemon,
// never OpenCode; OpenCode lifecycle (starting/failed/…) is surfaced separately
// by OpenCodeHealthPanel. Keep the wording topology-agnostic so the two can't
// be conflated.
//
// Slice B (send-net-resilience): keyed on the SHARED graded ConnStatus
// reduction (string-deduped grade — the ~5s health tick re-running the model
// does not re-fire these transitions). "reconnecting" keeps the prior wording
// (tunnel-down / socket reconnecting / post-reconnect convergence pending all
// collapse into it); "offline" gets its own distinct wording (browser has no
// network); the "Reconnected" ok fires at CONVERGENCE — the live grade
// requires the post-reconnect cascade to have completed, so recovery is
// confirmed, not merely socket-open. OBSERVATIONAL ONLY (debate-1 Q5).
//
// E-ink display profile (UX Slice 4 — quiet UI): while the profile is ON the
// auto-expiry timers (4s restart warn / 2.5s "Reconnected" ok) are NOT armed —
// on a slow-refresh panel those windows are unreadable. IMPORTANT notices
// (disconnect/offline/restart warns) persist until RESOLVED (the grade
// returning to live replaces the warn with the recovery ok) or DISMISSED (an
// ON-only × button); the benign recovery ok coalesces into a stable status —
// it stays until dismissed or superseded by the next warn, never piling up
// (the component holds one toast at a time by construction). Profile OFF is
// unchanged: same timers, same wording, no dismiss affordance.
//
// Latent-defect fix riding this slice (disclosed): the epoch/restart branch
// previously consumed the latch (a store write) inside the effect that had
// just read it — Solid's immediate re-run landed in the live branch and
// cleared the toast in the SAME flush, so the restart notice was stillborn
// exactly in its designed firing condition (epoch transition detected on a
// live connection). The epochSelfReentry guard turns that one self-scheduled
// re-run into a no-op; the notice now displays as documented (4s under OFF,
// until-dismissed under ON). Verified against a verbatim HEAD copy of the
// component (scratch probe) before fixing.
//
// (2026-10-25 flake fix, disclosed): a SILENT "degraded" transition no longer
// cancels a pending auto-expiry — live → degraded inside the ok's 2.5s OFF
// window used to orphan the "Reconnected" toast on screen (the expiry was
// cleared, no branch fired). See the guard in the effect below.
//
// (2026-10-26 A-F4, follow-up to that fix — clear-on-cancelled-debounce): a
// degraded landing INSIDE the 1200ms warn debounce is the mirror-image orphan:
// the run cancels the pending replacement warn and fires no branch, so the
// stale ok/restart-warn it was about to replace lingered with ZERO timers.
// The degraded fall-through now clears the toast, FENCED to fire only when a
// debounce was actually cancelled (see the cancelledDebounce capture below).
export default function ConnectionToast() {
  const [toast, setToast] = createSignal<{ kind: "warn" | "ok"; text: string } | null>(null);
  let showTimer: number | undefined;
  let hideTimer: number | undefined;
  let warned = false;
  // True while the 1200ms warn debounce is armed and has NOT yet fired — lets
  // a later effect run distinguish "this run cancelled a pending replacement"
  // (the toast on screen is stale, its replacement is not coming) from "no
  // debounce was pending" (any on-screen toast keeps its own lifecycle).
  let showArmed = false;
  // True only between "the epoch branch armed the restart notice" and the
  // effect re-run that arming ITSELF schedules: consumeEpochChanged() writes
  // state.epochChanged inside the effect that just read it, so Solid re-runs
  // this effect immediately — and that re-run would land in the live branch,
  // CLEAR the just-armed hide timer, and setToast(null): the restart notice
  // was set and hidden-forever in the same flush (a latent stillborn-toast
  // defect at HEAD, verified by component-level probe: latch-while-live, the
  // branch's designed firing condition, never displayed anything). When set,
  // the very next run is a complete NO-OP (timers from the arming run stay
  // armed, the toast stays); every later, genuine transition runs normally.
  let epochSelfReentry = false;

  createEffect(() => {
    // Reactive reads FIRST, on EVERY run — Solid tears an effect's dependency
    // set down before each re-run and re-establishes it only from what the
    // run actually reads. A run that reads nothing (the no-op re-run below)
    // would leave the set EMPTY and permanently kill this effect after the
    // first epoch event (no later warns, no "Reconnected", no profile-flip
    // re-run) — so the reads are hoisted ABOVE the guard, and the guard's
    // early return stays a pure no-op.
    const grade = connGrade();
    const ec = state.epochChanged;
    // The e-ink quiet-UI switch: ON skips every auto-expiry arming below.
    const quiet = einkProfile();
    if (epochSelfReentry) {
      // The one self-scheduled re-run after the epoch latch was consumed:
      // a no-op (timers from the arming run stay armed, the toast stays).
      epochSelfReentry = false;
      return;
    }
    // A-F4: capture whether THIS run cancels a live warn debounce — before
    // the unconditional clear below eats the evidence.
    const cancelledDebounce = showArmed;
    showArmed = false;
    clearTimeout(showTimer);
    // A silent "degraded" transition must NOT cancel a pending auto-expiry:
    // live → degraded (fetch-failure spike / tree-stale) inside the ok's 2.5s
    // OFF window used to orphan the "Reconnected" toast on screen — no branch
    // matches degraded, and an unconditional clear had already killed its
    // expiry (field flake 2026-10-25, e2e preferences.spec.ts:387). Every
    // other transition either replaces/clears the toast immediately (epoch,
    // live) or will replace it after the 1200ms debounce (offline,
    // reconnecting) — cancelling the pending expiry there stays correct.
    if (ec || grade !== "degraded") clearTimeout(hideTimer);
    if (ec) {
      // Consume the latch here (only the toast surfaces it). warned=false so
      // the subsequent live transition does NOT also fire a "Reconnected".
      consumeEpochChanged();
      warned = false;
      epochSelfReentry = true; // the consume-write schedules the no-op re-run
      // Say "vh-solara" explicitly so this can't be read as an OpenCode event
      // (the OpenCodeHealthPanel owns OpenCode lifecycle separately).
      setToast({ kind: "warn", text: "vh-solara restarted — re-syncing…" });
      // Under the profile the restart notice persists until dismissed (there
      // is no distinct resync-complete signal this toast can observe).
      if (!quiet) hideTimer = window.setTimeout(() => setToast(null), 4000);
      return;
    }
    if (grade === "offline") {
      // Only surface if it persists — avoids flashing on a quick recovery.
      showArmed = true;
      showTimer = window.setTimeout(() => {
        showArmed = false;
        warned = true;
        setToast({ kind: "warn", text: "You're offline — waiting for network…" });
      }, 1200);
    } else if (grade === "reconnecting") {
      // Only surface if it persists — avoids flashing on a quick recovery.
      showArmed = true;
      showTimer = window.setTimeout(() => {
        showArmed = false;
        warned = true;
        setToast({ kind: "warn", text: "Connection lost — reconnecting…" });
      }, 1200);
    } else if (grade === "live") {
      if (warned) {
        warned = false;
        setToast({ kind: "ok", text: "Reconnected" });
        // Resolution of the warn above. Under the profile the ok is a stable
        // status (no 2.5s flash): it clears on dismiss or the next warn.
        if (!quiet) hideTimer = window.setTimeout(() => setToast(null), 2500);
      } else {
        setToast(null);
      }
    } else if (grade === "degraded" && cancelledDebounce) {
      // A-F4 (2026-10-26): this run CANCELLED a pending warn debounce (the
      // replacement is not coming) and landed on the silent grade — the toast
      // on screen was content that replacement was about to retire (e.g. the
      // stale "Reconnected" ok after a hard drop whose sub-second recovery
      // landed degraded). Nothing true remains to show: clear it, or it sits
      // orphaned with zero timers until the next grade transition. FENCE:
      // fires ONLY when a debounce was actually cancelled — degraded with NO
      // pending debounce stays the 2026-10-25-protected silent dip (a pending
      // auto-expiry survives untouched), and degraded with toast=null is a
      // no-op. The epoch branch is above this and unaffected (it replaces the
      // toast itself).
      setToast(null);
    }
    // "degraded" without a cancelled debounce is a silent observational
    // grade — no toast, no timer changes.
  });

  // ON-only explicit dismissal: clears the current notice and any pending
  // arming. A warn dismissed while its condition still holds STAYS gone until
  // the grade actually changes (the effect re-fires only on grade/epoch/
  // profile transitions — connGrade is string-deduped), so dismissal never
  // loops.
  const dismiss = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showArmed = false; // a dismissed debounce is cancelled by intent, not orphaned
    setToast(null);
  };

  onCleanup(() => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
  });

  return (
    <Show when={toast()}>
      <div class={styles["conn-toast"]} classList={{ [toast()!.kind]: true }} role="status">
        <Icon name={toast()!.kind === "warn" ? "help" : "check"} size={15} />
        <span>{toast()!.text}</span>
        <Show when={einkProfile()}>
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
