// =============================================================================
// LAYOUT VALIDATION — the pure structural checks shared by the local
// named-layouts store (namedLayouts.ts), the cold-restore pipeline
// (layoutPersistence.ts), and the server-layouts catalog client
// (state/namedLayoutCatalog.ts).
//
// Extraction note: `coerceTabLayoutEntry` is lifted VERBATIM from the private
// `coerceEntry` tab-branch in namedLayouts.ts (same checks, same fallbacks,
// same null cases — byte-for-byte behavior), and `validateServerLayoutTargets`
// reuses the target-allowlist logic of `validRestoreIds` in
// layoutPersistence.ts. ONE difference by design (F3 hazard H1): a LOCAL
// restore DROPS invalid panes and restores the survivors, while a SERVER
// entry with ANY unallowlisted target is BLOCKED WHOLE — server data is
// untrusted until validated and must never silently open panes.
//
// This module is PURE: no DOM, no fetch, no signals, no module-init side
// effects (safe to import from the TDZ-sensitive layoutPersistence module —
// its init-order comments still hold; nothing here runs at import time).
// =============================================================================

import type { SerializedDockview } from "dockview-core";
import {
  hasRealFleetEnv,
  isFleetEntry,
  resolveBaseFleet,
  type FleetEntry,
} from "../state/mockData";
import type { MasterLayoutEntry, TabLayoutEntry } from "./namedLayouts";
import type { SavedLayout } from "./layoutPersistence";

/**
 * Structural guard for a WELL-FORMED tab-layout entry as it appears on the
 * wire from the server catalog: scope "tab", a non-empty PRE-TRIMMED name, a
 * non-empty tabTitle, a non-null layout object, and a finite savedAt. Stricter
 * than {@link coerceTabLayoutEntry} (which repairs a missing tabTitle by
 * falling back to the name, mirroring the local store's read path) because
 * server entries are validated server-side to the non-empty form before
 * storage — anything else here is a malformed/hostile document.
 */
export function isTabLayoutEntry(obj: unknown): obj is TabLayoutEntry {
  if (typeof obj !== "object" || obj === null) return false;
  const e = obj as Record<string, unknown>;
  if (e.scope !== "tab") return false;
  if (typeof e.name !== "string" || e.name === "" || e.name !== e.name.trim()) {
    return false;
  }
  if (typeof e.tabTitle !== "string" || e.tabTitle.trim() === "") return false;
  if (typeof e.layout !== "object" || e.layout === null) return false;
  if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt)) return false;
  return true;
}

/**
 * Structural guard for ONE tab-scope store value (lifted from the private
 * coerceEntry tab-branch in namedLayouts.ts — behavior identical). `name` is
 * the caller's key for the entry (the local store keys by name; the server
 * entry's own name field is passed by the catalog client). Returns the
 * coerced entry or null (the caller drops the entry — a poison entry never
 * poisons the store/doc). The layout blob stays an opaque object — the
 * cold-restore pipeline re-validates it at consume time. tabTitle falls back
 * to the name when absent/empty (a v2 blob from a future variant that dropped
 * it still loads sensibly). A master-scope (or unknown-scope) value returns
 * null — this coerces TAB entries only.
 */
export function coerceTabLayoutEntry(name: string, v: unknown): TabLayoutEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt)) return null;
  if (e.scope !== "tab") return null;
  if (typeof e.layout !== "object" || e.layout === null) return null;
  const tabTitle =
    typeof e.tabTitle === "string" && e.tabTitle.trim() !== ""
      ? e.tabTitle
      : name;
  return {
    scope: "tab",
    name,
    tabTitle,
    layout: e.layout as SerializedDockview,
    savedAt: e.savedAt,
  };
}

/**
 * Structural guard for a WELL-FORMED master-layout entry as it appears on the
 * wire from the server catalog: scope "master", a non-empty PRE-TRIMMED name,
 * a session object with activeWorkspaceName string|null and a NON-EMPTY
 * workspaces array of {name: non-empty string, layout: non-null object}, and
 * a finite savedAt. The server validates this exact shape before storage
 * (non-empty workspaces is a server-side invariant), so anything looser here
 * is a malformed/hostile document — the companion {@link
 * coerceMasterLayoutEntry} (the shared local-store read path) is
 * deliberately more lenient (an empty workspaces array survives a LOCAL
 * read; the load path no-ops it).
 */
