// Queue sync controller — the pull-based queue-draining lifecycle for the
// selected session.
//
// Extracted from ChatView.tsx (C7) so the queue-synchronization effects can be
// exercised in isolation, mirroring the createQueueDrainer precedent and the
// createComposerAutocomplete (C3) / createPromptHistory (C5) / createComposerPaste
// (C4) extractions: a SolidJS `create...` controller factory (NOT a React-style
// `use...` hook). Side-effect-only — NOT a scroll-controller extraction.
//
// The factory is constructed ONCE under the ChatView Solid owner. It takes
// Accessor<T> reactive inputs + injectable side effects, registers its effects
// + onMount/onCleanup inside that owner, and returns nothing — this is a
// side-effect-only controller. The queue-rendering JSX (chips, status rows)
// reads the queue cache directly from ../../queue, NOT from this factory; this
// module owns ONLY the effects that trigger drains + keep the cache fresh. The
// drainer itself (createQueueDrainer) STAYS in ChatView; this factory only arms
// it.
//
// What moved here (~44 LOC, previously inlined in ChatView):
//   - the drain-trigger effect — busy→idle (turn finished) and opening an idle
//     session that still has a queue both kick one drain iteration via the
//     injected `drain` (single-flight lives inside the drainer; this effect
//     only arms it, so duplicate-drain prevention is the drainer's job).
//   - the session-open effect — migrate any legacy local queue into the
//     backend, then fetch the authoritative cache.
//   - the reconnect effect — when the stream goes live after a reconnect,
//     refresh the cache.
//   - the ~5s poll — runs only while the selected session has visible queue
//     state (hasQueueState), and only while the tab is visible.
//   - the focus/visibility listeners — refresh on window focus + tab re-show.
//   - cleanup — clears the poll timer + removes the listeners on unmount.
//
// What stays in ChatView: the createQueueDrainer({...}) call (the drainer owns
// the single-flight `draining` flag + the per-session sending-guard lifecycle),
// dispatch/claim/resolve (the actual POST + outcome classification), and every
// queue-rendering JSX site (chips, status rows) which reads ../../queue
// directly.
//
// Correctness never depends on a push channel: /vh/stream is a reconnect
// trigger only. The cache is pulled on session open, after every mutation, on
// focus/visibility, on stream reconnect, and polled ~5s while there is queue
// state to show.
import { type Accessor, createEffect, onCleanup, onMount } from "solid-js";
import type { ConnStatus } from "../../types";
import type { QueuedMessage } from "../../queue";

// Injectable inputs + side effects. ChatView passes its own accessors/closures;
// tests pass fakes under createRoot. The reactive cache reads (queueFor,
// hasQueueState) track the queue store when called inside the factory's
// effects; the network ops (migrateLegacyQueue, fetchQueue) are injected so the
// factory owns NO network/localStorage — mirroring createQueueDrainer's
// DrainDeps injectable-seam precedent.
export interface QueueSyncDeps {
  // Session id — drives the session-open, reconnect, poll, focus/visibility,
  // and drain-trigger reads. Reactive so switching sessions re-arms everything.
  sessionId: Accessor<string>;
  // Draft mode suppresses every path (no server session to migrate/fetch/drain).
  draft: Accessor<boolean>;
  // True while the session has an active turn. The drain trigger only fires
  // when idle (!working); a busy→idle edge re-arms a drain.
  working: Accessor<boolean>;
  // Stream connection status (reconnect trigger). A transition to "live" after a
  // reconnect refreshes the cache.
  streamStatus: Accessor<ConnStatus>;
  // Reactive cache reads (track the queue store inside the effects):
  //   queueFor(id) — visible items for the session (excludes `sent`).
  //   hasQueueState(id) — whether the session has any visible item (drives the
  //     ~5s poll: polling runs only while there's something to show).
  queueFor: (id: string) => QueuedMessage[];
  hasQueueState: (id: string) => boolean;
  // Pull-based queue operations. Results are discarded by the factory (the
  // cache mutation happens inside these), so the return is unknown. Injected so
  // the factory owns no network/localStorage and is unit-testable in isolation.
  migrateLegacyQueue: (id: string) => Promise<unknown>;
  fetchQueue: (id: string) => Promise<unknown>;
  // Kick one drain iteration. The drainer itself (createQueueDrainer) stays in
  // ChatView and owns the single-flight `draining` flag + sending-guard
  // lifecycle; this factory only arms it from the drain-trigger effect.
  drain: () => Promise<void>;
}

// Side-effect-only controller: registers its effects + cleanup under the
// ChatView owner and returns nothing. The queue-rendering JSX in ChatView reads
// the cache directly from ../../queue.
export function createQueueSync(deps: QueueSyncDeps): void {
  // Fires on busy→idle (turn finished) and on opening an idle session that still
  // has a queue (its turn finished while elsewhere). Reads queue length + working
  // reactively; the drainer's own guards keep it single-flight. pendingCount
  // counts only items the FE may still dispatch (pending) — dispatching/terminal
  // items stay visible but don't re-trigger a drain.
  createEffect(() => {
    void deps.sessionId();
    const idle = !deps.working();
    const items = !deps.draft() ? deps.queueFor(deps.sessionId()) : [];
    const pending = items.filter((q) => q.state === "pending").length;
    if (idle && pending > 0) queueMicrotask(() => void deps.drain());
  });
  // Pull-based sync: refresh the selected session's queue on open, on stream
  // reconnect (status live-after-reconnecting), on window focus/visibility, and
  // poll ~5s while the selected session has any queue state. Correctness never
  // depends on a push channel (/vh/stream is a reconnect trigger only).
  createEffect(() => {
    const id = deps.sessionId();
    if (deps.draft() || !id) return;
    // Session open: migrate any legacy local queue into the backend, then fetch.
    void (async () => {
      await deps.migrateLegacyQueue(id);
      void deps.fetchQueue(id);
    })();
  });
  createEffect(() => {
    // Reconnect trigger: when the stream goes live after a reconnect, refresh.
    const st = deps.streamStatus();
    void st; // track status transitions
    if (st === "live" && !deps.draft() && deps.sessionId()) {
      void deps.fetchQueue(deps.sessionId());
    }
  });
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => {
    const id = deps.sessionId();
    const has = !deps.draft() && id ? deps.hasQueueState(id) : false;
    // Restart the poll whenever the has-state signal changes.
    clearInterval(pollTimer);
    pollTimer = undefined;
    if (has) {
      pollTimer = setInterval(() => {
        if (!deps.draft() && deps.sessionId() && document.visibilityState === "visible") {
          void deps.fetchQueue(deps.sessionId());
        }
      }, 5000);
    }
  });
  onMount(() => {
    const onFocus = () => {
      if (!deps.draft() && deps.sessionId()) void deps.fetchQueue(deps.sessionId());
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    onCleanup(() => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(pollTimer);
    });
  });
}
