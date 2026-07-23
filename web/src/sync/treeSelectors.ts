// treeSelectors — pure pinned/search selectors over the tree=2 flat map.
//
// This module restores the parity the deleted proj=1 client had (PINS + SEARCH)
// but implemented against the NEW flat `Map<id,TreeNode>` (treeMap.ts), NOT the
// old `buildChildrenIndex`/root-walk. The key fix: the old client built the
// pinned group from ROOTS only, so a pinned deep/collapsed node vanished.
// Because every TreeNode in the flat map carries its own display data (title,
// agent chip, descendantCount), a pinned node is hoisted into the pinned group
// regardless of depth or `loaded` state — it stays actionable + chip-rendered.
//
// PURE: no Solid, no store, no network. Takes the map (and the pinned
// order/membership) as arguments so it is trivially unit-testable and reusable
// from both the reactive shell (treeState) and tests.
import type { TreeNode, TreeFlatMap } from "./treeMap";

// The pinned group: iterate the reconciled pinned ORDER (membership + drag
// order, supplied by sidebar.reconciledPinnedOrder), resolve each id against
// the flat map, and drop any that are not currently resident. A pinned node
// that is deep, collapsed (loaded:false), or orphaned still resolves here —
// that is the whole point: the flat map does not care about depth.
//
// Dedup: the caller (TreeStateView) uses this list to render the pinned group
// AND filters these same ids OUT of the normal tree walk, so a pinned node
// appears exactly once (hoisted), mirroring the old client's approach.
export function selectPinnedNodes(map: TreeFlatMap, pinnedOrder: string[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const id of pinnedOrder) {
    const n = map.get(id);
    if (n) out.push(n);
  }
  return out;
}

// Flatten-to-matches search. Returns `null` when search is inactive (empty/
// blank query) so the caller can render the normal tree; returns `[]` when
// search is active but nothing matches so the caller can render the empty
// state. Matching is case-insensitive substring over title || id || agent
// (a SUPERSET of the old proj=1 client, which matched title || id only —
// adding agent lets you find a session by its model/role chip).
//
// Because this walks the WHOLE flat map (not a root→leaf tree walk), a match
// deep inside a collapsed subtree is always surfaced: there is no "ancestor
// must be expanded" gate. Sort: pinned-first, then recency (updatedMs desc),
// matching the old client's flat-result ordering.
export function selectSearchResults(
  map: TreeFlatMap,
  query: string,
  isPinned: (id: string) => boolean,
): TreeNode[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const matches: TreeNode[] = [];
  for (const n of map.values()) {
    const hay = `${n.title || n.id}\u{0}${n.id}\u{0}${n.agent ?? ""}`.toLowerCase();
    if (hay.includes(q)) matches.push(n);
  }
  matches.sort((a, b) => {
    const pa = isPinned(a.id) ? 0 : 1;
    const pb = isPinned(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return b.updatedMs - a.updatedMs;
  });
  return matches;
}
