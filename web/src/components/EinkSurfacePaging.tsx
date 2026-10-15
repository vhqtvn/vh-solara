// EinkSurfacePaging — the e-ink profile's generic discrete-paging adapter for
// owned scroll surfaces (UX Slice 3): a compact Prev/Next toolbar that steps
// ANY overflowing element through viewport-sized pages along one axis. This is
// the same adapter idiom as UX Slices 1/2 (ChatPagingControls /
// TerminalPanePagingControls), factored because Slice 3 covers several small
// surfaces (session tree, settings dialog body, reasoning bodies, the code
// pane's horizontal overflow, the tag-filter rail) that all share it:
//
//   - GEOMETRY IS lib/paging.ts, REUSED VERBATIM. There is no second paging
//     engine: for the x axis the scroller's (scrollLeft, scrollWidth,
//     clientWidth) triple is MAPPED onto PagingGeometry (see the pure helpers
//     in einkSurfacePagingAxis.ts — the geometry functions are axis-agnostic
//     numbers: scrollTop/scrollHeight/clientHeight in, a clamped target out),
//     written back as scrollLeft. Vertical surfaces
//     map 1:1. Every action measures the CURRENT geometry (the S1
//     "measure-at-action-time" rule), writes INSTANTLY, and is an enabled
//     no-op at its extent (a no-op page action preserves the reader's mode).
//   - PROFILE-SCOPED, DEFAULT OFF. Mount sites gate the whole component on
//     einkProfile() (the ChatPagingControls <Show> idiom), and the action
//     handler double-gates on the profile — profile OFF never mounts these
//     controls, their observers, or their listeners.
//   - FOCUS IS NEVER STOLEN: every button preventDefaults pointerdown (the
//     S2 discipline) so a paging click never moves focus — text selections
//     in a reasoning body, a focused input inside the settings dialog, and
//     dialog focus traps all stay put. Click still fires; keyboard
//     activation (Tab + Enter/Space) is untouched.
//   - VISIBILITY IS OVERFLOW-GATED: the bar renders only while the target
//     actually overflows along the axis (a pager on a surface that fits is
//     dead weight). A ResizeObserver (box changes) plus a childList
//     MutationObserver on the scroller (content growth — under the profile
//     DOM churn is one-shot by design, so this is cheap) refresh the
//     overflow state; a parent-level childList guard re-resolves the target
//     if the scroller element is ever replaced.
//   - ONLY THE INTENDED SURFACE MOVES: the action writes exactly one
//     property (scrollTop or scrollLeft) on exactly one element — the
//     locator-resolved scroller. Paging the settings body cannot scroll the
//     chat behind it; paging a reasoning body cannot scroll the transcript.
//
// Placement contract for mount sites: a RESERVED in-flow row adjacent to the
// scroller (below it, or above the dialog body) — never an overlay, so no
// content is occluded (the S1/S2 "reserve space, never cover" rule). All
// targets are ~44 CSS px (brief §2 design choice).

import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { einkProfile } from "../prefs";
import {
  pageBackward,
  pageForward,
  isEffectivePageMove,
} from "../lib/paging";
import {
  axisGeometry,
  axisOverflows,
  type PagingAxis,
} from "./einkSurfacePagingAxis";
import styles from "./EinkSurfacePaging.module.css";

function applyAxis(el: HTMLElement, axis: PagingAxis, to: number): void {
  if (axis === "x") el.scrollLeft = to; // instant write — never smooth
  else el.scrollTop = to;
}

export interface EinkSurfacePagingProps {
  // Stable surface id for the data-eink-surface seam (e2e locator).
  name: string;
  axis: PagingAxis;
  // Accessible toolbar name (axe/aria; the buttons carry per-axis labels).
  label: string;
  // Resolves the scroller to page. Called at mount (observer attachment),
  // on every observer tick, and AGAIN at each action — the S1
  // resolve-at-action-time rule, so a remounted/replaced scroller is picked
  // up without stale refs.
  target: () => HTMLElement | null | undefined;
}

// The shared button seam (S2 discipline): pointerdown is preventDefaulted so
// a paging click NEVER transfers focus out of whatever owned it (selections,
// dialog inputs, focus traps). Click still fires; keyboard activation is
// untouched.
const noFocusSteal = (e: { preventDefault: () => void }) => e.preventDefault();

