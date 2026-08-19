// Shared embed gate for the single-server SPA.
//
// The SPA is "embedded" when its document runs inside the host shell's iframe
// (`window.parent !== window`) — the post-fold default: the SPA at /app is
// embedded same-origin by the host shell at /. This module is the ONE source
// of truth for that check; embed-aware modules (heartbeat, statusEmitter,
// selectListener, hostGesture, prefs) import it instead of each re-deriving
// the raw comparison. The inbound source-guards (`ev.source !== window.parent`)
// in those modules are a DIFFERENT check (message authenticity, not embed
// status) and stay local to them.
//
// Deliberately a plain per-call function — NOT a cached module-init const and
// NOT a Solid signal:
// - per-call preserves the pre-refactor semantics exactly: every former call
//   site evaluated the comparison at call time (each start*() gate evaluates
//   at startup; prefs.ts applyScale() re-evaluates on every reactive apply).
//   The property read is free and embedding status is stable per document,
//   so caching would buy nothing.
// - no reactive need exists today; a future reactive signal (e.g. an S2 shape
//   tier signal) will be its own thing built on this seam.
// Guarded for non-DOM (node unit-test) contexts, matching the guard prefs.ts
// formerly inlined: no window → NOT embedded.

/** True when this SPA document runs inside a parent frame (the host shell). */
export function isEmbedded(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}
