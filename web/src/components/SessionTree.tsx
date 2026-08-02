import { For, Show, createMemo, createEffect, createSignal } from "solid-js";
import { selectedId, setSelectedId, state, expandTreeNode } from "../sync";
import { setView } from "../ui";
import {
  treeMap,
  treeRoots,
  treeChildrenOf,
  treeNode,
  modeOf,
  setNodeMode,
  markUserToggled,
  userToggledSignal,
} from "../sync/treeState";
import {
  selectLabeledSections,
  selectSearchResults,
  selectedPathIds,
  strictAncestors,
  effectiveTreeMode,
  effectiveExpanded,
  working,
  hasKnownDescendants,
} from "../sync/treeSelectors";
import { searchQuery, selectedTagIds } from "../sidebar";
import { reconciledPinnedOrder, isPinned } from "../pins";
import {
  labelsDoc,
  labelsGroups,
  labelsPending,
  toggleGroupCollapse,
  renameGroup,
  setGroupColor,
  deleteGroup,
  reorderGroup,
  type LabelGroup,
} from "../labels";
import { menuTriggers } from "../sessionMenu";
import { dismiss } from "../lib/a11y";
import TreeRow from "./TreeRow";
import Icon from "./Icon";
import TextPromptDialog from "./TextPromptDialog";
import { LABEL_COLORS, labelColorVar, visibleTagChips, type VisibleTagChip } from "./labelPalette";
import type { TreeNode } from "../sync/treeMap";
import styles from "./SessionTree.module.css";

// Picking a session always shows its chat — even re-clicking the already-open
// one while on another tab (Code/Changes) jumps you back to the conversation.
export const openSessionChat = (id: string) => {
  setSelectedId(id);
  setView("chat");
};

