import { For, Show, createMemo, createEffect } from "solid-js";
import { selectedId, setSelectedId, state, expandTreeNode } from "../sync";
import { setView } from "../ui";
import {
  treeMap,
  treeRoots,
  treeChildrenOf,
  treeNode,
  modeOf,
  setNodeMode,
  setNodesMode,
  markUserToggled,
  userToggledSignal,
} from "../sync/treeState";
import {
  selectPinnedNodes,
  selectSearchResults,
  selectedPathIds,
  strictAncestors,
  effectiveTreeMode,
  working,
  hasKnownDescendants,
} from "../sync/treeSelectors";
import { childrenIndex } from "../sync/treeMap";
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

// tree=2 (4-state twisty model): render from the server-owned flat map
// (treeState). Every node is self-contained (title, agent chip, activity/flags,
// descendantCount) — there is NO client-side orphan classification, parent
// inference, or reconcile logic. The twisty reflects an EFFECTIVE display mode
// (collapsed | filtered | expanded | temp) derived from the node's persisted
// mode + the selection path + the transient userToggled overlay. Roots render
// regardless of their mode (the top-level list always shows every root row).
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
  // The INCLUSIVE selected-path set (selectedPathIds), reactive. Drives the
  // "temp" branch's single-child reveal (the one path child under a temp node).
  selectedPath: () => Set<string>;
  // The STRICT selected-ancestor set (selected node excluded), reactive. Drives
  // effectiveTreeMode's "temp" overlay so a selected nested session's ancestors
  // reveal exactly one path child without a manual expand.
  selectedAncestors: () => Set<string>;
}) {
  // Resident direct children (recency-sorted, pinned-dedup'd) — these STAY in
  // the flat map regardless of display mode (instant re-expand, no round-trip).
  const residentChildren = () =>
    treeChildrenOf(props.node.id).filter((c) => !props.pinnedIds().has(c.id));

  const persistedMode = () => modeOf(props.node.id);
  const displayState = () =>
    effectiveTreeMode(
      props.node.id,
      persistedMode(),
      props.selectedAncestors(),
      userToggledSignal(),
    );

  // visibleKids — EXACTLY four branches (proj=1 model). Children STAY resident
  // in the flat map; this only gates RENDER:
  //   collapsed — renders nothing (even working children).
  //   filtered  — renders only working children (the default).
  //   temp      — renders exactly ONE child: the next step toward the selection.
  //   expanded  — renders ALL children, working-first (stable partition within
  //               each group; sibling order preserved).
  const visibleKids = (): TreeNode[] => {
    switch (displayState()) {
      case "collapsed":
        return [];
      case "filtered":
        return residentChildren().filter(working);
      case "temp": {
        const p = props.selectedPath();
        const c = residentChildren().find((k) => p.has(k.id));
        return c ? [c] : [];
      }
      case "expanded": {
        const active: TreeNode[] = [];
        const idle: TreeNode[] = [];
        for (const c of residentChildren()) (working(c) ? active : idle).push(c);
        return [...active, ...idle];
      }
    }
  };

  // Lazy frontier: when this branch is mounted in a REVEALING mode (filtered /
  // expanded / temp) AND the node is unloaded AND it has known descendants,
  // fetch its direct children once. Reading treeNode(id) reactively re-runs the
  // effect when `loaded` flips true, which STOPS further fetches. Collapsed /
  // leaf / loaded never fetch. expandTreeNode's per-id single-flight
  // (treeExpandInFlight) is the dedup authority — no extra guard needed here.
  createEffect(() => {
    const n = treeNode(props.node.id);
    if (!n) return;
    if (n.loaded) return;
    if (!hasKnownDescendants(n)) return;
    const ds = displayState();
    if (ds === "collapsed") return; // collapsed never fetches
    void expandTreeNode(n.id);
  });

  return (
    <>
      <TreeRow
        node={props.node}
        depth={props.depth}
        prefix={props.prefix}
        isLast={props.isLast}
        selected={selectedId() === props.node.id}
        displayState={displayState()}
        unread={!!state.unread[props.node.id]}
        onSelect={() => openSessionChat(props.node.id)}
        onToggle={() => props.onToggle(props.node)}
        menuProps={menuTriggers(() => props.node.id, () => props.node.title || props.node.id)}
      />
      <For each={visibleKids()}>
        {(child, i) => {
          // childPrefix extends the parent's prefix with whether the PARENT has
          // a following sibling (its rail continues past this child). A root
          // (depth 0) contributes no rail to its children, so its children start
          // from [] — their OWN connector is the first indent column. The
          // index/isLast are computed over visibleKids() (the actually-rendered
          // rows) so the connectors reflect what is on screen.
          const childPrefix = props.depth === 0 ? [] : [...props.prefix, !props.isLast];
          const childIsLast = i() === visibleKids().length - 1;
          return (
            <TreeBranch
              node={child}
              depth={props.depth + 1}
              prefix={childPrefix}
              isLast={childIsLast}
              onToggle={props.onToggle}
              pinnedIds={props.pinnedIds}
              selectedPath={props.selectedPath}
              selectedAncestors={props.selectedAncestors}
            />
          );
        }}
      </For>
    </>
  );
}

