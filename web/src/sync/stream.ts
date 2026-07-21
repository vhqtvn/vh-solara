// The stream state-machine: consumes the daemon's resumable /vh/stream over two
// EventSources, reconciles the store, and keeps itself alive (heartbeat
// watchdog, backoff reconnect, foreground/online recovery). It owns transport
// and store reconciliation; notification policy lives in ./orchestration.
import { produce } from "solid-js/store";
import { createSignal } from "solid-js";
import type { MessageWindowMeta, Snapshot } from "../types";
import {
  buildMessages,
  deleteMessage,
  deletePart,
  upsertMessage,
  upsertPart,
  prependMessagesIfAbsent,
  deleteMessagesFromTop,
  approxResidentBytes,
} from "../lib/reduce";
import { pushNotification } from "../notify";
import { handleNotice } from "../alerts";
import { checkVersionNow } from "../pwa";
import { log } from "../lib/log";
import { state, setState, projectDir, selectedId, persist } from "./store";
import { invalidateChildrenIndex, normalizeTodos } from "./selectors";
import { notifyFromMessage, maybeNotifyRootDone, maybeClearWaiting } from "./orchestration";
import { isGateActive, currentGateEpoch, markBusyDirty, setReconcileFn } from "../busy";

// mergeLastAgents — the agent-label fix (S3). During a server restart the
// daemon serves HTTP while still aggregating session tails, so a mid-hydrate
// tree snapshot carries an INCOMPLETE lastAgents map (sessions whose tail
// hasn't been pulled yet are simply absent). The old code wholesale-replaced
// the FE cache (`s.lastAgents = {...snap.lastAgents}`), which erased correct
// labels — the agent chips blanked until the next FULL snapshot landed. This
// merge keeps any FE entry the incoming snapshot omits/empties, so a
// mid-aggregation snapshot can only ADD or UPDATE labels, never wipe them.
// Incoming non-empty values still win (so a genuine change applies once
// aggregation completes). Pure + exported for unit testing.
export function mergeLastAgents(
  prev: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(incoming)) {
    if (name) out[id] = name; // server-provided label (authoritative when present)
  }
  for (const [id, name] of Object.entries(prev)) {
    if (name && !out[id]) out[id] = name; // keep FE cache when the snapshot omits it
  }
  return out;
}

// deriveMessageWindow — pure helper that projects the server-side window meta
// (Phase 1's WindowMeta wire shape) into the client's resident MessageWindowState
// (Phase 3). Used by the three wholesale-replace paths (messages.batch,
// applySessionSnapshot, refreshOpenSessions) so they all populate the window
// state consistently. Pure + exported for unit testing.
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

// epochChanged — pure epoch-transition detector. True only when we already had
// a real epoch AND the incoming one differs (a restart while connected). The
// first snapshot after a page load has an empty prevEpoch → not a change.
export function epochChanged(prevEpoch: string, incomingEpoch: string): boolean {
  return !!prevEpoch && !!incomingEpoch && prevEpoch !== incomingEpoch;
}

// === Phase 4: historical-page load-older ====================================
// The bounded initial window (Phase 1) ships only the recent tail. Phase 4
// lazy-loads OLDER pages on demand via the GET /vh/session/{sid}/messages
// endpoint (Phase 2). Single-flight per session (one in-flight page at a time,
// mirroring aggregator.msgInflight); Contract-B conditional-freshness via the
// `dirty` mirror flag (client-side analog of the server's
// me.liveTouchedBody/me.liveTouchedParts) — discard-and-refetch ONLY for
// resurrection-class mutations during the page flight (deletions + wholesale
// cache replace). Live state always wins. The dirty trigger is NARROW — see
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

