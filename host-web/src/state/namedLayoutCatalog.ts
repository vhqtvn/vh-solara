// =============================================================================
// NAMED-LAYOUT CATALOG CLIENT — host-web's FIRST /vh/* API client.
//
// Talks to the worker-side named-layouts catalog (pkg/web/named_layouts*.go):
//   GET /vh/layouts            → {revision, entries:[TabLayoutEntry…]}
//   PUT /vh/layouts (per-entry) → body {baseRevision, entry} — exactly ONE
//                                 entry per PUT (F3-pinned granularity);
//                                 200 = full public doc (revision +1);
//                                 409 = stale baseRevision, body = the
//                                 CURRENT doc (adopt + deliberate retry).
//
// F3 LAW (task-2026-09-17t20-32-39, hazards H1/H2 — violations are design
// breaches):
//   • This module NEVER participates in boot/restore arbitration: it fetches
//     ONLY when the Layouts popover opens or a publish follows an explicit
//     save — never at module init, never seeding the URL hash or the v3
//     localStorage blob (the sanctioned explicit-load path persists through
//     addWorkspace→scheduleSave like any user layout; this module itself
//     never writes either mirror).
//   • `revision` is CAS-ONLY. It is NEVER used as ordering, sequencing, or
//     display state — no seq/savedAt/revision cross-device comparison exists
//     anywhere in this module.
//   • The publish is PER-ENTRY: saving name Y uploads exactly one entry and
//     never propagates local deletes/renames or never-published entries.
//   • Silent degradation: ANY failure (network error, non-200, HTML instead
//     of JSON — the vite-dev 404/SPA-fallback case) returns null / warns and
//     resolves as a NO-OP SUCCESS so the local save path is never blocked.
//     Unfolded vite-dev mode therefore degrades to a no-op catalog while
//     localStorage carries the feature.
//   • No SSE/stream listener (v1 has no layouts.updated fanout; convergence
//     is by refetch on the next open/save).
//
// CSRF: PUT carries X-VH-CSRF: 1 explicitly (the SPA-side wrapper pattern in
// web/src/csrf.ts installs it process-wide; host-web has no such wrapper, so
// this client sets the header on its mutating call — the only fetch surface
// in host-web today, kept deliberately narrow).
//
// Same-origin only: the path is relative ("/vh/layouts" on the origin serving
// the host shell — the folded binary serves both, and the controller subdomain
// proxy forwards the same path).
// =============================================================================

import { coerceTabLayoutEntry, isTabLayoutEntry } from "../dockview/layoutValidation";
import {
  normalizeLayoutName,
  normalizeTabTitle,
  type TabLayoutEntry,
} from "../dockview/namedLayouts";

/** The catalog's public wire shape (GET body, PUT 200/409 body). */
export interface ServerLayoutsDoc {
  /** CAS guard value for the next PUT. Never ordered, never displayed. */
  revision: number;
  entries: TabLayoutEntry[];
}

const LAYOUTS_PATH = "/vh/layouts";

/** The single degradation log line (surfaced in dev consoles; grep-able in
 *  e2e). Deliberately quiet: a missing backend is a supported posture. */
function warnSkip(): void {
  console.warn("skipping server layout sync");
}

/**
 * Parse a catalog doc from an unknown body. A structurally invalid doc is
 * null (silent degradation); a poison ENTRY is dropped, not the doc (the
 * same per-entry tolerance the local store's read path has). Entries are
 * strictly validated (isTabLayoutEntry — pre-trimmed name, non-empty
 * tabTitle) because the server is a remote writer whose bytes are untrusted
 * here, then coerced through the SHARED coerceTabLayoutEntry so local and
 * server data flow through one validation path.
 */
function parseDoc(body: unknown): ServerLayoutsDoc | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.revision !== "number" || !Number.isFinite(o.revision)) return null;
  if (!Array.isArray(o.entries)) return null;
  const entries: TabLayoutEntry[] = [];
  for (const v of o.entries) {
    if (!isTabLayoutEntry(v)) continue;
    const coerced = coerceTabLayoutEntry(v.name, v);
    if (coerced) entries.push(coerced);
  }
  return { revision: o.revision, entries };
}

/**
 * Fetch the current catalog. Called ONLY from the Layouts popover's open
 * refresh (and internally by publishEntry for the CAS base) — NEVER at boot.
 * ANY failure → null (the caller renders local-only). Never throws.
 */
export async function fetchCatalog(): Promise<ServerLayoutsDoc | null> {
  try {
    const res = await fetch(LAYOUTS_PATH, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return parseDoc(await res.json());
  } catch {
    return null; // network error / HTML body / aborted — silent degradation
  }
}

/**
 * Publish ONE entry to the worker catalog (the push half of an explicit
 * save). Fire-and-forget by design: the LOCAL save has already succeeded;
 * this resolves as a NO-OP SUCCESS on any failure after one console.warn —
 * the operator's save is never blocked or failed by the server.
 *
 * Sequence: GET the current revision (the CAS base) → PUT {baseRevision,
 * entry} → on 409 ADOPT the returned current doc and retry exactly ONCE (a
 * deliberate, user-initiated retry — not a spin loop; two consecutive 409s
 * give up and converge by the next refetch) → on success return the
 * committed doc (the caller may refresh its list from it). Returns null on
 * every failure path.
 *
 * The entry is defensively re-normalized client-side (name trim/cap 60,
 * tabTitle trim/cap 80 with the empty→name fallback) — the server requires
 * the already-normalized form and rejects anything else with a 400, and the
 * sanctioned callers (the Layouts save flow, which publishes exactly what
 * namedLayouts.saveTabLayout wrote) already pass normalized entries.
 */
export async function publishEntry(entry: TabLayoutEntry): Promise<ServerLayoutsDoc | null> {
  const name = normalizeLayoutName(entry.name);
  if (!name) {
    warnSkip();
    return null;
  }
  const payload: TabLayoutEntry = {
    ...entry,
    name,
    tabTitle: normalizeTabTitle(entry.tabTitle) || name,
  };
  try {
    let base = await fetchCatalog();
    if (base === null) {
      warnSkip();
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(LAYOUTS_PATH, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-vh-csrf": "1",
        },
        body: JSON.stringify({ baseRevision: base.revision, entry: payload }),
      });
      if (res.status === 409) {
        // Stale CAS: the body IS the current doc — adopt it, retry ONCE.
        const adopted = parseDoc(await res.json().catch(() => null));
        if (adopted === null) break;
        base = adopted;
        continue;
      }
      if (!res.ok) break; // 400/403/5xx — malformed or refused; do not retry
      const doc = parseDoc(await res.json().catch(() => null));
      if (doc === null) break;
      return doc;
    }
  } catch {
    // fall through to the no-op-success path
  }
  warnSkip();
  return null;
}
