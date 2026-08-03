// The Phase-4 historical-page (load-older) concern, extracted from stream.ts —
// the second extraction boundary per the stream.ts invariant audit
// (.opencode/state/workstreams/refactor-maintainability/stream-invariant-audit.md §6b).
// Owns: the in-flight page tracker (pageInFlight), the GET /vh/session/{sid}/messages
// fetcher, the Contract-B response gate (sesGen/epoch/dirty-retry), the clean-response
// merge (insert-if-not-present), the narrow dirty-kind filter, resident-cache eviction,
// and the pure deriveMessageWindow helper that projects server window meta into the
// resident MessageWindowState.
//
// SEAM — sesGen accessor (Option A). The response gate must recheck the Stream2
// connection-generation token (sesGen) after its await to avoid applying a stale
// page-merge after a session switch / connection teardown. sesGen is a module-private
// `let` owned by the transport layer (stream.ts) — it is bumped in closeSessionStream()
// BEFORE ses.close() and in openSessionStream()'s retry path (audit §3a: bump-before-
// close is load-bearing). Rather than duplicate or push that token, this module reads
// it through a narrow peek accessor getSesGen() re-exported by stream.ts. This:
//   1. keeps sesGen OWNERSHIP in the transport module (audit §6f: "NO module owns
//      another's generation token" — a read-only peek is not ownership transfer);
//   2. preserves the gate distinction — a sesGen mismatch DISCARDS (step 1 of
//      runPageFetchLoop), while markPageDirty DISCARDS+RETRIES (step 3); a bump-callback
//      would conflate these two gates;
//   3. introduces no mutable state here (the bump-callback alternative would require a
//      registered reader `let` plus registration at every bump site — a footgun).
// The resulting stream ↔ history import is a RUNTIME-ONLY cycle (history calls
// getSesGen() only inside loadOlder/runPageFetchLoop; stream calls history's
// resetPageInFlight/markPageDirty only inside listener callbacks). getSesGen is a
// hoisted function declaration; neither module reads the other's binding at eval time,
// so there is no TDZ. When the active-session transport is later extracted (audit §6c,
// session-stream.ts), getSesGen (and sesGen) move there and this import path updates by
// one segment — no behavior change.
//
// INVARIANTS this module must preserve (audit §3 + §5d):
//   - §3a: sesGen is rechecked after EVERY await in the response gate (loadOlder captures
//     gen at issue; runPageFetchLoop rechecks after the fetch await). The getSesGen()
//     accessor reads the LIVE value, so the post-await recheck semantics are identical to
//     the prior direct module-var read.
//   - §3e (cursor duality): this module NEVER advances state.cursor. requestSeq captures
//     state.cursor for DIAGNOSTICS ONLY (it is not consulted by the response gate — the
//     anti-clobber mechanism for cursor-advancing mutations is markPageDirty, not a seq
//     comparison). trackCursor=false on Stream2 still holds.
//   - §3f (dirty filter narrowness): isPageDirtyingKind returns true ONLY for
//     message.delete / part.delete / messages.batch. Do NOT widen this set — widening
//     regresses the "Load-older unusable on actively-streaming sessions" bug (a
//     part.upsert flood would exhaust MAX_PAGE_RETRIES and abandon with no merge).
//   - §3h (eviction caps): evictIfOverCap evicts from the OLDEST end (protectTail=1
//     keeps the live tail); the sticky evictedHistory flag ORs into hasOlder so the
//     Load-older button re-appears for evicted messages.
//   - §5d#2 (live always wins): applyPageMerge uses prependMessagesIfAbsent
//     (insert-if-not-present; an existing byId entry is left untouched EXCEPT
//     the upgrade-on-completed path, reduce.ts:123-136, which replaces a
//     resident entry's info when the incoming copy is completed).
//
// Callers (preserved by stream.ts re-exports — see the import/re-export block there):
//   - ChatView: loadOlder(sid) on the IntersectionObserver sentinel + "Load older" button.
//   - stream.ts reducers: deriveMessageWindow (messages.batch / applySessionSnapshot /
//     refreshOpenSessions) and resetPageInFlight (session.delete / pruneSessionDeleted).
//   - stream.ts Stream2 listener: if (isPageDirtyingKind(kind)) markPageDirty(sid).
//   - stream.ts closeSessionStream: resetPageInFlight() on connection teardown.
//   - actions.ts switchProject: resetPageInFlight().
import { produce } from "solid-js/store";
import type { MessageWindowMeta } from "../types";
import { prependMessagesIfAbsent, deleteMessagesFromTop, approxResidentBytes } from "../lib/reduce";
import { log } from "../lib/log";
import { state, setState, projectDir } from "./store";
import { decodeGzip64 } from "./decode";
import { getSesGen } from "./session-stream";

