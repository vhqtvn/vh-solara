import { For, Show, createMemo } from "solid-js";
import { selectedId, setSelectedId, state, expandTreeNode } from "../sync";
import { setView } from "../ui";
import { treeMap, treeRoots, treeChildrenOf, isUserExpanded, setUserNodeExpanded } from "../sync/treeState";
import { selectPinnedNodes, selectSearchResults, visiblePathIds } from "../sync/treeSelectors";
import { searchQuery, reconciledPinnedOrder, isPinned } from "../sidebar";
import { menuTriggers } from "../sessionMenu";
import TreeRow from "./TreeRow";
import type { TreeNode } from "../sync/treeMap";

// Picking a session always shows its chat — even re-clicking the already-open
// one while on another tab (Code/Changes) jumps you back to the conversation.
export const openSessionChat = (id: string) => {
  setSelectedId(id);
  setView("chat");
};

// tree=2: render from the server-owned flat map (treeState). Every node is
// self-contained (title, agent chip, activity/flags, descendantCount) — there
// is NO client-side orphan classification, parent inference, or reconcile
// logic. Collapsed nodes (loaded:false with descendants) still render via
// TreeRow with their chip + "▸ N" badge and are right-clickable; expansion
// fetches direct children from the server (§8); collapse is client-only (§8.4).
//
// PINS (parity restored): a pinned node is hoisted into a Pinned group built
// from the FLAT map (selectPinnedNodes), so a pinned node surfaces REGARDLESS
// of depth or collapse state — the old proj=1 client only pinned roots. To
// avoid a pinned node rendering twice (once hoisted, once in its tree spot),
// `pinnedIds` is threaded through the tree walk and both the root list and
// each branch's children drop pinned ids.
function TreeBranch(props: {
  node: TreeNode;
  depth: number;
  // Tree guides (P0-A): `prefix` is one boolean per ancestor level (true when
  // that ancestor has a following sibling → its rail continues past this row);
  // `isLast` is whether THIS node is the last child of its parent (elbow └ vs
  // tee ├). Roots pass `prefix={[]}` so they render no guides. Both feed the
  // presentational TreeRow verbatim — no inference here.
  prefix: boolean[];
  isLast: boolean;
  onToggle: (n: TreeNode) => void;
  // Membership of the pinned group, as a reactive accessor. Children that are
  // pinned are skipped in THIS branch's recursion so they don't duplicate the
  // hoisted pinned row. Empty set in search mode (no dedup there).
  pinnedIds: () => Set<string>;
  // The "keep-visible" set (activePathIds ∪ selectedPathIds), as a reactive
  // accessor. The per-child render gate: under THIS parent, a child renders
  // iff it is in this set OR the parent is user-expanded. Threaded from
  // TreeStateView so activity + selection changes re-run the gate reactively.
  pathIds: () => Set<string>;
}) {
  // Resident direct children (recency-sorted, pinned-dedup'd) — these STAY in
  // the flat map regardless of expand state (instant re-expand, no round-trip).
  const children = () => treeChildrenOf(props.node.id).filter((c) => !props.pinnedIds().has(c.id));
  // Per-child render gate (P0-C flood fix + P0-D selection reveal):
  //   - user-expanded → render ALL children (the user asked to see everything);
  //   - otherwise → render only children on the keep-visible path (busy/active
  //     chains + the selected node's ancestor chain). Idle siblings of the path
  //     stay collapsed behind the parent's "▸ N" twisty. So an active parent
  //     with 1 busy + N idle children auto-shows ONLY the busy branch.
  const visibleChildren = () => {
    const all = children();
    if (isUserExpanded(props.node.id)) return all;
    const ids = props.pathIds();
    return all.filter((c) => ids.has(c.id));
  };
  // Is P open (does it render its children loop at all)? open(P) = user-expanded
  // OR it has at least one keep-visible child. Drives the children loop and the
  // twisty's `expanded` prop. The `&& children().length > 0` guard preserves
  // the unloaded-expand edge (a user-expanded node with no RESIDENT children
  // still shows "Expand"/▸ N while its fetch is in flight — it has nothing to
  // collapse yet).
  const open = () => isUserExpanded(props.node.id) || visibleChildren().length > 0;
  return (
    <>
      <TreeRow
        node={props.node}
        depth={props.depth}
        prefix={props.prefix}
        isLast={props.isLast}
        selected={selectedId() === props.node.id}
        expanded={open() && children().length > 0}
        unread={!!state.unread[props.node.id]}
        onSelect={() => openSessionChat(props.node.id)}
        onToggle={() => props.onToggle(props.node)}
        menuProps={menuTriggers(() => props.node.id, () => props.node.title || props.node.id)}
      />
      <For each={visibleChildren()}>
        {(child, i) => {
          // childPrefix extends the parent's prefix with whether the PARENT has
          // a following sibling (its rail continues past this child). A root
          // (depth 0) contributes no rail to its children, so its children start
          // from [] — their OWN connector is the first indent column. The
          // index/isLast are computed over visibleChildren() (the actually-
          // rendered rows) so the connectors reflect what is on screen.
          const childPrefix = props.depth === 0 ? [] : [...props.prefix, !props.isLast];
          const childIsLast = i() === visibleChildren().length - 1;
          return (
            <TreeBranch node={child} depth={props.depth + 1} prefix={childPrefix} isLast={childIsLast} onToggle={props.onToggle} pinnedIds={props.pinnedIds} pathIds={props.pathIds} />
          );
        }}
      </For>
    </>
  );
}

