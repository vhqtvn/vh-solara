// Backend-authoritative per-session message queue.
//
// The backend owns the queue (state, ordering, durability) keyed by
// (project, sessionId). This module is a thin reactive CACHE of that state plus
// the SOLE dispatcher: it lists, enqueues, removes, claims, and resolves items
// through the backend. The cache is a view, never the authority — queue
// payloads are never written to localStorage (only the legacy vh.queue.v1 map
// is read as a one-time migration source).
//
// Lifecycle (no auto-retry anywhere):
//
//   pending → dispatching → {sent | failed | unknown}
//
// `claim` is the cross-client boundary (one browser wins). Neither `failed` nor
// `unknown` ever returns to `pending`; they persist until explicit operator
// dismissal. `sent` is filtered from the visible queue: a successfully-
// dispatched queued message is now in the transcript, so its chip clears (the
// cache retains it internally only to drive the F1 reconcile overlay).
// Correctness never depends on a push channel — the FE pulls on session open,
// after every mutation, on focus/visibility, on stream reconnect, and polls
// ~5s while the selected session has queue state.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { loadVersioned, saveVersioned } from "./lib/store";
import { markSendAttemptResolveConflict, markSendAttemptStatusUnsaved } from "./lib/sendActionStatus";

export interface QueuedAttachment {
  url: string;
  filename: string;
  mime: string;
  // Project-relative attachment path threaded from attach.go's upload response
  // (".vh-solara/sessions/<id>/attachments/<file>"). Optional for backward
  // compat: legacy queued items persisted without a path round-trip with path
  // simply absent/undefined. S1 only threads the field; it is not yet consumed
  // by the dispatch path.
  path?: string;
}
export type QueueItemState = "pending" | "dispatching" | "sent" | "failed" | "unknown";
export interface QueuedMessage {
  id: string;
  order: number;
  state: QueueItemState;
  text: string;
  attachments: QueuedAttachment[];
  // Captured at enqueue time so a later model/agent switch doesn't retroactively
  // change a queued message.
  sendConfig?: { providerID?: string; modelID?: string; variant?: string; agent?: string };
  originClientId?: string;
  // Backend-minted OpenCode message-ID correlation key (the exact id OpenCode
  // will persist the dispatched user message under, via prompt_async's
  // `messageID` body field — caller-id-wins on v1.17.18). Optional for backward
  // compat with in-flight items persisted before this field shipped. The drainer
  // threads it into the dispatch POST so a later exact GET
  // /session/:sid/message/:mid can reconcile delivered-but-stuck items.
  opencodeMsgID?: string;
  // Send-reliability slice 2: the client attempt id this item was admitted
  // under (the idempotent-admission key). Echoed by the backend on the enqueued
  // item; absent on legacy items/servers. Used by reconcile-first recovery to
  // match a list item back to its uncertain admission attempt.
  attemptId?: string;
  createdAt: number;
  resolvedAt?: number;
  // Failure / ambiguous detail for failed | unknown (diagnostics).
  detail?: string;
}

// Input shape for enqueue (the backend issues id + order + state + createdAt).
// attemptId (send-reliability slice 2) makes admission durably idempotent on
// slice-1 servers: the same (attemptId, canonical payload) replay returns the
// ORIGINAL receipt ("replayed": true) and creates no second item. See
// enqueue() for the legacy-server feature-detect.
export type QueueInput = Pick<QueuedMessage, "text" | "attachments"> & {
  sendConfig?: QueuedMessage["sendConfig"];
  originClientId?: string;
  attemptId?: string;
};

// Typed enqueue failure (send-reliability slice 2). `code` is machine-readable:
//   queue_admission_conflict — 409, same attemptId with a CHANGED payload.
//   queue_admission_full     — 429, receipt capacity; a definitive rejection.
//   timeout / network        — NO response: the outcome is UNKNOWN (the POST
//                              may have been admitted; reconcile before
//                              deciding anything).
//   ambiguous                — 2xx whose body carried no item.
//   unknown                  — any other non-2xx WITH a response. /vh/queue is
//                              served by the LOCAL worker server (not the /oc
//                              proxy), so an HTTP error status is definitive
//                              non-admission; `status` carries it.
export type EnqueueErrorCode =
  | "queue_admission_conflict"
  | "queue_admission_full"
  | "timeout"
  | "network"
  | "ambiguous"
  | "unknown";

