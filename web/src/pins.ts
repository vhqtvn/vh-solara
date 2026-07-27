// Pin authority: pin membership + order facade.
//
// ─── Phase 5: server-backed pin facade ───────────────────────────────────────
// Pin membership + order are now a WORKER-WIDE server authority (Phases 1–4):
// the durable PinStore, GET/PUT /vh/pins CAS API, and the pins.snapshot /
// pins.updated SSE frames. This module is the client facade over that authority.
//
// Two modes:
//   - "legacy"  (default until the first pins.snapshot arrives): the OLD 100%
//               localStorage implementation is used verbatim. This is the
//               fallback for an old/feature-off server (no pins.* frames ever
//               arrive) and the pre-snapshot boot window.
//   - "server"  (flipped by the first pins.snapshot): the server's
//               orderedSessionIds[] is the SOLE membership+order source. Pin /
//               unpin / reorder become async PUT /vh/pins calls with one bounded
//               409 retry for membership intents and no auto-replay for reorder.
//
// `reconciledPinnedOrder()` stays RENDER-ONLY: its output is never PUT back to
// the server. Pins are worker-wide; a client viewing one project must not
// overwrite pins belonging to another project, so mutations always derive the
// next worker-wide list from the CURRENT authoritative orderedSessionIds —
// never from the current-tree intersection (which selectPinnedNodes filters at
// render time and is irrelevant to the worker-wide truth).
//
// ─── Rollback compatibility (ONE release window) ────────────────────────────
// When server capability is present, localStorage is NEVER consulted for
// decisions; after each authoritative server update the facade writes a
// compatibility SHADOW to the two legacy keys so a rollback to a pre-Phase-5
// binary keeps the user's pins. If the capability is absent (old server) the
// legacy implementation stands. After the rollback window the shadow writes +
// the legacy reader will be removed.
//   TODO(phase-after-rollback-window): remove writeLegacyShadow +
//   readLegacyReconciledSeed + the legacy signals/path once the rollback window
//   closes and pins.* frames are guaranteed server-side.
import { batch, createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";
import { reorderRelative } from "./lib/dragReorder";
import { log } from "./lib/log";

// Legacy localStorage keys. In server mode these are shadow-written only
// (rollback compat); in legacy mode they are the authority.
const LS_PINNED = "vh.pinned.v1";
const LS_ORDER = "vh.pinned-order.v1";

const coerceStringArray = (o: unknown): string[] =>
  Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : [];

// === Pin wire shape (LOCKED contract from Phases 1–4) =========================
// Both pins.snapshot and pins.updated decode as this. GET/PUT /vh/pins responses
// (200 + 409) carry the same public doc. NO projectBySessionId, NO schemaVersion
// on the wire.
export interface PinDoc {
  revision: number;
  initialized: boolean;
  orderedSessionIds: string[];
}

// coercePinDoc — defensive parser for a pins frame / response body. Returns null
// on a shape that cannot be trusted; fills sensible defaults for partially-missing
// scalar fields. Exported so the stream listener + tests share one validation path.
export function coercePinDoc(o: unknown): PinDoc | null {
  if (!o || typeof o !== "object") return null;
  const obj = o as Record<string, unknown>;
  const revision = typeof obj.revision === "number" ? obj.revision : 0;
  const initialized = typeof obj.initialized === "boolean" ? obj.initialized : false;
  const orderedSessionIds = Array.isArray(obj.orderedSessionIds)
    ? obj.orderedSessionIds.filter((x): x is string => typeof x === "string")
    : [];
  return { revision, initialized, orderedSessionIds };
}

export type PinErrorKind = "pin-conflict" | "pin-network" | "pin-error";

// === Authority mode ==========================================================
// "legacy" until the first pins.snapshot flips to "server". The flip is one-way
// within a session (a reconnect re-flips to "server" via the new snapshot — it
// never returns to "legacy").
const [pinsMode, setPinsMode] = createSignal<"legacy" | "server">("legacy");

// === Legacy fallback signals (legacy-mode authority) =========================
// Membership (a Set) is the legacy source of truth; the order array only governs
// render order within the pinned group. Kept as separate signals so the legacy
// path is byte-for-byte the old implementation.
const [legacyPinnedSet, setLegacyPinnedSet] = createSignal<Set<string>>(
  new Set(loadVersioned<string[]>(LS_PINNED, 1, [], coerceStringArray)),
);
const [legacyOrderArr, setLegacyOrderArr] = createSignal<string[]>(
  loadVersioned<string[]>(LS_ORDER, 1, [], coerceStringArray),
);

// === Server-authoritative signals (server-mode authority) ====================
// serverOrder is THE render source in server mode (membership = the set of ids
// in this array; order = the array order). Optimistic mutations write here
// directly; a failed PUT rolls back to the captured pre-mutation snapshot.
// serverRevision is the CAS base for the next PUT; it is bumped only by
// adoptServerDoc (a confirmed server frame / 200 response), never by optimistic.
const [serverOrder, setServerOrder] = createSignal<string[]>([]);
const [serverRevision, setServerRevision] = createSignal<number>(0);
const [serverInitialized, setServerInitialized] = createSignal<boolean>(false);

// === Pending-mutation + advisory error state (for Phase 6 UI) ================
// pendingCount serializes the boolean view across concurrent in-flight PUTs.
let pendingCount = 0;
const [pinsPendingSig, setPinsPendingSig] = createSignal(false);
const [pinsErrorSig, setPinsErrorSig] = createSignal<PinErrorKind | null>(null);

// migrationAttempted guards the one-shot legacy→server seed migration so a
// reconnect (which re-emits pins.snapshot) does not re-submit the seed within
// the same session. Reset in __resetPinnedForTest.
let migrationAttempted = false;

function incPending(): void {
  pendingCount++;
  if (!pinsPendingSig()) setPinsPendingSig(true);
}
function decPending(): void {
  pendingCount = Math.max(0, pendingCount - 1);
  if (pendingCount === 0 && pinsPendingSig()) setPinsPendingSig(false);
}
function clearPinsErrorSig(): void {
  if (pinsErrorSig() !== null) setPinsErrorSig(null);
}

// === Render accessors (sync; branch on mode) =================================
export function pinned(): Set<string> {
  if (pinsMode() === "server") return new Set(serverOrder());
  return legacyPinnedSet();
}
export const isPinned = (id: string): boolean =>
  pinsMode() === "server" ? serverOrder().includes(id) : legacyPinnedSet().has(id);

// reconciledPinnedOrder — RENDER-ONLY. In server mode the server's
// orderedSessionIds is already reconciled (membership + order in one), so it is
// returned verbatim. In legacy mode the persisted order is reconciled against
// the current membership (drop stale, append unknown) — the historical behavior.
// The output MUST NEVER be PUT to the server as the worker-wide list (it is a
// render view; the worker-wide truth is what the server already holds).
export function reconciledPinnedOrder(): string[] {
  if (pinsMode() === "server") return serverOrder();
  return reconcileLegacyOrder(legacyPinnedSet(), legacyOrderArr());
}

// === Public state accessors (for Phase 6 UX + diagnostics) ===================
export const pinsRevision = (): number => serverRevision();
export const pinsInitialized = (): boolean => serverInitialized();
export const pinsServerMode = (): boolean => pinsMode() === "server";
export const pinsPending = (): boolean => pinsPendingSig();
export function pinsLastError(): PinErrorKind | null {
  return pinsErrorSig();
}
export function clearPinsError(): void {
  clearPinsErrorSig();
}

// === Legacy helpers (pure + isolated) ========================================
// reconcileLegacyOrder — the historical reconciledPinnedOrder body, extracted
// verbatim so the legacy path is unchanged. Pure: takes the set + order, returns
// the reconciled list (drop stale ids absent from the set; append set members
// absent from the order at the end, preserving relative order). Does NOT persist.
function reconcileLegacyOrder(set: Set<string>, order: string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (set.has(id) && !seen.has(id)) {
      kept.push(id);
      seen.add(id);
    }
  }
  for (const id of set) {
    if (!seen.has(id)) {
      kept.push(id);
      seen.add(id);
    }
  }
  return kept;
}

