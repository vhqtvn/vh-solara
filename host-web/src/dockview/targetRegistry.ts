// =============================================================================
// P4 attention-target registry (host state).
//
// The operator's unit of attention is a SESSION, not a workspace. This module
// keeps a registry of intentionally-visited AttentionTarget records (Fork B —
// explicit-watch): a session becomes a tab ONLY when the operator opens/selects
// it. There is NO auto-enumeration of server sessions and NO server-wide roster
// — never-visited sessions, even needy ones, do NOT surface. That is intentional
// (a future enumeration bridge is out of scope for P4).
//
// This state is NEW and SEPARATE from statusByPane (which is latest-per-pane and
// overwrites on navigate — it is NOT repurposed as the registry). The registry
// dedupes by exact (serverId,dir,session) and is the source for the flat
// tabstrip (Tabstrip.tsx).
//
// SERVER IDENTITY: `serverId` is the pane's bound server origin
// (configuredOriginFor(paneId)), DERIVED from the pane/server binding. It is
// NEVER sender-claimed — an inbound status/route message carries dir+session but
// no trustworthy server id; the server is implied by the pane the message came
// from (same trust model as the P1 status bridge). Callers pass the pane's bound
// origin as serverId.
//
// HONEST STATUS (load-bearing invariant): `liveStatus` on a record is the
// LAST-KNOWN PaneStatus. It is honest as CURRENT attention ONLY while a live pane
// is reporting this exact target (isLive(target)). When the pane navigates away
// the record stops being live; the tab MUST NOT show a needs-you badge then —
// it shows the last-known status dimmed/stale. This prevents a stale
// needs_reply/needs_permission from masquerading as current attention on a
// target no pane is reporting. See `livePaneTarget` + `liveKeys`.
//
// PERSISTENCE: durable fields {target, title, lastVisitedAt, pinned} persist
// under a versioned localStorage key (cold-only restore at module init,
// debounced save on mutation — mirrors layoutPersistence.ts). `liveStatus` is
// runtime-only and stripped on save, so a stale needs-you can never survive a
// reload. There is NO URL-hash mirror (unlike layout, targets are not per-tab
// URL state).
// =============================================================================

import { createSignal } from "solid-js";
import type { AttentionTarget, PaneStatus, TabRecord } from "./types";

// ---- caps + age retirement (settled constants) -----------------------------

/** Maximum UNPINNED records. Beyond this, the least-recently-visited unpinned
 *  record is LRU-evicted on insert. Pinned records are exempt from this cap. */
const UNPINNED_CAP = 20;
/** Maximum PINNED records. A pin beyond this is REFUSED (returns false) — pins
 *  are NEVER silently evicted (the operator chose to keep them). */
const PINNED_CAP = 10;
/** Unpinned records older than this are retired (evicted) on host startup and
 *  on every registry mutation. 7 days. */
const AGE_RETIREMENT_MS = 7 * 24 * 60 * 60 * 1000;

// ---- target key (dedup identity) -------------------------------------------

/** Stable string key for exact (serverId,dir,session) dedup. The separator is
 *  not expected in any field (origins are URLs, dirs/session are path-like);
 *  the key is internal-only (never persisted as a field — the target object is
 *  persisted in full). */
export function targetKey(t: AttentionTarget): string {
  return `${t.serverId}\u0000${t.dir}\u0000${t.session}`;
}

/** Build a target key from raw fields (avoids allocating an object for lookups
 *  in hot paths). Same encoding as targetKey(). */
function keyOf(serverId: string, dir: string, session: string): string {
  return `${serverId}\u0000${dir}\u0000${session}`;
}

// ---- reactive state ---------------------------------------------------------

/**
 * The registry: a list of TabRecords (deduped by targetKey). Ordered
 * most-recently-visited first (inserts + revisits move to front), with pinned
 * records kept ahead of unpinned within the same recency bucket is NOT done —
 * the order is pure LRU (lastVisitedAt desc). The Tabstrip renders this list
 * as-is; stable order = no tab shuffle on a status-only update.
 */
const [records, setRecords] = createSignal<TabRecord[]>([]);
export { records };

/**
 * The currently-active target (the tab that is highlighted + the session the
 * operator is currently focused on). Set on visit() and on tab-select. Drives
 * the active-tab highlight in the Tabstrip. Persisted indirectly: the active
 * target is whatever the operator last visited, and on a cold reload the
 * most-recently-visited record is the natural active candidate (the Tabstrip
 * also re-derives activity from pane focus). Not separately persisted to keep
 * the surface minimal.
 */
