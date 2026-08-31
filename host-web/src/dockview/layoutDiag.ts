// =============================================================================
// LAYOUT DIAGNOSTICS — a bounded, always-on event ring persisted at
// localStorage["vh-host:layout:diag"].
//
// WHY (2026-08-31 diagnosis-first slice): the PWA relaunch layout loss is STILL
// reproducible on the operator's real Android device after the flush-on-hide
// fix (c557b1b), but NOT headlessly — the headless kill/relaunch proxy passes.
// The device diverges somewhere we cannot observe from here (origin/start_url
// divergence, a storage partition, a read source we do not expect, or a kill
// path that beats every flush anchor). Rather than guess again, the persistence
// module now records a tiny fingerprint of every load-bearing transition, so
// ONE on-device reproduction (relaunch → Settings → "Copy layout diagnostics" →
// paste back) pins down which transition diverged.
//
// CONTRACT (load-bearing — never violate):
//   • The diag must NEVER break persistence. Every entry point is try/catch'd;
//     a throwing diag is a silent no-op. Ring hydration treats corrupt storage
//     as an empty ring (fresh start), never a throw.
//   • ALWAYS-ON in production (not DEV-gated) — the whole point is capturing
//     the operator's production PWA relaunch. Only the window.__hostLayoutDiag
//     TEST bridge below is DEV-gated (same convention as __hostProportions /
//     __hostViewport — absent in prod, asserted by the preview e2e).
//   • TINY: ring-capped at the last 30 events, persisted as one small JSON
//     array; each record is a handful of numbers/short strings. No timestamps
//     formatting, no PII beyond origin + a 120-char href prefix (the
//     operator's own server URL).
//
// EVENT KINDS (see layoutPersistence.ts for the emitters):
//   read  — module-init blob read: source actually used (hash|v3|v2|none),
//           workspace count, origin, href prefix, standalone display mode.
//           Catches origin/start_url divergence: a DIFFERENT origin has
//           DIFFERENT localStorage.
//   seed  — the default workspace was seeded (the reset symptom's fingerprint:
//           a relaunch that re-seeded when it should have restored). Carries
//           what the init read found, so "seeded despite a blob" vs "no blob"
//           is distinguishable.
//   flush — every completed flushSave: trigger (debounce|hide|pagehide|freeze),
//           written byte length, workspace count, active workspace id.
//   clear — the layout keys were removed (state emptied).
//
// (A `sched` event kind was considered and deliberately SKIPPED: onDidLayoutChange
// fires in bursts during sash drags and would flood the 30-slot ring within one
// gesture, evicting exactly the load-bearing events the ring exists to keep.
// Debounce coalescing is instead proven by the e2e setItem spy.)
// =============================================================================

/** Versioned + namespaced storage key (distinct from the layout blob keys). */
export const DIAG_STORAGE_KEY = "vh-host:layout:diag";

/** Ring cap: keep the LAST N events (drop oldest). */
export const DIAG_RING_CAP = 30;

/** The closed set of event kinds (structural guard for hydrated records). */
export type LayoutDiagKind = "read" | "flush" | "seed" | "clear";

export interface LayoutDiagEvent {
  /** Wall-clock ms (Date.now) — enough to order events, no formatting. */
  t: number;
  kind: LayoutDiagKind;
  /** Kind-specific fields (source/trigger/ws/bytes/origin/href/…). */
  [field: string]: unknown;
}

function isLayoutDiagKind(v: unknown): v is LayoutDiagKind {
  return v === "read" || v === "flush" || v === "seed" || v === "clear";
}

/** Structural guard for one hydrated record (untrusted storage). */
function isLayoutDiagEvent(v: unknown): v is LayoutDiagEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.t === "number" && isLayoutDiagKind(o.kind);
}

/** Hydrate the ring from localStorage. Corrupt/absent → empty ring. Never throws. */
function hydrateRing(): LayoutDiagEvent[] {
  try {
    const raw = localStorage.getItem(DIAG_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLayoutDiagEvent).slice(-DIAG_RING_CAP);
  } catch {
    return [];
  }
}

// The in-memory ring is the source of truth for reads (the DEV bridge + the
// Settings copy action); it is re-persisted whole on every record. Hydrated
// ONCE at module init so events survive reloads/relaunches — the ring the
// operator copies after a broken relaunch contains the PREVIOUS session's
// flush events followed by this session's read (and, if it reset, seed).
const ring: LayoutDiagEvent[] = hydrateRing();

/** Persist the whole ring. Never throws. */
function persistRing(): void {
  try {
    localStorage.setItem(DIAG_STORAGE_KEY, JSON.stringify(ring));
  } catch {
    // localStorage unavailable / quota — swallow; diag is best-effort.
  }
}

/**
 * Append one event to the ring (dropping the oldest past the cap) and persist.
 * `fields` runs INSIDE the try so a throwing field accessor (e.g. matchMedia in
 * a exotic environment) can never break the persistence caller. Silent no-op
 * on any failure — the diag must never take the layout save path down.
 */
export function recordLayoutDiag(
  kind: LayoutDiagKind,
  fields: () => Record<string, unknown>,
): void {
  try {
    ring.push({ t: Date.now(), kind, ...fields() });
    if (ring.length > DIAG_RING_CAP) {
      ring.splice(0, ring.length - DIAG_RING_CAP);
    }
    persistRing();
  } catch {
    // never break persistence
  }
}

/** A copy of the current ring (oldest→newest). Never throws. */
export function getLayoutDiagRing(): LayoutDiagEvent[] {
  try {
    return ring.slice();
  } catch {
    return [];
  }
}

// ---- DEV bridge (window.__hostLayoutDiag) -----------------------------------
// Unit-grade test surface (host-web has NO vitest; unit asserts run through
// page.evaluate — the repo's established pattern for host-web logic, see
// proportions.ts). DEV-gated like __host / __hostProportions / __hostViewport /
// __hostKbdFocus / __hostAttention; absent in prod (the preview e2e asserts
// __host*=0 — this bridge follows the same rule).

const DEV_BRIDGE_KEY = "__hostLayoutDiag";

interface LayoutDiagDevBridge {
  /** Current ring (oldest→newest). */
  ring(): LayoutDiagEvent[];
  /** Test hook: push synthetic events (cap + persistence assertions). */
  record(kind: LayoutDiagKind, fields?: Record<string, unknown>): void;
  /** Test hook: empty the ring + remove the storage key. */
  clearRing(): void;
}

/** Install the DEV bridge (idempotent). Exposed for App.tsx (same install
 *  point as the other DEV bridges). */
export function installLayoutDiagDevBridge(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  if (w[DEV_BRIDGE_KEY]) return;
  const bridge: LayoutDiagDevBridge = {
    ring: (): LayoutDiagEvent[] => getLayoutDiagRing(),
    record: (kind: LayoutDiagKind, fields?: Record<string, unknown>): void => {
      recordLayoutDiag(kind, () => fields ?? {});
    },
    clearRing: (): void => {
      try {
        ring.length = 0;
        localStorage.removeItem(DIAG_STORAGE_KEY);
      } catch {
        // never throw from a test hook
      }
    },
  };
  w[DEV_BRIDGE_KEY] = bridge;
}
