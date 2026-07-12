// Global busy scope — coordinates archive/unarchive operations with the stream
// reconciliation layer. While any operation holds the scope, stream.ts suppresses
// reactive store mutation (deferring frames to a coalesced authoritative refresh
// on release). This prevents the archive/unarchive of large session subtrees
// from contending with live stream updates and causing application lag.
//
// Modelled on admin.ts (a Solid signal driving a full-screen overlay) but kept
// separate: restart state is administrative; this coordinates general UI work +
// stream reconciliation. Do NOT expand admin.ts for this.
import { createSignal } from "solid-js";

// True while any operation holds the scope OR the final reconciliation is still
// running. Drives the WorkingOverlay. MUST stay true through reconciliation —
// not just while the HTTP request is pending — so the overlay doesn't flash
// off between the operation completing and the fresh snapshots landing.
const [busy, setBusy] = createSignal(false);

// Reference count of active operations. 0 = idle.
let refCount = 0;
// True while the coalesced reconciliation (fresh tree + session snapshot) is
// running. Distinct from refCount>0: reconciliation starts AFTER the last
// operation releases, and busy must stay true until it completes.
let reconciling = false;
// Latched by stream.ts when a deferred frame arrives during reconciliation,
// signalling that one more coalesced authoritative pass is needed (at most one
// extra pass — the dirty-pass rule).
let dirty = false;
// Monotonic epoch incremented when the gate activates (first acquire) and at the
// start of each reconcile pass. Async work (gzip64 snapshot/batch decodes)
// captures this and refuses to mutate the store if the epoch changed — an
// obsolete decode (e.g. one that started before the gate activated) must NOT
// clobber state or clear the overlay.
let gateEpoch = 0;

// The one-shot reconciliation callback registered by sync/stream.ts. Called on
// the outermost release; requests fresh tree + selected-session snapshots.
let reconcileFn: (() => Promise<void>) | null = null;

/** Reactive accessor for the global overlay (busy OR reconciling). */
export function globalBusy(): boolean {
  return busy();
}

/** True while the stream gate should suppress store mutation. */
export function isGateActive(): boolean {
  return refCount > 0 || reconciling;
}

/** Current gate epoch — captured by async decodes to detect staleness. */
export function currentGateEpoch(): number {
  return gateEpoch;
}

/** Called by stream.ts when a deferred frame arrives during reconciliation. */
export function markBusyDirty(): void {
  if (reconciling) dirty = true;
}

/** Register (or clear) the stream reconciliation callback. */
export function setReconcileFn(fn: (() => Promise<void>) | null): void {
  reconcileFn = fn;
}

/**
 * Acquire the global busy scope for the duration of `operation`. The overlay
 * shows immediately and stays visible through the coalesced reconciliation that
 * runs on the outermost release. Nested acquisitions keep the overlay visible;
 * only the final release triggers reconciliation. try/finally guarantees the
 * scope is released even if the operation throws.
 */
export async function withGlobalBusy<T>(operation: () => Promise<T>): Promise<T> {
  if (refCount === 0) {
    // Gate activating — bump the epoch so in-flight async decodes become stale.
    gateEpoch++;
    setBusy(true);
  }
  refCount++;
  try {
    return await operation();
  } finally {
    refCount--;
    if (refCount === 0) {
      await runReconcile();
    }
  }
}

// On the outermost release, run the coalesced authoritative refresh: one fresh
// tree snapshot + one fresh selected-session snapshot. If deferred frames
// arrived during the pass and latched dirty, allow at most ONE additional
// coalesced pass (the dirty-pass rule). If a new operation acquires during
// reconciliation, stop — it will reconcile on its own release.
async function runReconcile(): Promise<void> {
  // Non-reentrant guard: if reconciliation is already in progress (e.g. a
  // second operation released while the first's reconcile is still awaiting
  // fresh snapshots), don't start a second loop — mark dirty so the existing
  // loop does another pass. Without this, two overlapping runReconcile calls
  // clobber each other's reconciling/dirty/busy state.
  if (reconciling) {
    dirty = true;
    return;
  }
  for (let pass = 0; pass < 2; pass++) {
    reconciling = true;
    gateEpoch++;
    dirty = false;
    if (reconcileFn) {
      try {
        await reconcileFn();
      } catch {
        /* reconciliation errors are non-fatal — the stream self-heals */
      }
    }
    // A new operation acquired the gate during reconciliation — clear
    // reconciling so the new operation's release can start a fresh loop.
    // Keep busy true (refCount > 0 holds it).
    if (refCount > 0) {
      reconciling = false;
      return;
    }
    if (!dirty) break;
  }
  reconciling = false;
  if (refCount === 0) setBusy(false);
}