function legacyPersistPinned(next: Set<string>): void {
  setLegacyPinnedSet(next);
  saveVersioned(LS_PINNED, 1, [...next]);
}
function legacyPersistOrder(next: string[]): void {
  setLegacyOrderArr(next);
  saveVersioned(LS_ORDER, 1, next);
}

// writeLegacyShadow — ROLLBACK COMPAT. Mirrors the authoritative server order
// into BOTH legacy keys so a rollback to a pre-Phase-5 binary keeps the user's
// pins. Membership and order are now the same array (the server combines them),
// so both keys receive it; an old binary reading them sees consistent data.
// Removed after the rollback window closes (see TODO at top of file).
function writeLegacyShadow(order: string[]): void {
  saveVersioned(LS_PINNED, 1, order);
  saveVersioned(LS_ORDER, 1, order);
}

// readLegacyReconciledSeed — reads the legacy keys and reconciles them into a
// seed for the one-time migration PUT. Pure (no signal reads). Used only on the
// first pins.snapshot with initialized===false.
function readLegacyReconciledSeed(): string[] {
  const set = new Set(loadVersioned<string[]>(LS_PINNED, 1, [], coerceStringArray));
  const order = loadVersioned<string[]>(LS_ORDER, 1, [], coerceStringArray);
  return reconcileLegacyOrder(set, order);
}