// Resident-only DFS over current child edges (reuses the pure childrenIndex).
// Includes the root; marks non-resident descendants with NOTHING (they default
// "filtered" on later fetch). Performs NO fetch. Used by cascadeFiltered.
function residentSubtreeIds(rootId: string): string[] {
  const idx = childrenIndex(treeMap());
  const out: string[] = [];
  const stack: string[] = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    const kids = idx.get(cur);
    if (kids) for (const k of kids) stack.push(k.id);
  }
  return out;
}

function TreeStateView() {
  // PINS — the pinned group. Built from the FLAT map via selectPinnedNodes, so
  // a pinned node hoists here regardless of depth/collapse. `reconciledPinnedOrder`
  // is the membership+drag-order source (sidebar.ts, persisted vh.pinned.v1 +
  // vh.pinned-order.v1). `pinnedIds` is the dedup set threaded through the tree
  // walk so a hoisted node doesn't also render in its natural spot.
  const pinnedOrder = () => reconciledPinnedOrder();
  const pinnedIds = createMemo(() => new Set(pinnedOrder()));
  const pinnedNodes = createMemo(() => selectPinnedNodes(treeMap(), pinnedOrder()));
  const emptyPinnedIds = (): Set<string> => EMPTY_SET;

  // SEARCH — flatten-to-matches over the whole flat map. A deep descendant
  // match is always surfaced because the walk is flat (no ancestor-expand
  // gate). null = search inactive (render the normal tree); [] = active but
  // no matches (render the empty state).
  const results = createMemo(() => selectSearchResults(treeMap(), searchQuery(), isPinned));

  // The two memos threaded into TreeBranch as accessors (parallel to the old
  // pathIds/selectedAncestors threading). Reading both `treeMap()` and
  // `selectedId()` subscribes each memo to tree mutations and selection.
  const selectedPath = createMemo(() => selectedPathIds(treeMap(), selectedId()));
  const selectedAncestors = createMemo(() => strictAncestors(treeMap(), selectedId()));

  // onToggle — the proj=1 4-state transition table. Capture the effective state
  // at click BEFORE markUserToggled (so a temp node's click sees it as temp, not
  // promoted). Every click marks the CLICKED id in userToggled (the clicked id
  // ONLY — cascade marks descendants' MODES, not their toggled state). The
  // transition does NOT depend on visibleKids().length.
  //
  //   collapsed/temp → filtered + cascadeFiltered(id)   (promote + open subtree)
  //   filtered       → expanded                          (show all, working-first)
  //   expanded       → collapsed                         (hide all)
  const onToggle = (n: TreeNode) => {
    const stateAtClick = effectiveTreeMode(
      n.id,
      modeOf(n.id),
      selectedAncestors(),
      userToggledSignal(),
    );
    markUserToggled(n.id);
    switch (stateAtClick) {
      case "collapsed":
      case "temp":
        setNodeMode(n.id, "filtered");
        setNodesMode(residentSubtreeIds(n.id), "filtered"); // cascade: resident subtree → filtered
        return;
      case "filtered":
        setNodeMode(n.id, "expanded");
        return;
      case "expanded":
        setNodeMode(n.id, "collapsed");
        return;
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
                  flat={true}
                  selected={selectedId() === node.id}
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
                {(n, i) => (
                  <TreeBranch
                    node={n}
                    depth={0}
                    prefix={[]}
                    isLast={i() === pinnedNodes().length - 1}
                    onToggle={onToggle}
                    pinnedIds={emptyPinnedIds}
                    selectedPath={selectedPath}
                    selectedAncestors={selectedAncestors}
                  />
                )}
              </For>
            </div>
          </Show>
          {/* Separator between the pinned group and the rest of the tree, mirroring
              the old client's .tree-pin-sep. Only rendered when there are unpinned
              rows below to separate from. */}
          <Show when={pinnedNodes().length > 0 && roots().length > 0}>
            <div class="tree-pin-sep" />
          </Show>
          <For each={roots()}>
            {(n, i) => (
              <TreeBranch
                node={n}
                depth={0}
                prefix={[]}
                isLast={i() === roots().length - 1}
                onToggle={onToggle}
                pinnedIds={pinnedIds}
                selectedPath={selectedPath}
                selectedAncestors={selectedAncestors}
              />
            )}
          </For>
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
