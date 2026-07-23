import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js";
import { createSignal } from "solid-js";
import { selectedId, setSelectedId, state, sessionNeedsInput, sessionLastAgent } from "../sync";
import { agentDisplay, displayName } from "../projectSettings";
import { setView } from "../ui";

// Picking a session always shows its chat — even re-clicking the already-open
// one while on another tab (Code/Changes) jumps you back to the conversation.
// Exported so StubNode's row button can open a collapsed-branch stub's chat
// (idle-root-unopenable fix): a stub's row click routes here exactly like a
// materialized Node row, while the separate twisty stays the expand/collapse path.
export const openSessionChat = (id: string) => {
  setSelectedId(id);
  setView("chat");
};
import { treeDensity } from "../prefs";
import { isPinned, searchQuery, reconciledPinnedOrder, movePinnedTo } from "../sidebar";
import { buildChildrenIndex } from "../lib/reduce";
import { menuTriggers } from "../sessionMenu";
import type { Session } from "../types";
import Icon from "./Icon";
import Spinner from "./Spinner";
import { loadVersioned, saveVersioned } from "../lib/store";
import RelTime from "./RelTime";
import { formatDuration } from "../lib/time";
// Phase 5: StubNode renders collapsed-branch stubs. Imported for type + render
// of stub children inside Node (idle frontier under an active ancestor).
import StubNode from "./StubNode";
import type { CollapsedBranchStub } from "../types";
// Phase 3 Step A (COEXIST): tree=2 render path. When tree2Enabled() is true the
// tree renders from the server-owned flat map (treeState) via TreeRow instead of
// the projection path (state.sessions + Node/StubNode). The flag-OFF body below
// is byte-for-byte unchanged; these imports are only consumed by the TreeStateView
// branch at the top of SessionTree().
import { tree2Enabled } from "../sync/url";
import { treeRoots, treeChildrenOf, collapseTreeNode } from "../sync/treeState";
import { expandTreeNode } from "../sync";
import TreeRow from "./TreeRow";
import type { TreeNode } from "../sync/treeMap";

// --- per-node expand state ----------------------------------------------------
// Persisted state, cycled by clicking the twisty:
//   collapsed — no children shown (footer summarizes hidden running/idle counts)
//   filtered  — only children whose subtree is running (footer: hidden idle)
//   expanded  — all children, running grouped first
// Plus a transient `temp` (auto): an ancestor of the active session is revealed
// to JUST the child on the path. Default for an untouched node is `filtered`.
type TreeMode = "collapsed" | "filtered" | "expanded";
type DisplayState = TreeMode | "temp";
const LS_MODE = "vh.tree.mode.v2";

function loadModes(): Record<string, TreeMode> {
  const m = loadVersioned<Record<string, TreeMode>>(LS_MODE, 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, TreeMode>) : {},
  );
  if (Object.keys(m).length) return m;
  // Migrate the previous open/closed/running map.
  const old = loadVersioned<Record<string, string>>("vh.tree.mode.v1", 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, string>) : {},
  );
  const map: Record<string, TreeMode> = {};
  for (const [k, v] of Object.entries(old)) {
    map[k] = v === "open" ? "expanded" : v === "running" ? "filtered" : "collapsed";
  }
  return map;
}

const [treeMode, setTreeMode] = createSignal<Record<string, TreeMode>>(loadModes());
const modeOf = (id: string): TreeMode => treeMode()[id] || "filtered";
// Nodes the user toggled during the current selection — their persisted state
// then wins over the auto `temp` reveal (only for that node, until selection
// changes).
const [userToggled, setUserToggled] = createSignal<Set<string>>(new Set());

// Test-only: reset the module-level signals so test cases don't leak state.
// treeMode/userToggled are initialized once at first import; localStorage.clear()
// wipes the persisted backing store but NOT the in-memory signal, so without this
// a prior test's persisted/toggled entries survive into the next render.
// Component-instance state (prevWorking/didInit/prevSessionKeys) is fresh per
// render() and is intentionally not touched here.
export function __resetTreeForTest() {
  setTreeMode(loadModes());
  setUserToggled(new Set<string>());
}

