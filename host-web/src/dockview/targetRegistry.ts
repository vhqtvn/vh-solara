// =============================================================================
// REMOVED — tabs=panes=windows model (P4 reframe).
//
// The targetRegistry layer (AttentionTarget/TabRecord/visit/dedupe/caps/LRU/
// age/pin/dismiss/titleSource) was the Fork B "many targets, few panes"
// abstraction. After on-device operator testing it was REJECTED in favor of
// tabs=panes=windows (browser-tab style): the tabstrip shows panes directly
// (one tab per pane), and there is NO separate target registry. This file is
// intentionally hollow — no exports, no module-level coldLoad, no localStorage
// persistence. The `vh-host:targets:v1` key is no longer read or written; any
// stale blob from a prior version is ignored (harmless dead data in localStorage).
//
// The per-pane needs-you badge (P1 attention layer) is retained — it reads the
// pane's current session status directly from the store (statusFor), not from
// a registry. The honest-status invariant is naturally satisfied: the status is
// per-pane and always reflects the latest reported session.
// =============================================================================
export {};