// resetTreeStreamStateForTesting resets module-level tree-stream state that
// persists across applySnapshot calls. Used by unit tests (applySnapshot.test.ts)
// to isolate structuralRevision guard tests from prior test state.
export function resetTreeStreamStateForTesting() {
  lastAppliedStructuralRevision = undefined;
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
    gen: sesGen,
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
    if (flight.gen !== sesGen) {
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
        flight.gen = sesGen;
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
// hook in this file (gated by isPageDirtyingKind); tests call it directly to
// simulate a concurrent mutation without a full SSE setup.
export function markPageDirty(sid: string) {
  const f = pageInFlight.get(sid);
  if (f) f.dirty = true;
}

// isPageDirtyingKind — the narrow resurrection-class kind filter for the
// Stream2 listener's markPageDirty hook. Returns true ONLY for mutation kinds
// that could make a stale in-flight page resurrect a message the live state
// has removed:
//
//   - message.delete: a page captured before the delete would re-insert the
//     deleted message by ID (prependMessagesIfAbsent inserts absent ids).
//   - part.delete:    a page captured before the part delete would re-insert
//     the message with the deleted part still present.
//   - messages.batch: wholesale-replaces the resident cache; a stale page
//     merged after the replace could resurrect messages the batch removed.
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
// hook in this file; tests assert the kind filter directly + simulate the
// listener call site's pattern (if (isPageDirtyingKind(kind)) markPageDirty(sid)).
export function isPageDirtyingKind(kind: string): boolean {
  return kind === "message.delete" || kind === "part.delete" || kind === "messages.batch";
}

// applyPageMerge — the clean-response merge. Inserts page messages that are NOT
// already resident (live always wins — NEVER touch existing byId entries),
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


// Exported for integration tests (tests/unit/applySnapshot.test.ts) — it mutates
// the singleton store, so the tests drive it directly and assert on `state`.
export function applySnapshot(snap: Snapshot) {
  bumpUpdating();
  // Phase 3 Gate B: structuralRevision monotonicity guard. Discard stale (<),
  // skip idempotent (==), apply (>). Reset on epoch change (new epoch starts
  // fresh at revision 0). When either revision is undefined (old server omits
  // the field, or this is the first snapshot for a fresh client), always apply.
  const incomingEpoch = snap.epoch || "";
  if (epochChanged(state.epoch, incomingEpoch)) {
    lastAppliedStructuralRevision = undefined;
  } else if (
    snap.structuralRevision !== undefined &&
    lastAppliedStructuralRevision !== undefined
  ) {
    if (snap.structuralRevision < lastAppliedStructuralRevision) return;
    if (snap.structuralRevision === lastAppliedStructuralRevision) return;
  }
  // Phase 2 Gate A: projected snapshots use MERGE semantics — sessions absent
  // from the array are PRESERVED as hidden, NOT deleted. Only an explicit
  // session.delete event removes a session. AUTHORITY_COMPLETE (projected
  // absent/false) keeps the legacy wholesale-replace where omission === deleted.
  // The capability is dual-negotiated: `?proj=1` (query param) + `projected:true`
  // (envelope). An old server ignoring proj=1 emits no `projected` field, so a
  // new client falls back to wholesale-replace transparently.
  if (snap.projected) {
    applyProjectedSnapshot(snap);
    if (snap.structuralRevision !== undefined)
      lastAppliedStructuralRevision = snap.structuralRevision;
    return;
  }
  const changed = epochChanged(state.epoch, incomingEpoch);
  // B2a resync window: mergeLastAgents is ONLY correct while the server is
  // re-aggregating after a restart. Outside that window a complete AUTHORITATIVE
  // snapshot must be able to CLEAR a label (e.g. a session whose latest
  // assistant no longer has an agent, or whose recomputed messages yield none).
  // We are "resyncing" when ANY of these hold:
  //   - this snapshot is itself an epoch transition (`changed`), OR
  //   - the latched epochChanged flag from a recent transition is still set
  //     (the toast hasn't consumed it yet — e.g. back-to-back snapshots in one
  //     reactive tick), OR
  //   - any session in this snapshot is still hydrated===false (its tail hasn't
  //     been pulled yet → the lastAgents map is incomplete).
  // `state.epochChanged` is read BEFORE the latch is (re)set below, so the first
  // transition snapshot is caught via `changed` and later window snapshots via
  // the latch / hydration. Only an EXPLICIT hydrated===false counts — an omitted
  // gate (older daemon) or omitted hydrated must NOT pin resync mode forever
  // (that would reintroduce the overcorrection and block legitimate clears).
  const resyncing =
    changed ||
    state.epochChanged ||
    Object.values(snap.gate || {}).some((g) => !!g && g.hydrated === false);
  setState(
    produce((s) => {
      // Reconcile: replace the session set with the authoritative snapshot.
      s.sessions = {};
      for (const sess of snap.sessions || []) s.sessions[sess.id] = sess;
      s.activity = { ...(snap.activity || {}) };
      // B2a: merge-protect labels only INSIDE the resync window (above) so a
      // mid-aggregation snapshot can ADD/UPDATE but never wipe. Outside the
      // window the server map is authoritative — a wholesale replace lets a
      // legitimate clear (an id the server omits) propagate. mergeLastAgents
      // semantics are unchanged for the resync branch (incoming non-empty wins;
      // FE entries the snapshot omits are kept). The wholesale branch also
      // prunes orphans: ids absent from snap.lastAgents are dropped.
      s.lastAgents = resyncing
        ? mergeLastAgents(s.lastAgents, snap.lastAgents || {})
        : { ...(snap.lastAgents || {}) };
      // Tier-A current-verb facets seed from the snapshot (active sessions only;
      // the daemon omits idle/cleared ones). Ephemeral — never persisted.
      s.currentVerbs = { ...(snap.currentVerbs || {}) };
      s.permissions = {};
      for (const [sid, perms] of Object.entries(snap.permissions || {})) {
        s.permissions[sid] = {};
        for (const p of perms) s.permissions[sid][p.id] = p;
      }
      s.questions = {};
      for (const [sid, qs] of Object.entries(snap.questions || {})) {
        s.questions[sid] = {};
        for (const q of qs) s.questions[sid][q.id] = q;
      }
      s.todos = {};
      for (const [sid, v] of Object.entries(snap.todos || {})) s.todos[sid] = normalizeTodos(v);
      s.unread = {};
      for (const id of snap.unread || []) s.unread[id] = true;
      // S3 epoch transition: latch so the connection-health toast can surface
      // "Server restarted — re-syncing…". The merge-protect above already
      // shielded the labels from this (potentially mid-aggregation) snapshot.
      if (changed) s.epochChanged = true;
      if (incomingEpoch) s.epoch = incomingEpoch;
      s.cursor = snap.seq;
    }),
  );
  // Wholesale session-set replacement invalidates the parent→children index.
  invalidateChildrenIndex();
  persist();
  // Phase 3 Gate B: record the applied revision (complete path).
  if (snap.structuralRevision !== undefined)
    lastAppliedStructuralRevision = snap.structuralRevision;
}

// applyProjectedSnapshot — Phase 2 Gate A merge path. When `snap.projected` is
// true, the snapshot carries only the ACTIVE CLOSURE + frontier stubs (Phase 4
// builds the projection; Phase 2 just wires the merge machinery). Sessions
// ABSENT from the array are PRESERVED as hidden — they are collapsed behind a
// frontier stub on the server and will be lazy-expanded on demand. Only an
// explicit `session.delete` event removes a session (Gate A core rule:
// projected snapshots MAY NOT infer deletion from omission).
//
// Merge semantics per slice:
//   - sessions:       UPSERT incoming; PRESERVE absent (hidden !== deleted).
//   - activity:       UPSERT incoming; PRESERVE absent.
//   - lastAgents:     MERGE (incoming non-empty wins; FE entries the snapshot
//                     omits are kept — same as the resync-window path).
//   - currentVerbs:   UPSERT incoming; PRESERVE absent.
//   - permissions:    REPLACE per-session for sessions present in snap; PRESERVE
//                     sessions absent (their perms are still live — a hidden
//                     session can still have a pending permission).
//   - questions:      Same as permissions.
//   - todos:          Same as permissions.
//   - unread:         MERGE (incoming non-empty wins; absent roots preserved).
//   - epoch/cursor:   Always update (projected snapshots advance the cursor).
//
// Transcript orthogonality (Gate F): this function touches NONE of
// messages/messagesLoaded/messageWindows/Stream-2/msgRev. Those are owned by
// the open-session lifecycle and are orthogonal to the tree projection.
function applyProjectedSnapshot(snap: Snapshot) {
  const incomingEpoch = snap.epoch || "";
  const changed = epochChanged(state.epoch, incomingEpoch);
  setState(
    produce((s) => {
      // Sessions: upsert incoming, PRESERVE absent. This is the core Gate A
      // rule — a session omitted from a projected snapshot is hidden, not
      // deleted. Only session.delete removes it.
      for (const sess of snap.sessions || []) s.sessions[sess.id] = sess;
      // Activity: upsert incoming, preserve absent.
      if (snap.activity) {
        for (const [id, act] of Object.entries(snap.activity)) s.activity[id] = act;
      }
      // lastAgents: merge (same semantics as the resync-window path — incoming
      // non-empty wins, absent preserved). A projected snapshot may omit labels
      // for sessions it didn't materialize; keep the FE cache.
      s.lastAgents = mergeLastAgents(s.lastAgents, snap.lastAgents || {});
      // currentVerbs: upsert incoming, preserve absent.
      if (snap.currentVerbs) {
        for (const [id, v] of Object.entries(snap.currentVerbs)) s.currentVerbs[id] = v;
      }
      // Permissions: replace per-session for sessions present in the snapshot;
      // preserve absent sessions (their pending permissions are still live).
      for (const [sid, perms] of Object.entries(snap.permissions || {})) {
        s.permissions[sid] = {};
        for (const p of perms) s.permissions[sid][p.id] = p;
      }
      // Questions: same as permissions.
      for (const [sid, qs] of Object.entries(snap.questions || {})) {
        s.questions[sid] = {};
        for (const q of qs) s.questions[sid][q.id] = q;
      }
      // Todos: replace per-session for sessions present; preserve absent.
      for (const [sid, v] of Object.entries(snap.todos || {})) s.todos[sid] = normalizeTodos(v);
      // Unread: merge (incoming wins, absent preserved — a hidden root can still
      // be unread).
      for (const id of snap.unread || []) s.unread[id] = true;
      // Stubs (Phase 4): upsert incoming stubs. Replace the stub map entirely
      // when cause="initial" or "promotion" (the server re-projects the full
      // frontier); merge for "lazy-expand" (partial branch expansion). On epoch
      // change, clear all stubs first (server restart invalidates them), then
      // upsert the incoming stubs (they're from the NEW server).
      if (changed) {
        s.branchStubs = {};
        for (const stub of snap.stubs || []) s.branchStubs[stub.id] = stub;
      } else if (snap.cause === "initial" || snap.cause === "promotion" || snap.cause === "reconnect" || snap.cause === "resync") {
        s.branchStubs = {};
        for (const stub of snap.stubs || []) s.branchStubs[stub.id] = stub;
      } else {
        // lazy-expand or cause absent: merge
        for (const stub of snap.stubs || []) s.branchStubs[stub.id] = stub;
      }
      // Epoch transition: latch for the connection-health toast. On epoch
      // change, clear expandedBranches (server restart invalidates all stubs).
      if (changed) {
        s.epochChanged = true;
        s.expandedBranches = {};
      }
      if (incomingEpoch) s.epoch = incomingEpoch;
      s.cursor = snap.seq;
    }),
  );
  // The merge may have added/changed sessions — invalidate the children cache.
  invalidateChildrenIndex();
  persist();
}

// Exported for integration tests (tests/unit/applySnapshot.test.ts).
export function applySessionEvent(kind: string, seq: number, payload: any) {
  bumpUpdating();
  setState(
    produce((s) => {
      if (kind === "session.upsert") s.sessions[payload.id] = payload;
      else if (kind === "session.delete") {
        delete s.sessions[payload.id];
        // B2b: prune the per-session metadata maps so a deleted session's facts
        // don't leak and can't resurrect on id-reuse. lastAgents is a
        // snapshot-seeded facet that must not outlive the session; messagesLoaded
        // is the open-session delivery flag, cleared here to stay consistent with
        // the session's removal. (s.messages is owned by the Stream-2 / openSession
        // lifecycle and reconciled separately, so it is NOT pruned here — see
        // SyncState.messagesLoaded.) Phase 3: messageWindows is pruned for the
        // same reason — a stale window state (hasOlder/oldestResidentID) must not
        // resurrect on id-reuse. Phase 4: pageInFlight (the in-flight
        // historical-page request) is also pruned — a deleted session's in-flight
        // page must not land into a resurrected id-reuse.
        delete s.lastAgents[payload.id];
        delete s.messageWindows[payload.id];
        delete s.messagesLoaded[payload.id];
        delete s.messagesError[payload.id];
        delete s.refreshing[payload.id];
        delete s.branchStubs[payload.id]; // Phase 4: prune collapsed stub
        resetPageInFlight(payload.id);
      }
      if (seq) s.cursor = seq;
    }),
  );
  // session.upsert / session.delete change the parent→children topology.
  invalidateChildrenIndex();
  persist();
}

// Message/part events are applied only for opened sessions (those present in
// state.messages) to bound memory. The mutation logic lives in ./lib/reduce.
// trackCursor: whether this event should advance the persisted resume cursor.
// Stream 2 (active-session messages) passes false — it always re-snapshots on
// connect (never resumes), so letting its high-seq message events advance the
// shared cursor would push Stream 1's resume point PAST structural events it
// hasn't applied yet (e.g. an activity=busy), which then get skipped on
// reconnect — leaving the sidebar stuck on a stale state (the "busy session
// shows idle, no Stop button" bug). Only Stream 1's events move the cursor.
export function applyMessageEvent(kind: string, seq: number, payload: any, trackCursor = true) {
  bumpUpdating();
  setState(
    produce((s) => {
      switch (kind) {
        case "message.upsert": {
          const sm = s.messages[payload.sessionID];
          if (sm) upsertMessage(sm, payload);
          notifyFromMessage(payload);
          break;
        }
        case "message.delete": {
          const sm = s.messages[payload.sessionID];
          if (sm) deleteMessage(sm, payload.messageID);
          break;
        }
        case "part.upsert": {
          const sm = s.messages[payload.sessionID];
          if (sm) upsertPart(sm, payload);
          break;
        }
        case "part.delete": {
          const sm = s.messages[payload.sessionID];
          if (sm) deletePart(sm, payload.messageID, payload.partID);
          break;
        }
        case "messages.loaded": {
          // Slice C async-hydration completion: the daemon finished fetching this
          // session's FULL message history (emitted even when the fetch returned
          // zero or unchanged messages, since those produce no message.* delta).
          // Flip the per-client delivery flag so the transcript moves from
          // "loading" to "delivered-and-empty" (or renders the just-hydrated msg
          // deltas that Stream 2 forwarded alongside this on the same connection).
          // Clear any prior messagesError: a later successful load supersedes a
          // past failure (e.g. retry after a transient background-hydration error).
          if (payload.sessionID) {
            s.messagesLoaded[payload.sessionID] = true;
            delete s.messagesError[payload.sessionID];
          }
          break;
        }
        case "messages.batch": {
          // Cold-load wholesale content: the daemon collapsed the session's
          // entire cold-load message+part history (what would otherwise be N
          // per-message message.upsert + per-part part.upsert events) into ONE
          // event. Ingest it in a single buildMessages mutation — the same path
          // applySessionSnapshot uses for a warm-session snapshot — so the
          // transcript populates without N reactive rounds (over the controller
          // tunnel each event is a yamux frame + WebSocket message, the root
          // cause of the cold-load stall). DECOUPLED from the reveal gate: this
          // carries content only; messages.loaded (still emitted after the batch)
          // flips messagesLoaded so the gate opens. The batch MAY arrive before
          // messages.loaded — that is the whole point (content staged, then the
          // gate flips). Live message.upsert/part.upsert are unchanged.
          //
          // Phase 3 (transcript windowing): after Phase 1's server-side bounded
          // projection, the batch carries the recent TAIL only (default 100 msgs
          // / 1 MiB), and the OUTER payload carries a `window` field (sibling to
          // encoding/data) with has_older/oldest_loaded_id metadata. Populate
          // messageWindows[sid] so the Phase-4 "Load older" path knows whether
          // older messages exist and where the resident tail starts. Back-compat:
          // a pre-Phase-1 server omits `window` → deriveMessageWindow yields
          // {hasOlder:false} (unbounded server, nothing older to fetch).
          if (payload.sessionID) {
            const items = payload.messages || [];
            s.messages[payload.sessionID] = buildMessages(items);
            s.messageWindows[payload.sessionID] = deriveMessageWindow(items, payload.window);
          }
          break;
        }
        case "messages.error": {
          // Background fetch failed; the daemon left the session UNLOADED (it
          // retries on the next selection/reconnect). Record the failure so the
          // chat's visual-reveal gate can fall back to showing whatever partial
          // content was streamed (instead of wedging forever on a blank loading
          // state — messages.loaded never arrives on failure). Log as well.
          if (payload?.sessionID) {
            s.messagesError[payload.sessionID] = true;
            log.warn("sync", "messages hydration failed", {
              id: payload.sessionID,
              error: payload.error,
            });
          }
          break;
        }
        case "activity":
          if (payload.sessionID) s.activity[payload.sessionID] = payload.state;
          // The completion ping is decided AFTER the store updates (below), at
          // the root level — not per-session — so a finished root pings once and
          // noisy subsession completions don't.
          break;
        case "permission.upsert":
          if (payload.sessionID && payload.id) {
            if (!s.permissions[payload.sessionID]) s.permissions[payload.sessionID] = {};
            s.permissions[payload.sessionID][payload.id] = payload;
          }
          break;
        case "permission.delete":
          if (payload.sessionID && s.permissions[payload.sessionID]) {
            delete s.permissions[payload.sessionID][payload.permissionID];
          }
          break;
        case "question.upsert":
          if (payload.sessionID && payload.id) {
            if (!s.questions[payload.sessionID]) s.questions[payload.sessionID] = {};
            s.questions[payload.sessionID][payload.id] = payload;
          }
          break;
        case "question.delete":
          if (payload.sessionID && s.questions[payload.sessionID]) {
            delete s.questions[payload.sessionID][payload.questionID];
          }
          break;
        case "unread.set":
          if (payload.sessionID) s.unread[payload.sessionID] = true;
          break;
        case "unread.clear":
          if (payload.sessionID) delete s.unread[payload.sessionID];
          break;
        case "todo":
          // OpenCode TodoWrite snapshot for a session (full list each time). The
          // event payload is the `{ sessionID, todos }` envelope.
          if (payload.sessionID) s.todos[payload.sessionID] = normalizeTodos(payload);
          break;
        case "activity.verb":
          // Tier-A rich-activity facet for an UNOPENED session: the RAW tool
          // primitive (tool + trimmed state) so the chat row can format
          // "Reading parser.go" via toolVerb/toolSubject without loading Tier-B
          // messages. Empty tool clears it (idle/error/turn-complete). Mirrors
          // the activity/todo live-patch patterns; Stream-1 always-streams it
          // (sendable passes any kind not prefixed message./part.).
          if (payload.sessionID) {
            if (payload.tool) s.currentVerbs[payload.sessionID] = { tool: payload.tool, state: payload.state };
            else delete s.currentVerbs[payload.sessionID];
          }
          break;
        case "lastAgent.set":
          // Cold-seed live-patch: the daemon's background seedColdLastAgents
          // (a non-blocking goroutine) usually finishes AFTER this client's
          // first snapshot landed, so Snapshot.LastAgents didn't carry this
          // session's agent. This event delivers the seeded agent name to an
          // already-connected client so the per-agent chip renders in the tree
          // BEFORE the session is opened. sessionLastAgent still prefers the
          // live message scan once messages load (live-scan-takes-precedence),
          // so this only fills the cold gap. Mirrors activity.verb's pattern
          // (a snapshot-only facet pushed live).
          if (payload.sessionID) {
            if (payload.agent) s.lastAgents[payload.sessionID] = payload.agent;
            else delete s.lastAgents[payload.sessionID];
          }
          break;
        case "status":
          // A session.error event carries an `error` payload (activity already
          // flipped to "error" via the separate activity event). Surface it so a
          // failed turn/resume is VISIBLE — e.g. prompt_async reports a turn that
          // couldn't start as a session.error rather than silently doing nothing.
          if (payload?.error && payload.sessionID) {
            const e = payload.error;
            pushNotification({
              kind: "error",
              sessionID: payload.sessionID,
              title: "errored",
              detail: e?.data?.message || e?.message || e?.name || "Session error",
            });
          }
          break; // activity drives the indicator; this only adds the notification
      }
      if (trackCursor && seq) s.cursor = seq;
    }),
  );
  if (kind === "activity" && payload.sessionID) {
    maybeNotifyRootDone(payload.sessionID);
    maybeClearWaiting(payload.sessionID); // resumed working → no longer awaiting you
  }
  if ((kind === "permission.delete" || kind === "question.delete") && payload.sessionID) {
    maybeClearWaiting(payload.sessionID); // answered → ack the "needs input" nudge
  }
  persist();
}

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
      setState("messages", id, buildMessages(items));
      setState("messagesLoaded", id, true);
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

let es: EventSource | null = null;
// Two INDEPENDENT liveness clocks — the dead-but-OPEN Stream2 bug (a frozen
// transcript with the `updating` pulse lit and no reconnect) came from a single
// shared `lastSeen` that Stream1's 15s server ping kept fresh forever, so the
// watchdog's `Date.now() - lastSeen > STALE_MS` could NEVER age out for a dead
// Stream2 while the tree was healthy. Each stream now owns its own clock and the
// watchdog evaluates each independently.
//   treeLastSeen    — Stream1 (tree: sessions/activity/permissions/...). Backs
//                     the global `isStale()` indicator (the status dot = global
//                     connection health) and the tree-stream watchdog branch.
//   sessionLastSeen — Stream2 (active-session messages). Drives the Stream2
//                     stale-but-OPEN watchdog branch → forced fresh-snapshot
//                     reconnect. 0 = "never seen / just reset" → treated as
//                     not-stale (like the old code's `lastSeen > 0` guard), so a
//                     not-yet-open or just-reconnected Stream2 gets a fresh
//                     deadline instead of inheriting a stale timestamp.
let treeLastSeen = 0;
let sessionLastSeen = 0;
let reconnectTimer: number | undefined;
let backoff = 1000; // grows on repeated failures, reset on a healthy open
let everOpened = false; // first stream open is the initial load; later opens are reconnects
export const STALE_MS = 45_000; // ~3 missed 15s pings → assume the stream is dead

// --- Feature 1: staleness (S1) ---------------------------------------------
// healthNow is a coarse tick (bumped by the watchdog) so staleness re-evaluates
// over wall-clock time even with no store writes. isStale reads the
// NON-reactive module `treeLastSeen` (plain var → no per-event subscription), so
// consumers of isStale only re-run on healthNow / state.status changes, not on
// every SSE byte. This keeps the stale indicator off the per-token hot path.
const [healthNow, setHealthNow] = createSignal(0);
// tickHealth advances the coarse health tick WITHOUT touching the watchdog's
// reconnect logic. Called on a faster cadence than the 10s watchdog (see
// startSync) so a stale-but-open socket surfaces the stale indicator BEFORE the
// watchdog reconnects it — otherwise isStale() could never render (the
// watchdog flips status to "reconnecting" in the same tick it detects staleness).
export function tickHealth() {
  setHealthNow((n) => n + 1);
}
export function isStale(): boolean {
  healthNow(); // subscribe to the coarse tick
  // Reads the TREE clock only: the status dot represents GLOBAL connection
  // health. A dead-but-OPEN Stream2 (selected-session messages) does NOT flip
  // the global status to stale/disconnected — it surfaces via the per-session
  // `refreshing[id]` dot and is healed by the Stream2 watchdog branch below.
  return state.status === "live" && treeLastSeen > 0 && Date.now() - treeLastSeen > STALE_MS;
}
// lastSeenStateWritten throttles the mirror into the reactive store: the mark*
// helpers fire on every SSE byte, but writing state.lastSeen that often would
// notify the debug surfaces per-token. Bound it to ~1 write/sec. The mirror now
// tracks treeLastSeen (the value the global status dot represents); it is a
// debug-only field — isStale() reads the unthrottled module var, not state.
let lastSeenStateWritten = 0;
// markTreeSeen updates Stream1's liveness clock and (throttled) the reactive
// mirror consumed by debug surfaces. Called from every Stream1 listener.
function markTreeSeen() {
  treeLastSeen = Date.now();
  const now = treeLastSeen;
  if (now - lastSeenStateWritten >= 1000) {
    lastSeenStateWritten = now;
    setState("lastSeen", now);
  }
}
// markSessionSeen updates Stream2's liveness clock ONLY. No reactive mirror —
// Stream2 health surfaces through `refreshing[id]` and the watchdog, not the
// global status dot. Called from every Stream2 listener (gen-guarded).
function markSessionSeen() {
  sessionLastSeen = Date.now();
}

// --- Feature 2: anti-spam "updating" indicator (U3 debounce) ---------------
// Leading edge lights the indicator on the first data event; trailing edge
// holds it for UPDATING_DEBOUNCE_MS after the LAST event, then clears. A token
// stream (events <600ms apart) keeps it continuously lit without per-token
// flicker; a pause longer than the window turns it off. bumpUpdating is called
// at the top of applySnapshot/applySessionEvent/applyMessageEvent — the data
// reconciliation entry points for both streams.
export const UPDATING_DEBOUNCE_MS = 600;
const [updating, setUpdating] = createSignal(false);
let updatingTimer: number | undefined;
export function isUpdating(): boolean {
  return updating();
}
function bumpUpdating() {
  setUpdating(true);
  clearTimeout(updatingTimer);
  updatingTimer = window.setTimeout(() => setUpdating(false), UPDATING_DEBOUNCE_MS);
}

// advanceCursor — cursor-only path for deferred Stream-1 frames during a global
// busy scope. applySnapshot/applySessionEvent/applyMessageEvent couple cursor
// advancement with store mutation; this extracts just the cursor+persist so the
// resume point stays current while the store is left untouched. The gate then
// latches dirty (if reconciling) so the final coalesced refresh catches up.
function advanceCursor(seq: number) {
  if (seq) {
    setState("cursor", seq);
    persist();
  }
}

// applyTreeFrame — hardens a Stream-1 (tree) event frame against a malformed
// MessageEvent.data payload. Parses raw, and on a malformed parse advances the
// resume cursor (so a permanently-bad frame the server keeps resending from the
// saved cursor can't wedge reconnect in an infinite replay loop) then returns
// WITHOUT mutating the store. On a well-formed parse it dispatches to the
// supplied apply fn, which advances the cursor itself (applySessionEvent /
// applyMessageEvent via trackCursor). The gate-active early-return
// (advanceCursor + markBusyDirty) stays in the listener — this only owns the
// parse + the malformed-cursor contract. Exported so the malformed-frame
// no-throw + cursor-advance contract is unit-testable without an EventSource,
// mirroring the applySessionSnapshot extraction precedent.
export function applyTreeFrame(
  kind: string,
  seq: number,
  raw: string,
  apply: (kind: string, seq: number, payload: any) => void,
) {
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    log.warn("sync", "malformed tree frame", { kind, seq, err });
    // Account for the RECEIVED frame so resume skips it — a malformed frame will
    // always be malformed, so replaying it on reconnect (the server resends
    // events with seq > cursor) would throw forever. Mirrors the gate-active
    // path's advanceCursor(seq) at the listener call sites.
    advanceCursor(seq);
    return;
  }
  apply(kind, seq, payload);
}

// === Stream 1: tree + notifications (persistent) ============================
// Structural (session/activity/status) + notification (permission/question)
// events for ALL sessions. The server omits message/part events here
// (sessions=""), so a busy project's background token-delta flood never delays
// these important events. Resumable via cursor; watchdog + backoff guarded.
//
// `fresh` forces a full snapshot (no cursor) instead of resuming. Used on a page
// load / project switch, where in-memory state was just hydrated from
// localStorage and is INCOMPLETE — only sessions+activity are persisted, not
// pending permissions/questions/unread. Resuming from the saved cursor would
// replay only events AFTER it, so any state established before the cursor (a
// busy activity, a pending permission/question) would be invisible. A snapshot
// reconciles all current state authoritatively. Transient in-page reconnects
// (watchdog/onerror/visibility) resume normally: in-memory state is intact, and
// the server falls back to a snapshot itself if the gap exceeds its ring buffer.
// --- Feature 3: connection-vs-first-snapshot latency diagnostic (L1, FE-only) -
// Purely additive instrumentation (zero server change). For each stream we
// capture performance.now() stamps and derive deltas:
//   open    = onopen − EventSource construction      (pure connection latency)
//   snap    = first snapshot FRAME − onopen          (end-to-end: server compute + serialize +
//                                                      tunnel transport of the payload through
//                                                      the controller; under refreshOpenSessions
//                                                      fan-out the transport dominates, NOT
//                                                      server compute). The snapshot payload is
//                                                      gzip64-compressed when large (a warm open
//                                                      of a loaded session inlines the whole
//                                                      transcript) — `snap` measures transport of
//                                                      the COMPRESSED size, which is the win this
//                                                      surfaces. Stamped on frame ARRIVAL, before
//                                                      the client-side decode, so it stays a pure
//                                                      transport signal (decode is ms-scale CPU).
//   hydrate = messages.loaded arrival − first snapshot   [SESSION STREAM ONLY]
//                                                      (upstream full-fetch wait —
//                                                      the gap `snap` misses on a
//                                                      cold session: the snapshot
//                                                      ships instantly with
//                                                      gate.messagesLoaded=false,
//                                                      then the daemon fetches the
//                                                      full history async; the
//                                                      client reveal gate holds
//                                                      until messages.loaded)
// The first snapshot per connection bounds `snap`; later snapshots are normal
// deltas and aren't timed. `hydrate` records once per connection (only on a
// cold first snapshot); a warm first snapshot (gate.messagesLoaded!==false) is
// stamped "warm" since messages.loaded never arrives for it. Surfaces in
// ServersPanel as "conn Xms · snap Yms · hydrate (Yms|warm|…)" so an operator
// can tell a slow connection from a slow first-snapshot (server compute + tunnel
// transport) from a slow upstream fetch.
function recordLatency(stream: "tree" | "session", phase: "open" | "snap", ms: number): void {
  setState("connLatency", stream, phase, Math.max(0, Math.round(ms)));
}
// recordSessionHydrate writes the session-stream `hydrate` L1 stamp (kept
// separate from recordLatency because its value is a number|"warm"|undefined
// union, not a rounded ms). number = cold session, messages.loaded delta ms;
// "warm" = first snapshot already had gate.messagesLoaded===true (no fetch
// needed); undefined = cold and waiting for messages.loaded (clears any stale
// value from a prior connection so the UI shows the in-progress wait).
function recordSessionHydrate(value: number | "warm" | undefined): void {
  setState(
    "connLatency",
    "session",
    "hydrate",
    typeof value === "number" ? Math.max(0, Math.round(value)) : value,
  );
}
// recordSessionFetchSplit writes the session-stream `fetchMs`/`reconcileMs` L1
// stamps — the daemon-side split of `hydrate` (only present on a COLD session
// that fired messages.loaded): fetchMs = upstream OpenCode GET round-trip,
// reconcileMs = daemon SetSessionMessages. undefined = not reported for this
// connection yet (older daemon omits the fields on the wire; a warm session
// never fires messages.loaded; a cold fetch is still in flight). Cleared on
// each (re)open's first snapshot so a stale value from a prior connection can't
// leak. Reads defensively — the payload is JSON, fields optional on the wire.
function recordSessionFetchSplit(fetchMs: number | undefined, reconcileMs: number | undefined): void {
  setState(
    "connLatency",
    "session",
    "fetchMs",
    typeof fetchMs === "number" ? Math.max(0, Math.round(fetchMs)) : undefined,
  );
  setState(
    "connLatency",
    "session",
    "reconcileMs",
    typeof reconcileMs === "number" ? Math.max(0, Math.round(reconcileMs)) : undefined,
  );
}
// Per-connection stamps/flags. Reset on each (re)open; snap recorded once.
let treeT0 = 0;
let treeT1 = 0;
let treeSnapDone = false;
// treeGen is the tree-stream connection generation. Bumped at every connect()
// so an async gzip64 snapshot decode captured by a PRIOR (now-closed)
// connection can detect it was superseded and refuse to mutate the store.
// Mirrors Stream 2's sesGen: a sync listener is naturally bounded by es.close()
// (pending events are dropped), but the gzip64 snapshot decode AWAITs, so the
// close can land mid-decode. The captured `gen` is checked at listener entry
// and again after the await. Without this, a stale decode from a superseded
// connection would clobber the replacement's fresh state with a stale snapshot.
let treeGen = 0;
// Phase 3 Gate B: last-applied structural revision. Used to discard stale
// snapshot responses (<), skip idempotent re-applies (==), and apply newer
// (>). Reset to undefined on epoch change (a new epoch starts fresh). When
// either side is undefined (old server or fresh client), always apply.
let lastAppliedStructuralRevision: number | undefined = undefined;
// In-flight gzip64 snapshot decode for the CURRENT tree connection. A warm
// tree snapshot ships compressed (server maybeCompressSnapshot when z=1); the
// decode is ASYNC (native DecompressionStream). applySnapshot
// WHOLESALE-REPLACES state.sessions AND unconditionally sets
// state.cursor=snap.seq, so a session.upsert/session.delete/TREE_STREAM_KINDS
// frame landing in the decode window would have its store mutation clobbered
// AND the cursor REGRESSED from the live event's higher seq back to the
// snapshot's seq when the stale-but-now-decoded snapshot lands. Promise-gate
// exactly like sesSnapshotDecode: the tree live-event listeners await this
// before processing ANY frame for the stream. Connect-time only (a snapshot
// decode is ms-scale) and bounded to one (the current connection's). Reset on
// each (re)open. treeSnapshotDecoding is the cheap boolean the fast path
// checks to avoid a microtask when no decode is in flight (tree event floods
// must stay zero-latency).
let treeSnapshotDecode: Promise<void> = Promise.resolve();
let treeSnapshotDecoding = false;
let sesT0 = 0;
let sesT1 = 0;
let sesSnapDone = false;
// L1 hydrate stamps (session stream only). sesFirstSnap = first-snapshot
// arrival time (hydrate t0); sesHydrating = the first snapshot was cold
// (gate.messagesLoaded===false) so a later messages.loaded closes the window.
let sesFirstSnap = 0;
let sesHydrating = false;
// In-flight messages.batch decodes keyed by sessionID. The batch payload is
// application-compressed (gzip+base64) and its decode is ASYNC (native
// DecompressionStream); EventSource fires the next event (messages.loaded) as
// soon as the batch listener RETURNS — i.e. before the decode resolves.
// Without coordination messages.loaded would flip messagesLoaded (the reveal
// gate) before the batch content staged → flash of empty content at reveal.
// The batch listener stashes its decode promise here; the messages.loaded /
// messages.error listener awaits any pending entry for the session before
// flipping the gate. Cleared as each batch lands (try/finally in the listener).
const pendingBatch = new Map<string, Promise<void>>();
// In-flight gzip64 snapshot decode for the CURRENT session connection. A warm
// open ships the transcript compressed (server maybeCompressSnapshot); the
// decode is ASYNC (native DecompressionStream). applySessionSnapshot
// WHOLESALE-REPLACES messages[id], so a message.upsert/part.upsert landing in
// the decode window would be applied then silently clobbered by the stale-but-
// now-decoded snapshot. Promise-gate exactly like pendingBatch: the shared
// message-kind listener awaits this before processing ANY live event for the
// session. Connect-time only (a snapshot decode is ms-scale) and bounded to one
// (the current connection's). Reset on each (re)open. sesSnapshotDecoding is
// the cheap boolean the firehose path checks to avoid a microtask when no decode
// is in flight (message.upsert/part.upsert floods must stay zero-latency).
let sesSnapshotDecode: Promise<void> = Promise.resolve();
let sesSnapshotDecoding = false;

// TREE_STREAM_KINDS — the named SSE events Stream 1 (the tree stream)
// subscribes to and forwards to applyMessageEvent. Exported so a unit test
// can PIN it: a snapshot-only facet pushed live (activity.verb,
// lastAgent.set) MUST appear here, or EventSource silently drops the frame
// even though applyMessageEvent has the handler case — that was the
// cold-chip gap (handler present, listener absent). Structural session
// events (session.upsert/delete) route through applySessionEvent and are
// registered in a separate loop above; message.* kinds are Stream 2
// (active-session) only.
export const TREE_STREAM_KINDS = [
  "status",
  "activity",
  "activity.verb",
  "lastAgent.set",
  "permission.upsert",
  "permission.delete",
  "question.upsert",
  "question.delete",
  "unread.set",
  "unread.clear",
  "todo",
] as const;

// --- Global busy-scope gate (archive/unarchive) -----------------------------
// While a global busy scope is active (see ../busy.ts), stream frames are
// deferred: markTreeSeen/markSessionSeen run (watchdog health), but store
// mutation is suppressed.
// On the outermost release, reconcileBusy() requests fresh authoritative
// snapshots. expectTreeSnap / expectSessionSnap identify the ONE expected fresh
// snapshot per stream (from connect(true) / openSessionStream); all other frames
// during reconciliation are deferred + latch dirty. The precheck found that
// applySnapshot sets s.cursor = snap.seq UNCONDITIONALLY (no seq>cursor guard),
// so a fresh snapshot CAN clobber newer accepted state — therefore the gate is
// retained through both resume snapshots and the dirty-pass rule applies (at most
// one extra coalesced pass).
let expectTreeSnap = false;
let expectSessionSnap = false;
let reconcileResolve: (() => void) | null = null;
let reconcileTimer: number | undefined;

// maybeResolveReconcile — resolves the pending reconciliation promise once ALL
// expected snapshots have been applied (or were superseded by a stale-epoch
// discard). Called from the snapshot listeners after each expected frame lands.
function maybeResolveReconcile() {
  if (!expectTreeSnap && !expectSessionSnap && reconcileResolve) {
    const r = reconcileResolve;
    reconcileResolve = null;
    clearTimeout(reconcileTimer);
    r();
  }
}

// reconcileBusy — registered with busy.ts via setReconcileFn. Called on the
// outermost busy release. Requests ONE fresh tree snapshot (connect(true) drops
// the tree EventSource and reconnects with no cursor) and ONE fresh session
// snapshot for the selected session (openSessionStream drops + reconnects).
// Resolves once both expected snapshots have been applied, or a 15s safety
// timeout. If no session is selected, only the tree refresh is requested.
function reconcileBusy(): Promise<void> {
  return new Promise<void>((resolve) => {
    const sel = selectedId();
    reconcileResolve = resolve;
    expectTreeSnap = true;
    expectSessionSnap = !!sel;
    connect(true);
    // force=true so the selected session's Stream-2 EventSource is recreated
    // even when it's already healthy/open — the fresh snapshot this produces is
    // what clears expectSessionSnap and resolves reconciliation promptly.
    if (sel) openSessionStream(sel, true);
    // Safety: if the fresh snapshots don't arrive in 15s (e.g. the server is
    // unresponsive), clear the flags and resolve so the overlay doesn't wedge.
    clearTimeout(reconcileTimer);
    reconcileTimer = window.setTimeout(() => {
      expectTreeSnap = false;
      expectSessionSnap = false;
      maybeResolveReconcile();
    }, 15_000);
    // If there's nothing to wait for (shouldn't happen — expectTreeSnap is
    // always set — but defensive), resolve immediately.
    maybeResolveReconcile();
  });
}

// Register the reconciliation callback once at module load. reconcileBusy is a
// hoisted function declaration; connect/openSessionStream are also hoisted, so
// the reference is valid even though they're textually defined below.
setReconcileFn(reconcileBusy);

// isTreeSnapshotDecoding — test-only peek at the module-private decode flag.
// DecompressionStream's internal pipeline chains multiple microtasks; tests
// using fake timers loop flushes until this flips false so the flush count is
// deterministic regardless of suite load (a fixed flush count is fragile).
export function isTreeSnapshotDecoding(): boolean {
  return treeSnapshotDecoding;
}

// getTreeSnapshotDecode — test-only accessor for the in-flight decode promise.
// Lets tests await the decode directly (deterministic) instead of pumping fake
// timers (which is fragile with native DecompressionStream under load).
export function getTreeSnapshotDecode(): Promise<void> {
  return treeSnapshotDecode;
}

export function connect(fresh = false) {
  clearTimeout(reconnectTimer);
  // Invalidate any in-flight async gzip64 snapshot decode captured by a PRIOR
  // connection BEFORE we close it. Bumping the generation first means a stale
  // decode's post-await gen check fails and it refuses to mutate the store,
  // even on the empty-projectDir early-return path (switchProject("") →
  // connect()). Mirrors Stream 2's closeSessionStream order (sesGen++ BEFORE
  // ses?.close()); the prior Stream-1 order (close THEN bump) left a stale-
  // decode hazard on the empty-dir path.
  treeGen++;
  // Phase 3 Gate B: a fresh connect (project switch or explicit tree refresh)
  // means the next snapshot comes from a potentially different Store whose
  // structuralRevision counter is independent. Reset so the guard always
  // applies the incoming snapshot instead of comparing across Stores.
  if (fresh) lastAppliedStructuralRevision = undefined;
  // Reset the in-flight decode gate so a live tree event landing on the new
  // connection doesn't await a stale decode from the prior connection.
  treeSnapshotDecode = Promise.resolve();
  treeSnapshotDecoding = false;
  es?.close();
  // No project selected (daemon cwd is not a meaningful project): do NOT open
  // a tree stream. The watchdog/maybeReconnect also no-op while projectDir is
  // empty, so nothing auto-reconnects the cwd bridge. Selecting a project
  // (switchProject) calls connect(true) explicitly.
  if (!projectDir()) {
    es = null;
    return;
  }
  const cursorParam = fresh ? "" : `cursor=${state.cursor}&`;
  treeT0 = performance.now(); // L1 t0: connection attempt begins
  treeT1 = 0;
  treeSnapDone = false;
  // Capture the generation for THIS connection's listeners. The bump above
  // already invalidated any prior decode; this `gen` is checked at listener
  // entry and after every await in the snapshot listener.
  const gen = treeGen;
  // Stream 1 (tree) opts into the server's gzip64 snapshot compression with
  // `&z=1`, mirroring Stream 2's session stream. The tree snapshot for a real
  // project is ~760 KiB–1.1 MiB of highly repetitive JSON (one project, one
  // directory, a handful of agents/models) and ships UNCOMPRESSED through the
  // controller tunnel without this flag (the tunnel does not compress at any
  // lower layer). gzip cuts it to ~150–200 KiB on the wire — ~5–7x smaller.
  // The server's maybeCompressSnapshot only wraps payloads ≥ 2 KiB AND only
  // when z=1 is set, so small/raw responses (an old server, or an edge-case
  // tiny tree) still ship raw and the listener handles both shapes.
  // `&proj=1` (Phase 2 Gate A): opts into projected (collapsed-frontier)
  // snapshot mode. The server reads this via wantsProject(); when it supports
  // projection (Phase 4+), it emits `projected:true` on the envelope and the
  // client takes the merge path. An old server ignores proj=1 and emits
  // AUTHORITY_COMPLETE (no `projected` field), so the client transparently
  // falls back to wholesale-replace. Independent from z=1.
  es = new EventSource(`/vh/stream?${cursorParam}sessions=&dir=${encodeURIComponent(projectDir())}&z=1&proj=1`);
  markTreeSeen();
  log.debug("sync", "tree stream connect", { cursor: fresh ? "fresh" : state.cursor, dir: projectDir() });
  es.addEventListener("snapshot", (e) => {
    // Generation guard: ignore frames from a superseded connection BEFORE
    // touching the clock or the store. The gzip64 path awaits, so this same
    // guard is re-checked after the await — a stale decode must NOT mutate the
    // store or clear state. Mirrors Stream 2's sesGen guard.
    if (gen !== treeGen) return;
    markTreeSeen();
    // Parse the outer envelope ONCE. The server emits either the raw snapshot
    // JSON (small/legacy) OR {encoding:"gzip64", data:base64(gzip(snapshot))}
    // when z=1 AND the payload exceeds the threshold. The decode helper is a
    // total function (pass-through when no envelope), so both shapes work.
    let raw: any;
    try {
      raw = JSON.parse((e as MessageEvent).data);
    } catch (err) {
      // A malformed snapshot carries an UNREADABLE seq (it lives in the JSON
      // body, not the SSE id field), so the resume cursor can't be advanced from
      // the body. But a snapshot is a fresh FULL-STATE reconciliation (not a
      // per-seq replay frame), so dropping it is safe: live tree events keep
      // advancing the cursor meanwhile, and the next snapshot (a watchdog
      // reconnect / server re-snapshot) reconciles everything authoritatively.
      log.warn("sync", "malformed tree snapshot frame", { err });
      return;
    }
    // applySnap owns the full post-decode state transition (gate short-circuit,
    // expectTreeSnap resolution, wholesale apply, latency, status, refresh).
    // Defined as a closure so BOTH the compressed IIFE and the synchronous raw
    // path run the exact same logic — no divergence between the two shapes.
    const applySnap = (snap: Snapshot) => {
      if (isGateActive() && !expectTreeSnap) {
        // Deferred tree snapshot during a busy scope — advance the resume cursor
        // (Stream 1) but do NOT mutate the store or run refreshOpenSessions.
        advanceCursor(snap.seq);
        markBusyDirty();
        return;
      }
      if (expectTreeSnap) {
        expectTreeSnap = false;
        maybeResolveReconcile();
      }
      applySnapshot(snap);
      // L1 t2: first snapshot of this connection → server-processing delta.
      if (!treeSnapDone) {
        treeSnapDone = true;
        if (treeT1) recordLatency("tree", "snap", performance.now() - treeT1);
      }
      setState("status", "live");
      void refreshOpenSessions();
    };
    // Compressed path: async decode, gated behind treeSnapshotDecode so live
    // session.upsert/session.delete/TREE_STREAM_KINDS frames in the decode
    // window serialize behind it (the shared tree listeners await it) —
    // applySnapshot WHOLESALE-REPLACES state.sessions and unconditionally sets
    // state.cursor=snap.seq, so a live event applied mid-decode would have its
    // store mutation clobbered AND the cursor REGRESSED from the live event's
    // higher seq back to the snapshot's seq when the stale-but-now-decoded
    // snapshot lands. Until applySnap runs the PRIOR tree state stays in place
    // → no flash-of-empty through the decode window. Raw path: synchronous
    // apply, exactly the legacy behavior (cold small trees, zero decode
    // latency). Mirrors Stream 2's sesSnapshotDecode pattern verbatim.
    if (raw.encoding === "gzip64") {
      treeSnapshotDecoding = true;
      treeSnapshotDecode = (async () => {
        try {
          let snap: Snapshot;
          try {
            snap = await decodeSnapshot<Snapshot>(raw);
          } catch (err) {
            // decodeSnapshot is a total function (returns {} on malformed), so
            // this catch is defensive — but never let a decode throw propagate
            // to an unhandled promise rejection. Drop the frame; live events +
            // the next snapshot reconcile.
            log.warn("sync", "tree snapshot gzip64 decode failed", { err });
            return;
          }
          // Generation re-check (mirrors Stream 2's post-await sesGen check):
          // the connection may have been replaced while we were decoding. A
          // superseded decode must NOT mutate the store, advance the cursor, or
          // run latency effects: the replacement connection owns the tree state.
          if (gen !== treeGen) return;
          applySnap(snap);
        } finally {
          // Ownership-aware clear: only the CURRENT generation owns the flag.
          // A superseded connection's decode must NOT clear treeSnapshotDecoding
          // while the replacement's decode is still in flight — doing so would
          // re-open the decode-window race across reconnects: the replacement's
          // live-event listeners would take their synchronous fast path (boolean
          // short-circuits to false), apply ahead of the replacement snapshot,
          // and applySnapshot would then wholesale-replace + cursor-regress.
          // The post-await gen check above prevents a stale APPLY; this guard
          // prevents a stale CLEAR. Without it the flag-reset race re-introduces
          // the exact anti-clobber failure the serialize gate exists to close.
          if (gen === treeGen) treeSnapshotDecoding = false;
        }
      })();
    } else {
      applySnap(raw as Snapshot);
    }
  });
  es.addEventListener("ping", () => markTreeSeen()); // heartbeat for the watchdog
  for (const kind of ["session.upsert", "session.delete"]) {
    es.addEventListener(kind, async (e) => {
      markTreeSeen();
      const ev = e as MessageEvent;
      const seq = Number(ev.lastEventId);
      if (isGateActive()) {
        // Deferred — Stream 1 advances the resume cursor but does not mutate.
        advanceCursor(seq);
        markBusyDirty();
        return;
      }
      // Serialize against an in-flight gzip64 snapshot decode for this
      // connection. applySnapshot WHOLESALE-REPLACES state.sessions and sets
      // state.cursor=snap.seq; a live session event applied during the decode
      // window would be clobbered and the cursor REGRESSED when the stale-but-
      // now-decoded snapshot lands. Wait ONLY when a decode is actually in
      // flight — the boolean check is a no-op on the fast path so session
      // event floods keep zero microtask latency. Connect-time only. Mirrors
      // Stream 2's sesSnapshotDecoding gate.
      if (treeSnapshotDecoding) await treeSnapshotDecode;
      // Generation re-check: the connection may have been replaced during the
      // wait. The entry guard ran before the await, so drop the stale
      // continuation here before any state effect.
      if (gen !== treeGen) return;
      // The busy gate may have activated during the wait — defer the same way
      // the synchronous entry path does (advance cursor, latch dirty).
      if (isGateActive()) {
        advanceCursor(seq);
        markBusyDirty();
        return;
      }
      applyTreeFrame(kind, seq, ev.data, applySessionEvent);
    });
  }
  for (const kind of TREE_STREAM_KINDS) {
    es.addEventListener(kind, async (e) => {
      markTreeSeen();
      const ev = e as MessageEvent;
      const seq = Number(ev.lastEventId);
      if (isGateActive()) {
        // Deferred — Stream 1 advances the resume cursor but does not mutate.
        advanceCursor(seq);
        markBusyDirty();
        return;
      }
      // Serialize against an in-flight gzip64 snapshot decode (see the
      // session.upsert listener above for the full rationale).
      if (treeSnapshotDecoding) await treeSnapshotDecode;
      if (gen !== treeGen) return;
      if (isGateActive()) {
        advanceCursor(seq);
        markBusyDirty();
        return;
      }
      applyTreeFrame(kind, seq, ev.data, applyMessageEvent);
    });
  }
  // Daemon-detected alerts (transient; no cursor advance). In-app + OS delivery.
  es.addEventListener("notice", (e) => {
    markTreeSeen();
    try {
      handleNotice(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore malformed notice */
    }
  });
  es.onopen = () => {
    markTreeSeen();
    // L1 t1: socket established → pure connection-latency delta.
    treeT1 = performance.now();
    if (treeT0) recordLatency("tree", "open", treeT1 - treeT0);
    backoff = 1000; // healthy — reset backoff
    setState("status", "live");
    // A reconnect (not the first open) means the stream dropped and came back —
    // typically a vh restart/self-update. Re-check the version so a new build
    // surfaces the reload toast immediately instead of on the next poll.
    if (everOpened) checkVersionNow();
    everOpened = true;
  };
  es.onerror = () => {
    // EventSource auto-retries while CONNECTING; we only step in once it gives
    // up (CLOSED), with backoff, so a flaky network / daemon restart self-heals.
    setState("status", "reconnecting");
    if (es && es.readyState === EventSource.CLOSED) {
      log.warn("sync", "tree stream closed → reconnecting", { backoff });
      clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    }
  };
}

// === Stream 2: active-session messages ======================================
// message/part events for ONLY the open session. Always snapshots fresh (no
// cursor) so switching sessions can't miss/skip deltas; reopened on switch,
// closed when nothing is open. Self-retries on error.
let ses: EventSource | null = null;
let sesId = "";
let sesRetry: number | undefined;
// sesGen: Stream2 connection-generation token. Incremented on EVERY open /
// reopen / close / selection-switch. Captured in every Stream2 listener so a
// callback from a SUPERSEDED connection (closed, replaced, switched-away — or a
// slow decode whose source connection was torn down) is ignored: it must NOT
// refresh the replacement's sessionLastSeen clock or run state effects. This is
// what prevents a dead-but-closing Stream2's in-flight frames from masking the
// freshly-constructed replacement's liveness. The captured value is compared
// against the live sesGen at listener ENTRY (synchronous, before markSessionSeen
// or any store write).
let sesGen = 0;

export function closeSessionStream() {
  clearTimeout(sesRetry);
  // Invalidate any in-flight listeners from the outgoing connection: bump the
  // generation so a stale callback (e.g. a late frame already queued before
  // close() propagated) can't refresh sessionLastSeen or mutate the store.
  sesGen++;
  ses?.close();
  ses = null;
  // Drop the warm silent-swap indicator for the session being closed: if we
  // switch away before its first snapshot lands, its `refreshing` flag would
  // otherwise never be cleared (that connection's snapshot listener is gone),
  // leaking a permanent dot on the row.
  if (sesId) setState("refreshing", sesId, false);
  sesId = "";
  // Phase 4: clear ALL in-flight historical-page requests on connection
  // teardown. A page in flight belongs to the outgoing connection (its
  // flight.gen was captured against THIS sesGen); after the bump above those
  // pages would be discarded by the response gate anyway, but dropping them
  // explicitly here also clears the loadingOlder UI flag via loadOlder's
  // finally block as the in-flight promises settle. resetPageInFlight() with
  // no arg clears the whole map (no session owns a page after teardown).
  resetPageInFlight();
  // Reset Stream2's liveness clock: a not-yet-open / about-to-be-replaced
  // Stream2 must NOT inherit a stale timestamp and be classified stale before
  // it has had a chance to fire. 0 = "never seen" → watchdog treats it as
  // not-stale (gives the next open() a fresh deadline).
  sessionLastSeen = 0;
}

// applySessionSnapshot applies a Stream-2 (active-session) snapshot to the store.
// Extracted from the EventSource `snapshot` closure so the Slice C partial-
// snapshot contract — a hydrating snapshot (gate.messagesLoaded===false) must NOT
// mark the session delivered — is unit-testable. The connection-side bookkeeping
// (markSessionSeen + gen guard, latency) stays in the listener; this is the pure
// reconciliation.
export function applySessionSnapshot(id: string, snap: Snapshot) {
  const items = (snap.messages?.[id] as any[]) || [];
  setState("messages", id, buildMessages(items));
  // Phase 3 (transcript windowing): populate the resident-window state from the
  // server's bounded-projection meta. This is the Stream-2 (active-session)
  // wholesale-replace path, so it must populate messageWindows[id] just like the
  // messages.batch case and refreshOpenSessions do — without it the Phase-4
  // "Load older" button would never appear for the active session after a warm
  // snapshot. Back-compat: a pre-Phase-1 server omits snap.messageWindows AND
  // ships the whole transcript → deriveMessageWindow yields {hasOlder:false}
  // (correct: unbounded server, nothing older to fetch).
  setState("messageWindows", id, deriveMessageWindow(items, snap.messageWindows?.[id]));
  // Mark delivered ONLY when the snapshot's gate says the daemon has the FULL
  // history (messagesLoaded !== false). Slice C async hydration sends a PARTIAL
  // snapshot immediately (before the upstream fetch completes) with
  // messagesLoaded=false — keep the loading UI up; the messages.loaded event (or
  // a later re-snapshot) flips this. `undefined` (older daemon without the gate
  // field) stays delivered to preserve back-compat. An explicit false must
  // ACTIVELY clear a stale delivered=true (e.g. after a daemon restart / epoch
  // change while the session was open) — otherwise the empty-order snapshot
  // renders "delivered-and-empty" instead of "loading".
  const loaded = snap.gate?.[id]?.messagesLoaded;
  if (loaded === false) {
    setState("messagesLoaded", id, false);
    // Slice C "hydration attempt started": a partial snapshot (messagesLoaded
    // ===false) is the client-side signal that fires for BOTH openSession-driven
    // hydration AND a Stream-2 reconnect retry (which does NOT call openSession).
    // Clear any stale messagesError here so the chat's reveal gate does not show
    // the "select again to retry" hint while a retry is ALREADY in flight —
    // revealed() = ready() && (delivered() || messageFailed()) would otherwise
    // release on the stale failure. If this retry ALSO fails, messages.error
    // re-sets the flag (the messages.error case above). This is the single
    // correct reset point: openSession has no reset (it would miss the reconnect
    // path), and the daemon has no messages.started event (only messages.loaded
    // / messages.error — pkg/state/store.go), so a proactive clear here is the
    // only mechanism. Mirrors the else-branch clear below.
    setState(
      produce((s) => {
        delete s.messagesError[id];
      }),
    );
  } else {
    setState("messagesLoaded", id, true); // true OR undefined (older daemon) → delivered
    // A delivered snapshot supersedes a prior background-hydration failure
    // (e.g. retry after error, or a Stream-2 reconnect): clear the error so the
    // chat's reveal gate stops treating this session as "failed/partial".
    setState(
      produce((s) => {
        delete s.messagesError[id];
      }),
    );
  }
}

// decodeGzip64 reverses the server's gzip+base64 application compression
// (base64 → atob → Uint8Array → native DecompressionStream → UTF-8 string).
// Shared by the cold-load messages.batch decoder, the session-snapshot decoder,
// and the GET /vh/snapshot decoder so all three walk ONE decompression path.
// Returns "" when the runtime lacks DecompressionStream (an old browser) so each
// caller can fall back to whatever raw payload it has and log. No pako dep;
// relies on Chrome 80+/FF 113+/Safari 16.4+ native support (this PWA's target).
async function decodeGzip64(data: string): Promise<string> {
  if (typeof DecompressionStream === "undefined") return "";
  // atob → binary string → Uint8Array.
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Pipe through native gzip decompression, drain to one buffer.
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(merged);
}

// decodeMessagesBatch reverses the server's application-level compression of
// the cold-load messages.batch payload. The server emits {sessionID, encoding,
// data, window?} where data = base64( gzip( {"messages":[...]} ) ) and `window`
// (Phase 1 server-side bounded projection meta) travels SIBLING to `encoding`
// / `data` so the client can read has_older/oldest_loaded_id WITHOUT
// decompressing the messages array. sessionID stays PLAIN TEXT so the
// store/web interest filters (payloadSessionID / sendable) keep extracting it
// — replacing the whole payload with a base64 blob would silently drop the
// batch for Stream-2 (open-session) subscribers; only the heavy messages
// array is compressed. This helper returns {sessionID, messages, window?} in
// the exact shape applyMessageEvent's "messages.batch" case already consumes
// (plus the new window field), so that case is UNCHANGED in mechanism by
// compression. Exported for unit testing.
export async function decodeMessagesBatch(payload: {
  sessionID?: string;
  encoding?: string;
  data?: string;
  messages?: any[];
  window?: MessageWindowMeta;
}): Promise<{ sessionID: string; messages: any[]; window?: MessageWindowMeta }> {
  const sessionID = payload.sessionID || "";
  const window = payload.window;
  // Pass-through for a non-compressed payload (a non-conforming server, or a
  // future threshold policy that emits raw JSON below a size cutoff). Keeps the
  // helper a total function.
  if (payload.encoding !== "gzip64" || !payload.data) {
    return { sessionID, messages: payload.messages || [], window };
  }
  const text = await decodeGzip64(payload.data);
  if (!text) {
    // Older browser without DecompressionStream cannot decode. Fall back to
    // whatever inline messages arrived (likely empty) and log — the server
    // always compresses today, so this only matters for an old client.
    log.warn("sync", "DecompressionStream unavailable; messages.batch undecodable", { id: sessionID });
    return { sessionID, messages: payload.messages || [], window };
  }
  let inner: { messages?: any[] };
  try {
    inner = JSON.parse(text);
  } catch (err) {
    // Decompressed to non-JSON (corrupt/garbled batch payload). Return the same
    // safe empty envelope callers already handle for the DecompressionStream-
    // unavailable case above (empty messages array) instead of propagating the
    // throw to the listener.
    log.warn("sync", "malformed messages.batch payload (non-JSON after decompress)", {
      id: sessionID,
      err,
    });
    return { sessionID, messages: payload.messages || [], window };
  }
  return { sessionID, messages: inner.messages || [], window };
}

// decodeSnapshot reverses the server's gzip64 snapshot compression
// (pkg/web maybeCompressSnapshot) used for BOTH the Stream-2 session snapshot
// (SSE) and the GET /vh/snapshot response. Returns the decoded object.
// Pass-through when the payload carries no gzip64 envelope — covers an old
// server (never compresses) and a snapshot that fell under the server's size
// threshold (sent raw: cold/messageless partial snapshots, small trees). The
// generic <T> lets callers keep their typed Snapshot view. Exported for unit
// testing.
export async function decodeSnapshot<T = unknown>(payload: {
  encoding?: string;
  data?: string;
}): Promise<T> {
  if (payload.encoding === "gzip64" && payload.data) {
    const text = await decodeGzip64(payload.data);
    if (text) {
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        // Decompressed to non-JSON (corrupt/garbled snapshot). Return a safe
        // empty snapshot ({}) — applySessionSnapshot treats {} as a delivered-
        // empty session (snap.messages?.[id] → undefined → buildMessages([]),
        // snap.gate?.[id] → undefined → delivered path) — instead of
        // propagating the throw to the listener.
        log.warn("sync", "malformed snapshot payload (non-JSON after decompress)", { err });
        return {} as T;
      }
    }
    log.warn("sync", "DecompressionStream unavailable; snapshot undecodable");
  }
  return payload as unknown as T;
}

export function openSessionStream(id: string, force = false) {
  // `force` bypasses the "already open" early-return so a caller can demand a
  // FRESH authoritative snapshot even when the selected session's Stream-2
  // EventSource is healthy. Used by reconcileBusy() on the outermost busy
  // release: without it, an archive/unarchive WITH a selected session would
  // never re-request the session snapshot (the EventSource is still OPEN), so
  // expectSessionSnap stays true and the overlay only clears via the 15s safety
  // timeout — the exact UX this feature exists to fix. force=true → skip the
  // early-return → closeSessionStream() tears down the existing connection →
  // open() recreates the EventSource fresh.
  if (!force && id === sesId && ses && ses.readyState !== EventSource.CLOSED) return;
  closeSessionStream();
  // No project selected → nothing to stream (and no cwd bridge). Guards both
  // the no-project state and a stray selection cleared before a project lands.
  if (!id || !projectDir()) return;
  sesId = id;
  const open = () => {
    if (sesId !== id) return;
    // Bump the connection generation so listeners captured by any prior open()
    // of THIS selection (a retry) or a superseded selection are ignored. The
    // captured `gen` is checked at every listener ENTRY — a stale callback from
    // a closed/replaced Stream2 must NOT refresh sessionLastSeen or run state
    // effects (the dead-but-OPEN masking bug). closeSessionStream() already
    // bumped for the switch/force path; this bump covers the retry path (where
    // open() runs directly from the sesRetry timer, not via openSessionStream).
    const gen = ++sesGen;
    ses?.close();
    sesT0 = performance.now(); // L1 t0: session-stream connection attempt
    sesT1 = 0;
    sesSnapDone = false;
    sesFirstSnap = 0; // L1 hydrate: reset per (re)open
    sesHydrating = false;
    sesSnapshotDecode = Promise.resolve(); // no in-flight decode at (re)open
    sesSnapshotDecoding = false;
    // Warm silent-swap: this (re)open is showing cached/stale message state
    // until this connection's first authoritative snapshot lands. Arm the
    // per-session refresh indicator; the snapshot listener clears it (and
    // closeSessionStream clears it on switch-away). Set per (re)open so a
    // reconnect retry re-arms it.
    setState("refreshing", id, true);
    ses = new EventSource(`/vh/stream?sessions=${encodeURIComponent(id)}&dir=${encodeURIComponent(projectDir())}&z=1`);
    // Seed Stream2's liveness deadline from construction (mirrors Stream1's
    // markTreeSeen() right after `new EventSource`): a connection that NEVER
    // fires any event (silent from the start) must still be aged out after
    // STALE_MS rather than hang forever. A connection that does fire refreshes
    // this via markSessionSeen() in its listeners. closeSessionStream() reset
    // this to 0; open() gives it a fresh "now" baseline so it is NOT stale.
    markSessionSeen();
    log.debug("sync", "session stream connect", { id });
    ses.addEventListener("snapshot", (e) => {
      // Gen guard: ignore frames from a superseded connection BEFORE touching
      // the clock or the store.
      if (gen !== sesGen) return;
      markSessionSeen();
      let raw: any;
      try {
        raw = JSON.parse((e as MessageEvent).data);
      } catch (err) {
        // Stream-2 never advances the shared resume cursor (trackCursor:false),
        // so a malformed session snapshot is a clean log + drop. The connection
        // stays open; the per-session refresh indicator and reconcile overlay
        // (expectSessionSnap) self-heal via the next well-formed snapshot or the
        // 15s reconcile safety timeout — resolving them here would be dispatch/
        // state-machine surgery, out of scope for parse hardening.
        log.warn("sync", "malformed session snapshot frame", { err });
        return;
      }
      // L1 t2: stamp `snap` on FRAME ARRIVAL, before any decode. The window
      // measures pure transport (server compute + serialize + tunnel) — the
      // bottleneck this feature targets. Including the client-side gzip64 decode
      // (ms-scale local CPU) would muddy the transport signal the L1
      // instrumentation exists to surface. Same `now` bounds both the snap
      // delta and the hydrate t0.
      const first = !sesSnapDone;
      const now = performance.now();
      if (first) {
        sesSnapDone = true;
        if (sesT1) recordLatency("session", "snap", now - sesT1);
        sesFirstSnap = now;
      }
      // Global busy gate: while a busy scope is active, suppress store mutation.
      // The ONE expected fresh snapshot (from openSessionStream during
      // reconciliation) is allowed through; all other frames are deferred.
      if (isGateActive() && !expectSessionSnap) {
        // Deferred Stream-2 frame — neither mutate the store nor advance the
        // shared cursor (Stream 2 never advances it). Latch dirty so the
        // coalesced refresh catches up.
        markBusyDirty();
        return;
      }
      const wasExpected = expectSessionSnap;
      if (wasExpected) expectSessionSnap = false;
      // Apply the decoded snapshot: hydrate stamping (needs snap.gate) + clear
      // the per-session refresh indicator + reconcile. The server gzip64-wraps
      // the snapshot when z=1 AND it exceeds the size threshold (a warm open of
      // a loaded session — the megabyte transcript). Small/cold/messageless
      // snapshots ship raw (no `encoding`) and skip the async decode.
      const applySnap = (snap: Snapshot) => {
        if (first) {
          // L1 hydrate: warm-vs-cold read from the snapshot's gate. A warm
          // session (gate.messagesLoaded!==false) already has the full history,
          // so messages.loaded never arrives → stamp "warm"; a cold session
          // (gate.messagesLoaded===false) clears any stale value so the UI
          // shows the in-progress upstream-fetch wait until messages.loaded.
          const cold = snap.gate?.[id]?.messagesLoaded === false;
          sesHydrating = cold;
          recordSessionHydrate(cold ? undefined : "warm");
          // Clear any stale fetch/rec split from a prior connection. They only
          // land when THIS connection's messages.loaded arrives (cold session);
          // a warm snapshot never fires it, so they must read "—" until then.
          recordSessionFetchSplit(undefined, undefined);
        }
        // Authoritative snapshot for THIS connection landed — the cached/stale
        // render is now superseded; clear the per-session refresh indicator
        // BEFORE reconciling so the row's .dot.refreshing drops in the same
        // reactive tick the fresh data paints. Idempotent on later snapshots.
        setState("refreshing", id, false);
        applySessionSnapshot(id, snap);
      };
      // Compressed path: async decode, gated behind sesSnapshotDecode so live
      // message/part events in the decode window serialize behind it (the
      // shared listener awaits it) — applySessionSnapshot WHOLESALE-REPLACES
      // messages[id], so a live event applied mid-decode would be clobbered
      // when the stale-but-now-decoded snapshot lands. Until applySnap runs the
      // PRIOR messages stay in the store → no flash-of-empty through the decode
      // window (the reveal gate stays faithful). Raw path: synchronous apply,
      // exactly the legacy behavior (cold small snapshots, zero decode latency).
      //
      // Epoch guard: capture the gate epoch at decode start. If the gate
      // activated (or a new reconcile pass started) during the decode, the
      // epoch mismatches and the stale decode is discarded — it must NOT
      // mutate the store or clear the overlay. If this was the expected
      // snapshot, still resolve so reconcile doesn't wedge (dirty was latched).
      if (raw.encoding === "gzip64") {
        const ep = currentGateEpoch();
        sesSnapshotDecoding = true;
        sesSnapshotDecode = (async () => {
          try {
            const snap = await decodeSnapshot<Snapshot>(raw);
            // Generation re-check (finding #3): the snapshot decode AWAITED, so
            // the connection may have been replaced (sesGen bumped in
            // closeSessionStream/open) while we were decoding. The entry guard
            // cannot catch this — it ran before the await. A superseded decode
            // must NOT apply its snapshot, clear the refresh indicator, or run
            // latency effects: the replacement connection owns the session
            // state now. Supplements (does not replace) the epoch guard below,
            // which separately handles a busy-gate activation mid-await.
            if (gen !== sesGen) return;
            if (ep === currentGateEpoch()) {
              applySnap(snap);
            } else if (isGateActive()) {
              markBusyDirty();
            }
          } finally {
            // Ownership-aware clear: only the CURRENT generation owns the flag.
            // A superseded connection's decode must NOT clear sesSnapshotDecoding
            // while the replacement's decode is still in flight — same cross-
            // reconnect flag-reset race as the tree stream's treeSnapshotDecoding
            // gate. The post-await gen check above prevents a stale APPLY; this
            // guard prevents a stale CLEAR.
            if (gen === sesGen) sesSnapshotDecoding = false;
          }
        })();
        // Resolve after the decode lands (or is queued via microtask for the
        // stale case) — the expected snapshot has been "received".
        if (wasExpected) {
          sesSnapshotDecode.then(() => maybeResolveReconcile());
        }
      } else {
        applySnap(raw);
        if (wasExpected) maybeResolveReconcile();
      }
    });
    ses.addEventListener("ping", () => {
      if (gen !== sesGen) return;
      markSessionSeen();
    });
    // L1 t1: socket established → pure connection-latency delta. Stream 2 had
    // no explicit onopen before; added for the latency diagnostic (and parity
    // with Stream 1's connect/backoff semantics).
    ses.onopen = () => {
      if (gen !== sesGen) return;
      markSessionSeen();
      sesT1 = performance.now();
      if (sesT0) recordLatency("session", "open", sesT1 - sesT0);
    };
    for (const kind of ["message.upsert", "message.delete", "part.upsert", "part.delete", "messages.loaded", "messages.error", "messages.batch"]) {
      ses!.addEventListener(kind, async (e) => {
        // Gen guard: ignore frames from a superseded connection BEFORE touching
        // the clock or the store.
        if (gen !== sesGen) return;
        markSessionSeen();
        if (isGateActive()) {
          // Deferred Stream-2 frame — neither mutate the store nor advance the
          // shared cursor. Latch dirty so the coalesced refresh catches up.
          markBusyDirty();
          return;
        }
        const ev = e as MessageEvent;
        // Parse the payload once (was inline at applyMessageEvent); reused for
        // the split-timing read below. trackCursor:false — Stream 2 must not
        // advance Stream 1's resume cursor.
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch (err) {
          // Stream-2 never advances the shared cursor; a malformed message/part
          // frame is a clean log + drop. No pendingBatch entry was registered
          // for this frame (it's set up downstream, only for messages.batch
          // AFTER a successful parse), so a later messages.loaded for this
          // session finds no pending decode and opens the reveal gate without
          // wedging.
          log.warn("sync", "malformed session frame", { kind, err });
          return;
        }
        const sid: string | undefined = data?.sessionID;
        // Capture the gate epoch at entry so post-await application points can
        // detect that the gate activated during an await (snapshot decode or
        // batch decode) and refuse to mutate the store.
        const ep = currentGateEpoch();

        // Serialize against an in-flight gzip64 snapshot decode for this
        // connection. applySessionSnapshot WHOLESALE-REPLACES messages[id]; a
        // live message/part event applied during the decode window would be
        // clobbered when the (stale-but-now-decoded) snapshot lands. Wait ONLY
        // when a decode is actually in flight — the boolean check is a no-op on
        // the fast path so message.upsert/part.upsert floods keep zero microtask
        // latency. Connect-time only (a snapshot decode is ms-scale).
        if (sesSnapshotDecoding) await sesSnapshotDecode;
        // Generation re-check (finding #3): we just awaited the in-flight
        // snapshot decode — the connection may have been replaced (sesGen
        // bumped) during that wait. The entry guard ran before the await, so
        // drop the stale continuation here before any state effect. Supplements
        // the epoch guard below (which handles a busy-gate activation, not a
        // connection replacement — a sesGen bump does not change the epoch).
        if (gen !== sesGen) return;
        // Epoch guard: the gate may have activated during the snapshot-decode wait.
        if (ep !== currentGateEpoch()) {
          if (isGateActive()) markBusyDirty();
          return;
        }

        // Phase 4 — historical-page dirty-mirror hook. Mark the in-flight
        // historical page dirty ONLY for resurrection-class mutations
        // (message.delete / part.delete / messages.batch — see
        // isPageDirtyingKind) so the response gate (runPageFetchLoop) discards
        // + retries. This is the client mirror of the server's
        // me.liveTouchedBody/me.liveTouchedParts (pkg/state/store.go) — live
        // state always wins, so a page snapshot that raced a resurrection-class
        // mutation is stale.
        //
        // NARROW FILTER: the filter deliberately EXCLUDES message.upsert and
        // part.upsert. The merge is insert-if-not-present (live always wins),
        // so a live upsert CANNOT make a stale page resurrect anything:
        //   - upsert for a NEW tail message: newer than the `before` cursor →
        //     NOT in the page range.
        //   - upsert for an EXISTING message / part: prependMessagesIfAbsent
        //     and upsertPart both leave the live entry untouched.
        // Excluding upserts is what keeps Load-older usable on actively-
        // streaming sessions (a part.upsert flood per streamed token would
        // otherwise exhaust MAX_PAGE_RETRIES and abandon with no merge).
        // messages.loaded/messages.error are also excluded (reveal-gate flips,
        // not content mutations).
        //
        // Placed AFTER the gen+epoch re-checks so a superseded connection or a
        // gate activation during the snapshot-decode await does NOT mark a page
        // dirty for a connection/gate the page no longer belongs to.
        if (sid && isPageDirtyingKind(kind)) {
          markPageDirty(sid);
        }

        // messages.batch is application-compressed (gzip+base64) to cut cold-
        // load hydrate latency over the controller tunnel. The decode is ASYNC
        // (native DecompressionStream), but EventSource fires the next event
        // (messages.loaded) as soon as this listener RETURNS — i.e. before the
        // decode resolves. Without coordination messages.loaded would flip
        // messagesLoaded (the reveal gate, P1-WEB-020) before the batch content
        // staged → flash of empty content at reveal. Promise-gate: stash the
        // decode promise keyed by sessionID; the messages.loaded/messages.error
        // path below awaits any pending entry before flipping the gate. The
        // batch case of applyMessageEvent is UNCHANGED — it receives an
        // already-decoded {sessionID, messages} (same shape as before
        // compression). NOTE: an async listener with NO await on the warm path
        // runs synchronously to completion (async functions only suspend at an
        // awaited expression), so message.upsert/part.upsert floods pay zero
        // microtask latency — only batch (decode) and loaded/error (gate wait)
        // ever await.
        if (kind === "messages.batch") {
          const p = (async () => {
            const decoded = await decodeMessagesBatch(data);
            // Generation re-check (finding #3): the batch decode AWAITED — the
            // connection may have been replaced (sesGen bumped) while decoding.
            // The entry guard ran before the await. A superseded decode must not
            // stage its batch into the store; supplements the epoch guard below.
            if (gen !== sesGen) return;
            // Epoch guard: the gate may have activated during the batch decode.
            if (ep === currentGateEpoch()) {
              applyMessageEvent("messages.batch", Number(ev.lastEventId), decoded, false);
            } else if (isGateActive()) {
              markBusyDirty();
            }
          })();
          if (sid) pendingBatch.set(sid, p);
          try {
            await p;
          } finally {
            if (sid) pendingBatch.delete(sid);
          }
          return;
        }

        // messages.loaded / messages.error: await any in-flight batch decode
        // for this session so the gate opens AFTER content is staged. (Also
        // makes the L1 hydrate timing stamp below include the decode cost —
        // more correct.) If no batch is pending this is a no-op.
        if (sid && pendingBatch.has(sid)) {
          await pendingBatch.get(sid);
        }
        // Generation re-check (finding #3): we just awaited a pending batch
        // decode — the connection may have been replaced (sesGen bumped) during
        // that wait. The entry guard ran before the await. Drop the stale
        // continuation before the latency/reveal stamps and the messages.loaded
        // application below; supplements the epoch guard.
        if (gen !== sesGen) return;
        // Epoch guard: the gate may have activated during the batch-decode wait.
        if (ep !== currentGateEpoch()) {
          if (isGateActive()) markBusyDirty();
          return;
        }

        // L1 hydrate: messages.loaded arrival closes the cold-session
        // upstream-fetch window that `snap` misses. Recorded once per
        // connection — sesHydrating flips off so a duplicate messages.loaded
        // (or one arriving after a warm snapshot, which never set the flag)
        // does not overwrite the stamp. Belongs to THIS connection: the flag
        // and sesFirstSnap are reset in open() and only this connection's
        // (still-open) EventSource fires its listeners, so a torn-down prior
        // connection cannot stamp a stale delta here.
        if (kind === "messages.loaded" && sesHydrating && sesFirstSnap) {
          sesHydrating = false;
          recordSessionHydrate(performance.now() - sesFirstSnap);
          // Split-timing: the daemon reports how much of `hydrate` was the
          // upstream fetch vs the daemon-side reconcile. Read defensively — an
          // older daemon omits fetchMs/reconcileMs (render "—"). Parsed on the
          // same cold-session path as the hydrate stamp (a warm session never
          // reaches here).
          recordSessionFetchSplit(
            typeof data.fetchMs === "number" ? data.fetchMs : undefined,
            typeof data.reconcileMs === "number" ? data.reconcileMs : undefined,
          );
        }
        applyMessageEvent(kind, Number(ev.lastEventId), data, false);
      });
    }
    ses.onerror = () => {
      // Gen guard: a superseded connection's error must not arm a retry on
      // behalf of the new (current) connection — the current connection owns
      // its own retry scheduling via its own onerror.
      if (gen !== sesGen) return;
      if (ses && ses.readyState === EventSource.CLOSED && sesId === id) {
        clearTimeout(sesRetry);
        sesRetry = window.setTimeout(open, 1500);
      }
    };
  };
  open();
}

// Force a reconnect when a stream has gone silent past the heartbeat window
// (a dead-but-OPEN EventSource won't surface as an error) or was closed. Each
// stream is evaluated against its OWN liveness clock — the original bug was a
// single shared `lastSeen` that Stream1's 15s server ping kept fresh forever,
// so a dead-but-OPEN Stream2 could never age out while the tree was healthy.
// Runs while the tab is visible.
export function watchdogTick() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  // No project selected: never (re)connect the cwd bridge. The watchdog just
  // advances the stale-health tick (cheap, harmless) and stands down otherwise.
  if (!projectDir()) {
    setHealthNow((n) => n + 1);
    return;
  }
  // Feature 1: re-evaluate staleness over wall-clock time (no store write on
  // a silent-but-open socket). Coarse tick only — safe on the per-frame budget.
  setHealthNow((n) => n + 1);
  // --- Stream 1 (tree) liveness: drives the GLOBAL connection status. ---
  if (!es || es.readyState === EventSource.CLOSED) {
    connect();
  } else if (treeLastSeen && Date.now() - treeLastSeen > STALE_MS) {
    log.warn("sync", "tree stream stale → forcing reconnect", {
      silentMs: Date.now() - treeLastSeen,
    });
    setState("status", "reconnecting");
    connect();
  }
  // --- Stream 2 (selected-session messages) liveness: INDEPENDENT clock. ---
  // A dead-but-OPEN Stream2 must be detected even while Stream1's 15s server
  // pings keep the tree healthy (the original masking bug). A stale/closed
  // Stream2 is reconnected via the existing forced fresh-snapshot path
  // (openSessionStream(id, true)): it bypasses the healthy/open early return,
  // closes the old EventSource, bumps sesGen (invalidating the stale
  // connection's listeners), and constructs a cursorless one starting with an
  // authoritative snapshot. A not-yet-open / just-(re)connected Stream2 has
  // sessionLastSeen seeded to "now" by open() → not stale → gets a fresh
  // deadline (no tight construction/close loop). Reconnecting ONLY Stream2
  // does NOT flip global status to disconnected (that follows the tree above).
  if (sesId) {
    if (!ses || ses.readyState === EventSource.CLOSED) {
      openSessionStream(sesId);
    } else if (sessionLastSeen && Date.now() - sessionLastSeen > STALE_MS) {
      log.warn("sync", "session stream stale → forcing reconnect", {
        id: sesId,
        silentMs: Date.now() - sessionLastSeen,
      });
      openSessionStream(sesId, true);
    }
  }
}

export function maybeReconnect() {
  // No project selected: no stream to reconnect (and connect() would no-op
  // anyway, but avoid even the readyState read / status churn).
  if (!projectDir()) return;
  if (!es || es.readyState === EventSource.CLOSED) connect();
  else watchdogTick();
}
