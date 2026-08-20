// The warm-tree-reconnect message refresh, extracted from stream.ts — the
// refresh-machinery extraction boundary (region 4 of the stream-facade
// decomposition study). Owns the gzip64 full-transcript snapshot puller for a
// single NON-active open session (fetchSessionMessages), the bounded-fan-out
// concurrency runner with per-item fault isolation (runWithConcurrency), the
// tunnel-pressure cap (REFRESH_CONCURRENCY), and the entry point that fans the
// puller out across every open non-active session on a tree reconnect
// (refreshOpenSessions).
//
// WHY THIS SEPARATES. The sole caller of refreshOpenSessions is tree-transport
// (after a tree reconnect: `void refreshOpenSessions()`); it has no coupling to
// the stream.ts busy-reconcile gate (region 5, the irreducible facade residue).
// Relocating it here lets tree-transport reach it without depending on the rest
// of the facade. For backward compatibility stream.ts re-exports every exported
// symbol below, so tree-transport.ts, tests, and the namespace
// `await import("../../src/sync/stream")` suite keep working unchanged.
//
// SEAM — fetch + synchronous store writes, no reactive mirror. fetchSessionMessages
// is an async fetch; refreshOpenSessions fans it out via runWithConcurrency and
// writes results synchronously through setState (the established store seam). The
// import cycle refresh → history → session-stream → (tree-transport, reducers) →
// refresh is TDZ-safe: every cross-module reference is a runtime call inside an
// async body, never a top-level read, so no binding is dereferenced at eval time.
//
// GPU-HEAT. NONE. This runs on tree reconnect (a cold-ish event), NOT the token
// streaming hot path. The part.upsert → upsertPart → state.messages mutation →
// Part re-render path (coalesced ~5fps) is UNCHANGED by relocation.
import type { MessageWindowMeta, Snapshot } from "../types";
import { produce } from "solid-js/store";
import { buildMessages } from "../lib/reduce";
import { state, setState, projectDir, selectedId } from "./store";
import { decodeSnapshot } from "./decode";
import { deriveMessageWindow } from "./history";
import { stampCompletionIfIdle } from "./reducers";

async function fetchSessionMessages(
  id: string,
): Promise<{ items: any[]; window?: MessageWindowMeta }> {
  // z=1 opts into gzip64 snapshot encoding (server maybeCompressSnapshot) so the
  // full transcript ships compressed through the controller tunnel — the same
  // win as the Stream-2 snapshot. refreshOpenSessions fans one of these out per
  // open session on a tree reconnect, so without it each pull ships a full
  // uncompressed transcript and they contend the tunnel. decodeSnapshot is a
  // pass-through when the response carries no `encoding` (old server / small
  // snapshot under the threshold), so an old server keeps working.
  //
  // Phase 3: also surface snap.messageWindows?.[id] (Phase-1 server-side
  // bounded projection meta) so refreshOpenSessions can populate the resident
  // window state alongside the messages — without it the warm-refresh path
  // would lose hasOlder/oldestResidentID and the Phase-4 "Load older" button
  // would never appear after a tree reconnect.
  const res = await fetch(
    `/vh/snapshot?sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}&z=1`,
  );
  const snap: Snapshot = await decodeSnapshot<Snapshot>(await res.json());
  return { items: (snap.messages?.[id] as any[]) || [], window: snap.messageWindows?.[id] };
}

// Bounds tunnel pressure from the warm-open refresh fan-out. Each open session
// triggers a full-transcript /vh/snapshot pull, and firing all N at once (the
// original Promise.all) contends the single yamux-over-WebSocket tunnel —
// head-of-line / bandwidth contention inflates each warm open's latency into
// seconds at large N. Server compute is sub-20ms (measured); the latency is
// transport. Capping concurrency keeps the tunnel from saturating so individual
// pulls complete faster. The knee (concurrency vs throughput) is inferred, not
// measured — the operator-side acceptance signal is before/after `snap` ms in
// ServersPanel under a large-N warm reconnect.
export const REFRESH_CONCURRENCY = 3;

// runWithConcurrency — bounded-fan-out runner with per-item fault isolation, no
// external dependency. Processes `items` with at most `limit` calls to `fn`
// in flight at once. A rejection from one item does NOT abort its siblings: the
// worker catches each item's rejection in isolation and keeps pulling the next,
// so every item is attempted and the returned promise always resolves (matches
// refreshOpenSessions' per-session try/catch tolerance). `limit` is clamped to
// [1, items.length]. Exported for unit testing.
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const i = cursor++;
      try {
        await fn(queue[i]);
      } catch {
        /* isolated — one item's failure does not abort its siblings */
      }
    }
  };
  const n = Math.max(1, Math.min(limit, queue.length));
  await Promise.all(Array.from({ length: n }, worker));
}

// On a tree-stream resync, refresh cached message state for NON-active opened
// sessions (the active one is owned by the live session stream, so skip it to
// avoid clobbering streamed deltas). Dispatched with BOUNDED concurrency: an
// operator with N open sessions has N full-transcript /vh/snapshot pulls to
// re-issue on every tree reconnect, but firing all N at once saturates the
// controller tunnel (see REFRESH_CONCURRENCY). The inner try/catch keeps the
// per-session error isolation (one failed fetch keeps stale + does NOT starve
// the batch, so the other sessions still refresh).
// Exported for unit testing (tests/unit/refreshOpenSessions.test.ts).
export async function refreshOpenSessions() {
  const active = selectedId();
  await runWithConcurrency(Object.keys(state.messages), REFRESH_CONCURRENCY, async (id) => {
    if (id === active) return;
    try {
      const { items, window } = await fetchSessionMessages(id);
      // Cross-stream completion bridge, arrival-path #3 — the THIRD
      // transcript-arrival seam (twins: messages.batch in reducers.ts +
      // applySessionSnapshot in session-stream.ts). The wholesale
      // buildMessages replace re-introduces whatever transcript the server
      // holds — including an orphaned incomplete tail from an instance that
      // died mid-generation (idle forever; no terminal event will ever
      // come). Without a stamp here, every tree reconnect re-created the
      // unstamped orphan tail in the cache (commit-review F5). Stamp inside
      // the SAME produce() that installs the rows so the tail's first
      // re-render after the refresh is already settled. The epoch gate (a
      // snapshot applied THIS boot ⇒ s.activity is server-refreshed, not
      // the stale localStorage seed) + the helper's own idle guard are
      // identical to the landed seams; a genuinely busy session never
      // stamps.
      setState(
        produce((s) => {
          s.messages[id] = buildMessages(items);
          if (s.epoch !== "") stampCompletionIfIdle(s, id);
        }),
      );
      setState("messagesDelivered", id, true);
      // Phase 3: populate the resident-window state alongside the messages so
      // the Phase-4 "Load older" affordance works after a tree reconnect (not
      // just after the cold-load batch / a Stream-2 snapshot). Mirrors what
      // applySessionSnapshot does on the warm path.
      setState("messageWindows", id, deriveMessageWindow(items, window));
    } catch {
      /* keep stale; reopening re-snapshots */
    }
  });
}