export class EnqueueError extends Error {
  code: EnqueueErrorCode;
  status?: number;
  constructor(message: string, code: EnqueueErrorCode, status?: number) {
    super(message);
    this.name = "EnqueueError";
    this.code = code;
    this.status = status;
  }
}

const LS_QUEUE = "vh.queue.v1"; // LEGACY migration source only — never written for live queues
const LS_QUEUE_MODE = "vh.prefs.queueMode.v1";

// Reactive cache of backend queue state, keyed by sessionId. A view only.
const [queues, setQueues] = createStore<Record<string, QueuedMessage[]>>({});

// Locally-known terminal outcomes for items whose dispatch ALREADY happened
// (the resolve WRITE then records them). Keyed by itemId (globally unique via
// crypto/rand on the backend). When the resolve write fails (500 / network),
// the backend item stays `dispatching` while the FE knows the real terminal
// outcome. This overlay lets fetchQueue reconcile so the UI never flips a
// known-terminal item back to a misleading `dispatching`. In-memory only (not
// persisted): a reload re-fetches backend truth. Bounded by the rare set of
// items whose resolve write failed this session; cleared on archive and dropped
// once the backend catches up to terminal.
const knownOutcomes = new Map<string, { state: QueueItemState; detail: string; resolvedAt: number }>();

// Global toggle (default on). When off, sending while busy is blocked the old
// way instead of queuing. The preference stays local (not a queue payload).
const [queueMode, setQueueModeSig] = createSignal<boolean>(
  loadVersioned<boolean>(LS_QUEUE_MODE, 1, true, (o) => !(o === 0 || o === "0" || o === false)),
);
export function setQueueMode(on: boolean) {
  setQueueModeSig(on);
  saveVersioned(LS_QUEUE_MODE, 1, on);
}
export { queueMode };

// --- reactive read ---------------------------------------------------------

export function queueFor(sessionId: string): QueuedMessage[] {
  // `sent` items are filtered from the read view: a successfully-dispatched
  // queued message is now in the transcript, so its chip must clear. The cache
  // still retains `sent` internally (for the F1 reconcile overlay), but the
  // visible queue holds only pending/dispatching/failed/unknown. `failed` and
  // `unknown` stay displayed until explicit operator dismissal.
  return (queues[sessionId] || []).filter((m) => m.state !== "sent");
}

// True when a session has any VISIBLE items (pending/dispatching/failed/unknown).
// Drives the ~5s poll: polling runs only while there's something to show. A
// session whose only item is `sent` has nothing to show, so polling stops.
export function hasQueueState(sessionId: string): boolean {
  return (queues[sessionId] || []).some((m) => m.state !== "sent");
}

// --- backend operations ----------------------------------------------------

function queueUrl(sessionId: string, suffix = ""): string {
  return `/vh/session/${encodeURIComponent(sessionId)}/queue${suffix}`;
}

