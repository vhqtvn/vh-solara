// Orphaned sessions: subsessions whose parent is genuinely ABSENT from the live
// tree — not present in the materialized set (state.sessions) NOR collapsed
// behind a frontier stub (state.branchStubs). This is distinct from a parent
// that is merely collapsed into a stub: that is a LIVE state under the lazy-
// expand / projected-snapshot projection (the parent still exists server-side
// and can be re-materialized), so such a child must NOT be treated as an orphan.
// A genuine orphan arises when the parent was archived/deleted server-side but
// OpenCode's cascade-archive didn't reach the (late/active) child. They're kept
// out of the tree so they don't flood it, but surfaced via a banner so they can
// be cleaned up.
//
// Frontier invariant (load-bearing): a materialized child's DIRECT parent is
// always EITHER materialized (state.sessions) OR a frontier stub
// (state.branchStubs). The only time the direct parent is in NEITHER is a
// genuine orphan. This holds across every path that materializes a session:
//   - active-closure projection: the server materializes every ancestor of an
//     active session (projection.go descendActiveClosureLocked), so a
//     materialized child's parent is materialized too;
//   - lazy-expand: expanding stub P materializes P's children while P STAYS a
//     stub, so the parent is in branchStubs (stream.ts applyLazyExpandMerge);
//   - stub-demotion reconcile: when P is demoted to a stub, P is removed from
//     state.sessions AND added to branchStubs atomically, and a preserved child
//     of P still finds P in branchStubs (stream.ts applyProjectedSnapshot).
// So the single direct-parentID check below is sufficient — no ancestor walk is
// needed. orphans.test.ts pins this invariant.
import { sessionWorking, state } from "./sync";
import type { Session } from "./types";

// Idle orphans only: a running orphan already surfaces in the tree (and is
// active work you wouldn't bulk-archive), so the banner targets the stale,
// idle leftovers. A child whose parent is collapsed behind a frontier stub is
// NOT an orphan (live branch) — only a parent absent from BOTH the
// materialized sessions and the frontier stubs counts.
export function orphanSessions(): Session[] {
  return Object.values(state.sessions).filter(
    (s) =>
      s.parentID &&
      !state.sessions[s.parentID] &&
      !state.branchStubs[s.parentID] &&
      !sessionWorking(s.id),
  );
}

export interface RootInfo {
  id: string;
  title: string;
  archived: boolean;
}

// Destructive bulk-archive safety gate. Returns ONLY orphans whose
// server-resolved root is CONFIRMED archived. A live (ACTIVE) root or an
// unresolved root (fetch failed / still pending) is NEVER bulk-archived — it
// may be a client projection artifact (collapsed/stranded behind the frontier),
// not a genuine orphan. This makes the bulk action safe-by-construction
// regardless of client state: only "root archived, child left behind" (the
// feature's original intent) is ever archived in bulk.
//
// Pure and network-free: the caller resolves each orphan's root server-side
// first (rootInfoFor, the FULL server store — independent of the client
// projection), then hands the resolved rows here. Unit-testable without a
// network by feeding synthetic rows.
export function archiveEligibleOrphans(
  rows: { orphan: Session; root: RootInfo | null }[],
): Session[] {
  return rows
    .filter((r) => r.root !== null && r.root.archived === true)
    .map((r) => r.orphan);
}

// Parents are archived (not in the live store), so resolve them from OpenCode.
// Cached, since many orphans share the same ancestor chain.
const cache = new Map<string, any>();
async function fetchSession(id: string): Promise<any | null> {
  if (cache.has(id)) return cache.get(id);
  let val: any = null;
  try {
    const r = await fetch(`/oc/session/${encodeURIComponent(id)}`);
    if (r.ok) val = await r.json();
  } catch {
    /* leave null */
  }
  cache.set(id, val);
  return val;
}

// Walk parentID up to the root, returning its id/title/archived. Bounded.
export async function rootInfoFor(parentID: string): Promise<RootInfo | null> {
  let cur: string | undefined = parentID;
  let last: any = null;
  for (let guard = 0; cur && guard < 50; guard++) {
    const s = await fetchSession(cur);
    if (!s) break;
    last = s;
    cur = s.parentID || undefined;
  }
  if (!last) return null;
  return { id: last.id, title: last.title || last.id, archived: !!last.time?.archived };
}
