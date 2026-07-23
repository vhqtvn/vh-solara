import { For, Show } from "solid-js";
import { selectedId, setSelectedId, state, expandTreeNode } from "../sync";
import { setView } from "../ui";
import { treeRoots, treeChildrenOf, collapseTreeNode } from "../sync/treeState";
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
function TreeBranch(props: {
  node: TreeNode;
  depth: number;
  onToggle: (n: TreeNode) => void;
}) {
  // expanded mirrors the node's loaded flag (§3: loaded is a render attribute,
  // not a node kind). Reads the reactive treeState accessor so a collapse (which
  // drops loaded descendants + flips loaded:false) re-renders this branch closed.
  const expanded = () => treeChildrenOf(props.node.id);
  return (
    <>
      <TreeRow
        node={props.node}
        depth={props.depth}
        selected={selectedId() === props.node.id}
        expanded={expanded().length > 0}
        unread={!!state.unread[props.node.id]}
        onSelect={() => openSessionChat(props.node.id)}
        onToggle={() => props.onToggle(props.node)}
        menuProps={menuTriggers(() => props.node.id, () => props.node.title || props.node.id)}
      />
      <For each={expanded()}>
        {(child) => (
          <TreeBranch node={child} depth={props.depth + 1} onToggle={props.onToggle} />
        )}
      </For>
    </>
  );
}

function TreeStateView() {
  // §8: expand = fetch direct children (treeOps.fetchChildren via stream's
  // expandTreeNode, single-flight + F1 staleCursor fix); collapse = client-only
  // drop of loaded descendants keeping the placeholder (treeState.collapseTreeNode).
  // A node with loaded children collapses; a node with descendants but no loaded
  // children expands. Leaf nodes (childCount===0) toggle is a no-op via TreeRow's
  // own isLeaf guard.
  const onToggle = (n: TreeNode) => {
    if (treeChildrenOf(n.id).length > 0) collapseTreeNode(n.id);
    else if ((n.descendantCount ?? 0) > 0 || n.childCount > 0) void expandTreeNode(n.id);
  };
  const roots = () => treeRoots();
  return (
    <div class="tree tree2">
      <Show
        when={roots().length > 0}
        fallback={<div class="tree-empty">No sessions yet</div>}
      >
        <For each={roots()}>{(n) => <TreeBranch node={n} depth={0} onToggle={onToggle} />}</For>
      </Show>
    </div>
  );
}

export default function SessionTree() {
  return <TreeStateView />;
}
