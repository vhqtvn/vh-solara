// TerminalPanePagingControls — the e-ink profile's terminal history-paging
// toolbar (UX Slice 2): Older / Newer / Latest over the xterm NORMAL-buffer
// scrollback. Presentational only, mirroring the ChatPagingControls design
// language (UX Slice 1): every action is injected by TerminalPane, which owns
// the xterm instance, the line-domain paging geometry, and the e-ink profile
// mount gate — this component renders ONLY while einkProfile() is ON
// (TerminalPane wraps it in a <Show>), so profile OFF never mounts these
// controls or their listeners.
//
// Semantics (the xterm 6 seam, inspected in web/node_modules/@xterm/xterm):
//  - Older/Newer page through the normal buffer via the documented viewport
//    APIs (scrollLines/scrollToBottom). These never write to the PTY/ws —
//    zero terminal bytes — and never reconnect or remount the pane.
//  - FOCUS IS NEVER STOLEN: every button preventDefaults pointerdown, the
//    default action that would transfer focus from the xterm textarea to
//    the button. Refocusing after a click is NOT an option — when the
//    application has enabled focus reporting (DECSET 1004, common in
//    vim/less/tmux), a blur+refocus pair emits ESC[O / ESC[I through
//    xterm's triggerDataEvent → onData → ws.send, i.e. PTY bytes from a
//    paging action, violating the zero-bytes contract. Keeping focus in
//    the terminal emits nothing; the click still fires normally, and the
//    buttons stay keyboard-reachable (Tab/Enter/Space focus them only by
//    explicit keyboard navigation).
//  - An upward page marks the reader "parked" in history (xterm's
//    isUserScrolling): new streamed output keeps the viewport parked instead
//    of jumping to the tail; Latest (and any Newer page that reaches the
//    tail) resumes following. data-parked exposes the state for diagnostics.
//  - ALTERNATE BUFFER (full-screen apps, DECSET 47/1047/1049): the alt
//    buffer has no scrollback (BufferSet gives it maxLength = rows), so
//    history paging is impossible there. While an app owns the alt screen
//    every button is disabled and a visible explanation renders; leaving
//    alt-screen restores the controls. Detected ONLY through
//    term.buffer.onBufferChange / buffer.active.type — never by intercepting
//    escape sequences.
//  - Older/Newer stay ENABLED no-ops at their extent (the chat toolbar's
//    contract: a no-op page action preserves the reader's mode); Latest is
//    disabled while already at the tail.
//
// Placement: a RESERVED in-flow row at the top of .term (the flex column;
// .term-host is flex:1 and yields the height) — no occlusion of terminal
// content, matching the chat toolbar's "reserve space, never cover" rule.
// All targets are ~44 CSS px (the brief's design choice).

import { Show, type Accessor, type JSX } from "solid-js";
import Icon from "./Icon";
import styles from "./TerminalPanePagingControls.module.css";

export interface TerminalPanePagingControlsProps {
  onPrev: () => void;
  onNext: () => void;
  onLatest: () => void;
  // True while the viewport is parked in history (viewportY < baseY) —
  // gates the Latest button (nothing to resume while at the tail).
  parked: Accessor<boolean>;
  // True while the application owns the ALTERNATE buffer (full-screen app):
  // history paging is unavailable and every button is disabled with the
  // visible explanation below.
  alt: Accessor<boolean>;
}

// The shared button seam: pointerdown is preventDefaulted so a pointer click
// NEVER transfers focus out of the xterm textarea (the DECSET 1004 focus-
// reporting hazard — see the header comment). Click still fires; keyboard
// activation (Tab + Enter/Space) is untouched.
const noFocusSteal = (e: { preventDefault: () => void }) => e.preventDefault();

export function TerminalPanePagingControls(props: TerminalPanePagingControlsProps): JSX.Element {
  return (
    <div
      class={styles.bar}
      data-eink="term-paging"
      data-parked={props.parked() ? "true" : "false"}
      data-alt={props.alt() ? "true" : "false"}
      role="toolbar"
      aria-label="Terminal history"
    >
      <Show when={props.alt()}>
        <span class={styles.altNote} data-eink="term-alt-note" role="status">
          Full-screen app active — history unavailable
        </span>
      </Show>
      <button
        type="button"
        class={styles.btn}
        data-eink="term-prev"
        aria-label="Older history"
        title="Page up through terminal history"
        disabled={props.alt()}
        onPointerDown={noFocusSteal}
        onClick={() => props.onPrev()}
      >
        <Icon name="arrowUp" size={16} />
      </button>
      <button
        type="button"
        class={styles.btn}
        data-eink="term-next"
        aria-label="Newer history"
        title="Page down through terminal history"
        disabled={props.alt()}
        onPointerDown={noFocusSteal}
        onClick={() => props.onNext()}
      >
        <Icon name="arrowDown" size={16} />
      </button>
      <button
        type="button"
        class={`${styles.btn} ${styles.latest}`}
        data-eink="term-latest"
        aria-label="Latest"
        title="Jump to the latest output and follow"
        disabled={props.alt() || !props.parked()}
        onPointerDown={noFocusSteal}
        onClick={() => props.onLatest()}
      >
        <Icon name="arrowDown" size={14} />
        <span class={styles.latestText}>Latest</span>
      </button>
    </div>
  );
}
