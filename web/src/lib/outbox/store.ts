// IndexedDB outbox store — the durability boundary for send gestures
// (send-net-resilience slice 3, BLK-A3 prerequisite contract).
//
// The UI may claim a gesture is "locally saved" ONLY after the IDB transaction
// commits, so the store's `put` resolves with an explicit typed result instead
// of throwing: every IndexedDB failure mode (private-mode unavailable, quota
// exceeded, database blocked/evicted, a cleared store, aborted transactions)
// funnels into `{ ok: false, code: "storage-unavailable", reason }` and the
// CALLER decides the honest surface (a blocking persistent "not saved — copy
// your text" state with in-memory retention — never a silent loss).
//
// The boundary is an INTERFACE (`OutboxStore`) so unit tests run against an
// in-memory fake (no fake-indexeddb dependency; jsdom has no real IDB) while
// the REAL IndexedDB path is proven in the Playwright e2e lane. Both
// implementations live here because they share the record contract.

/** Context head captured at gesture-save time (debate-4 finding 7, as
 *  amended 2026-10-09 — see tmp/agent-runs/send-design/design.md): the
 *  immutable target session's transcript tail at the moment the gesture became
 *  locally durable. Compared at RESUME (the reconcile re-admission gate) and
 *  at REPLACEMENT (the chip's inline confirm + TOCTOU re-verify) — NOT inside
 *  the live tap→save→admit window, where hydration catch-up would
 *  false-positive. A changed head at those points means the conversation
 *  moved on and a VISIBLE stale-context confirmation must precede sending.
 *  `lastMessageId` is the resident transcript's last message id; `count`
 *  backs the id comparison (a compacted/reloaded window could theoretically
 *  reuse ids). `null` head fields mean "unknowable" and never fabricate
 *  staleness. */
export interface OutboxContextHead {
  sessionId: string;
  lastMessageId: string | null;
  count: number;
}

/** Serializable enqueue payload retained verbatim (the exact text/attachments/
 *  config the gesture will admit — mirrors PreparedSendPayload's serializable
 *  subset). */
export interface OutboxPayload {
  text: string;
  attachments: { url: string; filename: string; mime: string; path?: string }[];
  sendConfig?: { providerID?: string; modelID?: string; variant?: string; agent?: string };
}

/** One send gesture's durable local record. `intentId` is the gesture identity
 *  minted once per explicit send (retries of the SAME gesture reuse it; a NEW
 *  send — including an ambiguous replacement — mints a fresh one) and is the
 *  same value threaded to admission as the queue API's `intentId` wire alias
 *  (the daemon dedupes admission by value across the attemptId/intentId
 *  aliases, which is the multi-tab backstop). */
export interface OutboxGestureRecord {
  intentId: string;
  sessionId: string;
  createdAt: number;
  payload: OutboxPayload;
  capturedHead: OutboxContextHead | null;
  // "saved"    — locally durable; admission not yet confirmed (the crash window
  //              the outbox exists to protect).
  // "admitted" — the daemon confirmed admission (2xx receipt); the server-owned
  //              queue is now the authority and the record exists only for
  //              reconcile + the replacement-requested overlay until pruned.
  status: "saved" | "admitted";
  queueItemId?: string;
  // Ambiguous-replacement overlay (debate-4 B1): set when the operator tapped
  // "Send new message" on this gesture's ambiguous chip — the queue item stays
  // server-side unknown+ambiguousDelivery, so this FE-owned marker is what the
  // chip renders ("Replacement requested"). Points at the replacement's
  // intentId; both messages display truthfully if both land.
  replacedBy?: string;
  replacedAt?: number;
  // c-F2 (review): set when the record was (re-)committed WITHOUT a usable
  // captured head (retryFailedSave after a storage failure whose tap-time
  // head was unknowable). The stale gate can never run for this record, so
  // reconcile must NEVER auto re-admit it — it waits for an explicit operator
  // re-tap (the blocked row/banner own the retained text; a new same-text
  // gesture supersedes this record in saveGesture).
  reAdmitHold?: boolean;
}

/** Typed result of a local save. Never a throw. */
export type OutboxSaveResult = { ok: true } | { ok: false; code: "storage-unavailable"; reason: string };