// deriveMessageWindow — pure helper that projects the server-side window meta
// (Phase 1's WindowMeta wire shape) into the client's resident MessageWindowState
// (Phase 3). Used by the three snapshot/batch paths that derive a window from
// server items (messages.batch, applySessionSnapshot, refreshOpenSessions) so
// they all populate the window state consistently. NOTE: messages.batch and
// applySessionSnapshot both merge-if-absent message bodies via
// prependMessagesIfAbsent (live always wins — see applySessionSnapshot); only
// refreshOpenSessions wholesale-replaces messages[id] (it skips the active
// session, so it has no live upserts to clobber). All three still derive the
// resident-window cursor from their items. Pure
// + exported for unit testing.
//
// Back-compat: a pre-Phase-1 server ships the WHOLE transcript and omits the
// window meta — that yields {hasOlder:false, oldestResidentID:<derived from
// items[0]>}, which is the correct "unbounded server, nothing older to fetch"
// state. The derived oldestResidentID lets Phase 4 (the prepend path) read a
// stable cursor even against an old server (though it would have nothing to
// fetch in that case — hasOlder:false hides the button).
export function deriveMessageWindow(
  items: any[],
  serverWindow?: MessageWindowMeta,
): { hasOlder: boolean; oldestResidentID?: string } {
  const hasOlder = !!(serverWindow && serverWindow.has_older);
  // Prefer the server's declared oldest_loaded_id (authoritative — it survives
  // even when an oversized-anchor item ships alone with older messages still
  // beyond it). Fall back to the first resident item's info.id for back-compat
  // with an unbounded server that omitted the meta. Items arrive in creation
  // order (oldest first), so items[0] is the oldest.
  const oldestResidentID =
    (serverWindow && serverWindow.oldest_loaded_id) ||
    (items.length ? (items[0] as any)?.info?.id : undefined);
  return { hasOlder, oldestResidentID };
}

// === Phase 4: historical-page load-older ====================================
// The bounded initial window (Phase 1) ships only the recent tail. Phase 4
// lazy-loads OLDER pages on demand via the GET /vh/session/{sid}/messages
// endpoint (Phase 2). Single-flight per session (one in-flight page at a time,
// mirroring aggregator.msgInflight); Contract-B conditional-freshness via the
// `dirty` mirror flag (client-side analog of the server's
// me.liveTouchedBody/me.liveTouchedParts) — discard-and-refetch ONLY for
// the narrow isPageDirtyingKind set (deletions + messages.batch, which
// resets the resident window). Live state always wins. The dirty trigger is NARROW — see
// isPageDirtyingKind for the rationale (live upserts cannot resurrect a stale
// page because the merge is insert-if-not-present, so they are deliberately
// excluded to keep Load-older usable on actively-streaming sessions).

// pageInFlight: per-session in-flight historical-page request. Module-level
// (transport state, NOT store state — the store carries only the
// `loadingOlder` UI flag in messageWindows[id]). Single-flight: a second
// loadOlder(sid) while one is in flight is a no-op.
const pageInFlight = new Map<
  string,
  {
    requestSeq: number; // state.cursor at issue time (Stream1 resume cursor)
    dirty: boolean; // a session mutation landed during the flight → discard+retry
    retries: number; // dirty-retry count (bounded by MAX_PAGE_RETRIES)
    gen: number; // sesGen at issue time (Stream2 connection generation)
    epoch: string; // state.epoch at issue time
  }
>();

// Bounded dirty-retry cap. After N dirty retries, abandon the page for this
// request (per-request fallback — no unbounded memory, no resurrection). The
// user can click Load-older again to re-issue.
//
// The dirty trigger fires ONLY for resurrection-class mutations
// (message.delete / part.delete / messages.batch — see isPageDirtyingKind).
// Live token streaming (part.upsert floods during an assistant turn) does NOT
// mark the page dirty, because prependMessagesIfAbsent's insert-if-not-present
// merge makes live always wins without discarding the page. Abandonment under
// active streaming was the pre-narrowing bug — it is now unreachable on the
// streaming hot path; the cap bounds fetch amplification only in the rare
// genuine concurrent-deletion-during-flight case (rapid message churn while the
// user clicks Load older), which is the intended safety bound.
const MAX_PAGE_RETRIES = 3;

