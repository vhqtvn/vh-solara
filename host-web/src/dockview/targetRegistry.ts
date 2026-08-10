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
 * The registry: a list of TabRecords (deduped by targetKey) in STABLE
 * INSERTION ORDER (decision #1). New tabs APPEND to the end; a re-visit
 * updates `lastVisitedAt` + the active target but does NOT move the record.
 * This is what stops the "tabs jump positions on re-visit" defect the
 * operator reported: the visible order never changes from a status-only or
 * re-select update.
 *
 * `lastVisitedAt` is retained ONLY for cap-eviction (LRU at the 20-unpinned
 * cap) and age retirement (7-day) — NOT for visible reorder. The Tabstrip
 * renders this list as-is.
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
 *  (a stale/malformed blob is rejected wholesale → empty registry).
 *
 *  `titleSource` is OPTIONAL (backward-compat with v1 blobs written before the
 *  source-precedence fix): an absent field is loaded as `"fallback"`. */
interface PersistedTargets {
  v: 1;
  records: Array<{
    target: { serverId: string; dir: string; session: string };
    title: string;
    lastVisitedAt: number;
    pinned: boolean;
    titleSource?: "fallback" | "session";
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
    // titleSource is optional + bounded; absent/malformed → "fallback".
    let titleSource: "fallback" | "session" = "fallback";
    if (e.titleSource === "fallback" || e.titleSource === "session") {
      titleSource = e.titleSource;
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
      titleSource,
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
      titleSource: r.titleSource ?? "fallback",
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
 *  records are exempt. The just-inserted/revisited record is never the LRU
 *  victim (its lastVisitedAt is `now`). NOTE: this evicts BY lastVisitedAt, NOT
 *  by array position — the visible order is STABLE insertion order (decision
 *  #1), so LRU here means "drop the unpinned record with the smallest
 *  lastVisitedAt", wherever it sits in the list. */
function enforceUnpinnedCap(list: TabRecord[]): void {
  let unpinned = list.reduce((n, r) => (r.pinned ? n : n + 1), 0);
  if (unpinned <= UNPINNED_CAP) return;
  // Evict the unpinned record(s) with the smallest lastVisitedAt until the
  // unpinned count is within cap. Splice by index (highest first so earlier
  // indices stay valid), choosing the current min each iteration.
  while (unpinned > UNPINNED_CAP) {
    let victimIdx = -1;
    let victimTs = Number.POSITIVE_INFINITY;
    for (let i = 0; i < list.length; i++) {
      if (list[i].pinned) continue;
      if (list[i].lastVisitedAt < victimTs) {
        victimTs = list[i].lastVisitedAt;
        victimIdx = i;
      }
    }
    if (victimIdx < 0) break; // no unpinned left (shouldn't happen)
    list.splice(victimIdx, 1);
    unpinned--;
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
 * Upsert a target as a visited tab. Dedupes by exact (serverId,dir,session).
 * STABLE INSERTION ORDER (decision #1): on first visit, the record APPENDS to
 * the end of the list; on re-visit, `lastVisitedAt` is updated + the record is
 * set as the active target, but the record is NOT moved (its position is
 * preserved — no tab jumps). Enforces age retirement + the unpinned cap
 * (LRU-evict by lastVisitedAt) on every call. Persists via a debounced save.
 *
 * TITLE SOURCE-PRECEDENCE (decision #2): the `title` arg here is the PANE
 * title (titleFor(paneId)) — a document/page label, NOT a session status title.
 * It is FALLBACK-TIER only: a fresh record starts titleSource="fallback"
 * (title = the pane title if supplied, else the server host). A re-visit may
 * refresh the fallback label value (the pane title may have improved) while
 * still "fallback". The ONLY promotion to "session" (pinned) happens in
 * applyLiveStatus, when the first non-empty SESSION STATUS title arrives.
 * Once "session", the title is never touched here. This is the fix for the
 * "server label does nothing" defect: the server/pane label is the fallback
 * shown until a real session title arrives, then the session title wins
 * permanently (no flicker, no re-clobber by later status ticks).
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
    // TITLE PRECEDENCE: a re-visit's `title` (pane title) refreshes the FALLBACK
    // label value ONLY while titleSource is still "fallback". Once "session"
    // (pinned by applyLiveStatus), the visit title is IGNORED — a pinned session
    // title is never clobbered by a pane/server label.
    const isFallback = (existing.titleSource ?? "fallback") === "fallback";
    const refreshFallback = isFallback && !!title && title.length > 0;
    const refreshed: TabRecord = {
      target: existing.target, // keep referential target identity
      title: refreshFallback ? title! : existing.title,
      titleSource: existing.titleSource ?? "fallback",
      lastVisitedAt: now, // LRU for cap-eviction + age retirement (NOT for reorder)
      pinned: existing.pinned,
      liveStatus: existing.liveStatus, // preserve last-known live status
    };
    // STABLE ORDER: update IN PLACE — do NOT move the record. This is the fix
    // for the "tabs jump positions on re-visit" defect.
    updated = list.slice();
    updated[existingIdx] = refreshed;
  } else {
    // First visit: new record APPENDED at the end, unpinned. titleSource is
    // ALWAYS "fallback" here (the pane/server label is fallback-tier; only a
    // session status title — applyLiveStatus — promotes to "session").
    const rec: TabRecord = {
      target,
      title: title && title.length > 0 ? title : fallbackTitle(target),
      titleSource: "fallback",
      lastVisitedAt: now,
      pinned: false,
    };
    updated = [...list, rec];
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
  // TITLE SOURCE-PRECEDENCE (decision #2): adopt the session title from a
  // status tick ONLY while the source is still "fallback" AND the tick carries
  // a non-empty title — then PIN it ("session"). Once "session", the title is
  // NEVER replaced by a status tick (this is the fix for the "server label
  // does nothing" defect: previously EVERY non-empty status.title overwrote
  // the tab title, so a session title clobbered the server label and then got
  // re-clobbered by each later tick — flicker). An empty status title cannot
  // clear a pinned title. The server label (catalog/pane context) is the
  // fallback only until a real session title arrives; after that the session
  // title wins permanently.
  const wasFallback = (prev.titleSource ?? "fallback") === "fallback";
  const adoptTitle = wasFallback && !!status.title && status.title.length > 0;
  next[idx] = {
    ...prev,
    liveStatus: status,
    title: adoptTitle ? status.title : prev.title,
    titleSource: adoptTitle ? "session" : (prev.titleSource ?? "fallback"),
  };
  setRecords(next);
  // PERSISTENCE: liveStatus itself is runtime-only (stripped on save), so a
  // status-only tick needs no save. BUT when this tick PROMOTED the title
  // source (fallback → session pin), the durable `title` + `titleSource`
  // fields changed — persist so a reload before the next registry mutation
  // does NOT revert the pinned session title to the fallback server label.
  // (Decision #2 completeness: "Never replace a session title with fallback"
  // must hold across a cold reload, not only across later mutations.)
  if (adoptTitle) scheduleTargetSave();
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
