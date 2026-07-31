// ChatNavigator — the right-edge user-turn jump strip, extracted verbatim from
// ChatView.tsx (the former ~L1537-1581 inline JSX). Presentational only: it
// reads reactive state + actions from a NavigatorController (created by
// createNavigator in ChatView) and renders the dots, the hover/focus preview
// bubble, click-to-jump, and the up/down chevrons.
//
// Behavior-preserving extraction — no CSS changes (the .chat-nav* classes stay
// global in the legacy shards; GPU-heat invariants unchanged), no wrapper added.
// The desktop + >1-user-turn render gate moved with the JSX: this component
// renders nothing when off-desktop or there is at most one user turn.
//
// Pinned by web/tests/unit/ChatViewNavigator.test.tsx (mounts the REAL ChatView,
// so this component is exercised through its parent — dot count/order, active
// tracking, centered window + chevrons, click-to-jump, hover/focus bubble
// lifecycle, and rAF coalescing).

import { For, Show, type JSX } from "solid-js";
import Icon from "../Icon";
import { isDesktop } from "../../layout";
import type { NavigatorController } from "./createNavigator";

export interface ChatNavigatorProps {
  // The navigator controller (created once per ChatView mount via
  // createNavigator). A stable object reference, not a reactive primitive, so
  // binding it once is safe; all reactivity flows through its signals/actions.
  navigator: NavigatorController;
}

export function ChatNavigator(props: ChatNavigatorProps): JSX.Element {
  const nav = props.navigator;
  return (
    <Show when={isDesktop() && nav.userTurns().length > 1}>
      <div class="chat-nav" aria-label="Jump to a turn">
        <Show when={nav.navWindow().start > 0}>
          <button
            type="button"
            class="chat-nav-more up"
            title={`${nav.navWindow().start} earlier turn${nav.navWindow().start > 1 ? "s" : ""}`}
            aria-label={`${nav.navWindow().start} earlier turns`}
            onClick={() => nav.jumpToMsg(nav.userTurns()[Math.max(0, nav.navWindow().start - 1)].id)}
          >
            <Icon name="chevronDown" size={11} />
          </button>
        </Show>
        <For each={nav.navWindow().items}>
          {(m) => (
            <button
              type="button"
              class="chat-nav-dot"
              classList={{ active: nav.activeTurn() === m.id }}
              aria-label={nav.turnText(m)}
              aria-current={nav.activeTurn() === m.id ? "true" : undefined}
              onClick={() => nav.jumpToMsg(m.id)}
              onMouseEnter={(e) => nav.setNavPreview({ text: nav.turnText(m), y: e.currentTarget.offsetTop + e.currentTarget.offsetHeight / 2 })}
              onMouseLeave={() => nav.setNavPreview(null)}
              onFocus={(e) => nav.setNavPreview({ text: nav.turnText(m), y: e.currentTarget.offsetTop + e.currentTarget.offsetHeight / 2 })}
              onBlur={() => nav.setNavPreview(null)}
            />
          )}
        </For>
        <Show when={nav.navWindow().end < nav.navWindow().total}>
          <button
            type="button"
            class="chat-nav-more"
            title={`${nav.navWindow().total - nav.navWindow().end} more turn${nav.navWindow().total - nav.navWindow().end > 1 ? "s" : ""}`}
            aria-label={`${nav.navWindow().total - nav.navWindow().end} more turns`}
            onClick={() => nav.jumpToMsg(nav.userTurns()[Math.min(nav.navWindow().total - 1, nav.navWindow().end)].id)}
          >
            <Icon name="chevronDown" size={11} />
          </button>
        </Show>
        <Show when={nav.navPreview()}>
          {(pv) => <div class="chat-nav-bubble" style={{ top: `${pv().y}px` }}>{pv().text}</div>}
        </Show>
      </div>
    </Show>
  );
}
