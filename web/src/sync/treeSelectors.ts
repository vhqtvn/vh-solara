// treeSelectors — pure pinned/search/mode selectors over the tree=2 flat map.
//
// This module restores the parity the deleted proj=1 client had (PINS + SEARCH)
// plus the 4-state twisty MODEL helpers (working / strictAncestors /
// effectiveTreeMode / hasKnownDescendants), all implemented against the NEW flat
// `Map<id,TreeNode>` (treeMap.ts), NOT the old `buildChildrenIndex`/root-walk.
//
// PURE: no Solid, no store, no network, no localStorage, no lifecycle. Takes the
// map (and selected-ancestor/toggle sets) as arguments so it is trivially unit-
// testable and reusable from both the reactive shell (treeState) and tests.
import type { TreeNode, TreeFlatMap } from "./treeMap";
import type { TreeMode } from "./treeState";

// The effective display mode: the three persisted modes plus the transient
// "temp" overlay (a non-expanded strict ancestor of the selected session that
// the user has NOT clicked, revealing exactly one path child). "temp" is never
// persisted — it is computed at render time by effectiveTreeMode.
export type EffectiveTreeMode = TreeMode | "temp";

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

// selectedPathIds — the SELECTION reveal set (P0-D). Returns the INCLUSIVE
// ancestor chain of `selectedId` (the selected node + every parentId up to a
// root), ancestor-closed. Drives the "temp" overlay: a selected idle nested
// session's ancestors become "temp" (revealing exactly one path child) so the
// selected leaf is reachable even when its parent is collapsed/filtered.
//
// `selectedId` may be null/empty (no selection) or point at a node NOT resident
// in the map (a stale deep link): both yield an empty set (nothing to reveal —
// never add an id the client does not hold). The idle SIBLINGS of the selected
// chain are NOT added (only the selected node's own ancestor chain opens).
//
// PURE: takes the map + selectedId, returns a fresh Set. Depth-capped
// defensively against a corrupt parentId cycle.
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

// working — the SINGLE working predicate (proj=1 model restore). Leans on the
// SERVER-COMPUTED rollups (flags.subtreeBusy / flags.subtreeNeedsInput) + the
// node's own activity — NO client-side subtree walk, NO full-map projection. The
// "balance with server computing" is satisfied by reading these rollups (already
// on the node) rather than recursing. Used for THREE things in the tree:
//   1. filtered-mode child inclusion (only working children render),
//   2. expanded-mode working-first stable ordering,
//   3. the non-flat ring (.tree-twisty/.tree-node .running).
// Input-ancestry is represented by the subtreeNeedsInput rollup — error /
// permission are NOT added independently (Permission:true ⟹ PendingInput today,
// and the rollup carries input-ancestry for collapsed ancestors).
export function working(node: TreeNode): boolean {
  return (
    node.activity === "busy" ||
    node.activity === "retry" ||
    !!node.flags.subtreeBusy ||
    !!node.flags.subtreeNeedsInput
  );
}

// autoTreeModeForWorkingTransition — the QUALIFIED auto-mutation decision for a
// persisted tree mode given a node's working() transition (previousWorking →
// currentWorking). Encodes ONLY the two edges that auto-mutate the persisted
// mode; every other combination (including any involvement of "expanded", the
// already-matching target, and the no-edge same-state cases) returns undefined
// (no-op). PURE: takes only the transition + the current PERSISTED mode, never
// reads the map, signals, selection, temp overlay, or userToggled.
//
// Transition table (the qualified, not absolute, invariant):
//   prev    cur     persistedMode  → result
//   false   true    collapsed      → "filtered"   (running → reveal working kids)
//   true    false   filtered       → "collapsed"  (finished → hide the now-idle kids)
//   any     any     expanded       → undefined    (expanded is NEVER auto-changed)
//   any other combination          → undefined    (no qualifying edge)
//
// The "qualified" qualifier: a manually-clicked collapsed→filtered on an idle
// node stays filtered (that is NOT a transition — prev==cur==false); only a
// GENUINE working edge auto-mutates. Likewise a false→true on an already-filtered
// node does nothing (undefined), so a node the user already revealed keeps that
// choice. Auto-mutation is TRANSITION-DRIVEN; it never fires for a steady state.
export function autoTreeModeForWorkingTransition(
  previousWorking: boolean,
  currentWorking: boolean,
  persistedMode: TreeMode,
): TreeMode | undefined {
  if (!previousWorking && currentWorking && persistedMode === "collapsed") return "filtered";
  if (previousWorking && !currentWorking && persistedMode === "filtered") return "collapsed";
  return undefined;
}

// strictAncestors — the selected node's ancestors EXCLUDING the selected node
// itself. Copies selectedPathIds (which may be shared/cached) before deleting
// the leaf so the caller's set is not mutated. Drives the "temp" overlay: a
// non-expanded strict ancestor that the user has not clicked becomes "temp".
// Empty when selectedId is null/empty/non-resident.
export function strictAncestors(map: TreeFlatMap, selectedId: string | null): Set<string> {
  const ids = new Set(selectedPathIds(map, selectedId));
  if (selectedId) ids.delete(selectedId);
  return ids;
}

// effectiveTreeMode — the per-node display mode state machine. A node is "temp"
// iff ALL of: its persisted mode is NOT "expanded", it is a STRICT ancestor of
// the selected session, and the user has NOT clicked it (userToggled) since the
// last real selection change. Otherwise it reflects its persisted mode (which
// defaults to "filtered" via treeState.modeOf for an absent entry).
//
// The userToggled suppression is the proj=1 temp→filtered transition: clicking
// a temp ancestor promotes it to its persisted mode (filtered) instead of
// re-clamping to temp, and the click also flips the persisted mode (handled by
// SessionTree.onToggle).
export function effectiveTreeMode(
  id: string,
  persistedMode: TreeMode,
  selectedAncestors: ReadonlySet<string>,
  toggled: ReadonlySet<string>,
): EffectiveTreeMode {
  if (persistedMode !== "expanded" && selectedAncestors.has(id) && !toggled.has(id)) return "temp";
  return persistedMode;
}

// hasKnownDescendants — does this node have ANY known descendants (structural OR
// resident)? A structural leaf (childCount 0 + no descendantCount) never has
// children to fetch, so the lazy frontier never fires for it.
export function hasKnownDescendants(node: TreeNode): boolean {
  return node.childCount > 0 || (node.descendantCount ?? 0) > 0;
}