function persist(next: Record<string, TreeMode>) {
  saveVersioned(LS_MODE, 1, next);
  setTreeMode(next);
}
function setMode(id: string, m: TreeMode) {
  persist({ ...treeMode(), [id]: m });
  setUserToggled((s) => new Set(s).add(id));
}
// collapsed/temp → filtered, recursively for the whole subtree (so the running
// paths expand all the way down).
function cascadeFiltered(id: string) {
  const next = { ...treeMode() };
  const stack = [id];
  let guard = 0;
  while (stack.length && guard++ < 100000) {
    const cur = stack.pop()!;
    next[cur] = "filtered";
    for (const c of Object.values(state.sessions)) if (c.parentID === cur) stack.push(c.id);
  }
  persist(next);
  setUserToggled((s) => new Set(s).add(id));
}
// Click behaviour keyed off the EFFECTIVE display state:
//   collapsed | temp → filtered (+cascade); filtered → expanded; expanded → collapsed
function onTwisty(id: string, d: DisplayState) {
  if (d === "collapsed" || d === "temp") cascadeFiltered(id);
  else if (d === "filtered") setMode(id, "expanded");
  else setMode(id, "collapsed");
}

// Strict ancestors (parent chain) of the active session.
function selectedAncestors(): Set<string> {
  const set = new Set<string>();
  let cur = selectedId() ? state.sessions[selectedId()!]?.parentID : undefined;
  let guard = 0;
  while (cur && guard++ < 100000) {
    set.add(cur);
    cur = state.sessions[cur]?.parentID;
  }
  return set;
}

// Ids whose SUBTREE is running (self busy/retry, or any descendant is) — built
// once per render by propagating busy sessions up their parent chain, so the
// tree doesn't do a subtree walk per node.
function buildWorkingSet(): Set<string> {
  const set = new Set<string>();
  // NOTE: index each value (state.activity[id]) rather than Object.entries() —
  // a Solid store's entries/values track only the KEY SET, not value changes, so
  // Object.entries would recompute only when a session is added/removed (e.g. a
  // new subsession) and miss a session simply flipping busy↔idle. Reading via the
  // proxy get-trap subscribes to each value, so live status updates land.
  for (const id of Object.keys(state.activity)) {
    const act = state.activity[id];
    if (act === "busy" || act === "retry") set.add(id);
  }
  // Phase 5: a collapsed-branch stub with busy/retry aggregate state represents
  // a subtree with active work underneath. Its parent chain must be in the
  // working set so the auto-tidy effect doesn't collapse the branch (hiding the
  // busy stub in filtered mode). Propagate the stub's parent up the chain,
  // mirroring the session-activity propagation below.
  for (const stub of Object.values(state.branchStubs)) {
    if (stub.aggregateState === "busy" || stub.aggregateState === "retry") {
      let cur = stub.parentID;
      while (cur && !set.has(cur)) {
        set.add(cur);
        cur = state.sessions[cur]?.parentID;
      }
    }
  }
  for (const id of [...set]) {
    let cur = state.sessions[id]?.parentID;
    while (cur && !set.has(cur)) {
      set.add(cur);
      cur = state.sessions[cur]?.parentID;
    }
  }
  return set;
}

// The per-agent badge on a session row: a compact colored chip for the session's
// most-recent agent, shown only when the project gave that agent a label
// (agentStyles in .vh-solara/project.jsonc) — so the list stays quiet by default.
function AgentChip(props: { sessionID: string }) {
  const name = () => sessionLastAgent(props.sessionID);
  const d = () => agentDisplay(name());
  return (
    <Show when={d()?.label}>
      <span
        class="tree-agent"
        data-chip={d()!.style}
        style={d()!.color ? { "--agent-color": d()!.color! } : undefined}
        data-tip={`Agent: ${name()}`}
      >
        {d()!.label}
      </span>
    </Show>
  );
}

