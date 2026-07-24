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
//
// d_F1 (nested-pin double render): the pinned-group TreeBranch recurses with an
// EMPTY dedup set (the pinned group renders its rows' descendant trees too), so
// if BOTH an ancestor and a descendant are pinned, the descendant would render
// TWICE — once nested under the pinned ancestor's recursion, once as a top-level
// pinned row. To prevent that, a pinned id that has a PINNED ANCESTOR is
// excluded here: it already renders nested under that ancestor in the group.
export function selectPinnedNodes(map: TreeFlatMap, pinnedOrder: string[]): TreeNode[] {
  const pinnedSet = new Set(pinnedOrder);
  const out: TreeNode[] = [];
  for (const id of pinnedOrder) {
    const n = map.get(id);
    if (!n) continue;
    if (hasPinnedAncestor(map, id, pinnedSet)) continue; // d_F1: nested, not top-level
    out.push(n);
  }
  return out;
}

// Walk the parentId chain from `id` upward; return true iff any ancestor is also
// pinned. The server guarantees a DAG (parentId is server-assigned, never
// client-inferred), but a depth cap guards against a corrupt cycle defensively.
function hasPinnedAncestor(map: TreeFlatMap, id: string, pinnedSet: Set<string>): boolean {
  let cur = map.get(id)?.parentId;
  for (let i = 0; i < 10000 && cur != null; i++) {
    if (pinnedSet.has(cur)) return true;
    cur = map.get(cur)?.parentId;
  }
  return false;
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

// Active-path render gate (flood fix). Returns the set of node ids that are on
// an ACTIVE PATH: the inclusive ancestor chain (root → ... → node) of ANY node
// that is itself active — per §5.1 (the precise active-path definition), which
// the server's authoritative `isActiveLocked` implements at
// pkg/state/tree_emitter.go:200-212. Such nodes are auto-expanded by the render
// gate so live work / pending-input branches stay visible WITHOUT requiring a
// user toggle (and WITHOUT a server fetch — §5 guarantees the active path ships
// resident).
//
// A node with no active descendant (and not itself active) is NOT in the set, so
// an idle many-child parent collapses to its "▸ N" twisty even though its
// children stay resident in the flat map — this is exactly the flood fix.
//
// PURE: takes the map, returns a fresh Set. Depth-capped defensively against a
// corrupt parentId cycle (mirrors hasPinnedAncestor's guard). A node with no
// active descendant is never added; idle siblings of the active chain are not.

// §5.1 active-path seed — MIRRORS the server's authoritative isActiveLocked
// (pkg/state/tree_emitter.go:200-212) line-for-line. NOTE: `flags.permission` is
// currently REDUNDANT in live data (Permission:true ⟹ PendingInput:true because
// pendingInputSelfLocked counts perms — pkg/state/subtree_indexes.go:178-183),
// and archived nodes are not resident client-side today (cascade-deleted server-
// side + eagerly dropped), so both arms produce ZERO behavior change against
// current data. Mirroring the server predicate exactly removes any client↔server
// divergence surface and future-proofs both cases (commit-reviewer tier1_b-F1).
function nodeSeedsActivePath(n: TreeNode): boolean {
  if (n.flags.archived) return false; // §5.1 Q1: archived NEVER seeds
  return (
    n.activity !== "idle" || // busy | retry | error (Activity has no 5th state)
    n.flags.permission ||
    n.flags.pendingInput
  );
}

export function activePathIds(map: TreeFlatMap): Set<string> {
  const out = new Set<string>();
  for (const n of map.values()) {
    if (nodeSeedsActivePath(n)) {
      // Walk the parentId chain upward from the active node, adding every
      // ancestor inclusive. Depth-capped: a corrupt cycle terminates instead of
      // looping forever (cur becomes undefined when the id is not in the map).
      let cur: string | undefined = n.id;
      for (let i = 0; i < 10000 && cur != null; i++) {
        out.add(cur);
        cur = map.get(cur)?.parentId ?? undefined;
      }
    }
  }
  return out;
}

// selectedPathIds — the SELECTION reveal set (P0-D). activePathIds seeds ONLY
// on activity/permission/pendingInput, so selecting or deep-linking an idle
// NESTED session left its row hidden inside a collapsed parent. selectedPathIds
// fills that gap: it returns the INCLUSIVE ancestor chain of `selectedId` (the
// selected node + every parentId up to a root), ancestor-closed. Combined with
// activePathIds into visiblePathIds (below), this drives the per-child render
// gate so a selected idle nested node is rendered even when its parent is
// collapsed by default.
//
// `selectedId` may be null/empty (no selection) or point at a node NOT resident
// in the map (a stale deep link): both yield an empty set (nothing to reveal —
// never add an id the client does not hold). The idle SIBLINGS of the selected
// chain are NOT added (only the selected node's own ancestor chain opens).
//
// PURE: takes the map + selectedId, returns a fresh Set. Depth-capped
// defensively against a corrupt parentId cycle (mirrors activePathIds' /
// hasPinnedAncestor's 10000 guard).
export function selectedPathIds(map: TreeFlatMap, selectedId: string | null): Set<string> {
  const out = new Set<string>();
  if (!selectedId) return out;
  // A selection pointing at a node the client does not hold reveals nothing:
  // start the walk only if the selected id is resident. (Also guards against
  // adding a bare non-resident id at the loop's first iteration.)
  if (!map.has(selectedId)) return out;
  let cur: string | undefined = selectedId;
  for (let i = 0; i < 10000 && cur != null; i++) {
    out.add(cur);
    cur = map.get(cur)?.parentId ?? undefined;
  }
  return out;
}

// visiblePathIds — the ONE "keep-visible" set driving the per-child render gate
// (P0-C flood + P0-D selection reveal). A child C renders under parent P iff
// C ∈ visiblePathIds (on the active OR selected path) OR P is user-expanded
// (the user-expand branch is handled in SessionTree.TreeBranch). This is the
// UNION of activePathIds (live-work chains) and selectedPathIds (the selected
// node's chain); ancestor-closed because both operands are. Idle siblings of
// either path are NOT in the set → an active parent shows only its busy branch,
// and a selected idle nested node is revealed by opening only its own chain.
//
// PURE: union of two pure sets; returns a fresh Set.
export function visiblePathIds(map: TreeFlatMap, selectedId: string | null): Set<string> {
  const out = activePathIds(map);
  for (const id of selectedPathIds(map, selectedId)) out.add(id);
  return out;
}
