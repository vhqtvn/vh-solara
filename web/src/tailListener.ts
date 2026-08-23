// Host→pane tail/follow command listener (embed-gated) for the production SPA.
//
// Mirrors web/src/selectListener.ts structure EXACTLY (P4 reverse-nav pattern):
//   - embed gate (`window.parent === window` → no-op standalone);
//   - inbound source-guard (`ev.source !== window.parent` → reject, BEFORE any
//     state mutation — only the actual parent window may drive a tail command;
//     an untrusted sibling pane that grabbed this window's WindowProxy via
//     window.parent.frames[index] cannot hijack the chat's follow state);
//   - payload allowlist to {type:'vh-host-tail', following: boolean} ONLY (the
//     CF1 closed-payload pattern — every other field is ignored; a poison
//     access_token / debug flag in the payload never reaches the dispatch).
//
// DISPATCH TABLE (read-first gate verdict):
//   - following:true  → force follow. Dispatches to the active ChatView's
//     jumpToLatest() — the SPA's own "↓ Latest" code path (setFollowing(true) +
//     clear the intent latch/input veto + pin). Composes cleanly: an external
//     force-follow is indistinguishable from the operator clicking the pill
//     inside the pane. No-op when no chat is mounted (forceChatTailFollow
//     returns false).
//   - following:false → validated but NOT dispatched. ChatView has no native
//     unfollow action, and flipping following=false while scrolled at the
//     bottom is NOT durable: the scrollEl ResizeObserver's bug-2b recovery
//     re-engages it on the next viewport resize (composer autosize fires on
//     every keystroke; that branch checks only prevGap<64 && nearBottom(), not
//     the intent latch or the Approach-A input veto), the busy→idle turn-finish
//     recovery re-engages it (gap < 200 at the bottom), and any scroll event
//     landing at the bottom re-engages it. Shipping a silently-undone toggle
//     would be worse than not shipping it — the host UI exposes indicator +
//     "Jump to latest" only, and this listener keeps honoring the closed
//     payload contract for forwards-compatibility.
//
// No REPLY is posted here (mirrors selectListener): the round-trip signal is
// the statusEmitter's existing {type:"status"} emission, whose idempotence key
// now includes `following` — a successful jump lands following=true and the
// next 1 Hz tick reports it to the host.

import { isEmbedded } from "./embedded";
import { forceChatTailFollow } from "./tailFollow";

export const TAIL_TYPE = "vh-host-tail";

interface HostTailMessage {
  type: "vh-host-tail";
  following: boolean;
}

/**
 * Validate that a payload is an allowlisted {type:'vh-host-tail',following}
 * carrying ONLY a boolean `following` (CF1: every other field is ignored, never
 * forwarded into dispatch). Returns the typed message or null when the payload
 * is out-of-contract. Mirrors the closed-vocabulary discipline of the route
 * allowlist (heartbeat.ts `allowlistRoute`) and asHostSelect.
 */
function asHostTail(data: unknown): HostTailMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<HostTailMessage> & Record<string, unknown>;
  if (d.type !== TAIL_TYPE) return null;
  // Allowlist: following MUST be a boolean; reject anything else (a poison
  // field like access_token is ignored — it never reaches the dispatch).
  if (typeof d.following !== "boolean") return null;
  return { type: TAIL_TYPE, following: d.following };
}

/**
 * Dispatch a validated tail command. Only the follow (true) path is dispatched
 * — see the module header for the read-first verdict on force-unfollow.
 */
function dispatchTail(tail: HostTailMessage): void {
  if (!tail.following) return; // validated but not dispatched (not durable)
  forceChatTailFollow();
}

/**
 * Install the embed-gated host→pane tail listener. Returns a disposer that
 * removes the listener (the listener otherwise lives for the document lifetime;
 * a reload re-runs this module → a fresh listener). No-op when standalone
 * (returns undefined, mirroring startSelectListener's embed gate). Wire
 * alongside startSelectListener() in index.tsx.
 */
export function startTailListener(): (() => void) | undefined {
  if (typeof window === "undefined") return;
  // Constraint #1 (mirror selectListener/heartbeat): embed gate. Do nothing
  // standalone — the common single-server case has no host to drive a tail.
  if (!isEmbedded()) return;

  const onMessage = (ev: MessageEvent): void => {
    // F1 (mirror selectListener): inbound source-guard, BEFORE any state
    // mutation. Only the actual parent window may drive a tail command; an
    // untrusted sibling pane that grabbed this window's WindowProxy must not
    // hijack the chat's follow state. event.source for a real host tail is
    // window.parent.
    if (ev.source !== window.parent) return;
    const tail = asHostTail(ev.data);
    if (!tail) return; // CF1 allowlist: non-contract payloads are ignored entirely.
    dispatchTail(tail);
  };
  window.addEventListener("message", onMessage);

  return () => {
    window.removeEventListener("message", onMessage);
  };
}