// Resident-cache soft caps. After each page merge, if EITHER cap is exceeded,
// evict from the OLDEST end (top of order). The live tail is never yanked
// (deleteMessagesFromTop protects the last protectTail entries). This bounds
// the multi-page history-loading OOM vector (a user who clicks Load older
// repeatedly). The live-streaming growth vector (a long-lived session where
// Stream2 message.upsert/part.upsert events grow messages[sid] without a page
// merge) is NOT bounded by this slice — that's the bidirectional-eviction
// follow-up (C-F4). Bidirectional eviction (tail-end when reading history) is
// also a documented follow-up.
export const MAX_RESIDENT_MESSAGES = 500;
export const MAX_RESIDENT_BYTES = 5 * 1024 * 1024; // 5 MiB

// resetPageInFlight — clear in-flight page state. Called on session.delete,
// closeSessionStream (connection teardown), and switchProject. Exported for
// actions.ts's switchProject to call alongside messageWindows={}.
export function resetPageInFlight(sid?: string) {
  if (sid) pageInFlight.delete(sid);
  else pageInFlight.clear();
}

// fetchMessagePage — GET /vh/session/{sid}/messages?before=<id>&z=1. Mirrors
// fetchSessionMessages but hits the Phase-2 historical-page endpoint (NOT the
// bounded /vh/snapshot — that path returns only the recent tail after Phase 1).
// `before` is the exclusive cursor (the oldest currently-resident id); the
// server returns a page of strictly-older messages WITH a one-item overlap at
// `before` itself (Phase-2 design) so the client can dedup robustly. The
// response envelope is MessagePageResult (session_id/project_id/daemon_epoch/
// request_before/baseline_seq/items/oldest_id/newest_id/has_older/
// serialized_bytes/count_limited/bytes_limited/oversized_item). NEVER emits
// messages.batch/messages.loaded — this is a pure point-in-time GET.
//
// `?z=1` opts into gzip64 (server maybeCompressSnapshot). The X-VH-Seq +
// X-VH-Epoch headers are stamped by the stampMeta middleware on every /vh/*
// response. X-VH-Epoch IS validated against the issue-time epoch in the
// response gate (step 2) — a server restart invalidates the page. X-VH-Seq is
// returned as headerSeq for diagnostics (the client cursor-validation path is
// the markPageDirty hook, NOT a headerSeq comparison — see loadOlder for why).
async function fetchMessagePage(
  id: string,
  before: string,
): Promise<{
  items: any[];
  oldestID?: string;
  newestID?: string;
  hasOlder: boolean;
  headerSeq: number;
  headerEpoch: string;
}> {
  const url = `/vh/session/${encodeURIComponent(id)}/messages?before=${encodeURIComponent(
    before,
  )}&dir=${encodeURIComponent(projectDir())}&z=1`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`page fetch failed: ${res.status}`);
  }
  const headerSeq = Number(res.headers.get("X-VH-Seq") || 0);
  const headerEpoch = res.headers.get("X-VH-Epoch") || "";
  const raw = await res.json();
  // gzip64 envelope {encoding,data} (server maybeCompressSnapshot) OR raw
  // MessagePageResult JSON (small payload under snapshotCompressThreshold).
  let body: any = raw;
  if (raw && raw.encoding === "gzip64" && raw.data) {
    const text = await decodeGzip64(raw.data);
    body = text ? JSON.parse(text) : {};
  }
  const items: any[] = Array.isArray(body?.items) ? body.items : [];
  return {
    items,
    oldestID: body?.oldest_id || undefined,
    newestID: body?.newest_id || undefined,
    hasOlder: !!body?.has_older,
    headerSeq,
    headerEpoch,
  };
}