const [activeTarget, setActiveTarget] = createSignal<AttentionTarget | null>(null);
export { activeTarget };

/**
 * In-memory map: paneId → the target that pane is CURRENTLY reporting (from its
 * latest accepted status message). NON-PERSISTED. This is the source for the
 * honest-status liveness check: a record is "live" iff some pane currently
 * reports its exact target. When a pane navigates away (a new status with a
 * different dir/session) or unregisters, its entry here changes/is deleted, and
 * the previously-reported target stops being live (its record keeps last-known
 * liveStatus but loses the live badge).
 */
const livePaneTarget = new Map<string, AttentionTarget>();

/**
 * Reactive mirror of `livePaneTarget` values: the set of targetKeys that at
 * least one live pane currently reports. The Tabstrip reads this to decide
 * whether a record's liveStatus is CURRENT (show badge) or stale (show dimmed).
 * Updated on every applyLiveStatus call.
 */
const [liveKeys, setLiveKeys] = createSignal<Set<string>>(new Set());
export { liveKeys };

/**
 * True iff at least one live pane currently reports this exact target. Reads
 * the reactive `liveKeys()` signal so callers in a tracking scope re-evaluate
 * when liveness changes. This is the honest-status gate: a needs-you badge may
 * show ONLY when this is true AND the record's last-known liveStatus.attention
 * is needs_reply/needs_permission.
 */
export function isLive(t: AttentionTarget): boolean {
  return liveKeys().has(targetKey(t));
}

// ---- persistence (cold-only restore + debounced save) ----------------------
// Mirrors layoutPersistence.ts: a versioned localStorage key, read + validated
// ONCE at module init (cold-only), debounced writes on mutation. NO URL-hash
// mirror (targets are not per-tab-URL state). liveStatus is stripped (runtime).

/** Versioned + namespaced storage key. v1 is the initial P4 schema. */
const TARGETS_STORAGE_KEY = "vh-host:targets:v1";
const TARGET_SAVE_DEBOUNCE_MS = 450;

/** Durable persisted shape. `liveStatus` is deliberately absent (runtime-only).
 *  The envelope carries a `v` tag so a future schema bump can fall back cleanly
 *  (a stale/malformed blob is rejected wholesale → empty registry). */
interface PersistedTargets {
  v: 1;
  records: Array<{
    target: { serverId: string; dir: string; session: string };
    title: string;
    lastVisitedAt: number;
    pinned: boolean;
  }>;
}

/** Read + parse + validate the blob ONCE at module init (cold-only). */
function readTargetBlob(): TabRecord[] {
  if (typeof localStorage === "undefined") return [];
  let raw: string | null;
  try {
    raw = localStorage.getItem(TARGETS_STORAGE_KEY);
  } catch {
    return []; // localStorage unavailable (private mode / quota) → empty registry
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // corrupt JSON → treat as no blob → empty registry
  }
  return validatePersistedTargets(parsed);
}

/** Structural guard. A malformed envelope is rejected wholesale (empty registry)
 *  rather than partially recovered — same conservative policy as
 *  layoutPersistence.validatePersistedState. */
function validatePersistedTargets(v: unknown): TabRecord[] {
  if (typeof v !== "object" || v === null) return [];
  const o = v as Record<string, unknown>;
  if (o.v !== 1) return [];
  if (!Array.isArray(o.records)) return [];
  const out: TabRecord[] = [];
  const seen = new Set<string>(); // dedup at load (defense-in-depth)
  for (const entry of o.records) {
    if (typeof entry !== "object" || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const tg = e.target;
    if (typeof tg !== "object" || tg === null) return [];
    const t = tg as Record<string, unknown>;
    if (
      typeof t.serverId !== "string" ||
      typeof t.dir !== "string" ||
      typeof t.session !== "string" ||
      typeof e.title !== "string" ||
      typeof e.lastVisitedAt !== "number" ||
      typeof e.pinned !== "boolean"
    ) {
      return [];
    }
    const target: AttentionTarget = {
      serverId: t.serverId,
      dir: t.dir,
      session: t.session,
    };
    const k = targetKey(target);
    if (seen.has(k)) continue; // dedup a duplicate in the blob
    seen.add(k);
    out.push({
      target,
      title: e.title,
      lastVisitedAt: e.lastVisitedAt,
      pinned: e.pinned,
      // liveStatus is deliberately NOT loaded (runtime-only).
    });
  }
  return out;
}

// ---- debounced save (MUST be defined before coldLoad, which may call it) ----
// coldLoad() runs at module init + may call scheduleTargetSave() when age
// retirement fires. Declaring `let saveTimer` here (before coldLoad) avoids a
// temporal-dead-zone ReferenceError at boot when an aged blob triggers a save.

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Request a debounced save of the registry. Idempotent under rapid calls
 *  (coalesces into one write). Strips liveStatus (runtime-only). */
export function scheduleTargetSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushTargetSave, TARGET_SAVE_DEBOUNCE_MS);
}

