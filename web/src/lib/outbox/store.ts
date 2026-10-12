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
  // R-F2 (cross-tab supersede scoping, 2026-10-10): the page (tab) that wrote
  // this record — stamped by saveGesture/retryFailedSave from the controller's
  // per-tab page identity (sessionStorage-backed, b-F2: per-tab AND
  // reload-stable within the tab — never localStorage, which is shared across
  // tabs; the b-F1/b-F2 round-2 platform-copy caveat is documented on
  // `bootNonce` below and in index.ts's identity block). Supersede scans
  // match ONLY same-clientId records: a tab must never prune another tab's
  // just-committed durable gesture (the cross-tab mutual-prune interleave
  // voided BLK-A3 for the pruned gesture). Cross-tab same-text duplicates
  // are owned by the DESIGNED backstops — reconcile's pass-local same-text
  // suppression + the daemon's intentId-VALUE admission dedupe (which does
  // NOT collapse same-text records under distinct intentIds). ABSENT
  // (records written before this field existed): foreign — never pruned
  // (migration-safe, errs toward retention).
  clientId?: string;
  // b-F1/b-F2 round 2 (2026-10-10): the PAGE EVALUATION nonce of the writer —
  // a per-eval random stamped at save/retry (deliberately NOT reload-stable:
  // every page load mints a fresh one; the clientId is the reload-stable
  // half, this is the eval-distinguishing half). Needed because the platform
  // COPIES sessionStorage into opener-created tabs (window.open /
  // target=_blank) and duplicated tabs — a clone then evaluates under the
  // SAME clientId, and the id alone cannot distinguish "my dead former self
  // (a reload)" from "a live clone sibling". Same clientId + SAME nonce =
  // THIS page-eval's record (definitely ours); same clientId + DIFFERENT or
  // ABSENT nonce = an EARLIER eval of this id (pre-reload self OR clone —
  // not locally distinguishable; the uncontested-claim gate in index.ts
  // decides). ABSENT on same-clientId records (pre-upgrade): treated as
  // cross-eval — never pruned without the claim gate (migration-safe).
  bootNonce?: string;
  // R-F3 (admitted twin prune, 2026-10-10): stamped by markAdmitted when the
  // admission confirmation commits. A still-`saved` same-text record whose
  // createdAt is OLDER than this timestamp is a pre-admission residual twin
  // (the crash-separated ~2-IDB-op window) — reconcile prunes it instead of
  // re-admitting (the daemon does NOT collapse distinct intentIds: two
  // admissions would be a duplicate send). A same-text record NEWER than
  // admittedAt is a fresh deliberate gesture — kept. ABSENT (legacy
  // records): the time gate cannot run — current behavior retained.
  admittedAt?: number;
}

/** Typed result of a local save. Never a throw. */
export type OutboxSaveResult = { ok: true } | { ok: false; code: "storage-unavailable"; reason: string };

/** The storage seam. All operations resolve (never reject); storage failures
 *  surface as the typed `{ok:false}` result on put and as `undefined`/empty on
 *  reads (a read that cannot observe the store must not fabricate records).
 *  `snapshot` is the exception: it REJECTS on failure — its caller (the
 *  pending-marker trust check) must distinguish "read the store, it is empty"
 *  from "could not read the store" (an unreadable store can establish neither
 *  emptiness nor eviction, so the caller must conclude nothing at all). */
export interface OutboxStore {
  put(rec: OutboxGestureRecord): Promise<OutboxSaveResult>;
  get(intentId: string): Promise<OutboxGestureRecord | undefined>;
  all(): Promise<OutboxGestureRecord[]>;
  delete(intentId: string): Promise<void>;
  /** Consistent {records, epoch} read from ONE transaction. `epoch` is the
   *  store's mutation epoch — bumped transactionally by EVERY put/delete —
   *  so a snapshot's record list and its epoch can never disagree. The
   *  pending-marker trust basis (index.ts): a marker stamped with epoch E is
   *  provably about the store state at epoch E, and any later mutation
   *  invalidates it detectably. */
  snapshot(): Promise<OutboxSnapshot>;
}