// loadOlder — the exported Phase-4 action. Issues a historical-page fetch for
// the session, gates the response (sesGen / epoch / dirty-retry / merge), and
// updates messageWindows[id] + messages[id] (insert-if-not-present). The UI
// (ChatView) calls this from the IntersectionObserver top sentinel + the
// "Load older" button. Single-flight: a second call while one is in flight is
// a no-op. Idempotent under duplicate intersections (loadingOlder signal
// guards the IO).
export async function loadOlder(sid: string): Promise<void> {
  if (!sid) return;
  if (pageInFlight.has(sid)) return; // single-flight
  const win = state.messageWindows[sid];
  const before = win?.oldestResidentID;
  if (!before) return; // nothing resident yet — initial window not landed
  if (!win?.hasOlder) return; // server says no older messages — hide affordance
  // Capture the freshness tokens at issue time:
  //   - gen = sesGen (Stream2 connection generation). CHECKED in the response
  //     gate (step 1) — a session reopen/connection-teardown invalidates the
  //     page. This is the Stream2 connection-gen anti-clobber invariant.
  //   - epoch = state.epoch. CHECKED in the response gate (step 2, alongside
  //     the response X-VH-Epoch header) — a server restart invalidates the page.
  //   - requestSeq = state.cursor (Stream1 resume cursor; advanced by every
  //     Stream1 event via trackCursor). DIAGNOSTIC-ONLY — NOT consulted by the
  //     response gate. Cursor advance on unrelated Stream1 events (session
  //     tree mutations, background snapshots, OTHER sessions' deltas) does NOT
  //     invalidate a per-session historical page; an explicit cursor check
  //     would spuriously discard valid pages. The Contract-B anti-clobber
  //     mechanism for cursor-advancing mutations on THIS session is the
  //     markPageDirty hook (set on Stream2 resurrection-class events only —
  //     message.delete / part.delete / messages.batch — see
  //     isPageDirtyingKind; step 3 of the gate). Retained on the flight
  //     object per the mission spec (`pageInFlight = { requestSeq: s.cursor,
  //     dirty: boolean }`) for diagnostics + future cursor-based prefetch.
  const flight = {
    requestSeq: state.cursor,
    dirty: false,
    retries: 0,
    gen: getSesGen(),
    epoch: state.epoch,
  };
  pageInFlight.set(sid, flight);
  setState("messageWindows", sid, { ...win, loadingOlder: true });
  try {
    await runPageFetchLoop(sid, before, flight);
  } catch (e) {
    // Network / parse / non-OK HTTP error. Swallow + log — the UI's only signal
    // is the loadingOlder spinner (cleared in finally). A thrown error here
    // would surface as an unhandled rejection in ChatView's onLoadOlder click
    // handler, so we deliberately do NOT rethrow. The user can click Load older
    // again to retry.
    log.warn("sync", "page fetch error", { sid, err: String(e) });
  } finally {
    // Clear loadingOlder + drop in-flight state on every exit path (success,
    // abandon, network error, thrown exception). The store write is safe even
    // if the session was deleted mid-flight (setState on a deleted key is a
    // no-op in Solid's store).
    pageInFlight.delete(sid);
    const post = state.messageWindows[sid];
    if (post) setState("messageWindows", sid, { ...post, loadingOlder: false });
  }
}

// runPageFetchLoop — the Contract-B response gate. Re-issues the fetch on a
// dirty signal (a session mutation landed during the flight) up to
// MAX_PAGE_RETRIES; abandons after that. Drops on sesGen/epoch mismatch
// (connection replaced or server restarted). On a clean response, merges via
// insert-if-not-present (prependMessagesIfAbsent) and evicts from the oldest
// end if resident caps are exceeded.
async function runPageFetchLoop(
  sid: string,
  before: string,
  flight: { requestSeq: number; dirty: boolean; retries: number; gen: number; epoch: string },
) {
  let cursor = before;
  while (true) {
    const res = await fetchMessagePage(sid, cursor);
    // Step 1: drop if sesGen changed (connection replaced mid-flight).
    if (flight.gen !== getSesGen()) {
      log.warn("sync", "page discarded: sesGen changed", { sid });
      return;
    }
    // Step 2: drop if epoch changed (server restarted) — compare both the
    // issue-time epoch AND the response header epoch against the current
    // store epoch. Either mismatch means the page is stale.
    if (flight.epoch !== state.epoch || res.headerEpoch !== state.epoch) {
      log.warn("sync", "page discarded: epoch changed", { sid });
      return;
    }
    // Step 3: discard + bounded retry if dirty. The dirty flag is set by the
    // Stream2 listener hook (markPageDirty) ONLY for resurrection-class
    // mutation events (message.delete / part.delete / messages.batch) for this
    // session while the page was in flight — see isPageDirtyingKind for the
    // rationale (live upserts cannot resurrect a stale page because the merge
    // is insert-if-not-present). This is the Contract-B client mirror of the
    // server's me.liveTouchedBody/Parts — live state always wins, so a page
    // that raced a resurrection-class mutation is stale and must be refetched.
    if (flight.dirty) {
      if (flight.retries < MAX_PAGE_RETRIES) {
        flight.retries++;
        flight.dirty = false;
        // Re-issue with the current freshness tokens. The cursor stays the
        // same (oldestResidentID) unless a live delta prepended a new oldest
        // — in which case the new oldest is what we want anyway.
        flight.requestSeq = state.cursor;
        flight.gen = getSesGen();
        flight.epoch = state.epoch;
        const cur = state.messageWindows[sid]?.oldestResidentID;
        if (cur) cursor = cur;
        continue;
      }
      log.warn("sync", "page abandoned: max dirty retries", { sid, retries: flight.retries });
      return;
    }
    // Step 4: clean response — merge via insert-if-not-present.
    applyPageMerge(sid, res);
    return;
  }
}