function flushTargetSave(): void {
  saveTimer = null;
  if (typeof localStorage === "undefined") return;
  const list = records();
  if (list.length === 0) {
    try {
      localStorage.removeItem(TARGETS_STORAGE_KEY);
    } catch {
      // swallow (quota / private mode)
    }
    return;
  }
  const payload: PersistedTargets = {
    v: 1,
    records: list.map((r) => ({
      target: {
        serverId: r.target.serverId,
        dir: r.target.dir,
        session: r.target.session,
      },
      title: r.title,
      lastVisitedAt: r.lastVisitedAt,
      pinned: r.pinned,
    })),
  };
  try {
    localStorage.setItem(TARGETS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage unavailable / quota exceeded / private mode — swallow. The
    // registry stays in-memory; the next mutation re-attempts a debounced save.
  }
}

// ---- age retirement + cap enforcement (MUST be before coldLoad) ------------
// coldLoad() calls retireAged at boot; declare these before the coldLoad call.

/** Evict unpinned records older than AGE_RETIREMENT_MS. Returns the same array
 *  reference if nothing was retired (so the caller can skip a needless signal
 *  update), or a new filtered array otherwise. Evaluated on cold load + on
 *  every registry mutation. Pinned records are NEVER aged out (the operator
 *  chose to keep them indefinitely). */
function retireAged(list: TabRecord[], now: number): TabRecord[] {
  const cutoff = now - AGE_RETIREMENT_MS;
  let changed = false;
  const out = list.filter((r) => {
    if (r.pinned) return true; // pins are exempt from age retirement
    if (r.lastVisitedAt < cutoff) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? out : list;
}

/** Enforce the unpinned cap (LRU-evict the least-recently-visited unpinned).
 *  Mutates the array in place (the caller has just built a fresh list). Pinned
 *  records are exempt. The just-inserted/revisited record is most-recent so it
 *  is never the LRU victim. */
function enforceUnpinnedCap(list: TabRecord[]): void {
  // list is ordered most-recent-first. Walk from the END (least-recent) and
  // drop unpinned records until the unpinned count is within cap.
  let unpinned = list.reduce((n, r) => (r.pinned ? n : n + 1), 0);
  if (unpinned <= UNPINNED_CAP) return;
  for (let i = list.length - 1; i >= 0 && unpinned > UNPINNED_CAP; i--) {
    if (!list[i].pinned) {
      list.splice(i, 1);
      unpinned--;
    }
  }
}

/** Cold-only initial load: read the blob, retire aged unpinned records, set the
 *  initial records signal. Runs exactly once at module init. The age retirement
 *  here is the "on host startup" evaluation required by the spec. */
function coldLoad(): void {
  const loaded = readTargetBlob();
  const retired = retireAged(loaded, Date.now());
  if (retired !== loaded) {
    // Age retirement fired at startup — persist the trimmed registry so the
    // stale records don't re-appear on the next load.
    setRecords(retired);
    scheduleTargetSave();
  } else {
    setRecords(retired);
  }
}
coldLoad();

// ---- liveKeys recompute -----------------------------------------------------

/** Recompute the liveKeys signal from the livePaneTarget map. Called after
 *  every mutation to livePaneTarget so the reactive Tabstrip re-evaluates
 *  liveness. Cheap: builds a small Set from the map's values. */
function recomputeLiveKeys(): void {
  const s = new Set<string>();
  for (const t of livePaneTarget.values()) s.add(targetKey(t));
  setLiveKeys(s);
}

// ---- registry operations ----------------------------------------------------

/**
 * Upsert a target as a visited tab. Dedupes by exact (serverId,dir,session):
 * on re-visit, updates lastVisitedAt + title and moves the record to
 * most-recent (front). On first visit, creates the record at the front. Sets
 * the record as the active target. Enforces age retirement + the unpinned cap
 * (LRU-evict) on every call. Persists via a debounced save.
 *
 * Fork B: this is the ONLY way a never-visited session enters the registry
 * (host-driven selectTarget or an accepted SPA route). No background creation
 * from stream-tree/attention/permissions/questions/unread.
 */
export function visit(target: AttentionTarget, title?: string): void {
  const now = Date.now();
  const k = targetKey(target);
  let list = retireAged(records(), now);
  // Find the existing record (dedup).
  const existingIdx = list.findIndex((r) => targetKey(r.target) === k);
  let updated: TabRecord[];
  if (existingIdx >= 0) {
    const existing = list[existingIdx];
    const refreshed: TabRecord = {
      target: existing.target, // keep referential target identity
      title: title && title.length > 0 ? title : existing.title,
      lastVisitedAt: now,
      pinned: existing.pinned,
      liveStatus: existing.liveStatus, // preserve last-known live status
    };
    // Move to front (most-recent).
    updated = [refreshed, ...list.filter((_, i) => i !== existingIdx)];
  } else {
    // First visit: new record at front, unpinned.
    const rec: TabRecord = {
      target,
      title: title && title.length > 0 ? title : fallbackTitle(target),
      lastVisitedAt: now,
      pinned: false,
    };
    updated = [rec, ...list];
    enforceUnpinnedCap(updated);
  }
  setRecords(updated);
  setActiveTarget(target);
  scheduleTargetSave();
}

/**
 * Remove a record (Phase 3 adds the UI; the mechanic lands now). Idempotent.
 * Does NOT close the pane/session (it's a registry record, not a pane
 * lifecycle). Clears the active target if it was the dismissed one. */
export function dismiss(target: AttentionTarget): void {
  const k = targetKey(target);
  const list = records();
  const next = list.filter((r) => targetKey(r.target) !== k);
  if (next.length === list.length) return; // not found — no-op
  setRecords(next);
  const at = activeTarget();
  if (at && targetKey(at) === k) {
    // Active target dismissed — clear it (the Tabstrip shows no active tab).
    setActiveTarget(null);
  }
  scheduleTargetSave();
}

/**
 * Pin a record. REFUSES (returns false) when the pinned cap is reached — pins
 * are NEVER silently evicted. No-op (returns true) when already pinned or when
 * the target has no record (can't pin a never-visited target — Phase 3 UI will
 * only offer pin on existing tabs). Returns true on success, false on refusal.
 */
export function pin(target: AttentionTarget): boolean {
  const k = targetKey(target);
  const list = records();
  const idx = list.findIndex((r) => targetKey(r.target) === k);
  if (idx < 0) return false; // no record to pin
  if (list[idx].pinned) return true; // already pinned — idempotent success
  const pinnedCount = list.reduce((n, r) => (r.pinned ? n + 1 : n), 0);
  if (pinnedCount >= PINNED_CAP) return false; // REFUSE — cap reached
  const next = list.slice();
  next[idx] = { ...next[idx], pinned: true };
  setRecords(next);
  scheduleTargetSave();
  return true;
}

/** Unpin a record. After unpinning, re-checks the unpinned cap (the newly-
 *  unpinned record might push the unpinned count over cap → LRU-evict). */
export function unpin(target: AttentionTarget): void {
  const k = targetKey(target);
  const list = records();
  const idx = list.findIndex((r) => targetKey(r.target) === k);
  if (idx < 0) return;
  if (!list[idx].pinned) return; // already unpinned — no-op
  const next = list.slice();
  next[idx] = { ...next[idx], pinned: false };
  enforceUnpinnedCap(next);
  setRecords(next);
  scheduleTargetSave();
}

// ---- liveStatus mirroring (called from store.setStatusFor / unregisterPane) -

/**
 * Mirror a pane's current status into the registry's liveness tracking. Called
 * from store.setStatusFor (on an accepted status message) and with status=null
 * from store.unregisterPane (pane gone → its live contribution is withdrawn).
 *
 * `serverId` is the pane's bound origin (configuredOriginFor) — the caller
 * derives it; it is NEVER taken from the message. `status` carries the
 * target's dir+session (the SPA's routing vocabulary).
 *
 * HONEST STATUS: this maintains `livePaneTarget` (paneId → target) + the
 * reactive `liveKeys` set. A record's `liveStatus` field is set to the
 * last-known status (metadata) but is only honest as CURRENT attention while
 * the target is live (isLive). When the pane navigates to a different target,
 * the OLD target's record KEEPS its last-known liveStatus (for dimmed/stale
 * display) but stops being live (loses its badge) — it is NOT cleared, so the
 * operator still sees the last-known state without a false needs-you.
 */
export function applyLiveStatus(
  paneId: string,
  serverId: string | undefined,
  status: PaneStatus | null,
): void {
  if (status === null) {
    // Pane gone (unregistered) — withdraw its live contribution. The record's
    // last-known liveStatus stays (for stale display) unless no other pane
    // reports it; liveness is recomputed from the remaining livePaneTarget map.
    livePaneTarget.delete(paneId);
    recomputeLiveKeys();
    return;
  }
  if (!serverId) return; // no bound origin → cannot derive serverId → skip
  const newTarget: AttentionTarget = {
    serverId,
    dir: status.dir,
    session: status.session,
  };
  const newKey = targetKey(newTarget);
  livePaneTarget.set(paneId, newTarget);
  recomputeLiveKeys();
  // Mirror the status into the matching record's last-known liveStatus (so the
  // tab shows it — live or stale). Only update if a record exists (Fork B: a
  // status for a never-visited target does NOT mint a tab).
  const list = records();
  const idx = list.findIndex((r) => targetKey(r.target) === newKey);
  if (idx < 0) return;
  const prev = list[idx];
  // Avoid a needless signal update when the status is unchanged.
  if (
    prev.liveStatus &&
    prev.liveStatus.attention === status.attention &&
    prev.liveStatus.activity === status.activity &&
    prev.liveStatus.title === status.title
  ) {
    return;
  }
  const next = list.slice();
  next[idx] = {
    ...prev,
    liveStatus: status,
    title: status.title && status.title.length > 0 ? status.title : prev.title,
  };
  setRecords(next);
  // liveStatus is runtime-only — no scheduleTargetSave() (it's stripped on save
  // anyway, so persisting now would be a wasted write).
}

// ---- helpers ----------------------------------------------------------------

/** Fallback tab title when none was supplied on visit. Derives a short label
 *  from the server origin host (the unit the operator recognizes). */
function fallbackTitle(t: AttentionTarget): string {
  try {
    const h = new URL(t.serverId).host;
    return h || t.serverId;
  } catch {
    return t.serverId;
  }
}

// ---- route parsing (SPA route → target) -------------------------------------
// Routes are `?dir=...&session=...` query strings (the SPA's routing vocabulary,
// identical to the route/status/select messages). Returns null when the route
// lacks both dir and session (a non-session view) → not a visitable target.

/** Parse an SPA route string into an AttentionTarget (without serverId) when it
 *  carries both dir+session, else null. The caller supplies the serverId from
 *  the pane binding. Tolerates a leading '?', '#', or bare params. */
export function parseRouteTarget(
  route: string,
): { dir: string; session: string } | null {
  if (typeof route !== "string" || route.length === 0) return null;
  let q = route;
  // Strip a leading '?' or '#' (the route may be a full search/hash fragment).
  // Also tolerate a path-like prefix; URLSearchParams handles the rest.
  const qIdx = q.indexOf("?");
  if (qIdx >= 0) q = q.slice(qIdx + 1);
  const hIdx = q.indexOf("#");
  if (hIdx >= 0) q = q.slice(hIdx + 1);
  const params = new URLSearchParams(q);
  const dir = params.get("dir");
  const session = params.get("session");
  if (!dir || !session) return null;
  return { dir, session };
}

// ---- DEV/TEST-ONLY: clock injection for age-retirement e2e ------------------
// Age retirement (7-day eviction of unpinned records) is otherwise impossible
// to exercise in a fast e2e without waiting a week. This hook lets a DEV-only
// test bridge backdate a record's lastVisitedAt so retireAged() has something
// to evict on the next mutation (or on the next cold load, since it persists).
// It is consumed ONLY by the DEV-only window.__host bridge (absent in prod) —
// the brief explicitly sanctions "a clock-injectable or a forced age in the
// test" for this case. NOT part of the production API surface.

/**
 * TEST-ONLY: set a record's lastVisitedAt to an arbitrary timestamp (used to
 * simulate age for retirement tests). Persists so a subsequent cold load reads
 * the backdated value. No-op when the record does not exist. DEV-only callers.
 */
export function _setRecordVisitedAtForTest(
  target: AttentionTarget,
  ts: number,
): void {
  const k = targetKey(target);
  const list = records();
  const idx = list.findIndex((r) => targetKey(r.target) === k);
  if (idx < 0) return;
  const next = list.slice();
  next[idx] = { ...next[idx], lastVisitedAt: ts };
  setRecords(next);
  scheduleTargetSave();
}
