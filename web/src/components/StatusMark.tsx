import BrandMark from "./BrandMark";

// Connection-health STATUS MARK for the sidebar header — the VHSolara glyph
// ITSELF carries the connection state (5 states), replacing the former separate
// BrandMark logo + .status-ind pill. The markup is CONSTANT: the glyph plus
// every effect layer (halo / orbital / scan / status-core / packets / sparks)
// is always present; a single state class on the root drives all color + motion
// via CSS (see `.status-mark` in styles.css). Layers not used by the active
// state rest at opacity:0 in the base CSS and are revealed only by their state
// rule, so state transitions never mount/unmount spans (matching the former
// .status-ind pattern and avoiding transition flicker).
//
// The semantic state carrier is the `.status-core` corner badge — its
// ::before/::after draw the state glyph (check / clock / arrows / exclamation)
// from STATIC state rules, so it still reads with motion off (reduced-motion /
// e-ink). The orbiting packets / sparks are decorative and simply hidden then.
//
// role="img" + aria-label expose the state to screen readers without a chatty
// live region (read on traversal, not announced on every change). data-tip
// carries the same "Status: …" string for the hover/focus tooltip.
//
// Layers rendered (all always present; CSS hides the unused per state):
//  • BrandMark (class "brand-mark") — the recolorable glyph (fill: currentColor,
//    so it takes the root's per-state --status color).
//  • halo — a thin status-colored ring (solid arc; dashed + drifting in stale).
//  • orbital — a counter-rotating accent arc (syncing / reconnecting only).
//  • scan — a conic sweep ring (connecting only).
//  • status-core — the corner badge whose ::before/::after are the state glyph.
//  • packet.a/b/c — orbiting dots (connecting / syncing).
//  • spark.a/b/c — a burst (reconnecting).
export default function StatusMark(props: { state: string; tip: string }) {
  return (
    <span
      class="status-mark"
      classList={{ [props.state]: true }}
      role="img"
      aria-label={props.tip}
      data-tip={props.tip}
    >
      <BrandMark class="brand-mark" />
      <span class="halo" />
      <span class="orbital" />
      <span class="scan" />
      <span class="status-core" />
      <span class="packet a" />
      <span class="packet b" />
      <span class="packet c" />
      <span class="spark a" />
      <span class="spark b" />
      <span class="spark c" />
    </span>
  );
}
