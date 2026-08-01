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
import type { LabelGroup, LabelsDoc } from "../labels";
import { labelsGroups, labelTagIdsByRootSessionId } from "../labels";

// The effective display mode: the three persisted modes plus the transient
// "temp" overlay (a non-expanded strict ancestor of the selected session that
// the user has NOT clicked, revealing exactly one path child). "temp" is never
// persisted — it is computed at render time by effectiveTreeMode.
export type EffectiveTreeMode = TreeMode | "temp";

// The pinned group: iterate the reconciled pinned ORDER (membership + drag
// order, supplied by pins.reconciledPinnedOrder), resolve each id against
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
export function selectPinnedNodes(map: TreeFlatMap, pinnedOrder: readonly string[]): TreeNode[] {
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
// on the node) rather than recursing. Used for four things in the tree:
//   1. filtered-mode child inclusion (only working children render),
//   2. expanded-mode working-first partition (working children before idle),
//   3. the non-flat ring (.tree-twisty/.tree-node .running),
//   4. ingestion working() transition detection (seedTreeStore +
//      applyTreeOpStore): a genuine edge auto-mutates the persisted mode
//      (collapsed↔filtered); a non-working → working edge also front-promotes
//      the node's shell presentation rank in treeRoots()/treeChildrenOf()
//      (the activity-edge promotion).
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

// === Label selectors (slice 5) ==============================================
// Pure partition of active root sessions into PINNED / GROUPS / UNGROUPED
// sections with tag AND-filtering, built atop the labels-facade accessors
// (../labels, slice 4). These feed the Sidebar/SessionTree render (slice 6).
//
// LAYERING (the module's purity invariant is preserved for the heavy logic):
//   - PURE CORE (data-args): groupOfRoot, tagsOfRoot, matchesAllTags,
//     effectiveExpanded, pinnedRootsWithGroupHintFrom, selectLabeledSections.
//     Fully pure — take labels data + tree state as args, read no signals,
//     mutate no inputs. Trivially unit-testable with plain data, mirroring how
//     selectPinnedNodes(map, pinnedOrder) relates to pins.reconciledPinnedOrder
//     (the selector does NOT read the facade; the caller passes its current
//     value). The tag-filter + partition logic lives here.
//   - FACADE WRAPPERS (contract names): groupOf, tagsOf,
//     pinnedRootsWithGroupHint — thin one-liners reading the labels facade's
//     current signal values, delegating to the pure core. For slice-6 per-row
//     render lookups; smoke-tested via applyLabelsSnapshot.
//
// INVARIANTS preserved:
//   - selectPinnedNodes semantics + d_F1 (nested-pin double-render dedup) are
//     UNCHANGED — selectLabeledSections DELEGATES to selectPinnedNodes for the
//     pinned forest, so the dedup guarantee carries by construction. The label
//     partition only ever touches ROOTS (parentId === null — labels are
//     root-only), so it can neither introduce nor weaken a nested-pin double
//     render (a nested pin is not a root, not in rankedRoots, not in any
//     group's ordered root list).
//   - Sections are DISJOINT: a root rendered as pinned is suppressed from both
//     groups and ungrouped (pinned section wins). Group membership is treated
//     as EXCLUSIVE — a root is placed in at most one group (first group wins,
//     re-enforcing coerceLabelsDoc's invariant defensively for a direct-doc
//     input that bypassed coercion).
//   - Input immutability: selectors build fresh arrays/objects; they never
//     mutate the map, rankedRoots, pinnedOrder, doc, or the doc's nested
//     collections — the same read-only posture selectPinnedNodes takes vs
//     pins.serverOrder().

// A pinned root annotated with the group it returns to on unpin (null if the
// root is ungrouped). The hint lets slice 6's pinned row show the group
// color/chip so the user knows where the root lands when unpinned.
export interface PinnedRootWithHint {
  node: TreeNode;
  group: LabelGroup | null;
}

// One group section in the labeled partition: the group definition + its
// resident root nodes in the group's authoritative (orderedRootSessionIds)
// order.
export interface LabeledSectionGroup {
  group: LabelGroup;
  roots: TreeNode[];
}

// The render-walk partition consumed by slice 6's SessionTree. Render order is
// pinned → groups → ungrouped (slice 6 emits rows in that order). The three
// sections are DISJOINT.
export interface LabeledSections {
  // The pinned forest (d_F1-deduped via selectPinnedNodes), each root carrying
  // its group hint. Filter-aware: under an active tag filter only pinned ROOTS
  // matching the filter remain (a pinned non-root has no tags and cannot match
  // a non-empty filter).
  pinned: PinnedRootWithHint[];
  // Groups with their resident matching roots, in doc.groups array order. Under
  // an active filter, groups with zero matching roots are SUPPRESSED.
  groups: LabeledSectionGroup[];
  // Resident matching roots not pinned and not in any group, in presentation-
  // rank (rankedRoots) order — the caller's rank order is reused verbatim.
  ungrouped: TreeNode[];
}

// groupOfRoot — the group a root belongs to, or null. A root is in at most one
// group (the exclusive-membership invariant coerceLabelsDoc enforces by keeping
// the FIRST group — by doc.groups array order — that claims a root and stripping
// later occurrences). Returns the FIRST group whose orderedRootSessionIds
// contains rootId, which is therefore the unique owner for a well-formed doc.
// PURE: takes groups as data.
export function groupOfRoot(groups: readonly LabelGroup[], rootId: string): LabelGroup | null {
  for (const g of groups) {
    if (g.orderedRootSessionIds.includes(rootId)) return g;
  }
  return null;
}

// tagsOfRoot — the tag ids assigned to a root (empty if none). Returns the
// root's assignment list as-is, or a fresh empty array for an unknown root.
// PURE: takes the assignment map as data; does not mutate it or return its
// internal reference for an unknown root.
export function tagsOfRoot(
  assign: Record<string, string[]>,
  rootId: string,
): readonly string[] {
  return assign[rootId] ?? [];
}

// matchesAllTags — the AND filter: a root matches iff it carries EVERY selected
// tag id. An empty selectedTagIds set means NO filter (everything matches). A
// selected tag id the root lacks → no match. PURE.
export function matchesAllTags(
  assign: Record<string, string[]>,
  rootId: string,
  selectedTagIds: readonly string[],
): boolean {
  if (selectedTagIds.length === 0) return true;
  const tags = assign[rootId] ?? [];
  for (const t of selectedTagIds) {
    if (!tags.includes(t)) return false;
  }
  return true;
}

// effectiveExpanded — the per-group effective expansion state. During an active
// filter (filterActive), matching groups render EXPANDED regardless of their
// stored `collapsed` value — a temporary unfold so filtered roots are visible
// without the user first opening the group. The stored `collapsed` value is NOT
// overwritten (the unfold is purely render-time); clearing the filter restores
// the user's prior collapse state. PURE.
export function effectiveExpanded(group: LabelGroup, filterActive: boolean): boolean {
  return filterActive || !group.collapsed;
}

// pinnedRootsWithGroupHintFrom — the pinned forest (selectPinnedNodes) with
// each root's group attached, for slice 6's pinned-row "returns to" hint.
// Filter-AGNOSTIC (returns every pinned root with its hint); slice 6 applies
// any tag filter via selectLabeledSections().pinned. PURE: takes map,
// pinnedOrder, and groups as data.
export function pinnedRootsWithGroupHintFrom(
  map: TreeFlatMap,
  pinnedOrder: readonly string[],
  groups: readonly LabelGroup[],
): PinnedRootWithHint[] {
  return selectPinnedNodes(map, pinnedOrder).map((node) => ({
    node,
    group: groupOfRoot(groups, node.id),
  }));
}

// selectLabeledSections — the render-walk partition. Pure: takes the tree flat
// map, the presentation-rank-ordered roots (treeRoots()), the reconciled pinned
// order (pins.reconciledPinnedOrder()), the labels doc (labelsDoc()), and the
// selected tag ids (the AND filter). Returns the disjoint pinned / groups /
// ungrouped sections slice 6 renders (in that order).
//
// Reuses selectPinnedNodes for the pinned forest (d_F1 carries by delegation).
// Reuses the passed rankedRoots order for ungrouped (does NOT invent a new
// ordering — the presentation rank is the caller's authority, private to
// treeState). Group root order is each group's orderedRootSessionIds (the labels
// doc's authority). Nonresident ids in a group's ordered list (reconciliation
// temporarily incomplete) are skipped gracefully and appear in-place when they
// load — the partition is deterministic regardless of reconciliation state.
// Input refs are treated as read-only (fresh arrays/objects built for output).
export function selectLabeledSections(opts: {
  map: TreeFlatMap;
  rankedRoots: readonly TreeNode[];
  pinnedOrder: readonly string[];
  doc: LabelsDoc;
  selectedTagIds: readonly string[];
}): LabeledSections {
  const { map, rankedRoots, pinnedOrder, doc, selectedTagIds } = opts;
  const filterActive = selectedTagIds.length > 0;
  const groups = doc.groups;
  const assign = doc.tagIdsByRootSessionId;

  // Pinned forest via the EXISTING selector — d_F1 dedup carries by
  // construction. A root rendered as pinned (any node selectPinnedNodes
  // surfaced) is suppressed from groups/ungrouped below (pinned wins).
  const pinnedForest = selectPinnedNodes(map, pinnedOrder);
  const pinnedRenderedIds = new Set<string>();
  for (const n of pinnedForest) pinnedRenderedIds.add(n.id);

  const pinned: PinnedRootWithHint[] = [];
  for (const n of pinnedForest) {
    if (filterActive) {
      // Only pinned ROOTS matching the filter survive in the pinned section.
      // Labels are root-only, so a pinned non-root (deep pin) has no tag
      // assignment and cannot match a non-empty filter → dropped from the
      // pinned top-level under filter (its subtree still renders naturally
      // beneath a matching pinned root ancestor in slice 6's TreeBranch).
      if (n.parentId !== null) continue;
      if (!matchesAllTags(assign, n.id, selectedTagIds)) continue;
    }
    pinned.push({ node: n, group: groupOfRoot(groups, n.id) });
  }

  // Group sections in doc.groups order. A root is included iff resident, a
  // root (defensive — labels are root-only), not rendered as pinned, and
  // matching the filter. EXCLUSIVE: a root already placed in an earlier group
  // is skipped (first-group-wins, re-enforcing coerceLabelsDoc defensively for
  // a direct-doc input). Per-group order is orderedRootSessionIds.
  const placedRoots = new Set<string>();
  const groupSections: LabeledSectionGroup[] = [];
  for (const g of groups) {
    const roots: TreeNode[] = [];
    for (const id of g.orderedRootSessionIds) {
      if (placedRoots.has(id)) continue; // EXCLUSIVE: first group wins
      if (pinnedRenderedIds.has(id)) continue; // pinned wins — render exactly once
      const n = map.get(id);
      if (!n) continue; // nonresident — reconciliation incomplete; skip gracefully
      if (n.parentId !== null) continue; // defensive: labels are root-only
      if (!matchesAllTags(assign, id, selectedTagIds)) continue; // AND filter
      roots.push(n);
      placedRoots.add(id);
    }
    // Empty-group suppression: under an active filter, a group with no matching
    // roots is hidden. With no filter, every group is returned (slice 6 renders
    // collapsed/empty groups so the user can see + drag into them).
    if (filterActive && roots.length === 0) continue;
    groupSections.push({ group: g, roots });
  }

  // Claimed-by-group set for the ungrouped partition: a root id appearing in
  // ANY group's ordered list — resident or not, placed or skipped under filter
  // — is NOT ungrouped. (A filtered-out grouped root is hidden entirely, not
  // demoted to ungrouped.)
  const groupedIds = new Set<string>();
  for (const g of groups) {
    for (const id of g.orderedRootSessionIds) groupedIds.add(id);
  }

  // Ungrouped: resident roots not pinned-rendered, not claimed by any group,
  // and matching the filter, in presentation-rank (rankedRoots) order. Reuses
  // the caller's rank order verbatim — no re-sort, no new ordering invented.
  const ungrouped: TreeNode[] = [];
  for (const n of rankedRoots) {
    if (n.parentId !== null) continue; // roots only (defensive; rankedRoots are roots)
    if (pinnedRenderedIds.has(n.id)) continue; // pinned wins
    if (groupedIds.has(n.id)) continue; // claimed by a group → not ungrouped
    if (!matchesAllTags(assign, n.id, selectedTagIds)) continue; // AND filter
    ungrouped.push(n);
  }

  return { pinned, groups: groupSections, ungrouped };
}

// === Facade-reading wrappers (slice-6 per-row render lookups) ===============
// Thin delegates over the labels facade's current signal values. Read-only:
// they never mutate the returned refs (every internal facade write installs a
// new array/map, so a captured reference is a stable snapshot between
// mutations — the same guarantee pins.serverOrder() gives selectPinnedNodes).
// Exhaustive logic is covered by the pure core tests above; these are smoke-
// tested via applyLabelsSnapshot.

// groupOf — the group a root belongs to, or null. Reads labelsGroups().
export function groupOf(rootId: string): LabelGroup | null {
  return groupOfRoot(labelsGroups(), rootId);
}

// tagsOf — the tag ids assigned to a root (empty if none). Reads
// labelTagIdsByRootSessionId().
export function tagsOf(rootId: string): readonly string[] {
  return tagsOfRoot(labelTagIdsByRootSessionId(), rootId);
}

// pinnedRootsWithGroupHint — the pinned forest with group hints. Reads
// labelsGroups(); takes map + pinnedOrder as args (matches selectPinnedNodes'
// convention — the tree map and pin order are the render shell's authority, not
// the labels facade's). Filter-agnostic. Delegates to the pure core.
export function pinnedRootsWithGroupHint(
  map: TreeFlatMap,
  pinnedOrder: readonly string[],
): PinnedRootWithHint[] {
  return pinnedRootsWithGroupHintFrom(map, pinnedOrder, labelsGroups());
}
