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
// dismissal. Correctness never depends on a push channel — the FE pulls on
// session open, after every mutation, on focus/visibility, on stream reconnect,
// and polls ~5s while the selected session has queue state.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { loadVersioned, saveVersioned } from "./lib/store";

export interface QueuedAttachment {
  url: string;
  filename: string;
  mime: string;
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
  createdAt: number;
  resolvedAt?: number;
  // Failure / ambiguous detail for failed | unknown (diagnostics).
  detail?: string;
}

// Input shape for enqueue (the backend issues id + order + state + createdAt).
export type QueueInput = Pick<QueuedMessage, "text" | "attachments"> & {
  sendConfig?: QueuedMessage["sendConfig"];
  originClientId?: string;
};

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
  return queues[sessionId] || [];
}

// True when a session has any items in the cache (pending/dispatching/terminal).
// Drives the ~5s poll: polling runs only while there's something to show.
export function hasQueueState(sessionId: string): boolean {
  return (queues[sessionId] || []).length > 0;
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

// enqueue POSTs a new message; the backend issues the id + monotonic order.
// Returns the created item. Throws on non-2xx so the caller can preserve the
// composed text (no silent loss).
export async function enqueue(sessionId: string, input: QueueInput): Promise<QueuedMessage> {
  const res = await fetch(queueUrl(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`enqueue failed (${res.status})`);
  }
  const j = await readJSON(res);
  const item: QueuedMessage | undefined = j.item;
  if (!item) {
    // Ambiguous response (successful import lost / malformed): treat as a
    // failure so the caller retains the text. A retry may produce a visible
    // duplicate, which is preferred over silent loss (operator policy).
    throw new Error("enqueue: no item in response");
  }
  setQueues(produce((q) => {
    (q[sessionId] ||= []).push(item);
  }));
  return item;
}

// removeQueued deletes a PENDING item. The backend rejects non-pending removal
// (409); on that, refresh the cache so the UI reflects the real state.
export async function removeQueued(sessionId: string, id: string): Promise<void> {
  const res = await fetch(queueUrl(sessionId, `/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: { "X-VH-CSRF": "1" },
  });
  if (res.ok) {
    setQueues(produce((q) => {
      if (q[sessionId]) q[sessionId] = q[sessionId].filter((m) => m.id !== id);
    }));
    return;
  }
  if (res.status === 404) return; // already gone — reflect nothing
  if (res.status === 409) {
    // Item is no longer pending (dispatching/terminal) — refresh to show truth.
    await fetchQueue(sessionId);
    return;
  }
}

// claimQueued atomically claims the oldest pending item (the cross-client
// boundary: only one browser wins). Returns the item, or null if nothing is
// pending. The cache is updated to mark the item dispatching.
export async function claimQueued(sessionId: string): Promise<QueuedMessage | null> {
  const res = await fetch(queueUrl(sessionId, "/claim"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
    body: "{}",
  });
  if (!res.ok) return null;
  const j = await readJSON(res);
  const item: QueuedMessage | null = j.item || null;
  if (!item) return null;
  setQueues(produce((q) => {
    const arr = q[sessionId];
    if (arr) {
      for (const m of arr) {
        if (m.id === item.id) {
          // Reconcile with the authoritative claimed state (dispatching).
          m.state = item.state;
          m.detail = item.detail;
          m.resolvedAt = item.resolvedAt;
          return;
        }
      }
      // Not in the local cache (stale/empty view) — upsert the authoritative
      // claimed item so the UI still reflects dispatching truth.
      arr.push(item);
    } else {
      q[sessionId] = [item];
    }
  }));
  return item;
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
export async function resolveQueued(
  sessionId: string,
  id: string,
  state: "sent" | "failed" | "unknown",
  detail = "",
): Promise<void> {
  const resolvedAt = Date.now();
  // Reflect the KNOWN terminal outcome into the local cache + overlay now, so
  // the UI is honest regardless of whether the resolve write lands.
  applyOutcome(sessionId, id, state, detail, resolvedAt);
  // Bounded retry of the resolve WRITE (a record, not a dispatch — safe).
  const echoed = await resolveWithRetry(sessionId, id, state, detail);
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
  // If retries exhausted, the optimistic local terminal state (set above) stays;
  // knownOutcomes keeps fetchQueue from flipping it back to dispatching.
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

// resolveWithRetry POSTs the resolve write a bounded number of times. Returns
// the authoritative item echoed by the backend on success (may be undefined if
// the 2xx body carried no item), or undefined if the write never landed.
// Retries on any non-2xx or network error (transient). This only records an
// outcome — it NEVER dispatches.
async function resolveWithRetry(
  sessionId: string,
  id: string,
  state: "sent" | "failed" | "unknown",
  detail: string,
): Promise<QueuedMessage | undefined> {
  const url = queueUrl(sessionId, `/${encodeURIComponent(id)}/resolve`);
  const body = JSON.stringify({ state, detail });
  const headers = { "Content-Type": "application/json", "X-VH-CSRF": "1" };
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers, body });
      if (res.ok) {
        const j = await readJSON(res);
        return j.item as QueuedMessage | undefined;
      }
    } catch {
      // Network error / interruption — retry (this is a record, not a dispatch).
    }
    if (attempt < MAX_ATTEMPTS) await delay(50);
  }
  return undefined;
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
