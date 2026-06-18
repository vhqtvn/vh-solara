import { For } from "solid-js";

// Working/busy spinner ported from opencode web's sidebar session list: a 4×4
// grid of rounded squares whose inner/outer cells pulse opacity at randomized
// delays, with the corners hidden — a soft shimmering block rather than a
// blinking dot.
const outer = new Set([1, 2, 4, 7, 8, 11, 13, 14]);
const corner = new Set([0, 3, 12, 15]);
const squares = Array.from({ length: 16 }, (_, i) => ({
  x: (i % 4) * 4,
  y: Math.floor(i / 4) * 4,
  delay: Math.random() * 1.5,
  duration: 1 + Math.random(),
  outer: outer.has(i),
  corner: corner.has(i),
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
        {(s) => (
          <rect
            x={s.x}
            y={s.y}
            width="3"
            height="3"
            rx="1"
            style={
              s.corner
                ? { opacity: 0 }
                : {
                    animation: `${s.outer ? "spin-pulse-dim" : "spin-pulse"} ${s.duration}s ease-in-out infinite`,
                    "animation-fill-mode": "both",
                    "animation-delay": `${s.delay}s`,
                  }
            }
          />
        )}
      </For>
    </svg>
  );
}
