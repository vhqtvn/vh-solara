// Auto-drain state machine for the backend-authoritative per-session queue.
//
// The browser is the SOLE dispatcher: when a session is idle and has queued
// messages, it CLAIMS the oldest pending item (the atomic cross-client
// boundary — only one browser wins), dispatches it to /oc/session/:id/prompt_async,
// then RESOLVES the terminal outcome. This module owns ONLY that lifecycle
// shell: the single-flight `draining` flag and the per-session `sending` guard
// toggled around dispatch.
//
// Extracted from ChatView.tsx so the state machine can be unit-tested in
// isolation (no component/reactive harness required). The dispatch, claim, and
// resolve side effects — plus the busy/draft/idle guard — stay injectable so
// behavior is identical to the inlined version; only the lifecycle bookkeeping
// moved here.
//
// Lifecycle (no auto-retry anywhere — the operator's explicit intent):
//
//   pending → dispatching → {sent | failed | unknown}
//
// Neither `failed` nor `unknown` ever returns to `pending`; they persist until
// explicit operator dismissal.
import type { QueuedMessage } from "./queue";

// Terminal outcome of a queued dispatch, classified from the prompt_async
// response. Definitive rejection (non-2xx) → failed; network interruption →
// unknown (ambiguous, never repend); 2xx → sent.
export interface DrainOutcome {
  state: "sent" | "failed" | "unknown";
  detail: string;
}

// Injectable side effects + guards. ChatView passes its closures; tests pass
// fakes. `setSending(true)` after a successful claim guards drain-vs-direct-send
// overlap; `setSending(false)` in finally releases the guard so the next pending
// item can drain (FIFO). Missing that finally call was the setSending-leak bug:
// after item 1 drained, isSending(id) stayed true forever and items 2..N stalled
// in pending until a page reload.
export interface DrainDeps {
  // Guard evaluated at the top of each drain: return false to skip this
  // attempt (e.g. draft mode, session busy/working). The drainer additionally
  // checks `!id`, an in-flight drain, and the sending guard itself.
  canDrain: () => boolean;
  // The session id being drained (also the sending-guard key).
  getId: () => string | null;
  // Claim the oldest pending item (cross-client boundary). Returns null when
  // nothing is pending (claim loser / empty queue) → the drain stops.
  claim: (id: string) => Promise<QueuedMessage | null>;
  // Dispatch the claimed item (POST prompt_async) and classify the outcome.
  // Must NOT throw on a definitive rejection — return {state:"failed"} instead
  // so the item reaches a terminal state via resolve. The AbortSignal fires after
  // dispatchTimeoutMs (see createQueueDrainer): the dispatch implementation MUST
  // treat an aborted signal as the "unknown" outcome (the POST may have reached
  // OpenCode — never repend, never auto-retry).
  dispatch: (id: string, item: QueuedMessage, signal: AbortSignal) => Promise<DrainOutcome>;
  // Record the terminal outcome (can never repend).
  resolve: (id: string, itemId: string, state: DrainOutcome["state"], detail: string) => Promise<void>;
  // Sending-guard lifecycle (wraps sync/store setSending).
  setSending: (id: string, v: boolean) => void;
  isSending: (id: string) => boolean;
  // Optional: invoked after a successful resolve (ChatView refreshes the cache
  // via fetchQueue so the UI reflects the terminal state). Best-effort.
  onResolved?: (id: string) => void;
}

export interface QueueDrainer {
  // Run one drain iteration: claim → dispatch → resolve. Single-flight across
  // concurrent calls via an internal `draining` flag. Always releases the
  // sending guard in finally so the next pending item can advance (FIFO).
  drain: () => Promise<void>;
  // True when a drain is in flight (diagnostics / testing).
  isDraining: () => boolean;
}

// Default bounded timeout for a claimed-item prompt_async dispatch. Mirrors the
// 12s AbortController precedent at web/src/code/api.ts:9-25. A hung socket MUST
// NOT hold a dispatching item forever: after this elapses the AbortController
// fires, the dispatch classifies "unknown", and the item persists visibly. We
// NEVER auto-retry — abort/timeout is ambiguous (the POST may have reached
// OpenCode), so the operator must decide whether to resend.
const DEFAULT_DISPATCH_TIMEOUT_MS = 12000;

// createQueueDrainer builds a single-flight drain state machine. One drainer
// per ChatView instance owns the `draining` flag; the sending guard is owned by
// the injected deps (per-session keyed in sync/store). `dispatchTimeoutMs`
// bounds a single dispatch attempt; on timeout the AbortController passed to
// deps.dispatch fires so the implementation can classify "unknown".
export function createQueueDrainer(
  deps: DrainDeps,
  dispatchTimeoutMs: number = DEFAULT_DISPATCH_TIMEOUT_MS,
): QueueDrainer {
  let draining = false;
  return {
    drain: async () => {
      const id = deps.getId();
      if (!deps.canDrain() || !id || draining || deps.isSending(id)) return;
      draining = true;
      try {
        // Claim is the cross-client boundary. If we don't win (or nothing is
        // pending), there is nothing to dispatch.
        const claimed = await deps.claim(id);
        if (!claimed) return;
        deps.setSending(id, true);
        // Bound the dispatch so a hung socket cannot hold a dispatching item
        // forever. The AbortController is passed to deps.dispatch; on timeout
        // the fetch rejects with AbortError and the dispatch classifies
        // "unknown". We never repend — the POST may have reached OpenCode.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), dispatchTimeoutMs);
        let outcome: DrainOutcome;
        try {
          outcome = await deps.dispatch(id, claimed, ctrl.signal);
        } finally {
          clearTimeout(timer);
        }
        // Record the terminal outcome (can never repend).
        await deps.resolve(id, claimed.id, outcome.state, outcome.detail);
        deps.onResolved?.(id);
      } finally {
        draining = false;
        // RELEASE the sending guard so the next pending item can drain. This
        // is the FIFO-advance invariant: without it, isSending(id) stays true
        // after the first drain and items 2..N stall in pending.
        deps.setSending(id, false);
      }
    },
    isDraining: () => draining,
  };
}
