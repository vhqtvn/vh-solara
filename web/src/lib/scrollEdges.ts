// Scroll-edge fade — REMOVED.
//
// It used to tag scroll surfaces (.chat-scroll, .reasoning-body, …) with a
// gradient `mask-image` that faded the top/bottom edges. But a CSS mask on a
// scroll container forces Firefox/WebRender to render the WHOLE scrollable
// content to an offscreen surface and re-rasterize it to apply the mask — a
// heavy, near-persistent GPU cost on the always-present chat scroll with a long
// transcript (the real-app heat a bare test page never reproduced). The tagger
// also ran a per-surface MutationObserver(subtree, characterData) that fired on
// every streamed character. Both gone. Kept as a no-op so callers/imports stay
// valid; re-add a cheap edge fade (a small fixed gradient overlay) if wanted.
export function installScrollEdges(): void {
  /* intentionally empty */
}
