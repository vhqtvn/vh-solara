import { createEffect, createSignal, onCleanup } from "solid-js";
import { formatAgo, formatShort, registerRelTime } from "../lib/time";
import { einkProfile } from "../prefs";

// A self-refreshing relative-time label. All instances share one interval and
// (at scale) update only while on screen — see lib/time.ts. Re-renders both on
// the shared tick and whenever `ms` changes (e.g. a session/message updates).
//
// E-ink display profile (UX Slice 4 — quiet UI): while the profile is ON this
// label does NOT register with the shared re-render interval — a periodic
// repaint of "5m ago" is gratuitous churn on a slow-refresh panel. Quiet ≠
// silent: meaningful updates are preserved — the first render (computed at
// creation), every `ms` change (the effect below), and one catch-up refresh
// at the moment the interval goes QUIET on an OFF→ON toggle. On the reverse
// (ON→OFF) toggle the label re-registers and updates resume on the next
// shared tick (≤15s later — no forced refresh at resume). Profile OFF
// registers exactly as before (byte-identical ticking).
export default function RelTime(props: { ms?: number; mode?: "short" | "ago"; class?: string }) {
  let el: HTMLSpanElement | undefined;
  const fmt = () => (props.mode === "ago" ? formatAgo : formatShort)(props.ms, Date.now());
  const [text, setText] = createSignal(fmt());
  const refresh = () => setText(fmt());

  // Recompute immediately when the underlying timestamp changes.
  createEffect(() => {
    props.ms;
    refresh();
  });

  let unregister: (() => void) | undefined;
  createEffect(() => {
    if (einkProfile()) {
      // ON: drop any prior registration (a mid-life ON toggle), leave the
      // label current at the moment the ticking goes quiet, and stop there.
      unregister?.();
      unregister = undefined;
      refresh();
      return;
    }
    // OFF: the shared 15s tick — the unchanged pre-profile path.
    unregister?.();
    unregister = registerRelTime(refresh, () => el);
  });
  onCleanup(() => unregister?.());

  return (
    <span class={props.class} ref={el}>
      {text()}
    </span>
  );
}