function TreeStateView() {
  // PINS — the pinned group. Built from the FLAT map via selectPinnedNodes, so
  // a pinned node hoists here regardless of depth/collapse. `reconciledPinnedOrder`
  // is the membership+drag-order source (sidebar.ts, persisted vh.pinned.v1 +
  // vh.pinned-order.v1). `pinnedIds` is the dedup set threaded through the tree
  // walk so a hoisted node doesn't also render in its natural spot, AND the
  // protected set handed to collapse so a pinned descendant survives an
  // ancestor collapse (pin-parity fix).
  const pinnedOrder = () => reconciledPinnedOrder();
  const pinnedIds = createMemo(() => new Set(pinnedOrder()));
  const pinnedNodes = createMemo(() => selectPinnedNodes(treeMap(), pinnedOrder()));
  const emptyPinnedIds = (): Set<string> => EMPTY_SET;

  // SEARCH — flatten-to-matches over the whole flat map. A deep descendant
  // match is always surfaced because the walk is flat (no ancestor-expand
  // gate). null = search inactive (render the normal tree); [] = active but
  // no matches (render the empty state).
  const results = createMemo(() => selectSearchResults(treeMap(), searchQuery(), isPinned));

  // The keep-visible set (P0-C flood + P0-D selection reveal): activePathIds ∪
  // selectedPathIds. Threaded into TreeBranch as a reactive accessor so the
  // per-child render gate re-runs when activity OR the selection changes.
  // Reading both `treeMap()` and `selectedId()` here subscribes this memo to
  // tree mutations and selection (selection is the P0-D reactive trigger —
  // activePathIds alone never seeded on selectedId).
  const pathIds = createMemo(() => visiblePathIds(treeMap(), selectedId()));

  // Flood fix: toggle the UI expand-state, NOT the map. Collapsing a node hides
  // its resident children from the RENDER but keeps them in the flat map (no
  // fetch on re-expand). Expanding a node whose children are ALREADY resident
  // shows them with NO server round-trip; only a genuinely-unloaded node
  // (no resident children but it has descendants to fetch) calls expandTreeNode.
  //
  // The gate reads `isUserExpanded` (the UI toggle ONLY), not the old
  // active-path-∪-user `isNodeExpanded`. Effect: the twisty always reflects the
  // user's explicit intent — clicking an active-path node flips between "show
  // only my busy branch" and "show all my children" (idle siblings toggle in/
  // out), rather than being a no-op on the active path. The active-path auto-
  // reveal of the busy branch is handled by the per-child gate (visiblePathIds),
  // independent of this toggle.
  const onToggle = (n: TreeNode) => {
    if (isUserExpanded(n.id)) {
      setUserNodeExpanded(n.id, false);
      return;
    }
    setUserNodeExpanded(n.id, true);
    if (treeChildrenOf(n.id).length === 0 && ((n.descendantCount ?? 0) > 0 || n.childCount > 0)) {
      void expandTreeNode(n.id);
    }
  };

  const roots = () => treeRoots().filter((n) => !pinnedIds().has(n.id));
  const hasAnySessions = () => treeRoots().length > 0 || pinnedNodes().length > 0;

  // results() === null  → search inactive → render the normal tree (children).
  // results() !== null  → search active    → render the flat match list (fallback).
  return (
    <div class="tree tree2">
      <Show
        when={results() === null}
        fallback={
          // Search active: flat match list (pinned-first, recency-sorted), each
          // match a single self-contained row with full chip/badge/context-menu.
          // No recursion — matches render flat at depth 0 regardless of their
          // real tree depth (mirrors the old proj=1 flat-result UX).
          <Show when={results()!.length > 0} fallback={<div class="tree-empty">No matches</div>}>
            <For each={results()!}>
              {(node) => (
                <TreeRow
                  node={node}
                  depth={0}
                  selected={selectedId() === node.id}
                  expanded={false}
                  onSelect={() => openSessionChat(node.id)}
                  onToggle={() => onToggle(node)}
                  menuProps={menuTriggers(() => node.id, () => node.title || node.id)}
                />
              )}
            </For>
          </Show>
        }
      >
        <Show when={hasAnySessions()} fallback={<div class="tree-empty">No sessions yet</div>}>
          <Show when={pinnedNodes().length > 0}>
            <div class="tree-pinned">
              <For each={pinnedNodes()}>
                {(n, i) => <TreeBranch node={n} depth={0} prefix={[]} isLast={i() === pinnedNodes().length - 1} onToggle={onToggle} pinnedIds={emptyPinnedIds} pathIds={pathIds} />}
              </For>
            </div>
          </Show>
          {/* Separator between the pinned group and the rest of the tree, mirroring
              the old client's .tree-pin-sep. Only rendered when there are unpinned
              rows below to separate from. */}
          <Show when={pinnedNodes().length > 0 && roots().length > 0}>
            <div class="tree-pin-sep" />
          </Show>
          <For each={roots()}>{(n, i) => <TreeBranch node={n} depth={0} prefix={[]} isLast={i() === roots().length - 1} onToggle={onToggle} pinnedIds={pinnedIds} pathIds={pathIds} />}</For>
        </Show>
      </Show>
    </div>
  );
}

// Shared empty set for branches that should NOT dedup (the pinned group itself,
// and the flat search list — those render their rows directly with no recursion).
const EMPTY_SET: Set<string> = new Set();

export default function SessionTree() {
  return <TreeStateView />;
}