// === Server-authoritative adoption + transport ===============================
// adoptServerDoc — the single writer for a confirmed server doc (snapshot,
// updated, or a 200 PUT response). Bumps revision + initialized + order together
// (batched so render sees a consistent snapshot) and shadows to legacy keys.
// Clears any prior advisory error (a confirmed doc supersedes it).
function adoptServerDoc(doc: PinDoc): void {
  batch(() => {
    setServerOrder(doc.orderedSessionIds);
    setServerRevision(doc.revision);
    setServerInitialized(doc.initialized);
    clearPinsErrorSig();
  });
  writeLegacyShadow(doc.orderedSessionIds);
}

// applyServerOrder — optimistic local order write (no revision bump). Used for
// the immediate UI feedback before a PUT resolves.
function applyServerOrder(order: string[]): void {
  setServerOrder(order);
}

// adoptPutResponse — adopt a confirmed PUT-response doc (200 success or 409
// conflict), gated by the SAME revision-monotonicity guard as applyPinsUpdated
// (F1, Phase 3 review). A pins.updated frame adopted between the optimistic
// write and the response landing could otherwise regress client order/revision
// to the (older) response. Equal revision is allowed through (idempotent
// re-adopt). Self-corrects on the next frame. Mirrors applyPinsUpdated's guard;
// pins.snapshot stays EXEMPT — it is the bootstrap reset handled by
// applyPinsSnapshot directly. (p5-defer-put-success-adopt-race.)
function adoptPutResponse(doc: PinDoc): void {
  if (doc.revision < serverRevision()) {
    log.warn("pins", "dropping stale PUT response (revision regression)", {
      got: doc.revision,
      have: serverRevision(),
    });
    return;
  }
  adoptServerDoc(doc);
}

// rollbackOrderIfUnchanged — roll an optimistic order write back to a captured
// baseline, but ONLY if no fresher authoritative frame landed during the PUT
// round-trip. A pins.updated / pins.snapshot adopted in that window bumped
// serverRevision + serverOrder; rolling back to the stale baseline would
// overwrite the fresher frame's order while leaving serverRevision at the
// frame's value — a (stale order, fresh revision) split that can lost-update on
// the next mutation (the next PUT would ship the stale order against a
// now-matching revision and the frame's pins silently drop). When the revision
// moved, the fresher frame's order wins and is left intact; the advisory error
// is still surfaced. (p5-defer-retry-rollback-race.)
function rollbackOrderIfUnchanged(baseline: string[], issueRevision: number): void {
  if (serverRevision() !== issueRevision) return; // fresher frame landed — don't clobber
  applyServerOrder(baseline);
}

