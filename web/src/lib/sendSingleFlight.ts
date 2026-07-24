// Per-key single-flight guard for the chat ENQUEUE path.
//
// PROBLEM (the duplicate-send-on-slow-network bug): on a weak/hung network the
// enqueue POST can take up to ENQUEUE_TIMEOUT_MS (12s, queue.ts) to resolve.
// During that window the composer text is deliberately NOT cleared (no-loss
// invariant) and no queue chip appears yet (the cache push in queue.ts:enqueue
// only fires on success), so the operator sees no feedback and re-taps Send
// (or re-presses Enter). Each re-tap spawns a PARALLEL enqueue POST; when the
// network settles, all N land → N identical queued messages dispatch.
//
// FIX: a per-session guard that (1) surfaces an immediate "sending" signal so
// the operator sees the tap registered, and (2) drops any additional send
// attempt while one is already in-flight for that session. The guard releases
// on BOTH success and failure (try/finally) so a genuine retry still works
// after a 12s timeout/failure.
//
// This is ENQUEUE-IN-FLIGHT — DISTINCT from two other signals in this codebase:
//   - session "busy" (busy.ts) — an agent turn is executing.
//   - queue "dispatching" / the sync store's `isSending` (queueDrain.ts +
//     sync/store.ts) — a CLAIMED queued item is being POSTed to prompt_async,
//     or a shell dispatch is in flight. sendText explicitly MUST NOT touch
//     setSending (it would stall the drain effect, leaving the just-enqueued
//     item stranded in `pending`); this guard is fully independent of it.
// Do NOT reuse those signals. This is a dedicated, narrow in-flight signal
// scoped to the send action itself.
//
// Extracted from ChatView.tsx so the single-flight logic is unit-testable in
// isolation (precedent: QueueChip.tsx, queueDrain.ts — both extracted from
// ChatView specifically so a guard/state-machine can be exercised without
// mounting the ~15-module component). ChatView binds its Send button's
// `disabled` + the sending animation to `isSendInFlight` and wraps the enqueue
// tail in `runSendSingleFlight`.
import { createStore } from "solid-js/store";

// Reactive map of session-key → in-flight enqueue. Keyed by the LIVE session id
// (the value `ensureSession()` returns in ChatView.send), mirroring how the sync
// store's `isSending` is keyed. A read is REACTIVE — bind it inside a Solid
// createMemo / classList / disabled expression so the UI updates the instant a
// send engages or releases. Returns false for unknown keys.
const [inFlight, setInFlight] = createStore<Record<string, boolean>>({});

/** True while an enqueue send is in-flight for `key`. Reactive — safe to read
 *  inside a Solid binding (createMemo / classList / disabled). */
export function isSendInFlight(key: string): boolean {
  return !!inFlight[key];
}

// Sentinel returned by runSendSingleFlight when the call was dropped because a
// send was already in-flight for that key. Callers/tests compare with `===`.
export const IGNORED: unique symbol = Symbol("send-single-flight-ignored");
export type Ignored = typeof IGNORED;

/**
 * Per-key single-flight: run `fn` only if no enqueue is already in-flight for
 * `key`; otherwise immediately resolve with {@link IGNORED} (the re-tap is
 * dropped — NO second enqueue). Marks `key` in-flight BEFORE `fn` runs (so the
 * UI reflects the tap immediately via `isSendInFlight`) and releases in
 * `finally` on BOTH success and failure so a genuine retry still works after a
 * timeout/failure.
 *
 * `fn` may resolve to any value, or reject. On rejection the guard is released
 * and the rejection propagates to the caller (send()/sendText already handle
 * enqueue failure by preserving the composer text + attachments — no silent
 * loss — so re-throwing is the correct, no-loss behavior).
 */
export async function runSendSingleFlight<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T | Ignored> {
  if (inFlight[key]) return IGNORED;
  setInFlight(key, true);
  try {
    return await fn();
  } finally {
    setInFlight(key, false);
  }
}

/** Test-only: clear the in-flight map so unit cases don't leak state across
 *  each other. Not used by the application. */
export function __resetSendSingleFlightForTests(): void {
  for (const k of Object.keys(inFlight)) setInFlight(k, false);
}