// Exported for StubNode.tsx (Phase 5): stubs delegate materialized session
// children to this Node component. The circular import (StubNode → SessionTree
// → StubNode) is broken by ESM live-binding: Node is only CALLED at render
// time, never at module-eval time, so the TDZ is never hit.
export function Node(props: {
  session: Session;
  depth: number;
  prefix: boolean[];
  isLast: boolean;
  index: () => Record<string, Session[]>;
  ancestors: () => Set<string>;
  working: (id: string) => boolean;
  // Pinned-root drag-to-reorder affordance. Only set for pinned root rows
  // (depth 0 inside .tree-pinned). When set, the row carries a drag handle and
  // reflects the in-flight DnD state (source dimming + drop indicator).
  pinnedDnd?: {
    onHandleDown: (e: PointerEvent) => void;
    dragging: boolean;
    drop: "before" | "after" | null;
  };
}) {
  const kids = () => props.index()[props.session.id] || [];
  // Phase 5: stub children — collapsed-branch stubs whose parent is this
  // session (the idle frontier under an active ancestor). These are NOT in
  // the session index (they're in state.branchStubs), so they need a separate
  // accessor. Display-mode filtering applies to them too: a filtered node
  // shows only stubs with active work underneath (busy/retry/needs-input).
  // Dedup invariant (stub-vs-session): a stub whose OWN id is a live,
  // materialized session must NOT render. When a session is demoted to a stub
  // the merge layer (applyProjectedSnapshot) clears+rebuilds state.branchStubs
  // but never removes the now-stale state.sessions[id] (preserve-absent is
  // load-bearing for lazy-expand / partial snapshots). That leaves both maps
  // holding the same id. The materialized <Node> always wins — it carries the
  // full payload — so the stale stub is suppressed here at the source. This
  // single guard covers both visibleStubKids() (the render path) and the
  // twisty leaf-check (stubKids().length === 0).
  const stubKids = (): CollapsedBranchStub[] =>
    Object.values(state.branchStubs).filter(
      (s) => s.parentID === props.session.id && !state.sessions[s.id],
    );
  // A materialized node may have ONLY stub children (the common O1 workload:
  // an active root whose direct descendants are idle subagents collapsed into
  // frontier stubs). The twisty — leaf state, click handler, chevron, count —
  // must treat stub children as real children, otherwise the twisty is an inert
  // blank square: leaf=false (the leaf check already counts stubKids) but no
  // chevron renders and the click is a no-op, so the idle stubs stay hidden
  // forever. hasAnyChildren unifies both kinds for every UI affordance.
  const hasAnyChildren = () => kids().length > 0 || stubKids().length > 0;
  const visibleStubKids = (): CollapsedBranchStub[] => {
    switch (display()) {
      case "collapsed":
        return [];
      case "filtered":
        return stubKids().filter(
          (s) =>
            s.aggregateState === "busy" ||
            s.aggregateState === "retry" ||
            s.aggregateState === "needs-input",
        );
      case "temp":
        return []; // path goes through sessions only — can't select a stub
      default:
        return stubKids(); // expanded: all stubs
    }
  };
  const activity = () => state.activity[props.session.id] || "idle";
  const busy = () => props.working(props.session.id);
  // Subtree has a pending permission/question awaiting a typed reply. Reactive —
  // clears itself the moment the request is answered.
  const needsInput = () => sessionNeedsInput(props.session.id);
  // Detailed line-2 stats: running/idle across ALL direct children (not just
  // hidden ones — this is an always-on summary, unlike the expand-state footer).
  const runCount = () => kids().filter((c) => props.working(c.id)).length;
  const idleCount = () => kids().length - runCount();
  // How long the session ran (created → last updated). Only meaningful once the
  // session has FINISHED (see the !busy() guard at the render site); empty when
  // unknown or sub-second so we don't print "ran for 0s".
  const ranFor = () => {
    const c = props.session.time?.created;
    const u = props.session.time?.updated;
    if (!c || !u || u <= c) return "";
    const span = u - c;
    // Seconds wouldn't tick live (the line isn't a live timer), so a stale "8s"
    // reads as wrong — collapse anything under a minute to "<1m".
    return span < 60_000 ? "<1m" : formatDuration(span);
  };

  const display = (): DisplayState => {
    const id = props.session.id;
    const m = modeOf(id);
    // An ancestor of the active session that would otherwise hide the path is
    // temporarily revealed (to just the path child).
    if (m !== "expanded" && props.ancestors().has(id) && !userToggled().has(id)) return "temp";
    return m;
  };

  // The single direct child on the path to the active session (for temp).
  const pathChild = (): Session | undefined => {
    const active = selectedId();
    return kids().find((c) => c.id === active || props.ancestors().has(c.id));
  };

  const visibleKids = (): Session[] => {
    const k = kids();
    switch (display()) {
      case "collapsed":
        return [];
      case "filtered":
        return k.filter((c) => props.working(c.id));
      case "temp": {
        const p = pathChild();
        return p ? [p] : [];
      }
      default: {
        // expanded: running children first, idle after (recency kept within each).
        const running = k.filter((c) => props.working(c.id));
        const idle = k.filter((c) => !props.working(c.id));
        return [...running, ...idle];
      }
    }
  };

  // Counts of HIDDEN direct children (running/idle) for the footer.
  const hidden = (): { running: number; idle: number } => {
    const k = kids();
    let running = 0;
    let idle = 0;
    for (const c of k) (props.working(c.id) ? running++ : idle++);
    switch (display()) {
      case "collapsed":
        return { running, idle }; // all hidden
      case "filtered":
        return { running: 0, idle }; // running shown, idle hidden
      case "temp": {
        const p = pathChild();
        if (p) props.working(p.id) ? running-- : idle--;
        return { running: Math.max(0, running), idle: Math.max(0, idle) };
      }
      default:
        return { running: 0, idle: 0 }; // expanded: nothing hidden
    }
  };

  const childPrefix = () => (props.depth === 0 ? [] : [...props.prefix, !props.isLast]);
  // In detailed density the node's own second line already shows the
  // running/idle counts, so the separate footer row would just duplicate them.
  const hasFooter = () =>
    treeDensity() !== "detailed" && hasAnyChildren() && hidden().running + hidden().idle > 0;

  return (
    <>
      <div
        class="tree-row"
        classList={{
          selected: selectedId() === props.session.id,
          dragging: !!props.pinnedDnd?.dragging,
          "drop-before": props.pinnedDnd?.drop === "before",
          "drop-after": props.pinnedDnd?.drop === "after",
        }}
        data-pinned-id={props.pinnedDnd ? props.session.id : undefined}
      >
        <span class="tree-guides" aria-hidden="true">
          <For each={props.prefix}>{(rail) => <span class="tg-cell" classList={{ rail }} />}</For>
          <Show when={props.depth > 0}>
            <span class="tg-cell tg-connector" classList={{ last: props.isLast }} />
          </Show>
        </span>
        <button
          type="button"
          class="tree-twisty"
          classList={{ leaf: !hasAnyChildren() }}
          aria-label={`Subtree: ${display()} (click to cycle)`}
          data-tip={`Subtree: ${display()}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasAnyChildren()) onTwisty(props.session.id, display());
          }}
        >
          <Show when={hasAnyChildren()}>
            {/* expanded=chevron-down, collapsed=chevron-right (rotated),
                filtered=funnel, temp=eye. */}
            <Switch>
              {/* The funnel marks a `filtered` node ONLY while its subtree has
                  live work. An idle filtered node (the default mode for every
                  untouched parent) renders the ordinary chevron below — otherwise
                  it would pulse forever even with nothing running underneath. */}
              <Match when={display() === "filtered" && (busy() || runCount() > 0)}>
                <span class="twisty-running"><Icon name="filter" size={12} /></span>
              </Match>
              <Match when={display() === "temp"}>
                <span class="twisty-temp"><Icon name="eye" size={12} /></span>
              </Match>
              <Match when={true}>
                <span classList={{ open: display() === "expanded" }}><Icon name="chevronDown" size={13} /></span>
              </Match>
            </Switch>
          </Show>
        </button>
        <button
          type="button"
          class="tree-node"
          classList={{ selected: selectedId() === props.session.id, sub: props.depth > 0, running: busy(), detailed: treeDensity() === "detailed" }}
          onClick={() => openSessionChat(props.session.id)}
          data-session-id={props.session.id}
          data-tip={displayName(props.session.title || props.session.id)}
          {...menuTriggers(() => props.session.id, () => props.session.title || props.session.id)}
        >
          <span class="tree-line1">
            <Show when={busy()}>
              <Spinner class="tree-spinner" />
            </Show>
            <Show when={!busy() && activity() === "error"}>
              <span class="dot error" data-tip="error" />
            </Show>
            {/* Needs input: a pending permission/question (here or in a subagent)
                that's blocking until you reply. Takes visual priority. */}
            <Show when={needsInput()}>
              <span class="dot needs-input" data-tip="needs your input — reply to continue" />
            </Show>
            {/* Finished-unread: a root task that completed but hasn't been viewed. */}
            <Show when={!busy() && !needsInput() && state.unread[props.session.id]}>
              <span class="dot unread" data-tip="finished — not yet viewed" />
            </Show>
            {/* Transient per-session loading indicator: shown ONLY while THIS
                session's full message history is actively being fetched
                (messagesLoaded===false — the row was selected and Stream-2
                reserved the slot / delivered a cold partial snapshot, now awaiting
                messages.loaded). It is NOT shown for idle never-opened sessions
                (messagesLoaded===undefined): those are lazily unfetched by design
                (Go Hydrated is false-by-design until first open), not "loading."
                Cleared the moment the fetch completes. Driven by messagesLoaded,
                NOT hydrated: hydrated conflates "never lazily fetched" with
                "actively aggregating," so keying off it armed the dot PERMANENTLY
                on every idle never-opened session. Suppressed while busy() so the
                running-agent spinner wins. */}
            <Show when={state.status === "live" && state.messagesLoaded[props.session.id] === false && !busy()}>
              <span class="dot hydrating" data-tip="loading from server…" />
            </Show>
            {/* Warm silent-swap indicator: the session's Stream-2 connection is
                open and we are showing cached/stale message state while its fresh
                authoritative snapshot is still in flight (the ~5s daemon-side
                serve). Distinct from .dot.hydrating (cold-open, messagesLoaded
                ===false): shown ONLY on a WARM reopen (messagesLoaded !== false)
                so the two never stack — the `!== false` here is a de-dup guard,
                NOT the driver (the driver is solely state.refreshing[id]). Cleared
                the instant the snapshot lands. Suppressed while busy() so the
                running spinner wins. */}
            <Show when={state.status === "live" && state.refreshing[props.session.id] && state.messagesLoaded[props.session.id] !== false && !busy()}>
              <span class="dot refreshing" data-tip="refreshing from server…" />
            </Show>
            <AgentChip sessionID={props.session.id} />
            <span class="tree-title" classList={{ unread: !busy() && !!state.unread[props.session.id], "needs-input": needsInput() }}>
              {displayName(props.session.title || props.session.id)}
            </span>
            <span class="tree-meta">
              <Show when={hasAnyChildren()}>
                <span class="tree-count">{kids().length + stubKids().length}</span>
              </Show>
              <RelTime class="tree-time" ms={props.session.time?.updated || props.session.time?.created} />
            </span>
          </span>
          {/* Detailed mode: a second line. Direct-children running/idle counts
              when there are any, else the session's own facts (started + tokens). */}
          <Show when={treeDensity() === "detailed"}>
            <span class="tree-sub">
              <Show
                when={kids().length > 0}
                fallback={
                  <span class="tree-sub-started">
                    started <RelTime mode="ago" ms={props.session.time?.created} />
                    {/* Only for a FINISHED session: while it's still running,
                        "ran for" (created→last-event) lags behind "started ago"
                        and reads as wrong, so omit it. */}
                    <Show when={!busy() && ranFor()}>{`, ran for ${ranFor()}`}</Show>
                  </span>
                }
              >
                <Show when={runCount() > 0}>
                  <span class="tree-sub-run">{runCount()} running</span>
                </Show>
                <Show when={idleCount() > 0}>
                  <span class="tree-sub-idle">{idleCount()} idle</span>
                </Show>
              </Show>
            </span>
          </Show>
        </button>
        {/* Drag handle for reorderable pinned roots only. Sibling of .tree-node
            inside .tree-row, so a touch on it does NOT bubble to .tree-node's
            context-menu touch handlers (siblings, not ancestors) — clean gesture
            separation, no long-press-menu conflict. Pointer-only affordance;
            keyboard reorder is a deferred follow-up (AT users still have
            pin/unpin via the row's context menu). */}
        <Show when={props.pinnedDnd}>
          <span
            class="tree-drag"
            data-tip="Drag to reorder"
            title="Drag to reorder"
            onPointerDown={(e) => props.pinnedDnd!.onHandleDown(e)}
          >
            <Icon name="grip" size={14} />
          </span>
        </Show>
      </div>

      <For each={visibleKids()}>
        {(child, i) => (
          <Node
            session={child}
            depth={props.depth + 1}
            prefix={childPrefix()}
            isLast={!hasFooter() && i() === visibleKids().length - 1}
            index={props.index}
            ancestors={props.ancestors}
            working={props.working}
          />
        )}
      </For>

      {/* Phase 5: collapsed-branch stub children (the idle frontier under an
          active ancestor). Rendered after session children; display-mode
          filtered (collapsed/temp hide them; filtered shows busy/retry/
          needs-input stubs; expanded shows all). Each StubNode handles its
          own expand/collapse + lazy-fetch. */}
      <For each={visibleStubKids()}>
        {(stub) => (
          <StubNode
            stub={stub}
            depth={props.depth + 1}
            prefix={childPrefix()}
            isLast={true}
            index={props.index}
            ancestors={props.ancestors}
            working={props.working}
          />
        )}
      </For>

      {/* Footer: what's hidden here (running/idle of direct children). */}
      <Show when={hasFooter()}>
        <div class="tree-row tree-footer-row">
          <span class="tree-guides" aria-hidden="true">
            <For each={childPrefix()}>{(rail) => <span class="tg-cell" classList={{ rail }} />}</For>
            <span class="tg-cell tg-connector last" />
          </span>
          {/* A line that stretches across the row, pushing the hidden-counts to
              the right (so the footer reads as a continuation of this branch). */}
          <span class="tree-footer-rule" aria-hidden="true" />
          <span class="tree-footer">
            <Show when={hidden().running > 0}>
              <span class="tree-footer-run">{hidden().running} running</span>
            </Show>
            <Show when={hidden().idle > 0}>
              <span class="tree-footer-idle">{hidden().idle} idle</span>
            </Show>
          </span>
        </div>
      </Show>
    </>
  );
}

// === Phase 3 Step A (COEXIST): tree=2 render path ===========================
// TreeStateView renders the tree from the server-owned flat map (treeState)
// instead of the projection layer (state.sessions). Every node is self-contained
// (title, agent chip, activity/flags, descendantCount) — there is NO client-side
// orphan classification, parent inference, or reconcile logic. Collapsed nodes
// (loaded:false with descendants) still render via TreeRow with their chip +
// "▸ N" badge and are right-clickable; expansion fetches direct children from
// the server (§8); collapse is client-only (§8.4). COEXIST: the flag-OFF path
// (the original SessionTree body below) is untouched.
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
  // Phase 3 Step A (COEXIST): early-return the tree=2 render path BEFORE any of
  // the proj=1 memo/signal setup, so the entire flag-OFF body below runs
  // unchanged. The capability is read once per render pass (cheap; the §10 flag
  // is a plain URL query, no caching needed). Removing ?tree=2 and reloading
  // restores the exact original path.
  if (tree2Enabled()) return <TreeStateView />;
  const working = createMemo(() => buildWorkingSet());
  const index = createMemo(() => buildChildrenIndex(state.sessions, (s) => working().has(s.id)));
  const roots = () => index()[""] || [];
  // Phase 5: stub roots — collapsed-branch stubs whose parent is absent or not
  // materialized (they're roots in the projected tree, even though the server
  // collapsed their entire subtree into a single stub). These render alongside
  // session roots, sorted by recency.
  // Dedup invariant (stub-vs-session): suppress a stub whose own id is a live,
  // materialized session — see the matching guard on Node.stubKids(). The
  // materialized <Node> (rendered via the session index / roots) always wins.
  const stubRoots = () =>
    Object.values(state.branchStubs).filter(
      (s) => (!s.parentID || !state.sessions[s.parentID]) && !state.sessions[s.id],
    );
  const ancestors = createMemo(() => selectedAncestors());
  const isWorking = (id: string) => working().has(id);
  // Selecting a different session reverts temporary auto-expansions: clear the
  // manual-toggle overrides so the new path reveals fresh and the previous one
  // returns to its persisted state.
  createEffect(() => {
    selectedId();
    setUserToggled(new Set<string>());
  });
  // Auto-tidy as work starts/stops: a collapsed node that starts running opens
  // to filtered (surfaces the active work); a filtered node that goes idle
  // collapses (nothing left to show). Expanded nodes are left alone.
  let prevWorking = new Set<string>();
  // Session keys seen on the previous effect run. The init pass is one-shot, so
  // a session syncing in AFTER mount (didInit already true) in an idle +
  // default-filtered state isn't caught by the delta loops (they only collapse
  // nodes they observed LEAVE the working set). Tracking seen keys lets a later
  // run collapse only the NEWLY-arrived idle filtered newcomers.
  let prevSessionKeys = new Set<string>();
  // One-shot init: the delta logic below only collapses a filtered node when it
  // SEES it leave the working set — but prevWorking starts empty, so a node
  // whose mode is the default `filtered` and whose subtree finished BEFORE this
  // mount is never caught (it sits in `filtered` showing zero children). On the
  // first run we collapse every filtered node that isn't in the working set.
  // This is once-only; later start/stop transitions are the delta logic's job.
  // (An ancestor of the active session still reveals its path via `temp` —
  // display() keys that off m !== "expanded", so a collapsed mode resolves too.)
  let didInit = false;
  createEffect(() => {
    const w = working();
    // Read current modes (so a concurrent manual toggle isn't clobbered). The
    // prevWorking guard makes a re-run from our own persist a no-op, so the
    // delta passes below can't loop; the late-arrival pass is likewise guarded
    // by prevSessionKeys (newcomers are folded into it the same run they're
    // collapsed). Reading allKeys unconditionally also keeps the effect
    // subscribed to the session key set after init, so a post-mount arrival
    // actually re-runs this effect.
    const modes = treeMode();
    const next = { ...modes };
    let changed = false;
    const allKeys = Object.keys(state.sessions);
    const currentKeys = new Set(allKeys);
    if (!didInit) {
      // First mount: collapse default/persisted `filtered` nodes whose subtree
      // has no running work. Reads `next` (== modes at this point) so it stays
      // consistent with the delta pass below and shares the single persist().
      for (const id of allKeys) {
        if ((next[id] ?? "filtered") === "filtered" && !w.has(id)) {
          next[id] = "collapsed";
          changed = true;
        }
      }
      didInit = true;
    } else {
      // Post-mount late arrival: the init pass is one-shot, but a session that
      // syncs in AFTER mount in an idle + default-`filtered` state would
      // otherwise sit open showing zero children — the delta loops only
      // collapse nodes they observed LEAVE the working set, and a newcomer was
      // never in prevWorking. Collapse only the NEWLY-arrived idle filtered
      // nodes. A newly-arrived BUSY session is in `w`, so `!w.has(id)` is false
      // and it stays filtered (running children visible). A late-arriving idle
      // ancestor of the active session still reveals its path via `temp` —
      // display() keys that off m !== "expanded", so a collapsed mode resolves
      // (same guarantee the init pass relies on).
      for (const id of allKeys) {
        if (!prevSessionKeys.has(id) && (next[id] ?? "filtered") === "filtered" && !w.has(id)) {
          next[id] = "collapsed";
          changed = true;
        }
      }
    }
    prevSessionKeys = currentKeys;
    for (const id of w) {
      if (!prevWorking.has(id) && (modes[id] ?? "filtered") === "collapsed") {
        next[id] = "filtered";
        changed = true;
      }
    }
    for (const id of prevWorking) {
      if (!w.has(id) && (modes[id] ?? "filtered") === "filtered") {
        next[id] = "collapsed";
        changed = true;
      }
    }
    prevWorking = new Set(w);
    if (changed) persist(next);
  });
  // Pinned roots float to the top as a distinct, tinted group; the rest follow.
  // Position (above the divider) is the pin signal — no per-row pin marker. The
  // pinned group is also reorderable by drag: the order comes from the
  // persisted pinned-order array (reconciled against membership), so a root
  // synced in later still lands in its saved slot; a pinned id whose session
  // hasn't synced yet is dropped here and reappears in place once it does.
  const pinnedRoots = createMemo(() => {
    const byId = new Map(roots().map((s) => [s.id, s] as const));
    return reconciledPinnedOrder()
      .map((id) => byId.get(id))
      .filter((s): s is Session => !!s);
  });
  const unpinnedRoots = createMemo(() => roots().filter((s) => !isPinned(s.id)));

  // --- pinned-root drag-to-reorder -----------------------------------------
  // Pointer-event based (works on touch + mouse; HTML5 DnD alone is insufficient
  // on touch). Follows the repo's established resize-handle pattern
  // (Sidebar.tsx startResize, CodeFrame.tsx startResize): capture the pointer on
  // the handle, listen for move/up on the handle, hit-test drop targets against
  // the pinned rows' bounding rects.
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<{ id: string; pos: "before" | "after" } | null>(null);
  let pinnedContainer: HTMLDivElement | undefined;

  function startPinnedDrag(sessionId: string, e: PointerEvent) {
    // preventDefault: suppress text selection + synthetic click on the row.
    // stopPropagation: keep the gesture on the handle (defensive — the handle is
    // a sibling of .tree-node so its touch handlers don't fire anyway).
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture?.(e.pointerId);
    const threshold = 4; // px of movement before a tap becomes a drag
    const startY = e.clientY;
    let dragging = false;

    const rows = (): HTMLElement[] =>
      pinnedContainer
        ? Array.from(pinnedContainer.querySelectorAll<HTMLElement>("[data-pinned-id]"))
        : [];

    // Pick the pinned row whose vertical center is closest to the pointer; its
    // half (top/bottom) decides before/after. The dragged row is excluded, so
    // the result is always a valid neighbor to drop beside.
    const computeDrop = (clientY: number): { id: string; pos: "before" | "after" } | null => {
      let best: { id: string; pos: "before" | "after" } | null = null;
      let bestDist = Infinity;
      for (const row of rows()) {
        const id = row.dataset.pinnedId;
        if (!id || id === sessionId) continue;
        const r = row.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const dist = Math.abs(clientY - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = { id, pos: clientY < mid ? "before" : "after" };
        }
      }
      return best;
    };

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < threshold) return;
        dragging = true;
        setDragId(sessionId);
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      setDropTarget(computeDrop(ev.clientY));
    };
    const cleanup = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      handle.releasePointerCapture?.(e.pointerId);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setDragId(null);
      setDropTarget(null);
    };
    // pointerup: commit a real drop. Capture the drop target BEFORE cleanup
    // resets it (setDropTarget(null) would otherwise null it mid-commit).
    const finish = () => {
      const drop = dragging ? dropTarget() : null;
      cleanup();
      if (drop) movePinnedTo(sessionId, drop.id, drop.pos);
    };
    // pointercancel: the OS interrupted the gesture (scroll/resize/etc.), so any
    // hovered target is stale. Same exit hygiene as finish, but NO commit.
    const cancel = () => {
      cleanup();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", cancel);
  }
  // Search collapses the tree into a flat, recency-sorted list of title matches
  // across the whole project (pinned first) — "find a session", not navigate.
  const results = createMemo(() => {
    const q = searchQuery().trim().toLowerCase();
    if (!q) return null;
    return Object.values(state.sessions)
      .filter((s) => (s.title || s.id).toLowerCase().includes(q))
      .sort((a, b) => {
        const pa = isPinned(a.id) ? 1 : 0, pb = isPinned(b.id) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return (b.time?.updated || b.time?.created || 0) - (a.time?.updated || a.time?.created || 0);
      });
  });
  return (
    <div class="tree">
      <Show
        when={!results()}
        fallback={
          <Show when={results()!.length > 0} fallback={<div class="tree-empty">No matches</div>}>
            <For each={results()!}>
              {(s) => (
                <div class="tree-row" classList={{ selected: selectedId() === s.id }}>
                  <button
                    type="button"
                    class="tree-node"
                    classList={{ selected: selectedId() === s.id, running: isWorking(s.id), detailed: treeDensity() === "detailed" }}
                    onClick={() => openSessionChat(s.id)}
                    data-session-id={s.id}
                    data-tip={displayName(s.title || s.id)}
                    {...menuTriggers(() => s.id, () => s.title || s.id)}
                  >
                    <span class="tree-line1">
                      <Show when={isWorking(s.id)}><Spinner class="tree-spinner" /></Show>
                      <Show when={sessionNeedsInput(s.id)}>
                        <span class="dot needs-input" data-tip="needs your input — reply to continue" />
                      </Show>
                      <AgentChip sessionID={s.id} />
                      <span class="tree-title" classList={{ "needs-input": sessionNeedsInput(s.id) }}>{displayName(s.title || s.id)}</span>
                      <span class="tree-meta">
                        <RelTime class="tree-time" ms={s.time?.updated || s.time?.created} />
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </For>
          </Show>
        }
      >
        <Show
          when={roots().length > 0 || stubRoots().length > 0}
          fallback={<div class="tree-empty">No sessions yet</div>}
        >
          <Show when={pinnedRoots().length > 0}>
            <div class="tree-pinned" ref={(el) => (pinnedContainer = el)}>
              <For each={pinnedRoots()}>
                {(s, i) => (
                  <Node
                    session={s}
                    depth={0}
                    prefix={[]}
                    isLast={i() === pinnedRoots().length - 1}
                    index={index}
                    ancestors={ancestors}
                    working={isWorking}
                    pinnedDnd={{
                      onHandleDown: (e) => startPinnedDrag(s.id, e),
                      dragging: dragId() === s.id,
                      drop: dropTarget()?.id === s.id ? dropTarget()!.pos : null,
                    }}
                  />
                )}
              </For>
            </div>
            <Show when={unpinnedRoots().length > 0 || stubRoots().length > 0}>
              <div class="tree-pin-sep" aria-hidden="true" />
            </Show>
          </Show>
          <For each={unpinnedRoots()}>
            {(s, i) => (
              <Node
                session={s}
                depth={0}
                prefix={[]}
                isLast={i() === unpinnedRoots().length - 1}
                index={index}
                ancestors={ancestors}
                working={isWorking}
              />
            )}
          </For>
          {/* Phase 5: collapsed-branch stub roots (idle subtrees the server
              collapsed into a single stub). Rendered after unpinned session
              roots. Each StubNode handles its own expand/collapse + lazy-fetch. */}
          <For each={stubRoots()}>
            {(stub) => (
              <StubNode
                stub={stub}
                depth={0}
                prefix={[]}
                isLast={true}
                index={index}
                ancestors={ancestors}
                working={isWorking}
              />
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
