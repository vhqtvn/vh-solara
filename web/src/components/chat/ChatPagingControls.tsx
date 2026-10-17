// ChatPagingControls — the e-ink profile's viewport-paging toolbar (UX
// Slice 1): Prev page / Next page, plus the "New below" chip and a compact
// semantic turn-navigation group for narrow viewports (where the desktop
// right-edge dot navigator does not render).
//
// Device-feedback round 2: the toolbar's own Latest button was REMOVED — it
// duplicated the chat's established "↓ Latest" pill (ChatView's .jump, the
// link interface the operator actually uses), and a second prominent
// jump-to-latest affordance added noise, not reachability. The pill remains
// THE jump-to-latest control (untouched); the "New below" chip — which
// renders exactly while a reader is parked in history during streaming, the
// one moment "take me to the new content" is wanted — is now a real BUTTON
// performing the SAME jumpToLatest (resume follow subject to the existing
// holds). Exactly one in-toolbar jump affordance + the pill: no redundancy.
//
// Presentational only: every action is injected by ChatView, which owns the
// geometry (web/src/lib/paging.ts), the reading-intent integration with the
// existing scroll-follow machine, and the e-ink profile mount gate — this
// component renders ONLY while einkProfile() is ON (ChatView wraps it in a
// <Show>), so profile OFF never mounts these controls or their listeners.
//
// Placement: a RESERVED in-flow toolbar row at the top of .chat-main (see
// ChatPagingControls.module.css) — no occlusion of transcript content or the
// bottom-anchored pills. All targets are ~44 CSS px (brief §2 design
// choice). Prev/Next at their extent are enabled no-ops BY CONTRACT: a
// no-op page action preserves the reader's prior mode.

import { Show, type Accessor, type JSX } from "solid-js";
import Icon from "../Icon";
import styles from "./ChatPagingControls.module.css";

export interface TurnNavBindings {
  // Jump to the previous/next USER turn via the existing navigator machinery
  // (createNavigator's userTurns/activeTurn/jumpToMsg). At the first/last
  // turn the action is a no-op that preserves mode.
  onPrevTurn: () => void;
  onNextTurn: () => void;
  // "3/7"-style position label for the active user turn ("" before the first
  // update).
  position: Accessor<string>;
}

export interface ChatPagingControlsProps {
  onPrevPage: () => void;
  onNextPage: () => void;
  // Jump to the live tail and resume follow — the "New below" chip's action.
  // ChatView passes the SAME jumpToLatest the "↓ Latest" pill uses (subject
  // to the existing holds); the chip renders only while parked in history
  // during streaming, so there is always something below to jump to.
  onLatest: () => void;
  // "New below" chip label while parked in history during streaming, or null
  // when the chip must not render.
  newBelowLabel: Accessor<string | null>;
  // Provided ONLY on narrow viewports (ChatView gates on !isDesktop()): the
  // compact semantic turn navigation that fills the dot-navigator gap.
  turnNav?: TurnNavBindings;
}

export function ChatPagingControls(props: ChatPagingControlsProps): JSX.Element {
  return (
    <div class={styles.bar} data-eink="paging" role="toolbar" aria-label="Chat paging">
      <Show when={props.newBelowLabel()}>
        {(label) => (
          <button
            type="button"
            class={styles.newbelow}
            data-eink="new-below"
            aria-live="polite"
            title="Jump to the latest messages and follow"
            onClick={() => props.onLatest()}
          >
            <Icon name="arrowDown" size={12} />
            {label()}
          </button>
        )}
      </Show>
      <Show when={props.turnNav}>
        {(turns) => (
          <span class={styles.turns}>
            <button
              type="button"
              class={styles.btn}
              data-eink="prev-turn"
              aria-label="Previous turn"
              title="Previous turn"
              onClick={() => turns().onPrevTurn()}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <Show when={turns().position()}>
              {(pos) => (
                <span class={styles.turnLabel} data-eink="turn-pos">
                  {pos()}
                </span>
              )}
            </Show>
            <button
              type="button"
              class={styles.btn}
              data-eink="next-turn"
              aria-label="Next turn"
              title="Next turn"
              onClick={() => turns().onNextTurn()}
            >
              <span aria-hidden="true">›</span>
            </button>
          </span>
        )}
      </Show>
      <button
        type="button"
        class={styles.btn}
        data-eink="prev-page"
        aria-label="Previous page"
        title="Previous page"
        onClick={() => props.onPrevPage()}
      >
        <Icon name="arrowUp" size={16} />
      </button>
      <button
        type="button"
        class={styles.btn}
        data-eink="next-page"
        aria-label="Next page"
        title="Next page"
        onClick={() => props.onNextPage()}
      >
        <Icon name="arrowDown" size={16} />
      </button>
    </div>
  );
}