export function EinkSurfacePaging(props: EinkSurfacePagingProps): JSX.Element {
  const [overflows, setOverflows] = createSignal(false);
  let barEl: HTMLDivElement | undefined;
  // Set by onMount once the sibling-replacement guard exists: every check()
  // tick (observer or click) also refreshes the guard's observation target —
  // the bar only renders while overflowing, so the guard must retarget from
  // <body> to the bar's parent on the first overflow.
  let guardTick: (() => void) | undefined;

  const check = () => {
    const el = props.target();
    setOverflows(!!el && axisOverflows(el, props.axis));
    guardTick?.();
  };

  onMount(() => {
    let lastEl: HTMLElement | null = null;
    let ro: ResizeObserver | undefined;
    let mo: MutationObserver | undefined;
    // (Re)resolve the scroller: attach the box + content observers to the
    // CURRENT element, dropping any previous pair (idempotent when the
    // element is unchanged).
    const attach = () => {
      const el = props.target() ?? null;
      if (el === lastEl) {
        check();
        return;
      }
      ro?.disconnect();
      mo?.disconnect();
      lastEl = el;
      if (!el) return;
      ro = new ResizeObserver(check);
      ro.observe(el);
      // Content growth changes the scroll extent without resizing the
      // scroller's own box — a childList observer catches it. CLASS changes
      // matter too: the code pane's Wrap control flips a class that re-wraps
      // (and de-overflows) the content without any childList churn. Under
      // the profile, DOM churn is one-shot by design (settled parts,
      // disclosure toggles, section switches), so this observer is quiet.
      mo = new MutationObserver(check);
      mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      check();
    };
    // Guard against sibling REPLACEMENT of the scroller (a Show boundary
    // swapping the element without remounting this bar): a childList observer
    // over the bar's PARENT re-runs attach whenever the parent's direct
    // children change. The bar itself renders only while overflowing, so the
    // guard starts on <body> and retargets to the bar's parent once the bar
    // first mounts — refreshGuard() runs on every observer/click tick.
    const guard = new MutationObserver(attach);
    let guardParent: Node | null = null;
    const refreshGuard = () => {
      const p: Node = barEl?.parentNode ?? document.body;
      if (p === guardParent) return;
      guard.disconnect();
      guard.observe(p, { childList: true });
      guardParent = p;
    };
    refreshGuard();
    attach();
    guardTick = refreshGuard;
    onCleanup(() => {
      ro?.disconnect();
      mo?.disconnect();
      guard.disconnect();
    });
  });

  // One discrete page along the axis: resolve the scroller NOW, measure NOW,
  // step by (usable − bounded overlap), clamp to the extent, write INSTANTLY.
  // At the extent the step is an enabled no-op (preserve-mode contract).
  const step = (dir: 1 | -1) => {
    if (!einkProfile()) return; // profile-scoped (mount sites gate too; double gate)
    const el = props.target();
    if (!el) return;
    const g = axisGeometry(el, props.axis);
    const to = dir > 0 ? pageForward(g) : pageBackward(g);
    if (!isEffectivePageMove(g.scrollTop, to)) return;
    applyAxis(el, props.axis, to);
    check(); // the write may change what overflows means for the next tick
  };

  const prevLabel = props.axis === "x" ? "Page left" : "Page up";
  const nextLabel = props.axis === "x" ? "Page right" : "Page down";

  return (
    <Show when={overflows()}>
      <div
        ref={barEl}
        class={styles.bar}
        data-eink="surface-paging"
        data-eink-surface={props.name}
        data-axis={props.axis}
        role="toolbar"
        aria-label={props.label}
      >
        <button
          type="button"
          class={styles.btn}
          data-eink="surface-prev"
          aria-label={prevLabel}
          title={prevLabel}
          onPointerDown={noFocusSteal}
          onClick={() => step(-1)}
        >
          <span aria-hidden="true">{props.axis === "x" ? "‹" : "↑"}</span>
        </button>
        <button
          type="button"
          class={styles.btn}
          data-eink="surface-next"
          aria-label={nextLabel}
          title={nextLabel}
          onPointerDown={noFocusSteal}
          onClick={() => step(1)}
        >
          <span aria-hidden="true">{props.axis === "x" ? "›" : "↓"}</span>
        </button>
      </div>
    </Show>
  );
}