/** The storage seam. All operations resolve (never reject); storage failures
 *  surface as the typed `{ok:false}` result on put and as `undefined`/empty on
 *  reads (a read that cannot observe the store must not fabricate records). */
export interface OutboxStore {
  put(rec: OutboxGestureRecord): Promise<OutboxSaveResult>;
  get(intentId: string): Promise<OutboxGestureRecord | undefined>;
  all(): Promise<OutboxGestureRecord[]>;
  delete(intentId: string): Promise<void>;
}

// --- real IndexedDB implementation -------------------------------------------

const IDB_NAME = "vh-solara-outbox";
const IDB_VERSION = 1;
const STORE = "gestures";

/** Open (and once-create) the outbox database. Rejects on ANY failure mode —
 *  the caller wraps it into the typed save result. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "intentId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB open blocked"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
  });
}

/** Records are JSON-shaped BY CONTRACT (they round-trip through IDB), but
 *  CALLERS may hand us reactive store objects (Solid proxies — e.g. a queue
 *  item's sendConfig captured off the queue store), which IDB's structured
 *  clone REFUSES (DataCloneError). A JSON round-trip both un-proxies and
 *  enforces the contract at the boundary; non-JSON fields were never
 *  persistable anyway. */
function toPlain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Real IndexedDB store. A single cached connection is opened lazily; on any
 *  failure the connection is dropped so a later attempt (or a fresh gesture
 *  after the operator frees storage) re-opens cleanly. */
export function createIdbOutboxStore(): OutboxStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = async (): Promise<IDBDatabase> => {
    if (!dbp) {
      dbp = openDb();
      dbp.catch(() => {
        dbp = null; // failed open is not cached — retry next call
      });
    }
    return dbp;
  };
  return {
    async put(rec) {
      try {
        const d = await db();
        // readwrite + await transaction completion: "saved" means COMMITTED,
        // not "request queued" (BLK-A3 — the commit is the gate).
        const tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(toPlain(rec));
        await txDone(tx);
        return { ok: true } as const;
      } catch (e) {
        return { ok: false, code: "storage-unavailable", reason: String(e) } as const;
      }
    },
    async get(intentId) {
      try {
        const d = await db();
        return await new Promise<OutboxGestureRecord | undefined>((resolve, reject) => {
          const req = d.transaction(STORE, "readonly").objectStore(STORE).get(intentId);
          req.onsuccess = () => resolve(req.result as OutboxGestureRecord | undefined);
          req.onerror = () => reject(req.error);
        });
      } catch {
        return undefined;
      }
    },
    async all() {
      try {
        const d = await db();
        return await new Promise<OutboxGestureRecord[]>((resolve, reject) => {
          const req = d.transaction(STORE, "readonly").objectStore(STORE).getAll();
          req.onsuccess = () => resolve((req.result as OutboxGestureRecord[]) ?? []);
          req.onerror = () => reject(req.error);
        });
      } catch {
        return [];
      }
    },
    async delete(intentId) {
      try {
        const d = await db();
        const tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(intentId);
        await txDone(tx);
      } catch {
        /* best-effort prune; a stuck record is retried by the next reconcile GC */
      }
    },
  };
}

// --- in-memory fake (unit tests) ---------------------------------------------

/** Deterministic in-memory OutboxStore for unit tests (jsdom has no IndexedDB
 *  and the repo does not depend on fake-indexeddb). Optionally constructed
 *  with a failing put for the storage-unavailable contract tests. */
export function createMemoryOutboxStore(opts: { failPuts?: () => string | null } = {}): OutboxStore {
  const map = new Map<string, OutboxGestureRecord>();
  return {
    async put(rec) {
      const reason = opts.failPuts?.();
      if (reason !== null && reason !== undefined) {
        return { ok: false, code: "storage-unavailable", reason };
      }
      // Same JSON boundary as the real store (proxy callers behave
      // identically under both implementations).
      map.set(rec.intentId, toPlain(rec));
      return { ok: true } as const;
    },
    async get(intentId) {
      const r = map.get(intentId);
      return r ? { ...r } : undefined;
    },
    async all() {
      return [...map.values()].map((r) => ({ ...r }));
    },
    async delete(intentId) {
      map.delete(intentId);
    },
  };
}
