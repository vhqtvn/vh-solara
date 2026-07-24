// TreeRow — a SELF-CONTAINED node row for the server-owned session tree.
// docs/design/server-owned-tree.md §3, §7, §8.
//
// Unlike the legacy StubNode (which represented a server-omitted collapsed
// subtree and could NOT show an agent chip or be right-clicked), EVERY TreeRow
// node carries its own display data (§3): title, agent, activity, flags,
// descendantCount. "Collapsed" is just `loaded:false` — a render attribute, NOT
// a different node type. So a collapsed node still renders its agent chip, is
// right-clickable, and opens its chat on row click. Those three are the core of
// the Phase 3 bug fixes (blank agent chip / no right-click / subagent-as-root /
// flatten-on-load / archived ghosts).
//
// This component is PRESENTATIONAL: it derives every indicator from `node`
// alone (no store, no selectors, no inference) and reports user intent via the
// injected `onSelect` / `onToggle` callbacks + `menuProps`. The caller owns
// expand/collapse wiring (treeOps fetch + collapseNode) and selection.
import { For, Show } from "solid-js";
import Icon from "./Icon";
import Spinner from "./Spinner";
import RelTime from "./RelTime";
import { agentDisplay, displayName } from "../projectSettings";
import type { TreeNode } from "../sync/treeMap";
import styles from "./TreeRow.module.css";

// The context-menu trigger handlers (right-click desktop / long-press touch),
// produced by `menuTriggers(() => id, () => title)` from ../sessionMenu. They
// are injected (not imported) so this component stays store-free and unit-
// testable without dragging the sessionMenu singleton. Spreading them onto the
// row button is what makes a collapsed node right-clickable (bug fix #5).
export interface TreeRowMenuProps {
  onContextMenu?: (e: MouseEvent) => void;
  onTouchStart?: (e: TouchEvent) => void;
  onTouchMove?: (e: TouchEvent) => void;
  onTouchEnd?: (e: TouchEvent) => void;
}

export interface TreeRowProps {
  node: TreeNode;
  depth: number;
  selected: boolean;
  // Tree guides (tree=2 UI parity, P0-A): `prefix` is one boolean per ANCESTOR
  // level — true when that ancestor has a FOLLOWING sibling (so its vertical
  // rail continues past this row). `isLast` is whether THIS node is the last
  // child of its parent (draws the elbow └ instead of the tee ├). Both are
  // computed by the TreeBranch recursion in SessionTree and default to the
  // depth-0/empty state so the flat search-results list and existing unit tests
  // (which don't pass them) render no guides — roots and flat rows stay unindented.
  prefix?: boolean[];
  isLast?: boolean;
  // UI expand state (are this node's direct children currently rendered?).
  // Distinct from `node.loaded` (are the children RESIDENT in the flat map):
  // a node can be loaded:true but UI-collapsed, or mid-fetch.
  expanded: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  menuProps?: TreeRowMenuProps;
  // True when this session finished while not selected and the server marked it
  // unread. The unread store (state.unread[id]) is a legacy sync store still
  // populated under tree=2 (unread.set/unread.clear events + snapshot unread
  // list). Passed in (not read from the store) so TreeRow stays presentational.
  unread?: boolean;
}