// markPageDirty — the Stream2 listener hook calls this on a resurrection-class
// mutation event for a session that has a page in flight (see
// isPageDirtyingKind for the kind filter). Mirrors the server's
// me.liveTouchedBody/me.liveTouchedParts (pkg/state/store.go): a resurrection-
// class mutation during the flight invalidates the page's point-in-time
// snapshot, so the response gate discards + retries.
//
// Exported for testability — the production caller is the Stream2 listener
// hook in stream.ts (gated by isPageDirtyingKind); tests call it directly to
// simulate a concurrent mutation without a full SSE setup.
export function markPageDirty(sid: string) {
  const f = pageInFlight.get(sid);
  if (f) f.dirty = true;
}

// isPageDirtyingKind — the narrow kind filter for the Stream2 listener's
// markPageDirty hook. Returns true ONLY for mutation kinds that could leave a
// stale in-flight page inconsistent with the live resident state — either
// resurrecting a message the live state has removed, or clobbering a fresher
// resident window the batch just reset:
//
//   - message.delete: a page captured before the delete would re-insert the
//     deleted message by ID (prependMessagesIfAbsent inserts absent ids).
//   - part.delete:    a page captured before the part delete would re-insert
//     the message with the deleted part still present.
//   - messages.batch: after the Lane B merge-guard this merge-if-absents
//     message bodies (prependMessagesIfAbsent — cannot resurrect removed
//     messages like the two delete kinds above), but it still wholesale-resets
//     messageWindows[id]; a stale page merged after the batch could clobber
//     the batch's fresher window meta, so it remains in the dirty set.
//
// The kinds FALSE here are safe to skip because the merge is INSERT-IF-NOT-
// PRESENT (live always wins, never overwrites):
//
//   - message.upsert (NEW tail): newer than the `before` cursor → NOT in the
//     page range. The page cannot contain it. Live delta already applied.
//   - message.upsert (EXISTING): prependMessagesIfAbsent skips resident ids.
//   - part.upsert (EXISTING — token streaming): upsertPart Object.assigns into
//     the live part; the page merge skips the resident parent message.
//   - part.upsert (NEW tail placeholder): newer than `before` → NOT in page
//     range.
//   - messages.loaded / messages.error: reveal-gate flips + cold-batch error
//     reports — do NOT change messages[sid] content; marking dirty would waste
//     a retry cycle.
//
// The narrow filter is what makes Load-older usable on actively-streaming
// sessions: a part.upsert flood (one event per streamed token) used to mark
// the page dirty on every token, exhaust MAX_PAGE_RETRIES, and abandon with no
// merge + no user feedback. With the narrow filter, abandonment is unreachable
// on the streaming hot path and fires only on the rare genuine concurrent-
// deletion-during-flight case (the intended safety bound).
//
// Exported for testability — the production caller is the Stream2 listener
// hook in stream.ts; tests assert the kind filter directly + simulate the
// listener call site's pattern (if (isPageDirtyingKind(kind)) markPageDirty(sid)).
export function isPageDirtyingKind(kind: string): boolean {
  return kind === "message.delete" || kind === "part.delete" || kind === "messages.batch";
}