/** One transactionally consistent view of the store. */
export interface OutboxSnapshot {
  all: OutboxGestureRecord[];
  epoch: number;
}

// --- real IndexedDB implementation -------------------------------------------

const IDB_NAME = "vh-solara-outbox";
// v2 adds the `meta` object store (the mutation epoch — see snapshot()). v1
// databases upgrade in place: onupgradeneeded only creates the missing store,
// existing gesture records are preserved.
const IDB_VERSION = 2;
const STORE = "gestures";
const META_STORE = "meta";
const META_EPOCH_KEY = "epoch";

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
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
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

/** Bump the mutation epoch INSIDE a readwrite transaction that also mutates
 *  the gesture store. Transactionality is the entire point: records and epoch
 *  move together atomically, so "epoch E" names an exact store state and a
 *  crash between record-write and epoch-write is impossible. IDB serializes
 *  write transactions per database, so concurrent tabs can never lose an
 *  epoch bump (two mutations ⇒ epoch advanced by exactly two). A failing
 *  epoch write aborts the WHOLE transaction — the caller's put surfaces
 *  {ok:false} rather than committing a mutation the epoch does not testify
 *  to (the marker trust basis must never diverge from the records). */
function txBumpEpoch(tx: IDBTransaction): void {
  const meta = tx.objectStore(META_STORE);
  const get = meta.get(META_EPOCH_KEY);
  get.onsuccess = () => {
    meta.put((Number(get.result) || 0) + 1, META_EPOCH_KEY);
  };
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
        // not "request queued" (BLK-A3 — the commit is the gate). The same
        // transaction bumps the mutation epoch (see txBumpEpoch).
        const tx = d.transaction([STORE, META_STORE], "readwrite");
        tx.objectStore(STORE).put(toPlain(rec));
        txBumpEpoch(tx);
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
    async snapshot() {
      const d = await db();
      // ONE readonly transaction across both stores: the record list and the
      // epoch cannot disagree (a mutation committed between two separate
      // reads could otherwise make a snapshot lie about which state it saw).
      // Rejects on failure — see the interface note.
      return await new Promise<OutboxSnapshot>((resolve, reject) => {
        const tx = d.transaction([STORE, META_STORE], "readonly");
        const reqAll = tx.objectStore(STORE).getAll();
        const reqEpoch = tx.objectStore(META_STORE).get(META_EPOCH_KEY);
        tx.oncomplete = () =>
          resolve({
            all: (reqAll.result as OutboxGestureRecord[]) ?? [],
            epoch: Number(reqEpoch.result) || 0,
          });
        tx.onerror = () => reject(tx.error ?? new Error("snapshot transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("snapshot transaction aborted"));
      });
    },
    async delete(intentId) {
      try {
        const d = await db();
        const tx = d.transaction([STORE, META_STORE], "readwrite");
        tx.objectStore(STORE).delete(intentId);
        txBumpEpoch(tx);
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
 *  with a failing put for the storage-unavailable contract tests. Mirrors the
 *  real store's epoch semantics: successful put/delete bump the epoch, a
 *  failed put does not (the mutation never happened, so the epoch must not
 *  testify that it did). */
export function createMemoryOutboxStore(opts: { failPuts?: () => string | null } = {}): OutboxStore {
  const map = new Map<string, OutboxGestureRecord>();
  let epoch = 0;
  return {
    async put(rec) {
      const reason = opts.failPuts?.();
      if (reason !== null && reason !== undefined) {
        return { ok: false, code: "storage-unavailable", reason };
      }
      // Same JSON boundary as the real store (proxy callers behave
      // identically under both implementations).
      map.set(rec.intentId, toPlain(rec));
      epoch += 1;
      return { ok: true } as const;
    },
    async get(intentId) {
      const r = map.get(intentId);
      return r ? { ...r } : undefined;
    },
    async all() {
      return [...map.values()].map((r) => ({ ...r }));
    },
    async snapshot() {
      return { all: [...map.values()].map((r) => ({ ...r })), epoch };
    },
    async delete(intentId) {
      if (map.delete(intentId)) epoch += 1;
    },
  };
}
