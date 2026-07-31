// Load-older controller — the historical-page prepend state + single-flight
// action, extracted from ChatView (mirroring the other create... controller
// factories: createComposerAutocomplete / createAttachments / createComposerPaste
// / createPromptHistory / createQueueSync / createQueueRecovery / createSend /
// createMessageActions / createNavigator).
//
// The factory owns the load-older concern's REACTIVE derived state read off the
// sync store (`win` / `hasOlder` / `loadingOlder`) and the single-flight action
// (`onLoadOlder`): capture the read-mode anchor, then fetch one older page via
// `loadOlder` (sync/history.ts owns the actual fetch/merge/gate; stream.ts's
// `pageInFlight` is the authoritative single-flight, this store signal is the
// UI-facing mirror that gates BOTH the IO callback and the button).
//
// SCROLL-SURFACE BOUNDARY — what stays in ChatView:
//   • `captureAnchorBeforeLoadOlder` (the geometry capture) is NOT moved here.
//     It writes `restoredAnchorId`/`restoredAnchorOffset`, the SAME two locals
//     the contentEl ResizeObserver's read-mode `restoredAnchorId` branch reads
//     to mechanically correct scrollTop through the prepend (ChatView ~L813-828).
//     It also reads five scroll-surface-coupled locals (scrollEl, following(),
//     bottommostReadFromDom(), messages(), anchorContentOffset()). Moving it
//     would force a 6+-dep surface across the scroll seam. Instead it is injected
//     here as `deps.captureAnchor` — the controller calls it synchronously before
//     the fetch, staying decoupled from scrollEl geometry + the anchor-restore
//     seam. This mirrors createMessageActions.injected `resendText` (the send
//     controller's public surface) and createNavigator.injected `cssEsc`.
//   • `topSentinelEl` / `loadMoreObserver` refs + the sentinel IntersectionObserver
//     onMount/onCleanup (rooted at `.chat-scroll`) + the load-more JSX stay in
//     ChatView — they are coupled to the scroll surface (the IO root is scrollEl).
//
// Behavior-preserving extraction: bodies moved verbatim from ChatView, only
// `props.sessionId` → `deps.sessionId()` and the inline `captureAnchorBeforeLoad
// Older()` call → `deps.captureAnchor()`.

import type { Accessor } from "solid-js";
import { loadOlder, state } from "../../sync";
import type { MessageWindowState } from "../../sync/store";

export interface LoadOlderDeps {
  // Session id for the windowed transcript (win/hasOlder/loadingOlder key off
  // state.messageWindows[sessionId()]).
  sessionId: Accessor<string>;
  // Scroll-surface-coupled anchor capture (ChatView's captureAnchorBeforeLoad
  // Older). Writes restoredAnchorId/restoredAnchorOffset — the locals the
  // contentEl RO restore branch reads to correct scrollTop through the prepend.
  // Injected as a callback so this controller never touches scrollEl geometry or
  // the anchor-restore seam. Called SYNCHRONOUSLY before the fetch so the
  // read-mode anchor is recorded before the prepend mutates the transcript; a
  // no-op in tail mode (following) where there is nothing to preserve.
  captureAnchor: () => void;
}

export interface LoadOlderController {
  // The per-session window meta (hasOlder / loadingOlder / oldestResidentID).
  win: Accessor<MessageWindowState | undefined>;
  // Server says older messages exist beyond the resident tail → drives the
  // affordance + sentinel visibility.
  hasOlder: Accessor<boolean>;
  // A historical page request is in flight → drives the button spinner/disabled
  // state + the IO single-flight guard.
  loadingOlder: Accessor<boolean>;
  // Load-older action: single-flight guard → capture read-mode anchor → fetch
  // one older page. Called from the button onClick AND the sentinel IO callback
  // (both in ChatView).
  onLoadOlder: () => Promise<void>;
}

export function createLoadOlder(deps: LoadOlderDeps): LoadOlderController {
  const win = () => state.messageWindows[deps.sessionId()];
  const hasOlder = () => !!win()?.hasOlder;
  const loadingOlder = () => !!win()?.loadingOlder;

  async function onLoadOlder() {
    if (loadingOlder()) return; // single-flight guard (mirrors pageInFlight)
    deps.captureAnchor();
    await loadOlder(deps.sessionId());
  }

  return { win, hasOlder, loadingOlder, onLoadOlder };
}