// Resolve a root's tag ids → fully-formed tag chips (id/name/color from the
// registry), capped to the visible maximum. Reads the labels facade signals so
// a tag create/delete/rename or an assignment change re-runs the memo that
// calls it. Returns [] for a root with no tags (TreeRow hides the cluster).
function rootTagChips(rootId: string): VisibleTagChip[] {
  const doc = labelsDoc();
  const ids = doc.tagIdsByRootSessionId[rootId];
  if (!ids || ids.length === 0) return [];
  const byId = new Map(doc.tags.map((t) => [t.id, t]));
  const resolved: { id: string; name: string; color: string }[] = [];
  for (const tid of ids) {
    const t = byId.get(tid);
    if (t) resolved.push({ id: t.id, name: t.name, color: t.color });
  }
  return visibleTagChips(resolved);
}

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
  // ── Labels (slice 6) — root-row-only adornments, passed to THIS branch's root
  //    TreeRow (never to recursed children: labels are root-only). Optional. ──
  // rootTags: the visible tag chips for this root (dot+abbr, max 2 + overflow).
  // rootGroupHint: when this root is pinned AND in a group, the color/name hint
  // shown beside its title (null otherwise).
  rootTags?: () => VisibleTagChip[];
  rootGroupHint?: () => { color: string; name: string } | null;
}) {
  // Resident direct children (stable activity-edge ordered via treeChildrenOf,
  // pinned-dedup'd) — these STAY in the flat map regardless of display mode
  // (instant re-expand, no round-trip).
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
        tags={props.rootTags}
        groupHint={props.rootGroupHint}
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

// GroupHeader — a labeled group's collapsible header (slice 6): color dot +
// name + member count + a collapse caret (<button aria-expanded>), plus an
// inline "⋯" manage popover (rename / recolor / move up-down / delete). The
// count reflects the VISIBLE roots in this section (already filter-applied by
// selectLabeledSections), so under an active tag filter it shows how many of
// the group's roots match.
function GroupHeader(props: {
  group: LabelGroup;
  count: number;
  filterActive: boolean;
}) {
  // One open-popover id for the whole tree (only one group's popover at a time).
  // Module-local so every GroupHeader instance shares it.
  const open = () => manageOpenId() === props.group.id;
  const toggleOpen = () => setManageOpenId(open() ? null : props.group.id);
  const expanded = () => effectiveExpanded(props.group, props.filterActive);
  const groups = () => labelsGroups();
  const onFirst = () => groups().findIndex((g) => g.id === props.group.id) === 0;
  const onLast = () => {
    const idx = groups().findIndex((g) => g.id === props.group.id);
    return idx === groups().length - 1;
  };
  return (
    <div class={styles.groupHeaderRow}>
      <button
        type="button"
        class={styles.groupToggle}
        aria-expanded={expanded()}
        aria-label={`${expanded() ? "Collapse" : "Expand"} group ${props.group.name}`}
        data-tip={`${expanded() ? "Collapse" : "Expand"}`}
        disabled={labelsPending()}
        onClick={() => void toggleGroupCollapse(props.group.id)}
      >
        <span
          class={styles.groupCaret}
          classList={{ [styles.groupCaretOpen]: expanded() }}
          aria-hidden="true"
        >
          <Icon name="chevronDown" size={12} />
        </span>
        <span class={styles.groupDot} aria-hidden="true" />
        <span class={styles.groupName}>{props.group.name}</span>
        <span class={styles.groupCount}>{props.count}</span>
      </button>
      <div class={styles.groupManageWrap} use:dismiss={() => open() && toggleOpen()}>
        <button
          type="button"
          class={styles.groupManageBtn}
          aria-label={`Manage group ${props.group.name}`}
          aria-haspopup="menu"
          aria-expanded={open()}
          onClick={toggleOpen}
        >
          <Icon name="settings" size={13} />
        </button>
        <Show when={open()}>
          <div class={styles.groupMenu} role="menu" aria-label={`Manage group ${props.group.name}`}>
            <button
              type="button"
              class={styles.groupMenuItem}
              role="menuitem"
              disabled={labelsPending()}
              onClick={() => {
                setManageOpenId(null);
                setRenameTarget({ id: props.group.id, name: props.group.name });
              }}
            >
              <Icon name="edit" size={13} /> Rename group
            </button>
            <button
              type="button"
              class={styles.groupMenuItem}
              role="menuitem"
              disabled={labelsPending() || onFirst()}
              onClick={() => {
                const idx = groups().findIndex((g) => g.id === props.group.id);
                void reorderGroup(props.group.id, idx - 1);
              }}
            >
              <Icon name="arrowUp" size={13} /> Move group up
            </button>
            <button
              type="button"
              class={styles.groupMenuItem}
              role="menuitem"
              disabled={labelsPending() || onLast()}
              onClick={() => {
                const idx = groups().findIndex((g) => g.id === props.group.id);
                void reorderGroup(props.group.id, idx + 1);
              }}
            >
              <Icon name="arrowDown" size={13} /> Move group down
            </button>
            <div class={styles.groupMenuSep} />
            <div class={styles.groupSwatches} role="group" aria-label="Group color">
              <For each={LABEL_COLORS}>
                {(c) => (
                  <button
                    type="button"
                    class={styles.groupSwatch}
                    classList={{ [styles.groupSwatchOn]: props.group.color === c }}
                    style={{ "--label-color": labelColorVar(c) }}
                    aria-label={`Color ${c}`}
                    aria-pressed={props.group.color === c}
                    disabled={labelsPending()}
                    onClick={() => void setGroupColor(props.group.id, c)}
                  />
                )}
              </For>
            </div>
            <div class={styles.groupMenuSep} />
            <button
              type="button"
              class={`${styles.groupMenuItem} ${styles.groupMenuDanger}`}
              role="menuitem"
              disabled={labelsPending()}
              onClick={() => {
                setManageOpenId(null);
                void deleteGroup(props.group.id);
              }}
            >
              <Icon name="x" size={13} /> Delete group
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

// One shared manage-popover id across all GroupHeader instances (only one open
// at a time). Lives at module scope so the dismiss directive closes it on
// outside-click uniformly.
const [manageOpenId, setManageOpenId] = createSignal<string | null>(null);
// The group currently being renamed (drives a TextPromptDialog rendered at the
// SessionTree root). null when no rename is in flight.
const [renameTarget, setRenameTarget] = createSignal<{ id: string; name: string } | null>(null);

// Resident-only DFS over current child edges was REMOVED (cascadeFiltered is
// gone — the absolute invariant makes cascade redundant for auto-promoted
// descendants and wrong for manually-collapsed-working ones).

function TreeStateView() {
  // PINS — the pinned membership/order source (pins.ts). The pinned FOREST is
  // now produced by selectLabeledSections (which delegates to selectPinnedNodes
  // unchanged — d_F1 dedup carries by construction). `pinnedIds` is the dedup
  // set threaded through the tree walk so a hoisted node doesn't also render in
  // its natural spot.
  const pinnedOrder = () => reconciledPinnedOrder();
  const pinnedIds = createMemo(() => new Set(pinnedOrder()));
  const emptyPinnedIds = (): Set<string> => EMPTY_SET;

  // The labeled partition (slice 5 selector + slice 6 render). Reads treeMap,
  // treeRoots, the reconciled pin order, the labels doc, and the active tag
  // filter — so any of those changing re-runs the partition and re-renders the
  // three sections. Render order is pinned → groups → ungrouped (DISJOINT).
  const sections = createMemo(() =>
    selectLabeledSections({
      map: treeMap(),
      rankedRoots: treeRoots(),
      pinnedOrder: pinnedOrder(),
      doc: labelsDoc(),
      selectedTagIds: selectedTagIds(),
    }),
  );

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

  // onToggle — the status-sensitive transition table. Capture the effective
  // state at click BEFORE markUserToggled (so a temp node's click sees it as
  // temp, not promoted). Every click marks ONLY the clicked id in userToggled.
  // The transition depends on working(node), NOT on visibleKids().length.
  //
  // ABSOLUTE invariant: an idle node is NEVER in "filtered". So the manual
  // click cycle is status-sensitive:
  //   idle:    collapsed|temp → expanded; filtered → expanded (defensive — an
  //            invalid pre-click state, normally normalized before interaction);
  //            expanded → collapsed   (2-state: collapsed ↔ expanded)
  //   working: collapsed|temp → filtered; filtered → expanded;
  //            expanded → collapsed   (3-state: collapsed → filtered → expanded)
  const onToggle = (n: TreeNode) => {
    const stateAtClick = effectiveTreeMode(
      n.id,
      modeOf(n.id),
      selectedAncestors(),
      userToggledSignal(),
    );
    markUserToggled(n.id);
    const isWorking = working(n);
    switch (stateAtClick) {
      case "collapsed":
      case "temp":
        setNodeMode(n.id, isWorking ? "filtered" : "expanded");
        return;
      case "filtered":
        setNodeMode(n.id, "expanded");
        return;
      case "expanded":
        setNodeMode(n.id, "collapsed");
        return;
    }
  };

  const filterActive = () => selectedTagIds().length > 0;
  const hasAnySessions = () =>
    treeRoots().length > 0 ||
    sections().pinned.length > 0 ||
    sections().groups.length > 0;

  // A per-root tags accessor bound to an id, for the <For> bodies. Returns the
  // visible chips; memoized implicitly by the partition re-running on labels
  // signal changes (rootTagChips reads labelsDoc()).
  const tagsFor = (id: string) => () => rootTagChips(id);

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
          {/* PINNED section — the hoisted pinned forest. selectLabeledSections
              delegates to selectPinnedNodes (d_F1 dedup unchanged); each pinned
              root carries its group hint so the row shows where it returns on
              unpin. A pinned root that also has tags still shows its chips. */}
          <Show when={sections().pinned.length > 0}>
            <div class="tree-pinned">
              <For each={sections().pinned}>
                {(item, i) => (
                  <TreeBranch
                    node={item.node}
                    depth={0}
                    prefix={[]}
                    isLast={i() === sections().pinned.length - 1}
                    onToggle={onToggle}
                    pinnedIds={emptyPinnedIds}
                    selectedPath={selectedPath}
                    selectedAncestors={selectedAncestors}
                    rootTags={tagsFor(item.node.id)}
                    rootGroupHint={() =>
                      item.group ? { color: item.group.color, name: item.group.name } : null
                    }
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={sections().pinned.length > 0 && (sections().groups.length > 0 || sections().ungrouped.length > 0)}>
            <div class="tree-pin-sep" />
          </Show>
          {/* GROUPS section — each labeled group: a collapsible header followed
              by its resident root rows (in the group's authoritative order).
              Under an active tag filter, empty groups are already suppressed by
              selectLabeledSections and matching groups render expanded
              (effectiveExpanded masks stored `collapsed` without overwriting). */}
          <For each={sections().groups}>
            {(sec) => (
              <div
                class={styles.group}
                data-group-id={sec.group.id}
                style={{ "--label-color": labelColorVar(sec.group.color) }}
              >
                <GroupHeader
                  group={sec.group}
                  count={sec.roots.length}
                  filterActive={filterActive()}
                />
                <Show when={effectiveExpanded(sec.group, filterActive())}>
                  <div class={styles.groupBody}>
                    <For each={sec.roots}>
                      {(n, i) => (
                        <TreeBranch
                          node={n}
                          depth={0}
                          prefix={[]}
                          isLast={i() === sec.roots.length - 1}
                          onToggle={onToggle}
                          pinnedIds={pinnedIds}
                          selectedPath={selectedPath}
                          selectedAncestors={selectedAncestors}
                          rootTags={tagsFor(n.id)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>
          {/* UNGROUPED section — resident roots not pinned and not in any group,
              in presentation-rank order. */}
          <For each={sections().ungrouped}>
            {(n, i) => (
              <TreeBranch
                node={n}
                depth={0}
                prefix={[]}
                isLast={i() === sections().ungrouped.length - 1}
                onToggle={onToggle}
                pinnedIds={pinnedIds}
                selectedPath={selectedPath}
                selectedAncestors={selectedAncestors}
                rootTags={tagsFor(n.id)}
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
  return (
    <>
      <TreeStateView />
      {/* Group rename dialog (slice 6). One shared instance; renameTarget holds
          the group being renamed. Empty name cancels (keeps the current name). */}
      <TextPromptDialog
        open={!!renameTarget()}
        title="Rename group"
        initial={renameTarget()?.name ?? ""}
        confirmText="Rename"
        onCancel={() => setRenameTarget(null)}
        onConfirm={(v) => {
          const t = renameTarget();
          if (t && v.trim()) void renameGroup(t.id, v.trim());
          setRenameTarget(null);
        }}
      />
    </>
  );
}