export function isMasterLayoutEntry(obj: unknown): obj is MasterLayoutEntry {
  if (typeof obj !== "object" || obj === null) return false;
  const e = obj as Record<string, unknown>;
  if (e.scope !== "master") return false;
  if (typeof e.name !== "string" || e.name === "" || e.name !== e.name.trim()) {
    return false;
  }
  if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt)) return false;
  if (typeof e.session !== "object" || e.session === null) return false;
  const s = e.session as Record<string, unknown>;
  if (s.activeWorkspaceName !== null && typeof s.activeWorkspaceName !== "string") {
    return false;
  }
  if (!Array.isArray(s.workspaces) || s.workspaces.length === 0) return false;
  for (const w of s.workspaces) {
    if (typeof w !== "object" || w === null) return false;
    const rec = w as Record<string, unknown>;
    if (typeof rec.name !== "string" || rec.name === "") return false;
    if (typeof rec.layout !== "object" || rec.layout === null) return false;
  }
  return true;
}

/**
 * Structural guard for ONE master-scope store value (lifted from the private
 * coerceEntry master-branch in namedLayouts.ts — behavior identical, so the
 * local store read path and the server-catalog client validate master data
 * with ONE set of checks). `name` is the caller's key for the entry. Returns
 * the coerced entry or null (the caller drops the entry — a poison entry
 * never poisons the store/doc). The per-workspace layout blobs stay opaque
 * objects — the cold-restore pipeline re-validates them at consume time.
 * activeWorkspaceName falls back to null when absent/non-string (a missing
 * or unknown active activates the FIRST workspace at load). A tab-scope (or
 * unknown-scope) value returns null — this coerces MASTER entries only.
 */
export function coerceMasterLayoutEntry(name: string, v: unknown): MasterLayoutEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt)) return null;
  if (e.scope !== "master") return null;
  if (typeof e.session !== "object" || e.session === null) return null;
  const s = e.session as Record<string, unknown>;
  if (!Array.isArray(s.workspaces)) return null;
  const workspaces: MasterLayoutEntry["session"]["workspaces"] = [];
  for (const w of s.workspaces) {
    if (typeof w !== "object" || w === null) return null;
    const rec = w as Record<string, unknown>;
    if (typeof rec.name !== "string" || rec.name.trim() === "") return null;
    if (typeof rec.layout !== "object" || rec.layout === null) return null;
    workspaces.push({
      name: rec.name,
      layout: rec.layout as SerializedDockview,
    });
  }
  const activeWorkspaceName =
    typeof s.activeWorkspaceName === "string" ? s.activeWorkspaceName : null;
  return { scope: "master", name, session: { activeWorkspaceName, workspaces }, savedAt: e.savedAt };
}

/**
 * The origin allowlist for restored/loaded pane targets, anchored to the
 * BUILD-TIME VITE_SERVERS config (hasRealFleetEnv + resolveBaseFleet), NOT
 * the runtime catalog. Extracted from validRestoreIds in
 * layoutPersistence.ts so both surfaces (local cold restore + server-layout
 * load) derive the allowlist from ONE place. Returns null in mock mode (no
 * VITE_SERVERS), meaning only the http/https protocol guard applies — the
 * documented mode asymmetry (see the per-pane url validation block in
 * layoutPersistence.ts).
 */
export function buildTimeFleetOrigins(): Set<string> | null {
  if (!hasRealFleetEnv()) return null;
  return new Set(
    resolveBaseFleet()
      .map((e) => safeOrigin(e.url))
      .filter((o): o is string => o !== null),
  );
}

/**
 * Validate every pane target of a SERVER-SOURCED layout against the fleet
 * allowlist. A panel id is INVALID when its params are not a fleet entry
 * ({url,label} with an absolute http/https url — the same isFleetEntry guard
 * the fleet resolver uses; a javascript:/data:/opaque value or a missing
 * params object is invalid because the restored url is assigned to an
 * UNSANDBOXED iframe.src) OR, in real-fleet mode, when its origin is not a
 * member of the build-time fleet (a pane pointing at a server this build
 * does not declare).
 *
 * DIFFERENT from the local restore path BY DESIGN (F3 H1): the local
 * validRestoreIds DROPS invalid panes and restores the survivors; this check
 * reports ALL offending ids and the caller BLOCKS the whole load when
 * `valid` is false — a server layout is never partially or silently opened.
 */
export function validateServerLayoutTargets(
  layout: SavedLayout,
  fleetOrigins: Set<string> | null,
): { valid: boolean; invalidIds: string[] } {
  const invalidIds: string[] = [];
  for (const [id, st] of Object.entries(layout.panels ?? {})) {
    const params = st?.params;
    if (!isFleetEntry(params)) {
      invalidIds.push(id);
      continue;
    }
    if (fleetOrigins) {
      const origin = safeOrigin((params as FleetEntry).url);
      if (!origin || !fleetOrigins.has(origin)) {
        invalidIds.push(id);
        continue;
      }
    }
  }
  return { valid: invalidIds.length === 0, invalidIds };
}

/** URL origin (null on a malformed url — never throws). */
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