export function TreeRow(props: TreeRowProps) {
  const node = () => props.node;

  // All indicators derive from the SELF-CONTAINED node (§3). No parent walk,
  // no activity-map lookup, no branchStubs — the server pre-computes every
  // aggregate the UI needs (subtreeNeedsInput is the one retained subtree roll-up;
  // subtreeBusy rolls up busy/retry so a collapsed ancestor of a busy descendant
  // spins — OR'd in here alongside the node's own activity).
  const isBusy = () => node().activity === "busy" || !!node().flags.subtreeBusy;
  const isError = () => node().activity === "error";
  const isRetry = () => node().activity === "retry";
  const needsInput = () => node().flags.pendingInput || node().flags.subtreeNeedsInput;
  // A structural leaf has no direct children, ever (childCount is structural,
  // not resident-count). A collapsed node (loaded:false) with childCount>0 is
  // NOT a leaf — it shows a chevron + the "▸ N" badge.
  const isLeaf = () => node().childCount === 0;
  const hasDescendants = () => (node().descendantCount ?? 0) > 0;
  // Flood fix: the "▸ N" badge keys off the RENDER-expanded prop (are children
  // currently rendered?), NOT `node.loaded` (are children resident in the map?).
  // Under the render-gate model a node can be loaded:true but UI-collapsed — it
  // MUST still show the badge so the user sees it has hidden children to open.
  const collapsed = () => !props.expanded && hasDescendants();
  const chip = () => agentDisplay(node().agent);

  return (
    <div class="tree-row" classList={{ selected: props.selected }}>
      {/* Depth-based tree guides (P0-A): one 16px rail cell per ancestor level
          (from `prefix`), then this node's own connector — a tee (├) or, when
          `isLast`, an elbow (└). Roots (depth 0) render no cells. The CSS for
          .tree-guides/.tg-cell/.tg-connector already exists unchanged in
          legacy/20-session-tree.css (lines 22-43); this markup ports the old
          SessionTree's guide rendering verbatim. Order matches the old client:
          guides → twisty → node. */}
      <span class="tree-guides" aria-hidden="true">
        <For each={props.prefix ?? []}>{(rail) => <span class="tg-cell" classList={{ rail }} />}</For>
        <Show when={props.depth > 0}>
          <span class="tg-cell tg-connector" classList={{ last: props.isLast ?? false }} />
        </Show>
      </span>
      <button
        type="button"
        class="tree-twisty"
        classList={{ leaf: isLeaf() }}
        aria-label={props.expanded ? "Collapse" : "Expand"}
        data-tip={props.expanded ? "Collapse" : "Expand"}
        onClick={(e) => {
          e.stopPropagation();
          // A structural leaf has nothing to toggle; never fire onToggle for it
          // (keeps the twisty a no-op affordance rather than a false signal).
          if (!isLeaf()) props.onToggle(node().id);
        }}
      >
        <Show when={!isLeaf()}>
          <span classList={{ open: props.expanded }}>
            <Icon name="chevronDown" size={13} />
          </span>
        </Show>
      </button>
      {/* data-session-id mirrors the legacy proj=1 attribute (node ID == session
          ID in tree=2) so e2e specs that target a row by session ID work here. */}
      <button
        type="button"
        class="tree-node"
        classList={{
          sub: props.depth > 0,
          running: isBusy(),
          selected: props.selected,
        }}
        data-node-id={node().id}
        data-session-id={node().id}
        data-tip={"Open: " + displayName(node().title || node().id)}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelect(node().id);
        }}
        {...(props.menuProps ?? {})}
      >
        <span class="tree-line1">
          <Show when={isBusy()}>
            <Spinner class="tree-spinner" />
          </Show>
          {/* Priority indicators (mutually exclusive with the busy spinner). */}
          <Show when={!isBusy() && isError()}>
            <span class="dot error" data-tip="error" />
          </Show>
          <Show when={!isBusy() && isRetry()}>
            <span class="dot retry" data-tip="retrying" />
          </Show>
          <Show when={needsInput()}>
            <span class="dot needs-input" data-tip="needs your input — reply to continue" />
          </Show>
          <Show when={!isBusy() && !needsInput() && props.unread}>
            <span class="dot unread" data-tip="finished — not yet viewed" />
          </Show>
          {/* EVERY node carries its own agent (§3) — so a collapsed (loaded:false)
              node STILL shows its chip. This is bug fix #5: the legacy StubNode
              explicitly omitted the chip because the server omitted per-session
              agent data for collapsed subtrees; the server-owned tree fixes that
              at the source by making every node self-contained. */}
          <Show when={chip()}>
            <span
              class="tree-agent"
              data-chip={chip()!.style}
              style={chip()!.color ? { "--agent-color": chip()!.color! } : undefined}
              data-tip=""
            >
              {chip()!.label}
            </span>
          </Show>
          <span class="tree-title">{displayName(node().title || node().id)}</span>
          <span class="tree-meta">
            {/* The "▸ N" badge appears ONLY on a collapsed node with descendants
                (§3: descendantCount drives it). When loaded, the children are
                rendered below, so a count would be redundant. */}
            <Show when={collapsed()}>
              <span
                class={`tree-count ${styles.descendantBadge}`}
                data-tip={`${node().descendantCount} sessions in this collapsed branch`}
              >
                ▸ {node().descendantCount}
              </span>
            </Show>
            <RelTime class="tree-time" ms={node().updatedMs} />
          </span>
        </span>
      </button>
    </div>
  );
}

export default TreeRow;
