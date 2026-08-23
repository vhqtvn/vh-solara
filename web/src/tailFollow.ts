// Chat tail-follow bridge: a tiny module-level seam that lets out-of-component
// code (the embed-gated statusEmitter + the host-driven tailListener) read and
// drive the ACTIVE ChatView's tail-follow state WITHOUT prop-drilling or a
// sync-store field (tail-follow is ephemeral view state, not session state).
//
// Why a bind seam instead of an exported store field: `following` is a local
// signal owned by ChatView (web/src/components/ChatView.tsx), whose value is
// written by the scroll classifier + several self-heal sites. The least
// invasive exposure is a late-bound accessor + force handler registered by the
// mounted ChatView and cleared on unmount. App.tsx mounts EXACTLY ONE ChatView
// at a time (draft XOR session, in a Switch), so last-bind-wins is the single
// active instance by construction.
//
// Semantics:
//   - `chatTailFollowing()` → the bound ChatView's following() (true = glued to
//     the tail); `true` when unbound (no chat mounted / standalone — nothing is
//     being not-followed, so the honest default is "on").
//   - `forceChatTailFollow()` → runs the bound ChatView's jumpToLatest() (the
//     SPA's own "↓ Latest" code path: setFollowing(true) + clear the intent
//     latch/input veto + pin()). Returns false when no ChatView is bound (the
//     caller treats it as a no-op).
//
// FORCE-UNFOLLOW IS DELIBERATELY NOT EXPRESSED (read-first verdict, tail
// feature): ChatView has no native unfollow action, and flipping following=false
// while scrolled at the bottom is not durable — the scrollEl ResizeObserver's
// bug-2b recovery re-engages it on the next viewport resize (composer autosize
// fires on every keystroke; that branch checks only prevGap<64 && nearBottom(),
// NOT the intent latch or input veto), the busy→idle recovery re-engages it
// (gap<200 at the bottom), and any scroll event landing at the bottom
// re-engages it. The shipped surface is indicator + force-follow only.

/** The bound active ChatView seam (accessor + force handler), or null. */
let bound: { following: () => boolean; forceFollow: () => void } | null = null;

/**
 * The active chat's tail-follow state. True when glued to the tail (Live) or
 * when no chat is mounted (the honest "on" default — there is no transcript
 * being read mid-history). Read by statusEmitter's 1 Hz tick.
 */
export function chatTailFollowing(): boolean {
  return bound ? bound.following() : true;
}

/**
 * Force the active chat back onto the tail — the SPA's own "↓ Latest"
 * jumpToLatest() code path, driven from the host's tail command. Returns true
 * when a ChatView was bound and the jump ran; false when no chat is mounted
 * (caller no-ops).
 */
export function forceChatTailFollow(): boolean {
  if (!bound) return false;
  bound.forceFollow();
  return true;
}

/**
 * Bind the ACTIVE ChatView's following signal + jump-to-latest action to this
 * bridge. Called once from ChatView's root scope; the returned disposer clears
 * the binding (ChatView wires it into onCleanup, which restores the honest
 * unbound default). No createEffect here on purpose: the bridge only forwards
 * reads, so it stays usable from non-reactive contexts (the emitter's interval
 * tick, the message listener) and from unit tests without a reactive root.
 */
export function bindChatTail(
  following: () => boolean,
  forceFollow: () => void,
): () => void {
  bound = { following, forceFollow };
  return () => {
    bound = null;
  };
}