// putPins — the PUT /vh/pins CAS call. X-VH-CSRF is added automatically by the
// SPA's installCsrf() (web/src/csrf.ts wraps window.fetch); tests that stub
// global fetch do not need to set it. 200 and 409 both carry the full public
// doc; a structured 400 (unknown_session) carries unknownIds so the caller can
// self-heal; 404/other do not. status:0 is a synthetic network-error sentinel.
async function putPins(
  baseRevision: number,
  orderedSessionIds: string[],
  opts?: { initializeOnly?: boolean },
): Promise<{ status: number; doc: PinDoc | null; unknownIds?: string[] }> {
  const body: Record<string, unknown> = { baseRevision, orderedSessionIds };
  if (opts?.initializeOnly) body.initializeOnly = true;
  try {
    const res = await fetch("/vh/pins", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 200 || res.status === 409) {
      const parsed = await res.json().catch(() => null);
      return { status: res.status, doc: coercePinDoc(parsed) };
    }
    if (res.status === 400) {
      // Structured 400: the server reports newly-added ids that are not active
      // on this worker (error:"unknown_session"). Parse unknownIds so the
      // caller can self-heal — drop them from the local order and retry once
      // (bounded). A 400 without unknownIds (other input-validation failures:
      // malformed/duplicate/oversized/over-cap) yields an empty array; the
      // caller treats it as a generic pin-error (no self-heal, no retry).
      const parsed = await res.json().catch(() => null);
      return { status: 400, doc: null, unknownIds: parseUnknownIds(parsed) };
    }
    return { status: res.status, doc: null };
  } catch (err) {
    log.warn("pins", "PUT /vh/pins network error", { err: String(err) });
    return { status: 0, doc: null };
  }
}

