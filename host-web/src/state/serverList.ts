import { createSignal } from "solid-js";
import { isFleetEntry, type FleetEntry } from "./mockData";

// =============================================================================
// Runtime server-list store — the operator-editable "fleet catalog".
//
// This is ORTHOGONAL to the build-time VITE_SERVERS config and to layout
// persistence (vh-host:layout:v1). It holds the {url,label}[] the operator
// added at runtime, persisted to a versioned localStorage key, and feeds the
// FIRST precedence tier of resolveFleet() (runtime catalog > VITE_SERVERS >
// mock). Adding a server appends here + opens a pane; removing drops here +
// closes that server's panes. The catalog never gates layout restore (see
// layoutPersistence.ts) — it only changes what resolveFleet() returns for
// seeding NEW panes and the add-server universe.
//
// Security: every entry is validated through the SAME isFleetEntry http/https
// guard the fleet resolver uses (never weaken it). The url lands on an
// UNSANDBOXED iframe.src, so a javascript:/data:/opaque value would execute
// same-origin against the host shell — rejected at insert time, and again at
// load time (defense-in-depth: never trust stored data).
//
// Cycle note: this module imports isFleetEntry from mockData, and mockData's
// resolveFleet() imports runtimeServers() from here. The cycle is safe: the
// imported binding (isFleetEntry) is a hoisted function declaration, so it is
// initialized before either module's body runs. No top-level call in either
// module depends on a value that could be in the TDZ across the cycle.
// =============================================================================

/** Versioned + namespaced storage key (mirrors the layout-persistence pattern). */
export const SERVERS_STORAGE_KEY = "vh-host:servers:v1";

/** Read + validate the persisted catalog. Never throws: corrupt/missing/private
 *  localStorage all collapse to an empty catalog (the mock fleet then seeds). */
function loadFromStorage(): FleetEntry[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SERVERS_STORAGE_KEY);
  } catch {
    return []; // localStorage unavailable
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // corrupt JSON → empty catalog
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isFleetEntry); // drop any non-{url,label} / non-http(s) entry
}

/** Best-effort persist. Never throws: private mode / quota / serialize failure
 *  are all swallowed (persistence is best-effort). An empty list CLEARS the key
 *  so a reload re-seeds rather than restoring a stale catalog. */
function persistToStorage(list: FleetEntry[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(SERVERS_STORAGE_KEY);
    else localStorage.setItem(SERVERS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable / quota exceeded — swallow.
  }
}

// Module-scope signal (same singleton pattern as dockview/store.ts). The initial
// value is loaded synchronously at import (before seedInitialPanes runs), so a
// cold start with a persisted catalog seeds from it when there is no saved layout.
const [runtimeServers, setRuntimeServers] = createSignal<FleetEntry[]>(
  loadFromStorage(),
);

export { runtimeServers };

/** Whether the operator has added any runtime servers. */
export function hasRuntimeServers(): boolean {
  return runtimeServers().length > 0;
}

/**
 * Append {url,label} to the catalog. Idempotent on url: a duplicate url does
 * NOT add a second catalog entry (a server is uniquely its url; multiple panes
 * of one server are opened via addServer/split, not via duplicate catalog rows).
 * The caller validates the url through isFleetEntry BEFORE calling (addServer),
 * but this re-validates defensively on insert too.
 */
export function addRuntimeServer(url: string, label: string): void {
  if (!isFleetEntry({ url, label })) return; // defensive: never store a bad entry
  setRuntimeServers((list) => {
    if (list.some((e) => e.url === url)) return list; // dedupe by url
    const next = [...list, { url, label }];
    persistToStorage(next);
    return next;
  });
}

/**
 * Drop the catalog entry for `url` (if present). Does NOT close panes — the
 * controller (removeServer) owns closing that url's panes and calls this for the
 * catalog side. Safe to call with a url that is not in the catalog (no-op).
 */
export function removeRuntimeServer(url: string): void {
  setRuntimeServers((list) => {
    const next = list.filter((e) => e.url !== url);
    if (next.length === list.length) return list; // not present → no-op
    persistToStorage(next);
    return next;
  });
}
