import { For } from "solid-js";

// Working/busy spinner (opencode-web's sidebar grid): a 4×4 block of rounded
// squares with the corners hidden.
//
// The cells used to each animate `opacity` on their own randomized keyframes.
// That's a per-frame MAIN-THREAD repaint on Firefox: an <svg> renders as a
// WebRender blob image, and animating its children re-rasterizes the whole blob
// every frame — and because the spinner is always on screen while a session is
// busy (sidebar + tools), that per-frame paint forces the page's display list to
// rebuild continuously (it dominated the streaming-CPU profile). So instead the
// cells get STATIC opacities (a textured block) and the whole element breathes
// via a single `opacity` animation in CSS, which the compositor runs on the GPU
// without re-rasterizing — see [data-component="spinner"] in styles.css.
const outer = new Set([1, 2, 4, 7, 8, 11, 13, 14]);
const corner = new Set([0, 3, 12, 15]);
const squares = Array.from({ length: 16 }, (_, i) => ({
  x: (i % 4) * 4,
  y: Math.floor(i / 4) * 4,
  opacity: corner.has(i) ? 0 : outer.has(i) ? 0.4 : 0.9,
}));

export default function Spinner(props: { class?: string; size?: number }) {
  return (
    <svg
      class={props.class}
      width={props.size ?? 11}
      height={props.size ?? 11}
      viewBox="0 0 15 15"
      data-component="spinner"
      fill="currentColor"
      aria-hidden="true"
    >
      <For each={squares}>
        {(s) => <rect x={s.x} y={s.y} width="3" height="3" rx="1" opacity={s.opacity} />}
      </For>
    </svg>
  );
}