// parseUnknownIds — extracts the string[] unknownIds from a structured 400
// body. Returns [] for a body lacking the unknown_session discriminator or a
// string-array unknownIds (defensive: a non-conforming or text/plain 400, or
// an unrelated structured 400, must not trigger local pin eviction + retry).
// Pure.
function parseUnknownIds(o: unknown): string[] {
  if (!o || typeof o !== "object") return [];
  const obj = o as Record<string, unknown>;
  if (obj.error !== "unknown_session") return [];
  if (!Array.isArray(obj.unknownIds)) return [];
  return obj.unknownIds.filter((x): x is string => typeof x === "string");
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

// === Stream entry points (called by sync/stream.ts listeners) ================
export function applyPinsSnapshot(raw: unknown): void {
  const doc = coercePinDoc(raw);
  if (!doc) {
    log.warn("pins", "malformed pins.snapshot doc", { raw });
    return;
  }
  // The snapshot is the fresh-connect bootstrap: authoritative, always adopted.
  // It is NOT subject to the revision-monotonicity guard (that guards only live
  // pins.updated fan-out); a snapshot resets the base.
  const seed = doc.initialized ? null : readLegacyReconciledSeed();
  batch(() => {
    setPinsMode("server");
    setServerRevision(doc.revision);
    setServerInitialized(doc.initialized);
    setServerOrder(doc.initialized ? doc.orderedSessionIds : seed ?? []);
    clearPinsErrorSig();
  });
  if (doc.initialized) {
    // Server has authority — it wins unconditionally. Never consult localStorage
    // for decisions; just shadow for rollback compat.
    writeLegacyShadow(doc.orderedSessionIds);
    return;
  }
  // Uninitialized: show the legacy seed optimistically (avoids an empty flash
  // while the migration PUT is in flight), then submit ONE initializeOnly PUT.
  // First successful browser wins; a 409 means another browser won — discard the
  // local seed and adopt server state. Do NOT union/merge lists across browsers.
  if (seed) writeLegacyShadow(seed);
  if (!migrationAttempted && seed && seed.length > 0) {
    migrationAttempted = true;
    void runMigration(seed);
  }
}

export function applyPinsUpdated(raw: unknown): void {
  const doc = coercePinDoc(raw);
  if (!doc) {
    log.warn("pins", "malformed pins.updated doc", { raw });
    return;
  }
  // An updated frame implies server capability. If one arrives before the
  // bootstrap snapshot (should not happen — snapshot is emitted first on every
  // fresh connect), defensively flip to server mode and adopt.
  if (pinsMode() !== "server") setPinsMode("server");
  // F1 (Phase 3 review): revision-monotonicity guard. Drop a live update whose
  // revision is older than the last-applied revision. Guards against the
  // theoretical concurrent-PUT out-of-order fan-out; self-corrects via
  // pins.snapshot on the next reconnect. Equal revision is allowed through
  // (idempotent re-adopt of the same doc).
  if (doc.revision < serverRevision()) {
    log.warn("pins", "dropping stale pins.updated (revision regression)", {
      got: doc.revision,
      have: serverRevision(),
    });
    return;
  }
  adoptServerDoc(doc);
}

// runMigration — the one-shot legacy→server seed claim. PUT {baseRevision: 0,
// initializeOnly: true, orderedSessionIds: seed}. On 200 this browser won (adopt
// the confirmed doc). On 409 another browser won (adopt theirs, discard seed).
// On network/other error the optimistic seed stays in place; the server remains
// uninitialized and a later pin/unpin (regular PUT) or the next session will
// initialize it.
async function runMigration(seed: string[]): Promise<void> {
  incPending();
  try {
    const res = await putPins(0, seed, { initializeOnly: true });
    if ((res.status === 200 || res.status === 409) && res.doc) {
      adoptPutResponse(res.doc);
      return;
    }
    setPinsErrorSig(res.status === 0 ? "pin-network" : "pin-error");
  } finally {
    decPending();
  }
}

// === Membership intent (pin / unpin) =========================================
// The user's goal, captured at click time, re-appliable to whatever the
// authoritative state is at PUT-issue / retry time.
type MembershipIntent = { kind: "pin" | "unpin"; id: string };
function applyMembershipIntent(intent: MembershipIntent, order: string[]): string[] {
  if (intent.kind === "pin") {
    return order.includes(intent.id) ? order : [...order, intent.id];
  }
  return order.filter((x) => x !== intent.id);
}

// performMembershipMutation — one bounded 409 retry for pin/unpin, PLUS a
// one-shot 400 self-heal when the server reports unknown (stale/archived) ids.
// On the first 409: adopt the returned authoritative doc, recompute the SAME
// explicit intent against it, retry once. On a second 409: adopt authoritative,
// stop, surface. If the post-adopt recomputation shows the intent is already
// satisfied (e.g. a concurrent change did it), no retry PUT is issued.
//
// 400 self-heal (stale-pinned-id repro): a stale id left in serverOrder bricks
// the full Replace. On a 400 carrying unknownIds, drop those ids from the
// AUTHORITATIVE base (baseOrder minus dropped — NOT the optimistic target, so a
// pin/unpin whose optimistic write already moved the id is re-applied fresh and
// actually reaches the server), recompute the SAME intent against the cleaned
// base, and retry ONCE at the SAME base revision (a 400 did not advance the
// server doc). On 200 → adopt. On any further failure → roll back to the
// cleaned base (the stale drop is a permanent local correction; the optimistic
// intent is what rolls back) + surface. Bounded: exactly one retry.
async function performMembershipMutation(intent: MembershipIntent): Promise<void> {
  incPending();
  const baseOrder = serverOrder();
  const baseRev = serverRevision(); // rollback guard baseline for the first attempt
  try {
    const target = applyMembershipIntent(intent, baseOrder);
    if (sameList(target, baseOrder)) return; // already satisfied
    clearPinsErrorSig();
    applyServerOrder(target); // optimistic
    let res = await putPins(baseRev, target);
    if (res.status === 200 && res.doc) {
      adoptPutResponse(res.doc);
      return;
    }
    if (res.status === 409 && res.doc) {
      // Adopt authoritative; this is the rollback baseline for the retry.
      adoptPutResponse(res.doc);
      const adoptedOrder = serverOrder();
      const retryTarget = applyMembershipIntent(intent, adoptedOrder);
      if (sameList(retryTarget, adoptedOrder)) return; // already satisfied post-adopt
      const retryRev = serverRevision(); // rollback guard baseline for the retry
      applyServerOrder(retryTarget); // optimistic retry
      res = await putPins(retryRev, retryTarget);
      if (res.status === 200 && res.doc) {
        adoptPutResponse(res.doc);
        return;
      }
      if (res.status === 409 && res.doc) {
        // Second 409 — stop, surface. Authoritative is already adopted.
        adoptPutResponse(res.doc);
        setPinsErrorSig("pin-conflict");
        return;
      }
      // Retry failed (non-409): roll back to the adopted authoritative, but
      // only if no fresher frame landed during the retry round-trip.
      rollbackOrderIfUnchanged(adoptedOrder, retryRev);
      setPinsErrorSig(res.status === 0 ? "pin-network" : "pin-error");
      return;
    }
    // 400 self-heal: server reports newly-added ids not active on this worker
    // (a stale/archived id left in serverOrder). Drop them from the base,
    // recompute the SAME intent, retry ONCE at the SAME base revision.
    if (res.status === 400 && res.unknownIds && res.unknownIds.length > 0) {
      const drop = new Set(res.unknownIds);
      // Cleaned BASE (not optimistic target): re-apply the intent fresh so a
      // pin/unpin actually reaches the server instead of looking satisfied.
      const cleanedBase = baseOrder.filter((id) => !drop.has(id));
      // The stale-id drop is a DURABLE local correction — shadow it to the
      // legacy keys (rollback compat) so a reconnect/rollback cannot resurrect
      // the dropped id, matching dropPinnedSession. The success path below
      // (adoptPutResponse → adoptServerDoc) overwrites this with the confirmed
      // doc; the failure path leaves the cleaned shadow in place.
      if (!sameList(cleanedBase, baseOrder)) writeLegacyShadow(cleanedBase);
      const retryTarget = applyMembershipIntent(intent, cleanedBase);
      if (sameList(retryTarget, cleanedBase)) {
        // Intent is a no-op against the cleaned base (e.g. unpin the stale id
        // itself). Adopt the cleaned base locally; no retry PUT needed. The
        // stale drop is the durable correction.
        applyServerOrder(cleanedBase);
        return;
      }
      applyServerOrder(retryTarget); // optimistic retry (replaces the stale optimistic)
      const retryRes = await putPins(baseRev, retryTarget); // SAME base rev (400 did not advance)
      if (retryRes.status === 200 && retryRes.doc) {
        adoptPutResponse(retryRes.doc);
        return;
      }
      if (retryRes.status === 409 && retryRes.doc) {
        // Concurrent change won — adopt authoritative, surface conflict.
        adoptPutResponse(retryRes.doc);
        setPinsErrorSig("pin-conflict");
        return;
      }
      // Retry failed: roll the optimistic back to the cleaned base (the stale
      // drop stays — it is a permanent local correction), but only if no
      // fresher frame landed during the retry round-trip. serverRevision is
      // still baseRev (a 400 did not advance the doc), so the guard works.
      rollbackOrderIfUnchanged(cleanedBase, baseRev);
      setPinsErrorSig(retryRes.status === 0 ? "pin-network" : "pin-error");
      return;
    }
    // First attempt non-200/non-409/non-400-with-unknownIds failure (e.g. a
    // 400 without unknownIds, or 404/500): roll back the optimistic to the
    // pre-state, but only if no fresher frame landed during the first PUT.
    rollbackOrderIfUnchanged(baseOrder, baseRev);
    setPinsErrorSig(res.status === 0 ? "pin-network" : "pin-error");
  } finally {
    decPending();
  }
}

// performReorder — reorder intent. On 409: discard the optimistic ordering,
// adopt the authoritative doc, do NOT auto-replay (require the user to repeat).
// On a 400 carrying unknownIds (stale/archived id in serverOrder): drop those
// ids from the base, recompute the SAME reorder against the cleaned base, retry
// ONCE at the SAME base revision (bounded — mirrors performMembershipMutation's
// 400 self-heal).
async function performReorder(
  draggedId: string,
  targetId: string,
  pos: "before" | "after",
): Promise<void> {
  incPending();
  const baseOrder = serverOrder();
  const baseRev = serverRevision(); // rollback guard baseline
  try {
    const target = reorderRelative(baseOrder, draggedId, targetId, pos);
    if (sameList(target, baseOrder)) return; // no-op (e.g. dragged === target)
    clearPinsErrorSig();
    applyServerOrder(target); // optimistic
    const res = await putPins(baseRev, target);
    if (res.status === 200 && res.doc) {
      adoptPutResponse(res.doc);
      return;
    }
    if (res.status === 409 && res.doc) {
      // Discard optimistic, adopt authoritative. No auto-replay.
      adoptPutResponse(res.doc);
      setPinsErrorSig("pin-conflict");
      return;
    }
    // 400 self-heal: drop stale ids, recompute the reorder, retry once.
    if (res.status === 400 && res.unknownIds && res.unknownIds.length > 0) {
      const drop = new Set(res.unknownIds);
      const cleanedBase = baseOrder.filter((id) => !drop.has(id));
      // Durable local correction — shadow the cleaned order (rollback compat),
      // matching dropPinnedSession. Success overwrites via adoptPutResponse.
      if (!sameList(cleanedBase, baseOrder)) writeLegacyShadow(cleanedBase);
      // If the dragged id itself is stale, the reorder is moot — adopt the
      // cleaned base and stop (can't reorder a deleted session).
      if (drop.has(draggedId)) {
        applyServerOrder(cleanedBase);
        return;
      }
      const retryTarget = reorderRelative(cleanedBase, draggedId, targetId, pos);
      if (sameList(retryTarget, cleanedBase)) {
        // targetId was stale (absent from cleanedBase) → reorder is a no-op.
        applyServerOrder(cleanedBase);
        return;
      }
      applyServerOrder(retryTarget); // optimistic retry
      const retryRes = await putPins(baseRev, retryTarget); // SAME base rev
      if (retryRes.status === 200 && retryRes.doc) {
        adoptPutResponse(retryRes.doc);
        return;
      }
      if (retryRes.status === 409 && retryRes.doc) {
        adoptPutResponse(retryRes.doc);
        setPinsErrorSig("pin-conflict");
        return;
      }
      rollbackOrderIfUnchanged(cleanedBase, baseRev);
      setPinsErrorSig(retryRes.status === 0 ? "pin-network" : "pin-error");
      return;
    }
    // Network/other: roll back the optimistic to the pre-state, but only if no
    // fresher frame landed during the PUT round-trip.
    rollbackOrderIfUnchanged(baseOrder, baseRev);
    setPinsErrorSig(res.status === 0 ? "pin-network" : "pin-error");
  } finally {
    decPending();
  }
}

// === Legacy action implementations (verbatim old behavior) ==================
function legacyTogglePin(id: string): void {
  const cur = legacyPinnedSet();
  if (cur.has(id)) {
    // Unpin: drop from BOTH membership and order so a later re-pin appends fresh.
    const nextSet = new Set(cur);
    nextSet.delete(id);
    legacyPersistPinned(nextSet);
    legacyPersistOrder(legacyOrderArr().filter((x) => x !== id));
  } else {
    // Pin: reconcile-then-append (drops any stale entry for id, then appends it
    // last). Reads the NEW set (just persisted) against the OLD order, mirroring
    // the historical togglePin exactly.
    const nextSet = new Set(cur);
    nextSet.add(id);
    legacyPersistPinned(nextSet);
    legacyPersistOrder([
      ...reconcileLegacyOrder(legacyPinnedSet(), legacyOrderArr()).filter((x) => x !== id),
      id,
    ]);
  }
}

function legacyMovePinnedTo(draggedId: string, targetId: string, pos: "before" | "after"): void {
  const order = reconcileLegacyOrder(legacyPinnedSet(), legacyOrderArr());
  const next = reorderRelative(order, draggedId, targetId, pos);
  const changed = next.length !== order.length || next.some((id, i) => id !== order[i]);
  if (changed) legacyPersistOrder(next);
}

function legacyMovePinnedByOffset(id: string, delta: -1 | 1): void {
  const order = reconcileLegacyOrder(legacyPinnedSet(), legacyOrderArr());
  const i = order.indexOf(id);
  if (i < 0) return;
  const neighbor = order[i + delta];
  if (!neighbor) return; // clamped at the boundary
  legacyMovePinnedTo(id, neighbor, delta < 0 ? "before" : "after");
}

// === Public async actions (branch on mode) ==================================
// dropPinnedSession — LOCAL correction called from the session.delete / prune
// path when a session is archived or deleted. In server mode it removes the id
// from serverOrder immediately (no PUT — the server's pin-lifecycle removes it
// from the server doc on archive and fans out pins.updated; this drop is the
// eager client-side eviction so the stale id does not linger in serverOrder
// and brick the next pin operation via the anti-resurrection guard). The S2
// 400 self-heal remains the durable backstop for any path that misses this
// drop. No-op in legacy mode (the legacy path owns its own removal).
//
// Shadows the corrected order to the legacy keys (rollback compat) so a
// reconnect never resurrects the dropped id via the legacy seed.
export function dropPinnedSession(id: string): void {
  if (pinsMode() !== "server") return; // no-op in legacy mode
  const cur = serverOrder();
  if (!cur.includes(id)) return; // not pinned — nothing to drop
  const next = cur.filter((x) => x !== id);
  applyServerOrder(next);
  writeLegacyShadow(next);
}

export async function togglePin(id: string): Promise<void> {
  if (pinsMode() === "server") {
    const currentlyPinned = serverOrder().includes(id);
    const intent: MembershipIntent = { kind: currentlyPinned ? "unpin" : "pin", id };
    await performMembershipMutation(intent);
    return;
  }
  legacyTogglePin(id);
}

export async function movePinnedTo(
  draggedId: string,
  targetId: string,
  pos: "before" | "after",
): Promise<void> {
  if (pinsMode() === "server") {
    await performReorder(draggedId, targetId, pos);
    return;
  }
  legacyMovePinnedTo(draggedId, targetId, pos);
}

// Keyboard-accessible reorder for pinned ROOT sessions — the a11y fallback for
// the pointer-only drag handle. Move `id` one slot toward a neighbor. Inert at
// the boundary being pushed past and when id is absent from the order.
export async function movePinnedByOffset(id: string, delta: -1 | 1): Promise<void> {
  if (pinsMode() === "server") {
    const order = serverOrder();
    const i = order.indexOf(id);
    if (i < 0) return;
    const neighbor = order[i + delta];
    if (!neighbor) return; // clamped at the boundary
    await performReorder(id, neighbor, delta < 0 ? "before" : "after");
    return;
  }
  legacyMovePinnedByOffset(id, delta);
}

// Test-only: reset ALL pin signals from localStorage so cases don't leak state
// across each other. Resets both the legacy path (re-hydrate from localStorage)
// and the server path (mode→legacy, order/revision/initialized cleared,
// migration guard reset).
export function __resetPinnedForTest(): void {
  batch(() => {
    setLegacyPinnedSet(new Set(loadVersioned<string[]>(LS_PINNED, 1, [], coerceStringArray)));
    setLegacyOrderArr(loadVersioned<string[]>(LS_ORDER, 1, [], coerceStringArray));
    setServerOrder([]);
    setServerRevision(0);
    setServerInitialized(false);
    setPinsMode("legacy");
    setPinsPendingSig(false);
    setPinsErrorSig(null);
  });
  migrationAttempted = false;
  pendingCount = 0;
}