async function readJSON(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

// Terminal states mirror pkg/web/queue.go's isTerminalState.
function isTerminalStateFE(s: QueueItemState): boolean {
  return s === "sent" || s === "failed" || s === "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// fetchQueue replaces the cache for a session with the backend's authoritative
// list. Idempotent; safe to call frequently.
//
// Reconcile: if the backend still reports a NON-terminal state (e.g.
// dispatching) for an item whose dispatch already reached a known terminal
// outcome (the resolve write failed), prefer the local outcome so the UI never
// flips a known-terminal item back to a misleading dispatching. The overlay
// entry is dropped once the backend catches up to terminal.
export async function fetchQueue(sessionId: string): Promise<QueuedMessage[]> {
  const res = await fetch(queueUrl(sessionId));
  if (!res.ok) return queues[sessionId] || [];
  const j = await readJSON(res);
  const items: QueuedMessage[] = Array.isArray(j.items) ? j.items : [];
  const reconciled = items.map((it) => {
    const known = knownOutcomes.get(it.id);
    if (!known) return it;
    if (isTerminalStateFE(it.state)) {
      // Backend caught up to terminal — drop the overlay; backend is authority.
      knownOutcomes.delete(it.id);
      return it;
    }
    // Backend still non-terminal but we KNOW the outcome — keep it honest.
    return { ...it, state: known.state, detail: known.detail, resolvedAt: known.resolvedAt };
  });
  setQueues(sessionId, reconciled);
  return reconciled;
}

// Bounded timeout for the enqueue POST. The backend enqueue is fast (atomic
// temp-write + fsync + rename, milliseconds), so 12s is a very generous upper
// bound. If the enqueue response never arrives (hung socket / slow drop), the
// abort throws and the caller (sendText) preserves the composer text +
// attachments — no silent loss. A retry may produce a visible duplicate (the
// POST may have reached the backend and persisted the item), which is preferred
// over silent loss per operator policy. Mirrors the 12s AbortController
// precedent at web/src/code/api.ts:9-25.
const ENQUEUE_TIMEOUT_MS = 12000;

// Feature-detect state for idempotent admission (send-reliability slice 2).
// Slice-1 servers echo `"replayed": <bool>` on every enqueue response; LEGACY
// servers return `{item}` with NO `replayed` field. We probe on the first
// attemptId-carrying enqueue and remember the verdict for the module's
// lifetime: once a server is known legacy, later enqueues OMIT attemptId
// (legacy requests keep the old non-idempotent behavior and must not silently
// appear to carry the stronger guarantee). "unknown" (pre-probe) still sends
// the attemptId — the probe IS the first such send.
type AttemptSupport = "unknown" | "supported" | "legacy";
let attemptSupport: AttemptSupport = "unknown";

/** Test-only: reset the attempt-support feature-detect (module singleton). */
export function __resetQueueAttemptSupportForTests(): void {
  attemptSupport = "unknown";
}

// enqueue POSTs a new message; the backend issues the id + monotonic order.
// Returns the created item. Throws EnqueueError on non-2xx (typed — see the
// class), on a hung/timed-out response, or on a 2xx-without-item ambiguous
// response so the caller can preserve the composed text (no silent loss).
// Throwing on timeout means the caller NEVER clears the composer until durable
// custody is confirmed — and must NOT assume "nothing persisted": the POST may
// have been admitted (reconcile-first, see createSend.sendText).
//
// Idempotent admission (slice 2): when input.attemptId is present (and the
// server is not known-legacy), it is sent with the payload; a slice-1 server
// dedupes same-(attemptId,payload) replays and answers the ORIGINAL receipt
// with `replayed: true`. The cache is UPSERTED by item id, so a replay never
// produces a duplicate chip. After a session-queue cleanup/archive the replay
// guarantee is over server-side (a replay is a fresh admission) — the client's
// retries are user-driven re-taps, never an automatic loop, so no stale
// attemptId is ever hammered.
export async function enqueue(sessionId: string, input: QueueInput): Promise<QueuedMessage> {
  const sendAttempt = !!input.attemptId && attemptSupport !== "legacy";
  const body = sendAttempt ? input : { ...input, attemptId: undefined };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ENQUEUE_TIMEOUT_MS);
  // BOTH body reads (the error-path code probe AND the success-path payload)
  // run INSIDE the armed timeout window (send-reliability slice 3, T1C-F1 /
  // T1D-F2 — the D-F2 hang class on the most load-bearing path: admission).
  // Headers arriving with a stalled body used to leave the read UNARMED:
  // clearTimeout had already fired after the fetch promise resolved, so the
  // abort signal no longer covered the body reader and a stalled body wedged
  // the admission guard forever. Mirrors the slice-2 claimQueued/uploadFile
  // shape: inside the window the aborting signal tears the reader down too,
  // the read rejects, and enqueue settles to a typed error.
  try {
    let res: Response;
    try {
      res = await fetch(queueUrl(sessionId), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      // Network error OR abort/timeout. Either way NO response arrived: the
      // admission outcome is UNKNOWN (the POST may have been admitted), so throw
      // typed — the caller reconciles before deciding anything.
      const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      throw new EnqueueError(
        aborted ? "enqueue timed out" : `enqueue failed (${String(e)})`,
        aborted ? "timeout" : "network",
      );
    }
    if (!res.ok) {
      // The local worker server answered with an error — definitive
      // non-admission (this is NOT the /oc upstream proxy, whose 502 is
      // ambiguous). The STATUS LINE alone proves non-admission; the body only
      // refines the machine-readable code, so a hung/unreadable error body
      // (read inside the armed window; abort → rejection → caught) still
      // settles to the typed plain-status error instead of wedging.
      let code: string | undefined;
      try {
        code = (await res.json())?.code;
      } catch {
        /* body unreadable or stalled→aborted — status already proves non-admission */
      }
      if (code === "queue_admission_conflict" || code === "queue_admission_full") {
        throw new EnqueueError(`enqueue failed (${res.status} ${code})`, code, res.status);
      }
      throw new EnqueueError(`enqueue failed (${res.status})`, "unknown", res.status);
    }
    let j: any;
    try {
      j = await res.json();
    } catch {
      // Body read failed INSIDE the armed window. An abort here (headers
      // arrived, body stalled, the 12s signal tore the reader down) is
      // outcome-UNKNOWN — classify it honestly as a timeout, never as a parse
      // ambiguity. A completed-but-unparseable body keeps the legacy
      // ambiguous shape below.
      if (ctrl.signal.aborted) {
        throw new EnqueueError("enqueue timed out (response body stalled)", "timeout");
      }
      j = {};
    }
    const item: QueuedMessage | undefined = j.item;
    if (!item) {
      // Ambiguous response (successful import lost / malformed): treat as a
      // failure so the caller retains the text. A retry may produce a visible
      // duplicate, which is preferred over silent loss (operator policy).
      throw new EnqueueError("enqueue: no item in response", "ambiguous");
    }
    // Feature-detect (slice 2): a response carrying the `replayed` field proves
    // slice-1 admission semantics; its ABSENCE on an attemptId-carrying request
    // proves a legacy server (fall back to non-idempotent, no attemptId sent).
    if (sendAttempt) {
      attemptSupport = "replayed" in j ? "supported" : "legacy";
    }
    setQueues(produce((q) => {
      const arr = (q[sessionId] ||= []);
      // Upsert by id: a replayed receipt (or a raced duplicate response) must
      // never yield two cache entries for one server item.
      const i = arr.findIndex((m) => m.id === item.id);
      if (i >= 0) arr[i] = item;
      else arr.push(item);
    }));
    return item;
  } finally {
    clearTimeout(timer);
  }
}

// Outcome of a remove attempt. A caller that takes a composer-restoring side
// effect on success (e.g. retract-to-compose) MUST branch on `removed` so a
// failed/non-removable DELETE never leaves a dangling restored draft alongside
// a still-present chip. `removed` is true ONLY when the item is confirmed
// absent from the backend (2xx delete OR 404 already-gone); it is false on a
// 409 (dispatching — non-removable) and on any other non-2xx / network error.
export interface RemoveQueuedResult {
  removed: boolean;
  // True when the backend explicitly rejected removal because the item is
  // dispatching (409) — the dispatch may be in flight, so the state machine
  // must own the transition to terminal first. Distinct from a transient
  // error: this is a hard "not removable right now".
  nonRemovable?: boolean;
  // Diagnostic for a non-success (the HTTP status, "network", etc.).
  reason?: string;
}

// removeQueued deletes an item. The backend accepts removal of `pending`
// (cancel before dispatch) and terminal `sent`/`failed`/`unknown` (explicit
// dismissal — FIX-QUEUE-GC-4); a `dispatching` item is rejected (409) because
// the dispatch may be in flight. On 409, refresh the cache so the UI reflects
// the real (still-dispatching) state.
//
// Returns a confirmed result so the caller knows whether the DELETE actually
// took. The cache side effects are unchanged: a 2xx deletes from the cache, a
// 404 reflects nothing (already gone), a 409 refreshes to dispatching truth.
// A network throw surfaces as a non-removed result (the item's removability is
// unknown) rather than propagating, so the caller can fail soft.
export async function removeQueued(sessionId: string, id: string): Promise<RemoveQueuedResult> {
  let res: Response;
  try {
    res = await fetch(queueUrl(sessionId, `/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: { "X-VH-CSRF": "1" },
    });
  } catch (e) {
    // Network error / interruption — the item's removability is unknown. Do NOT
    // touch the cache; surface as non-removed so a caller never takes a
    // success-only side effect (e.g. restoring a draft) on an unconfirmed DELETE.
    return { removed: false, reason: `network (${String(e)})` };
  }
  if (res.ok) {
    setQueues(produce((q) => {
      if (q[sessionId]) q[sessionId] = q[sessionId].filter((m) => m.id !== id);
    }));
    return { removed: true };
  }
  if (res.status === 404) return { removed: true }; // already gone — confirmed absent
  if (res.status === 409) {
    // Item is dispatching (in flight) — the state machine must own the
    // transition to terminal first. Refresh to show the real state.
    await fetchQueue(sessionId);
    return { removed: false, nonRemovable: true, reason: "409" };
  }
  return { removed: false, reason: String(res.status) };
}

// Bounded timeout for the claim POST (same class as ENQUEUE_TIMEOUT_MS above —
// the stuck-send bug class: a hung claim left the drainer's `draining` flag
// true forever, so the queue never dispatched again until a page reload).
// Claim is a fast atomic file op server-side, so 12s is a generous bound. On
// abort/network failure return null (no claim): the drain simply stops, and
// the ~5s queue poll re-arms a later drain. If the backend DID award the
// claim but the response was lost, the item is `dispatching` server-side and
// is never re-claimed (claim awards only `pending`) — the reconcile/recovery
// paths own that item; no double dispatch is possible.
const CLAIM_TIMEOUT_MS = 12000;

// claimQueued atomically claims the oldest pending item (the cross-client
// boundary: only one browser wins). Returns the item, or null if nothing is
// pending. The cache is updated to mark the item dispatching.
export async function claimQueued(sessionId: string): Promise<QueuedMessage | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLAIM_TIMEOUT_MS);
  let item: QueuedMessage | null = null;
  try {
    const res = await fetch(queueUrl(sessionId, "/claim"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: "{}",
      signal: ctrl.signal,
    });
    if (res.ok) {
      // Body read INSIDE the armed timeout window (send-reliability slice 2,
      // commit-review D-F2): headers arriving with a stalled body used to
      // wedge the drainer's `draining` flag past the timer clear (readJSON ran
      // after the finally). Mirrors the createSession/resolveWithRetry shape.
      const j = await readJSON(res);
      item = j.item || null;
    }
  } catch {
    // Network error OR abort/timeout (incl. a hung BODY after headers) — no
    // confirmed claim; the drain stops (null), and a later drain attempt
    // retries cleanly.
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!item) return null;
  const claimed = item;
  setQueues(produce((q) => {
    const arr = q[sessionId];
    if (arr) {
      for (const m of arr) {
        if (m.id === claimed.id) {
          // Reconcile with the authoritative claimed state (dispatching).
          m.state = claimed.state;
          m.detail = claimed.detail;
          m.resolvedAt = claimed.resolvedAt;
          return;
        }
      }
      // Not in the local cache (stale/empty view) — upsert the authoritative
      // claimed item so the UI still reflects dispatching truth.
      arr.push(claimed);
    } else {
      q[sessionId] = [claimed];
    }
  }));
  return claimed;
}

// resolveQueued records a terminal outcome (sent | failed | unknown) for an
// item whose dispatch ALREADY happened (the caller classified the prompt_async
// result). It can never repend. The resolve WRITE only RECORDS that outcome —
// re-issuing it is SAFE and is NOT a re-dispatch (it never sends a prompt).
//
// Resolve-write failure handling (no stranding): the dispatch already produced
// a KNOWN terminal outcome. If the POST fails (500 / network), we reflect that
// outcome into the local cache IMMEDIATELY (optimistic terminal) so the UI is
// never misleadingly stuck in `dispatching`, then retry the write a bounded
// number of times to bring the backend to terminal. If retries exhaust, the
// optimistic local terminal state stays visible and `knownOutcomes` keeps a
// later fetchQueue from flipping the item back to dispatching.
//
// Invariants: NEVER re-dispatch (no second /oc/.../prompt_async). NEVER repend
// (target is always terminal). NEVER return a stranded item to pending.
//
// Send-reliability slice 3: returns the ResolveWriteOutcome so a status-surface
// retry (SendStatus's "Retry status save") knows whether the write recorded.
// Callers that ignore the return value (the drainer) are unaffected.
export async function resolveQueued(
  sessionId: string,
  id: string,
  state: "sent" | "failed" | "unknown",
  detail = "",
): Promise<ResolveWriteOutcome> {
  const resolvedAt = Date.now();
  // Reflect the KNOWN terminal outcome into the local cache + overlay now, so
  // the UI is honest regardless of whether the resolve write lands.
  applyOutcome(sessionId, id, state, detail, resolvedAt);
  // Bounded retry of the resolve WRITE (a record, not a dispatch — safe), with
  // the EXACT same (state, detail) body on every attempt (byte-identical
  // detail reuse: a slice-1 server treats an identical terminal re-resolve as
  // a no-op preserving timestamps, so legitimate retries never conflict).
  const outcome = await resolveWithRetry(sessionId, id, state, detail);
  if (outcome.kind === "recorded") {
    const echoed = outcome.item;
    if (echoed) {
      // Backend accepted and echoed the authoritative item — reconcile
      // detail/resolvedAt to the server's stamp.
      setQueues(produce((q) => {
        const arr = q[sessionId];
        if (arr) {
          for (const m of arr) {
            if (m.id === id) {
              m.state = echoed.state;
              m.detail = echoed.detail;
              m.resolvedAt = echoed.resolvedAt;
              break;
            }
          }
        }
      }));
    }
  } else if (outcome.kind === "conflict") {
    // The server holds a DIFFERENT terminal state for this item (slice-1
    // monotonic resolve: e.g. the reconciler already recorded `sent` while we
    // are late-reporting `unknown`). This is an EXPLICIT conflict, not a
    // transient failure — never retry-forever. The server's queue state is
    // authoritative: drop our optimistic overlay and refresh from the server
    // so the UI reflects the real terminal state instead of ours.
    knownOutcomes.delete(id);
    const linked = (queues[sessionId] || []).find((m) => m.id === id);
    if (linked?.attemptId) {
      // Surface the conflict on the linked send attempt (send-reliability
      // slice 2): the operator-visible state must be expressible.
      markSendAttemptResolveConflict(linked.attemptId, sessionId, outcome.detail || "queue_resolve_conflict");
    }
    try {
      await fetchQueue(sessionId);
    } catch {
      /* offline: the optimistic local state stays; the next successful poll
         reconciles (the overlay is gone, so server truth wins when it lands). */
    }
  } else {
    // UNRECORDED (send-reliability slice 3): attempts exhausted on transient
    // errors. The dispatch outcome IS known and visible (the optimistic
    // terminal state applied above + the knownOutcomes overlay), but the
    // backend never received the record. Surface the retryable status-save
    // state — Slice 3 renders "Message outcome recorded; status not saved."
    // with a Retry STATUS SAVE affordance (a record, never a resend). Linked
    // by the item's attemptId when the item carries one (slice-1 servers); a
    // synthetic id otherwise (the record still lands under the session's
    // ownerKey so the status surface finds it).
    const linked = (queues[sessionId] || []).find((m) => m.id === id);
    markSendAttemptStatusUnsaved(linked?.attemptId || `save-${id}`, sessionId, {
      itemId: id,
      state,
      detail,
    });
  }
  // If retries exhausted (unrecorded), the optimistic local terminal state
  // (set above) stays; knownOutcomes keeps fetchQueue from flipping it back
  // to dispatching.
  return outcome;
}

// applyOutcome records the known terminal outcome in both the local cache and
// the reconcile overlay. Called once the dispatch outcome is determined
// (regardless of whether the resolve write later succeeds).
function applyOutcome(
  sessionId: string,
  id: string,
  state: "sent" | "failed" | "unknown",
  detail: string,
  resolvedAt: number,
): void {
  knownOutcomes.set(id, { state, detail, resolvedAt });
  setQueues(produce((q) => {
    const arr = q[sessionId];
    if (arr) {
      for (const m of arr) {
        if (m.id === id) {
          m.state = state;
          m.detail = detail;
          m.resolvedAt = resolvedAt;
          break;
        }
      }
    }
  }));
}

// Per-attempt timeout for the resolve WRITE. The resolve is a fast local
// record server-side; 5s per attempt bounds the worst-case guard hold
// (3 attempts + 50ms delays ≈ 15.1s) so a hung resolve socket can never leave
// the drainer's finally unreachable — that was the isSending-stuck-true bug:
// the Send button disabled forever with no error until a page reload. On
// abort the attempt counts as failed and the bounded retry loop continues.
const RESOLVE_TIMEOUT_MS = 5000;

// Typed outcome of the bounded resolve-write retry loop (send-reliability
// slice 2):
//   recorded   — a 2xx landed (item may be absent on a body-less 2xx).
//   conflict   — the server answered 409 queue_resolve_conflict: it holds a
//                DIFFERENT terminal state. Terminal for this write — the loop
//                STOPS (an explicit conflict must never be retried forever).
//   unrecorded — attempts exhausted on transient errors (network/5xx); the
//                optimistic local terminal state stays visible.
export type ResolveWriteOutcome =
  | { kind: "recorded"; item?: QueuedMessage }
  | { kind: "conflict"; detail: string }
  | { kind: "unrecorded" };

// resolveWithRetry POSTs the resolve write a bounded number of times. The
// request body is built ONCE and reused byte-identically on every attempt
// (slice-1 servers treat an identical terminal re-resolve as a no-op that
// preserves timestamps, so legitimate retries never conflict). Returns the
// outcome (see ResolveWriteOutcome). Retries only on transient errors (network
// / non-coded non-2xx). This only records an outcome — it NEVER dispatches.
async function resolveWithRetry(
  sessionId: string,
  id: string,
  state: "sent" | "failed" | "unknown",
  detail: string,
): Promise<ResolveWriteOutcome> {
  const url = queueUrl(sessionId, `/${encodeURIComponent(id)}/resolve`);
  const body = JSON.stringify({ state, detail });
  const headers = { "Content-Type": "application/json", "X-VH-CSRF": "1" };
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
      if (res.ok) {
        const j = await readJSON(res);
        return { kind: "recorded", item: j.item as QueuedMessage | undefined };
      }
      if (res.status === 409) {
        // Body read inside the armed window. A coded resolve-conflict is
        // terminal for this write — STOP immediately (explicit conflict, not
        // retry-forever). An uncoded 409 keeps the legacy transient-retry
        // behavior (older servers, non-monotonic sentinels).
        const j = await readJSON(res);
        if (j.code === "queue_resolve_conflict") {
          return { kind: "conflict", detail: String(j.error || "") };
        }
      }
    } catch {
      // Network error / interruption / abort-timeout — retry (this is a
      // record, not a dispatch).
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) await delay(50);
  }
  return { kind: "unrecorded" };
}

// clearQueueCache drops cache entries for the given sessions (used on archive:
// the backend deletes the queue file server-side, so this is just a local
// cache prune — NOT a write to queue authority).
export function clearQueueCache(ids: string[]) {
  setQueues(produce((q) => {
    for (const id of ids) {
      const arr = q[id];
      if (arr) for (const m of arr) knownOutcomes.delete(m.id);
      delete q[id];
    }
  }));
}

// --- legacy migration (vh.queue.v1 → backend) ------------------------------
//
// Per session: read legacy entries in local order → enqueue sequentially through
// the backend → after each CONFIRMED response remove that specific legacy entry
// → on full success the session key is empty (and when all sessions are gone,
// vh.queue.v1 is retired). On enqueue failure/ambiguous response: stop, retain
// the entry locally, and signal failure so the UI can warn. Prefer a visible
// duplicate over silent loss if a successful import response is lost.

// In-memory guard: once a session has been migrated successfully, don't re-scan.
const migrated = new Set<string>();

function readLegacyMap(): Record<string, QueuedMessage[]> {
  return loadVersioned<Record<string, QueuedMessage[]>>(LS_QUEUE, 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, QueuedMessage[]>) : {},
  );
}

function writeLegacyMap(map: Record<string, QueuedMessage[]>) {
  const hasAny = Object.keys(map).some((k) => map[k] && map[k].length > 0);
  if (hasAny) {
    saveVersioned(LS_QUEUE, 1, map);
  } else {
    try {
      localStorage.removeItem(LS_QUEUE);
    } catch {
      /* ignore */
    }
  }
}

// migrateLegacyQueue imports a session's legacy local queue into the backend.
// Returns true on full success (or nothing to migrate). After a successful full
// import, the session's legacy entries are removed; vh.queue.v1 is retired once
// every session is empty.
export async function migrateLegacyQueue(sessionId: string): Promise<boolean> {
  if (migrated.has(sessionId)) return true;
  const map = readLegacyMap();
  const entries = map[sessionId];
  if (!entries || entries.length === 0) {
    migrated.add(sessionId);
    return true;
  }
  for (const e of entries) {
    try {
      await enqueue(sessionId, { text: e.text, attachments: e.attachments, sendConfig: e.sendConfig });
    } catch {
      // Enqueue failed or response ambiguous — stop, retain this entry. A later
      // retry may produce a visible duplicate, which is preferred over loss.
      return false;
    }
    // Confirmed import → remove THIS specific legacy entry.
    const fresh = readLegacyMap();
    if (fresh[sessionId]) {
      fresh[sessionId] = fresh[sessionId].filter((m) => m.id !== e.id);
      if (fresh[sessionId].length === 0) delete fresh[sessionId];
    }
    writeLegacyMap(fresh);
  }
  migrated.add(sessionId);
  return true;
}