// applyPageMerge — the clean-response merge. Inserts page messages that are NOT
// already resident (live always wins — existing byId entries are left untouched
// EXCEPT the upgrade-on-completed path, reduce.ts:123-136, which replaces a
// resident entry's info when the incoming copy is completed),
// updates oldestResidentID + hasOlder from the server's page meta, and evicts
// from the oldest end if resident caps are exceeded. Mutates the store via
// produce() so Solid's reactivity propagates the prepend + the window-state
// update atomically.
function applyPageMerge(
  sid: string,
  res: { items: any[]; oldestID?: string; newestID?: string; hasOlder: boolean },
) {
  setState(
    produce((s) => {
      const sm = s.messages[sid];
      if (!sm) return; // session closed mid-flight — drop
      const prevWin = s.messageWindows[sid];
      const prevEvictedHistory = !!prevWin?.evictedHistory;
      const added = prependMessagesIfAbsent(sm, res.items);
      if (added === 0) {
        // Page was a pure overlap (all messages already resident) or empty.
        // Still update hasOlder from the server's authoritative page meta so
        // the button hides when end-of-history is reached — but preserve the
        // sticky evictedHistory signal since those evicted messages remain on
        // the server and re-fetchable.
        if (prevWin) {
          s.messageWindows[sid] = {
            ...prevWin,
            hasOlder: res.hasOlder || prevEvictedHistory,
          };
        }
        return;
      }
      // Eviction: if resident caps are exceeded, evict from the OLDEST end.
      // protectTail=1 keeps the live tail intact (an in-flight assistant turn
      // at the bottom of order is never yanked). The just-merged page is at
      // the top (older messages), so eviction from the oldest end yanks the
      // farthest-from-tail messages — typically ones the user already scrolled
      // past back down to the live view. Bidirectional eviction is a follow-up.
      const evicted = evictIfOverCap(s, sid);
      const newEvictedHistory = prevEvictedHistory || evicted;
      // Update window state. oldestResidentID = the new oldest resident (order
      // may have shifted if eviction fired). hasOlder = server's authoritative
      // page meta (returned count < limit ⇒ end of history) OR'd with the
      // sticky eviction signal so the button re-appears when evicted messages
      // remain server-resident. Without the OR, an end-of-history page that
      // triggers eviction would hide the button even though evicted messages
      // are still on the server.
      const oldestResidentID = sm.order.length ? sm.order[0] : undefined;
      s.messageWindows[sid] = {
        hasOlder: res.hasOlder || newEvictedHistory,
        oldestResidentID,
        loadingOlder: prevWin?.loadingOlder,
        evictedHistory: newEvictedHistory,
      };
    }),
  );
}

// evictIfOverCap — bounded-resident-cache eviction. Fires after a page merge
// if EITHER MAX_RESIDENT_MESSAGES or MAX_RESIDENT_BYTES is exceeded. Evicts
// from the oldest end (top of order) until under BOTH caps or only
// protectTail entries remain. Returns true if any eviction occurred. The
// caller ORs the eviction signal into hasOlder so the "Load older" button
// re-appears (the evicted messages exist on the server and can be re-fetched)
// even when the just-fetched page reported end-of-history (has_older=false).
function evictIfOverCap(s: any, sid: string): boolean {
  const sm = s.messages[sid];
  if (!sm) return false;
  let bytes = approxResidentBytes(sm);
  let count = sm.order.length;
  if (count <= MAX_RESIDENT_MESSAGES && bytes <= MAX_RESIDENT_BYTES) return false;
  // Evict in a single pass — compute how many to drop to get under BOTH caps.
  // Walk from the top (oldest), accumulating freed bytes, until both caps are
  // satisfied or only protectTail entries remain.
  const protectTail = 1;
  let dropCount = 0;
  let freedBytes = 0;
  while (
    dropCount < count - protectTail &&
    (count - dropCount > MAX_RESIDENT_MESSAGES || bytes - freedBytes > MAX_RESIDENT_BYTES)
  ) {
    // Approximate freed bytes for the candidate message (cheap recompute of
    // its info+parts size).
    const id = sm.order[dropCount];
    const msg = sm.byId[id];
    if (msg) {
      let mb = msg.info ? JSON.stringify(msg.info).length : 0;
      for (const pid of msg.partOrder) {
        const p = msg.parts[pid];
        if (p) mb += JSON.stringify(p).length;
      }
      freedBytes += mb;
    }
    dropCount++;
  }
  if (dropCount > 0) {
    deleteMessagesFromTop(sm, dropCount, protectTail);
    return true;
  }
  return false;
}
