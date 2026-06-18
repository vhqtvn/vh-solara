import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { formatAgo, formatShort, registerRelTime } from "../lib/time";

// A self-refreshing relative-time label. All instances share one interval and
// (at scale) update only while on screen — see lib/time.ts. Re-renders both on
// the shared tick and whenever `ms` changes (e.g. a session/message updates).
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

  onMount(() => {
    const unregister = registerRelTime(refresh, () => el);
    onCleanup(unregister);
  });

  return (
    <span class={props.class} ref={el}>
      {text()}
    </span>
  );
}
